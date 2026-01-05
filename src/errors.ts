/**
 * Custom error classes for DMX Monitor
 */

/** Base error class for DMX Monitor errors */
export abstract class DMXMonitorError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();
    
    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /** Get a safe error message without sensitive data */
  public toSafeString(): string {
    return `[${this.code}] ${this.message}`;
  }

  /** Convert to JSON for logging */
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
    };
  }
}

/** Network-related errors (port conflicts, bind failures, connection issues) */
export class NetworkError extends DMXMonitorError {
  public readonly address?: string;
  public readonly port?: number;
  public readonly syscall?: string;
  public readonly originalError?: Error;

  constructor(
    message: string,
    options?: {
      address?: string;
      port?: number;
      syscall?: string;
      cause?: Error;
    }
  ) {
    super(message, 'NETWORK_ERROR');
    this.address = options?.address;
    this.port = options?.port;
    this.syscall = options?.syscall;
    this.originalError = options?.cause;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      address: this.address,
      port: this.port,
      syscall: this.syscall,
    };
  }

  /** Create error for port already in use */
  static portInUse(port: number, address?: string): NetworkError {
    return new NetworkError(
      `Port ${port} is already in use${address ? ` on ${address}` : ''}`,
      { port, address, syscall: 'bind' }
    );
  }

  /** Create error for bind failure */
  static bindFailed(address: string, port: number, cause?: Error): NetworkError {
    return new NetworkError(
      `Failed to bind to ${address}:${port}`,
      { address, port, syscall: 'bind', cause }
    );
  }

  /** Create error for multicast join failure */
  static multicastJoinFailed(address: string, cause?: Error): NetworkError {
    return new NetworkError(
      `Failed to join multicast group ${address}`,
      { address, syscall: 'addMembership', cause }
    );
  }

  /** Create error for interface not found */
  static interfaceNotFound(interfaceName: string): NetworkError {
    return new NetworkError(
      `Network interface '${interfaceName}' not found`,
      { address: interfaceName }
    );
  }
}

/** Protocol parsing errors (malformed packets, invalid data) */
export class ProtocolError extends DMXMonitorError {
  public readonly protocol?: string;
  public readonly packetSize?: number;
  public readonly expectedSize?: number;
  public readonly originalError?: Error;

  constructor(
    message: string,
    options?: {
      protocol?: string;
      packetSize?: number;
      expectedSize?: number;
      cause?: Error;
    }
  ) {
    super(message, 'PROTOCOL_ERROR');
    this.protocol = options?.protocol;
    this.packetSize = options?.packetSize;
    this.expectedSize = options?.expectedSize;
    this.originalError = options?.cause;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      protocol: this.protocol,
      packetSize: this.packetSize,
      expectedSize: this.expectedSize,
    };
  }

  /** Create error for malformed packet */
  static malformedPacket(protocol: string, reason: string): ProtocolError {
    return new ProtocolError(
      `Malformed ${protocol} packet: ${reason}`,
      { protocol }
    );
  }

  /** Create error for packet too short */
  static packetTooShort(protocol: string, actual: number, expected: number): ProtocolError {
    return new ProtocolError(
      `${protocol} packet too short: ${actual} bytes (expected at least ${expected})`,
      { protocol, packetSize: actual, expectedSize: expected }
    );
  }

  /** Create error for invalid header */
  static invalidHeader(protocol: string): ProtocolError {
    return new ProtocolError(
      `Invalid ${protocol} packet header`,
      { protocol }
    );
  }

  /** Create error for unsupported version */
  static unsupportedVersion(protocol: string, version: number): ProtocolError {
    return new ProtocolError(
      `Unsupported ${protocol} protocol version: ${version}`,
      { protocol }
    );
  }
}

/** Universe-related errors (invalid universe numbers, no universes detected) */
export class UniverseError extends DMXMonitorError {
  public readonly universe?: number;
  public readonly validRange?: { min: number; max: number };

  constructor(
    message: string,
    options?: {
      universe?: number;
      validRange?: { min: number; max: number };
    }
  ) {
    super(message, 'UNIVERSE_ERROR');
    this.universe = options?.universe;
    this.validRange = options?.validRange;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      universe: this.universe,
      validRange: this.validRange,
    };
  }

  /** Create error for invalid universe number */
  static invalidUniverse(universe: number, min: number, max: number): UniverseError {
    return new UniverseError(
      `Invalid universe number: ${universe} (valid range: ${min}-${max})`,
      { universe, validRange: { min, max } }
    );
  }

  /** Create error for no universes detected */
  static noUniversesDetected(): UniverseError {
    return new UniverseError('No DMX universes detected on the network');
  }

  /** Create error for universe not found */
  static universeNotFound(universe: number): UniverseError {
    return new UniverseError(
      `Universe ${universe} not found in detected universes`,
      { universe }
    );
  }
}

/** Display/UI errors */
export class DisplayError extends DMXMonitorError {
  public readonly component?: string;
  public readonly originalError?: Error;

  constructor(
    message: string,
    options?: {
      component?: string;
      cause?: Error;
    }
  ) {
    super(message, 'DISPLAY_ERROR');
    this.component = options?.component;
    this.originalError = options?.cause;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      component: this.component,
    };
  }

  /** Create error for terminal too small */
  static terminalTooSmall(required: { width: number; height: number }): DisplayError {
    return new DisplayError(
      `Terminal too small. Required: ${required.width}x${required.height}`,
      { component: 'terminal' }
    );
  }

  /** Create error for render failure */
  static renderFailed(component: string, cause?: Error): DisplayError {
    return new DisplayError(
      `Failed to render ${component}`,
      { component, cause }
    );
  }

  /** Create error for initialization failure */
  static initFailed(cause?: Error): DisplayError {
    const message = cause ? `Failed to initialize display: ${cause.message}` : "Failed to initialize display";
    return new DisplayError(message, { component: "display", cause });
  }
}

/** Configuration/setup errors */
export class ConfigError extends DMXMonitorError {
  public readonly field?: string;
  public readonly value?: unknown;

  constructor(
    message: string,
    options?: {
      field?: string;
      value?: unknown;
    }
  ) {
    super(message, 'CONFIG_ERROR');
    this.field = options?.field;
    // Sanitize value for logging (don't expose potentially sensitive data)
    this.value = typeof options?.value === 'string' ? '[string]' : typeof options?.value;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      field: this.field,
      valueType: this.value,
    };
  }

  /** Create error for invalid option value */
  static invalidOption(field: string, value: unknown, reason: string): ConfigError {
    return new ConfigError(
      `Invalid value for '${field}': ${reason}`,
      { field, value }
    );
  }

  /** Create error for missing required option */
  static missingRequired(field: string): ConfigError {
    return new ConfigError(
      `Missing required option: ${field}`,
      { field }
    );
  }
}

/** Type guard to check if error is a DMXMonitorError */
export function isDMXMonitorError(error: unknown): error is DMXMonitorError {
  return error instanceof DMXMonitorError;
}

/** Extract safe error message from any error */
export function getSafeErrorMessage(error: unknown): string {
  if (isDMXMonitorError(error)) {
    return error.toSafeString();
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unknown error occurred';
}

/** Extended error type with network properties */
interface NetworkErrnoException extends NodeJS.ErrnoException {
  port?: number;
  address?: string;
}

/** Wrap unknown error in appropriate DMXMonitorError */
export function wrapError(error: unknown, context: string): DMXMonitorError {
  if (isDMXMonitorError(error)) {
    return error;
  }
  
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;
  
  // Try to categorize based on error properties or message
  if (error instanceof Error) {
    const nodeError = error as NetworkErrnoException;
    if (nodeError.code === 'EADDRINUSE') {
      return NetworkError.portInUse(
        nodeError.port ?? 0,
        nodeError.address
      );
    }
    if (nodeError.code === 'EADDRNOTAVAIL' || nodeError.code === 'ENODEV') {
      return NetworkError.bindFailed(
        nodeError.address ?? 'unknown',
        nodeError.port ?? 0,
        cause
      );
    }
  }
  
  // Default to a generic error with context
  return new NetworkError(`${context}: ${message}`, { cause });
}
