/**
 * Migrations must not be able to wedge an upgrade.
 *
 * Two failure shapes are covered here, both from the v0.3.2 CLI audit:
 *
 *   1. A migration that has nothing to do must not fail because some unrelated
 *      file it would have touched is unreadable. The lmstudio-native migration
 *      asked the credentials store to rename a provider on every upgrade, and
 *      the store refused outright on a hand-edited credentials.yaml, so every
 *      `clio-coder upgrade` on that machine exited 1 forever.
 *   2. A migration that throws must not discard the record of the migrations
 *      that already succeeded in the same pass, or they re-run against a tree
 *      they have already changed.
 */
import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type Migration, runPending } from "../../src/domains/lifecycle/migrations/index.js";
import { FileAuthStorageBackend } from "../../src/domains/providers/auth/backend-file.js";
import { AuthStorage, AuthStorageDamagedError } from "../../src/domains/providers/auth/storage.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/** credentials.yaml in a shape the parser reports as damage, holding no entries it can read. */
const DAMAGED_CREDENTIALS = "openai: sk-abc\n";

function readManifest(stateDir: string): { applied: string[] } {
	return JSON.parse(readFileSync(join(stateDir, "migrations.json"), "utf8")) as { applied: string[] };
}

describe("contracts/migration resilience", () => {
	let scratch: IsolatedClioEnv;
	let configDir: string;
	let stateDir: string;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-migration-resilience-");
		configDir = join(scratch.dir, "config");
		stateDir = join(scratch.dir, "state");
		mkdirSync(configDir, { recursive: true });
		mkdirSync(stateDir, { recursive: true });
	});

	afterEach(() => scratch.restore());

	describe("renameProvider", () => {
		function openStore(): AuthStorage {
			return new AuthStorage(new FileAuthStorageBackend(join(configDir, "credentials.yaml")));
		}

		it("is a no-op on a damaged store that holds no credential under the source id", () => {
			writeFileSync(join(configDir, "credentials.yaml"), DAMAGED_CREDENTIALS, { encoding: "utf8", mode: 0o600 });

			const storage = openStore();
			// The whole point: this must not throw, because it writes nothing.
			storage.renameProvider("lmstudio-native", "lmstudio");

			strictEqual(
				readFileSync(join(configDir, "credentials.yaml"), "utf8"),
				DAMAGED_CREDENTIALS,
				"a no-op rename must leave the operator's file byte-identical",
			);
			// The damaged view must not be adopted as "no credentials stored"; the
			// store still has to report why it could not be read.
			ok(storage.damageReason() !== null, "damage must survive a no-op rename");
		});

		it("still refuses when the source credential exists in a partially unreadable store", () => {
			writeFileSync(
				join(configDir, "credentials.yaml"),
				`version: 2
entries:
  lmstudio-native:
    type: api_key
    key: secret
    updatedAt: 2026-08-18T00:00:00.000Z
  broken:
    type: something-this-version-cannot-read
`,
				{ encoding: "utf8", mode: 0o600 },
			);

			const storage = openStore();
			let thrown: unknown = null;
			try {
				storage.renameProvider("lmstudio-native", "lmstudio");
			} catch (error) {
				thrown = error;
			}
			ok(
				thrown instanceof AuthStorageDamagedError,
				"a rename that rewrites the file must still refuse to drop entries it cannot read",
			);
			match(readFileSync(join(configDir, "credentials.yaml"), "utf8"), /broken:/u);
		});

		it("renames and rewrites when the store is clean", () => {
			writeFileSync(
				join(configDir, "credentials.yaml"),
				`version: 2
entries:
  lmstudio-native:
    type: api_key
    key: secret
    updatedAt: 2026-08-18T00:00:00.000Z
`,
				{ encoding: "utf8", mode: 0o600 },
			);

			const storage = openStore();
			storage.renameProvider("lmstudio-native", "lmstudio");

			ok(storage.hasStored("lmstudio"));
			ok(!storage.hasStored("lmstudio-native"));
		});
	});

	describe("the lmstudio-native migration", () => {
		it("applies and records itself on a home whose credentials.yaml cannot be parsed", async () => {
			writeFileSync(
				join(configDir, "settings.yaml"),
				`version: 1
targets:
  - id: ls
    runtime: lmstudio
    url: ws://127.0.0.1:1234
    defaultModel: qwen3.8-27b
`,
				"utf8",
			);
			writeFileSync(join(configDir, "credentials.yaml"), DAMAGED_CREDENTIALS, { encoding: "utf8", mode: 0o600 });

			const result = await runPending(stateDir);

			deepStrictEqual(result.applied, ["2026-08-18-lmstudio-runtime-id"]);
			deepStrictEqual(readManifest(stateDir).applied, ["2026-08-18-lmstudio-runtime-id"]);
			// The settings half of the migration still ran.
			match(readFileSync(join(configDir, "settings.yaml"), "utf8"), /url: http:\/\/127\.0\.0\.1:1234/u);
			// The file it had no business touching is untouched.
			strictEqual(readFileSync(join(configDir, "credentials.yaml"), "utf8"), DAMAGED_CREDENTIALS);
		});

		it("is not re-applied on a second pass", async () => {
			writeFileSync(join(configDir, "credentials.yaml"), DAMAGED_CREDENTIALS, { encoding: "utf8", mode: 0o600 });

			await runPending(stateDir);
			const second = await runPending(stateDir);

			deepStrictEqual(second.applied, []);
			deepStrictEqual(second.allApplied, ["2026-08-18-lmstudio-runtime-id"]);
		});
	});

	describe("runPending", () => {
		it("records each migration as it succeeds, so a later failure does not replay the earlier ones", async () => {
			const ran: string[] = [];
			const first: Migration = {
				id: "2026-01-01-first",
				async up(): Promise<void> {
					ran.push("first");
				},
			};
			const second: Migration = {
				id: "2026-01-02-second",
				async up(): Promise<void> {
					ran.push("second");
					throw new Error("second migration is broken");
				},
			};
			const manifestDir = join(scratch.dir, "state-ordered");

			await rejects(runPending(manifestDir, [first, second]), /second migration is broken/u);

			deepStrictEqual(ran, ["first", "second"]);
			deepStrictEqual(
				readManifest(manifestDir).applied,
				["2026-01-01-first"],
				"a migration that already succeeded must be recorded even though a later one threw",
			);

			// The retry re-runs only the one that failed.
			ran.length = 0;
			await rejects(runPending(manifestDir, [first, second]), /second migration is broken/u);
			deepStrictEqual(ran, ["second"], "an already-recorded migration must not run a second time");
		});

		it("leaves a well-formed manifest when nothing is pending", async () => {
			writeFileSync(join(configDir, "credentials.yaml"), DAMAGED_CREDENTIALS, { encoding: "utf8", mode: 0o600 });
			await runPending(stateDir);
			await runPending(stateDir);
			ok(Array.isArray(readManifest(stateDir).applied));
		});
	});
});
