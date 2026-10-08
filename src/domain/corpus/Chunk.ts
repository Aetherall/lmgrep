import { CodeLocation } from "./CodeLocation.js";
import { ContentHash } from "./ContentHash.js";
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

	splitByBytes(maxBytes: number, documentPrefix = ""): Chunk[] {
		const overhead = Buffer.byteLength(`${documentPrefix}${this.context}\n`);
		if (overhead + Buffer.byteLength(this.content) <= maxBytes) return [this];
		const budget = maxBytes - overhead;
		if (budget < 4)
			throw new Error(
				`Embedding context exceeds the byte budget for ${this.location}`,
			);
		const parts: Chunk[] = [];
		let content = "";
		let bytes = 0;
		let startLine = this.location.startLine;
		let line = startLine;
		const emit = () => {
			parts.push(
				new Chunk({
					location: new CodeLocation(
						this.location.filePath,
						startLine,
						Math.min(
							this.location.endLine,
							content.endsWith("\n") ? line - 1 : line,
						),
					),
					type: this.type,
					name: this.name,
					content,
					context: this.context,
					hash: ContentHash.of(content),
					fileVersion: this.fileVersion,
				}),
			);
			content = "";
			bytes = 0;
			startLine = line;
		};
		for (const sourceLine of this.content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
			const lineBytes = Buffer.byteLength(sourceLine);
			if (bytes + lineBytes > budget && content) emit();
			if (lineBytes <= budget) {
				content += sourceLine;
				bytes += lineBytes;
				if (sourceLine.endsWith("\n")) line++;
			} else {
				for (const character of sourceLine) {
					const size = Buffer.byteLength(character);
					if (bytes + size > budget) emit();
					content += character;
					bytes += size;
					if (character === "\n") line++;
				}
			}
		}
		if (content) emit();
		return parts;
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
