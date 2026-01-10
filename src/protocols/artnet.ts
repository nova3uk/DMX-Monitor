/**
 * Art-Net protocol handler for DMX Monitor
 * 
 * Art-Net is a protocol for transmitting DMX512 data over UDP.
 * Port: 6454 (0x1936)
 * Header: "Art-Net\0" (8 bytes)
 */

import dgram from 'dgram';
import { EventEmitter } from 'events';
import {
  DMXPacket,
  UniverseInfo,
  ProtocolHandler,
  ProtocolEvents,
  ArtNetNode,
  ARTNET_PORT,
  ARTNET_BROADCAST,
  TOTAL_CHANNELS,
  isValidUniverse,
} from '../types';
import { NetworkError, ProtocolError, wrapError } from '../errors';
import { logDebug, logError, logInfo, logWarn } from '../logger';
import { ESTA_MANUFACTURER_CODES } from '../constants/esta';

/** Art-Net handler configuration */
export interface ArtNetConfig {
  bindAddress: string;
  useBroadcast: boolean;
  interfaceName?: string;
  /** Netmask for the interface (e.g., "255.255.255.0") - used to calculate subnet broadcast */
  netmask?: string;
}

/** Art-Net OpCodes */
const ARTNET_OPCODE_DMX = 0x5000; // OpDmx
const ARTNET_OPCODE_POLL = 0x2000; // OpPoll
const ARTNET_OPCODE_POLL_REPLY = 0x2100; // OpPollReply

/** Art-Net packet header */
const ARTNET_HEADER = Buffer.from("Art-Net\0");
const ARTNET_HEADER_LENGTH = 8;
const ARTNET_MIN_PACKET_LENGTH = 18; // Header + OpCode + ProtVer + Sequence + Physical + Universe + Length
const ARTNET_POLL_REPLY_MIN_LENGTH = 207; // Minimum ArtPollReply packet length

/** Default discovery timeout in milliseconds */
const DEFAULT_DISCOVERY_TIMEOUT = 3000;

/**
 * Calculate the subnet broadcast address from an IP and netmask
 * e.g., IP: 2.0.0.2, Netmask: 255.0.0.0 -> Broadcast: 2.255.255.255
 */
function calculateBroadcastAddress(ip: string, netmask: string): string {
  const ipParts = ip.split(".").map(Number);
  const maskParts = netmask.split(".").map(Number);

  if (ipParts.length !== 4 || maskParts.length !== 4) {
    // Invalid format, fall back to global broadcast
    return ARTNET_BROADCAST;
  }

  // Broadcast = IP OR (NOT netmask)
  const broadcastParts = ipParts.map((ipByte, i) => {
    const maskByte = maskParts[i] ?? 255;
    return (ipByte | (~maskByte & 0xff)) >>> 0;
  });

  return broadcastParts.join(".");
}

/**
 * Art-Net protocol handler
 */
export class ArtNetHandler extends EventEmitter implements ProtocolHandler {
  private socket: dgram.Socket | null = null;
  private readonly config: ArtNetConfig;
  private readonly discoveredUniverses: Map<number, UniverseInfo> = new Map();
  private readonly discoveredNodes: Map<string, ArtNetNode> = new Map();
  private isRunning = false;
  private isDiscovering = false;

  constructor(config: ArtNetConfig) {
    super();
    this.config = config;
  }

  /**
   * Start listening for Art-Net packets
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logWarn("Art-Net handler already running");
      return;
    }

    logInfo("Starting Art-Net receiver", {
      bindAddress: this.config.bindAddress,
      useBroadcast: this.config.useBroadcast,
    });

    return new Promise((resolve, reject) => {
      try {
        this.socket = dgram.createSocket({
          type: "udp4",
          reuseAddr: true,
        });

        // Handle errors
        this.socket.on("error", (error: Error) => {
          logError(error, "Art-Net socket error");
          const categorizedError = this.categorizeError(error);

          if (!this.isRunning) {
            // Error during startup
            reject(categorizedError);
          } else {
            this.emit("error", categorizedError);
          }
        });

        // Handle incoming messages
        this.socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          try {
            // Debug: log all incoming packets
            const opCode = msg.length >= 10 ? msg.readUInt16LE(8) : 0;
            logDebug(`Raw packet received`, {
              from: rinfo.address,
              port: rinfo.port,
              length: msg.length,
              opCode: opCode.toString(16),
            });
            this.handleMessage(msg, rinfo);
          } catch (error) {
            logError(error, "Error handling Art-Net message");
            this.emit("error", wrapError(error, "Art-Net message handling"));
          }
        });

        // Handle socket close
        this.socket.on("close", () => {
          logDebug("Art-Net socket closed");
          this.isRunning = false;
          this.emit("close");
        });

        // Bind with options matching DMXDesktop for cross-platform compatibility
        // exclusive: false allows multiple apps to bind to same port (needed for same-machine testing)
        // Note: This may hide port conflicts on some platforms - we log a warning about this
        logDebug("Binding Art-Net socket with exclusive: false (allows port sharing)");
        
        this.socket.bind(
          {
            port: ARTNET_PORT,
            address: this.config.bindAddress,
            exclusive: false,
          },
          () => {
            if (!this.socket) return;

            // Enable broadcast
            try {
              this.socket.setBroadcast(true);
              logDebug("Broadcast enabled on Art-Net socket");
            } catch (error) {
              logWarn("Failed to enable broadcast", { error });
            }

            // macOS: Increase receive buffer size for better performance
            if (process.platform === "darwin") {
              try {
                this.socket.setRecvBufferSize(65535);
                logDebug("macOS: Receive buffer size set to 65535");
              } catch (error) {
                logWarn("Failed to set receive buffer size", { error });
              }
            }

            this.isRunning = true;
            const address = this.socket.address();
            logInfo("Art-Net receiver started", {
              address: address.address,
              port: address.port,
              platform: process.platform,
            });
            
            // Log a note about port sharing - another app may be using the port
            logDebug("Note: Port sharing is enabled. If another application is using port 6454, packets may not be received correctly.");
            
            resolve();
          }
        );
      } catch (error) {
        const wrappedError = this.categorizeError(error);
        logError(wrappedError, "Failed to start Art-Net receiver");
        reject(wrappedError);
      }
    });
  }

  /**
   * Stop the Art-Net receiver
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.socket) {
      return;
    }

    logInfo("Stopping Art-Net receiver");

    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }

      this.socket.removeAllListeners();
      this.socket.close(() => {
        this.socket = null;
        this.isRunning = false;
        logInfo("Art-Net receiver stopped");
        resolve();
      });
    });
  }

  /**
   * Get list of discovered universes
   */
  getDiscoveredUniverses(): UniverseInfo[] {
    return Array.from(this.discoveredUniverses.values());
  }

  /**
   * Get list of discovered Art-Net nodes
   */
  getDiscoveredNodes(): ArtNetNode[] {
    return Array.from(this.discoveredNodes.values());
  }

  /**
   * Send ArtPoll broadcast to discover nodes
   */
  private sendArtPoll(): void {
    if (!this.socket) {
      logWarn("Cannot send ArtPoll: socket not initialized");
      return;
    }

    // Create ArtPoll packet (14 bytes)
    const artPollPacket = Buffer.alloc(14);

    // Art-Net header (8 bytes)
    artPollPacket.write("Art-Net\0", 0);

    // OpPoll code (0x2000, little-endian)
    artPollPacket.writeUInt16LE(ARTNET_OPCODE_POLL, 8);

    // Protocol version (2 bytes)
    artPollPacket.writeUInt8(0, 10); // Hi byte
    artPollPacket.writeUInt8(14, 11); // Lo byte - protocol version 14

    // TalkToMe flags (1 byte)
    artPollPacket.writeUInt8(0x00, 12);

    // Priority (1 byte)
    artPollPacket.writeUInt8(0x00, 13);

    // Calculate broadcast address based on interface IP and netmask
    // This ensures ArtPoll reaches devices on non-standard subnets (e.g., 2.x.x.x with 255.0.0.0 netmask)
    let broadcastAddress = ARTNET_BROADCAST;
    if (this.config.bindAddress !== "0.0.0.0" && this.config.netmask) {
      broadcastAddress = calculateBroadcastAddress(this.config.bindAddress, this.config.netmask);
      logDebug("Using subnet broadcast address", {
        ip: this.config.bindAddress,
        netmask: this.config.netmask,
        broadcast: broadcastAddress,
      });
    }

    logDebug("Sending ArtPoll broadcast", { broadcastAddress });

    // Send to broadcast address
    this.socket.send(artPollPacket, ARTNET_PORT, broadcastAddress, (error) => {
      if (error) {
        logError(error, "Failed to send ArtPoll");
      } else {
        logDebug("ArtPoll sent successfully", { broadcastAddress });
      }
    });
  }

  /**
   * Start discovery of Art-Net nodes
   * @param timeout Discovery timeout in milliseconds (default: 3000ms)
   * @returns Promise that resolves with discovered nodes
   */
  async startDiscovery(timeout: number = DEFAULT_DISCOVERY_TIMEOUT): Promise<ArtNetNode[]> {
    if (!this.isRunning) {
      throw new Error("Art-Net handler must be started before discovery");
    }

    if (this.isDiscovering) {
      logWarn("Discovery already in progress");
      return this.getDiscoveredNodes();
    }

    this.isDiscovering = true;
    this.discoveredNodes.clear();

    logInfo("Starting Art-Net node discovery", { timeout });

    // Send ArtPoll
    this.sendArtPoll();

    // Wait for responses
    return new Promise((resolve) => {
      setTimeout(() => {
        this.isDiscovering = false;
        const nodes = this.getDiscoveredNodes();
        logInfo(`Discovery complete. Found ${nodes.length} node(s)`);
        resolve(nodes);
      }, timeout);
    });
  }

  /**
   * Parse ArtPollReply packet
   */
  private parseArtPollReply(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length < ARTNET_POLL_REPLY_MIN_LENGTH) {
      logDebug("ArtPollReply packet too short", { length: msg.length });
      return;
    }

    // Get short name early for logging
    const shortName = msg.toString("utf8", 26, 44).split("\0")[0]?.trim() || "";

    try {
      // Parse ESTA manufacturer code (offset 24-25, little-endian with hi byte at offset+1)
      const estaOffset = 24;
      const estaCode = (msg.readUInt8(estaOffset + 1) << 8) | msg.readUInt8(estaOffset);
      const estaHex = `${estaCode.toString(16).padStart(4, "0").toUpperCase()}h`;

      // Find manufacturer name
      const manufacturerObj = ESTA_MANUFACTURER_CODES.find((code) => Object.keys(code)[0] === estaHex);
      const manufacturer = manufacturerObj ? Object.values(manufacturerObj)[0] : `Unknown (0x${estaCode.toString(16).padStart(4, "0")})`;

      // Parse other fields
      const longName = msg.toString("utf8", 44, 108).split("\0")[0]?.trim() || "";
      const firmwareVersion = `V${msg[16]}.${msg[17]}`;
      const numPorts = msg[173] || 0;

      // Parse MAC address
      const macBuffer = msg.subarray(201, 207);
      const macAddress = Array.from(macBuffer)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(":")
        .toUpperCase();

      // Get or create node entry
      let node = this.discoveredNodes.get(rinfo.address);
      const isNewNode = !node;

      if (!node) {
        node = {
          ip: rinfo.address,
          shortName,
          longName,
          universes: [],
          macAddress,
          manufacturer,
          firmwareVersion,
          lastSeen: new Date(),
        };
        this.discoveredNodes.set(rinfo.address, node);
        logInfo(`Discovered Art-Net node: ${shortName} (${rinfo.address})`, {
          manufacturer,
          firmwareVersion,
          numPorts,
        });
      } else {
        // Update existing node
        node.lastSeen = new Date();
        node.shortName = shortName;
        node.longName = longName;
        node.manufacturer = manufacturer;
        node.firmwareVersion = firmwareVersion;
        node.macAddress = macAddress;
      }

      // Extract universes from SwOut array (always read all 4 ports)
      // SwOut values are 0-indexed - keep as-is to match wire format
      // Note: numPorts may not reflect actual configured universes, so we read all 4 SwOut values
      // and filter out invalid/unused ones (0xFF typically indicates unused port)
      for (let i = 0; i < 4; i++) {
        const swOutValue = msg[190 + i];
        // Valid Art-Net universe values are 0-255 for the low byte (SubUni)
        // 0xFF (255) typically indicates an unused/unconfigured port
        // We also check that the value is defined and not already in the list
        if (swOutValue !== undefined && swOutValue !== 0xff && !node.universes.includes(swOutValue)) {
          node.universes.push(swOutValue);
          logDebug(`Added universe ${swOutValue} to node ${rinfo.address}`);
        }
      }
      node.universes.sort((a, b) => a - b);
      
      logDebug(`Node ${shortName} universes parsed`, { 
        numPorts, 
        universes: node.universes,
        swOut: [msg[190], msg[191], msg[192], msg[193]]
      });

      // Emit nodeDiscovered event for new nodes
      if (isNewNode) {
        this.emit("nodeDiscovered", node);
      }
    } catch (error) {
      logError(error, "Error parsing ArtPollReply");
    }
  }

  /**
   * Handle incoming UDP message
   */
  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    // Validate minimum packet length
    if (msg.length < ARTNET_MIN_PACKET_LENGTH) {
      logDebug("Packet too short", { length: msg.length, from: rinfo.address });
      return;
    }

    // Validate Art-Net header
    if (!this.validateHeader(msg)) {
      logDebug("Invalid Art-Net header", { from: rinfo.address });
      return;
    }

    // Get OpCode (little-endian at offset 8)
    const opCode = msg.readUInt16LE(8);

    // Handle different packet types
    switch (opCode) {
      case ARTNET_OPCODE_DMX:
        this.parseDMXPacket(msg, rinfo);
        break;
      case ARTNET_OPCODE_POLL_REPLY:
        // Always process ArtPollReply - nodes may respond late or unsolicited
        this.parseArtPollReply(msg, rinfo);
        break;
      default:
        logDebug("Unhandled Art-Net packet", { opCode: opCode.toString(16), from: rinfo.address });
    }
  }

  /**
   * Validate Art-Net header
   */
  private validateHeader(msg: Buffer): boolean {
    for (let i = 0; i < ARTNET_HEADER_LENGTH; i++) {
      if (msg[i] !== ARTNET_HEADER[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Parse Art-Net DMX packet (OpDmx)
   *
   * Packet structure:
   * Offset | Size | Description
   * -------|------|------------
   * 0      | 8    | "Art-Net\0"
   * 8      | 2    | OpCode (0x5000)
   * 10     | 2    | Protocol Version (14)
   * 12     | 1    | Sequence
   * 13     | 1    | Physical
   * 14     | 2    | Universe (little-endian)
   * 16     | 2    | Length (big-endian)
   * 18     | n    | DMX data
   */
  private parseDMXPacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    // Protocol version (big-endian at offset 10)
    const protocolVersion = msg.readUInt16BE(10);
    if (protocolVersion < 14) {
      logDebug("Unsupported Art-Net version", { version: protocolVersion });
      return;
    }

    // Sequence number
    const sequence = msg[12];

    // Physical port (informational)
    const physical = msg[13];

    // Universe (little-endian at offset 14)
    // Art-Net universe is 15-bit: SubUni (low byte) + Net (high byte bits 0-6)
    // Note: Art-Net uses 0-indexed on wire, we keep it as-is internally
    const universe = msg.readUInt16LE(14);

    // Validate universe
    if (!isValidUniverse(universe)) {
      logWarn(`Received packet with invalid universe: ${universe}`);
      return;
    }

    // Data length (big-endian at offset 16)
    const dataLength = msg.readUInt16BE(16);

    // Validate data length
    if (dataLength < 2 || dataLength > 512) {
      logDebug("Invalid DMX data length", { length: dataLength });
      return;
    }

    // Validate packet has enough data
    if (msg.length < 18 + dataLength) {
      logDebug("Packet truncated", { expected: 18 + dataLength, actual: msg.length });
      return;
    }

    // Update discovered universes
    const now = new Date();
    const existingInfo = this.discoveredUniverses.get(universe);

    if (!existingInfo) {
      // New universe discovered
      const info: UniverseInfo = {
        universe,
        lastSeen: now,
        packetCount: 1,
        source: rinfo.address,
      };
      this.discoveredUniverses.set(universe, info);
      logInfo(`Discovered new Art-Net universe: ${universe}`, { source: rinfo.address });
      this.emit("universeDiscovered", universe);
    } else {
      // Update existing universe info
      existingInfo.lastSeen = now;
      existingInfo.packetCount++;
      existingInfo.source = rinfo.address;
    }

    // Extract channel data
    const channels = new Uint8Array(TOTAL_CHANNELS);
    for (let i = 0; i < Math.min(dataLength, TOTAL_CHANNELS); i++) {
      const value = msg[18 + i];
      if (value !== undefined) {
        channels[i] = value;
      }
    }

    // Create DMX packet
    const dmxPacket: DMXPacket = {
      universe,
      channels,
      source: rinfo.address,
      sequence,
      timestamp: now,
    };

    logDebug("Art-Net DMX packet received", {
      universe,
      sequence,
      physical,
      dataLength,
      source: rinfo.address,
    });

    this.emit("packet", dmxPacket);
  }

  /**
   * Categorize error into appropriate error type
   * Provides user-friendly error messages for common network issues
   */
  private categorizeError(error: unknown): Error {
    if (error instanceof Error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code === "EADDRINUSE") {
        // Port is already in use - provide helpful message
        logError(error, `Port ${ARTNET_PORT} is already in use`);
        return new NetworkError(
          `Port ${ARTNET_PORT} is already in use by another application. ` +
          `Please close the other application using this port or select a different network interface.`,
          { port: ARTNET_PORT, address: this.config.bindAddress, syscall: "bind" }
        );
      }

      if (nodeError.code === "EADDRNOTAVAIL") {
        return NetworkError.bindFailed(this.config.bindAddress, ARTNET_PORT, error);
      }

      if (nodeError.code === "ENODEV") {
        return NetworkError.interfaceNotFound(this.config.bindAddress);
      }

      if (nodeError.code === "EACCES") {
        return new NetworkError(
          `Permission denied binding to port ${ARTNET_PORT}. ` +
          `Try running with elevated privileges or select a different network interface.`,
          { port: ARTNET_PORT, address: this.config.bindAddress }
        );
      }

      // Windows-specific: WSAEACCES (10013) - another process has exclusive access
      if (nodeError.code === "WSAEACCES" || (nodeError.message && nodeError.message.includes("10013"))) {
        return new NetworkError(
          `Port ${ARTNET_PORT} is blocked or in use by another application with exclusive access. ` +
          `Please close the other application or try a different network interface.`,
          { port: ARTNET_PORT, address: this.config.bindAddress }
        );
      }

      // Check for protocol-related errors
      if (nodeError.message?.includes("packet") || nodeError.message?.includes("header") || nodeError.message?.includes("invalid")) {
        return ProtocolError.malformedPacket("Art-Net", nodeError.message);
      }
    }

    return wrapError(error, "Art-Net");
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): this {
    return super.on(event, listener);
  }

  override off<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof ProtocolEvents>(event: K, ...args: Parameters<ProtocolEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * Create and configure an Art-Net handler
 */
export function createArtNetHandler(config: ArtNetConfig): ArtNetHandler {
  return new ArtNetHandler(config);
}
