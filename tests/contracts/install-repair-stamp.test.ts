/**
 * `clio doctor` reported an install timestamp that was the repair time.
 *
 * `initializeClioHome()` writes install.json when it cannot read one, and it
 * wrote `installedAt: now` every time. Recreating the file over a state root
 * that already held sessions therefore stamped the repair minute as the day the
 * user installed Clio, and every run afterwards repeated it as fact. A repair is
 * not an install, and the install time it destroyed is not recoverable, so the
 * record says what actually happened and says nothing about what it cannot know.
 */
import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initializeClioHome } from "../../src/core/init.js";
import { runDoctor } from "../../src/domains/lifecycle/doctor.js";
import { readStateInfo } from "../../src/domains/lifecycle/state.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

describe("contracts/install and repair stamps", () => {
	let scratch: ReturnType<typeof isolateClioEnv>;
	let installPath: string;

	beforeEach(() => {
		scratch = isolateClioEnv("clio-install-stamp-");
		installPath = join(scratch.dir, "state", "install.json");
	});

	afterEach(() => {
		scratch.restore();
	});

	function stateMetadataRow(): string {
		const row = runDoctor().find((finding) => finding.name === "state metadata");
		ok(row, "doctor has a state metadata row");
		return row.detail;
	}

	it("stamps a genuine first install as an install", () => {
		initializeClioHome();

		const info = readStateInfo();
		ok(info?.installedAt, "a first install knows when it happened");
		strictEqual(info?.repairedAt, undefined, "and nothing was repaired");
		ok(stateMetadataRow().includes(`installed ${info?.installedAt}`), stateMetadataRow());
	});

	it("calls a rebuild over an existing home a repair, and claims no install time", () => {
		initializeClioHome();
		// The state root survives; only the record of the install is gone. This is
		// what `clio doctor --fix` faces after the file is deleted or corrupted.
		rmSync(installPath);
		mkdirSync(join(scratch.dir, "state", "sessions"), { recursive: true });

		initializeClioHome();

		const info = readStateInfo();
		strictEqual(info?.installedAt, undefined, "the install time is gone and must not be invented");
		ok(info?.repairedAt, "the repair is on record as a repair");
		const row = stateMetadataRow();
		ok(row.includes(`repaired ${info?.repairedAt}`), `the row names the repair: ${row}`);
		ok(!row.includes("installed "), `and claims no install date: ${row}`);
	});

	it("treats an unreadable record the same way", () => {
		initializeClioHome();
		writeFileSync(installPath, "{ not json", "utf8");

		initializeClioHome();

		const info = readStateInfo();
		strictEqual(info?.installedAt, undefined);
		ok(info?.repairedAt);
	});

	it("does not move the repair stamp forward on later runs", () => {
		initializeClioHome();
		rmSync(installPath);
		initializeClioHome();
		const first = readStateInfo()?.repairedAt;
		ok(first);

		initializeClioHome();
		strictEqual(readStateInfo()?.repairedAt, first, "a repaired record is a valid record, not one to redo");
	});

	it("preserves a real install time across an upgrade, and keeps the two stamps apart", () => {
		initializeClioHome();
		const installedAt = readStateInfo()?.installedAt;
		ok(installedAt);

		// What an upgrade looks like from here: same home, older version on record.
		const record = JSON.parse(readFileSync(installPath, "utf8")) as Record<string, unknown>;
		writeFileSync(installPath, JSON.stringify({ ...record, version: "0.0.0-old" }, null, 2), "utf8");
		initializeClioHome();

		const info = readStateInfo();
		strictEqual(info?.installedAt, installedAt, "an upgrade never rewrites the install date");
		ok(info?.upgradedAt, "and records itself as an upgrade");
		strictEqual(info?.repairedAt, undefined, "an upgrade is not a repair");
	});
});
