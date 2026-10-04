import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings } from "../../src/core/config.js";
import { runDoctorModelChecks } from "../../src/domains/lifecycle/doctor.js";
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
