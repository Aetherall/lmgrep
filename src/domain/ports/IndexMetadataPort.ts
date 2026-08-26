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
	/**
	 * Whether a directory actually holds an index.
	 *
	 * Deliberately stricter than {@link isDatabaseDirectory}, which answers a
	 * different question: that one guards destructive commands and so accepts
	 * an empty directory, since deleting one cannot lose data. Listing an
	 * empty directory as an index is the opposite mistake — it reports an
	 * index that is not there.
	 */
	holdsIndex(databasePath: string): boolean;
}
