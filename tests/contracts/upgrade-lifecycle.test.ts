import { match, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runUpgradeCommand } from "../../src/cli/upgrade.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { getVersionInfo } from "../../src/domains/lifecycle/version.js";
import { createLifecycleHome, type LifecycleHome, runInHome } from "../harness/lifecycle-home.js";

const MIGRATION_IDS = [
	"2026-09-01-settings-v2",
	"2026-09-01-extension-install-digests",
	"2026-09-01-clio-coder-naming",
	"2026-09-01-retire-panes-knobs",
	"2026-08-18-lmstudio-runtime-id",
] as const;

/** Upgrade caches the resolved state dir, so every run gets a fresh resolution. */
async function upgrade(
	temp: LifecycleHome,
	argv: ReadonlyArray<string>,
	extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string }> {
	resetXdgCache();
	try {
		return await runInHome({ ...temp, env: { ...temp.env, ...extraEnv } }, () => runUpgradeCommand(argv));
	} finally {
		resetXdgCache();
	}
}

/** A home whose migration manifest and recorded version are already up to date. */
function currentHome(): LifecycleHome {
	const temp = createLifecycleHome("clio-test-upgrade-");
	writeFileSync(join(temp.stateDir, "migrations.json"), JSON.stringify({ applied: [...MIGRATION_IDS] }), "utf8");
	writeFileSync(join(temp.stateDir, "install.json"), JSON.stringify({ version: getVersionInfo().clio }), "utf8");
	return temp;
}

const NO_NETWORK = { CLIO_CODER_TEST_UPGRADE_NO_NETWORK: "1" };

describe("contracts/upgrade-lifecycle", () => {
	it("reports the detected facts before doing anything", async () => {
		const temp = currentHome();
		try {
			const version = getVersionInfo().clio;
			const { code, stdout } = await upgrade(temp, [], { ...NO_NETWORK, CLIO_CODER_TEST_UPGRADE_AVAILABLE: version });
			strictEqual(code, 0);
			match(stdout, /Installation method: (source checkout|npm global)/u);
			match(stdout, new RegExp(`Current version: ${version}`, "u"));
			match(stdout, new RegExp(`Available version: ${version}`, "u"));
			match(stdout, /State dir: /u);
		} finally {
			temp.cleanup();
		}
	});

	it("exits 0 with one sentence when the version is current and no migration is pending", async () => {
		const temp = currentHome();
		try {
			const version = getVersionInfo().clio;
			const { code, stdout } = await upgrade(temp, [], { ...NO_NETWORK, CLIO_CODER_TEST_UPGRADE_AVAILABLE: version });
			strictEqual(code, 0);
			match(stdout, new RegExp(`Already on ${version}, with no pending migrations`, "u"));
			ok(!/Applied migration/u.test(stdout), `nothing ran:\n${stdout}`);
		} finally {
			temp.cleanup();
		}
	});

	it("does not claim to be current when the registry was asked and could not answer", async () => {
		const temp = currentHome();
		try {
			// A lookup that failed compared nothing. Treating its null as "same as
			// installed" told an offline user they were up to date and skipped the
			// install they had asked for.
			const failed = await upgrade(temp, ["--dry-run"], { CLIO_CODER_TEST_UPGRADE_AVAILABLE: "unreachable" });
			ok(!/Already on /u.test(failed.stdout), `an unanswered lookup is not a current version:\n${failed.stdout}`);
			match(failed.stdout, /Available version: unknown \(the registry could not be reached\)/u);

			// A lookup that was never owed is a different fact, and says so.
			const skipped = await upgrade(temp, ["--dry-run"], NO_NETWORK);
			match(skipped.stdout, /Available version: not checked/u);
		} finally {
			temp.cleanup();
		}
	});

	it("previews the install step and every pending migration by id, changing nothing", async () => {
		const temp = createLifecycleHome("clio-test-upgrade-dry-");
		try {
			const { code, stdout } = await upgrade(temp, ["--dry-run"], NO_NETWORK);
			strictEqual(code, 0);
			match(stdout, /Would apply 5 pending migrations:/u);
			for (const id of MIGRATION_IDS) match(stdout, new RegExp(id.replace(/\./gu, "\\."), "u"));
			match(stdout, /Would refresh state metadata/u);
			match(stdout, /Dry run: no changes made/u);
			ok(!/✓ Applied migration/u.test(stdout), `a preview applies nothing:\n${stdout}`);
		} finally {
			temp.cleanup();
		}
	});

	it("puts the dry-run plan in the JSON report, not only in the prose", async () => {
		const temp = createLifecycleHome("clio-test-upgrade-json-");
		try {
			const { code, stdout } = await upgrade(temp, ["--dry-run", "--json"], NO_NETWORK);
			strictEqual(code, 0);

			const parsed = JSON.parse(stdout) as {
				command: string;
				method: string;
				steps: Array<{ type: string; message: string }>;
				warnings: string[];
			};
			strictEqual(parsed.command, "upgrade");
			strictEqual(typeof parsed.method, "string");
			const messages = parsed.steps.map((step) => step.message);
			// A scripted caller has to be able to see which migrations a real run
			// would apply; the old report carried only the three detected facts.
			for (const id of MIGRATION_IDS) ok(messages.includes(id), `${id} missing from the JSON plan`);
			ok(parsed.warnings.includes("Dry run: no changes made"));
		} finally {
			temp.cleanup();
		}
	});

	it("applies pending migrations and reports the count", async () => {
		const temp = createLifecycleHome("clio-test-upgrade-run-");
		try {
			const { code, stdout } = await upgrade(temp, [], NO_NETWORK);
			strictEqual(code, 0);
			for (const id of MIGRATION_IDS) match(stdout, new RegExp(`✓ Applied migration ${id}`, "u"));
			match(stdout, /5 migrations applied/u);
		} finally {
			temp.cleanup();
		}
	});

	it("parses --channel in both spellings and rejects anything else", async () => {
		const temp = currentHome();
		try {
			for (const argv of [
				["--channel=beta", "--dry-run"],
				["--channel", "beta", "--dry-run"],
			]) {
				const { code, stdout } = await upgrade(temp, argv, NO_NETWORK);
				strictEqual(code, 0, `${argv.join(" ")} must parse`);
				// Only meaningful on an npm install; a source checkout prints no
				// channel line, so assert it is never the wrong one.
				ok(!/Channel: latest/u.test(stdout), `--channel beta must not read as latest:\n${stdout}`);
			}
			for (const argv of [["--channel=unknown"], ["--channel"], ["--channel", "--dry-run"]]) {
				const { code } = await upgrade(temp, argv, NO_NETWORK);
				strictEqual(code, 2, `${argv.join(" ")} must be a usage error`);
			}
			strictEqual((await upgrade(temp, ["--nope"], NO_NETWORK)).code, 2);
		} finally {
			temp.cleanup();
		}
	});

	it("names the command to run by hand when a migration fails, and says so in JSON", async () => {
		const temp = createLifecycleHome("clio-test-upgrade-fail-");
		try {
			const plain = await upgrade(temp, [], { ...NO_NETWORK, CLIO_CODER_TEST_UPGRADE_FAIL: "migration" });
			strictEqual(plain.code, 1);
			match(plain.stdout, /clio-coder upgrade --skip-migrations/u);

			// fail() used to serialize the report before the advice was recorded,
			// so a scripted caller got the error and not the recovery.
			const json = await upgrade(temp, ["--json"], { ...NO_NETWORK, CLIO_CODER_TEST_UPGRADE_FAIL: "migration" });
			strictEqual(json.code, 1);
			const parsed = JSON.parse(json.stdout) as {
				status: string;
				errors: string[];
				advice: Array<{ command: string }>;
			};
			strictEqual(parsed.status, "error");
			match(parsed.errors[0] ?? "", /migration failed/u);
			strictEqual(parsed.advice[0]?.command, "clio-coder upgrade --skip-migrations");
		} finally {
			temp.cleanup();
		}
	});
});
