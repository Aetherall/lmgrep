import { LmStudioProbe } from "./LmStudioProbe.js";
import type {
	CatalogedModel,
	DetectedRuntime,
	RuntimeProbe,
} from "./ModelRuntime.js";
import { OllamaProbe } from "./OllamaProbe.js";

/**
 * Finds whichever local inference server is running.
 *
 * Probes run concurrently and the first *useful* result wins — a server with
 * models beats one that is merely listening, so a running-but-empty Ollama
 * does not shadow a fully set up LM Studio.
 */
export class LocalRuntimeDetector {
	constructor(
		private readonly probes: readonly RuntimeProbe[] = [
			new LmStudioProbe(),
			new OllamaProbe(),
		],
	) {}

	async detectAll(): Promise<DetectedRuntime[]> {
		const results = await Promise.all(
			this.probes.map((p) => p.detect().catch(() => undefined)),
		);
		return results.filter((r): r is DetectedRuntime => r !== undefined);
	}

	/** The best runtime to configure against, if any is usable. */
	async detectBest(): Promise<DetectedRuntime | undefined> {
		const found = await this.detectAll();
		return (
			found.find((r) => LocalRuntimeDetector.embeddingModels(r).length > 0) ??
			found[0]
		);
	}

	/** Models the runtime says are embedders, best candidates first. */
	static embeddingModels(runtime: DetectedRuntime): CatalogedModel[] {
		return runtime.models.filter((m) => m.kind === "embedding");
	}

	/**
	 * Models usable for `ask`. Only taken when the runtime typed them: guessing
	 * an embedder is a chat model produces a confusing failure at answer time.
	 */
	static chatModels(runtime: DetectedRuntime): CatalogedModel[] {
		return runtime.models.filter((m) => m.kind === "chat");
	}

	/**
	 * Fallback for runtimes that do not type their models: anything not
	 * recognizable as an embedder.
	 */
	static untypedModels(runtime: DetectedRuntime): CatalogedModel[] {
		return runtime.models.filter((m) => m.kind === "unknown");
	}
}
