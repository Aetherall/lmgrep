import type {
	DiscoveredIndex,
	IndexMetadata,
} from "../project/IndexMetadata.js";

/** Reads and writes the metadata sidecar beside each database. */
export interface IndexMetadataPort {
	read(databasePath: string): IndexMetadata | undefined;
	write(databasePath: string, metadata: Omit<IndexMetadata, "indexedAt">): void;
	/** Whether a directory is an lmgrep database, or safely treatable as one. */
	isDatabaseDirectory(databasePath: string): boolean;
	/** Every index in the state directory carrying readable metadata. */
	discoverAll(): DiscoveredIndex[];
}
