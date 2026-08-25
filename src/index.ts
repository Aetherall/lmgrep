/**
 * Public entry point.
 *
 * Composition lives in {@link LmgrepFactory}; this module only re-exports, so
 * nothing here should ever contain logic.
 */

export type {
	IndexBuildOptions,
	IndexBuildResult,
	IndexingProgressEvent,
} from "./application/indexing/IndexingProgress.js";
export { Lmgrep } from "./application/Lmgrep.js";
export {
	LmgrepFactory,
	type LmgrepOptions,
} from "./application/LmgrepFactory.js";
export type { HealthState } from "./application/operations/HealthMonitor.js";
export type { RepairResult } from "./application/operations/RepairService.js";
export type { StatusInfo } from "./application/operations/StatusService.js";
export type { ResearchResult } from "./application/research/ResearchAgent.js";
export type { SearchOptions } from "./application/search/SearchCriteria.js";
export type { LmgrepConfig } from "./domain/config/LmgrepConfig.js";
export { Chunk } from "./domain/corpus/Chunk.js";
export { CodeLocation } from "./domain/corpus/CodeLocation.js";
export { ContentHash } from "./domain/corpus/ContentHash.js";
export { FileVersion } from "./domain/corpus/FileVersion.js";
export { FileManifest, SourceFile } from "./domain/corpus/SourceFile.js";
export { Vector } from "./domain/corpus/Vector.js";
export type { ChunkerPort } from "./domain/ports/ChunkerPort.js";
export type { EmbedderPort } from "./domain/ports/EmbedderPort.js";
export type { LoggerPort } from "./domain/ports/LoggerPort.js";
export { Branch } from "./domain/project/Branch.js";
export { DatabaseLocation } from "./domain/project/DatabaseLocation.js";
export type {
	DiscoveredIndex,
	IndexMetadata,
} from "./domain/project/IndexMetadata.js";
export { ModelIdentity } from "./domain/project/ModelIdentity.js";
export { Project } from "./domain/project/Project.js";
export { ProjectId } from "./domain/project/ProjectId.js";
export { ProjectLocator } from "./domain/project/ProjectLocator.js";
export type { TraceEntry } from "./domain/research/ResearchTrace.js";
export { Hit } from "./domain/retrieval/Hit.js";
export { HitList } from "./domain/retrieval/HitList.js";
export { AiSdkEmbedder } from "./infrastructure/ai/AiSdkEmbedder.js";
export { ConfigLoader } from "./infrastructure/fs/ConfigLoader.js";
export { ConsoleLogger, SilentLogger } from "./infrastructure/fs/Loggers.js";
export { ProjectMetadataStore } from "./infrastructure/fs/ProjectMetadataStore.js";
export { StateDirectory } from "./infrastructure/fs/StateDirectory.js";
export { IndexShare } from "./infrastructure/p2p/IndexShare.js";
export { ShareCode } from "./infrastructure/p2p/ShareCode.js";
export {
	ProcessRegistry,
	type RunningProcess,
} from "./infrastructure/process/ProcessRegistry.js";
export { TreeSitterChunker } from "./infrastructure/treesitter/TreeSitterChunker.js";
export { LmgrepCore } from "./presentation/mcp/LmgrepCore.js";
