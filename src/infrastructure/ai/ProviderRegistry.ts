import { ProviderModuleLoader } from "./ProviderModuleLoader.js";

/** A `provider:model` string split into its parts. */
export class ModelReference {
	private constructor(
		readonly provider: string,
		readonly model: string,
		readonly full: string,
	) {}

	static parse(value: string, label: string): ModelReference {
		const colon = value.indexOf(":");
		if (colon === -1) {
			throw new Error(
				`${label} must be in "provider:model" format. Got: "${value}"`,
			);
		}
		return new ModelReference(
			value.slice(0, colon),
			value.slice(colon + 1),
			value,
		);
	}
}

export interface ProviderRequest {
	reference: ModelReference;
	/** Package to import; defaults to `@ai-sdk/<provider>`. */
	packageName?: string;
	baseURL?: string;
	/**
	 * Whether a configured `baseURL` should force use of the `create*` factory
	 * even when the module exports a ready-made default instance.
	 *
	 * It matters because a bare default export (e.g. `openai`) ignores baseURL
	 * and would silently talk to the cloud. The chat path sets this; the
	 * embedding path historically does not, and the two are kept distinct here
	 * rather than quietly unified.
	 */
	preferFactoryWhenBaseUrlSet: boolean;
}

/**
 * Turns a `provider:model` string plus config into a live AI SDK provider.
 *
 * Both the embedding and chat paths need the same import-and-instantiate
 * dance, so it lives here once; the one place they genuinely differ is
 * expressed as {@link ProviderRequest.preferFactoryWhenBaseUrlSet}.
 */
export class ProviderRegistry {
	constructor(
		private readonly loader: ProviderModuleLoader = new ProviderModuleLoader(),
	) {}

	async instantiate(request: ProviderRequest): Promise<unknown> {
		const providerName = request.reference.provider;
		const packageName = request.packageName ?? `@ai-sdk/${providerName}`;
		const module = await this.loader.load(packageName);

		let instance = module[providerName];

		const forceFactory =
			request.preferFactoryWhenBaseUrlSet && Boolean(request.baseURL);
		if (!instance || forceFactory) {
			const factoryKey = Object.keys(module).find((k) =>
				k.startsWith("create"),
			);
			if (factoryKey) {
				const factory = module[factoryKey] as (
					opts: Record<string, unknown>,
				) => unknown;
				instance = factory({
					name: providerName,
					...(request.baseURL ? { baseURL: request.baseURL } : {}),
				});
			}
		}

		if (!instance) {
			throw new Error(
				`Package "${packageName}" has no usable provider export. ` +
					`Available: ${Object.keys(module).join(", ")}`,
			);
		}
		return instance;
	}
}
