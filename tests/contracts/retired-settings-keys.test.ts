import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readSettings, validateSettingsFile } from "../../src/core/config.js";
import { migrateSettingsV1Document } from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Two validated keys that nothing read: a delegated agent's permission ask is
// decided at once, and entry labels were never displayed. A user file still
// naming one loads, the key is ignored, and validation lists it as retired so
// doctor can name it; it must never block loading or an upgrade.
test("user settings load with retired per-agent keys and list them as retired", async (t) => {
	const home = await isolateClioEnv("clio-retired-keys-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const cases = [
		{
			yaml:
				"version: 2\nintegrations:\n  externalAgents:\n    entries:\n      - { id: peer, command: peer, permissionTimeoutMs: 5000 }\n",
			path: "integrations.externalAgents.entries[0].permissionTimeoutMs",
		},
		{
			yaml:
				"version: 2\nintegrations:\n  externalAgents:\n    entries:\n      - { id: peer, command: peer, labels: { team: a } }\n",
			path: "integrations.externalAgents.entries[0].labels",
		},
	];
	for (const { yaml, path } of cases) {
		writeFileSync(file, yaml);
		readSettings();
		const validation = validateSettingsFile();
		strictEqual(validation.issues.length, 0, `${path}: ${JSON.stringify(validation.issues)}`);
		const hits = validation.retired.filter((entry) => entry.path === path);
		strictEqual(hits.length, 1, `${path}: ${JSON.stringify(validation.retired)}`);
		ok((hits[0]?.reason ?? "").length > 0);
	}
});

test("the v1 migration drops the retired per-agent keys and records why", () => {
	const result = migrateSettingsV1Document({
		version: 1,
		delegation: { agents: [{ id: "peer", command: "peer", permissionTimeoutMs: 5000, labels: { team: "a" } }] },
	});
	const entries = (result.document.integrations as { externalAgents: { entries: Array<Record<string, unknown>> } })
		.externalAgents.entries;
	strictEqual(Object.hasOwn(entries[0] ?? {}, "permissionTimeoutMs"), false);
	strictEqual(Object.hasOwn(entries[0] ?? {}, "labels"), false);
	ok(result.dropped.some((line) => line.startsWith("integrations.externalAgents.entries[0].permissionTimeoutMs:")));
	ok(result.dropped.some((line) => line.startsWith("integrations.externalAgents.entries[0].labels:")));
});
