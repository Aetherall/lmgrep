/**
 * Thrown when a search reaches a database that has no chunk table.
 *
 * A distinct type rather than a plain Error because the *reason* it is missing
 * is only knowable further out — most often the configured model changed and
 * this project's other models are sitting right beside it — and matching on a
 * message string to detect that would break the first time the wording did.
 */
export class MissingIndexError extends Error {
	constructor(message = "No index found. Run `lmgrep index` first.") {
		super(message);
		this.name = "MissingIndexError";
	}
}
