/**
 * The 0.4.1 migration that strips the retired `panes.agents` and
 * `panes.keepFailed` knobs.
 *
 * The schema refuses both keys by name, which is right for a file written
 * today and wrong as an upgrade: an operator whose settings predate 0.4.0 did
 * nothing but keep a key two releases honored. This migration is what makes
 * the refusal land only on files that name the keys fresh.
 *
 * It cannot go through `readSettings` or `updateSettings`, because those run
 * the validator that rejects exactly the keys being removed, so what is pinned
 * here is the raw-document path: it strips the keys, it leaves every other file
 * alone byte for byte, and it never rewrites a document it could not parse.
 *
 * Most cases drive `up()` directly. `runPending` is used only where the
 * registry itself is the subject, because it also runs the lmstudio migration,
 * whose strict `readSettings` is exactly what the ordering rule exists to keep
 * behind this one.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";

import { validateSettingsFile } from "../../src/core/config.js";
import retirePanesKnobs from "../../src/domains/lifecycle/migrations/2026-09-01-retire-panes-knobs.js";
import { listMigrations, runPending } from "../../src/domains/lifecycle/migrations/index.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const MIGRATION_ID = "2026-09-01-retire-panes-knobs";
const LMSTUDIO_ID = "2026-08-18-lmstudio-runtime-id";

describe("contracts/retired pane knobs migration", () => {
	let scratch: IsolatedClioEnv;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-retire-panes-");
		mkdirSync(join(scratch.dir, "config"), { recursive: true });
		mkdirSync(join(scratch.dir, "state"), { recursive: true });
	});

	afterEach(() => scratch.restore());

	const settingsFile = (): string => join(scratch.dir, "config", "settings.yaml");
	const write = (text: string): void => writeFileSync(settingsFile(), text, "utf8");
	const read = (): string => readFileSync(settingsFile(), "utf8");
	const stateDir = (): string => join(scratch.dir, "state");

	it("strips both retired keys and leaves the file loading clean", async () => {
		write(`autonomy: auto-edit
panes:
  enabled: auto
  agents: off
  keepFailed: false
  notifications: failures
`);
		// The file this migration is for cannot pass the strict reader; that is the
		// whole reason it exists.
		deepStrictEqual(
			validateSettingsFile()
				.issues.map((issue) => issue.path)
				.sort(),
			["panes.agents", "panes.keepFailed"],
		);

		await retirePanesKnobs.up(stateDir());

		deepStrictEqual(validateSettingsFile().issues, []);
		const saved = parseYaml(read()) as { panes?: Record<string, unknown>; autonomy?: string };
		// The keys around them survive: this removes two knobs, not a section.
		deepStrictEqual(Object.keys(saved.panes ?? {}).sort(), ["enabled", "notifications"]);
		strictEqual(saved.panes?.enabled, "auto");
		strictEqual(saved.panes?.notifications, "failures");
		strictEqual(saved.autonomy, "auto-edit");
	});

	it("removes a panes map that held nothing else, rather than leaving an empty one", async () => {
		write(`autonomy: suggest
panes:
  agents: off
  keepFailed: true
`);
		await retirePanesKnobs.up(stateDir());
		const saved = parseYaml(read()) as Record<string, unknown>;
		strictEqual("panes" in saved, false, `an empty panes map names no setting: ${read()}`);
		strictEqual(saved.autonomy, "suggest");
		deepStrictEqual(validateSettingsFile().issues, []);
	});

	it("strips one retired key without disturbing the other's absence", async () => {
		write(`panes:
  enabled: off
  keepFailed: true
`);
		await retirePanesKnobs.up(stateDir());
		deepStrictEqual(Object.keys((parseYaml(read()) as { panes?: object }).panes ?? {}), ["enabled"]);
		deepStrictEqual(validateSettingsFile().issues, []);
	});

	// Rewriting re-serializes from the parse, so comments and formatting do not
	// survive it. A file that never named these keys must therefore come out of
	// the migration byte for byte identical.
	it("does not touch a file that never named a retired key", async () => {
		const original = `# Written by hand, comments and all.
autonomy: suggest

panes:
  enabled: auto   # trailing note
  notifications: all
`;
		write(original);
		await retirePanesKnobs.up(stateDir());
		strictEqual(read(), original, "an untouched document keeps its comments and spacing");
	});

	it("leaves a file with no panes section alone, and never creates one that is absent", async () => {
		const original = "autonomy: read-only\n";
		write(original);
		await retirePanesKnobs.up(stateDir());
		strictEqual(read(), original);

		rmSync(settingsFile());
		await retirePanesKnobs.up(stateDir());
		strictEqual(existsSync(settingsFile()), false, "a home with no settings file must not gain one");
	});

	// A document the parser cannot read is one the operator still has to fix by
	// hand. Writing a re-serialized guess over it would destroy the original.
	it("refuses to rewrite a document it could not parse", async () => {
		const broken = "panes:\n  agents: off\n   keepFailed: [unclosed\n";
		write(broken);
		await retirePanesKnobs.up(stateDir());
		strictEqual(read(), broken, "the malformed original is left exactly as found");
	});

	it("runs ahead of the migration that reads settings strictly", async () => {
		// Ordering is the load-bearing part: `lmstudio-runtime-id` calls
		// `readSettings`, which throws on a retired key, so a registry that ran it
		// first could never reach the repair. Pinned on the registry rather than on
		// ids, which are stable identifiers and deliberately not the order.
		const ids = listMigrations().map((migration) => migration.id);
		ok(ids.indexOf(MIGRATION_ID) < ids.indexOf(LMSTUDIO_ID), ids.join(", "));

		write(`autonomy: auto-edit
panes:
  enabled: auto
  agents: off
  keepFailed: false
`);
		const applied = await runPending(stateDir());
		deepStrictEqual(applied.applied, [MIGRATION_ID, LMSTUDIO_ID], "the whole pending set ran, in registry order");
		deepStrictEqual(validateSettingsFile().issues, []);
	});

	it("is not applied twice", async () => {
		write("panes:\n  agents: off\n");
		ok((await runPending(stateDir())).applied.includes(MIGRATION_ID));
		const second = await runPending(stateDir());
		deepStrictEqual(second.applied, []);
		ok(second.allApplied.includes(MIGRATION_ID));
	});
});
