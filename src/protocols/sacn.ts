/**
 * sACN (E1.31) protocol handler for DMX Monitor
 */

import { Receiver } from 'sacn';
import { EventEmitter } from 'events';
import {
  DMXPacket,
  UniverseInfo,
  ProtocolHandler,
  ProtocolEvents,
  SACN_PORT,
  TOTAL_CHANNELS,
  isValidUniverse,
} from '../types';
import { NetworkError, ProtocolError, wrapError } from '../errors';
import { logDebug, logError, logInfo, logWarn } from '../logger';

/** sACN handler configuration */
export interface SACNConfig {
  bindAddress: string;
  useMulticast: boolean;
  universes?: number[];
  interfaceName?: string;
}

/** sACN packet from the sacn library */
interface SACNPacket {
  universe: number;
  payload: { [channel: number]: number };
  sourceName?: string;
  priority?: number;
  sequence?: number;
  cid?: Buffer;
}

/**
 * sACN (E1.31) protocol handler
 */
export class SACNHandler extends EventEmitter implements ProtocolHandler {
  private receiver: Receiver | null = null;
  private readonly config: SACNConfig;
  private readonly discoveredUniverses: Map<number, UniverseInfo> = new Map();
  private isRunning = false;

  constructor(config: SACNConfig) {
    super();
    this.config = config;
  }

  /**
   * Start listening for sACN packets
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logWarn('sACN handler already running');
      return;
    }

    logInfo('Starting sACN receiver', {
      bindAddress: this.config.bindAddress,
      useMulticast: this.config.useMulticast,
    });

    try {
      // For multicast, we need a specific interface. If 0.0.0.0 is specified,
      // find the first non-internal IPv4 interface
      let ifaceAddress: string | undefined;
      if (this.config.bindAddress !== '0.0.0.0') {
        ifaceAddress = this.config.bindAddress;
      } else if (this.config.useMulticast) {
        // Find first non-internal IPv4 interface for multicast
        const os = await import('os');
        const interfaces = os.networkInterfaces();
        for (const [, addrs] of Object.entries(interfaces)) {
          if (!addrs) continue;
          for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal) {
              ifaceAddress = addr.address;
              logInfo(`Using interface ${ifaceAddress} for sACN multicast`);
              break;
            }
          }
          if (ifaceAddress) break;
        }
      }

      // Create receiver with empty universes initially to avoid immediate multicast join
      // Universes will be added later via addUniverse() after user selects one
      const receiverOptions: ConstructorParameters<typeof Receiver>[0] = {
        universes: this.config.universes ?? [], // Empty - will add after user prompt
        iface: ifaceAddress,
        reuseAddr: true,
      };

      this.receiver = new Receiver(receiverOptions);

      // Handle incoming packets
      this.receiver.on('packet', (packet: SACNPacket) => {
        try {
          this.handlePacket(packet);
        } catch (error) {
          logError(error, 'Error handling sACN packet');
          this.emit('error', wrapError(error, 'sACN packet handling'));
        }
      });

      // Handle errors - but don't crash on multicast join errors during startup
      this.receiver.on('error', (error: Error) => {
        const nodeError = error as NodeJS.ErrnoException;
        // EINVAL during startup is usually a multicast join issue - log but don't crash
        if (nodeError.message?.includes('addMembership') || nodeError.message?.includes('EINVAL')) {
          logWarn('sACN multicast join warning (will retry when universe is added)', { error: error.message });
          return;
        }
        logError(error, 'sACN receiver error');
        this.emit('error', this.categorizeError(error));
      });

      this.isRunning = true;
      logInfo('sACN receiver started successfully');
    } catch (error) {
      const wrappedError = this.categorizeError(error);
      logError(wrappedError, 'Failed to start sACN receiver');
      throw wrappedError;
    }
  }

  /**
   * Stop the sACN receiver
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.receiver) {
      return;
    }

    logInfo('Stopping sACN receiver');

    try {
      this.receiver.removeAllListeners();
      this.receiver.close();
      this.receiver = null;
      this.isRunning = false;
      this.emit('close');
      logInfo('sACN receiver stopped');
    } catch (error) {
      logError(error, 'Error stopping sACN receiver');
      throw wrapError(error, 'sACN stop');
    }
  }

  /**
   * Get list of discovered universes
   */
  getDiscoveredUniverses(): UniverseInfo[] {
    return Array.from(this.discoveredUniverses.values());
  }

  /**
   * Add a universe to listen on
   */
  addUniverse(universe: number): void {
    if (!isValidUniverse(universe)) {
      logWarn(`Invalid universe number: ${universe}`);
      return;
    }

    if (this.receiver) {
      try {
        this.receiver.addUniverse(universe);
        logDebug(`Added universe ${universe} to sACN receiver`);
      } catch (error) {
        logWarn(`Failed to add universe ${universe}: ${error}`);
      }
    }
  }

  /**
   * Handle incoming sACN packet
   */
  private handlePacket(packet: SACNPacket): void {
    const universe = packet.universe;

    // Validate universe
    if (!isValidUniverse(universe)) {
      logWarn(`Received packet with invalid universe: ${universe}`);
      return;
    }

    // Update discovered universes
    const existingInfo = this.discoveredUniverses.get(universe);
    const now = new Date();

    if (!existingInfo) {
      // New universe discovered
      const info: UniverseInfo = {
        universe,
        lastSeen: now,
        packetCount: 1,
        source: packet.sourceName,
      };
      this.discoveredUniverses.set(universe, info);
      logInfo(`Discovered new sACN universe: ${universe}`, { source: packet.sourceName });
      this.emit("universeDiscovered", universe);
    } else {
      // Update existing universe info
      existingInfo.lastSeen = now;
      existingInfo.packetCount++;
      if (packet.sourceName) {
        existingInfo.source = packet.sourceName;
      }
    }

    // Extract channel data
    const channels = new Uint8Array(TOTAL_CHANNELS);
    const payload = packet.payload;

    // Copy channel data from payload object (sacn library uses object with channel keys)
    // The sacn library returns values as percentages (0-100), convert to DMX (0-255)
    for (let i = 0; i < TOTAL_CHANNELS; i++) {
      const value = payload[i + 1]; // sACN uses 1-based channel numbers
      if (value !== undefined) {
        // Convert percentage (0-100) to DMX value (0-255)
        channels[i] = Math.round((value / 100) * 255);
      }
    }

    // Create DMX packet
    const dmxPacket: DMXPacket = {
      universe,
      channels,
      source: packet.sourceName,
      priority: packet.priority,
      sequence: packet.sequence,
      timestamp: now,
    };

    this.emit("packet", dmxPacket);
  }

  /**
   * Categorize error into appropriate error type
   */
  private categorizeError(error: unknown): Error {
    if (error instanceof Error) {
      const nodeError = error as NodeJS.ErrnoException;
      
      if (nodeError.code === 'EADDRINUSE') {
        return NetworkError.portInUse(SACN_PORT, this.config.bindAddress);
      }
      
      if (nodeError.code === 'EADDRNOTAVAIL') {
        return NetworkError.bindFailed(this.config.bindAddress, SACN_PORT, error);
      }
      
      if (nodeError.code === 'ENODEV') {
        return NetworkError.interfaceNotFound(this.config.bindAddress);
      }

      if (nodeError.message?.includes('multicast')) {
        return NetworkError.multicastJoinFailed(this.config.bindAddress, error);
      }

      // Check for protocol-related errors
      if (nodeError.message?.includes('packet') || 
          nodeError.message?.includes('header') ||
          nodeError.message?.includes('invalid')) {
        return ProtocolError.malformedPacket('sACN', nodeError.message);
      }
    }

    return wrapError(error, 'sACN');
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof ProtocolEvents>(
    event: K,
    listener: ProtocolEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override off<K extends keyof ProtocolEvents>(
    event: K,
    listener: ProtocolEvents[K]
  ): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof ProtocolEvents>(
    event: K,
    ...args: Parameters<ProtocolEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * Create and configure an sACN handler
 */
export function createSACNHandler(config: SACNConfig): SACNHandler {
  return new SACNHandler(config);
}
