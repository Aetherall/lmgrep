import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import {
	Store,
	getDbPath,
	readProjectMetadata,
	writeProjectMetadata,
	extractModelFamily,
} from "./store.js";
import type { IndexedChunk } from "./types.js";

// --- Share codes ---

// 256 short, unambiguous English words
const WORDS = [
	"acid","acme","aged","also","arch","area","army","away","back","bail",
	"bake","band","bank","barn","base","bath","beam","bean","bear","beat",
	"beef","beer","bell","belt","bend","bike","bird","bite","blow","blue",
	"boat","body","bolt","bomb","bond","bone","book","boot","born","boss",
	"bowl","bulk","bull","burn","cage","cake","calm","came","camp","cape",
	"card","care","cart","case","cash","cast","cave","chef","chip","city",
	"clan","clay","clip","club","clue","coal","coat","code","coil","coin",
	"cold","come","cook","cool","cope","copy","cord","core","corn","cost",
	"crew","crop","crow","cure","curl","cute","dame","damp","dare","dark",
	"dash","data","dawn","deal","dean","deck","deep","deer","demo","desk",
	"dial","dice","diet","dirt","disk","dock","door","dose","down","draw",
	"drop","drum","dual","duck","dull","dump","dune","dust","duty","each",
	"earl","earn","ease","east","edge","else","epic","even","ever","exam",
	"exit","face","fact","fade","fail","fair","fall","fame","farm","fast",
	"fate","fawn","feed","feel","file","film","find","fine","fire","firm",
	"fish","flag","flat","fled","flip","flow","foam","fold","folk","fond",
	"food","fool","fork","form","fort","foul","four","free","frog","fuel",
	"full","fund","fury","fuse","gain","gale","game","gang","gate","gave",
	"gaze","gear","gene","gift","glad","glow","glue","goat","gold","golf",
	"gone","good","grab","gray","grid","grip","grow","gulf","guru","gust",
	"hack","half","hall","halt","hand","hang","hare","harm","harp","hash",
	"hate","haul","have","hawk","haze","head","heap","heat","held","helm",
	"help","herb","herd","here","hero","hide","high","hike","hill","hilt",
	"hint","hire","hold","hole","holy","home","hood","hook","hope","horn",
	"host","hour","huge","hull","hung","hunt","hurt","icon","idea","inch",
	"info","iron","isle","item","jack","jade",
];

export function generateShareCode(): string {
	const bytes = randomBytes(16);
	const w1 = WORDS[bytes[0]];
	const w2 = WORDS[bytes[1]];
	const w3 = WORDS[bytes[2]];
	const hex = bytes.slice(3, 8).toString("hex");
	return `lmgrep${w1}${w2}${w3}${hex}`;
}

/**
 * Derive a Hyperswarm topic (for peer discovery) from the share code.
 * This is a separate derivation from the encryption key — knowing the
 * topic does NOT reveal the key.
 */
export function shareCodeToTopic(code: string): Buffer {
	return Buffer.from(
		hkdfSync("sha256", code, "lmgrep-topic", "topic", 32),
	);
}

/**
 * Derive a 256-bit AES key from the share code for payload encryption.
 */
function deriveKey(code: string): Buffer {
	return Buffer.from(
		hkdfSync("sha256", code, "lmgrep-key", "encryption", 32),
	);
}

function encrypt(key: Buffer, plaintext: Buffer): Buffer {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	// iv (12) + tag (16) + ciphertext
	return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(key: Buffer, data: Buffer): Buffer {
	const iv = data.subarray(0, 12);
	const tag = data.subarray(12, 28);
	const ciphertext = data.subarray(28);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export const SHARE_CODE_RE = /^lmgrep[a-z]+[0-9a-f]{10}$/;

// --- NDJSON helpers ---

type Message =
	| { type: "meta"; model?: string; dimensions?: number; chunkCount: number; branch: string; remote?: string }
	| { type: "ready" }
	| { type: "chunks"; batch: Record<string, unknown>[] }
	| { type: "files"; batch: Array<{ filePath: string; fileHash: string; branch: string }> }
	| { type: "done" }
	| { type: "ack" };

function sendMsg(socket: { write: (data: Buffer) => boolean }, key: Buffer, msg: Message): void {
	const plaintext = Buffer.from(JSON.stringify(msg));
	const encrypted = encrypt(key, plaintext);
	// Length-prefixed framing: 4-byte big-endian length + encrypted payload
	const frame = Buffer.alloc(4 + encrypted.length);
	frame.writeUInt32BE(encrypted.length, 0);
	encrypted.copy(frame, 4);
	socket.write(frame);
}

function createFrameParser(
	key: Buffer,
	onMessage: (msg: Message) => void,
): (chunk: Buffer) => void {
	let buffer = Buffer.alloc(0);
	return (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const frameLen = buffer.readUInt32BE(0);
			if (buffer.length < 4 + frameLen) break;
			const encrypted = buffer.subarray(4, 4 + frameLen);
			buffer = buffer.subarray(4 + frameLen);
			const plaintext = decrypt(key, encrypted);
			onMessage(JSON.parse(plaintext.toString()));
		}
	};
}

// --- Dynamic Hyperswarm import ---

async function loadHyperswarm(): Promise<new () => HyperswarmInstance> {
	try {
		// @ts-ignore -- no type declarations for hyperswarm
		const mod = await import("hyperswarm");
		return mod.default ?? mod;
	} catch {
		throw new Error(
			"hyperswarm is not installed. Run: pnpm add hyperswarm",
		);
	}
}

interface HyperswarmInstance {
	join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): { flushed(): Promise<void> };
	on(event: "connection", cb: (socket: DuplexSocket, info: unknown) => void): void;
	destroy(): Promise<void>;
}

interface DuplexSocket {
	write(data: Buffer): boolean;
	on(event: "data", cb: (chunk: Buffer) => void): void;
	on(event: "end" | "close" | "error", cb: (err?: Error) => void): void;
	end(): void;
	destroy(): void;
}

// --- Export ---

const BATCH_SIZE = 200;
const PEER_TIMEOUT_MS = 5 * 60 * 1000;

export interface ExportOptions {
	cwd: string;
	onProgress?: (sent: number, total: number) => void;
}

export async function startExport(
	opts: ExportOptions,
): Promise<{ code: string; done: Promise<void> }> {
	const Hyperswarm = await loadHyperswarm();
	const store = Store.forProject(opts.cwd);
	const dbPath = getDbPath(opts.cwd);
	const metadata = readProjectMetadata(dbPath);
	const chunkCount = await store.chunkCount();

	const code = generateShareCode();
	const topic = shareCodeToTopic(code);
	const key = deriveKey(code);
	const swarm = new Hyperswarm();

	const cleanup = async () => {
		await swarm.destroy().catch(() => {});
		await store.close();
	};

	const done = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(async () => {
			await cleanup();
			reject(new Error("Timed out waiting for peer (5 minutes)."));
		}, PEER_TIMEOUT_MS);

		swarm.on("connection", async (socket: DuplexSocket) => {
			clearTimeout(timeout);

			try {
				// Send metadata
				sendMsg(socket, key, {
					type: "meta",
					model: metadata?.model,
					dimensions: metadata?.dimensions,
					chunkCount,
					branch: metadata?.branch ?? "main",
					remote: metadata?.remote,
				});

				// Wait for ready
				await waitForMessage(socket, key, "ready");

				// Stream chunks
				let sent = 0;
				for await (const batch of store.streamAllChunks(BATCH_SIZE)) {
					sendMsg(socket, key, { type: "chunks", batch });
					sent += batch.length;
					opts.onProgress?.(sent, chunkCount);
				}

				// Stream file entries
				const files = await store.getAllFileEntries();
				if (files.length > 0) {
					sendMsg(socket, key, { type: "files", batch: files });
				}

				// Done
				sendMsg(socket, key, { type: "done" });
				await waitForMessage(socket, key, "ack");

				socket.end();
				await cleanup();
				resolve();
			} catch (err) {
				await cleanup();
				reject(err);
			}
		});

		const discovery = swarm.join(topic, { server: true, client: false });
		discovery.flushed().catch(reject);
	});

	return { code, done };
}

// --- Import ---

export interface ImportOptions {
	cwd: string;
	code: string;
	reset?: boolean;
	onProgress?: (received: number, total: number) => void;
	onMeta?: (meta: { model?: string; dimensions?: number; chunkCount: number; remote?: string }) => void;
}

export async function startImport(
	opts: ImportOptions,
): Promise<{ chunks: number; files: number }> {
	const Hyperswarm = await loadHyperswarm();
	const store = Store.forProject(opts.cwd);

	if (opts.reset) {
		await store.reset();
	}

	const topic = shareCodeToTopic(opts.code);
	const key = deriveKey(opts.code);
	const swarm = new Hyperswarm();

	const cleanup = async () => {
		await swarm.destroy().catch(() => {});
		await store.close();
	};

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(async () => {
			await cleanup();
			reject(new Error("Timed out waiting for peer (5 minutes)."));
		}, PEER_TIMEOUT_MS);

		swarm.on("connection", (socket: DuplexSocket) => {
			clearTimeout(timeout);

			let totalChunks = 0;
			let receivedChunks = 0;
			let receivedFiles = 0;
			let metaSent = false;

			const parse = createFrameParser(key, (msg: Message) => {
				try {
					handleMessage(msg);
				} catch (err) {
					cleanup().then(() =>
						reject(new Error(`Protocol error: ${err}`)),
					);
				}
			});

			socket.on("data", parse);
			socket.on("error", (err) => {
				cleanup().then(() => reject(err));
			});

			const handleMessage = (msg: Message) => {
				switch (msg.type) {
					case "meta": {
						totalChunks = msg.chunkCount;
						opts.onMeta?.({
							model: msg.model,
							dimensions: msg.dimensions,
							chunkCount: msg.chunkCount,
							remote: msg.remote,
						});

						// Validate model compatibility
						const localDb = getDbPath(opts.cwd);
						const localMeta = readProjectMetadata(localDb);
						if (localMeta?.model && msg.model) {
							const localFamily = extractModelFamily(localMeta.model);
							const remoteFamily = extractModelFamily(msg.model);
							if (localFamily !== remoteFamily || localMeta.dimensions !== msg.dimensions) {
								console.error(
									`Warning: source uses "${msg.model}" (${msg.dimensions} dims) ` +
									`but local index uses "${localMeta.model}" (${localMeta.dimensions} dims). ` +
									`Imported vectors may not be compatible.`,
								);
							}
						}

						sendMsg(socket, key, { type: "ready" });
						metaSent = true;
						break;
					}
					case "chunks": {
						if (!metaSent) break;
						const chunks = msg.batch as unknown as IndexedChunk[];
						receivedChunks += chunks.length;
						opts.onProgress?.(receivedChunks, totalChunks);
						store.addChunks(chunks).catch((err) => {
							cleanup().then(() => reject(err));
						});
						break;
					}
					case "files": {
						if (!metaSent) break;
						receivedFiles += msg.batch.length;
						store.upsertFileHashes(msg.batch).catch((err) => {
							cleanup().then(() => reject(err));
						});
						break;
					}
					case "done": {
						sendMsg(socket, key, { type: "ack" });
						writeProjectMetadata(opts.cwd);
						cleanup().then(() =>
							resolve({ chunks: receivedChunks, files: receivedFiles }),
						);
						break;
					}
				}
			};
		});

		const discovery = swarm.join(topic, { server: false, client: true });
		discovery.flushed().catch(reject);
	});
}

// --- Helpers ---

function waitForMessage(
	socket: DuplexSocket,
	key: Buffer,
	expectedType: string,
): Promise<Message> {
	return new Promise((resolve, reject) => {
		const parse = createFrameParser(key, (msg) => {
			if (msg.type === expectedType) {
				socket.on("data", () => {}); // clear handler
				resolve(msg);
			}
		});
		socket.on("data", parse);
		socket.on("error", reject);
		socket.on("close", () => reject(new Error("Connection closed")));
	});
}
