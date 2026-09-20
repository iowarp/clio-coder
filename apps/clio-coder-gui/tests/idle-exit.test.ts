import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { IdleExit } from "../server/services/idle-exit.js";
import { harness } from "./harness/app.js";
import { serverProcess } from "./harness/server.js";

test("two live clients hold the server; last disconnect exits after 2000 ms and logs no token", {
	timeout: 15000,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "clio-web-idle-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const token = "fixture-token-with-more-than-thirty-two-characters",
		log = join(dir, "web.log");
	const s = await serverProcess(t, ["--idle-exit", "2000", "--token", token, "--log-file", log]);
	const disconnect = await s.connect(),
		second = await s.connect();
	assert.equal((await s.json("/api/meta")).status, 200);
	disconnect();
	await setTimeout(2300);
	assert.equal(s.child.exitCode, null);
	const started = performance.now();
	second();
	assert.equal(await s.exited, 0);
	const elapsed = performance.now() - started;
	assert.ok(elapsed >= 1900 && elapsed < 4500, `Idle exit took ${elapsed} ms`);
	const text = await readFile(log, "utf8");
	assert.match(text, /Listening/);
	assert.match(text, /Stopped/);
	assert.ok(!text.includes(token));
	assert.equal((await stat(log)).mode & 0o777, 0o600);
});

test("a disconnected live ACP turn holds exit; cancellation settles the turn and reaps the idle child", {
	timeout: 16000,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "clio-web-idle-turn-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const s = await serverProcess(t, ["--idle-exit", "2000"], {
		CLIO_CODER_WEB_CLI: fileURLToPath(new URL("./fixtures/acp-fixture-child.mjs", import.meta.url)),
		CLIO_CODER_WEB_FIXTURE_SCENARIO: "slow",
	});
	const disconnect = await s.connect();
	const workspace = await s.json("/api/workspaces", { path: dir });
	assert.equal(workspace.status, 200);
	const session = await s.json(`/api/workspaces/${workspace.value.id}/sessions`, {});
	assert.equal(session.status, 200);
	const turn = await s.json(`/api/sessions/${session.value.id}/turns`, { text: "Hold until cancelled" });
	assert.equal(turn.status, 202);
	disconnect();
	await setTimeout(2500);
	assert.equal(s.child.exitCode, null);
	assert.equal((await s.json(`/api/sessions/${session.value.id}/turns/${turn.value.turnId}/cancel`, {})).status, 200);
	const started = performance.now();
	assert.equal(await s.exited, 0);
	assert.ok(performance.now() - started >= 1900);
});

test("an operation retains idle lifetime after its HTTP request, then releases it", { timeout: 10000 }, async (t) => {
	const h = await harness({ installDelayMs: 900 });
	t.after(h.close);
	let exits = 0;
	const idle = new IdleExit(
		200,
		() => !!(h.operations.activeCount || h.ops.pendingCount),
		() => {
			exits++;
		},
	);
	t.after(() => idle.stop());
	const release = idle.hold();
	assert.equal((await h.post("/api/toolchain/tools/herdr/install")).status, 202);
	release();
	await setTimeout(400);
	assert.equal(exits, 0);
	for (let i = 0; i < 100 && exits === 0; i++) await setTimeout(50);
	assert.equal(exits, 1);
});
