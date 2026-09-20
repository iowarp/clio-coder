import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { routes } from "../../contracts/routes.js";
import { AppFiles } from "../../server/state/files.js";
import { json } from "../harness/app.js";
import { processServer } from "../harness/process-server.js";
import { realAcpHome } from "../harness/real-acp.js";

test("real built CLI streams through HTTP; E3 records one, two, three ACP child boot times and RSS", {
	timeout: 120000,
}, async (t) => {
	const fixture = await realAcpHome(),
		server = await processServer(fixture.env);
	t.after(async () => {
		await server.close();
		await fixture.close();
	});
	const workspace = await json(
			await server.post("/api/workspaces", { path: fixture.home.path }),
			routes.openWorkspace.response,
		),
		files = new AppFiles(join(fixture.home.path, "state"));
	const measurements: { children: number; bootMs: number; childRssKiB: number[]; totalRssKiB: number }[] = [];
	const sessions: string[] = [];
	for (let count = 1; count <= 3; count++) {
		const started = performance.now(),
			response = await server.post(`/api/workspaces/${workspace.id}/sessions`);
		if (response.status !== 200) throw new Error(`Real ACP open failed: ${await response.text()}`);
		const session = await json(response, routes.newSession.response);
		sessions.push(session.id);
		const bootMs = performance.now() - started,
			rows = (await files.read("children")) as { pid: number }[];
		const childRssKiB = await Promise.all(
			rows.map(async (row) =>
				Number((await readFile(`/proc/${row.pid}/status`, "utf8")).match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0),
			),
		);
		measurements.push({
			children: count,
			bootMs: Math.round(bootMs),
			childRssKiB,
			totalRssKiB: childRssKiB.reduce((a, b) => a + b, 0),
		});
	}
	t.diagnostic(`E3 ${JSON.stringify(measurements)}`);
	const id = sessions[0];
	assert.ok(id);
	assert.equal(
		(await server.post(`/api/sessions/${id}/turns`, { text: "Say hello briefly without tools." })).status,
		202,
	);
	let snapshot = await json(await server.request(`/api/sessions/${id}`), routes.session.response);
	for (let i = 0; i < 300 && snapshot.turns.at(-1)?.status === "running"; i++) {
		await setTimeout(100);
		snapshot = await json(await server.request(`/api/sessions/${id}`), routes.session.response);
	}
	assert.equal(snapshot.turns.at(-1)?.status, "succeeded", JSON.stringify(snapshot.turns.at(-1)));
	assert.equal(
		snapshot.timeline
			.filter((item) => item.kind === "text")
			.map((item) => item.text)
			.join(""),
		"Hello from the real Clio CLI.",
	);
	assert.ok(snapshot.timeline.some((item) => item.provenance?.some((agent) => agent.role === "orchestrator")));
	assert.ok(fixture.provider.requests.length > 0);
	assert.deepEqual(Object.keys(snapshot.turns.at(-1)?.usage ?? {}).sort(), [
		"cacheRead",
		"cacheWrite",
		"input",
		"output",
		"reasoning",
	]);
	await server.post(`/api/sessions/${id}/close`);
	const history = await json(
		await server.request(`/api/workspaces/${workspace.id}/sessions`),
		routes.sessionHistory.response,
	);
	assert.ok(history.some((row) => row.id === id && row.endedAt !== null));
	const loaded = await server.post(`/api/sessions/${id}/load`, { workspaceId: workspace.id });
	assert.equal(loaded.status, 200, await loaded.clone().text());
	const replay = await json(loaded, routes.loadSession.response);
	assert.ok(replay.turns.some((turn) => turn.prompt.includes("Say hello briefly without tools.")));
	assert.ok(
		replay.timeline.some(
			(item) => item.origin === "replay" && item.kind === "text" && item.text.includes("Hello from the real Clio CLI."),
		),
	);
	const settings = await json(await server.request(`/api/sessions/${id}/settings`), routes.sessionSettings.response);
	assert.equal(settings.editable.length, 4);
	const updated = await server.request(`/api/sessions/${id}/settings`, "PATCH", { "chat.thinkingLevel": "off" });
	assert.equal(updated.status, 200, await updated.clone().text());
	const targets = await json(await server.request(`/api/sessions/${id}/targets`), routes.sessionTargets.response);
	assert.ok(targets.targets.length > 0);
	const target = targets.targets[0];
	assert.ok(target);
	const probe = await json(
		await server.post(`/api/sessions/${id}/targets/${target.id}/probe`),
		routes.probeSessionTarget.response,
	);
	assert.equal(probe.healthy, true);
	const autonomy = await json(
		await server.post(`/api/sessions/${id}/autonomy`, { level: "suggest" }),
		routes.setSessionAutonomy.response,
	);
	assert.equal(autonomy.level, "suggest");
	const renamed = await server.request(`/api/sessions/${id}`, "PATCH", { label: "S4 verified conversation" });
	assert.equal(renamed.status, 200, await renamed.clone().text());
	assert.equal(
		(await json(await server.request(`/api/sessions/${id}`), routes.session.response)).label,
		"S4 verified conversation",
	);
	assert.equal((await server.request(`/api/sessions/${id}`, "DELETE", {})).status, 409);
	await server.post(`/api/sessions/${id}/close`);
	const deleted = await server.request(`/api/sessions/${id}`, "DELETE", { workspaceId: workspace.id });
	assert.equal(deleted.status, 200, await deleted.clone().text());
	const remaining = await json(
		await server.request(`/api/workspaces/${workspace.id}/sessions`),
		routes.sessionHistory.response,
	);
	assert.ok(!remaining.some((row) => row.id === id));
	assert.equal(((await files.read("children")) as unknown[]).length, 2, "temporary control child is fully reaped");
});
