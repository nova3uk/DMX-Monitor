/**
 * Universe detection and selection logic for DMX Monitor
 */

import { UniverseInfo, ProtocolHandler, isValidUniverse } from './types';
import { UniverseError } from './errors';
import { logDebug, logInfo, logWarn } from './logger';
import { promptUniverseSelection } from './setup';

/** Universe manager configuration */
export interface UniverseManagerConfig {
  /** Pre-selected universe (skip detection) */
  selectedUniverse?: number;
  /** Detection timeout in milliseconds */
  detectionTimeout?: number;
  /** Minimum universes to detect before prompting */
  minUniversesBeforePrompt?: number;
}

/** Default configuration values */
const DEFAULT_DETECTION_TIMEOUT = 5000; // 5 seconds
const DEFAULT_MIN_UNIVERSES = 1;

/**
 * Universe manager for detecting and selecting DMX universes
 */
export class UniverseManager {
  private readonly config: UniverseManagerConfig;
  private readonly discoveredUniverses: Map<number, UniverseInfo> = new Map();
  private selectedUniverse: number | null = null;
  private detectionPromiseResolve: ((universe: number) => void) | null = null;

  constructor(config: UniverseManagerConfig = {}) {
    this.config = {
      detectionTimeout: config.detectionTimeout ?? DEFAULT_DETECTION_TIMEOUT,
      minUniversesBeforePrompt: config.minUniversesBeforePrompt ?? DEFAULT_MIN_UNIVERSES,
      selectedUniverse: config.selectedUniverse,
    };

    // If universe pre-selected, validate and set it
    if (this.config.selectedUniverse !== undefined) {
      if (!isValidUniverse(this.config.selectedUniverse)) {
        throw UniverseError.invalidUniverse(this.config.selectedUniverse, 0, 63999);
      }
      this.selectedUniverse = this.config.selectedUniverse;
      logInfo(`Universe pre-selected: ${this.selectedUniverse}`);
    }
  }

  /**
   * Get the currently selected universe
   */
  getSelectedUniverse(): number | null {
    return this.selectedUniverse;
  }

  /**
   * Get all discovered universes
   */
  getDiscoveredUniverses(): UniverseInfo[] {
    return Array.from(this.discoveredUniverses.values());
  }

  /**
   * Check if a universe is selected
   */
  hasSelectedUniverse(): boolean {
    return this.selectedUniverse !== null;
  }

  /**
   * Handle universe discovery event from protocol handler
   */
  onUniverseDiscovered(universe: number, source?: string): void {
    if (!isValidUniverse(universe)) {
      logWarn(`Invalid universe discovered: ${universe}`);
      return;
    }

    const existingInfo = this.discoveredUniverses.get(universe);
    const now = new Date();

    if (!existingInfo) {
      const info: UniverseInfo = {
        universe,
        lastSeen: now,
        packetCount: 1,
        source,
      };
      this.discoveredUniverses.set(universe, info);
      logDebug(`Universe ${universe} added to discovered list`);

      // If waiting for detection and we have enough universes, resolve
      if (this.detectionPromiseResolve && 
          this.discoveredUniverses.size >= (this.config.minUniversesBeforePrompt ?? 1)) {
        // Don't resolve immediately - wait for detection timeout to get all universes
      }
    } else {
      existingInfo.lastSeen = now;
      existingInfo.packetCount++;
      if (source) {
        existingInfo.source = source;
      }
    }
  }

  /**
   * Update universe info from packet
   */
  updateFromPacket(universe: number, source?: string): void {
    if (!isValidUniverse(universe)) {
      return;
    }

    const existingInfo = this.discoveredUniverses.get(universe);
    const now = new Date();

    if (!existingInfo) {
      this.onUniverseDiscovered(universe, source);
    } else {
      existingInfo.lastSeen = now;
      existingInfo.packetCount++;
      if (source) {
        existingInfo.source = source;
      }
    }
  }

  /**
   * Wait for universes to be detected, then prompt for selection
   */
  async detectAndSelectUniverse(handler: ProtocolHandler): Promise<number> {
    // If already selected, return immediately
    if (this.selectedUniverse !== null) {
      logInfo(`Using pre-selected universe: ${this.selectedUniverse}`);
      return this.selectedUniverse;
    }

    logInfo('Detecting DMX universes...');
    console.log('Listening for DMX traffic... (this may take a few seconds)');

    // Listen for universe discovery events
    const discoveryHandler = (universe: number) => {
      // Get source from handler's discovered universes
      const universeInfo = handler.getDiscoveredUniverses().find(u => u.universe === universe);
      this.onUniverseDiscovered(universe, universeInfo?.source);
    };

    handler.on('universeDiscovered', discoveryHandler);

    // Also sync any already discovered universes
    for (const info of handler.getDiscoveredUniverses()) {
      this.onUniverseDiscovered(info.universe, info.source);
    }

    // Wait for detection timeout
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.config.detectionTimeout);
    });

    // Remove discovery handler
    handler.off('universeDiscovered', discoveryHandler);

    // Get discovered universes
    const universes = Array.from(this.discoveredUniverses.keys()).sort((a, b) => a - b);

    logInfo(`Detection complete. Found ${universes.length} universe(s)`, { universes });

    if (universes.length === 0) {
      throw UniverseError.noUniversesDetected();
    }

    // If only one universe, auto-select it
    if (universes.length === 1) {
      const universe = universes[0];
      if (universe === undefined) {
        throw UniverseError.noUniversesDetected();
      }
      this.selectedUniverse = universe;
      console.log(`Auto-selected universe ${this.selectedUniverse} (only one detected)`);
      return this.selectedUniverse;
    }

    // Multiple universes - prompt for selection
    console.log(`\nDetected ${universes.length} universes:`);
    for (const universe of universes) {
      const info = this.discoveredUniverses.get(universe);
      console.log(`  Universe ${universe} - ${info?.packetCount ?? 0} packets from ${info?.source ?? 'unknown'}`);
    }
    console.log('');

    this.selectedUniverse = await promptUniverseSelection(universes);
    logInfo(`User selected universe: ${this.selectedUniverse}`);

    return this.selectedUniverse;
  }

  /**
   * Manually select a universe
   */
  selectUniverse(universe: number): void {
    if (!isValidUniverse(universe)) {
      throw UniverseError.invalidUniverse(universe, 0, 63999);
    }

    this.selectedUniverse = universe;
    logInfo(`Universe manually selected: ${universe}`);
  }

  /**
   * Check if a packet should be processed (matches selected universe)
   */
  shouldProcessPacket(universe: number): boolean {
    // If no universe selected yet, process all (for discovery)
    if (this.selectedUniverse === null) {
      return true;
    }

    return universe === this.selectedUniverse;
  }

  /**
   * Clear discovered universes
   */
  clearDiscovered(): void {
    this.discoveredUniverses.clear();
    logDebug('Cleared discovered universes');
  }

  /**
   * Get statistics about discovered universes
   */
  getStats(): {
    totalUniverses: number;
    selectedUniverse: number | null;
    universes: Array<{
      universe: number;
      packetCount: number;
      lastSeen: Date;
      source?: string;
    }>;
  } {
    return {
      totalUniverses: this.discoveredUniverses.size,
      selectedUniverse: this.selectedUniverse,
      universes: Array.from(this.discoveredUniverses.values()).map(info => ({
        universe: info.universe,
        packetCount: info.packetCount,
        lastSeen: info.lastSeen,
        source: info.source,
      })),
    };
  }
}

/**
 * Create a universe manager with configuration
 */
export function createUniverseManager(config?: UniverseManagerConfig): UniverseManager {
  return new UniverseManager(config);
}
