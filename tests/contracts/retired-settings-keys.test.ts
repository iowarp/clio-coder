import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings, validateSettingsFile } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { SETTINGS_FIELD_NAMES } from "../../src/core/settings-fields.js";
import { repairSettingsCoercions } from "../../src/core/settings-repair.js";
import { migrateSettingsV1Document } from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Two validated keys that nothing read: a delegated agent's permission ask is
// decided at once, and entry labels were never displayed. A user file still
// naming one loads, the key is ignored, and validation lists it as retired so
// doctor can name it; it must never block loading or an upgrade. The v2
// spelling of the compaction turn mask retires the same way.
test("user settings load with retired v2 keys and list them as retired", async (t) => {
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
			yaml: "version: 2\ncontext:\n  compaction:\n    excludeLastTurns: 3\n",
			path: "context.compaction.excludeLastTurns",
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

// `init` wrote `systemOne: { engines: {}, sites: {}, cuts: {} }`, so every existing home names a key since retired.
test("an old engine mode is a tombstone: the engine still loads and every value reads as batch", async (t) => {
	const home = await isolateClioEnv("clio-retired-engine-mode-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	for (const mode of ["auto", "logprobs", "answer", "batch"]) {
		writeFileSync(
			file,
			`version: 2\ntargets:\n  - { id: local, runtime: llamacpp, url: "http://127.0.0.1:1" }\nsystemOne:\n  use: [fast, local]\n  engines:\n    fast: { kind: llm, target: local, mode: ${mode} }\n`,
		);
		const validation = validateSettingsFile();
		ok(validation.retired.some((entry) => entry.path === "systemOne.engines.fast.mode"));
		const { systemOne } = readSettings();
		ok(!("mode" in (systemOne.engines.fast ?? {})));
		strictEqual(String(systemOne.use), "fast,local");
	}
});

test("a retired systemOne key never blocks loading: an empty cuts is silent and the rest are listed", async (t) => {
	const home = await isolateClioEnv("clio-retired-system-one-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const cases: ReadonlyArray<{ line: string; retired: string | null }> = [
		{ line: "cuts: {}", retired: null },
		{ line: "cuts: { jev-1.14.0: { turn.direct: 0.5 } }", retired: "systemOne.cuts" },
		{ line: "record: true", retired: "systemOne.record" },
		{ line: "retentionDays: 30", retired: "systemOne.retentionDays" },
		{ line: "maxMiB: 100", retired: "systemOne.maxMiB" },
	];
	for (const { line, retired } of cases) {
		writeFileSync(file, `version: 2\nsystemOne:\n  engines: {}\n  sites: {}\n  ${line}\n`);
		readSettings();
		const validation = validateSettingsFile();
		strictEqual(validation.issues.length, 0, `${line}: ${JSON.stringify(validation.issues)}`);
		const listed = validation.retired.filter((entry) => entry.path.startsWith("systemOne.")).map((entry) => entry.path);
		strictEqual(JSON.stringify(listed), JSON.stringify(retired === null ? [] : [retired]), line);
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

test("doctor removes retired keys in flow and block settings without losing adjacent values", async (t) => {
	const home = await isolateClioEnv("clio-retired-repair-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	for (const entries of [
		"      - { id: peer, command: peer, permissionTimeoutMs: 5000, labels: { team: a } }\n",
		"      - id: peer\n        command: peer\n        permissionTimeoutMs: 5000\n        labels: { team: a }\n",
	]) {
		writeFileSync(file, "# Keep this comment\nversion: 2\nintegrations:\n  externalAgents:\n    entries:\n" + entries);
		const result = repairSettingsCoercions();
		strictEqual(result.removed?.length, 2);
		strictEqual(validateSettingsFile().retired.length, 0);
		strictEqual(readSettings().integrations.externalAgents.entries[0]?.command, "peer");
		ok(readFileSync(file, "utf8").startsWith("# Keep this comment\n"));
	}
});

test("doctor removes a section its last retired key emptied, so the repaired home still loads", async (t) => {
	const home = await isolateClioEnv("clio-retired-emptied-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		file,
		"# Keep this comment\nversion: 2\nturnControl:\n  orientation:\n    maxSplit: 2\nfleet:\n  speculativeDispatch: true\ntelemetry:\n  research:\n    systemOneDataset: true\nchat:\n  model: kept\n",
	);
	const result = repairSettingsCoercions();
	strictEqual(result.removed?.length, 3);
	strictEqual(readFileSync(file, "utf8"), "# Keep this comment\nversion: 2\nchat:\n  model: kept\n");
	const after = validateSettingsFile();
	strictEqual(after.issues.length, 0);
	strictEqual(after.retired.length, 0);
	ok(readSettings());
});

// A name in SETTINGS_FIELD_NAMES is shared verbatim by telemetry share, so a name no schema
// carries any more would let an operator's dictionary key of that spelling go out unanonymized.
test("every settings field name is still a key some settings schema reads", () => {
	const keys = new Set<string>();
	const walk = (value: unknown): void => {
		if (value === null || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			keys.add(key);
			walk(child);
		}
	};
	walk(DEFAULT_SETTINGS);
	const schemaSources = ["src/core/config.ts", "src/domains/lifecycle/migrations/2026-09-01-settings-v2.ts"].map(
		(path) => readFileSync(path, "utf8"),
	);
	const stale = SETTINGS_FIELD_NAMES.filter(
		(name) => !keys.has(name) && !schemaSources.some((source) => new RegExp(`["'.]${name}["'.\\[]`, "u").test(source)),
	);
	deepStrictEqual(stale, []);
});
