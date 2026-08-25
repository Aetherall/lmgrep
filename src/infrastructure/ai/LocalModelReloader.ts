import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";

/**
 * Unloads and reloads a model on a local inference server.
 *
 * A local server that has wedged or evicted the model is the common cause of a
 * run of embedding failures, and it recovers on a reload — worth one automatic
 * attempt before abandoning a long index run. Remote providers are never
 * reloaded: the request would be meaningless and possibly billable.
 */
export class LocalModelReloader {
	private static readonly LOOPBACK_HOSTS = new Set([
		"localhost",
		"127.0.0.1",
		"0.0.0.0",
	]);
	private static readonly UNLOAD_SETTLE_MS = 2000;
	private static readonly DEFAULT_BASE_URL = "http://localhost:1234";
	private static readonly DEFAULT_CONTEXT_LENGTH = 8192;

	constructor(private readonly config: LmgrepConfig) {}

	/** Whether the configured endpoint is a loopback address. */
	get isLocal(): boolean {
		if (!this.config.baseURL) return false;
		try {
			return LocalModelReloader.LOOPBACK_HOSTS.has(
				new URL(this.config.baseURL).hostname,
			);
		} catch {
			return false;
		}
	}

	/** Best-effort reload; false when the server does not cooperate. */
	async reload(): Promise<boolean> {
		const modelId = this.config.model.split(":").slice(1).join(":");
		const baseURL = this.config.baseURL ?? LocalModelReloader.DEFAULT_BASE_URL;
		const apiBase = baseURL.replace(/\/v1\/?$/, "");

		try {
			await fetch(`${apiBase}/api/v1/models/unload`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instance_id: modelId }),
			});
			await new Promise((r) =>
				setTimeout(r, LocalModelReloader.UNLOAD_SETTLE_MS),
			);
			const res = await fetch(`${apiBase}/api/v1/models/load`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: modelId,
					context_length:
						this.config.maxTokens ??
						LocalModelReloader.DEFAULT_CONTEXT_LENGTH,
				}),
			});
			await res.json();
			return true;
		} catch {
			return false;
		}
	}
}
