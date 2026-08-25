import type { CodeLocation } from "./CodeLocation.js";
import type { ContentHash } from "./ContentHash.js";
import { FileVersion } from "./FileVersion.js";

/** Everything needed to build a Chunk, so callers never mis-order positionals. */
export interface ChunkProperties {
	location: CodeLocation;
	/** AST node type it was cut at, or "block"/"section" for non-parsed files. */
	type: string;
	name: string;
	content: string;
	/** Enclosing scope, leading comment and role, prepended when embedding. */
	context: string;
	hash: ContentHash;
	fileVersion?: FileVersion;
}

/**
 * A unit of code as indexed: one AST node, markdown section, or sliding window.
 *
 * Identity is `path:line:hash`, so the same content at the same place is the
 * same chunk across branches — that is what lets branches share embeddings
 * instead of re-embedding identical code.
 */
export class Chunk {
	/** Roughly the characters per token for code; good enough for budgeting. */
	private static readonly CHARS_PER_TOKEN = 4;

	readonly location: CodeLocation;
	readonly type: string;
	readonly name: string;
	readonly content: string;
	readonly context: string;
	readonly hash: ContentHash;
	readonly fileVersion: FileVersion;

	constructor(props: ChunkProperties) {
		this.location = props.location;
		this.type = props.type;
		this.name = props.name;
		this.content = props.content;
		this.context = props.context;
		this.hash = props.hash;
		this.fileVersion = props.fileVersion ?? FileVersion.unknown();
	}

	/**
	 * Stable identity. The hash is part of it so that editing a chunk in place
	 * produces a new row rather than silently shadowing the old one.
	 */
	get id(): string {
		return `${this.location.filePath}:${this.location.startLine - 1}:${this.hash}`;
	}

	/**
	 * What actually gets embedded: the context header followed by the source.
	 * Retrieval quality depends on the header being present, so this is the one
	 * definition of "the text of a chunk".
	 */
	embeddingText(): string {
		return `${this.context}\n${this.content}`;
	}

	/** Estimated token cost of {@link embeddingText}, for provider limits. */
	estimatedTokens(): number {
		return Math.ceil(
			(this.context.length + this.content.length) / Chunk.CHARS_PER_TOKEN,
		);
	}

	/** The same chunk stamped with the file version it was produced from. */
	stampedWith(fileVersion: FileVersion): Chunk {
		return new Chunk({
			location: this.location,
			type: this.type,
			name: this.name,
			content: this.content,
			context: this.context,
			hash: this.hash,
			fileVersion,
		});
	}
}
