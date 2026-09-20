import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Workspace } from "../contracts/sessions.js";
import { ConfigGraph, SettingsReport } from "../contracts/settings.js";
import { harness, json } from "./harness/app.js";
import { seedSettings } from "./harness/settings-fixture.js";

test("settings: canonical layer origins, complete leaves, real credential store and environment redaction", async () => {
	const h = await harness({}, { env: { OPENAI_API_KEY: "fixture-process-environment-e3d26" } });
	try {
		const seeded = await seedSettings(h.home.path, h.home.env);
		const configFiles = [
			"config/settings.yaml",
			".clio-coder/settings.yaml",
			".clio-coder/settings.local.yaml",
			".clio-coder/hooks.yaml",
		];
		const originalFiles = await Promise.all(configFiles.map((path) => readFile(join(h.home.path, path), "utf8")));
		const credentialFile = join(h.home.path, "config/credentials.yaml");
		const before = await readFile(credentialFile, "utf8");
		assert.ok(before.includes("fixture-stored-credential-72bda09"));
		const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), Workspace);
		const response = await h.request(`/api/workspaces/${workspace.id}/settings`);
		assert.equal(response.status, 200);
		const report = await json(response, SettingsReport);
		const rows = new Map(report.rows.map((row) => [row.key, row]));
		assert.deepEqual(report.issues, []);
		assert.equal(rows.get("chat.thinkingLevel")?.source, "user");
		assert.equal(rows.get("chat.thinkingLevel")?.value, "high");
		assert.equal(rows.get("chat.model")?.source, "project.local");
		assert.equal(rows.get("chat.model")?.value, "fixture-local-model");
		assert.equal(rows.get("safety.autonomy")?.source, "project");
		assert.equal(rows.get("safety.autonomy")?.value, "suggest");
		assert.equal(rows.get("interface.smoothStreaming")?.source, "built-in");
		assert.equal(
			rows.get("chat.maxOutputTokens")?.source,
			"built-in",
			"A partial object layer does not set absent default leaves",
		);
		assert.equal(rows.get("targets.0.runtime")?.source, "user", "Array replacement attributes its contained leaves");
		assert.deepEqual(
			report.layers.map((layer) => layer.origin),
			["built-in", "user", "project", "project.local"],
		);
		// Every canonical leaf appears, or belongs to an explicitly redacted parent branch.
		for (const key of seeded.settingsKeys)
			assert.ok(rows.has(key) || report.rows.some((row) => row.redacted && key.startsWith(`${row.key}.`)), key);
		assert.ok(report.rows.some((row) => row.key.endsWith(".env") && row.redacted));
		const graphResponse = await h.request(`/api/workspaces/${workspace.id}/config-graph`);
		assert.equal(graphResponse.status, 200);
		const graph = await json(graphResponse, ConfigGraph);
		assert.deepEqual(graph.categories, seeded.categories);
		assert.ok(graph.entries.some((entry) => entry.category === "hook" && entry.id === "fixture-hook"));
		for (const secret of [
			"fixture-stored-credential-72bda09",
			"fixture-process-environment-e3d26",
			"fixture-private-command",
			"fixture-private-argument",
			"fixture-configured-environment-913ab",
			"fixture-header-secret",
			"fixture-hook-command",
			"fixture-hook-argument-private",
		])
			assert.ok(!JSON.stringify({ report, graph }).includes(secret), "Sensitive fixture content escaped");
		assert.equal(await readFile(credentialFile, "utf8"), before, "Inspection must not change credentials");
		assert.deepEqual(
			await Promise.all(configFiles.map((path) => readFile(join(h.home.path, path), "utf8"))),
			originalFiles,
			"Inspection must not change configuration or hooks",
		);
		for (const suffix of ["settings", "config-graph"])
			assert.equal((await h.post(`/api/workspaces/${workspace.id}/${suffix}`)).status, 405);
	} finally {
		await h.close();
	}
});

test("config graph: actual 15-second deadline leaves HTTP responsive and later worker reads usable", async () => {
	const h = await harness({ fixtureGraphDelayMs: 15_100 });
	try {
		const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), Workspace);
		const start = performance.now();
		const pending = h.request(`/api/workspaces/${workspace.id}/config-graph`);
		await setTimeout(300);
		assert.equal((await h.request("/api/meta")).status, 200);
		assert.ok(performance.now() - start < 1000, "HTTP should not block on the graph worker");
		const expired = await pending;
		assert.equal(expired.status, 503);
		assert.equal((await expired.json()).code, "unavailable");
		assert.ok(
			performance.now() - start >= 14_900,
			`The graph owns a 15-second deadline; observed ${performance.now() - start} ms`,
		);
		assert.equal((await h.request("/api/toolchain/tools")).status, 200, "A late graph result must not wedge later reads");
	} finally {
		await h.close();
	}
});
