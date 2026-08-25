import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Recursive on-disk size, for reporting what an index actually costs. */
export class DiskUsage {
	/** Bytes used by `path` and everything under it; 0 when unreadable. */
	static of(path: string): number {
		let total = 0;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(path, { withFileTypes: true });
		} catch {
			return 0;
		}
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				total += DiskUsage.of(child);
				continue;
			}
			try {
				total += statSync(child).size;
			} catch {
				// Vanished mid-walk; the number is a report, not an invariant.
			}
		}
		return total;
	}

	static format(bytes: number): string {
		const units = ["B", "KB", "MB", "GB", "TB"];
		let value = bytes;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit++;
		}
		return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
	}
}
