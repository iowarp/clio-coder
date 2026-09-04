import { match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runResetCommand } from "../../src/cli/reset.js";
import { createLifecycleHome, runInHome } from "../harness/lifecycle-home.js";

const home = () => createLifecycleHome("clio-test-reset-");

describe("contracts/reset-lifecycle", () => {
	it("previews the default state scope, names what survives, and writes nothing", async () => {
		const temp = home();
		try {
			const { code, stdout } = await runInHome(temp, () => runResetCommand(["--dry-run"]));
			strictEqual(code, 0);

			match(stdout, /The following will be cleared:/u);
			match(stdout, /✓ State: /u, "the state root is the row marked for clearing");
			match(stdout, /– Data: .*\(survives\)/u);
			match(stdout, /– Settings: .*\(survives\)/u);
			match(stdout, /– Credentials: .*\(survives\)/u);
			match(stdout, /– Cache: .*\(survives\)/u);
			match(stdout, /Survives: Data, Settings, Credentials, Cache/u);
			match(stdout, /Dry run: no changes made/u);

			// The launcher is outside every reset scope, so it is not on the listing.
			ok(!/Launcher|Binary/u.test(stdout), `reset must not list a launcher row:\n${stdout}`);
			// No result lines on a preview.
			ok(!/Cleared /u.test(stdout), `a dry run must report no completed work:\n${stdout}`);

			ok(existsSync(join(temp.configDir, "settings.yaml")));
			ok(existsSync(join(temp.dataDir, "records.json")));
			ok(existsSync(join(temp.stateDir, "install.json")));
		} finally {
			temp.cleanup();
		}
	});

	it("previews --all as every root with nothing surviving", async () => {
		const temp = home();
		try {
			const { code, stdout } = await runInHome(temp, () => runResetCommand(["--all", "--dry-run"]));
			strictEqual(code, 0);

			for (const label of ["State", "Data", "Config", "Cache"]) {
				match(stdout, new RegExp(`✓ ${label}: `, "u"), `${label} must be marked for clearing`);
			}
			ok(!/\(survives\)/u.test(stdout), `--all leaves nothing:\n${stdout}`);
			ok(!/Survives:/u.test(stdout), `--all must not print a survivors line:\n${stdout}`);
			match(stdout, /Everything goes: settings, credentials, memory/u);

			ok(existsSync(join(temp.configDir, "settings.yaml")));
			ok(existsSync(join(temp.stateDir, "install.json")));
		} finally {
			temp.cleanup();
		}
	});

	it("states one consequence per selected scope and not one per root", async () => {
		const temp = home();
		try {
			const { stdout } = await runInHome(temp, () => runResetCommand(["--state", "--auth", "--dry-run"]));
			match(stdout, /State holds every session transcript/u);
			match(stdout, /Saved API keys are gone/u);
			ok(!/Cache is disposable/u.test(stdout), `an unselected scope owes no consequence line:\n${stdout}`);
		} finally {
			temp.cleanup();
		}
	});

	it("emits one JSON document with per-root status and size", async () => {
		const temp = home();
		try {
			const { code, stdout } = await runInHome(temp, () => runResetCommand(["--dry-run", "--json"]));
			strictEqual(code, 0);

			const parsed = JSON.parse(stdout) as {
				command: string;
				status: string;
				items: Array<{ label: string; path: string; status: string; bytes: number }>;
				warnings: string[];
			};
			strictEqual(parsed.command, "reset");
			strictEqual(parsed.status, "success");

			const byLabel = new Map(parsed.items.map((item) => [item.label, item]));
			strictEqual(byLabel.get("State")?.status, "remove");
			strictEqual(byLabel.get("State")?.path, temp.stateDir);
			strictEqual(byLabel.get("Settings")?.status, "keep");
			strictEqual(byLabel.get("Credentials")?.status, "keep");
			strictEqual(byLabel.get("Cache")?.bytes, 10, "cache size is measured, not guessed");
			ok(parsed.warnings.includes("Dry run: no changes made"));
		} finally {
			temp.cleanup();
		}
	});

	it("refuses without a terminal and without --force, on stderr alone", async () => {
		const temp = home();
		const savedIsTty = process.stdin.isTTY;
		process.stdin.isTTY = false;
		try {
			const { code, stdout } = await runInHome(temp, () => runResetCommand([]));
			strictEqual(code, 2);
			strictEqual(stdout, "", "a refusal must leave stdout clean for the caller parsing it");
			ok(existsSync(join(temp.stateDir, "install.json")), "nothing is removed on the refusal path");
		} finally {
			process.stdin.isTTY = savedIsTty;
			temp.cleanup();
		}
	});

	it("clears only the state root and leaves settings, credentials, and data byte-for-byte", async () => {
		const temp = home();
		try {
			mkdirSync(join(temp.stateDir, "sessions", "kept"), { recursive: true });
			writeFileSync(join(temp.stateDir, "sessions", "kept", "meta.json"), "{}\n", "utf8");
			writeFileSync(join(temp.stateDir, "install.json"), '{"version":"0.4.2-old"}\n', "utf8");
			const settingsBefore = readFileSync(join(temp.configDir, "settings.yaml"), "utf8");
			const { code, stdout } = await runInHome(temp, () => runResetCommand(["--force"]));
			strictEqual(code, 0);

			match(stdout, /✓ Cleared State/u);
			ok(!/Cleared Data|Cleared Config|Cleared Cache/u.test(stdout), `only state was in scope:\n${stdout}`);

			ok(!existsSync(join(temp.stateDir, "sessions", "kept")), "recorded sessions are gone");
			// install.json comes back from the bootstrap, carrying this version
			// rather than the one the reset removed.
			ok(existsSync(temp.stateDir), "the empty root is recreated so the next run has somewhere to write");
			ok(!readFileSync(join(temp.stateDir, "install.json"), "utf8").includes('"0.4.2-old"'));
			strictEqual(readFileSync(join(temp.configDir, "settings.yaml"), "utf8"), settingsBefore);
			ok(existsSync(join(temp.configDir, "credentials.yaml")));
			ok(existsSync(join(temp.dataDir, "records.json")));
			ok(existsSync(join(temp.cacheDir, "derived.bin")));
		} finally {
			temp.cleanup();
		}
	});

	it("clears credentials for --auth without touching settings", async () => {
		const temp = home();
		try {
			const { code } = await runInHome(temp, () => runResetCommand(["--auth", "--force"]));
			strictEqual(code, 0);
			// The bootstrap writes an empty store back, so the file exists and the
			// secret does not. Asserting only on the file's absence would pass over
			// a reset that left the key in place.
			ok(!readFileSync(join(temp.configDir, "credentials.yaml"), "utf8").includes("test-secret"));
			strictEqual(readFileSync(join(temp.configDir, "settings.yaml"), "utf8"), "theme: custom-theme\n");
			ok(existsSync(join(temp.stateDir, "install.json")), "--auth does not reach the state root");
		} finally {
			temp.cleanup();
		}
	});

	it("reports no work rather than a phantom result when the selected root is already gone", async () => {
		const temp = createLifecycleHome("clio-test-reset-empty-", { populate: false });
		try {
			const { code, stdout } = await runInHome(temp, () => runResetCommand(["--cache", "--force"]));
			strictEqual(code, 0);
			// removePath returns null both for a delete and for an absent path, so
			// the old code announced "Reset cache" over a cache that never existed.
			ok(!/Cleared Cache/u.test(stdout), `nothing was there to clear:\n${stdout}`);
			match(stdout, /Nothing to clear/u);
		} finally {
			temp.cleanup();
		}
	});

	it("rejects --all combined with a scope, and an unknown flag, without deleting anything", async () => {
		const temp = home();
		try {
			for (const argv of [["--all", "--state"], ["--nope"]]) {
				const { code } = await runInHome(temp, () => runResetCommand(argv));
				strictEqual(code, 2, `${argv.join(" ")} must be a usage error`);
			}
			ok(existsSync(join(temp.stateDir, "install.json")));
			ok(existsSync(join(temp.configDir, "settings.yaml")));
		} finally {
			temp.cleanup();
		}
	});
});
