/**
 * DMX Recording and Playback
 * 
 * Highly optimized binary format for recording DMX data with delta compression.
 * Only stores channel changes with precision timestamps for minimal file size.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  TOTAL_CHANNELS,
  Protocol,
  DMXREC_MAGIC,
  DMXREC_VERSION,
  RecordingHeader,
  RecordingFlags,
  FrameType,
  ChannelChange,
  RecordingFrame,
  RecordingState,
  RecordingStats,
  PlaybackState,
  PlaybackStats,
} from './types';
import { logInfo, logDebug } from './logger';

/** Header size in bytes */
const HEADER_SIZE = 32;

/** Interval between full snapshots (ms) */
const SNAPSHOT_INTERVAL = 5000;

/** Write buffer size before flushing */
const WRITE_BUFFER_SIZE = 64 * 1024; // 64KB

/**
 * Encode an unsigned integer as a varint (1-4 bytes)
 * Uses continuation bit encoding for compact representation
 */
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7F) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7F);
  return Buffer.from(bytes);
}

/**
 * Decode a varint from a buffer at the given offset
 * Returns the decoded value and number of bytes consumed
 */
function decodeVarint(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead]!;
    bytesRead++;
    value |= (byte & 0x7F) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  
  return { value, bytesRead };
}

/**
 * Format a date as YYYYMMDD-HHMMSS for filenames
 */
function formatDateForFilename(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * DMX Recorder - Records DMX data to an optimized binary format
 */
export class DMXRecorder {
  private state: RecordingState = 'idle';
  private filePath: string | null = null;
  private fileHandle: number | null = null;
  private writeBuffer: Buffer;
  private writeOffset = 0;
  
  private previousChannels: Uint8Array;
  private startTime: number = 0;
  private lastFrameTime: number = 0;
  private lastSnapshotTime: number = 0;
  private frameCount = 0;
  private bytesWritten = 0;
  
  private protocol: Protocol = 'sacn';
  private universe: number = 1;
  
  constructor() {
    this.previousChannels = new Uint8Array(TOTAL_CHANNELS);
    this.writeBuffer = Buffer.alloc(WRITE_BUFFER_SIZE);
  }
  
  /**
   * Get current recording state
   */
  getState(): RecordingState {
    return this.state;
  }
  
  /**
   * Get recording statistics
   */
  getStats(): RecordingStats {
    return {
      state: this.state,
      startTime: this.startTime > 0 ? new Date(this.startTime) : null,
      frameCount: this.frameCount,
      bytesWritten: this.bytesWritten,
      filePath: this.filePath,
      duration: this.state === "recording" ? Date.now() - this.startTime : 0,
    };
  }
  
  /**
   * Check if currently recording
   */
  isRecording(): boolean {
    return this.state === "recording";
  }
  
  /**
   * Start recording to a new file
   */
  startRecording(protocol: Protocol, universe: number, outputDir?: string): string {
    if (this.state === "recording") {
      throw new Error("Already recording");
    }
    
    this.protocol = protocol;
    this.universe = universe;
    
    // Generate filename
    const timestamp = formatDateForFilename(new Date());
    const filename = `dmx-recording-${timestamp}.dmxrec`;
    const dir = outputDir || process.cwd();
    this.filePath = path.join(dir, filename);
    
    // Open file for writing (binary mode)
    this.fileHandle = fs.openSync(this.filePath, 'w');
    
    // Write initial header with magic bytes (will be updated on stop with final values)
    const headerBuffer = this.createHeader(0);
    fs.writeSync(this.fileHandle, headerBuffer);
    this.bytesWritten = HEADER_SIZE;
    
    // Reset state
    this.previousChannels.fill(0);
    this.startTime = Date.now();
    this.lastFrameTime = this.startTime;
    this.lastSnapshotTime = this.startTime;
    this.frameCount = 0;
    this.writeOffset = 0;
    
    this.state = "recording";
    
    logInfo("Recording started", { filePath: this.filePath, protocol, universe });
    
    return this.filePath;
  }
  
  /**
   * Stop recording and finalize the file
   */
  stopRecording(): RecordingStats {
    if (this.state !== "recording") {
      throw new Error("Not recording");
    }
    
    // Flush any remaining buffer
    this.flushBuffer();
    
    // Calculate final duration
    const duration = Date.now() - this.startTime;
    
    // Write final header
    if (this.fileHandle !== null) {
      const header = this.createHeader(duration);
      fs.writeSync(this.fileHandle, header, 0, HEADER_SIZE, 0);
      fs.fsyncSync(this.fileHandle);  // Ensure data is flushed to disk
      fs.closeSync(this.fileHandle);
      this.fileHandle = null;
    }
    
    const stats = this.getStats();
    stats.duration = duration;
    
    this.state = "idle";
    
    logInfo("Recording stopped", {
      filePath: this.filePath,
      duration,
      frameCount: this.frameCount,
      bytesWritten: this.bytesWritten,
    });
    
    return stats;
  }
  
  /**
   * Record a frame of DMX data
   * Only stores changes from the previous frame
   */
  recordFrame(channels: Uint8Array): void {
    if (this.state !== "recording") return;
    
    const now = Date.now();
    const isFirstFrame = this.frameCount === 0;
    
    // First frame always has deltaTime = 0 (starts immediately on playback)
    const deltaTime = isFirstFrame ? 0 : (now - this.lastFrameTime);
    
    // Check if we need a full snapshot (first frame or periodic)
    const needsSnapshot = isFirstFrame || (now - this.lastSnapshotTime) >= SNAPSHOT_INTERVAL;
    
    if (needsSnapshot) {
      this.writeSnapshotFrame(channels, deltaTime);
      this.lastSnapshotTime = now;
      // Update state
      this.previousChannels.set(channels);
      this.lastFrameTime = now;
      this.frameCount++;
    } else {
      // Compute delta changes
      const changes: ChannelChange[] = [];
      for (let i = 0; i < TOTAL_CHANNELS; i++) {
        const newValue = channels[i] ?? 0;
        const oldValue = this.previousChannels[i] ?? 0;
        if (newValue !== oldValue) {
          changes.push({ channel: i, value: newValue });
        }
      }
      
      // Only write if there are changes
      if (changes.length > 0) {
        this.writeDeltaFrame(changes, deltaTime);
        // Update state
        this.previousChannels.set(channels);
        this.lastFrameTime = now;
        this.frameCount++;
      }
      // No changes = no frame written, don't update state
    }
  }
  
  /**
   * Write a delta frame to the buffer
   */
  private writeDeltaFrame(changes: ChannelChange[], deltaTime: number): void {
    // Encode delta time as varint
    const deltaBuffer = encodeVarint(deltaTime);
    this.appendToBuffer(deltaBuffer);
    
    // Write change count
    if (changes.length < FrameType.SNAPSHOT) {
      this.appendByte(changes.length);
    } else {
      // Extended count
      this.appendByte(FrameType.EXTENDED);
      this.appendUint16(changes.length);
    }
    
    // Write each change
    for (const change of changes) {
      this.appendUint16(change.channel);
      this.appendByte(change.value);
    }
  }
  
  /**
   * Write a full snapshot frame
   */
  private writeSnapshotFrame(channels: Uint8Array, deltaTime: number): void {
    // Encode delta time as varint
    const deltaBuffer = encodeVarint(deltaTime);
    this.appendToBuffer(deltaBuffer);
    
    // Write snapshot marker
    this.appendByte(FrameType.SNAPSHOT);
    
    // Write all 512 channel values
    this.appendToBuffer(Buffer.from(channels.slice(0, TOTAL_CHANNELS)));
    
    logDebug('Wrote snapshot frame', { deltaTime, frameCount: this.frameCount });
  }
  
  /**
   * Append a single byte to the write buffer
   */
  private appendByte(value: number): void {
    if (this.writeOffset >= this.writeBuffer.length - 1) {
      this.flushBuffer();
    }
    this.writeBuffer[this.writeOffset++] = value;
  }
  
  /**
   * Append a uint16 (little-endian) to the write buffer
   */
  private appendUint16(value: number): void {
    if (this.writeOffset >= this.writeBuffer.length - 2) {
      this.flushBuffer();
    }
    this.writeBuffer.writeUInt16LE(value, this.writeOffset);
    this.writeOffset += 2;
  }
  
  /**
   * Append a buffer to the write buffer
   */
  private appendToBuffer(data: Buffer): void {
    if (this.writeOffset + data.length >= this.writeBuffer.length) {
      this.flushBuffer();
    }
    
    // If data is larger than buffer, write directly
    if (data.length >= this.writeBuffer.length) {
      if (this.fileHandle !== null) {
        fs.writeSync(this.fileHandle, data);
        this.bytesWritten += data.length;
      }
      return;
    }
    
    data.copy(this.writeBuffer, this.writeOffset);
    this.writeOffset += data.length;
  }
  
  /**
   * Flush the write buffer to disk
   */
  private flushBuffer(): void {
    if (this.writeOffset > 0 && this.fileHandle !== null) {
      fs.writeSync(this.fileHandle, this.writeBuffer.subarray(0, this.writeOffset));
      this.bytesWritten += this.writeOffset;
      this.writeOffset = 0;
    }
  }
  
  /**
   * Create the file header buffer
   */
  private createHeader(duration: number): Buffer {
    const header = Buffer.alloc(HEADER_SIZE);
    let offset = 0;
    
    // Magic bytes (4 bytes)
    header.write(DMXREC_MAGIC, offset, 'ascii');
    offset += 4;
    
    // Version (1 byte)
    header.writeUInt8(DMXREC_VERSION, offset++);
    
    // Flags (1 byte)
    header.writeUInt8(RecordingFlags.HAS_SNAPSHOTS, offset++);
    
    // Protocol (1 byte) - 0=sACN, 1=Art-Net
    header.writeUInt8(this.protocol === 'sacn' ? 0 : 1, offset++);
    
    // Universe (2 bytes)
    header.writeUInt16LE(this.universe, offset);
    offset += 2;
    
    // Start timestamp (8 bytes)
    header.writeBigInt64LE(BigInt(this.startTime), offset);
    offset += 8;
    
    // Duration (4 bytes)
    header.writeUInt32LE(duration, offset);
    offset += 4;
    
    // Frame count (4 bytes)
    header.writeUInt32LE(this.frameCount, offset);
    offset += 4;
    
    // Reserved (7 bytes) - already zeroed
    
    return header;
  }
}

/** Speed presets for playback */
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 4.0];

/** Frame index entry for seeking */
interface FrameIndex {
  offset: number;
  position: number;
  isSnapshot: boolean;
}

/**
 * DMX Player - Plays back recorded DMX data
 * 
 * Enhanced with speed control, seeking, and loop support.
 */
export class DMXPlayer {
  private state: PlaybackState = "idle";
  private filePath: string | null = null;
  private header: RecordingHeader | null = null;
  private frameData: Buffer | null = null;
  private frameOffset = 0;
  
  private channels: Uint8Array;
  private currentFrame = 0;
  private playbackStartTime = 0;
  private currentPosition = 0;
  private pausedPosition = 0;
  
  // Speed and loop control
  private speed = 1.0;
  private loopEnabled = false;
  
  // Frame index for seeking (built lazily)
  private frameIndex: FrameIndex[] = [];
  private frameIndexBuilt = false;
  
  private playbackTimer: NodeJS.Timeout | null = null;
  private onFrameCallback: ((channels: Uint8Array) => void) | null = null;
  private onFinishedCallback: (() => void) | null = null;
  private onPositionCallback: ((position: number, duration: number) => void) | null = null;
  private onStateChangeCallback: ((state: PlaybackState) => void) | null = null;
  
  constructor() {
    this.channels = new Uint8Array(TOTAL_CHANNELS);
  }
  
  /**
   * Get current playback state
   */
  getState(): PlaybackState {
    return this.state;
  }
  
  /**
   * Get playback statistics
   */
  getStats(): PlaybackStats {
    return {
      state: this.state,
      position: this.currentPosition,
      duration: this.header?.duration ?? 0,
      frameIndex: this.currentFrame,
      totalFrames: this.header?.frameCount ?? 0,
      filePath: this.filePath,
    };
  }
  
  /**
   * Get the recording header info
   */
  getHeader(): RecordingHeader | null {
    return this.header;
  }
  
  /**
   * Get current playback speed
   */
  getSpeed(): number {
    return this.speed;
  }
  
  /**
   * Get loop enabled status
   */
  isLoopEnabled(): boolean {
    return this.loopEnabled;
  }
  
  /**
   * Get current channel data
   */
  getChannels(): Uint8Array {
    return this.channels;
  }
  
  /**
   * Load a recording file for playback
   */
  load(filePath: string): RecordingHeader {
    if (this.state === "playing") {
      this.stop();
    }
    
    this.filePath = filePath;
    
    // Read entire file into memory
    const fileBuffer = fs.readFileSync(filePath);
    
    // Parse header
    this.header = this.parseHeader(fileBuffer);
    
    // Store frame data (everything after header)
    this.frameData = fileBuffer.subarray(HEADER_SIZE);
    this.frameOffset = 0;
    
    // Clear frame index (will be built lazily on first seek)
    this.frameIndex = [];
    this.frameIndexBuilt = false;
    
    // Reset state
    this.channels.fill(0);
    this.currentFrame = 0;
    this.currentPosition = 0;
    
    this.state = "idle";
    
    logInfo("Recording loaded", {
      filePath,
      duration: this.header.duration,
      frameCount: this.header.frameCount,
    });
    
    return this.header;
  }
  
  /**
   * Build frame index for seeking (only indexes snapshots for efficiency)
   * Called lazily on first seek operation
   */
  private buildFrameIndex(): void {
    if (!this.frameData || this.frameIndexBuilt) return;
    
    const startTime = Date.now();
    this.frameIndex = [];
    let offset = 0;
    let position = 0;
    
    while (offset < this.frameData.length) {
      const frameStart = offset;
      
      // Read delta time (varint)
      const { value: deltaTime, bytesRead: deltaBytes } = decodeVarint(this.frameData, offset);
      offset += deltaBytes;
      
      // Read change count
      const changeCount = this.frameData[offset++];
      if (changeCount === undefined) break;
      
      const isSnapshot = changeCount === FrameType.SNAPSHOT;
      
      // Only index snapshot frames (needed for seeking)
      if (isSnapshot) {
        this.frameIndex.push({
          offset: frameStart,
          position,
          isSnapshot: true,
        });
      }
      
      position += deltaTime;
      
      // Skip frame data
      if (isSnapshot) {
        offset += TOTAL_CHANNELS;
      } else {
        let actualChangeCount = changeCount;
        if (changeCount === FrameType.EXTENDED) {
          actualChangeCount = this.frameData.readUInt16LE(offset);
          offset += 2;
        }
        // Skip changes (3 bytes each: 2 for channel, 1 for value)
        offset += actualChangeCount * 3;
      }
    }
    
    this.frameIndexBuilt = true;
    logDebug("Frame index built", { snapshots: this.frameIndex.length, timeMs: Date.now() - startTime });
  }
  
  /**
   * Parse the file header
   */
  private parseHeader(buffer: Buffer): RecordingHeader {
    if (buffer.length < HEADER_SIZE) {
      throw new Error("Invalid recording file: too small");
    }
    
    let offset = 0;
    
    // Magic bytes
    const magic = buffer.toString("ascii", offset, offset + 4);
    offset += 4;
    
    if (magic !== DMXREC_MAGIC) {
      throw new Error(`Invalid recording file: bad magic bytes "${magic}"`);
    }
    
    // Version
    const version = buffer.readUInt8(offset++);
    if (version > DMXREC_VERSION) {
      throw new Error(`Unsupported recording version: ${version}`);
    }
    
    // Flags
    const flags = buffer.readUInt8(offset++);
    
    // Protocol
    const protocol = buffer.readUInt8(offset++);
    
    // Universe
    const universe = buffer.readUInt16LE(offset);
    offset += 2;
    
    // Start timestamp
    const startTime = Number(buffer.readBigInt64LE(offset));
    offset += 8;
    
    // Duration
    const duration = buffer.readUInt32LE(offset);
    offset += 4;
    
    // Frame count
    const frameCount = buffer.readUInt32LE(offset);
    
    return {
      magic,
      version,
      flags,
      protocol,
      universe,
      startTime,
      duration,
      frameCount,
    };
  }
  
  /**
   * Set callback for frame updates during playback
   */
  onFrame(callback: (channels: Uint8Array) => void): void {
    this.onFrameCallback = callback;
  }
  
  /**
   * Set callback for playback finished
   */
  onFinished(callback: () => void): void {
    this.onFinishedCallback = callback;
  }
  
  /**
   * Set callback for position updates
   */
  onPosition(callback: (position: number, duration: number) => void): void {
    this.onPositionCallback = callback;
  }
  
  /**
   * Set callback for state changes
   */
  onStateChange(callback: (state: PlaybackState) => void): void {
    this.onStateChangeCallback = callback;
  }
  
  /**
   * Set playback state and notify listeners
   */
  private setState(newState: PlaybackState): void {
    if (this.state !== newState) {
      this.state = newState;
      if (this.onStateChangeCallback) {
        this.onStateChangeCallback(newState);
      }
    }
  }
  
  /**
   * Start or resume playback
   */
  play(): void {
    if (!this.frameData || !this.header) {
      throw new Error("No recording loaded");
    }
    
    if (this.state === "playing") return;
    
    if (this.state === "paused") {
      // Resume from paused position - adjust for speed
      this.playbackStartTime = Date.now() - (this.pausedPosition / this.speed);
    } else {
      // Start from beginning
      this.playbackStartTime = Date.now();
      this.frameOffset = 0;
      this.currentFrame = 0;
      this.currentPosition = 0;
      this.channels.fill(0);
    }
    
    this.setState("playing");
    this.scheduleNextFrame();
    
    logInfo("Playback started", { position: this.currentPosition, speed: this.speed });
  }
  
  /**
   * Pause playback
   */
  pause(): void {
    if (this.state !== "playing") return;
    
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    
    this.pausedPosition = this.currentPosition;
    this.setState("paused");
    
    logInfo("Playback paused", { position: this.currentPosition });
  }
  
  /**
   * Toggle play/pause
   */
  togglePlayPause(): void {
    if (this.state === "playing") {
      this.pause();
    } else if (this.state === "paused" || this.state === "idle" || this.state === "finished") {
      if (this.state === "finished") {
        // Reset to beginning if finished
        this.frameOffset = 0;
        this.currentFrame = 0;
        this.currentPosition = 0;
        this.pausedPosition = 0;
        this.channels.fill(0);
      }
      this.play();
    }
  }
  
  /**
   * Stop playback and reset to beginning
   */
  stop(): void {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    
    this.frameOffset = 0;
    this.currentFrame = 0;
    this.currentPosition = 0;
    this.pausedPosition = 0;
    this.channels.fill(0);
    this.setState("idle");
    
    // Emit position update
    if (this.onPositionCallback && this.header) {
      this.onPositionCallback(0, this.header.duration);
    }
    
    // Emit frame with zeroed channels
    if (this.onFrameCallback) {
      this.onFrameCallback(this.channels);
    }
    
    logInfo("Playback stopped");
  }
  
  /**
   * Set playback speed
   */
  setSpeed(speed: number): void {
    const clampedSpeed = Math.max(0.1, Math.min(10.0, speed));
    
    if (this.state === "playing") {
      // Adjust playback start time to maintain position
      const elapsed = this.currentPosition;
      this.speed = clampedSpeed;
      this.playbackStartTime = Date.now() - (elapsed / this.speed);
    } else {
      this.speed = clampedSpeed;
    }
    
    logInfo("Playback speed changed", { speed: this.speed });
  }
  
  /**
   * Increase speed to next preset
   */
  increaseSpeed(): void {
    const currentIndex = SPEED_PRESETS.findIndex(s => s >= this.speed);
    if (currentIndex < SPEED_PRESETS.length - 1) {
      this.setSpeed(SPEED_PRESETS[currentIndex + 1] ?? this.speed);
    }
  }
  
  /**
   * Decrease speed to previous preset
   */
  decreaseSpeed(): void {
    const currentIndex = SPEED_PRESETS.findIndex(s => s >= this.speed);
    if (currentIndex > 0) {
      this.setSpeed(SPEED_PRESETS[currentIndex - 1] ?? this.speed);
    } else if (currentIndex === -1) {
      // Speed is higher than all presets, go to highest preset
      this.setSpeed(SPEED_PRESETS[SPEED_PRESETS.length - 1] ?? this.speed);
    }
  }
  
  /**
   * Toggle loop mode
   */
  toggleLoop(): void {
    this.loopEnabled = !this.loopEnabled;
    logInfo("Loop mode changed", { enabled: this.loopEnabled });
  }
  
  /**
   * Set loop mode
   */
  setLoop(enabled: boolean): void {
    this.loopEnabled = enabled;
    logInfo("Loop mode set", { enabled: this.loopEnabled });
  }
  
  /**
   * Seek to a specific position (ms)
   */
  seek(positionMs: number): void {
    if (!this.frameData || !this.header) return;
    
    // Build frame index if not already built (lazy initialization)
    if (!this.frameIndexBuilt) {
      this.buildFrameIndex();
    }
    
    const wasPlaying = this.state === "playing";
    
    // Pause if playing
    if (wasPlaying) {
      if (this.playbackTimer) {
        clearTimeout(this.playbackTimer);
        this.playbackTimer = null;
      }
    }
    
    // Clamp position
    const targetPosition = Math.max(0, Math.min(positionMs, this.header.duration));
    
    // Find the nearest snapshot before target position
    let snapshotIndex = -1;
    
    for (let i = this.frameIndex.length - 1; i >= 0; i--) {
      const entry = this.frameIndex[i];
      if (entry && entry.position <= targetPosition) {
        snapshotIndex = i;
        break;
      }
    }
    
    // Reset channels
    this.channels.fill(0);
    
    // If we found a snapshot, start from there
    if (snapshotIndex >= 0) {
      const entry = this.frameIndex[snapshotIndex];
      if (entry) {
        this.frameOffset = entry.offset;
        this.currentPosition = entry.position;
        this.currentFrame = snapshotIndex;
        
        // Read and apply the snapshot
        const frame = this.readNextFrame();
        if (frame?.isSnapshot && frame.snapshotData) {
          this.channels.set(frame.snapshotData);
        }
      }
    } else {
      // No snapshot found, start from beginning
      this.frameOffset = 0;
      this.currentPosition = 0;
      this.currentFrame = 0;
    }
    
    // Replay frames until we reach target position
    while (this.currentPosition < targetPosition && this.frameOffset < this.frameData.length) {
      const frame = this.readNextFrame();
      if (!frame) break;
      
      this.currentPosition += frame.deltaTime;
      this.currentFrame++;
      
      if (this.currentPosition > targetPosition) {
        // Went past target, back up
        this.currentPosition -= frame.deltaTime;
        break;
      }
      
      // Apply frame
      if (frame.isSnapshot && frame.snapshotData) {
        this.channels.set(frame.snapshotData);
      } else {
        for (const change of frame.changes) {
          this.channels[change.channel] = change.value;
        }
      }
    }
    
    this.pausedPosition = this.currentPosition;
    
    // Emit position update
    if (this.onPositionCallback) {
      this.onPositionCallback(this.currentPosition, this.header.duration);
    }
    
    // Emit frame with current channels
    if (this.onFrameCallback) {
      this.onFrameCallback(this.channels);
    }
    
    logInfo("Seeked to position", { position: this.currentPosition, target: targetPosition });
    
    // Resume if was playing
    if (wasPlaying) {
      this.playbackStartTime = Date.now() - (this.currentPosition / this.speed);
      this.setState("playing");
      this.scheduleNextFrame();
    }
  }
  
  /**
   * Seek forward by specified milliseconds
   */
  seekForward(ms: number = 5000): void {
    this.seek(this.currentPosition + ms);
  }
  
  /**
   * Seek backward by specified milliseconds
   */
  seekBackward(ms: number = 5000): void {
    this.seek(this.currentPosition - ms);
  }
  
  /**
   * Schedule the next frame for playback
   */
  private scheduleNextFrame(): void {
    if (this.state !== "playing" || !this.frameData || !this.header) return;
    
    // Check if we've reached the end
    if (this.frameOffset >= this.frameData.length || this.currentFrame >= this.header.frameCount) {
      if (this.loopEnabled) {
        // Loop back to beginning
        logInfo("Looping playback");
        this.frameOffset = 0;
        this.currentFrame = 0;
        this.currentPosition = 0;
        this.channels.fill(0);
        this.playbackStartTime = Date.now();
        this.scheduleNextFrame();
        return;
      }
      
      this.setState("finished");
      if (this.onFinishedCallback) {
        this.onFinishedCallback();
      }
      return;
    }
    
    // Read the next frame
    const frame = this.readNextFrame();
    if (!frame) {
      if (this.loopEnabled) {
        // Loop back to beginning
        this.frameOffset = 0;
        this.currentFrame = 0;
        this.currentPosition = 0;
        this.channels.fill(0);
        this.playbackStartTime = Date.now();
        this.scheduleNextFrame();
        return;
      }
      
      this.setState("finished");
      if (this.onFinishedCallback) {
        this.onFinishedCallback();
      }
      return;
    }
    
    // Calculate when this frame should be displayed (adjusted for speed)
    this.currentPosition += frame.deltaTime;
    const adjustedPosition = this.currentPosition / this.speed;
    const targetTime = this.playbackStartTime + adjustedPosition;
    const delay = Math.max(0, targetTime - Date.now());
    
    this.playbackTimer = setTimeout(() => {
      // Apply frame to channel data
      if (frame.isSnapshot && frame.snapshotData) {
        this.channels.set(frame.snapshotData);
      } else {
        for (const change of frame.changes) {
          this.channels[change.channel] = change.value;
        }
      }
      
      this.currentFrame++;
      
      // Emit frame
      if (this.onFrameCallback) {
        this.onFrameCallback(this.channels);
      }
      
      // Emit position update (throttled - every 100ms worth of playback)
      if (this.onPositionCallback && this.header) {
        this.onPositionCallback(this.currentPosition, this.header.duration);
      }
      
      // Schedule next frame
      this.scheduleNextFrame();
    }, delay);
  }
  
  /**
   * Read the next frame from the buffer
   */
  private readNextFrame(): RecordingFrame | null {
    if (!this.frameData || this.frameOffset >= this.frameData.length) {
      return null;
    }
    
    // Read delta time (varint)
    const { value: deltaTime, bytesRead: deltaBytes } = decodeVarint(this.frameData, this.frameOffset);
    this.frameOffset += deltaBytes;
    
    // Read change count
    const changeCount = this.frameData[this.frameOffset++];
    if (changeCount === undefined) return null;
    
    // Check for snapshot frame
    if (changeCount === FrameType.SNAPSHOT) {
      const snapshotData = new Uint8Array(this.frameData.subarray(this.frameOffset, this.frameOffset + TOTAL_CHANNELS));
      this.frameOffset += TOTAL_CHANNELS;
      
      return {
        deltaTime,
        changes: [],
        isSnapshot: true,
        snapshotData,
      };
    }
    
    // Read change count (possibly extended)
    let actualChangeCount = changeCount;
    if (changeCount === FrameType.EXTENDED) {
      actualChangeCount = this.frameData.readUInt16LE(this.frameOffset);
      this.frameOffset += 2;
    }
    
    // Read changes
    const changes: ChannelChange[] = [];
    for (let i = 0; i < actualChangeCount; i++) {
      const channel = this.frameData.readUInt16LE(this.frameOffset);
      this.frameOffset += 2;
      const value = this.frameData[this.frameOffset++];
      if (value !== undefined) {
        changes.push({ channel, value });
      }
    }
    
    return {
      deltaTime,
      changes,
      isSnapshot: false,
    };
  }
}

/**
 * Create a new DMX recorder
 */
export function createRecorder(): DMXRecorder {
  return new DMXRecorder();
}

/**
 * Create a new DMX player
 */
export function createPlayer(): DMXPlayer {
  return new DMXPlayer();
}
