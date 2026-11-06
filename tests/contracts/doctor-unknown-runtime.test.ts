import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyDefaultTarget, describeVerdict } from "../../src/cli/default-target.js";
import { runClioRun } from "../../src/cli/run.js";
import { readSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { runDoctorModelChecks } from "../../src/domains/lifecycle/doctor.js";
import { createProvidersBundle } from "../../src/domains/providers/extension.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("doctor reports a target using a retired runtime and names its replacement", async (t) => {
	const home = await isolateClioEnv("clio-doctor-unknown-runtime-");
	t.after(() => home.restore());
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config", "settings.yaml"),
		"version: 2\ntargets:\n  - { id: blade, runtime: lmstudio-native, defaultModel: local-model }\n",
	);

	const findings = await runDoctorModelChecks();
	const target = findings.find((finding) => finding.name === "target blade");
	strictEqual(target?.ok, false);
	match(target?.detail ?? "", /runtime 'lmstudio-native'.*'lmstudio'/u);
});

test("startup names the replacement when the chat route sits on a retired runtime", async (t) => {
	const home = await isolateClioEnv("clio-retired-chat-runtime-");
	t.after(() => home.restore());
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config", "settings.yaml"),
		"version: 2\ntargets:\n  - { id: box, runtime: ollama-native, defaultModel: llama3 }\nchat:\n  target: box\n  model: llama3\n",
	);

	match(describeVerdict(classifyDefaultTarget(readSettings())), /'ollama-native'.*removed in 0\.7\.0.*runtime: ollama/u);
});

// `targets --json` serializes this reason, so it carries the same advice as the table.
test("a target on a retired runtime carries the replacement in its provider status reason", async (t) => {
	const home = await isolateClioEnv("clio-retired-runtime-status-");
	t.after(() => home.restore());
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "blade", runtime: "lmstudio-native", defaultModel: "local-model" }];
	const bundle = createProvidersBundle(dispatchStubContext({ settings }));
	await bundle.extension.start();
	t.after(() => bundle.extension.stop?.());
	const status = bundle.contract.list().find((entry) => entry.target.id === "blade");
	strictEqual(status?.available, false);
	match(status?.reason ?? "", /'lmstudio-native' was removed in 0\.7\.0.*runtime: lmstudio`/u);
});

test("run --agent with an API key names the replacement for a target on a retired runtime", async (t) => {
	const home = await isolateClioEnv("clio-retired-runtime-run-");
	const original = process.cwd();
	const cwd = join(home.dir, "workspace");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(
		join(home.dir, "config", "settings.yaml"),
		"version: 2\ntargets:\n  - { id: box, runtime: ollama-native, defaultModel: llama3 }\n",
	);
	let stderr = "";
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	process.chdir(cwd);
	try {
		const run = (target: string) =>
			runClioRun(["--agent", "coder", "--read-only", "--target", target, "audit"], {
				apiKey: "fixture-key",
				noContextFiles: true,
			});
		strictEqual(await run("box"), 1);
		match(stderr, /cannot use target 'box': runtime 'ollama-native' was removed in 0\.7\.0.*runtime: ollama`/u);
		stderr = "";
		strictEqual(await run("nosuch"), 2);
		match(stderr, /target 'nosuch' not found/u);
	} finally {
		process.chdir(original);
		home.restore();
	}
});

test("doctor proposes the provider catalog model and changes it only after confirmation", async (t) => {
	const home = await isolateClioEnv("clio-doctor-model-repair-");
	t.after(() => home.restore());
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const file = join(home.dir, "config", "settings.yaml");
	const original =
		"version: 2\ntargets:\n  - { id: anthropic, runtime: anthropic }\ncontext:\n  memory:\n    target: anthropic\n    model: claude-haiku-4.5 # keep the note\n";
	writeFileSync(file, original);
	const before = await runDoctorModelChecks({ fix: true, confirm: async () => false });
	match(
		before.find((row) => row.name === "model anthropic")?.detail ?? "",
		/Proposed memory.model: 'claude-haiku-4.5' -> 'claude-haiku-4-5'/,
	);
	strictEqual(readFileSync(file, "utf8"), original);
	let asked = 0;
	const after = await runDoctorModelChecks({
		fix: true,
		confirm: async () => {
			asked++;
			return true;
		},
	});
	strictEqual(asked, 1);
	strictEqual(readSettings().context.memory.model, "claude-haiku-4-5");
	match(readFileSync(file, "utf8"), /# keep the note/);
	strictEqual(after.find((row) => row.name === "model anthropic")?.level, undefined);
});
