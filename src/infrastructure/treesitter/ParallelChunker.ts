import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { Chunk } from "../../domain/corpus/Chunk.js";
import { CodeLocation } from "../../domain/corpus/CodeLocation.js";
import { ContentHash } from "../../domain/corpus/ContentHash.js";
import type { ChunkerPort } from "../../domain/ports/ChunkerPort.js";
import type { ChunkData, ChunkRequest, ChunkResponse } from "./ChunkWorker.js";
import {
	embeddedAssets,
	embeddedChunkWorker,
} from "./EmbeddedTreeSitterAssets.js";
import { TreeSitterChunker } from "./TreeSitterChunker.js";

interface Task {
	request: ChunkRequest;
	resolve: (chunks: Chunk[]) => void;
	reject: (error: Error) => void;
}

interface PoolWorker {
	thread: Worker;
	tasks: Map<number, Task>;
	/** Whether it has finished a file, proving workers can run here. */
	started: boolean;
}

/**
 * Chunks files on a pool of worker threads.
 *
 * Parsing is wasm and single-threaded, and files are independent, so this
 * scales with cores. Callers must issue calls concurrently to benefit.
 *
 * Workers start on first use and are unreferenced while idle, so they never
 * keep the process alive, and are terminated after a quiet period so a
 * long-running watcher does not hold their grammars in memory. If a worker
 * cannot start or dies, its files are chunked in-process instead: a broken
 * pool must cost speed, never skipped files.
 */
export class ParallelChunker implements ChunkerPort {
	private static readonly MAX_WORKERS = 8;
	private static readonly IDLE_TERMINATE_MS = 10_000;

	private workers: PoolWorker[] = [];
	private nextId = 0;
	private idleTimer: NodeJS.Timeout | undefined;
	private disabled = false;
	private readonly local = new TreeSitterChunker();

	constructor(
		private readonly size = Math.min(
			ParallelChunker.MAX_WORKERS,
			Math.max(1, availableParallelism() - 1),
		),
		private readonly workerUrl: string | URL = embeddedChunkWorker() ??
			new URL("./ChunkWorker.js", import.meta.url),
	) {}

	chunk(filePath: string, cwd: string): Promise<Chunk[]> {
		const worker = this.leastBusy();
		if (!worker) return this.local.chunk(filePath, cwd);

		clearTimeout(this.idleTimer);
		const request = { id: this.nextId++, filePath, cwd };
		return new Promise<Chunk[]>((resolve, reject) => {
			if (worker.tasks.size === 0) worker.thread.ref();
			worker.tasks.set(request.id, { request, resolve, reject });
			worker.thread.postMessage(request);
		});
	}

	/** Stop every worker now rather than waiting for the idle timeout. */
	async close(): Promise<void> {
		clearTimeout(this.idleTimer);
		const workers = this.workers;
		this.workers = [];
		await Promise.all(workers.map((worker) => this.retire(worker)));
	}

	private leastBusy(): PoolWorker | undefined {
		if (this.disabled) return undefined;
		while (this.workers.length < this.size) {
			const worker = this.spawn();
			if (!worker) break;
			this.workers.push(worker);
		}
		return this.workers.reduce<PoolWorker | undefined>(
			(best, worker) =>
				!best || worker.tasks.size < best.tasks.size ? worker : best,
			undefined,
		);
	}

	private spawn(): PoolWorker | undefined {
		let thread: Worker;
		try {
			thread = new Worker(this.workerUrl, {
				workerData: { assets: embeddedAssets() },
			});
		} catch {
			this.disabled = true;
			return undefined;
		}
		const worker: PoolWorker = { thread, tasks: new Map(), started: false };
		thread.on("message", (response: ChunkResponse) =>
			this.settle(worker, response),
		);
		thread.on("error", () => this.abandon(worker));
		thread.on("exit", () => this.abandon(worker));
		// After the listeners: attaching a message listener re-references the
		// worker, so a worker that never received a file kept the process
		// alive until the idle timeout terminated it.
		thread.unref();
		return worker;
	}

	private settle(worker: PoolWorker, response: ChunkResponse): void {
		const task = worker.tasks.get(response.id);
		if (!task) return;
		worker.tasks.delete(response.id);
		worker.started = true;
		if ("error" in response) task.reject(new Error(response.error));
		else task.resolve(response.chunks.map(ParallelChunker.toChunk));
		this.afterTask(worker);
	}

	/**
	 * A worker that errored or exited takes no new work; the next call starts a
	 * replacement. One that dies before finishing any file means workers cannot
	 * run here at all, so the pool stops trying and chunks in-process.
	 */
	private abandon(worker: PoolWorker): void {
		if (!this.workers.includes(worker)) return;
		this.workers = this.workers.filter((other) => other !== worker);
		if (!worker.started) this.disabled = true;
		void this.retire(worker);
	}

	/** Terminate a worker, redoing whatever it was holding in-process. */
	private async retire(worker: PoolWorker): Promise<void> {
		const tasks = [...worker.tasks.values()];
		worker.tasks.clear();
		for (const { request, resolve, reject } of tasks) {
			this.local.chunk(request.filePath, request.cwd).then(resolve, reject);
		}
		await worker.thread.terminate();
	}

	private afterTask(worker: PoolWorker): void {
		if (worker.tasks.size > 0) return;
		worker.thread.unref();
		if (this.workers.every((other) => other.tasks.size === 0)) {
			clearTimeout(this.idleTimer);
			this.idleTimer = setTimeout(
				() => void this.close(),
				ParallelChunker.IDLE_TERMINATE_MS,
			);
			this.idleTimer.unref();
		}
	}

	private static toChunk(data: ChunkData): Chunk {
		return new Chunk({
			location: new CodeLocation(data.filePath, data.startLine, data.endLine),
			type: data.type,
			name: data.name,
			content: data.content,
			context: data.context,
			hash: ContentHash.fromStored(data.hash),
		});
	}
}
