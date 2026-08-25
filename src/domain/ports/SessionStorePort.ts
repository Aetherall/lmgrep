import type { FacetSession } from "../faceting/FacetSession.js";
import type { ProjectId } from "../project/ProjectId.js";

/** Persistence for facet navigation sessions. */
export interface SessionStorePort {
	load(project: ProjectId, id: string): FacetSession | undefined;
	save(project: ProjectId, session: FacetSession): void;
	create(project: ProjectId, query: string, rootHits: string[]): FacetSession;
}
