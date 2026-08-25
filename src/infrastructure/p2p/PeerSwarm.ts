import type { DuplexSocket } from "./SecureChannel.js";

interface HyperswarmInstance {
	join(
		topic: Buffer,
		opts?: { server?: boolean; client?: boolean },
	): { flushed(): Promise<void> };
	on(
		event: "connection",
		cb: (socket: DuplexSocket, info: unknown) => void,
	): void;
	destroy(): Promise<void>;
}

/**
 * Peer discovery over Hyperswarm.
 *
 * Imported lazily and treated as optional: sharing is a side feature, and its
 * native dependency should not be required to run a search.
 */
export class PeerSwarm {
	private constructor(private readonly swarm: HyperswarmInstance) {}

	static async create(): Promise<PeerSwarm> {
		let module: { default?: new () => HyperswarmInstance };
		try {
			// @ts-expect-error -- no type declarations for hyperswarm
			module = await import("hyperswarm");
		} catch {
			throw new Error("hyperswarm is not installed. Run: pnpm add hyperswarm");
		}
		const Constructor = (module.default ??
			module) as new () => HyperswarmInstance;
		return new PeerSwarm(new Constructor());
	}

	onConnection(handler: (socket: DuplexSocket) => void): void {
		this.swarm.on("connection", handler);
	}

	/** Announce as a server (sharer) or dial as a client (receiver). */
	async join(topic: Buffer, role: "server" | "client"): Promise<void> {
		await this.swarm
			.join(topic, {
				server: role === "server",
				client: role === "client",
			})
			.flushed();
	}

	async destroy(): Promise<void> {
		await this.swarm.destroy().catch(() => {});
	}
}
