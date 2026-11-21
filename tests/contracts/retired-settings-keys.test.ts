import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formatSettingsIssues, readSettings, validateSettings, validateSettingsFile } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { SETTINGS_FIELD_NAMES } from "../../src/core/settings-fields.js";
import { runDoctor } from "../../src/domains/lifecycle/doctor.js";
import { migrateSettingsV1Document } from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import retiredSettings from "../../src/domains/lifecycle/migrations/2026-11-21-retired-settings.js";
import { REGISTERED_MIGRATION_IDS } from "../../src/domains/lifecycle/migrations/registry-ids.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// The reader used to ignore retired keys and read old spellings. `clio-coder upgrade`
// (and boot, after a background update) now rewrites the user file once, keeps the
// previous one beside it and reports every change, so nothing is tolerated at read time.
test("the retired-settings migration rewrites a home's settings, reports each change and keeps a backup", async (t) => {
	const home = await isolateClioEnv("clio-retired-settings-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const before = [
		"# Keep this comment",
		"version: 2",
		"turnControl:",
		"  workflows: [orientation, direction, ledger-facts, detached-collection]",
		"  orientation:",
		"    maxSplit: 2",
		"targets:",
		'  - { id: local, runtime: llamacpp, url: "http://127.0.0.1:1" }',
		"fleet:",
		"  decisionProfiles: {}",
		"  speculativeDispatch: true",
		"  nodes:",
		"    - { id: box, host: box, clioEntry: /opt/clio }",
		"systemOne:",
		"  use: [fast]",
		"  engines:",
		"    fast: { kind: llm, target: local, mode: logprobs }",
		"  sites: {}",
		"  cuts: {}",
		"  record: true",
		"context:",
		"  compaction:",
		"    excludeLastTurns: 3",
		"telemetry:",
		"  research:",
		"    systemOneDataset: true",
		"interface:",
		"  exitSummary: full # kept inline comment",
		"  outputDetail: verbose",
		"  panes:",
		"    enabled: true",
		"integrations:",
		"  externalAgents:",
		"    entries:",
		"      - id: peer",
		"        command: peer",
		"        permissionTimeoutMs: 5000",
		"        labels: { team: a }",
		"chat:",
		"  model: kept",
		"",
	].join("\n");
	writeFileSync(file, before);
	ok(validateSettingsFile().issues.length > 0, "the reader no longer tolerates the old file");

	const report = await retiredSettings.up(home.dir);

	strictEqual(readFileSync(`${file}.retired.bak`, "utf8"), before);
	const after = readFileSync(file, "utf8");
	ok(after.startsWith("# Keep this comment\n"), after);
	ok(after.includes("# kept inline comment"), after);
	deepStrictEqual(validateSettingsFile().issues, []);
	const settings = readSettings();
	deepStrictEqual(settings.turnControl.workflows, ["detached-collection"]);
	strictEqual(settings.interface.exitSummary, "standard");
	strictEqual(settings.interface.outputDetail, "detailed");
	strictEqual(settings.fleet.nodes[0]?.clioCoderEntry, "/opt/clio");
	strictEqual(settings.integrations.externalAgents.entries[0]?.command, "peer");
	ok(after.includes("chat:\n  model: kept\n"), after);
	ok(!("mode" in (settings.systemOne.engines.fast ?? {})));
	for (const gone of ["decisionProfiles", "speculativeDispatch", "sites:", "cuts:", "record:", "excludeLastTurns"])
		ok(!after.includes(gone), `${gone} remains:\n${after}`);
	// A section the migration emptied goes with its last key.
	ok(!after.includes("telemetry:") && !after.includes("panes:") && !after.includes("compaction:"), after);

	ok(report, "the migration reports");
	deepStrictEqual(report.attention, []);
	ok(report.changed[0]?.startsWith("What changed for you in settings.yaml"), report.changed[0]);
	for (const line of [
		"Removed turnControl.orientation:",
		"Removed orientation from turnControl.workflows",
		"Removed fleet.decisionProfiles:",
		"Removed systemOne.engines.fast.mode:",
		"Removed integrations.externalAgents.entries[0].labels:",
		"interface.exitSummary: full → standard",
		"interface.outputDetail: verbose → detailed",
		"Renamed fleet.nodes[0].clioEntry to fleet.nodes[0].clioCoderEntry",
	])
		ok(
			report.changed.some((entry) => entry.startsWith(line)),
			`${line} missing from:\n${report.changed.join("\n")}`,
		);

	// Run again on its own output: nothing left to change, nothing written.
	writeFileSync(`${file}.retired.bak`, "untouched");
	deepStrictEqual(await retiredSettings.up(home.dir), { changed: [], attention: [] });
	strictEqual(readFileSync(`${file}.retired.bak`, "utf8"), "untouched");
});

test("with the read path gone, a retired key is an ordinary unknown key and an old spelling is refused", () => {
	const { issues } = validateSettings({
		version: 2,
		orchestrator: { target: "x" },
		fleet: { speculativeDispatch: true },
		interface: { exitSummary: "full", outputDetail: "minimal" },
	});
	deepStrictEqual(
		issues.map((issue) => `${issue.path}: ${issue.message}`),
		[
			"orchestrator: unknown key",
			"fleet.speculativeDispatch: unknown key",
			"interface.outputDetail: expected compact, standard, or detailed",
			"interface.exitSummary: expected auto, brief, standard, report, or off",
		],
	);
});

test("a settings failure names `clio-coder upgrade` while a registered migration is pending, and only then", async (t) => {
	const home = await isolateClioEnv("clio-retired-settings-advice-");
	t.after(() => home.restore());
	const config = join(home.dir, "config");
	mkdirSync(config, { recursive: true });
	writeFileSync(join(config, "settings.yaml"), "version: 2\nfleet:\n  speculativeDispatch: true\n");
	const manifest = join(config, "migrations.json");
	const advice = /clio-coder upgrade.*2026-11-21-retired-settings.*rewrites retired keys/u;
	const surfaces = (): string[] => {
		let thrown = "";
		try {
			readSettings();
		} catch (error) {
			thrown = String(error instanceof Error ? error.message : error).replace(/\n/gu, " ");
		}
		return [thrown, formatSettingsIssues(validateSettingsFile().issues)];
	};
	// A provisioned file with no manifest, then a manifest written before the migration existed.
	for (const recorded of [null, REGISTERED_MIGRATION_IDS.filter((id) => id !== "2026-11-21-retired-settings")]) {
		if (recorded !== null) writeFileSync(manifest, JSON.stringify({ applied: recorded }));
		for (const text of surfaces()) {
			ok(/fleet\.speculativeDispatch: unknown key/u.test(text), text);
			ok(advice.test(text), text);
		}
	}
	// Everything recorded: the upgrade has nothing to apply, so it is not advised.
	writeFileSync(manifest, JSON.stringify({ applied: REGISTERED_MIGRATION_IDS }));
	for (const text of surfaces()) {
		ok(/fleet\.speculativeDispatch: unknown key/u.test(text), text);
		ok(!/clio-coder upgrade/u.test(text), text);
	}
});

// The installer accepts a candidate only when its own `doctor --json` settings.yaml row is ok,
// and `upgrade --post-install` runs the migrations only after that, so the row judges the file
// as the pending migrations would leave it. The reader itself still refuses the file as written.
test("the candidate check passes a home whose settings only the pending migration rewrites, and still refuses an unknown key", async (t) => {
	const home = await isolateClioEnv("clio-retired-settings-candidate-");
	t.after(() => home.restore());
	const config = join(home.dir, "config");
	mkdirSync(config, { recursive: true });
	const file = join(config, "settings.yaml");
	const recorded = REGISTERED_MIGRATION_IDS.filter((id) => id !== "2026-11-21-retired-settings");
	writeFileSync(join(config, "migrations.json"), JSON.stringify({ applied: recorded }));
	const row = () => runDoctor().find((finding) => finding.name === "settings.yaml");
	const retired = "version: 2\nturnControl:\n  workflows: [orientation, direction, ledger-facts, detached-collection]\n";
	writeFileSync(file, retired);
	ok(validateSettingsFile().issues.length > 0, "the reader still refuses the file as written");
	const passing = row();
	strictEqual(passing?.ok, true, JSON.stringify(passing));
	strictEqual(passing?.level, "warn");
	ok(/2026-11-21-retired-settings.*clio-coder upgrade/u.test(passing?.detail ?? ""), passing?.detail);
	strictEqual(readFileSync(file, "utf8"), retired, "the check writes nothing");
	writeFileSync(file, `${retired}mystery: true\n`);
	const refused = row();
	strictEqual(refused?.ok, false, JSON.stringify(refused));
	ok(/mystery: unknown key/u.test(refused?.detail ?? ""), refused?.detail);
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

test("a zero-byte settings file loads as defaults instead of failing every command", async (t) => {
	const home = await isolateClioEnv("clio-empty-settings-");
	t.after(() => home.restore());
	const path = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(path, "");
	const result = validateSettingsFile();
	deepStrictEqual(result.issues, []);
});
