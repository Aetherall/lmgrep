import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("init --preview prints configuration without creating it", () => {
	const home = mkdtempSync(join(tmpdir(), "lmgrep-preview-"));
	const configHome = join(home, "config");
	const configPath = join(configHome, "lmgrep", "config.yml");

	try {
		const result = spawnSync(
			process.execPath,
			["dist/cli.js", "init", "--preview"],
			{
				cwd: process.cwd(),
				env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
				encoding: "utf8",
				timeout: 15_000,
			},
		);

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /# lmgrep — this machine's inference setup\./);
		assert.equal(existsSync(configPath), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
