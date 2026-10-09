import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PidFileLock } from "../dist/infrastructure/fs/PidFileLock.js";

const CONTENDERS = 16;
const ROUNDS = 5;

// Each contender spins until a shared start time, then tries once and stays
// alive briefly so its lock is still live while the others check it.
const CONTENDER = `
const { PidFileLock } = await import(${JSON.stringify(new URL("../dist/infrastructure/fs/PidFileLock.js", import.meta.url).href)});
const [path, startAt] = process.argv.slice(1);
while (Date.now() < Number(startAt)) {}
const won = new PidFileLock(path).tryAcquire();
process.stdout.write(won ? "won" : "lost");
setTimeout(() => {}, 300);
`;

function contend(path) {
	const startAt = Date.now() + 400;
	return Promise.all(
		Array.from(
			{ length: CONTENDERS },
			() =>
				new Promise((resolve, reject) => {
					const child = spawn(
						process.execPath,
						["--input-type=module", "-e", CONTENDER, path, String(startAt)],
						{ stdio: ["ignore", "pipe", "inherit"] },
					);
					let out = "";
					child.stdout.on("data", (chunk) => {
						out += chunk;
					});
					child.on("error", reject);
					child.on("exit", () => resolve(out));
				}),
		),
	);
}

function directory(t) {
	const dir = mkdtempSync(join(tmpdir(), "lmgrep-lock-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("exactly one of many simultaneous contenders acquires a free lock", async (t) => {
	const dir = directory(t);
	for (let round = 0; round < ROUNDS; round++) {
		const path = join(dir, `free-${round}.lock`);
		const results = await contend(path);
		assert.equal(
			results.filter((r) => r === "won").length,
			1,
			`round ${round}`,
		);
	}
});

test("exactly one contender takes over a dead owner's lock", async (t) => {
	const dir = directory(t);
	for (let round = 0; round < ROUNDS; round++) {
		const path = join(dir, `stale-${round}.lock`);
		// A pid far above any default pid_max, so it is never alive.
		writeFileSync(path, `${JSON.stringify({ pid: 2 ** 30 })}\n`);
		const results = await contend(path);
		assert.equal(
			results.filter((r) => r === "won").length,
			1,
			`round ${round}`,
		);
	}
	assert.deepEqual(
		readdirSync(dir).filter((name) => !name.endsWith(".lock")),
		[],
		"drafts and set-aside locks are cleaned up",
	);
});

test("a live owner's lock is never taken over", async (t) => {
	const path = join(directory(t), "held.lock");
	const lock = new PidFileLock(path);
	assert.equal(lock.tryAcquire(), true);
	const results = await contend(path);
	assert.equal(results.filter((r) => r === "won").length, 0);
	assert.equal(lock.read()?.pid, process.pid);
});
