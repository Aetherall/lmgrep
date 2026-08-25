import { mkdirSync } from "node:fs";
import { type Connection, connect, type Table } from "@lancedb/lancedb";
import type { Branch } from "../../domain/project/Branch.js";

/**
 * Table names inside a LanceDB database directory.
 *
 * A const object rather than a `const enum`: const enums are erased at emit,
 * so importing one across modules compiles but can vanish at runtime.
 */
export const TableName = {
	Chunks: "chunks",
	Files: "files",
	Vocab: "vocab",
} as const;

export type TableName = (typeof TableName)[keyof typeof TableName];

/**
 * Shared access to one LanceDB database: connecting, opening tables lazily,
 * and running the schema backfills legacy databases need.
 *
 * The repositories share an instance so they share a connection — LanceDB
 * connections are per-directory and opening several would multiply the native
 * runtime's memory.
 */
export class LanceTables {
	/**
	 * Predicates are built by string interpolation, so batches are kept small
	 * enough that no single filter grows unreasonably long.
	 */
	static readonly FILTER_BATCH_SIZE = 50;

	private db: Connection | undefined;
	private readonly open = new Map<TableName, Table>();

	constructor(
		readonly path: string,
		private readonly branch: Branch,
	) {}

	private async connection(): Promise<Connection> {
		if (this.db) return this.db;
		mkdirSync(this.path, { recursive: true });
		this.db = await connect(this.path);
		return this.db;
	}

	/** Open a table, or undefined when the database has never held it. */
	async table(name: TableName): Promise<Table | undefined> {
		const cached = this.open.get(name);
		if (cached) return cached;

		const conn = await this.connection();
		const names = await conn.tableNames();
		if (!names.includes(name)) return undefined;

		const table = await conn.openTable(name);
		await this.migrate(name, table);
		this.open.set(name, table);
		return table;
	}

	/**
	 * Open a table, creating it from `seed` rows when it does not exist.
	 * `seeded` says whether creation consumed the rows, so the caller knows not
	 * to insert them a second time.
	 */
	async tableOrCreate(
		name: TableName,
		seed: Record<string, unknown>[],
	): Promise<{ table: Table; seeded: boolean }> {
		const existing = await this.table(name);
		if (existing) return { table: existing, seeded: false };

		const conn = await this.connection();
		const created = await conn.createTable(name, seed);
		this.open.set(name, created);
		return { table: created, seeded: true };
	}

	async tableNames(): Promise<string[]> {
		return (await this.connection()).tableNames();
	}

	async dropTable(name: TableName): Promise<void> {
		const conn = await this.connection();
		const names = await conn.tableNames();
		if (names.includes(name)) await conn.dropTable(name);
		this.open.delete(name);
	}

	/** Forget cached handles so the next access re-opens and re-migrates. */
	forget(name?: TableName): void {
		if (name) this.open.delete(name);
		else this.open.clear();
	}

	close(): void {
		this.open.clear();
		this.db = undefined;
	}

	/** `column IN ('a', 'b')`, with values single-quote escaped. */
	static inFilter(column: string, values: readonly string[]): string {
		const escaped = values.map((v) => `'${v.replace(/'/g, "''")}'`);
		return `${column} IN (${escaped.join(", ")})`;
	}

	static quote(value: string): string {
		return value.replace(/'/g, "''");
	}

	/** Run `column IN (...)` deletes in batches small enough for one predicate. */
	static async deleteIn(
		table: Table,
		column: string,
		values: readonly string[],
	): Promise<void> {
		for (let i = 0; i < values.length; i += LanceTables.FILTER_BATCH_SIZE) {
			const batch = values.slice(i, i + LanceTables.FILTER_BATCH_SIZE);
			await table.delete(LanceTables.inFilter(column, batch));
		}
	}

	/** Run a batched `column IN (...)` select, collecting one column's values. */
	static async selectIn(
		table: Table,
		column: string,
		values: readonly string[],
	): Promise<Set<string>> {
		const found = new Set<string>();
		for (let i = 0; i < values.length; i += LanceTables.FILTER_BATCH_SIZE) {
			const batch = values.slice(i, i + LanceTables.FILTER_BATCH_SIZE);
			const rows = await table
				.query()
				.where(LanceTables.inFilter(column, batch))
				.select([column])
				.toArray();
			for (const r of rows) found.add(r[column] as string);
		}
		return found;
	}

	/**
	 * Backfill columns that legacy databases predate. Both are additive and
	 * idempotent — a table that already has the column is left alone.
	 */
	private async migrate(name: TableName, table: Table): Promise<void> {
		if (name === TableName.Files) {
			// Pre branch-scoping `files` tables have no `branch` column. Fill it
			// with the current branch so branch-filtered queries keep working.
			const schema = await table.schema();
			if (schema.fields.some((f) => f.name === "branch")) return;
			await table.addColumns([
				{
					name: "branch",
					valueSql: `CAST('${LanceTables.quote(this.branch.toString())}' AS STRING)`,
				},
			]);
			return;
		}

		if (name === TableName.Chunks) {
			// Pre version-scoping `chunks` tables have no `fileHash`. Fill it
			// with "" — treated as a wildcard at search time, so legacy chunks
			// keep appearing until their file is re-indexed and gets a real
			// version hash.
			const schema = await table.schema();
			if (schema.fields.some((f) => f.name === "fileHash")) return;
			await table.addColumns([
				{ name: "fileHash", valueSql: `CAST('' AS STRING)` },
			]);
		}
	}
}
