import {
	type Dirent,
	type FSWatcher,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
	watch,
} from "node:fs";
import { join } from "node:path";
import { ContentHash } from "../../domain/corpus/ContentHash.js";
import { SourceFile } from "../../domain/corpus/SourceFile.js";
import type {
	ChangeSet,
	ExtensionRules,
	WatchHandle,
	WorkspacePort,
} from "../../domain/ports/WorkspacePort.js";
import { IndexableFileRules } from "./IndexableFileRules.js";

/** The working tree on the real filesystem. */
export class Workspace implements WorkspacePort {
	listFiles(
		cwd: string,
		extraIgnore?: string[],
		extensions?: ExtensionRules,
	): string[] {
		const rules = new IndexableFileRules(cwd, extraIgnore, extensions);
		const files: string[] = [];
		// Ignored directories are never entered. Globbing the whole tree and
		// filtering afterwards walked node_modules on every reconcile: 2s per
		// pass on a 15k-file monorepo, for each watching worktree.
		const walk = (dir: string): void => {
			let entries: Dirent[];
			try {
				entries = readdirSync(join(cwd, dir), { withFileTypes: true });
			} catch {
				return;
			}
			rules.loadNestedIgnore(dir);
			for (const entry of entries) {
				// Dotfiles and dot-directories are not indexed.
				if (entry.name.startsWith(".")) continue;
				const path = dir ? `${dir}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					if (rules.admitsDirectory(path)) walk(path);
				} else if (rules.admits(path)) {
					// Symlinks land here whatever they point to: they are listed,
					// never followed.
					files.push(path);
				}
			}
		};
		walk("");
		return files.sort();
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
	 * One non-recursive watcher per directory the ignore rules admit, added as
	 * directories appear. `fs.watch`'s recursive mode cannot be used: on Linux
	 * Node emulates it with a watcher for every file and directory in the tree,
	 * ignored or not, and on a repository with `node_modules` that measured
	 * 123k watchers holding ~200MB of heap for a 349-file project.
	 *
	 * Events can still be missed (editor atomic saves, bursts, files created in
	 * a new directory before its watcher exists), so callers pair this with a
	 * periodic reconcile rather than trusting it alone.
	 */
	watch(
		cwd: string,
		extraIgnore: string[] | undefined,
		onChanges: (changedFiles: string[]) => void,
		debounceMs: number,
		extensions?: ExtensionRules,
	): WatchHandle {
		const rules = new IndexableFileRules(cwd, extraIgnore, extensions);
		const watchers = new Map<string, FSWatcher>();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pending = new Set<string>();

		const unwatch = (dir: string): void => {
			for (const [path, watcher] of watchers) {
				if (path === dir || path.startsWith(`${dir}/`)) {
					watcher.close();
					watchers.delete(path);
				}
			}
		};

		const watchTree = (dir: string): void => {
			if (watchers.has(dir)) return;
			let watcher: FSWatcher;
			try {
				watcher = watch(join(cwd, dir), (_event, name) => {
					if (name) changed(dir ? `${dir}/${name}` : name);
				});
			} catch {
				return;
			}
			watcher.on("error", () => unwatch(dir));
			watchers.set(dir, watcher);

			let entries: Dirent[];
			try {
				entries = readdirSync(join(cwd, dir), { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const child = dir ? `${dir}/${entry.name}` : entry.name;
				if (!rules.isIgnored(`${child}/`)) watchTree(child);
			}
		};

		const changed = (path: string): void => {
			let isDirectory: boolean | undefined;
			try {
				isDirectory = lstatSync(join(cwd, path)).isDirectory();
			} catch {
				unwatch(path);
			}
			if (isDirectory) {
				if (!rules.isIgnored(`${path}/`)) watchTree(path);
				return;
			}
			if (!rules.hasIndexableExtension(path)) return;
			if (rules.isIgnored(path)) return;

			pending.add(path);
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				const files = [...pending];
				pending = new Set();
				onChanges(files);
			}, debounceMs);
		};

		watchTree("");

		return {
			close() {
				if (timer) clearTimeout(timer);
				for (const watcher of watchers.values()) watcher.close();
				watchers.clear();
			},
		};
	}
}
