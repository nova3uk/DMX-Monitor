#!/usr/bin/env node
/**
 * DMX Monitor - Console application to monitor sACN and Art-Net DMX traffic
 * 
 * Main entry point with CLI argument parsing
 */

import { Command } from "commander";
import * as path from "path";
import { CLIOptions, Protocol, DMXPacket, ProtocolHandler } from "./types";
import { runSetup, confirmStart, displayDiscoveredNodes, promptNodeSelection, promptUniverseFromNode, promptManualUniverse, promptSACNUniverse, hasAllRequiredOptions, REFRESH_NODE_LIST } from "./setup";
import { createSACNHandler, SACNHandler } from "./protocols/sacn";
import { createArtNetHandler, ArtNetHandler } from "./protocols/artnet";
import { createUniverseManager, UniverseManager } from "./universe";
import { createDisplayManager, DisplayManager } from "./display";
import { createRecorder, DMXRecorder, createPlayer, DMXPlayer } from "./recorder";
import { createTransmitter, DMXTransmitter } from "./transmitter";
import { initLogger, logInfo, logError, logDebug, closeLogger, formatErrorForUser, enableConsoleLogging } from "./logger";
import { isDMXMonitorError, wrapError } from "./errors";

/** Application version */
const VERSION = "1.0.0";

/** Packet rate calculation interval (ms) */
const PACKET_RATE_INTERVAL = 1000;

/** Art-Net discovery timeout (ms) */
const ARTNET_DISCOVERY_TIMEOUT = 3000;

/**
 * Parse command line arguments
 */
function parseArgs(): CLIOptions {
  const program = new Command();

  program
    .name("dmx-monitor")
    .description(
      "DMXDesktop.com - DMX Monitor Tool for sACN (E1.31) and Art-Net DMX traffic\n\n" +
        "Monitor Mode Controls:\n" +
        "  Q        Quit the application\n" +
        "  R        Toggle recording (saves to .dmxrec file)\n" +
        "  C        Clear all channel values\n" +
        "  V        Toggle between value/channel display mode\n\n" +
        "Playback Mode Controls:\n" +
        "  Space    Play/Pause\n" +
        "  S        Stop (reset to beginning)\n" +
        "  L        Toggle loop mode\n" +
        "  +/-      Increase/decrease playback speed\n" +
        "  ←/→      Seek backward/forward 5 seconds\n" +
        "  Q        Quit"
    )
    .version(VERSION)
    .option("-p, --protocol <protocol>", "Protocol to use (sacn or artnet)")
    .option("-i, --interface <name>", "Network interface name to bind to")
    .option("-a, --address <ip>", "IP address to bind to")
    .option("-u, --universe <number>", "Universe number to monitor/playback", parseInt)
    .option("-m, --multicast", "Enable multicast (sACN)")
    .option("-b, --broadcast", "Enable broadcast (Art-Net)")
    .option("-v, --verbose", "Enable verbose logging")
    .option("-l, --log-file <path>", "Write logs to file")
    .option("-o, --recording-dir <path>", "Directory to save recordings (default: current directory)")
    .option("--playback <file>", "Play back a .dmxrec recording file")
    .option("--loop", "Enable loop mode for playback")
    .option("--speed <factor>", "Playback speed multiplier (0.1 - 10.0)", parseFloat)
    .option("--priority <number>", "sACN priority for playback (0-200, default 100)", parseInt)
    .parse();

  const opts = program.opts();

  return {
    protocol: opts["protocol"] as Protocol | undefined,
    interface: opts["interface"] as string | undefined,
    address: opts["address"] as string | undefined,
    universe: opts["universe"] as number | undefined,
    multicast: opts["multicast"] as boolean | undefined,
    broadcast: opts["broadcast"] as boolean | undefined,
    verbose: opts["verbose"] as boolean | undefined,
    logFile: opts["logFile"] as string | undefined,
    recordingDir: opts["recordingDir"] as string | undefined,
    playback: opts["playback"] as string | undefined,
    loop: opts["loop"] as boolean | undefined,
    speed: opts["speed"] as number | undefined,
    priority: opts["priority"] as number | undefined,
  };
}

/**
 * Create protocol handler based on configuration
 */
function createProtocolHandler(protocol: Protocol, bindAddress: string, useMulticast: boolean, useBroadcast: boolean, interfaceName?: string, selectedUniverse?: number, netmask?: string): ProtocolHandler {
  if (protocol === "sacn") {
    return createSACNHandler({
      bindAddress,
      useMulticast,
      interfaceName,
      universes: selectedUniverse ? [selectedUniverse] : undefined,
    });
  } else {
    return createArtNetHandler({
      bindAddress,
      useBroadcast,
      interfaceName,
      netmask,
    });
  }
}

/**
 * Main application class
 */
class DMXMonitorApp {
  private protocolHandler: ProtocolHandler | null = null;
  private universeManager: UniverseManager | null = null;
  private displayManager: DisplayManager | null = null;
  private recorder: DMXRecorder | null = null;
  private packetCount = 0;
  private lastPacketCount = 0;
  private packetRateInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private currentProtocol: Protocol = "sacn";
  private currentUniverse: number = 1;
  private recordingDir: string | undefined;

  /**
   * Run the application
   */
  async run(): Promise<void> {
    // Parse CLI arguments
    const cliOptions = parseArgs();

    // Initialize logger - if verbose but no log file specified, create a default one
    const logFile = cliOptions.logFile ?? (cliOptions.verbose ? "dmx-monitor.log" : undefined);

    initLogger({
      level: cliOptions.verbose ? "debug" : "info",
      logFile: logFile,
      console: true, // Will be disabled when display starts
    });

    logInfo("DMX Monitor starting", { version: VERSION, logFile });

    // Setup signal handlers
    this.setupSignalHandlers();

    // Check for playback mode
    if (cliOptions.playback) {
      await this.runPlaybackMode(cliOptions);
      return;
    }

    try {
      // Check if we have all required options (non-interactive mode)
      const isNonInteractive = hasAllRequiredOptions(cliOptions);

      // Run interactive setup
      const config = await runSetup(cliOptions);

      // Only confirm if running interactively (missing required options)
      if (!isNonInteractive) {
        const confirmed = await confirmStart(config);
        if (!confirmed) {
          console.log("Cancelled.");
          process.exit(0);
        }
      } else {
        // Just show a brief summary for non-interactive mode
        logInfo("Starting with configuration", {
          protocol: config.protocol,
          bindAddress: config.bindAddress,
          universe: config.selectedUniverse,
        });
      }

      // Create universe manager
      this.universeManager = createUniverseManager({
        selectedUniverse: config.selectedUniverse,
      });

      // Create protocol handler
      this.protocolHandler = createProtocolHandler(config.protocol, config.bindAddress, config.useMulticast, config.useBroadcast, config.interfaceName, config.selectedUniverse, config.netmask);

      // Start protocol handler
      console.log(`\nStarting ${config.protocol.toUpperCase()} receiver...`);
      await this.protocolHandler.start();

      // If no universe pre-selected, handle discovery and selection
      let selectedUniverse: number;
      let bindAddress = config.bindAddress;

      if (this.universeManager.hasSelectedUniverse()) {
        selectedUniverse = this.universeManager.getSelectedUniverse()!;
      } else if (config.protocol === "artnet") {
        // Run Art-Net discovery
        const discovery = await this.runArtNetDiscovery();
        selectedUniverse = discovery.universe;

        // If user selected a node, rebind to that node's IP to receive its packets
        if (discovery.nodeIp && discovery.nodeIp !== config.bindAddress) {
          logInfo(`Rebinding to node IP: ${discovery.nodeIp}`);
          await this.protocolHandler.stop();

          // Recreate handler bound to the node's IP
          this.protocolHandler = createProtocolHandler(config.protocol, discovery.nodeIp, config.useMulticast, config.useBroadcast, config.interfaceName, selectedUniverse, config.netmask);
          await this.protocolHandler.start();
          bindAddress = discovery.nodeIp;
        }
      } else {
        // For sACN, prompt for universe (auto-detect is unreliable with multicast)
        console.log("\n");
        selectedUniverse = await promptSACNUniverse();
      }

      // If using sACN, make sure we're listening to the selected universe
      if (config.protocol === "sacn" && this.protocolHandler instanceof SACNHandler) {
        (this.protocolHandler as SACNHandler).addUniverse(selectedUniverse);
      }

      // Store current config for recorder
      this.currentProtocol = config.protocol;
      this.currentUniverse = selectedUniverse;
      this.recordingDir = cliOptions.recordingDir;

      // Create recorder
      this.recorder = createRecorder();

      // Create and initialize display
      this.displayManager = createDisplayManager({
        title: "DMXDesktop.com - DMX Monitor",
      });

      await this.displayManager.init();

      // Set initial stats
      this.displayManager.updateStats({
        protocol: config.protocol,
        universe: selectedUniverse,
        bindAddress: bindAddress,
        interfaceName: config.interfaceName,
      });

      // Setup recording toggle callback
      this.displayManager.onRecordingToggle(() => {
        this.toggleRecording();
      });

      // Setup packet handling
      this.setupPacketHandler(selectedUniverse);

      // Start packet rate calculation
      this.startPacketRateCalculation();

      // Start display update loop
      this.displayManager.start();

      logInfo("DMX Monitor running", {
        protocol: config.protocol,
        universe: selectedUniverse,
        bindAddress: bindAddress,
      });
    } catch (error) {
      await this.handleFatalError(error);
    }
  }

  /**
   * Run Art-Net node discovery and let user select a universe
   * Returns { universe, nodeIp } so we can rebind to the node's IP
   */
  private async runArtNetDiscovery(): Promise<{ universe: number; nodeIp: string | null }> {
    if (!(this.protocolHandler instanceof ArtNetHandler)) {
      throw new Error("Protocol handler is not an ArtNetHandler");
    }

    const artnetHandler = this.protocolHandler as ArtNetHandler;

    console.log("\n🔍 Discovering Art-Net nodes...");
    console.log(`   (Waiting ${ARTNET_DISCOVERY_TIMEOUT / 1000} seconds for responses)\n`);

    // Run initial discovery
    await artnetHandler.startDiscovery(ARTNET_DISCOVERY_TIMEOUT);

    // Track the number of nodes at the time the prompt was shown
    let nodesAtPromptTime = artnetHandler.getDiscoveredNodes().length;

    // Handler to notify user when new nodes are discovered during prompt
    const nodeDiscoveredHandler = (node: { shortName: string; ip: string }) => {
      // Print a visible notification - this will appear even while inquirer prompt is active
      console.log(`\n\n  ✨ New node discovered: ${node.shortName} (${node.ip})`);
      console.log(`     Select "🔄 Refresh list" to see updated nodes\n`);
    };
    artnetHandler.on("nodeDiscovered", nodeDiscoveredHandler);

    try {
      // Loop to allow refreshing the list when new nodes are discovered
      while (true) {
        // Get current list of nodes
        const nodes = artnetHandler.getDiscoveredNodes();

        // Check if we have more nodes than when we last showed the prompt
        const hasNewNodes = nodes.length > nodesAtPromptTime;

        // Display discovered nodes
        displayDiscoveredNodes(nodes);

        // If no nodes found, prompt for manual entry
        if (nodes.length === 0) {
          console.log("No Art-Net nodes were discovered on the network.");
          console.log("You can still monitor a specific universe manually.\n");
          return { universe: await promptManualUniverse(), nodeIp: null };
        }

        // Update the count for next iteration
        nodesAtPromptTime = nodes.length;

        // Let user select a node (always show refresh option so user can refresh if new nodes arrive)
        const selectedNode = await promptNodeSelection(nodes, hasNewNodes);

        // Check if user wants to refresh the list
        if (selectedNode === REFRESH_NODE_LIST) {
          console.log("\n🔄 Refreshing node list...\n");
          continue; // Loop back to show updated list
        }

        if (!selectedNode) {
          // User chose to skip node selection
          return { universe: await promptManualUniverse(), nodeIp: null };
        }

        // Let user select a universe from the node
        const universeFromNode = await promptUniverseFromNode(selectedNode);

        if (universeFromNode !== null) {
          return { universe: universeFromNode, nodeIp: selectedNode.ip };
        }

        // Node has no universes, fall back to manual entry
        return { universe: await promptManualUniverse(), nodeIp: selectedNode.ip };
      }
    } finally {
      // Clean up the event listener
      artnetHandler.off("nodeDiscovered", nodeDiscoveredHandler);
    }
  }

  /**
   * Setup packet handler for incoming DMX data
   */
  private setupPacketHandler(selectedUniverse: number): void {
    if (!this.protocolHandler || !this.displayManager || !this.universeManager) {
      return;
    }

    logInfo(`Listening for packets on universe ${selectedUniverse}`);

    this.protocolHandler.on("packet", (packet: DMXPacket) => {
      // Check if packet is for selected universe
      if (packet.universe !== selectedUniverse) {
        // Still track for universe manager
        logDebug(`Packet filtered: got universe ${packet.universe}, want ${selectedUniverse}`);
        this.universeManager?.updateFromPacket(packet.universe, packet.source);
        return;
      }

      // Update display
      this.displayManager?.updateChannels(packet.channels);
      this.displayManager?.incrementPacketCount();
      this.packetCount++;

      // Record frame if recording
      if (this.recorder?.isRecording()) {
        this.recorder.recordFrame(packet.channels);
        const stats = this.recorder.getStats();
        this.displayManager?.updateRecordingFrameCount(stats.frameCount);
      }

      logDebug("Packet matched", {
        universe: packet.universe,
        source: packet.source,
      });
    });

    this.protocolHandler.on("error", (error: Error) => {
      logError(error, "Protocol error");
      this.displayManager?.incrementErrorCount();
    });

    this.protocolHandler.on("universeDiscovered", (universe: number) => {
      logInfo(`New universe discovered: ${universe}`);
    });
  }

  /**
   * Start packet rate calculation interval
   */
  private startPacketRateCalculation(): void {
    this.packetRateInterval = setInterval(() => {
      const rate = this.packetCount - this.lastPacketCount;
      this.lastPacketCount = this.packetCount;
      this.displayManager?.setPacketsPerSecond(rate);
    }, PACKET_RATE_INTERVAL);
  }

  /**
   * Toggle recording on/off
   */
  private toggleRecording(): void {
    logInfo("toggleRecording called", { hasRecorder: !!this.recorder, isRecording: this.recorder?.isRecording() });

    if (!this.recorder) {
      logDebug("toggleRecording: no recorder");
      return;
    }

    try {
      if (this.recorder.isRecording()) {
        // Stop recording
        logInfo("toggleRecording: stopping recording");
        const stats = this.recorder.stopRecording();
        this.displayManager?.setRecordingState("idle");
        logInfo("Recording stopped", {
          filePath: stats.filePath,
          duration: stats.duration,
          frameCount: stats.frameCount,
          bytesWritten: stats.bytesWritten,
        });
      } else {
        // Start recording
        logInfo("toggleRecording: starting recording");
        const filePath = this.recorder.startRecording(this.currentProtocol, this.currentUniverse, this.recordingDir);
        logInfo("Recording started", { filePath });
        this.displayManager?.setRecordingState("recording", new Date(), 0);
        logInfo("setRecordingState called");
      }
    } catch (error) {
      logError(error, "Error toggling recording");
    }
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      logInfo(`Received ${signal}, shutting down...`);
      await this.cleanup();
      // Use setTimeout to allow cleanup to complete before exit
      setTimeout(() => {
        try {
          process.exit(0);
        } catch (exitError) {
          // Ignore exit errors from blessed
        }
      }, 0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Handle uncaught exceptions - but suppress blessed cleanup errors
    process.on("uncaughtException", async (error) => {
      // Suppress errors from blessed during exit
      if (error.message && (error.message.includes("Cannot read properties of undefined") || error.message.includes("isAlt") || error.message.includes("terminal"))) {
        // This is likely a blessed cleanup error - ignore it
        return;
      }
      logError(error, "Uncaught exception");
      await this.cleanup();
      setTimeout(() => {
        try {
          process.exit(1);
        } catch (exitError) {
          // Ignore exit errors
        }
      }, 0);
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", async (reason) => {
      logError(reason, "Unhandled rejection");
      await this.cleanup();
      setTimeout(() => {
        try {
          process.exit(1);
        } catch (exitError) {
          // Ignore exit errors
        }
      }, 0);
    });
  }

  // =========================================================================
  // Playback Mode
  // =========================================================================

  private player: DMXPlayer | null = null;
  private transmitter: DMXTransmitter | null = null;

  /**
   * Run in playback mode
   */
  private async runPlaybackMode(cliOptions: CLIOptions): Promise<void> {
    try {
      const playbackFile = cliOptions.playback!;

      console.log(`\n📼 Loading recording: ${playbackFile}`);

      // Create and load player
      this.player = createPlayer();
      const header = this.player.load(playbackFile);

      // Determine protocol and universe
      const protocol: Protocol = cliOptions.protocol ?? (header.protocol === 0 ? "sacn" : "artnet");
      const universe = cliOptions.universe ?? header.universe;

      console.log(`   Protocol: ${protocol.toUpperCase()}`);
      console.log(`   Universe: ${universe}`);
      console.log(`   Duration: ${(header.duration / 1000).toFixed(1)}s`);
      console.log(`   Frames: ${header.frameCount}`);

      // Apply CLI options
      if (cliOptions.speed !== undefined) {
        this.player.setSpeed(cliOptions.speed);
        console.log(`   Speed: ${cliOptions.speed}x`);
      }

      if (cliOptions.loop) {
        this.player.setLoop(true);
        console.log(`   Loop: enabled`);
      }

      // Create transmitter
      console.log(`\n📡 Starting ${protocol.toUpperCase()} transmitter...`);

      const priority = cliOptions.priority ?? 100;
      if (protocol === "sacn" && cliOptions.priority !== undefined) {
        console.log(`   Priority: ${priority}`);
      }

      this.transmitter = createTransmitter(protocol, universe, {
        targetAddress: cliOptions.address,
        interfaceAddress: cliOptions.address,
        priority,
      });

      await this.transmitter.start();

      // Create display in playback mode
      this.displayManager = createDisplayManager({
        title: "DMXDesktop.com - DMX Playback",
      });

      this.displayManager.setUIMode("playback");

      await this.displayManager.init();

      // Set initial playback info
      this.displayManager.updatePlaybackInfo({
        state: "idle",
        position: 0,
        duration: header.duration,
        speed: this.player.getSpeed(),
        loopEnabled: this.player.isLoopEnabled(),
        fileName: path.basename(playbackFile),
        universe,
        protocol,
      });

      // Setup playback callbacks
      this.setupPlaybackCallbacks();

      // Setup player event handlers
      this.player.onFrame((channels) => {
        // Update display
        this.displayManager?.updateChannels(channels);

        // Transmit DMX
        this.transmitter?.send(channels);
      });

      this.player.onPosition((position, duration) => {
        this.displayManager?.updatePlaybackInfo({ position, duration });
      });

      this.player.onStateChange((state) => {
        this.displayManager?.updatePlaybackInfo({ state });
      });

      this.player.onFinished(() => {
        logInfo("Playback finished");
        this.displayManager?.updatePlaybackInfo({ state: "finished" });
      });

      // Start display
      this.displayManager.start();

      // Auto-start playback
      this.player.play();

      logInfo("Playback mode running", {
        file: playbackFile,
        protocol,
        universe,
      });
    } catch (error) {
      await this.handleFatalError(error);
    }
  }

  /**
   * Setup playback control callbacks
   */
  private setupPlaybackCallbacks(): void {
    if (!this.displayManager || !this.player) return;

    this.displayManager.onPlayPause(() => {
      if (this.player) {
        this.player.togglePlayPause();
        this.displayManager?.updatePlaybackInfo({
          state: this.player.getState(),
        });
      }
    });

    this.displayManager.onStop(() => {
      if (this.player) {
        this.player.stop();
        this.displayManager?.updatePlaybackInfo({
          state: "idle",
          position: 0,
        });
        // Send blackout
        this.transmitter?.send(new Uint8Array(512));
      }
    });

    this.displayManager.onSeekForward(() => {
      this.player?.seekForward(5000);
    });

    this.displayManager.onSeekBackward(() => {
      this.player?.seekBackward(5000);
    });

    this.displayManager.onSpeedUp(() => {
      if (this.player) {
        this.player.increaseSpeed();
        this.displayManager?.updatePlaybackInfo({
          speed: this.player.getSpeed(),
        });
      }
    });

    this.displayManager.onSpeedDown(() => {
      if (this.player) {
        this.player.decreaseSpeed();
        this.displayManager?.updatePlaybackInfo({
          speed: this.player.getSpeed(),
        });
      }
    });

    this.displayManager.onLoopToggle(() => {
      if (this.player) {
        this.player.toggleLoop();
        this.displayManager?.updatePlaybackInfo({
          loopEnabled: this.player.isLoopEnabled(),
        });
      }
    });
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    logInfo("Cleaning up resources...");

    // Stop player if active
    if (this.player) {
      try {
        this.player.stop();
      } catch (error) {
        logError(error, "Error stopping player");
      }
      this.player = null;
    }

    // Stop transmitter if active
    if (this.transmitter) {
      try {
        await this.transmitter.stop();
      } catch (error) {
        logError(error, "Error stopping transmitter");
      }
      this.transmitter = null;
    }

    // Stop recording if active
    if (this.recorder?.isRecording()) {
      try {
        const stats = this.recorder.stopRecording();
        logInfo("Recording stopped during cleanup", {
          filePath: stats.filePath,
          frameCount: stats.frameCount,
        });
      } catch (error) {
        logError(error, "Error stopping recorder");
      }
    }
    this.recorder = null;

    // Stop packet rate calculation
    if (this.packetRateInterval) {
      clearInterval(this.packetRateInterval);
      this.packetRateInterval = null;
    }

    // Stop display
    if (this.displayManager) {
      this.displayManager.stop();
      this.displayManager = null;
    }

    // Re-enable console logging for shutdown messages
    enableConsoleLogging();

    // Stop protocol handler
    if (this.protocolHandler) {
      try {
        await this.protocolHandler.stop();
      } catch (error) {
        logError(error, "Error stopping protocol handler");
      }
      this.protocolHandler = null;
    }

    // Close logger
    await closeLogger();
  }

  /**
   * Handle fatal errors
   */
  private async handleFatalError(error: unknown): Promise<void> {
    // Re-enable console logging for error display
    enableConsoleLogging();

    const wrappedError = isDMXMonitorError(error) ? error : wrapError(error, "Fatal error");

    logError(wrappedError, "Fatal error");

    console.error("\n❌ Error:", formatErrorForUser(wrappedError));

    if (isDMXMonitorError(error)) {
      console.error(`   Code: ${error.code}`);
    }

    await this.cleanup();

    // Use setTimeout to exit on next tick, allowing any pending operations to complete
    // This helps avoid issues with blessed's exit handlers
    setTimeout(() => {
      try {
        process.exit(1);
      } catch (exitError) {
        // If process.exit itself fails (shouldn't happen, but just in case)
        // Force exit using a different method
        if (typeof process.exitCode !== "undefined") {
          process.exitCode = 1;
        }
      }
    }, 0);
  }
}

// Run the application
const app = new DMXMonitorApp();
app.run().catch(async (error) => {
  console.error("Failed to start DMX Monitor:", error);
  // Use setTimeout to allow cleanup to complete before exit
  setTimeout(() => {
    try {
      process.exit(1);
    } catch (exitError) {
      if (typeof process.exitCode !== "undefined") {
        process.exitCode = 1;
      }
    }
  }, 0);
});
