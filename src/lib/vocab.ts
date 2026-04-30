const STOPWORDS = new Set([
	// English
	"the", "and", "but", "are", "was", "were", "been", "being",
	"have", "has", "had", "does", "did", "will", "would", "could", "should",
	"may", "might", "must", "can", "this", "that", "these", "those",
	"what", "which", "who", "when", "where", "why", "how",
	"all", "each", "every", "both", "few", "more", "most", "other", "some",
	"such", "nor", "not", "only", "own", "same", "than", "too", "very",
	"just", "don", "now", "else", "for", "with", "from", "into", "out",
	"off", "over", "under", "again", "further", "then", "once", "here",
	"there", "any", "about", "after", "before", "between", "during", "while",
	"because", "although", "though", "unless", "until", "since", "through",
	"against", "toward", "within", "without", "across", "around", "behind",
	"below", "above", "among", "beside", "besides", "beyond", "despite",
	"however", "therefore", "otherwise", "likely", "perhaps", "probably",
	"maybe", "really", "actually", "certainly", "surely", "basically",
	"generally", "usually", "typically", "often", "sometimes", "rarely",
	"always", "never", "anymore", "anyway", "anyways", "anytime", "anywhere",
	"looks", "seems", "means", "making", "taking", "going", "coming",
	"getting", "doing", "being", "having", "saying", "seeing", "knowing",
	"using", "trying", "showing", "giving", "telling", "thinking", "working",
	"calling", "letting", "putting", "holding", "running", "keeping",
	// Generic code
	"return", "const", "let", "var", "function", "async", "await", "new",
	"import", "export", "default", "public", "private", "protected", "class",
	"interface", "type", "extends", "implements", "static", "readonly", "void",
	"null", "undefined", "true", "false", "string", "number", "boolean",
	"object", "array", "promise", "unknown", "never", "typeof", "keyof",
	"satisfies", "args", "opts", "option", "options", "props", "params",
	"param", "data", "value", "values", "items", "item", "list", "index",
	"idx", "err", "error", "result", "results", "callback", "handler",
	"anonymous", "lines", "context", "payload", "input", "output", "arg",
	"self", "this", "that", "super", "constructor", "prototype", "instance",
	"method", "methods", "field", "fields", "key", "keys", "entry", "entries",
	"name", "names", "count", "size", "length", "total", "sum", "min", "max",
	"temp", "tmp", "foo", "bar", "baz", "qux", "test", "tests", "spec",
	"specs", "todo", "fixme", "hack", "note", "notes", "info",
	"loading", "loaded", "fetching", "fetched", "saving", "saved", "updating",
	"updated", "creating", "created", "deleting", "deleted", "removing",
	"removed", "parsing", "parsed", "building", "built", "processing",
	"processed", "running", "starting", "started", "stopping", "stopped",
	"setting", "getting", "adding", "added", "removing", "removed",
	"pending", "ready", "done", "ongoing", "complete", "completed",
]);

function splitIdentifier(id: string): string[] {
	return id
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/[_\-.]/g, " ")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
}

/**
 * Tokenize text into vocab terms. Splits camelCase / snake_case / kebab-case
 * identifiers into parts. Filters stopwords, digits, and length outliers.
 */
export function tokenize(text: string): string[] {
	if (!text) return [];
	const raw = text.replace(/[^A-Za-z0-9_]+/g, " ").split(/\s+/).filter(Boolean);
	const out: string[] = [];
	for (const t of raw) {
		const looksIdent = /[a-z][A-Z]|[A-Z]{2,}[a-z]|_/.test(t);
		const parts = looksIdent ? splitIdentifier(t) : [t.toLowerCase()];
		for (const p of parts) {
			if (!isAcceptable(p)) continue;
			out.push(p);
		}
	}
	return out;
}

function isAcceptable(p: string): boolean {
	if (p.length < 4 || p.length > 20) return false;
	if (/\d/.test(p)) return false; // reject anything with digits (v81, schema1, f1c111...)
	if (STOPWORDS.has(p)) return false;
	if (!/^[a-z]+$/.test(p)) return false; // pure lowercase letters only
	if (!/[aeiou]/.test(p)) return false; // reject consonant-only strings (tsx, rgb, jwt...)
	return true;
}

/**
 * Aggregate term frequencies across many texts.
 */
export function collectVocab(
	texts: Iterable<string>,
	{ minDf = 1 }: { minDf?: number } = {},
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const t of texts) {
		const seen = new Set<string>();
		for (const tok of tokenize(t)) {
			if (!seen.has(tok)) {
				counts.set(tok, (counts.get(tok) ?? 0) + 1);
				seen.add(tok);
			}
		}
	}
	if (minDf > 1) {
		for (const [k, v] of counts) if (v < minDf) counts.delete(k);
	}
	return counts;
}

// ---- Math helpers ----

export function l2normalize(v: number[] | Float32Array): number[] {
	let s = 0;
	for (let i = 0; i < v.length; i++) s += v[i] * v[i];
	const n = Math.sqrt(s) || 1;
	const out = new Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
	return out;
}

function dot(a: number[], b: number[]): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}

function cosDist(a: number[], b: number[]): number {
	return 1 - dot(a, b);
}

function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function kmeansPP(
	vectors: number[][],
	k: number,
	rng: () => number,
): number[][] {
	const centroids: number[][] = [
		vectors[Math.floor(rng() * vectors.length)].slice(),
	];
	const dists = new Array(vectors.length).fill(Infinity);
	for (let c = 1; c < k; c++) {
		for (let i = 0; i < vectors.length; i++) {
			const d = cosDist(vectors[i], centroids[c - 1]);
			if (d < dists[i]) dists[i] = d;
		}
		let sum = 0;
		for (const d of dists) sum += d;
		if (sum === 0) {
			centroids.push(vectors[Math.floor(rng() * vectors.length)].slice());
			continue;
		}
		let r = rng() * sum;
		let picked = 0;
		for (let i = 0; i < vectors.length; i++) {
			r -= dists[i];
			if (r <= 0) { picked = i; break; }
		}
		centroids.push(vectors[picked].slice());
	}
	return centroids;
}

function kmeans(
	vectors: number[][],
	k: number,
	seed: number,
): number[] {
	if (vectors.length <= k) return vectors.map((_, i) => i);
	const rng = mulberry32(seed);
	let centroids = kmeansPP(vectors, k, rng);
	const labels = new Array(vectors.length).fill(0);
	const maxIter = 50;

	for (let iter = 0; iter < maxIter; iter++) {
		let changed = false;
		for (let i = 0; i < vectors.length; i++) {
			let best = 0;
			let bestD = Infinity;
			for (let c = 0; c < k; c++) {
				const d = cosDist(vectors[i], centroids[c]);
				if (d < bestD) { bestD = d; best = c; }
			}
			if (labels[i] !== best) { changed = true; labels[i] = best; }
		}
		if (!changed) break;

		const dim = vectors[0].length;
		const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
		const counts = new Array(k).fill(0);
		for (let i = 0; i < vectors.length; i++) {
			const c = labels[i];
			counts[c]++;
			for (let d = 0; d < dim; d++) sums[c][d] += vectors[i][d];
		}
		for (let c = 0; c < k; c++) {
			if (counts[c] === 0) {
				centroids[c] = vectors[Math.floor(rng() * vectors.length)].slice();
			} else {
				centroids[c] = l2normalize(sums[c]);
			}
		}
	}
	return labels;
}

/**
 * Bisecting k-means on pre-normalized vectors (cosine distance).
 * Repeatedly splits the largest cluster into 2 until k reached.
 */
export function bisecting(
	vectors: number[][],
	k: number,
	seed = 42,
): number[] {
	const n = vectors.length;
	if (n <= k) return vectors.map((_, i) => i);

	const clusters: number[][] = [vectors.map((_, i) => i)];

	while (clusters.length < k) {
		let bestIdx = -1;
		let bestSize = 1;
		for (let i = 0; i < clusters.length; i++) {
			if (clusters[i].length > bestSize) {
				bestSize = clusters[i].length;
				bestIdx = i;
			}
		}
		if (bestIdx < 0) break;
		const c = clusters[bestIdx];
		const subVecs = c.map((i) => vectors[i]);
		const lab = kmeans(subVecs, 2, seed);
		const left: number[] = [];
		const right: number[] = [];
		for (let i = 0; i < c.length; i++) {
			if (lab[i] === 0) left.push(c[i]);
			else right.push(c[i]);
		}
		if (left.length === 0 || right.length === 0) break;
		clusters.splice(bestIdx, 1);
		clusters.push(left, right);
	}

	const out = new Array(n).fill(0);
	for (let ci = 0; ci < clusters.length; ci++) {
		for (const i of clusters[ci]) out[i] = ci;
	}
	return out;
}

export function mean(vecs: number[][]): number[] {
	const d = vecs[0].length;
	const out = new Array(d).fill(0);
	for (const v of vecs) for (let i = 0; i < d; i++) out[i] += v[i];
	for (let i = 0; i < d; i++) out[i] /= vecs.length;
	return out;
}

export function subtract(a: number[], b: number[]): number[] {
	const out = new Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
	return out;
}

export { stemmer as stem } from "stemmer";
