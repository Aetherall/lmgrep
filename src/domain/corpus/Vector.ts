/**
 * An embedding as a value object: a chunk's meaning, or a query's, as a point
 * in the model's vector space.
 *
 * Every operation returns a new Vector; none mutate. Raw `number[]` stays the
 * wire format at the LanceDB and provider boundaries — this type is for the
 * domain, where naming the operation matters more than avoiding an allocation.
 *
 * Keep it that way. Scoring a whole table happens inside LanceDB, natively;
 * the operations here run over single queries and result pages, where the
 * allocations are free.
 */
export class Vector {
	private constructor(private readonly values: readonly number[]) {}

	static from(values: readonly number[] | Float32Array): Vector {
		return new Vector(
			values instanceof Float32Array ? Array.from(values) : values,
		);
	}

	/** Zero vector of the given width — the identity for {@link plus}. */
	static zeros(dimensions: number): Vector {
		return new Vector(new Array(dimensions).fill(0));
	}

	static mean(vectors: readonly Vector[]): Vector {
		if (vectors.length === 0) {
			throw new Error("Cannot take the mean of zero vectors");
		}
		return Vector.sum(vectors).scaledBy(1 / vectors.length);
	}

	static sum(vectors: readonly Vector[]): Vector {
		if (vectors.length === 0) {
			throw new Error("Cannot sum zero vectors");
		}
		const out = new Array(vectors[0].values.length).fill(0);
		for (const v of vectors) {
			for (let i = 0; i < out.length; i++) out[i] += v.values[i];
		}
		return new Vector(out);
	}

	get dimensions(): number {
		return this.values.length;
	}

	/** A mutable copy, for the provider and LanceDB boundaries. */
	toArray(): number[] {
		return [...this.values];
	}

	componentAt(index: number): number {
		return this.values[index];
	}

	dot(other: Vector): number {
		let s = 0;
		for (let i = 0; i < this.values.length; i++) {
			s += this.values[i] * other.values[i];
		}
		return s;
	}

	plus(other: Vector): Vector {
		const out = new Array(this.values.length);
		for (let i = 0; i < out.length; i++) {
			out[i] = this.values[i] + other.values[i];
		}
		return new Vector(out);
	}

	minus(other: Vector): Vector {
		const out = new Array(this.values.length);
		for (let i = 0; i < out.length; i++) {
			out[i] = this.values[i] - other.values[i];
		}
		return new Vector(out);
	}

	scaledBy(factor: number): Vector {
		const out = new Array(this.values.length);
		for (let i = 0; i < out.length; i++) out[i] = this.values[i] * factor;
		return new Vector(out);
	}

	/** Unit vector in the same direction. A zero vector is returned unchanged. */
	normalized(): Vector {
		let s = 0;
		for (const v of this.values) s += v * v;
		const n = Math.sqrt(s) || 1;
		return this.scaledBy(1 / n);
	}

	/**
	 * Cosine distance, valid only for unit vectors — callers normalize first.
	 * Kept as `1 - dot` rather than a general cosine so the clustering hot path
	 * does not re-derive magnitudes it already knows are 1.
	 */
	cosineDistanceTo(other: Vector): number {
		return 1 - this.dot(other);
	}
}
