import { statSync, watch } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";
import { ContentHash } from "../../domain/corpus/ContentHash.js";
import { SourceFile } from "../../domain/corpus/SourceFile.js";
import type {
	ChangeSet,
	ExtensionRules,
	WatchHandle,
	WorkspacePort,
} from "../../domain/ports/WorkspacePort.js";
import { IndexableFileRules } from "./IndexableFileRules.js";
import { readFileSync } from "node:fs";

/** The working tree on the real filesystem. */
export class Workspace implements WorkspacePort {
	listFiles(
		cwd: string,
		extraIgnore?: string[],
		extensions?: ExtensionRules,
	): string[] {
		const rules = new IndexableFileRules(cwd, extraIgnore, extensions);
		const all = globSync("**/*", { cwd, nodir: true, dot: false });
		rules.loadNestedIgnores(all);
		return all.filter((f) => rules.admits(f));
	}

	hashOf(cwd: string, filePath: string): ContentHash | undefined {
		try {
			return ContentHash.of(readFileSync(join(cwd, filePath)));
		} catch {
			return undefined;
		}
	}

	modifiedSince(files: string[], cwd: string, cutoffMs: number): string[] {
		return files.filter((f) => {
			try {
				return statSync(join(cwd, f)).mtimeMs >= cutoffMs;
			} catch {
				return false;
			}
		});
	}

	/**
	 * Compare on-disk hashes against what the manifest recorded.
	 *
	 * Unreadable files are skipped rather than reported as changed — a
	 * transient read error should not evict a file from the index.
	 */
	detectChanges(
		files: string[],
		manifest: { versionOf(path: string): ContentHash | undefined },
		cwd: string,
		force = false,
	): ChangeSet {
		const changed: SourceFile[] = [];
		const current = new Map<string, ContentHash>();

		for (const file of files) {
			const hash = this.hashOf(cwd, file);
			if (!hash) continue;
			current.set(file, hash);
			const stored = manifest.versionOf(file);
			if (force || stored === undefined || !stored.equals(hash)) {
				changed.push(new SourceFile(file, hash));
			}
		}

		return { changed, current };
	}

	/**
	 * Watch for changes, coalescing a burst into one callback.
	 *
	 * fs.watch's recursive mode misses events on Linux (new subdirectories,
	 * editor atomic saves); callers pair this with a periodic reconcile rather
	 * than trusting it alone.
	 */
	watch(
		cwd: string,
		extraIgnore: string[] | undefined,
		onChanges: (changedFiles: string[]) => void,
		debounceMs: number,
		extensions?: ExtensionRules,
	): WatchHandle {
		const rules = new IndexableFileRules(cwd, extraIgnore, extensions);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pending = new Set<string>();

		const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
			if (!filename) return;
			if (!rules.hasIndexableExtension(filename)) return;
			if (rules.isIgnored(filename)) return;

			pending.add(filename);
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				const files = [...pending];
				pending = new Set();
				onChanges(files);
			}, debounceMs);
		});

		return {
			close() {
				if (timer) clearTimeout(timer);
				watcher.close();
			},
		};
	}
}
