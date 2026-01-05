/**
 * Interactive setup prompts for DMX Monitor
 */

import inquirer from 'inquirer';
import os from 'os';
import { 
  Protocol, 
  NetworkInterface, 
  CLIOptions, 
  MonitorConfig,
  ArtNetNode,
  isValidIPv4,
  isValidUniverse,
} from './types';
import { ConfigError, NetworkError } from './errors';
import { logDebug, logInfo } from './logger';

/**
 * Get list of available network interfaces with IPv4 addresses
 */
export function getNetworkInterfaces(): NetworkInterface[] {
  const interfaces: NetworkInterface[] = [];
  const networkInterfaces = os.networkInterfaces();

  for (const [name, addrs] of Object.entries(networkInterfaces)) {
    if (!addrs) continue;
    
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        interfaces.push({
          name,
          address: addr.address,
          family: 'IPv4',
          internal: addr.internal,
          mac: addr.mac,
        });
      }
    }
  }

  // Also add loopback for testing
  interfaces.push({
    name: 'loopback',
    address: '127.0.0.1',
    family: 'IPv4',
    internal: true,
  });

  return interfaces;
}

/**
 * Prompt for protocol selection
 */
async function promptProtocol(): Promise<Protocol> {
  const { protocol } = await inquirer.prompt<{ protocol: Protocol }>([
    {
      type: 'list',
      name: 'protocol',
      message: 'Select DMX protocol to monitor:',
      choices: [
        { name: 'sACN (E1.31) - Streaming ACN', value: 'sacn' },
        { name: 'Art-Net - Artistic Licence protocol', value: 'artnet' },
      ],
    },
  ]);
  return protocol;
}

/**
 * Prompt for network interface selection
 */
async function promptInterface(
  interfaces: NetworkInterface[]
): Promise<{ address: string; name?: string }> {
  const choices = [
    { name: 'All interfaces (0.0.0.0)', value: '0.0.0.0' },
    ...interfaces.map(iface => ({
      name: `${iface.name} (${iface.address})`,
      value: iface.address,
    })),
    { name: 'Enter custom IP address', value: 'custom' },
  ];

  const { selection } = await inquirer.prompt<{ selection: string }>([
    {
      type: 'list',
      name: 'selection',
      message: 'Select network interface to listen on:',
      choices,
    },
  ]);

  if (selection === 'custom') {
    const { customAddress } = await inquirer.prompt<{ customAddress: string }>([
      {
        type: 'input',
        name: 'customAddress',
        message: 'Enter IP address to bind to:',
        validate: (input: string) => {
          if (!isValidIPv4(input)) {
            return 'Please enter a valid IPv4 address';
          }
          return true;
        },
      },
    ]);
    return { address: customAddress };
  }

  const selectedInterface = interfaces.find(i => i.address === selection);
  return {
    address: selection,
    name: selectedInterface?.name,
  };
}

/**
 * Prompt for multicast option (sACN)
 */
async function promptMulticast(): Promise<boolean> {
  const { useMulticast } = await inquirer.prompt<{ useMulticast: boolean }>([
    {
      type: 'confirm',
      name: 'useMulticast',
      message: 'Listen on multicast addresses? (recommended for sACN)',
      default: true,
    },
  ]);
  return useMulticast;
}

/**
 * Prompt for broadcast option (Art-Net)
 */
async function promptBroadcast(): Promise<boolean> {
  const { useBroadcast } = await inquirer.prompt<{ useBroadcast: boolean }>([
    {
      type: 'confirm',
      name: 'useBroadcast',
      message: 'Listen for broadcast packets? (recommended for Art-Net)',
      default: true,
    },
  ]);
  return useBroadcast;
}

/**
 * Prompt for universe selection from discovered universes
 */
export async function promptUniverseSelection(
  universes: number[]
): Promise<number> {
  if (universes.length === 0) {
    throw ConfigError.missingRequired('universe');
  }

  if (universes.length === 1) {
    const universe = universes[0];
    if (universe === undefined) {
      throw ConfigError.missingRequired('universe');
    }
    logInfo(`Auto-selecting only detected universe: ${universe}`);
    return universe;
  }

  const { universe } = await inquirer.prompt<{ universe: number }>([
    {
      type: 'list',
      name: 'universe',
      message: `Multiple universes detected (${universes.length}). Select universe to monitor:`,
      choices: universes.sort((a, b) => a - b).map(u => ({
        name: `Universe ${u}`,
        value: u,
      })),
    },
  ]);

  return universe;
}

/**
 * Display discovered Art-Net nodes
 */
export function displayDiscoveredNodes(nodes: ArtNetNode[]): void {
  if (nodes.length === 0) {
    console.log('\nNo Art-Net nodes discovered.');
    return;
  }

  console.log(`\n--- Discovered Art-Net Nodes (${nodes.length}) ---`);
  nodes.forEach((node, index) => {
    console.log(`\n  ${index + 1}. ${node.shortName || 'Unknown'} (${node.ip})`);
    if (node.manufacturer) {
      console.log(`     Manufacturer: ${node.manufacturer}`);
    }
    if (node.longName && node.longName !== node.shortName) {
      console.log(`     Product: ${node.longName}`);
    }
    if (node.firmwareVersion) {
      console.log(`     Firmware: ${node.firmwareVersion}`);
    }
    if (node.universes.length > 0) {
      // Display as 1-indexed for user clarity (Art-Net wire format is 0-indexed)
      console.log(`     Universes: ${node.universes.map(u => u + 1).join(', ')}`);
    }
  });
  console.log('\n-----------------------------------------\n');
}

/**
 * Prompt for Art-Net node selection from discovered nodes
 */
export async function promptNodeSelection(
  nodes: ArtNetNode[]
): Promise<ArtNetNode | null> {
  if (nodes.length === 0) {
    return null;
  }

  // Build choices from discovered nodes
  const choices = nodes.map((node, index) => {
    // Display universes as 1-indexed for user clarity (Art-Net wire format is 0-indexed)
    const universeStr = node.universes.length > 0 
      ? ` [Universes: ${node.universes.map(u => u + 1).join(', ')}]`
      : '';
    return {
      name: `${node.shortName || 'Unknown'} (${node.ip})${universeStr}`,
      value: index,
    };
  });

  // Add option to skip node selection
  choices.push({
    name: 'Skip - Enter universe manually',
    value: -1,
  });

  const { selection } = await inquirer.prompt<{ selection: number }>([
    {
      type: 'list',
      name: 'selection',
      message: 'Select an Art-Net node to monitor:',
      choices,
    },
  ]);

  if (selection === -1) {
    return null;
  }

  return nodes[selection] || null;
}

/**
 * Prompt for universe selection from a specific node
 */
export async function promptUniverseFromNode(
  node: ArtNetNode
): Promise<number | null> {
  if (node.universes.length === 0) {
    console.log(`Node ${node.shortName} has no universes configured.`);
    return null;
  }

  if (node.universes.length === 1) {
    const universe = node.universes[0];
    if (universe !== undefined) {
      // Display as 1-indexed, return 0-indexed wire value
      console.log(`Auto-selecting universe ${universe + 1} from ${node.shortName}`);
      return universe;
    }
    return null;
  }

  const { universe } = await inquirer.prompt<{ universe: number }>([
    {
      type: 'list',
      name: 'universe',
      message: `Select universe from ${node.shortName}:`,
      // Display as 1-indexed for user, but value is 0-indexed wire format
      choices: node.universes.map(u => ({
        name: `Universe ${u + 1}`,
        value: u,
      })),
    },
  ]);

  return universe;
}

/**
 * Prompt for manual universe entry (Art-Net)
 * User enters 1-indexed universe (1, 2, 3...), returns 0-indexed for Art-Net wire format
 */
export async function promptManualUniverse(): Promise<number> {
  const { universe } = await inquirer.prompt<{ universe: number }>([
    {
      type: 'input',
      name: 'universe',
      message: 'Enter universe number to monitor (1-63999):',
      default: '1',
      validate: (input: string) => {
        const num = parseInt(input, 10);
        if (isNaN(num) || num < 1 || num > 63999) {
          return 'Please enter a valid universe number (1-63999)';
        }
        return true;
      },
      filter: (input: string) => parseInt(input, 10),
    },
  ]);

  // Convert user's 1-indexed input to 0-indexed Art-Net wire format
  return universe - 1;
}

/**
 * Prompt for sACN universe entry
 * sACN uses 1-indexed universes (1-63999)
 */
export async function promptSACNUniverse(): Promise<number> {
  const { universe } = await inquirer.prompt<{ universe: number }>([
    {
      type: 'input',
      name: 'universe',
      message: 'Enter sACN universe to monitor (1-63999):',
      default: '1',
      validate: (input: string) => {
        const num = parseInt(input, 10);
        if (isNaN(num) || num < 1 || num > 63999) {
          return 'Please enter a valid universe number (1-63999)';
        }
        return true;
      },
      filter: (input: string) => parseInt(input, 10),
    },
  ]);

  return universe;
}

/**
 * Validate CLI options
 */
function validateCLIOptions(options: CLIOptions): void {
  if (options.protocol && !['sacn', 'artnet'].includes(options.protocol)) {
    throw ConfigError.invalidOption(
      'protocol',
      options.protocol,
      'must be "sacn" or "artnet"'
    );
  }

  if (options.address && !isValidIPv4(options.address)) {
    throw ConfigError.invalidOption(
      'address',
      options.address,
      'must be a valid IPv4 address'
    );
  }

  if (options.universe !== undefined && !isValidUniverse(options.universe)) {
    throw ConfigError.invalidOption(
      'universe',
      options.universe,
      'must be a valid universe number (0-63999)'
    );
  }
}

/**
 * Find interface by name or address
 */
function findInterface(
  interfaces: NetworkInterface[],
  nameOrAddress: string
): NetworkInterface | undefined {
  return interfaces.find(
    i => i.name.toLowerCase() === nameOrAddress.toLowerCase() ||
         i.address === nameOrAddress
  );
}

/**
 * Check if all required CLI options are provided (no prompts needed)
 */
export function hasAllRequiredOptions(cliOptions: CLIOptions): boolean {
  // Need: protocol, address/interface, universe
  // For sACN: multicast defaults to true if not specified
  // For Art-Net: broadcast defaults to true if not specified
  const hasProtocol = !!cliOptions.protocol;
  const hasAddress = !!(cliOptions.address || cliOptions.interface);
  const hasUniverse = cliOptions.universe !== undefined;
  
  return hasProtocol && hasAddress && hasUniverse;
}

/**
 * Run interactive setup with CLI options as defaults
 */
export async function runSetup(cliOptions: CLIOptions): Promise<MonitorConfig> {
  // Validate CLI options first
  validateCLIOptions(cliOptions);

  logDebug('Starting interactive setup', { cliOptions });

  const interfaces = getNetworkInterfaces();
  logDebug(`Found ${interfaces.length} network interfaces`);

  // Protocol selection
  let protocol: Protocol;
  if (cliOptions.protocol) {
    protocol = cliOptions.protocol;
    logInfo(`Using protocol from CLI: ${protocol}`);
  } else {
    protocol = await promptProtocol();
  }

  // Interface selection
  let bindAddress: string;
  let interfaceName: string | undefined;

  if (cliOptions.address) {
    bindAddress = cliOptions.address;
    logInfo(`Using address from CLI: ${bindAddress}`);
  } else if (cliOptions.interface) {
    const iface = findInterface(interfaces, cliOptions.interface);
    if (!iface) {
      throw NetworkError.interfaceNotFound(cliOptions.interface);
    }
    bindAddress = iface.address;
    interfaceName = iface.name;
    logInfo(`Using interface from CLI: ${interfaceName} (${bindAddress})`);
  } else if (cliOptions.broadcast && protocol === 'artnet') {
    // Art-Net with broadcast flag: auto-bind to 0.0.0.0 for discovery
    bindAddress = '0.0.0.0';
    logInfo('Using 0.0.0.0 for Art-Net broadcast discovery');
  } else {
    const selected = await promptInterface(interfaces);
    bindAddress = selected.address;
    interfaceName = selected.name;
  }

  // Multicast/Broadcast options - default to true when running non-interactively
  let useMulticast = false;
  let useBroadcast = false;
  const isNonInteractive = hasAllRequiredOptions(cliOptions);

  if (protocol === 'sacn') {
    if (cliOptions.multicast !== undefined) {
      useMulticast = cliOptions.multicast;
      logInfo(`Using multicast from CLI: ${useMulticast}`);
    } else if (isNonInteractive) {
      // Default to true for non-interactive mode
      useMulticast = true;
      logInfo('Defaulting multicast to true (non-interactive mode)');
    } else {
      useMulticast = await promptMulticast();
    }
  } else if (protocol === 'artnet') {
    if (cliOptions.broadcast !== undefined) {
      useBroadcast = cliOptions.broadcast;
      logInfo(`Using broadcast from CLI: ${useBroadcast}`);
    } else if (isNonInteractive) {
      // Default to true for non-interactive mode
      useBroadcast = true;
      logInfo('Defaulting broadcast to true (non-interactive mode)');
    } else {
      useBroadcast = await promptBroadcast();
    }
  }

  const config: MonitorConfig = {
    protocol,
    bindAddress,
    interfaceName,
    useMulticast,
    useBroadcast,
    selectedUniverse: cliOptions.universe,
    verbose: cliOptions.verbose ?? false,
    logFile: cliOptions.logFile,
  };

  logDebug('Setup complete', { config });

  return config;
}

/**
 * Confirm before starting monitoring
 */
export async function confirmStart(config: MonitorConfig): Promise<boolean> {
  console.log('\n--- Configuration Summary ---');
  console.log(`Protocol:  ${config.protocol.toUpperCase()}`);
  console.log(`Interface: ${config.interfaceName ?? 'All'} (${config.bindAddress})`);
  
  if (config.protocol === 'sacn') {
    console.log(`Multicast: ${config.useMulticast ? 'Yes' : 'No'}`);
  } else {
    console.log(`Broadcast: ${config.useBroadcast ? 'Yes' : 'No'}`);
  }
  
  if (config.selectedUniverse !== undefined) {
    console.log(`Universe:  ${config.selectedUniverse}`);
  } else {
    console.log(`Universe:  Auto-detect`);
  }
  console.log('-----------------------------\n');

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Start monitoring?',
      default: true,
    },
  ]);

  return confirm;
}
