import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { routes } from "../contracts/routes.js";
import { childRunning } from "../server/process-policy.js";
import { AppFiles } from "../server/state/files.js";
import { json } from "./harness/app.js";
import { processServer } from "./harness/process-server.js";
import { scratchHome } from "./harness/scratch-home.js";

async function until(check: () => Promise<boolean>) {
	for (let i = 0; i < 100; i++) {
		if (await check()) return;
		await setTimeout(50);
	}
	throw new Error("Process lifecycle did not settle.");
}
async function open(server: Awaited<ReturnType<typeof processServer>>, path: string) {
	const workspace = await json(await server.post("/api/workspaces", { path }), routes.openWorkspace.response);
	const response = await server.post(`/api/workspaces/${workspace.id}/sessions`);
	assert.equal(response.status, 200);
	return json(response, routes.newSession.response);
}

test("killed owner leaves its slow child alive; restart exposes unknown then closed and preserves session ledger bytes", {
	timeout: 30000,
}, async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const state = join(home.path, "state"),
		ledger = join(state, "sessions");
	await mkdir(ledger, { recursive: true });
	const sentinel = join(ledger, "sentinel.jsonl"),
		bytes = '{"type":"sentinel","unchanged":true}\n';
	await writeFile(sentinel, bytes);
	const first = await processServer({ ...home.env, CLIO_CODER_WEB_FIXTURE_SCENARIO: "slow" });
	t.after(() => first.close("SIGKILL"));
	const session = await open(first, home.path);
	await first.post(`/api/sessions/${session.id}/turns`, { text: "Wait" });
	const files = new AppFiles(state),
		rows = (await files.read("children")) as { pid: number }[];
	const pid = rows[0]?.pid;
	assert.ok(pid);
	await first.close("SIGKILL");
	assert.equal(await childRunning(pid), true);
	const second = await processServer(home.env);
	t.after(() => second.close());
	const recovering = await json(await second.request(`/api/sessions/${session.id}`), routes.session.response);
	assert.equal(recovering.state, "unknown");
	assert.equal(recovering.recoveredOrphan, true);
	await until(
		async () =>
			(await json(await second.request(`/api/sessions/${session.id}`), routes.session.response)).state === "closed",
	);
	assert.equal(await childRunning(pid), false);
	assert.deepEqual(await files.read("children"), []);
	assert.equal(await readFile(sentinel, "utf8"), bytes);
});

test("two live servers preserve each other's ownership and graceful shutdown removes only their own children", {
	timeout: 30000,
}, async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const first = await processServer(home.env);
	t.after(() => first.close());
	await open(first, home.path);
	const second = await processServer(home.env);
	t.after(() => second.close());
	await open(second, home.path);
	const files = new AppFiles(join(home.path, "state")),
		rows = (await files.read("children")) as { pid: number; ownerPid: number }[];
	assert.equal(rows.length, 2);
	for (const row of rows) assert.equal(await childRunning(row.pid), true);
	const third = await processServer(home.env);
	await third.close();
	for (const row of rows) assert.equal(await childRunning(row.pid), true);
	await first.close();
	const surviving = rows.find((row) => row.ownerPid === second.pid);
	assert.ok(surviving);
	assert.equal(await childRunning(surviving.pid), true);
	assert.equal(((await files.read("children")) as unknown[]).length, 1);
	await second.close();
	assert.deepEqual(await files.read("children"), []);
});

test("pid reuse drops the stale row without signalling an unrelated live process", { timeout: 20000 }, async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	t.after(() => {
		sleeper.kill("SIGKILL");
	});
	assert.ok(sleeper.pid);
	const files = new AppFiles(join(home.path, "state"));
	await files.update("children", () => ({
		value: [
			{
				ownerId: "dead-server",
				ownerPid: 999999999,
				ownerBirthToken: "old-owner",
				pid: sleeper.pid,
				birthToken: "different-birth-token",
				sessionId: "old-session",
				workspaceId: "old-workspace",
			},
		],
		result: undefined,
	}));
	const server = await processServer(home.env);
	t.after(() => server.close());
	await until(async () => ((await files.read("children")) as unknown[]).length === 0);
	assert.equal(await childRunning(sleeper.pid), true);
});
