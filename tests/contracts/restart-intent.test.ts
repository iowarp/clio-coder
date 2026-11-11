import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consumeRestartIntent, restartIntentPath, writeRestartIntent } from "../../src/core/restart-intent.js";
import { createInteractiveRestart, restartPreflight } from "../../src/interactive/interactive-restart.js";
import { makeScratchHome } from "../harness/scratch-env.js";

test("restart intent is preserved for the child of the process that wrote it (#420)", () => {
	const home = makeScratchHome("clio-coder-restart-intent-");
	try {
		writeRestartIntent(home.dir, "restart-session");
		const file = restartIntentPath(home.dir);
		const original = readFileSync(file, "utf8");
		const now = Date.parse(JSON.parse(original).createdAt);
		const parentA = process.pid;
		const parentB = parentA + 1;

		assert.equal(consumeRestartIntent(home.dir, process.cwd(), now, parentB), undefined);
		assert.equal(readFileSync(file, "utf8"), original);
		assert.equal(consumeRestartIntent(home.dir, process.cwd(), now, parentA), "restart-session");
		assert.equal(existsSync(file), false);
	} finally {
		home.cleanup();
	}
});

test("restart preflight refuses a build with a missing file and leaves the session alone", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-restart-preflight-"));
	try {
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist/build.json"), JSON.stringify({ id: "x", files: ["gone.js"] }));
		assert.match(restartPreflight(root, undefined, true) ?? "", /incomplete \(dist\/gone\.js\)/u);
		assert.equal(restartPreflight(root, undefined, false), null);
		const notices: string[] = [];
		let saved = false;
		createInteractiveRestart({
			stateDir: root,
			busyReason: () => null,
			settle: async () => {
				saved = true;
			},
			armHandoff: () => {},
			shutdown: async () => {},
			notify: (_level, text) => notices.push(text),
			preflight: () => restartPreflight(root, undefined, true),
		})();
		assert.equal(saved, false);
		assert.match(notices[0] ?? "", /^Restart refused: the build on disk is incomplete/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
