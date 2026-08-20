/**
 * The 0.3.0 → 0.3.1 upgrade, as the operator who installed 0.3.0 from npm
 * meets it: a home 0.3.0 wrote, then the newer binary pointed at it.
 *
 * Three things have to hold. `install.json` moves to the new version and keeps
 * where it came from, so `doctor` and the first interactive launch can say so.
 * The launch says so once, and never to a headless or ACP boot. And the
 * settings 0.3.0 generated (`identity:`, a fleet node keyed `clioEntry`) load
 * without an issue, because the upgrade rewrites nothing in them.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateSettingsFile } from "../../src/core/config.js";
import { initializeClioHome } from "../../src/core/init.js";
import { readClioVersion } from "../../src/core/package-root.js";
import { runDoctor } from "../../src/domains/lifecycle/doctor.js";
import { readStateInfo, takeUpgradeNotice } from "../../src/domains/lifecycle/state.js";
import { describeUpgradeNotice } from "../../src/domains/lifecycle/upgrade-notice.js";
import { isolateClioEnv, scratchClioEnvVars } from "../harness/scratch-env.js";
import { runCli } from "../harness/spawn.js";

const OLD_VERSION = "0.3.0";

/** What 0.3.0's `configure` plus a hand-added fleet node left on disk. */
const SETTINGS_FROM_0_3_0 = `version: 1
identity: clio
autonomy: auto-edit
targets:
  - id: local-llamacpp
    runtime: llamacpp
    url: http://127.0.0.1:8080
    defaultModel: qwen-7b
orchestrator:
  target: local-llamacpp
  model: qwen-7b
  thinkingLevel: off
workers:
  default:
    target: local-llamacpp
    model: qwen-7b
    thinkingLevel: off
fleet:
  nodes:
    - id: node-a
      host: node-a.example
      user: ops
      clioEntry: /opt/clio/bin/clio-coder worker
      labels: [gpu]
      maxWorkers: 2
`;

function seedHomeFrom030(dir: string): void {
	mkdirSync(join(dir, "config"), { recursive: true });
	mkdirSync(join(dir, "state", "sessions"), { recursive: true });
	writeFileSync(join(dir, "config", "settings.yaml"), SETTINGS_FROM_0_3_0, "utf8");
	writeFileSync(join(dir, "config", "credentials.yaml"), "{}\n", { mode: 0o600 });
	writeFileSync(
		join(dir, "state", "install.json"),
		`${JSON.stringify(
			{
				version: OLD_VERSION,
				installedAt: "2026-08-14T12:00:00.000Z",
				platform: process.platform,
				nodeVersion: process.version,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

describe("contracts/upgrade path from 0.3.0", () => {
	let scratch: Awaited<ReturnType<typeof isolateClioEnv>>;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-upgrade-path-");
		seedHomeFrom030(scratch.dir);
	});

	afterEach(() => {
		scratch.restore();
	});

	it("doctor calls the 0.3.0 record stale and points at --fix, and the settings load clean", () => {
		const rows = runDoctor();
		const state = rows.find((row) => row.name === "state metadata");
		ok(state && !state.ok, "the record is stale");
		ok(state.detail.includes(`stale ${OLD_VERSION}`), state.detail);
		ok(state.detail.includes("clio-coder doctor --fix"), state.detail);
		const settings = rows.find((row) => row.name === "settings.yaml");
		ok(settings?.ok, `identity: and clioEntry still load: ${settings?.detail}`);
		deepStrictEqual(validateSettingsFile().issues, []);
	});

	it("the refresh moves the version, keeps the install date, and remembers where it came from", () => {
		initializeClioHome();
		const info = readStateInfo();
		strictEqual(info?.version, readClioVersion());
		strictEqual(info?.installedAt, "2026-08-14T12:00:00.000Z");
		strictEqual(info?.upgradedFrom, OLD_VERSION);
		ok(info?.upgradedAt);
		const row = runDoctor().find((finding) => finding.name === "state metadata");
		ok(row?.ok, row?.detail);
		ok(row?.detail.includes(`from ${OLD_VERSION}`), `doctor names the origin: ${row?.detail}`);
	});

	it("the settings 0.3.0 wrote are not rewritten by the refresh", () => {
		const before = readFileSync(join(scratch.dir, "config", "settings.yaml"), "utf8");
		initializeClioHome();
		strictEqual(readFileSync(join(scratch.dir, "config", "settings.yaml"), "utf8"), before);
	});

	it("the upgrade notice is handed out once per version, and only after a version change", () => {
		strictEqual(takeUpgradeNotice(), null, "a stale record that has not been refreshed has nothing to announce yet");
		initializeClioHome();
		deepStrictEqual(takeUpgradeNotice(), { from: OLD_VERSION, to: readClioVersion() });
		strictEqual(takeUpgradeNotice(), null, "the second launch is quiet");
		strictEqual(readStateInfo()?.noticedVersion, readClioVersion());
		strictEqual(readStateInfo()?.upgradedFrom, OLD_VERSION, "the origin stays on record for doctor");

		// A later node change is not an upgrade and must not re-announce.
		initializeClioHome();
		strictEqual(takeUpgradeNotice(), null);
	});

	it("a fresh install has no notice", async () => {
		scratch.restore();
		scratch = await isolateClioEnv("clio-upgrade-path-fresh-");
		initializeClioHome();
		strictEqual(readStateInfo()?.upgradedFrom, undefined);
		strictEqual(takeUpgradeNotice(), null);
	});

	it("the notice names the transition, the keyboard-facing changes for 0.3.1, and the changelog", () => {
		const text = describeUpgradeNotice({ from: OLD_VERSION, to: "0.3.1" });
		ok(text.startsWith(`clio: upgraded ${OLD_VERSION} → 0.3.1.`), text);
		for (const expected of ["/settings", "file-ticket", "fix-issue", "ship", ".clio-coder/artifacts/", "CHANGELOG.md"]) {
			ok(text.includes(expected), `${expected} in: ${text}`);
		}
		ok(/changed/.test(text), "the word that keeps a footer notice from fading before it is read");
		const generic = describeUpgradeNotice({ from: "0.3.1", to: "0.9.9" });
		ok(generic.includes("CHANGELOG.md, section 0.9.9"), generic);
	});

	it("`upgrade --dry-run` says what would move and changes nothing", async () => {
		const result = await runCli(["upgrade", "--dry-run"], {
			env: scratchClioEnvVars(scratch.dir, { requireHomePrefix: true }),
		});
		strictEqual(result.code, 0, result.stderr);
		ok(result.stdout.includes(`would refresh state metadata ${OLD_VERSION} -> ${readClioVersion()}`), result.stdout);
		ok(result.stdout.includes("would consider 1 migration(s)"), result.stdout);
		ok(result.stdout.includes("2026-08-18-lmstudio-runtime-id"), result.stdout);
		strictEqual(readStateInfo()?.version, OLD_VERSION, "a dry run leaves the record alone");
		ok(!existsSync(join(scratch.dir, "state", "migrations.json")), "and writes no manifest");
	});

	it("`upgrade` without a network refreshes the record, records the migration, and reports the real transition", async () => {
		const result = await runCli(["upgrade"], {
			env: { ...scratchClioEnvVars(scratch.dir, { requireHomePrefix: true }), CLIO_CODER_TEST_UPGRADE_NO_NETWORK: "1" },
		});
		strictEqual(result.code, 0, result.stderr);
		ok(result.stdout.includes(`refreshed state metadata ${OLD_VERSION} -> ${readClioVersion()}`), result.stdout);
		ok(result.stdout.includes(`ok: ${OLD_VERSION} -> ${readClioVersion()} (migrations: 1)`), result.stdout);
		const manifest = JSON.parse(readFileSync(join(scratch.dir, "state", "migrations.json"), "utf8"));
		deepStrictEqual(manifest, { applied: ["2026-08-18-lmstudio-runtime-id"] });
		strictEqual(readStateInfo()?.upgradedFrom, OLD_VERSION);
		strictEqual(
			readStateInfo()?.noticedVersion,
			undefined,
			"a CLI upgrade is not the interactive launch; the notice is still owed",
		);
	});
});
