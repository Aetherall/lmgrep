/**
 * Which file supplied which settings.
 *
 * Recorded because the effective configuration used to be unattributable: two
 * files could each set `model`, `status` printed only the winner, and there
 * was no way to tell which file to edit.
 */
export interface ConfigSource {
	path: string;
	/** `machine` describes this computer's inference setup; `project` a repo. */
	scope: "machine" | "project";
	/** Keys this file actually contributed. */
	keys: string[];
	/** True for locations kept working only for backwards compatibility. */
	deprecated?: boolean;
}
