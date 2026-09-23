import { deepStrictEqual, match, strictEqual, throws } from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { runTargetsCommand } from "../../src/cli/targets.js";
import { TargetUseRefusal, useTargetInSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
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
