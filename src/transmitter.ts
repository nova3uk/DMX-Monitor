/**
 * DMX Transmitter - Sends DMX data via Art-Net or sACN
 * 
 * Used for playback of recorded DMX data.
 */

import dgram from "dgram";
import { Sender } from "sacn";
import {
  Protocol,
  TOTAL_CHANNELS,
  ARTNET_PORT,
  ARTNET_BROADCAST,
} from "./types";
import { logInfo, logError, logDebug } from "./logger";

/** Art-Net packet header */
const ARTNET_HEADER = Buffer.from("Art-Net\0");
const ARTNET_OPCODE_DMX = 0x5000;

/** Common transmitter interface */
export interface DMXTransmitter {
  /** Start the transmitter */
  start(): Promise<void>;
  /** Stop the transmitter */
  stop(): Promise<void>;
  /** Send DMX channel data */
  send(channels: Uint8Array): void;
  /** Get the protocol type */
  getProtocol(): Protocol;
}

/** Art-Net transmitter configuration */
export interface ArtNetTransmitterConfig {
  /** Target IP address (unicast) or broadcast address */
  targetAddress?: string;
  /** Universe number (0-32767) */
  universe: number;
  /** Bind address for the socket */
  bindAddress?: string;
}

/** sACN transmitter configuration */
export interface SACNTransmitterConfig {
  /** Universe number (1-63999) */
  universe: number;
  /** Source name to identify this sender */
  sourceName?: string;
  /** Priority (0-200, default 100) */
  priority?: number;
  /** Network interface to use */
  interfaceAddress?: string;
}

/**
 * Art-Net DMX Transmitter
 * 
 * Sends Art-Net DMX packets (OpDmx) to a target address.
 */
export class ArtNetTransmitter implements DMXTransmitter {
  private socket: dgram.Socket | null = null;
  private readonly config: ArtNetTransmitterConfig;
  private sequence = 0;
  private isRunning = false;

  constructor(config: ArtNetTransmitterConfig) {
    this.config = {
      targetAddress: config.targetAddress ?? ARTNET_BROADCAST,
      universe: config.universe,
      bindAddress: config.bindAddress ?? "0.0.0.0",
    };
  }

  getProtocol(): Protocol {
    return "artnet";
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    logInfo("Starting Art-Net transmitter", {
      targetAddress: this.config.targetAddress,
      universe: this.config.universe,
    });

    return new Promise((resolve, reject) => {
      try {
        this.socket = dgram.createSocket({
          type: "udp4",
          reuseAddr: true,
        });

        this.socket.on("error", (error: Error) => {
          logError(error, "Art-Net transmitter socket error");
          if (!this.isRunning) {
            reject(error);
          }
        });

        this.socket.bind(0, this.config.bindAddress, () => {
          if (!this.socket) return;

          // Enable broadcast
          try {
            this.socket.setBroadcast(true);
          } catch (error) {
            logDebug("Failed to enable broadcast", { error });
          }

          this.isRunning = true;
          const address = this.socket.address();
          logInfo("Art-Net transmitter started", {
            localPort: address.port,
            targetAddress: this.config.targetAddress,
            universe: this.config.universe,
          });
          resolve();
        });
      } catch (error) {
        logError(error, "Failed to start Art-Net transmitter");
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.socket) {
      return;
    }

    logInfo("Stopping Art-Net transmitter");

    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }

      this.socket.close(() => {
        this.socket = null;
        this.isRunning = false;
        logInfo("Art-Net transmitter stopped");
        resolve();
      });
    });
  }

  /**
   * Send DMX data via Art-Net
   * 
   * Packet structure:
   * Offset | Size | Description
   * -------|------|------------
   * 0      | 8    | "Art-Net\0"
   * 8      | 2    | OpCode (0x5000, little-endian)
   * 10     | 2    | Protocol Version (14, big-endian)
   * 12     | 1    | Sequence
   * 13     | 1    | Physical
   * 14     | 2    | Universe (little-endian)
   * 16     | 2    | Length (big-endian)
   * 18     | n    | DMX data
   */
  send(channels: Uint8Array): void {
    if (!this.socket || !this.isRunning) {
      return;
    }

    const dataLength = Math.min(channels.length, TOTAL_CHANNELS);
    const packet = Buffer.alloc(18 + dataLength);

    // Art-Net header
    ARTNET_HEADER.copy(packet, 0);

    // OpCode (little-endian)
    packet.writeUInt16LE(ARTNET_OPCODE_DMX, 8);

    // Protocol version (big-endian)
    packet.writeUInt16BE(14, 10);

    // Sequence (0-255, wraps around)
    packet.writeUInt8(this.sequence, 12);
    this.sequence = (this.sequence + 1) & 0xff;

    // Physical port (0)
    packet.writeUInt8(0, 13);

    // Universe (little-endian)
    packet.writeUInt16LE(this.config.universe, 14);

    // Data length (big-endian)
    packet.writeUInt16BE(dataLength, 16);

    // DMX data
    for (let i = 0; i < dataLength; i++) {
      packet[18 + i] = channels[i] ?? 0;
    }

    // Send packet
    this.socket.send(
      packet,
      ARTNET_PORT,
      this.config.targetAddress!,
      (error) => {
        if (error) {
          logError(error, "Failed to send Art-Net packet");
        }
      }
    );
  }
}

/**
 * sACN (E1.31) DMX Transmitter
 * 
 * Sends sACN packets to multicast address for the universe.
 */
export class SACNTransmitter implements DMXTransmitter {
  private sender: Sender | null = null;
  private readonly config: SACNTransmitterConfig;
  private isRunning = false;

  constructor(config: SACNTransmitterConfig) {
    this.config = {
      universe: config.universe,
      sourceName: config.sourceName ?? "DMX Monitor Playback",
      priority: config.priority ?? 100,
      interfaceAddress: config.interfaceAddress,
    };
  }

  getProtocol(): Protocol {
    return "sacn";
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    logInfo("Starting sACN transmitter", {
      universe: this.config.universe,
      sourceName: this.config.sourceName,
      priority: this.config.priority,
    });

    try {
      // Find interface address if not specified
      let ifaceAddress = this.config.interfaceAddress;
      if (!ifaceAddress) {
        const os = await import("os");
        const interfaces = os.networkInterfaces();
        for (const [, addrs] of Object.entries(interfaces)) {
          if (!addrs) continue;
          for (const addr of addrs) {
            if (addr.family === "IPv4" && !addr.internal) {
              ifaceAddress = addr.address;
              break;
            }
          }
          if (ifaceAddress) break;
        }
      }

      this.sender = new Sender({
        universe: this.config.universe,
        iface: ifaceAddress,
        reuseAddr: true,
      });

      this.isRunning = true;
      logInfo("sACN transmitter started", {
        universe: this.config.universe,
        interface: ifaceAddress,
      });
    } catch (error) {
      logError(error, "Failed to start sACN transmitter");
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.sender) {
      return;
    }

    logInfo("Stopping sACN transmitter");

    try {
      this.sender.close();
      this.sender = null;
      this.isRunning = false;
      logInfo("sACN transmitter stopped");
    } catch (error) {
      logError(error, "Error stopping sACN transmitter");
    }
  }

  /**
   * Send DMX data via sACN
   * 
   * The sacn library expects channel values as percentages (0-100),
   * so we need to convert from DMX values (0-255).
   */
  send(channels: Uint8Array): void {
    if (!this.sender || !this.isRunning) {
      return;
    }

    // Convert to sACN payload format (object with 1-based channel keys, percentage values)
    const payload: { [channel: number]: number } = {};
    for (let i = 0; i < Math.min(channels.length, TOTAL_CHANNELS); i++) {
      const value = channels[i] ?? 0;
      // Convert DMX (0-255) to percentage (0-100)
      payload[i + 1] = Math.round((value / 255) * 100);
    }

    try {
      this.sender.send({
        payload,
        sourceName: this.config.sourceName,
        priority: this.config.priority,
      });
    } catch (error) {
      logError(error, "Failed to send sACN packet");
    }
  }
}

/**
 * Create a transmitter based on protocol
 */
export function createTransmitter(
  protocol: Protocol,
  universe: number,
  options?: {
    targetAddress?: string;
    sourceName?: string;
    priority?: number;
    interfaceAddress?: string;
  }
): DMXTransmitter {
  if (protocol === "artnet") {
    return new ArtNetTransmitter({
      universe,
      targetAddress: options?.targetAddress,
    });
  } else {
    return new SACNTransmitter({
      universe,
      sourceName: options?.sourceName,
      priority: options?.priority,
      interfaceAddress: options?.interfaceAddress,
    });
  }
}
