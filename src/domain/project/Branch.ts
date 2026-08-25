/**
 * A branch scope for reads and writes.
 *
 * Chunks are shared across branches by content hash; the file manifest is what
 * is branch-scoped. A manually targeted database is flat — it uses
 * {@link Branch.DEFAULT} so switching git branches never hides results in a
 * database the user asked for by name or path.
 */
export class Branch {
	/** Scope used by non-git projects and manually targeted databases. */
	static readonly DEFAULT_NAME = "_default";

	private constructor(private readonly name: string) {}

	static of(name: string): Branch {
		return new Branch(name);
	}

	static default(): Branch {
		return new Branch(Branch.DEFAULT_NAME);
	}

	toString(): string {
		return this.name;
	}

	equals(other: Branch): boolean {
		return this.name === other.name;
	}

	/** Single-quote-escaped for embedding in a LanceDB filter predicate. */
	toSqlLiteral(): string {
		return this.name.replace(/'/g, "''");
	}
}
