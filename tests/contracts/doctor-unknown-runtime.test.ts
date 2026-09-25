import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
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
