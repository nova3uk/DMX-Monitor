/**
 * TypeScript type definitions for DMX Monitor
 */

/** Supported DMX protocols */
export type Protocol = 'sacn' | 'artnet';

/** DMX channel value (0-255) */
export type ChannelValue = number;

/** DMX universe number */
export type UniverseNumber = number;

/** Network interface information */
export interface NetworkInterface {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
  mac?: string;
  /** Netmask for the interface (e.g., "255.255.255.0") */
  netmask?: string;
}

/** CLI arguments parsed from command line */
export interface CLIOptions {
  protocol?: Protocol;
  interface?: string;
  address?: string;
  universe?: number;
  multicast?: boolean;
  broadcast?: boolean;
  verbose?: boolean;
  logFile?: string;
  /** Directory to save recordings (default: current working directory) */
  recordingDir?: string;
  /** Playback mode: path to .dmxrec file to play */
  playback?: string;
  /** Enable loop mode for playback */
  loop?: boolean;
  /** Playback speed multiplier (0.1 - 10.0) */
  speed?: number;
  /** sACN priority for playback (0-200, default 100) */
  priority?: number;
}

/** Configuration after setup is complete */
export interface MonitorConfig {
  protocol: Protocol;
  bindAddress: string;
  interfaceName?: string;
  /** Netmask for the selected interface (used for Art-Net broadcast calculation) */
  netmask?: string;
  useMulticast: boolean;
  useBroadcast: boolean;
  selectedUniverse?: number;
  verbose: boolean;
  logFile?: string;
}

/** DMX packet data from either protocol */
export interface DMXPacket {
  universe: number;
  channels: Uint8Array;
  source?: string;
  priority?: number;
  sequence?: number;
  timestamp: Date;
}

/** Universe tracking information */
export interface UniverseInfo {
  universe: number;
  lastSeen: Date;
  packetCount: number;
  source?: string;
}

/** Statistics for display */
export interface MonitorStats {
  protocol: Protocol;
  universe: number;
  bindAddress: string;
  interfaceName?: string;
  packetsReceived: number;
  packetsPerSecond: number;
  lastPacketTime: Date | null;
  startTime: Date;
  errors: number;
}

/** Display grid dimensions */
export const GRID_COLUMNS = 32;
export const GRID_ROWS = 16;
export const TOTAL_CHANNELS = GRID_COLUMNS * GRID_ROWS; // 512 channels

/** Protocol port numbers */
export const SACN_PORT = 5568;
export const ARTNET_PORT = 6454;

/** sACN multicast address base (239.255.x.y where x.y = universe) */
export const SACN_MULTICAST_BASE = "239.255.";

/** Art-Net broadcast address */
export const ARTNET_BROADCAST = "255.255.255.255";

/** sACN source information for priority tracking */
export interface SACNSourceInfo {
  /** Source name from sACN packet */
  sourceName: string;
  /** Source IP address */
  sourceAddress?: string;
  /** Priority (0-200) */
  priority: number;
  /** Last time we received a packet from this source */
  lastSeen: Date;
  /** Whether this is the active (highest priority) source */
  isActive: boolean;
}

/** Event types for protocol handlers */
export interface ProtocolEvents {
  packet: (packet: DMXPacket) => void;
  error: (error: Error) => void;
  universeDiscovered: (universe: number) => void;
  nodeDiscovered: (node: ArtNetNode) => void;
  /** Emitted when multiple sACN sources are detected on the same universe */
  sourcesChanged: (sources: SACNSourceInfo[]) => void;
  close: () => void;
}

/** Protocol handler interface */
export interface ProtocolHandler {
  start(): Promise<void>;
  stop(): Promise<void>;
  getDiscoveredUniverses(): UniverseInfo[];
  on<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): void;
  off<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): void;
}

/** Art-Net node discovered via ArtPoll */
export interface ArtNetNode {
  ip: string;
  shortName: string;
  longName: string;
  universes: number[];
  macAddress?: string;
  manufacturer?: string;
  firmwareVersion?: string;
  lastSeen: Date;
}

/** Art-Net discovery result */
export interface ArtNetDiscoveryResult {
  nodes: ArtNetNode[];
  totalUniverses: number;
}

/** Result type for operations that can fail */
export type Result<T, E = Error> = { success: true; value: T } | { success: false; error: E };

/** Helper to create success result */
export function success<T>(value: T): Result<T, never> {
  return { success: true, value };
}

/** Helper to create failure result */
export function failure<E>(error: E): Result<never, E> {
  return { success: false, error };
}

/** Validate channel value is in range */
export function isValidChannelValue(value: unknown): value is ChannelValue {
  return typeof value === "number" && value >= 0 && value <= 255 && Number.isInteger(value);
}

/** Validate universe number is in valid range */
export function isValidUniverse(universe: unknown): universe is UniverseNumber {
  // sACN supports 1-63999, Art-Net supports 0-32767
  return typeof universe === "number" && universe >= 0 && universe <= 63999 && Number.isInteger(universe);
}

/** Validate IP address format */
export function isValidIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    const num = parseInt(part, 10);
    return !isNaN(num) && num >= 0 && num <= 255 && part === num.toString();
  });
}

// ============================================================================
// Recording Types
// ============================================================================

/** Magic bytes for DMX recording file format */
export const DMXREC_MAGIC = "DMXR";

/** Current recording file format version */
export const DMXREC_VERSION = 1;

/** Recording file header (32 bytes) */
export interface RecordingHeader {
  /** Magic bytes - always "DMXR" */
  magic: string;
  /** File format version */
  version: number;
  /** Flags (compression, etc.) */
  flags: number;
  /** Protocol used (0=sACN, 1=Art-Net) */
  protocol: number;
  /** Universe number */
  universe: number;
  /** Start timestamp (Unix ms) */
  startTime: number;
  /** Total duration in ms */
  duration: number;
  /** Total frame count */
  frameCount: number;
}

/** Recording flags */
export const RecordingFlags = {
  /** No special flags */
  NONE: 0x00,
  /** Recording includes full snapshots */
  HAS_SNAPSHOTS: 0x01,
} as const;

/** Special change count values */
export const FrameType = {
  /** Full 512-byte snapshot frame */
  SNAPSHOT: 0xfe,
  /** Extended change count (followed by uint16) */
  EXTENDED: 0xff,
} as const;

/** A single channel change within a frame */
export interface ChannelChange {
  /** Channel number (0-511) */
  channel: number;
  /** New value (0-255) */
  value: number;
}

/** A recorded frame with delta changes */
export interface RecordingFrame {
  /** Time offset from previous frame in ms */
  deltaTime: number;
  /** Channel changes in this frame */
  changes: ChannelChange[];
  /** If true, this is a full snapshot frame */
  isSnapshot: boolean;
  /** Full channel data (only for snapshot frames) */
  snapshotData?: Uint8Array;
}

/** Recording state */
export type RecordingState = "idle" | "recording" | "paused";

/** Recording statistics */
export interface RecordingStats {
  /** Current recording state */
  state: RecordingState;
  /** Recording start time */
  startTime: Date | null;
  /** Total frames recorded */
  frameCount: number;
  /** Total bytes written */
  bytesWritten: number;
  /** Current file path */
  filePath: string | null;
  /** Duration in ms */
  duration: number;
}

/** Playback state */
export type PlaybackState = "idle" | "playing" | "paused" | "finished";

/** Playback statistics */
export interface PlaybackStats {
  /** Current playback state */
  state: PlaybackState;
  /** Current position in ms */
  position: number;
  /** Total duration in ms */
  duration: number;
  /** Current frame index */
  frameIndex: number;
  /** Total frames */
  totalFrames: number;
  /** File being played */
  filePath: string | null;
}