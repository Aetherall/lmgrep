import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import type {
	ProjectIndex,
	ProjectIndexesPort,
} from "../../domain/ports/ProjectIndexesPort.js";
import type { DatabaseLocation } from "../../domain/project/DatabaseLocation.js";
import { ModelIdentity } from "../../domain/project/ModelIdentity.js";
import type { ProjectLocator } from "../../domain/project/ProjectLocator.js";

/** What to say when the configured model has no index but another one does. */
export interface AbsenceExplanation {
	reason: string;
	fix: string;
	/** The indexes that do exist, largest first. */
	others: readonly ProjectIndex[];
}

/**
 * Explains an index that is absent because the model changed.
 *
 * Storing one database per model makes switching models safe and reversible,
 * but it also means a switch turns a working project into an empty one — and
 * "not indexed" is then a true statement that badly misdescribes the
 * situation. The old index is intact, one directory away, and reachable by
 * putting the old model back. Without saying so, the obvious next step is
 * `lmgrep index`, which re-embeds the entire repository to reach a state the
 * user may not have meant to ask for.
 */
export class IndexAlternatives {
	constructor(
		private readonly indexes: ProjectIndexesPort,
		private readonly locator: ProjectLocator,
		private readonly location: DatabaseLocation,
		private readonly config: LmgrepConfig,
		private readonly cwd: string,
	) {}

	/** Indexes for this project built with some other model. */
	others(): ProjectIndex[] {
		// A database chosen by name or path is not one of a project's model
		// variants, so it has no siblings to speak of.
		if (this.location.manual) return [];
		return this.indexes
			.list(this.locator.indexHomeFor(this.cwd))
			.filter((index) => index.databasePath !== this.location.path)
			.filter((index) => index.bytes > 0);
	}

	/** The explanation, or nothing when this is simply an unindexed project. */
	explainAbsence(): AbsenceExplanation | undefined {
		const others = this.others();
		if (others.length === 0) return undefined;

		const named = others.filter((index) => index.model);
		const previous = named[0] ?? others[0];
		const configured = ModelIdentity.of(this.config.model).family;

		return {
			reason:
				`This project has no index for "${configured}" — but it is indexed ` +
				`with ${this.describe(named)}.`,
			fix:
				`Set \`model\` back to ${previous.model ?? "the previous model"} to use that index immediately, ` +
				"or run `lmgrep index` to embed this project with the new model (the other index is kept).",
			others,
		};
	}

	private describe(indexes: readonly ProjectIndex[]): string {
		if (indexes.length === 0) return "another model";
		return indexes
			.map((index) => `"${ModelIdentity.of(index.model ?? "").family}"`)
			.join(", ");
	}
}
