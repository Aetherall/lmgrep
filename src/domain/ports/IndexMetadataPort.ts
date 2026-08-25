import type { IndexMetadata } from "../project/IndexMetadata.js";

/**
 * Reads and writes the metadata sidecar beside each database.
 *
 * Enumeration is deliberately not here: a database lives inside the repository
 * it describes, so listing them is the registry's job, not the sidecar's.
 */
export interface IndexMetadataPort {
	read(databasePath: string): IndexMetadata | undefined;
	write(databasePath: string, metadata: Omit<IndexMetadata, "indexedAt">): void;
	/** Whether a directory is an lmgrep database, or safely treatable as one. */
	isDatabaseDirectory(databasePath: string): boolean;
}
