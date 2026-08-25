import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Messages exchanged during a share. */
export type ShareMessage =
	| {
			type: "meta";
			model?: string;
			dimensions?: number;
			chunkCount: number;
			branch: string;
			remote?: string;
	  }
	| { type: "ready" }
	| { type: "chunks"; batch: Record<string, unknown>[] }
	| {
			type: "files";
			batch: Array<{ filePath: string; fileHash: string; branch: string }>;
	  }
	| { type: "done" }
	| { type: "ack" };

/** The transport a share runs over. */
export interface DuplexSocket {
	write(data: Buffer): boolean;
	on(event: "data", cb: (chunk: Buffer) => void): void;
	on(event: "end" | "close" | "error", cb: (err?: Error) => void): void;
	end(): void;
	destroy(): void;
}

/**
 * Authenticated encryption and message framing over a raw peer socket.
 *
 * AES-256-GCM, so a tampered payload fails to decrypt rather than being parsed
 * — a peer discovered over a public DHT is not trusted. Frames carry an
 * explicit length prefix because a stream socket splits and merges writes
 * arbitrarily, and JSON alone gives no way to find a message boundary.
 */
export class SecureChannel {
	private static readonly IV_BYTES = 12;
	private static readonly TAG_BYTES = 16;
	private static readonly LENGTH_PREFIX_BYTES = 4;

	constructor(private readonly key: Buffer) {}

	send(socket: { write(data: Buffer): boolean }, message: ShareMessage): void {
		const encrypted = this.encrypt(Buffer.from(JSON.stringify(message)));
		const frame = Buffer.alloc(
			SecureChannel.LENGTH_PREFIX_BYTES + encrypted.length,
		);
		frame.writeUInt32BE(encrypted.length, 0);
		encrypted.copy(frame, SecureChannel.LENGTH_PREFIX_BYTES);
		socket.write(frame);
	}

	/**
	 * A stateful reader: feed it raw socket chunks, and it emits whole
	 * messages as their frames complete.
	 */
	reader(onMessage: (message: ShareMessage) => void): (chunk: Buffer) => void {
		let buffered = Buffer.alloc(0);
		return (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= SecureChannel.LENGTH_PREFIX_BYTES) {
				const length = buffered.readUInt32BE(0);
				if (buffered.length < SecureChannel.LENGTH_PREFIX_BYTES + length) {
					break;
				}
				const frame = buffered.subarray(
					SecureChannel.LENGTH_PREFIX_BYTES,
					SecureChannel.LENGTH_PREFIX_BYTES + length,
				);
				buffered = buffered.subarray(
					SecureChannel.LENGTH_PREFIX_BYTES + length,
				);
				onMessage(JSON.parse(this.decrypt(frame).toString()));
			}
		};
	}

	/** Resolve once a message of the expected type arrives. */
	await(
		socket: DuplexSocket,
		expected: ShareMessage["type"],
	): Promise<ShareMessage> {
		return new Promise((resolve, reject) => {
			const read = this.reader((message) => {
				if (message.type === expected) resolve(message);
			});
			socket.on("data", read);
			socket.on("error", reject);
			socket.on("close", () => reject(new Error("Connection closed")));
		});
	}

	private encrypt(plaintext: Buffer): Buffer {
		const iv = randomBytes(SecureChannel.IV_BYTES);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), body]);
	}

	private decrypt(data: Buffer): Buffer {
		const iv = data.subarray(0, SecureChannel.IV_BYTES);
		const tag = data.subarray(
			SecureChannel.IV_BYTES,
			SecureChannel.IV_BYTES + SecureChannel.TAG_BYTES,
		);
		const body = data.subarray(
			SecureChannel.IV_BYTES + SecureChannel.TAG_BYTES,
		);
		const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]);
	}
}
