import { ModelIdentity } from "../../domain/project/ModelIdentity.js";
import type { ProjectMetadata } from "../fs/ProjectMetadataStore.js";
import type { RowReplication } from "../lancedb/RowReplication.js";
import { PeerSwarm } from "./PeerSwarm.js";
import {
	type DuplexSocket,
	SecureChannel,
	type ShareMessage,
} from "./SecureChannel.js";
import { ShareCode } from "./ShareCode.js";

export interface ShareProgress {
	onProgress?: (done: number, total: number) => void;
}

export interface ReceiveOptions extends ShareProgress {
	onMeta?: (meta: {
		model?: string;
		dimensions?: number;
		chunkCount: number;
		remote?: string;
	}) => void;
	onWarning?: (message: string) => void;
}

export interface ReceiveResult {
	chunks: number;
	files: number;
}

/**
 * Sends and receives a whole index between two machines.
 *
 * The transfer copies rows verbatim, embeddings included: re-embedding a large
 * repository is the expensive thing, and avoiding it is the entire reason to
 * share. That makes model compatibility the receiver's responsibility to check
 * — vectors from a different model are silently meaningless, so a mismatch is
 * warned about explicitly.
 */
export class IndexShare {
	private static readonly BATCH_SIZE = 200;
	private static readonly PEER_TIMEOUT_MS = 5 * 60 * 1000;

	constructor(private readonly rows: RowReplication) {}

	/**
	 * Publish the index and return the code a peer needs. `done` resolves once
	 * a peer has taken the whole transfer.
	 */
	async send(
		metadata: ProjectMetadata | undefined,
		options: ShareProgress = {},
	): Promise<{ code: string; done: Promise<void> }> {
		const swarm = await PeerSwarm.create();
		const code = ShareCode.generate();
		const channel = new SecureChannel(code.toEncryptionKey());
		const chunkCount = await this.rows.chunkCount();

		const done = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				void swarm.destroy();
				reject(new Error("Timed out waiting for peer (5 minutes)."));
			}, IndexShare.PEER_TIMEOUT_MS);

			swarm.onConnection(async (socket) => {
				clearTimeout(timeout);
				try {
					channel.send(socket, {
						type: "meta",
						model: metadata?.model,
						dimensions: metadata?.dimensions,
						chunkCount,
						branch: metadata?.branch ?? "main",
						remote: metadata?.remote,
					});
					// Wait for the receiver to accept before streaming — it may
					// refuse on an incompatible model.
					await channel.await(socket, "ready");

					let sent = 0;
					for await (const batch of this.rows.streamChunkRows(
						IndexShare.BATCH_SIZE,
					)) {
						channel.send(socket, { type: "chunks", batch });
						sent += batch.length;
						options.onProgress?.(sent, chunkCount);
					}

					const files = await this.rows.allManifestRows();
					if (files.length > 0) {
						channel.send(socket, { type: "files", batch: files });
					}

					channel.send(socket, { type: "done" });
					// Wait for the ack so the socket is not torn down before
					// the receiver has committed.
					await channel.await(socket, "ack");

					socket.end();
					await swarm.destroy();
					resolve();
				} catch (err) {
					await swarm.destroy();
					reject(err);
				}
			});

			swarm.join(code.toTopic(), "server").catch(reject);
		});

		return { code: code.toString(), done };
	}

	/** Connect to a sharer and write everything it sends into this database. */
	async receive(
		code: ShareCode,
		localMetadata: ProjectMetadata | undefined,
		options: ReceiveOptions = {},
	): Promise<ReceiveResult> {
		const swarm = await PeerSwarm.create();
		const channel = new SecureChannel(code.toEncryptionKey());

		return new Promise<ReceiveResult>((resolve, reject) => {
			const timeout = setTimeout(() => {
				void swarm.destroy();
				reject(new Error("Timed out waiting for peer (5 minutes)."));
			}, IndexShare.PEER_TIMEOUT_MS);

			const fail = (err: unknown): void => {
				void swarm.destroy().then(() => reject(err));
			};

			swarm.onConnection((socket: DuplexSocket) => {
				clearTimeout(timeout);

				let expected = 0;
				let chunks = 0;
				let files = 0;
				let accepted = false;

				const handle = (message: ShareMessage): void => {
					switch (message.type) {
						case "meta": {
							expected = message.chunkCount;
							options.onMeta?.({
								model: message.model,
								dimensions: message.dimensions,
								chunkCount: message.chunkCount,
								remote: message.remote,
							});
							this.warnOnModelMismatch(
								localMetadata,
								message,
								options.onWarning,
							);
							channel.send(socket, { type: "ready" });
							accepted = true;
							break;
						}
						case "chunks": {
							// Ignore anything arriving before the handshake.
							if (!accepted) break;
							chunks += message.batch.length;
							options.onProgress?.(chunks, expected);
							this.rows.addChunkRows(message.batch).catch(fail);
							break;
						}
						case "files": {
							if (!accepted) break;
							files += message.batch.length;
							this.rows.addManifestRows(message.batch).catch(fail);
							break;
						}
						case "done": {
							channel.send(socket, { type: "ack" });
							void swarm.destroy().then(() => resolve({ chunks, files }));
							break;
						}
					}
				};

				const read = channel.reader((message) => {
					try {
						handle(message);
					} catch (err) {
						fail(new Error(`Protocol error: ${err}`));
					}
				});
				socket.on("data", read);
				socket.on("error", fail);
			});

			swarm.join(code.toTopic(), "client").catch(reject);
		});
	}

	private warnOnModelMismatch(
		local: ProjectMetadata | undefined,
		remote: { model?: string; dimensions?: number },
		onWarning?: (message: string) => void,
	): void {
		if (!local?.model || !remote.model) return;
		const localFamily = ModelIdentity.of(local.model).family;
		const remoteFamily = ModelIdentity.of(remote.model).family;
		if (
			localFamily === remoteFamily &&
			local.dimensions === remote.dimensions
		) {
			return;
		}
		onWarning?.(
			`Warning: source uses "${remote.model}" (${remote.dimensions} dims) ` +
				`but local index uses "${local.model}" (${local.dimensions} dims). ` +
				"Imported vectors may not be compatible.",
		);
	}
}
