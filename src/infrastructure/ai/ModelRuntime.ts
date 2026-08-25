/** What a discovered model is good for. */
export type ModelKind = "embedding" | "chat" | "unknown";

export interface CatalogedModel {
	id: string;
	kind: ModelKind;
}

/** A local inference server that was found listening. */
export interface DetectedRuntime {
	/** Human name, for what `init` prints. */
	label: string;
	/** Provider segment of the `provider:model` string. */
	providerId: string;
	baseURL: string;
	/**
	 * AI SDK package to load. Undefined means the default
	 * `@ai-sdk/<providerId>` is correct.
	 */
	providerPackage?: string;
	models: CatalogedModel[];
}

/** Detects one kind of local inference server. */
export interface RuntimeProbe {
	detect(): Promise<DetectedRuntime | undefined>;
}
