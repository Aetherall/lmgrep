import { Vector } from "../../domain/faceting/Vector.js";
import type {
	EmbeddedTerm,
	ScoredTerm,
	VocabRepositoryPort,
} from "../../domain/ports/VocabRepositoryPort.js";
import { LanceTables, TableName } from "./LanceTables.js";
import { VectorIndexPolicy } from "./VectorIndexPolicy.js";

interface VocabRow extends Record<string, unknown> {
	term: string;
	vector: number[];
}

/**
 * Corpus vocabulary embedded in the same space as chunks.
 *
 * Faceting names a direction in embedding space by asking this table which
 * term sits closest to it — which is why the labels come out in the codebase's
 * own words rather than generic ones.
 */
export class VocabRepository implements VocabRepositoryPort {
	constructor(private readonly tables: LanceTables) {}

	async exists(): Promise<boolean> {
		return (await this.tables.table(TableName.Vocab)) !== undefined;
	}

	async storedTerms(): Promise<Set<string>> {
		const table = await this.tables.table(TableName.Vocab);
		if (!table) return new Set();
		const rows = await table.query().select(["term"]).toArray();
		return new Set(rows.map((r) => r.term as string));
	}

	async add(terms: EmbeddedTerm[]): Promise<void> {
		if (terms.length === 0) return;

		// Dedup within the batch, then against what is already stored: the
		// table has no unique constraint, so duplicates would just accumulate.
		const seen = new Set<string>();
		const unique: EmbeddedTerm[] = [];
		for (const t of terms) {
			if (seen.has(t.term)) continue;
			seen.add(t.term);
			unique.push(t);
		}

		const known = await this.storedTerms();
		const records: VocabRow[] = unique
			.filter((t) => !known.has(t.term))
			.map((t) => ({ term: t.term, vector: t.vector.toArray() }));
		if (records.length === 0) return;

		const { table, seeded } = await this.tables.tableOrCreate(
			TableName.Vocab,
			records,
		);
		if (!seeded) await table.add(records);
	}

	async nearest(
		axis: Vector,
		limit: number,
		exclude?: Set<string>,
	): Promise<ScoredTerm[]> {
		const table = await this.tables.table(TableName.Vocab);
		if (!table) return [];

		// Over-fetch by the exclusion count so filtering cannot starve the
		// result below `limit`.
		const fetch = exclude ? limit + exclude.size : limit;
		const rows = await table
			.query()
			.nearestTo(axis.toArray())
			.limit(fetch)
			.refineFactor(VectorIndexPolicy.REFINE_FACTOR)
			.select(["term", "_distance"])
			.toArray();

		const out: ScoredTerm[] = [];
		for (const r of rows) {
			const term = r.term as string;
			if (exclude?.has(term)) continue;
			const distance = r._distance as number | null | undefined;
			out.push({ term, score: distance != null ? 1 - distance : 0 });
			if (out.length >= limit) break;
		}
		return out;
	}

	async count(): Promise<number> {
		const table = await this.tables.table(TableName.Vocab);
		return table ? table.countRows() : 0;
	}

	async drop(): Promise<void> {
		await this.tables.dropTable(TableName.Vocab);
	}
}
