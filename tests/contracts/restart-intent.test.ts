import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { consumeRestartIntent, restartIntentPath, writeRestartIntent } from "../../src/core/restart-intent.js";
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
