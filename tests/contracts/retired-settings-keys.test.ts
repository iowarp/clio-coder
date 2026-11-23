import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { formatSettingsIssues, readSettings, validateSettings, validateSettingsFile } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { SETTINGS_FIELD_NAMES } from "../../src/core/settings-fields.js";
import { readStrictLayeredSettings } from "../../src/core/settings-layers.js";
import { resolveClioDirs } from "../../src/core/xdg.js";
import { runDoctor } from "../../src/domains/lifecycle/doctor.js";
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
	strictEqual(settings.interface.exitSummary, "on");
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
		"interface.exitSummary: full → on",
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
		context: { memory: { observations: { enabled: true } } },
	});
	deepStrictEqual(
		issues.map((issue) => `${issue.path}: ${issue.message}`),
		[
			"orchestrator: unknown key",
			"fleet.speculativeDispatch: unknown key",
			"context.memory.observations: unknown key",
			"interface.outputDetail: expected compact, standard, or detailed",
			"interface.exitSummary: expected on or off",
		],
	);
});

test("a settings failure names the migration command only for a key or value its pending migration rewrites", async (t) => {
	const home = await isolateClioEnv("clio-retired-settings-advice-");
	t.after(() => home.restore());
	const config = join(home.dir, "config");
	mkdirSync(config, { recursive: true });
	writeFileSync(join(config, "settings.yaml"), "version: 2\nfleet:\n  speculativeDispatch: true\n");
	const manifest = join(config, "migrations.json");
	const advice = /clio-coder upgrade.*2026-11-21-retired-settings.*rewrites retired keys/u;
	const surfaces = (): string[] => {
		const thrown = (read: () => unknown): string => {
			try {
				read();
			} catch (error) {
				return String(error instanceof Error ? error.message : error).replace(/\n/gu, " ");
			}
			return "";
		};
		// The layered reader is what `run`, `config get` and the config domain load through (M-38).
		return [
			thrown(readSettings),
			thrown(() => readStrictLayeredSettings(home.dir)),
			formatSettingsIssues(validateSettingsFile().issues),
		];
	};
	// A provisioned file with no manifest, then a manifest written before the migration existed.
	for (const recorded of [null, REGISTERED_MIGRATION_IDS.filter((id) => id !== "2026-11-21-retired-settings")]) {
		if (recorded !== null) writeFileSync(manifest, JSON.stringify({ applied: recorded }));
		for (const text of surfaces()) {
			ok(/fleet\.speculativeDispatch: unknown key/u.test(text), text);
			ok(advice.test(text), text);
		}
	}
	// The one-line form leads with the key and its cause and names the file once (M-30).
	const file = join(config, "settings.yaml");
	const line = formatSettingsIssues(validateSettingsFile().issues);
	ok(
		line.startsWith(
			"settings.yaml failed validation: fleet.speculativeDispatch: unknown key. Run `clio-coder upgrade --post-install`",
		),
		line,
	);
	strictEqual(line.split(file).length, 2, line);
	// A key no release ever read: the pending migration cannot fix it, so the upgrade is not advised.
	writeFileSync(file, "version: 2\nsafety:\n  bogusKey: 1\n");
	for (const text of surfaces()) {
		ok(/safety\.bogusKey: unknown key/u.test(text), text);
		ok(!/clio-coder upgrade/u.test(text), text);
	}
	strictEqual(
		formatSettingsIssues(validateSettingsFile().issues),
		`settings.yaml failed validation: safety.bogusKey: unknown key. Edit the named keys in ${file}. Run \`clio-coder doctor --fix\` for safe repairs.`,
	);
	writeFileSync(file, "version: 2\nfleet:\n  speculativeDispatch: true\n");
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

// `clio-coder upgrade` refuses a package-manager install and installs a newer release first elsewhere;
// only `upgrade --post-install` applies pending migrations with the active binary on every install (M-34).
test("every doctor row that advises a pending migration names the same command", async (t) => {
	const home = await isolateClioEnv("clio-migration-remedy-");
	t.after(() => home.restore());
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(join(home.dir, "config", "settings.yaml"), "version: 2\nfleet:\n  speculativeDispatch: true\n");
	const report = runDoctor();
	const rows = ["settings.yaml", "lifecycle migrations"].map((name) => report.find((row) => row.name === name));
	for (const row of rows) {
		ok(/2026-11-21-retired-settings/u.test(row?.detail ?? ""), JSON.stringify(row));
		deepStrictEqual(
			row?.detail.match(/`clio-coder upgrade[^`]*`/gu),
			["`clio-coder upgrade --post-install`"],
			row?.detail,
		);
	}
});

// Old shapes are not migrated: `doctor` names what this build cannot read and `doctor --fix` removes it.
test("doctor --fix removes a retired settings key, an older memory store's unreadable records and retired state", async (t) => {
	const home = await isolateClioEnv("clio-retired-state-fix-");
	t.after(() => home.restore());
	const dirs = resolveClioDirs();
	mkdirSync(dirs.config, { recursive: true });
	const settings = join(dirs.config, "settings.yaml");
	writeFileSync(settings, "version: 2\ncontext:\n  memory:\n    observations:\n      enabled: true\n");
	const store = join(dirs.data, "memory", "records.json");
	mkdirSync(dirname(store), { recursive: true });
	const base = {
		scope: "repo",
		evidenceRefs: ["run:synthetic"],
		appliesWhen: ["installing dependencies"],
		avoidWhen: ["offline"],
		confidence: 0.8,
		createdAt: "2026-09-21T00:00:00.000Z",
		repository: { kind: "canonical-path", key: "/work/demo" },
	};
	writeFileSync(
		store,
		JSON.stringify({
			version: 1,
			records: [
				{ ...base, id: "mem-00000000000000c1", key: "kept", lesson: "Kept lesson.", approved: false },
				{ ...base, id: "mem-old-1", key: "old", lesson: "Old lesson.", approved: false },
			],
		}),
	);
	const invalidAside = join(dirs.data, "memory", "records.invalid.json");
	writeFileSync(invalidAside, "[]\n");
	const conversions = join(dirs.state, "workspace-conversions.json");
	mkdirSync(dirs.state, { recursive: true });
	writeFileSync(conversions, JSON.stringify({ version: 1, workspaces: {} }));

	const report = runDoctor();
	strictEqual(report.find((row) => row.name === "settings.yaml retired keys")?.ok, false);
	ok(
		/would rewrite .*version 1.* keeping 1 records and dropping 1/u.test(
			report.find((row) => row.name === "memory store")?.detail ?? "",
		),
	);
	ok(existsSync(conversions) && existsSync(invalidAside), "a report writes nothing");

	const fixed = runDoctor({ fix: true });
	ok(
		/removed context\.memory\.observations/u.test(
			fixed.find((row) => row.name === "settings.yaml retired keys")?.detail ?? "",
		),
	);
	deepStrictEqual(validateSettingsFile().issues, []);
	const rewritten = JSON.parse(readFileSync(store, "utf8")) as { version: number; records: { id: string }[] };
	deepStrictEqual([rewritten.version, rewritten.records.map((record) => record.id)], [2, ["mem-00000000000000c1"]]);
	ok(!existsSync(invalidAside) && !existsSync(conversions));
	const again = runDoctor();
	ok(!again.some((row) => ["settings.yaml retired keys", "memory store", "retired state"].includes(row.name)));
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
	const schemaSources = ["src/core/config.ts", "src/domains/lifecycle/migrations/2026-11-21-retired-settings.ts"].map(
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
