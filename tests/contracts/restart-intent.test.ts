import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restartFallbackAdvice } from "../../src/core/restart-handoff.js";
import {
	consumeRestartContinuation,
	consumeRestartIntent,
	RESTART_CONTINUATION_MAX,
	restartIntentPath,
	writeRestartContinuation,
	writeRestartIntent,
} from "../../src/core/restart-intent.js";
import { firePendingModelRestart, nextModelRestartChain, setRestartHost } from "../../src/core/restart-request.js";
import { createInteractiveRestart, restartPreflight } from "../../src/interactive/interactive-restart.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";
import { createRestartSessionTool, restartSessionWorkspaceRefusal } from "../../src/tools/restart-session.js";
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

test("restart continuation reaches only the restarted session, once, capped", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-restart-continuation-"));
	try {
		writeRestartContinuation(root, "s1", `run the tests ${"x".repeat(3000)}`);
		assert.equal(consumeRestartContinuation(root, "other"), undefined);
		writeRestartContinuation(root, "s1", "run the tests");
		assert.equal(consumeRestartContinuation(root, "s1", Date.now() + 61_000), undefined);
		writeRestartContinuation(root, "s1", "x".repeat(3000));
		assert.equal(consumeRestartContinuation(root, "s1")?.length, RESTART_CONTINUATION_MAX);
		assert.equal(consumeRestartContinuation(root, "s1"), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/restart takes an optional task to continue with", () => {
	assert.deepEqual(parseSlashCommand("/restart"), { kind: "restart" });
	assert.deepEqual(parseSlashCommand("/restart  run the lane check "), {
		kind: "restart",
		continuation: "run the lane check",
	});
});

test("a restarted child that dies early without resuming gets the manual resume command", () => {
	const home = mkdtempSync(join(tmpdir(), "clio-restart-fallback-"));
	try {
		writeRestartIntent(home, "s1");
		assert.equal(restartFallbackAdvice(home, 0, 100), null);
		assert.equal(restartFallbackAdvice(home, 1, 20_000), null);
		assert.match(restartFallbackAdvice(home, 1, 100) ?? "", /code 1 .*\/resume s1/u);
		assert.equal(existsSync(restartIntentPath(home)), false);
		assert.equal(restartFallbackAdvice(home, 1, 100), null);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("restart_session: a card at default, refused at yolo and outside the running tree, fired once at turn end", async () => {
	const home = makeScratchHome("clio-coder-restart-session-");
	const fired: string[] = [];
	try {
		const repo = process.cwd();
		assert.equal(restartSessionWorkspaceRefusal(repo), null);
		assert.match(restartSessionWorkspaceRefusal(repo, home.dir) ?? "", /another build|does not run from/);
		assert.match(restartSessionWorkspaceRefusal(home.dir) ?? "", /not Clio Coder's source tree/);

		let autonomy: "default" | "yolo" = "default";
		const tool = createRestartSessionTool({ getCwd: () => repo, getAutonomy: () => autonomy });
		const args = { continuation: "check the footer", reason: "rebuilt" };
		const unhosted = await tool.run(args);
		assert.ok(unhosted.kind === "error" && /interactive terminal/.test(unhosted.message));
		setRestartHost((text) => fired.push(text));
		assert.match(tool.confirmationFor?.(args)?.detail ?? "", /continue: check the footer/);
		assert.equal((await tool.run(args)).kind, "ok");
		assert.equal(fired.length, 0, "never restarts mid-turn");
		assert.equal(firePendingModelRestart(), true);
		assert.equal(firePendingModelRestart(), false);
		assert.deepEqual(fired, ["check the footer"]);

		autonomy = "yolo";
		assert.equal(tool.confirmationFor?.(args), undefined);
		const refused = await tool.run(args);
		assert.ok(refused.kind === "error" && /type \/restart/.test(refused.message));

		autonomy = "default";
		writeRestartContinuation(home.dir, "s1", "again", 3);
		assert.equal(consumeRestartContinuation(home.dir, "s1"), "again");
		const looped = await tool.run(args);
		assert.ok(looped.kind === "error" && /3 restarts in a row/.test(looped.message));
		writeRestartContinuation(home.dir, "s1", "operator restart");
		consumeRestartContinuation(home.dir, "s1");
		assert.equal(nextModelRestartChain(), 1);
	} finally {
		setRestartHost(null);
		home.cleanup();
	}
});
