import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Accepted, Operation } from "../contracts/operations.js";
import { Workspace } from "../contracts/sessions.js";
import { SettingsReport } from "../contracts/settings.js";
import { CliTargets, Routing } from "../contracts/targets-cli.js";
import { harness, json } from "./harness/app.js";
import { seedSettings } from "./harness/settings-fixture.js";

async function finished(h: Awaited<ReturnType<typeof harness>>, id: string) {
	const deadline = performance.now() + 30_000;
	while (performance.now() < deadline) {
		const op = await json(await h.request(`/api/operations/${id}`), Operation);
		if (op.status !== "queued" && op.status !== "running") return op;
		await setTimeout(30);
	}
	throw new Error("CLI operation did not finish within 30 seconds");
}

test("targets HTTP: real CLI use/remove, typed follow-up reads, redaction and offline routing parity", async () => {
	const h = await harness({}, { scenario: "markdown", env: { CLIO_CODER_WEB_FIXTURE_ROUTE: "1" } });
	try {
		await seedSettings(h.home.path, h.home.env);
		const configFile = join(h.home.path, "config/settings.yaml");
		const config = JSON.parse(await readFile(configFile, "utf8"));
		config.chat = { target: null, model: null };
		config.fleet = {
			profiles: { local: { target: "fixture-target", model: null, thinkingLevel: "high" } },
			agentProfiles: { coder: "local" },
		};
		await writeFile(configFile, JSON.stringify(config));
		const cwd = join(h.home.path, "isolated-workspace");
		await mkdir(cwd);
		const workspace = await json(await h.post("/api/workspaces", { path: cwd }), Workspace);
		const path = `/api/workspaces/${workspace.id}`;
		const listed = await json(await h.request(`${path}/targets`), CliTargets);
		assert.deepEqual(
			listed.targets.map((target) => target.id),
			["fixture", "field-station"],
		);
		assert.equal(listed.targets[0]?.runtime, "openai-compatible");
		assert.equal(listed.targets[0]?.health, "unknown");
		assert.equal(listed.targets[0]?.url, null);
		assert.equal(listed.targets[0]?.defaultModel, null);
		assert.equal(listed.targets[0]?.contextWindow, null);
		assert.doesNotMatch(JSON.stringify(listed), /fixture-header-secret|must-be-stripped|apiKey/);
		const routing = await json(await h.request(`${path}/routing`), Routing);
		const cliProfiles = await h.cli.run({ kind: "routing.profiles" }, cwd);
		assert.deepEqual(routing.profiles, cliProfiles);
		assert.deepEqual(routing.bindings, [
			{ agentId: "coder", profile: "local", target: "fixture-target", model: null, resolved: true },
		]);
		const cliModels = await h.cli.run({ kind: "routing.models" }, cwd);
		assert.ok(Array.isArray(cliModels));
		assert.equal(routing.models.length, cliModels.length);
		assert.ok(routing.models.every((model) => model.target === "fixture-target"));
		for (const action of ["use", "remove"] as const) {
			const key = crypto.randomUUID();
			const admitted = await h.post(`${path}/targets/fixture-target/${action}`, {}, key);
			assert.equal(admitted.status, 202);
			const accepted = await json(admitted, Accepted);
			assert.deepEqual(await json(await h.post(`${path}/targets/fixture-target/${action}`, {}, key), Accepted), accepted);
			const op = await finished(h, accepted.operationId);
			assert.equal(op.status, "succeeded", JSON.stringify(op));
			assert.ok(op.status === "succeeded" && "kind" in op.result && op.result.kind === "targets");
			assert.equal(op.result.exitCode, 0);
			assert.equal(op.cancellable, false);
			assert.deepEqual(op.result.targets, listed);
			const settings = await json(await h.request(`${path}/settings`), SettingsReport);
			assert.equal(
				settings.rows.find((row) => row.key === "chat.target")?.value,
				action === "use" ? "fixture-target" : null,
			);
			assert.equal(
				settings.rows.find((row) => row.key === "fleet.default.target")?.value,
				action === "use" ? "fixture-target" : null,
			);
			if (action === "use") assert.deepEqual(op.result.settings, settings);
		}
		assert.equal((await h.request(`/api/workspaces/unknown/targets`)).status, 404);
		assert.equal((await h.post(`${path}/targets/--help/use`)).status, 422);
	} finally {
		await h.close();
	}
});

test("targets HTTP: ACP probe reaps its child and failed administrative CLI exits expose only sanitized problems", async () => {
	for (const scenario of ["probe", "fail"]) {
		const h = await harness(
			{},
			{
				scenario: "markdown",
				env: {
					CLIO_CODER_WEB_FIXTURE_ROUTE: "1",
					CLIO_CODER_WEB_CLI: fileURLToPath(new URL("./fixtures/cli-command-child.mjs", import.meta.url)),
					CLIO_CODER_WEB_COMMAND_SCENARIO: scenario,
				},
			},
		);
		try {
			// The fixture's command log is relative to its canonical workspace.
			await writeFile(join(h.home.path, "record-commands"), "");
			const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), Workspace);
			const accepted = await json(
				await h.post(`/api/workspaces/${workspace.id}/targets/local/${scenario === "probe" ? "probe" : "remove"}`),
				Accepted,
			);
			if (scenario === "probe") {
				const op = await finished(h, accepted.operationId);
				assert.equal(op.status, "succeeded", JSON.stringify(op));
				assert.ok(op.status === "succeeded" && "kind" in op.result && op.result.kind === "targets");
				assert.equal(op.cancellable, true);
				assert.match(op.result.message, /reachable.*5 ms/);
				const frames = (await readFile(join(h.home.path, "acp.jsonl"), "utf8"))
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
				assert.ok(frames.some((frame) => frame.method === "_clio-coder/targets/probe"));
				assert.ok(frames.some((frame) => frame.method === "_clio-coder/targets/list"));
				assert.ok(!frames.some((frame) => frame.method === "session/new"));
				assert.deepEqual(await h.supervisor.children.rows(), []);
			} else {
				const op = await finished(h, accepted.operationId);
				assert.ok(op.status === "failed");
				assert.equal(op.problem.code, "operation_failed");
				assert.match(op.problem.detail, /exit code 7/);
				assert.ok(!JSON.stringify(op).includes("fixture-private-stderr-content"));
			}
		} finally {
			await h.close();
		}
	}
});
