import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Accepted, Operation } from "../contracts/operations.js";
import { Workspace } from "../contracts/sessions.js";
import { SettingsReport } from "../contracts/settings.js";
import { CliTargets, Routing, TargetRuntimes } from "../contracts/targets-cli.js";
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
	const h = await harness();
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
			["fixture-target"],
		);
		assert.equal(listed.targets[0]?.runtime, "openai-compat");
		assert.ok(!JSON.stringify(listed).includes("fixture-header-secret"));
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
			assert.equal(op.result.targets.targets.length, action === "use" ? 1 : 0);
			const settings = await json(await h.request(`${path}/settings`), SettingsReport);
			assert.equal(
				settings.rows.find((row) => row.key === "chat.target")?.value,
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

test("targets HTTP: probe cancellation reaps its child and failed CLI exits expose only sanitized problems", async () => {
	for (const scenario of ["slow", "fail"]) {
		const h = await harness(
			{},
			{
				env: {
					CLIO_CODER_WEB_CLI: fileURLToPath(new URL("./fixtures/cli-command-child.mjs", import.meta.url)),
					CLIO_CODER_WEB_COMMAND_SCENARIO: scenario,
				},
			},
		);
		try {
			const log = join(h.home.path, "command.jsonl");
			// The fixture's command log is relative to its canonical workspace.
			await writeFile(join(h.home.path, "record-commands"), "");
			const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), Workspace);
			const accepted = await json(await h.post(`/api/workspaces/${workspace.id}/targets/local/probe`), Accepted);
			if (scenario === "slow") {
				let pid = 0;
				for (let i = 0; i < 200; i++) {
					const line = await readFile(log, "utf8").catch(() => "");
					if (line) {
						pid = JSON.parse(line.split("\n")[0] ?? "{}").pid;
						break;
					}
					await setTimeout(10);
				}
				assert.ok(pid);
				assert.equal((await h.post(`/api/operations/${accepted.operationId}/cancel`)).status, 200);
				assert.equal((await finished(h, accepted.operationId)).status, "cancelled");
				assert.match(await readFile(log, "utf8"), /SIGTERM/);
				assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
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

test("targets HTTP: a connection is created through the real CLI with no credential field, and a refusal says why", async () => {
	const h = await harness();
	try {
		await seedSettings(h.home.path, h.home.env);
		const cwd = join(h.home.path, "onboarding-workspace");
		await mkdir(cwd);
		const workspace = await json(await h.post("/api/workspaces", { path: cwd }), Workspace);
		const path = `/api/workspaces/${workspace.id}`;

		const { runtimes } = await json(await h.request("/api/target-runtimes"), TargetRuntimes);
		const compat = runtimes.find((runtime) => runtime.id === "openai-compat");
		assert.ok(compat?.supportsCustomUrl);
		assert.equal(compat.targetCount, 1, "the seeded target counts against its runtime");
		assert.ok(
			runtimes.some((runtime) => runtime.modelRequired),
			"a catalog runtime says it needs an explicit model",
		);
		assert.ok(!JSON.stringify(runtimes).includes("fixture-stored-credential"));

		const added = await json(
			await h.post(`${path}/targets`, {
				id: "onboarded",
				runtime: "openai-compat",
				url: "http://127.0.0.1:9",
				model: "fixture-onboarded-model",
			}),
			Accepted,
		);
		const done = await finished(h, added.operationId);
		assert.equal(done.status, "succeeded");
		const result =
			done.status === "succeeded" && "kind" in done.result && done.result.kind === "targets" ? done.result : null;
		assert.ok(result, "the operation settles as a targets result");
		assert.match(result.message, /^Connection saved\./);
		// The CLI could not reach port 9 and says so; the GUI passes that on instead of claiming a verified model.
		assert.match(result.message, /could not verify model/);
		const saved = result.targets.targets.find((target) => target.id === "onboarded");
		assert.equal(saved?.runtime, "openai-compat");
		assert.equal(saved?.defaultModel, "fixture-onboarded-model");

		const refused = await json(await h.post(`${path}/targets`, { id: "no-model", runtime: "anthropic" }), Accepted);
		const failure = await finished(h, refused.operationId);
		assert.equal(failure.status, "failed");
		assert.match(failure.status === "failed" ? failure.problem.detail : "", /--model is required for anthropic/);
		const listed = await json(await h.request(`${path}/targets`), CliTargets);
		assert.ok(!listed.targets.some((target) => target.id === "no-model"));

		for (const body of [
			{ id: "x", runtime: "openai-compat", apiKey: "sk-must-not-cross" },
			{ id: "x", runtime: "openai-compat", url: "file:///etc/passwd" },
			{ id: "x", runtime: "openai-compat", model: "--api-key" },
			{ id: "x", runtime: "openai-compat", apiKeyEnv: "BAD NAME" },
			{ id: "--force", runtime: "openai-compat" },
		])
			assert.equal((await h.post(`${path}/targets`, body)).status, 422, JSON.stringify(body));
	} finally {
		await h.close();
	}
});
