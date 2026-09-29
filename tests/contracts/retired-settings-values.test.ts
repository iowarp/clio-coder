import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readSettings, SettingsValidationError, validateSettingsFile } from "../../src/core/config.js";
import { runDoctor } from "../../src/domains/lifecycle/doctor.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// 0.5.6 retired four autonomy spellings and the `clio` product names without a
// migration, so the refusal is the only place the operator learns what to type
// instead. Listing the allowed values is not enough: the message must name the
// replacement for the exact value the file carries.
test("a retired enum value is refused with its replacement named", async (t) => {
	const home = await isolateClioEnv("clio-retired-values-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const cases = [
		{ yaml: "version: 2\nsafety:\n  autonomy: auto-edit\n", path: "safety.autonomy", replacement: "default" },
		{ yaml: "version: 2\nsafety:\n  autonomy: suggest\n", path: "safety.autonomy", replacement: "default" },
		{ yaml: "version: 2\nsafety:\n  autonomy: read-only\n", path: "safety.autonomy", replacement: "default" },
		{ yaml: "version: 2\nsafety:\n  autonomy: full-auto\n", path: "safety.autonomy", replacement: "yolo" },
		{
			yaml: "version: 2\ntargets:\n  - { id: local, runtime: lmstudio, lifecycle: clio-managed }\n",
			path: "targets[0].lifecycle",
			replacement: "clio-coder-managed",
		},
		{
			yaml:
				"version: 2\nintegrations:\n  externalAgents:\n    entries:\n      - { id: peer, command: peer, toolGovernance: clio-policy }\n",
			path: "integrations.externalAgents.entries[0].toolGovernance",
			replacement: "clio-coder-policy",
		},
	];
	for (const { yaml, path, replacement } of cases) {
		writeFileSync(file, yaml);
		throws(
			() => readSettings(),
			(error: unknown) => {
				ok(error instanceof SettingsValidationError, String(error));
				const hits = error.issues.filter((issue) => issue.path === path);
				strictEqual(hits.length, 1, `${path}: ${JSON.stringify(error.issues)}`);
				const message = hits[0]?.message ?? "";
				match(message, /^expected one of /u);
				match(message, new RegExp(`retired value .+ becomes "${replacement}"`, "u"));
				return true;
			},
		);
	}
});

// A value that was never a Clio spelling gets the plain enum refusal, so the
// replacement advice stays a claim about the rename and not a guess. The
// prototype keys are in the list because a lookup that reaches
// Object.prototype answers every value and advises nonsense.
test("an unrecognized enum value carries no replacement advice", async (t) => {
	const home = await isolateClioEnv("clio-unknown-value-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	for (const value of ["banana", "toString", "constructor", "hasOwnProperty", "__proto__"]) {
		writeFileSync(file, `version: 2\nsafety:\n  autonomy: "${value}"\n`);
		throws(
			() => readSettings(),
			(error: unknown) => {
				ok(error instanceof SettingsValidationError, String(error));
				const hits = error.issues.filter((issue) => issue.path === "safety.autonomy");
				strictEqual(hits.length, 1, `${value}: ${JSON.stringify(error.issues)}`);
				strictEqual(hits[0]?.message, `expected one of default | yolo, got ${JSON.stringify(value)}`);
				return true;
			},
		);
	}
});

// PyYAML writes a bare `off` or `on` as a boolean and hand edits say `false`.
// Loading coerces those to the level the field allows, but a boolean for a
// field with no such level is still a wrong value and keeps the plain refusal.
test("a YAML 1.1 boolean loads as the on/off level its field allows and is refused where none exists", async (t) => {
	const home = await isolateClioEnv("clio-yaml-boolean-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const yaml =
		"version: 2\nchat:\n  thinkingLevel: false\ninterface:\n  smoothStreaming: true\n  panes: { layout: false }\n";
	writeFileSync(file, yaml);
	const settings = readSettings();
	strictEqual(settings.chat.thinkingLevel, "off");
	strictEqual(settings.interface.smoothStreaming, "on");
	strictEqual(settings.interface.panes.layout, "off");
	deepStrictEqual(
		validateSettingsFile()
			.coercions.map((entry) => `${entry.path}=${entry.from}->${entry.to}`)
			.sort(),
		["chat.thinkingLevel=false->off", "interface.panes.layout=false->off", "interface.smoothStreaming=true->on"],
	);
	strictEqual(readFileSync(file, "utf8"), yaml, "loading never writes the file");

	writeFileSync(file, "version: 2\nchat:\n  thinkingLevel: true\n");
	throws(
		() => readSettings(),
		(error: unknown) => {
			ok(error instanceof SettingsValidationError, String(error));
			const hits = error.issues.filter((issue) => issue.path === "chat.thinkingLevel");
			strictEqual(hits.length, 1, JSON.stringify(error.issues));
			match(hits[0]?.message ?? "", /^expected one of off \| .*, got true$/u);
			return true;
		},
	);
});

test("doctor warns about coerced booleans and --fix rewrites only those values", async (t) => {
	const home = await isolateClioEnv("clio-yaml-boolean-fix-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const before = [
		"# my settings",
		"version: 2",
		"chat:",
		"  thinkingLevel: false # keep it quick",
		"",
		"interface:",
		"  smoothStreaming: true",
		"  panes: { layout: false }",
		"",
	].join("\n");
	writeFileSync(file, before);

	const warned = runDoctor().find((row) => row.name === "settings.yaml booleans");
	strictEqual(warned?.level, "warn");
	match(warned?.detail ?? "", /chat\.thinkingLevel: false.*interface\.smoothStreaming: true.*doctor --fix/u);
	strictEqual(readFileSync(file, "utf8"), before, "doctor without --fix is read-only");

	const rows = runDoctor({ fix: true });
	strictEqual(
		readFileSync(file, "utf8"),
		before
			.replace("thinkingLevel: false", 'thinkingLevel: "off"')
			.replace("smoothStreaming: true", 'smoothStreaming: "on"')
			.replace("layout: false", 'layout: "off"'),
	);
	ok(rows.some((row) => row.name === "settings.yaml repair"));
	strictEqual(
		rows.some((row) => row.name === "settings.yaml booleans"),
		false,
	);
	deepStrictEqual(validateSettingsFile().coercions, []);
});
