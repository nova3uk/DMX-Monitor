/**
 * Terminal UI manager for DMX Monitor
 * 
 * Displays a 32x16 grid of DMX channel values with color coding
 * Red (0) -> Green (255) based on channel value
 */

import blessed from "blessed";
import { GRID_COLUMNS, GRID_ROWS, TOTAL_CHANNELS, MonitorStats, RecordingState, PlaybackState, SACNSourceInfo, Protocol, formatUniverseForDisplay } from "./types";
import { DisplayError } from "./errors";
import { logDebug, logError, logInfo, disableConsoleLogging } from "./logger";

/** UI Mode - monitor or playback */
export type UIMode = "monitor" | "playback";

/** Playback display info */
export interface PlaybackInfo {
  state: PlaybackState;
  position: number;
  duration: number;
  speed: number;
  loopEnabled: boolean;
  fileName: string;
  universe: number;
  protocol: string;
}

/** Display configuration */
export interface DisplayConfig {
  /** Title to show in the header */
  title?: string;
  /** Update rate in milliseconds */
  updateRate?: number;
}

/** Display mode - what to show in each cell */
export type DisplayMode = "value" | "channel";

/** Layout mode based on available space */
type LayoutMode = "side" | "hidden";

/** Default configuration */
const DEFAULT_UPDATE_RATE = 50; // 20 FPS

/** Stats panel width */
const STATS_WIDTH = 26;

/** Minimum width to show stats on side */
const MIN_WIDTH_FOR_SIDE_STATS = 180;

/** Row header width for channel ranges */
const ROW_HEADER_WIDTH = 8;

/** Column header height */
const COL_HEADER_HEIGHT = 1;

/** Resize debounce delay in ms */
const RESIZE_DEBOUNCE_MS = 150;

/**
 * Simple color mapping using basic colors for compatibility
 * Returns color name that blessed understands
 */
function getSimpleColor(value: number): string {
  const v = Math.max(0, Math.min(255, value));

  if (v < 43) return "red";
  if (v < 85) return "yellow";
  if (v < 128) return "yellow";
  if (v < 170) return "green";
  if (v < 213) return "green";
  return "green";
}

/**
 * Format value for display, centered in available width
 */
function formatCentered(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length >= width) return text.substring(0, width);
  const padding = Math.floor((width - text.length) / 2);
  return " ".repeat(padding) + text + " ".repeat(width - text.length - padding);
}

/**
 * Display manager for DMX Monitor
 */
export class DisplayManager {
  private screen: blessed.Widgets.Screen | null = null;
  private gridContainer: blessed.Widgets.BoxElement | null = null;
  private channelBoxes: blessed.Widgets.BoxElement[][] = [];
  private colHeaders: blessed.Widgets.BoxElement[] = [];
  private rowHeaders: blessed.Widgets.BoxElement[] = [];
  private statsBox: blessed.Widgets.BoxElement | null = null;
  private headerBox: blessed.Widgets.BoxElement | null = null;
  private footerBox: blessed.Widgets.BoxElement | null = null;
  private readonly config: DisplayConfig;
  private channelData: Uint8Array;
  private stats: MonitorStats;
  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private needsRender = false;
  private _displayMode: DisplayMode = "value";
  private lastToggleTime = 0;
  private lastRecordingToggleTime = 0;

  // Resize debouncing
  private resizeTimeout: NodeJS.Timeout | null = null;
  private isResizing = false;

  // Layout state
  private layoutMode: LayoutMode = "side";

  // Calculated cell dimensions
  private cellWidth = 4;
  private cellHeight = 1;

  // Recording state
  private _recordingState: RecordingState = "idle";
  private recordingStartTime: Date | null = null;
  private recordingFrameCount = 0;
  private onRecordingToggleCallback: (() => void) | null = null;

  // Playback mode
  private _uiMode: UIMode = "monitor";
  private playbackInfo: PlaybackInfo = {
    state: "idle",
    position: 0,
    duration: 0,
    speed: 1.0,
    loopEnabled: false,
    fileName: "",
    universe: 0,
    protocol: "sacn",
  };

  // Playback callbacks
  private onPlayPauseCallback: (() => void) | null = null;
  private onStopCallback: (() => void) | null = null;
  private onSeekForwardCallback: (() => void) | null = null;
  private onSeekBackwardCallback: (() => void) | null = null;
  private onSpeedUpCallback: (() => void) | null = null;
  private onSpeedDownCallback: (() => void) | null = null;
  private onLoopToggleCallback: (() => void) | null = null;

  // sACN competing sources warning
  private competingSources: SACNSourceInfo[] = [];

  constructor(config: DisplayConfig = {}) {
    this.config = {
      title: config.title ?? "DMX Monitor",
      updateRate: config.updateRate ?? DEFAULT_UPDATE_RATE,
    };

    this.channelData = new Uint8Array(TOTAL_CHANNELS);
    this.stats = {
      protocol: "sacn",
      universe: 0,
      bindAddress: "0.0.0.0",
      packetsReceived: 0,
      packetsPerSecond: 0,
      lastPacketTime: null,
      startTime: new Date(),
      errors: 0,
    };
  }

  /**
   * Get current display mode
   */
  get displayMode(): DisplayMode {
    return this._displayMode;
  }

  /**
   * Get current recording state
   */
  get recordingState(): RecordingState {
    return this._recordingState;
  }

  /**
   * Initialize the display
   */
  async init(): Promise<void> {
    logInfo("Initializing display");

    try {
      // Check if we have a TTY
      if (!process.stdout.isTTY) {
        throw new Error("Not running in a TTY. Please run in a terminal.");
      }

      // Check terminal type - use xterm as default for pkg executables
      let term = process.env["TERM"];
      if (!term || term === "unknown" || term === "dumb") {
        // In pkg executables, TERM may not be set properly
        // Default to xterm-256color for best compatibility
        term = "xterm-256color";
        process.env["TERM"] = term;
      }
      logDebug(`Terminal type: ${term}`);

      // Disable console logging to avoid interference
      disableConsoleLogging();

      // Create screen with settings optimized for pkg executables
      this.screen = blessed.screen({
        smartCSR: true,
        title: this.config.title,
        fullUnicode: false, // Disable full unicode for better compatibility
        dockBorders: false, // Disable dock borders for compatibility
        autoPadding: false,
        warnings: false,
        fastCSR: true, // Use fast CSR for better performance
        useBCE: true, // Use back color erase
        forceUnicode: false, // Don't force unicode
        input: process.stdin,
        output: process.stdout,
        terminal: term,
      });

      // Verify screen was created properly
      if (!this.screen) {
        throw new Error("Failed to create blessed screen");
      }

      // Patch terminal object to prevent crashes during cleanup in pkg executables
      // blessed tries to access terminal.isAlt during cleanup, but it may be undefined
      if (this.screen.terminal && typeof this.screen.terminal === "object") {
        const termObj = this.screen.terminal as any;
        if (termObj.isAlt === undefined) {
          termObj.isAlt = false;
        }
        // Also patch other potentially undefined properties
        if (termObj.isCtrl === undefined) {
          termObj.isCtrl = false;
        }
        if (termObj.isShift === undefined) {
          termObj.isShift = false;
        }
      }

      // Hide the cursor
      try {
        process.stdout.write("\x1B[?25l");
      } catch (e) {
        // Ignore cursor hide errors
        logDebug("Could not hide cursor");
      }

      // Create layout
      this.createLayout();

      // Setup key handlers
      this.setupKeyHandlers();

      // Handle resize with debouncing
      this.screen.on("resize", () => {
        this.handleResize();
      });

      this.isRunning = true;
      logInfo("Display initialized");
    } catch (error) {
      // Log the actual error for debugging
      logError(error, "Display initialization failed");

      // Clean up if screen was partially created
      if (this.screen) {
        try {
          this.screen.destroy();
        } catch (e) {
          // Ignore cleanup errors
        }
        this.screen = null;
      }
      throw DisplayError.initFailed(error instanceof Error ? error : undefined);
    }
  }

  /**
   * Determine layout mode based on screen width
   */
  private getLayoutMode(): LayoutMode {
    if (!this.screen) return "side";
    const screenWidth = this.screen.width as number;
    return screenWidth >= MIN_WIDTH_FOR_SIDE_STATS ? "side" : "hidden";
  }

  /**
   * Calculate cell dimensions to fill available space
   */
  private calculateCellDimensions(): { width: number; height: number } {
    if (!this.screen) return { width: 4, height: 1 };

    const screenWidth = this.screen.width as number;
    const screenHeight = this.screen.height as number;

    // Determine if stats panel is shown on side
    const statsWidth = this.layoutMode === "side" ? STATS_WIDTH : 0;

    // Available space for grid
    const availableWidth = screenWidth - statsWidth - 2 - ROW_HEADER_WIDTH;
    const availableHeight = screenHeight - 3 - 3 - 2 - COL_HEADER_HEIGHT;

    // Calculate cell size to use available space
    const cellWidth = Math.max(3, Math.floor(availableWidth / GRID_COLUMNS));
    const cellHeight = Math.max(1, Math.floor(availableHeight / GRID_ROWS));

    return { width: cellWidth, height: cellHeight };
  }

  /**
   * Destroy all UI elements
   */
  private destroyAllElements(): void {
    for (const header of this.colHeaders) {
      header.destroy();
    }
    this.colHeaders = [];

    for (const header of this.rowHeaders) {
      header.destroy();
    }
    this.rowHeaders = [];

    for (const row of this.channelBoxes) {
      for (const box of row) {
        box.destroy();
      }
    }
    this.channelBoxes = [];

    if (this.gridContainer) {
      this.gridContainer.destroy();
      this.gridContainer = null;
    }

    if (this.statsBox) {
      this.statsBox.destroy();
      this.statsBox = null;
    }

    if (this.headerBox) {
      this.headerBox.destroy();
      this.headerBox = null;
    }

    if (this.footerBox) {
      this.footerBox.destroy();
      this.footerBox = null;
    }
  }

  /**
   * Create the UI layout
   */
  private createLayout(): void {
    if (!this.screen) return;

    // Determine layout mode
    this.layoutMode = this.getLayoutMode();

    // Calculate cell dimensions
    const dims = this.calculateCellDimensions();
    this.cellWidth = dims.width;
    this.cellHeight = dims.height;

    // Calculate actual grid size
    const statsWidth = this.layoutMode === "side" ? STATS_WIDTH : 0;
    const gridHeight = COL_HEADER_HEIGHT + GRID_ROWS * this.cellHeight + 2;

    // Header
    this.headerBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      content: ` ${this.config.title} `,
      tags: true,
      border: { type: "line" },
      style: {
        fg: "white",
        bg: "blue",
        border: { fg: "cyan" },
      },
    });

    // Stats panel - only show on side if enough width
    if (this.layoutMode === "side") {
      this.statsBox = blessed.box({
        parent: this.screen,
        top: 3,
        right: 0,
        width: STATS_WIDTH,
        height: "100%-6",
        label: " Statistics ",
        tags: true,
        border: { type: "line" },
        style: {
          fg: "white",
          border: { fg: "cyan" },
        },
      });
    }

    // Channel grid container
    this.gridContainer = blessed.box({
      parent: this.screen,
      top: 3,
      left: 0,
      width: this.layoutMode === "side" ? `100%-${statsWidth}` : "100%",
      height: gridHeight,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
      },
    });

    // Create column headers (1-32)
    this.colHeaders = [];
    for (let col = 0; col < GRID_COLUMNS; col++) {
      const header = blessed.box({
        parent: this.gridContainer,
        top: 0,
        left: ROW_HEADER_WIDTH + col * this.cellWidth,
        width: this.cellWidth,
        height: COL_HEADER_HEIGHT,
        content: formatCentered((col + 1).toString(), this.cellWidth),
        style: {
          fg: "yellow",
          bold: true,
        },
      });
      this.colHeaders.push(header);
    }

    // Create row headers
    this.rowHeaders = [];
    for (let row = 0; row < GRID_ROWS; row++) {
      const startChannel = row * GRID_COLUMNS + 1;
      const endChannel = (row + 1) * GRID_COLUMNS;
      const rowTop = COL_HEADER_HEIGHT + row * this.cellHeight;
      const header = blessed.box({
        parent: this.gridContainer,
        top: rowTop,
        left: 0,
        width: ROW_HEADER_WIDTH,
        height: this.cellHeight,
        content: `${startChannel}-${endChannel}`.padStart(ROW_HEADER_WIDTH - 1, " "),
        style: {
          fg: "yellow",
          bold: true,
        },
      });
      this.rowHeaders.push(header);
    }

    // Create channel boxes (32x16 grid)
    this.channelBoxes = [];
    const useBorder = this.cellHeight >= 3 && this.cellWidth >= 5;

    for (let row = 0; row < GRID_ROWS; row++) {
      this.channelBoxes[row] = [];
      for (let col = 0; col < GRID_COLUMNS; col++) {
        const cellTop = COL_HEADER_HEIGHT + row * this.cellHeight;
        const cellLeft = ROW_HEADER_WIDTH + col * this.cellWidth;
        const channelIndex = row * GRID_COLUMNS + col;
        const value = this.channelData[channelIndex] ?? 0;

        const box = blessed.box({
          parent: this.gridContainer,
          top: cellTop,
          left: cellLeft,
          width: this.cellWidth,
          height: this.cellHeight,
          content: this.getCellContent(channelIndex, value),
          border: useBorder ? { type: "line" } : undefined,
          style: {
            fg: value < 85 ? "white" : "black",
            bg: getSimpleColor(value),
            border: { fg: "white" },
          },
        });
        this.channelBoxes[row]![col] = box;
      }
    }

    // Footer with help - include stats info if panel is hidden
    this.footerBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      content: this.getFooterContent(),
      tags: true,
      border: { type: "line" },
      style: {
        fg: "white",
        border: { fg: "cyan" },
      },
    });
  }

  /**
   * Get cell content based on display mode
   */
  private getCellContent(channelIndex: number, value: number): string {
    const hasBorder = this.cellHeight >= 3 && this.cellWidth >= 5;
    const innerWidth = hasBorder ? this.cellWidth - 2 : this.cellWidth;

    if (this._displayMode === "value") {
      return formatCentered(value.toString(), innerWidth);
    } else {
      return formatCentered((channelIndex + 1).toString(), innerWidth);
    }
  }

  /**
   * Rebuild the entire layout
   */
  private rebuildLayout(): void {
    if (!this.screen) return;

    // Destroy all existing elements
    this.destroyAllElements();

    // Recreate layout
    this.createLayout();

    // Force render
    this.needsRender = true;
    this.render();
  }

  /**
   * Get footer content based on current mode and layout
   */
  private getFooterContent(): string {
    if (this._uiMode === "playback") {
      return this.getPlaybackFooterContent();
    }

    const modeText = this._displayMode === "value" ? "VALUES" : "CHANNELS";
    const recText = this._recordingState === "recording" ? "*** RECORDING ***" : "{bold}R{/bold}: Record";

    if (this.layoutMode === "hidden") {
      // Include basic stats in footer when stats panel is hidden
      // Convert universe to 1-indexed display format for Art-Net
      const displayUniverse = formatUniverseForDisplay(this.stats.universe, this.stats.protocol);
      const pps = this.stats.packetsPerSecond.toFixed(0);
      return ` {bold}Q{/bold}: Quit | ${recText} | {bold}C{/bold}: Clear | {bold}V{/bold}: Toggle (${modeText}) | Pkts: ${this.stats.packetsReceived} | ${pps}/s | U:${displayUniverse} `;
    }

    return ` {bold}Q{/bold}: Quit | ${recText} | {bold}C{/bold}: Clear | {bold}V{/bold}: Toggle (${modeText}) `;
  }

  /**
   * Get footer content for playback mode
   */
  private getPlaybackFooterContent(): string {
    const playPauseText = this.playbackInfo.state === "playing" ? "Pause" : "Play";
    const loopText = this.playbackInfo.loopEnabled ? "{green-fg}L{/green-fg}" : "L";

    return ` {bold}Space{/bold}: ${playPauseText} | {bold}S{/bold}: Stop | {bold}${loopText}{/bold}: Loop | {bold}+/-{/bold}: Speed | {bold}←/→{/bold}: Seek | {bold}Q{/bold}: Quit `;
  }

  /**
   * Toggle between value and channel display modes
   */
  public toggleDisplayMode(): void {
    // Debounce
    const now = Date.now();
    if (now - this.lastToggleTime < 200) {
      return;
    }
    this.lastToggleTime = now;

    this._displayMode = this._displayMode === "value" ? "channel" : "value";
    logInfo(`Display mode changed to: ${this._displayMode}`);

    // Update footer
    if (this.footerBox) {
      this.footerBox.setContent(this.getFooterContent());
    }

    // Update stats display
    if (this.statsBox) {
      this.updateStatsContent();
    }

    // Force render
    this.needsRender = true;
    this.render();
  }

  /**
   * Set callback for recording toggle
   */
  public onRecordingToggle(callback: () => void): void {
    this.onRecordingToggleCallback = callback;
  }

  /**
   * Toggle recording state (calls external handler)
   */
  public toggleRecording(): void {
    // Debounce - prevent double-trigger from key repeat
    const now = Date.now();
    if (now - this.lastRecordingToggleTime < 500) {
      logDebug("toggleRecording debounced", { timeSinceLast: now - this.lastRecordingToggleTime });
      return;
    }
    this.lastRecordingToggleTime = now;

    logInfo("Display.toggleRecording called", { hasCallback: !!this.onRecordingToggleCallback });
    if (this.onRecordingToggleCallback) {
      this.onRecordingToggleCallback();
    } else {
      logInfo("Display.toggleRecording: NO CALLBACK SET!");
    }
  }

  /**
   * Update recording state (called from external recorder)
   */
  public setRecordingState(state: RecordingState, startTime?: Date, frameCount?: number): void {
    logInfo("Display.setRecordingState called", { state, startTime: startTime?.toISOString(), frameCount, currentState: this._recordingState });
    this._recordingState = state;
    this.recordingStartTime = startTime ?? null;
    this.recordingFrameCount = frameCount ?? 0;

    // Update footer
    if (this.footerBox) {
      const content = this.getFooterContent();
      logInfo("Setting footer content", { content: content.substring(0, 50) });
      this.footerBox.setContent(content);
    }

    // Update stats if visible
    if (this.statsBox) {
      this.updateStatsContent();
    }

    // Force immediate render
    this.needsRender = true;
    if (this.screen) {
      this.screen.render();
    }

    logInfo(`Recording state changed to: ${state}`);
  }

  /**
   * Update recording frame count
   */
  public updateRecordingFrameCount(frameCount: number): void {
    this.recordingFrameCount = frameCount;
  }

  // =========================================================================
  // Playback Mode Methods
  // =========================================================================

  /**
   * Set UI mode (monitor or playback)
   */
  public setUIMode(mode: UIMode): void {
    this._uiMode = mode;
    logInfo(`UI mode set to: ${mode}`);
  }

  /**
   * Get current UI mode
   */
  public getUIMode(): UIMode {
    return this._uiMode;
  }

  /**
   * Update playback info
   */
  public updatePlaybackInfo(info: Partial<PlaybackInfo>): void {
    this.playbackInfo = { ...this.playbackInfo, ...info };

    // Update footer
    if (this.footerBox) {
      this.footerBox.setContent(this.getFooterContent());
    }

    // Update stats if visible
    if (this.statsBox) {
      this.updateStatsContent();
    }

    this.needsRender = true;
  }

  /**
   * Set callback for play/pause
   */
  public onPlayPause(callback: () => void): void {
    this.onPlayPauseCallback = callback;
  }

  /**
   * Set callback for stop
   */
  public onStop(callback: () => void): void {
    this.onStopCallback = callback;
  }

  /**
   * Set callback for seek forward
   */
  public onSeekForward(callback: () => void): void {
    this.onSeekForwardCallback = callback;
  }

  /**
   * Set callback for seek backward
   */
  public onSeekBackward(callback: () => void): void {
    this.onSeekBackwardCallback = callback;
  }

  /**
   * Set callback for speed up
   */
  public onSpeedUp(callback: () => void): void {
    this.onSpeedUpCallback = callback;
  }

  /**
   * Set callback for speed down
   */
  public onSpeedDown(callback: () => void): void {
    this.onSpeedDownCallback = callback;
  }

  /**
   * Set callback for loop toggle
   */
  public onLoopToggle(callback: () => void): void {
    this.onLoopToggleCallback = callback;
  }

  /**
   * Setup keyboard handlers
   */
  private setupKeyHandlers(): void {
    if (!this.screen) return;

    // Quit
    this.screen.key(["q", "C-c", "escape"], () => {
      this.stop();
      process.exit(0);
    });

    if (this._uiMode === "playback") {
      this.setupPlaybackKeyHandlers();
    } else {
      this.setupMonitorKeyHandlers();
    }
  }

  /**
   * Setup keyboard handlers for monitor mode
   */
  private setupMonitorKeyHandlers(): void {
    if (!this.screen) return;

    logInfo("Setting up monitor key handlers");

    // Toggle recording
    this.screen.key(["r"], () => {
      logInfo("R key pressed");
      this.toggleRecording();
    });

    // Clear values
    this.screen.key(["c"], () => {
      this.clearChannels();
    });

    // Toggle display mode
    this.screen.key(["v"], () => {
      this.toggleDisplayMode();
    });
  }

  /**
   * Setup keyboard handlers for playback mode
   */
  private setupPlaybackKeyHandlers(): void {
    if (!this.screen) return;

    // Play/Pause (Space)
    this.screen.key(["space"], () => {
      if (this.onPlayPauseCallback) {
        this.onPlayPauseCallback();
      }
    });

    // Stop
    this.screen.key(["s"], () => {
      if (this.onStopCallback) {
        this.onStopCallback();
      }
    });

    // Loop toggle
    this.screen.key(["l"], () => {
      if (this.onLoopToggleCallback) {
        this.onLoopToggleCallback();
      }
    });

    // Speed up
    this.screen.key(["+", "="], () => {
      if (this.onSpeedUpCallback) {
        this.onSpeedUpCallback();
      }
    });

    // Speed down
    this.screen.key(["-", "_"], () => {
      if (this.onSpeedDownCallback) {
        this.onSpeedDownCallback();
      }
    });

    // Seek forward
    this.screen.key(["right"], () => {
      if (this.onSeekForwardCallback) {
        this.onSeekForwardCallback();
      }
    });

    // Seek backward
    this.screen.key(["left"], () => {
      if (this.onSeekBackwardCallback) {
        this.onSeekBackwardCallback();
      }
    });

    // Toggle display mode
    this.screen.key(["v"], () => {
      this.toggleDisplayMode();
    });
  }

  /**
   * Handle terminal resize with debouncing
   */
  private handleResize(): void {
    // Mark as resizing - pause updates
    this.isResizing = true;

    // Clear any existing timeout
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }

    // Set new timeout - only rebuild after resize stops
    this.resizeTimeout = setTimeout(() => {
      logDebug("Resize complete, rebuilding layout");
      this.isResizing = false;
      this.rebuildLayout();
      this.resizeTimeout = null;
    }, RESIZE_DEBOUNCE_MS);
  }

  /**
   * Start the display update loop
   */
  start(): void {
    if (!this.screen || this.updateInterval) return;

    logInfo("Starting display update loop");

    // Hide cursor
    process.stdout.write("\x1B[?25l");

    this.updateInterval = setInterval(() => {
      // Keep cursor hidden
      process.stdout.write("\x1B[?25l");

      // Skip updates while resizing
      if (this.isResizing) {
        return;
      }

      if (this.needsRender) {
        this.render();
        this.needsRender = false;
      }
    }, this.config.updateRate);

    // Initial render
    this.render();
  }

  /**
   * Stop the display
   */
  stop(): void {
    logInfo("Stopping display");

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = null;
    }

    // Show cursor
    try {
      process.stdout.write("\x1B[?25h");
    } catch (e) {
      // Ignore cursor show errors
    }

    // Destroy all UI elements first
    this.destroyAllElements();

    // Then destroy screen with error handling
    if (this.screen) {
      try {
        // Patch terminal object one more time before destroy to prevent crashes
        if (this.screen.terminal && typeof this.screen.terminal === "object") {
          const term = this.screen.terminal as any;
          if (term.isAlt === undefined) {
            term.isAlt = false;
          }
          if (term.isCtrl === undefined) {
            term.isCtrl = false;
          }
          if (term.isShift === undefined) {
            term.isShift = false;
          }
        }

        // Remove all listeners to prevent errors during cleanup
        this.screen.removeAllListeners();

        // Try to remove process exit handlers that blessed sets up
        // This prevents blessed from trying to clean up after we've already cleaned up
        const exitListeners = process.listeners("exit");
        for (const listener of exitListeners) {
          // Remove listeners that might be from blessed
          if (listener.toString().includes("leave") || listener.toString().includes("destroy")) {
            try {
              process.removeListener("exit", listener);
            } catch (e) {
              // Ignore errors removing listeners
            }
          }
        }

        this.screen.destroy();
      } catch (error) {
        // Ignore cleanup errors - blessed can have issues during cleanup
        logDebug(`Error during screen cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.screen = null;
    }

    this.isRunning = false;
  }

  /**
   * Update channel data
   */
  updateChannels(channels: Uint8Array): void {
    for (let i = 0; i < Math.min(channels.length, TOTAL_CHANNELS); i++) {
      const value = channels[i];
      if (value !== undefined) {
        this.channelData[i] = value;
      }
    }
    this.needsRender = true;
  }

  /**
   * Update statistics
   */
  updateStats(stats: Partial<MonitorStats>): void {
    this.stats = { ...this.stats, ...stats };
    this.needsRender = true;
  }

  /**
   * Increment packet counter
   */
  incrementPacketCount(): void {
    this.stats.packetsReceived++;
    this.stats.lastPacketTime = new Date();
    this.needsRender = true;
  }

  /**
   * Increment error counter
   */
  incrementErrorCount(): void {
    this.stats.errors++;
    this.needsRender = true;
  }

  /**
   * Set packets per second
   */
  setPacketsPerSecond(pps: number): void {
    this.stats.packetsPerSecond = pps;
    this.needsRender = true;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats.packetsReceived = 0;
    this.stats.packetsPerSecond = 0;
    this.stats.errors = 0;
    this.stats.startTime = new Date();
    this.needsRender = true;
    logInfo("Stats reset");
  }

  /**
   * Clear all channel values
   */
  clearChannels(): void {
    this.channelData.fill(0);
    this.needsRender = true;
    logInfo("Channels cleared");
  }

  /**
   * Update competing sources info (for sACN priority warning)
   */
  updateCompetingSources(sources: SACNSourceInfo[]): void {
    this.competingSources = sources;
    this.needsRender = true;
  }

  /**
   * Update stats box content
   */
  private updateStatsContent(): void {
    if (!this.statsBox) return;

    if (this._uiMode === "playback") {
      this.updatePlaybackStatsContent();
      return;
    }

    const uptime = Math.floor((Date.now() - this.stats.startTime.getTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const uptimeStr = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

    const lastPacket = this.stats.lastPacketTime ? this.stats.lastPacketTime.toLocaleTimeString() : "N/A";

    const modeText = this._displayMode === "value" ? "Values" : "Channels";

    // Recording info
    let recordingInfo = "";
    if (this._recordingState === "recording" && this.recordingStartTime) {
      const recDuration = Math.floor((Date.now() - this.recordingStartTime.getTime()) / 1000);
      const recMin = Math.floor(recDuration / 60);
      const recSec = recDuration % 60;
      recordingInfo = `\n {red-fg}● REC{/red-fg} ${recMin.toString().padStart(2, "0")}:${recSec.toString().padStart(2, "0")}\n Frames: ${this.recordingFrameCount}`;
    }

    // Source info (sACN only)
    let sourceInfo = "";
    if (this.stats.protocol === "sacn" && this.competingSources.length > 0) {
      const activeSource = this.competingSources.find((s) => s.isActive);
      const inactiveSources = this.competingSources.filter((s) => !s.isActive);

      if (this.competingSources.length > 1) {
        // Multiple sources - show warning
        sourceInfo = `\n {yellow-fg}⚠ Multi-source{/yellow-fg}`;
        if (activeSource) {
          sourceInfo += `\n {green-fg}►{/green-fg} ${this.truncateSource(activeSource.sourceName)}`;
          sourceInfo += `\n   pri:${activeSource.priority}`;
        }
        for (const src of inactiveSources.slice(0, 2)) {
          // Show max 2 inactive
          sourceInfo += `\n {red-fg}✗{/red-fg} ${this.truncateSource(src.sourceName)}`;
          sourceInfo += `\n   pri:${src.priority}`;
        }
        if (inactiveSources.length > 2) {
          sourceInfo += `\n   +${inactiveSources.length - 2} more`;
        }
      } else if (activeSource) {
        // Single source - just show source name and priority
        sourceInfo = `\n Source:`;
        sourceInfo += `\n  ${this.truncateSource(activeSource.sourceName)}`;
        sourceInfo += `\n  pri:${activeSource.priority}`;
      }
    }

    // Convert universe to 1-indexed display format for Art-Net
    const displayUniverse = formatUniverseForDisplay(this.stats.universe, this.stats.protocol);
    
    this.statsBox.setContent(
      [
        "",
        ` Protocol: ${this.stats.protocol.toUpperCase()}`,
        ` Universe: ${displayUniverse}`,
        "",
        ` Interface:`,
        `  ${this.stats.interfaceName ?? "All"}`,
        `  ${this.stats.bindAddress}`,
        "",
        ` Packets: ${this.stats.packetsReceived}`,
        ` Rate: ${this.stats.packetsPerSecond.toFixed(1)}/s`,
        ` Last: ${lastPacket}`,
        "",
        ` Errors: ${this.stats.errors}`,
        ` Uptime: ${uptimeStr}`,
        "",
        ` Display: ${modeText}`,
        recordingInfo,
        sourceInfo,
      ].join("\n")
    );
  }

  /**
   * Truncate source name to fit in stats panel
   */
  private truncateSource(name: string, maxLen: number = 18): string {
    if (name.length <= maxLen) return name;
    return name.substring(0, maxLen - 1) + "…";
  }

  /**
   * Update stats box content for playback mode
   */
  private updatePlaybackStatsContent(): void {
    if (!this.statsBox) return;

    const info = this.playbackInfo;

    // Format position and duration as MM:SS
    const formatTime = (ms: number): string => {
      const totalSec = Math.floor(ms / 1000);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      return `${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
    };

    const posStr = formatTime(info.position);
    const durStr = formatTime(info.duration);

    // Progress bar
    const barWidth = 20;
    const progress = info.duration > 0 ? info.position / info.duration : 0;
    const filled = Math.round(progress * barWidth);
    const progressBar = "█".repeat(filled) + "░".repeat(barWidth - filled);

    // State indicator
    let stateText = "";
    switch (info.state) {
      case "playing":
        stateText = "{green-fg}▶ PLAYING{/green-fg}";
        break;
      case "paused":
        stateText = "{yellow-fg}⏸ PAUSED{/yellow-fg}";
        break;
      case "finished":
        stateText = "{cyan-fg}⏹ FINISHED{/cyan-fg}";
        break;
      default:
        stateText = "⏹ STOPPED";
    }

    const loopText = info.loopEnabled ? "{green-fg}ON{/green-fg}" : "OFF";
    const speedText = info.speed === 1.0 ? "1.0x" : `${info.speed.toFixed(2)}x`;

    // Convert universe to 1-indexed display format for Art-Net
    const displayUniverse = formatUniverseForDisplay(info.universe, info.protocol as Protocol);
    
    this.statsBox.setContent(
      [
        "",
        ` {bold}PLAYBACK{/bold}`,
        "",
        ` ${stateText}`,
        "",
        ` ${progressBar}`,
        ` ${posStr} / ${durStr}`,
        "",
        ` Protocol: ${info.protocol.toUpperCase()}`,
        ` Universe: ${displayUniverse}`,
        "",
        ` Speed: ${speedText}`,
        ` Loop: ${loopText}`,
        "",
        ` File:`,
        `  ${info.fileName.length > 20 ? "..." + info.fileName.slice(-17) : info.fileName}`,
      ].join("\n")
    );
  }

  /**
   * Render the display
   */
  private render(): void {
    if (!this.screen || this.isResizing) return;

    try {
      // Update header
      if (this.headerBox) {
        if (this._uiMode === "playback") {
          const info = this.playbackInfo;
          let stateIcon = "⏹";
          if (info.state === "playing") stateIcon = "▶";
          else if (info.state === "paused") stateIcon = "⏸";
          // Convert universe to 1-indexed display format for Art-Net
          const displayUniverse = formatUniverseForDisplay(info.universe, info.protocol as Protocol);
          this.headerBox.setContent(` ${this.config.title} - PLAYBACK ${stateIcon} - Universe ${displayUniverse} (${info.protocol.toUpperCase()}) `);
        } else {
          const recIndicator = this._recordingState === "recording" ? " {red-fg}● REC{/red-fg}" : "";
          // Convert universe to 1-indexed display format for Art-Net
          const displayUniverse = formatUniverseForDisplay(this.stats.universe, this.stats.protocol);
          this.headerBox.setContent(` ${this.config.title} - Universe ${displayUniverse} (${this.stats.protocol.toUpperCase()})${recIndicator} `);
        }
      }

      // Update channel boxes
      for (let row = 0; row < GRID_ROWS; row++) {
        for (let col = 0; col < GRID_COLUMNS; col++) {
          const channelIndex = row * GRID_COLUMNS + col;
          const value = this.channelData[channelIndex] ?? 0;
          const box = this.channelBoxes[row]?.[col];

          if (box) {
            box.setContent(this.getCellContent(channelIndex, value));
            box.style.bg = getSimpleColor(value);
            box.style.fg = value < 85 ? "white" : "black";
          }
        }
      }

      // Update stats panel if visible
      if (this.statsBox) {
        this.updateStatsContent();
      }

      // Update footer (always update to reflect recording state changes)
      if (this.footerBox) {
        this.footerBox.setContent(this.getFooterContent());
      }

      // Render screen
      this.screen.render();
    } catch (error) {
      logError(error, "Render error");
    }
  }

  /**
   * Check if display is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get current channel data
   */
  getChannelData(): Uint8Array {
    return this.channelData;
  }

  /**
   * Get current stats
   */
  getStats(): MonitorStats {
    return { ...this.stats };
  }

  /**
   * Get current display mode
   */
  getDisplayMode(): DisplayMode {
    return this._displayMode;
  }

  /**
   * Set display mode
   */
  setDisplayMode(mode: DisplayMode): void {
    this._displayMode = mode;
    if (this.footerBox) {
      this.footerBox.setContent(this.getFooterContent());
    }
    this.needsRender = true;
  }
}

/**
 * Create a display manager
 */
export function createDisplayManager(config?: DisplayConfig): DisplayManager {
  return new DisplayManager(config);
}
