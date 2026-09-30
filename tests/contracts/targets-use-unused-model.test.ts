import { deepStrictEqual, match, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { runTargetsCommand } from "../../src/cli/targets.js";
import { TargetUseRefusal, useTargetInSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
beforeEach(async () => {
	env = await isolateClioEnv("clio-targets-use-model-");
});
afterEach(() => env.restore());

function settings() {
	const value = structuredClone(DEFAULT_SETTINGS);
	value.targets = [
		{ id: "blade", runtime: "litellm", defaultModel: "dynamo/main" },
		{ id: "cloud", runtime: "openai-codex", defaultModel: "luna" },
	];
	value.chat.target = "blade";
	value.chat.model = "dynamo/main";
	value.fleet.default = { target: "blade", model: "dynamo/main", thinkingLevel: "low" };
	return value;
}

it("refuses --model when the fleet flags select fleet alone and name its model", () => {
	const value = settings();
	const before = structuredClone(value);
	throws(
		() => useTargetInSettings(value, "blade", { model: "dynamo/new", workerTargetId: "cloud", workerModel: "sol" }),
		TargetUseRefusal,
	);
	deepStrictEqual(value, before);
});

it("keeps the scoped call working once --model is moved to --orchestrator-model", () => {
	const value = settings();
	const before = structuredClone(value);
	useTargetInSettings(value, "blade", { orchestratorModel: "dynamo/new", workerTargetId: "cloud", workerModel: "sol" });
	deepStrictEqual(value.chat, { ...before.chat, model: "dynamo/new" });
	deepStrictEqual(value.fleet.default, { ...before.fleet.default, target: "cloud", model: "sol" });
});

it("exits 2 from the CLI, names the flag that sets chat, and writes nothing", async () => {
	const written: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	let code: number;
	try {
		code = await runTargetsCommand([
			"use",
			"blade",
			"--model",
			"dynamo/new",
			"--fleet-target",
			"cloud",
			"--fleet-model",
			"sol",
		]);
	} finally {
		process.stderr.write = original;
	}
	strictEqual(code, 2);
	const message = written.join("");
	match(message, /--model 'dynamo\/new' would not be used/u);
	match(message, /--orchestrator-model 'dynamo\/new'/u);
	match(message, /drop the role flags/u);
});

it("lists an agent binding kept only in trusted project-local settings", async () => {
	const workspace = join(env.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	writeFileSync(
		join(workspace, ".clio-coder", "settings.local.yaml"),
		"fleet:\n  profiles:\n    local-fast:\n      target: blade\n      model: dynamo/main\n      thinkingLevel: low\n  agentProfiles:\n    coder: local-fast\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	if (!snapshot.contentHash) throw new Error("missing project settings hash");
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const written: string[] = [];
	const cwd = process.cwd();
	const original = process.stdout.write.bind(process.stdout);
	let pending: Promise<number>;
	process.chdir(workspace);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		// The bindings listing writes synchronously, so stdout is restored before the await.
		pending = runTargetsCommand(["profile", "bindings", "--json"]);
	} finally {
		process.stdout.write = original;
		process.chdir(cwd);
	}
	strictEqual(await pending, 0);
	const rows = JSON.parse(written.join("")) as Array<{ agentId: string; profile: string; source: string }>;
	const coder = rows.find((row) => row.agentId === "coder");
	strictEqual(coder?.profile, "local-fast");
	strictEqual(coder?.source, "project.local");
});
