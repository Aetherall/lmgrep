import type { LoggerPort } from "../../domain/ports/LoggerPort.js";

/** Timestamped output on stdout/stderr, for foreground commands. */
export class ConsoleLogger implements LoggerPort {
	info(message: string): void {
		console.log(`[${new Date().toISOString()}] ${message}`);
	}

	error(message: string): void {
		console.error(`[${new Date().toISOString()}] ${message}`);
	}
}

/**
 * Discards everything. Used by the MCP server, whose stdout is a protocol
 * stream — a stray log line there corrupts the transport.
 */
export class SilentLogger implements LoggerPort {
	info(): void {}
	error(): void {}
}
