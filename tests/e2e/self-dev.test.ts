import { ok } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { spawnClioPty } from "../harness/pty.js";
import { runCli } from "../harness/spawn.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

describe("CLIO_SELF_DEV end-to-end", () => {
	let home: string;

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "clio-selfdev-e2e-"));
		await runCli(["install"], { env: { CLIO_HOME: home } });
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("banner shows CLIO_SELF_DEV line and footer flips to restart-required on engine edit", async () => {
		const readToolPath = join(REPO_ROOT, "src", "tools", "read.ts");
		const original = readFileSync(readToolPath, "utf8");
		const pty = spawnClioPty({
			env: { CLIO_HOME: home, CLIO_SELF_DEV: "1" },
		});
		try {
			await pty.expect(/CLIO_SELF_DEV=1/, 8000);
			await pty.expect(/clio\s+IOWarp/, 8000);
			// touch read.ts (safe: change only a comment)
			const patched = original.replace("export const readTool", "/* hot-reload smoke test */\nexport const readTool");
			writeFileSync(readToolPath, patched);
			await pty.expect(/read\.ts/, 5000);
			// Now trigger a restart prompt via an engine-boundary file.
			const sessionTouch = join(REPO_ROOT, "src", "engine", "types.ts");
			const engineOriginal = readFileSync(sessionTouch, "utf8");
			try {
				writeFileSync(sessionTouch, `${engineOriginal}\n// hot-reload smoke test\n`);
				await pty.expect(/restart required/, 5000);
			} finally {
				writeFileSync(sessionTouch, engineOriginal);
			}
			ok(true);
		} finally {
			pty.kill();
			writeFileSync(readToolPath, original);
		}
	});
});
