import { match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readSettings, SettingsValidationError } from "../../src/core/config.js";
import { migrateSettingsV1Document } from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Three validated keys that nothing read: a delegated agent's permission ask is
// decided at once, entry labels were never displayed, and dispatch never asks
// the routing decision site. A user file still naming one is refused with a
// message that says the key is retired, not that it is unknown.
test("user settings refuse the three retired keys with a targeted removal message", async (t) => {
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
		{
			yaml:
				"version: 2\nfleet:\n  profiles:\n    system-one: { target: local, model: m }\n  decisionProfiles: { routing: system-one }\ntargets:\n  - { id: local, runtime: lmstudio }\n",
			path: "fleet.decisionProfiles.routing",
		},
	];
	for (const { yaml, path } of cases) {
		writeFileSync(file, yaml);
		throws(
			() => readSettings(),
			(error: unknown) => {
				ok(error instanceof SettingsValidationError, String(error));
				const hits = error.issues.filter((issue) => issue.path === path);
				strictEqual(hits.length, 1, `${path}: ${JSON.stringify(error.issues)}`);
				match(hits[0]?.message ?? "", /^retired without replacement: .+\. Remove this key$/u);
				return true;
			},
		);
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
