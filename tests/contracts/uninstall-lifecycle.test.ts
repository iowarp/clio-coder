import { match, ok, strictEqual } from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runUninstallCommand } from "../../src/cli/uninstall.js";
import { createLifecycleHome, type LifecycleHome, runInHome } from "../harness/lifecycle-home.js";

const home = () => createLifecycleHome("clio-test-uninstall-");

/** The launcher path uninstall resolves, from CLIO_CODER_BIN_DIR. */
const launcherPath = (temp: LifecycleHome): string => join(temp.binDir, "clio-coder");

describe("contracts/uninstall-lifecycle", () => {
	it("inventories the four roots with sizes, and lists no child of a root it deletes whole", async () => {
		const temp = home();
		try {
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));
			strictEqual(code, 0);

			match(stdout, /Installation method: /u);
			match(stdout, /The following will be removed:/u);
			match(stdout, /✓ Data: .*\(11 B\)/u, "sizes come from the disk, not from a constant");
			match(stdout, /✓ Cache: .*\(10 B\)/u);
			match(stdout, /✓ Config: /u);
			match(stdout, /✓ State: /u);

			// `state/audit` and `state/sessions` live inside the State row. Listing
			// them again double-counted the bytes and promised per-child results
			// that one recursive delete never produces.
			ok(!/^\s+[✓–] Logs:/mu.test(stdout), `logs must not be a row of its own:\n${stdout}`);
			ok(!/^\s+[✓–] Sessions:/mu.test(stdout), `sessions must not be a row of its own:\n${stdout}`);

			match(stdout, /Dry run: no changes made/u);
			ok(!/Removed /u.test(stdout), `a dry run reports no completed work:\n${stdout}`);

			ok(existsSync(join(temp.configDir, "settings.yaml")));
			ok(existsSync(join(temp.dataDir, "records.json")));
			ok(existsSync(join(temp.stateDir, "install.json")));
		} finally {
			temp.cleanup();
		}
	});

	it("marks a shell startup file that mentions clio-coder as kept, never as removed", async () => {
		const temp = home();
		try {
			writeFileSync(join(temp.root, ".bashrc"), 'export PATH="$HOME/.local/bin:$PATH" # clio-coder\n', "utf8");
			const { stdout } = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));

			// Uninstall never edits a login file, so a ✓ beside one claimed work it
			// does not do. The row is informational.
			match(stdout, /– Shell config: .*\.bashrc.*edit it by hand/u);
			ok(!/✓ Shell/u.test(stdout), `a shell row must never be marked for removal:\n${stdout}`);

			ok(readFileSync(join(temp.root, ".bashrc"), "utf8").includes("clio-coder"), "reported, not rewritten");
		} finally {
			temp.cleanup();
		}
	});

	it("omits the shell row entirely when no startup file mentions clio-coder", async () => {
		const temp = home();
		try {
			const { stdout } = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));
			ok(!/Shell config/u.test(stdout), `nothing found means nothing listed:\n${stdout}`);
		} finally {
			temp.cleanup();
		}
	});

	it("honors --keep-config and --keep-data on the listing and on disk", async () => {
		const temp = home();
		try {
			const { code, stdout } = await runInHome(temp, () =>
				runUninstallCommand(["--force", "--keep-config", "--keep-data"]),
			);
			strictEqual(code, 0);

			match(stdout, /– Config: .*\(kept by --keep-config\)/u);
			match(stdout, /– Data: .*\(kept by --keep-data\)/u);
			match(stdout, /✓ Removed Cache/u);
			match(stdout, /✓ Removed State/u);
			ok(!/Removed Config|Removed Data/u.test(stdout), `kept roots owe no result line:\n${stdout}`);

			ok(existsSync(join(temp.configDir, "settings.yaml")));
			ok(existsSync(join(temp.dataDir, "records.json")));
			ok(!existsSync(join(temp.stateDir, "install.json")));
			ok(!existsSync(join(temp.cacheDir, "derived.bin")));
		} finally {
			temp.cleanup();
		}
	});

	it("keeps a launcher that points at another installation and says why", async () => {
		const temp = home();
		try {
			const foreign = join(temp.root, "other-install", "dist", "cli", "index.js");
			mkdirSync(join(temp.root, "other-install", "dist", "cli"), { recursive: true });
			writeFileSync(foreign, "// another clio\n", "utf8");
			symlinkSync(foreign, launcherPath(temp));

			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--force", "--remove-binary"]));
			strictEqual(code, 0);

			// --remove-binary unlinks only a symlink into *this* installation. The
			// previous code reported "Removed Binary launcher" from the flag alone,
			// over a launcher the classifier had already decided to keep.
			ok(!/Removed launcher/u.test(stdout), `a foreign launcher is not removed:\n${stdout}`);
			match(stdout, /– Launcher: .*not this installation/u);
			ok(existsSync(launcherPath(temp)), "the foreign launcher is still on disk");
			strictEqual(lstatSync(launcherPath(temp)).isSymbolicLink(), true);
		} finally {
			temp.cleanup();
		}
	});

	it("keeps a launcher that is a real file rather than a symlink", async () => {
		const temp = home();
		try {
			writeFileSync(launcherPath(temp), "#!/bin/sh\n", "utf8");
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--force", "--remove-binary"]));
			strictEqual(code, 0);
			match(stdout, /– Launcher: .*not a symlink/u);
			ok(existsSync(launcherPath(temp)));
		} finally {
			temp.cleanup();
		}
	});

	it("names the removal command only when a launcher is actually there", async () => {
		const withLauncher = home();
		const withoutLauncher = home();
		try {
			writeFileSync(launcherPath(withLauncher), "#!/bin/sh\n", "utf8");
			const present = await runInHome(withLauncher, () => runUninstallCommand(["--dry-run"]));
			match(present.stdout, /(finish removing|remove) the launcher/u);

			// An absent launcher used to get the same "to finish removing the
			// binary, run: rm <path>" line, over a path the listing had just
			// reported as absent.
			const absent = await runInHome(withoutLauncher, () => runUninstallCommand(["--dry-run"]));
			match(absent.stdout, /– Launcher: .*\(absent\)/u);
			ok(!/the launcher/u.test(absent.stdout), `no launcher, no removal advice:\n${absent.stdout}`);
		} finally {
			withLauncher.cleanup();
			withoutLauncher.cleanup();
		}
	});

	it("prints the same launcher guidance on the dry run as on the real run", async () => {
		const preview = home();
		const real = home();
		try {
			writeFileSync(launcherPath(preview), "#!/bin/sh\n", "utf8");
			writeFileSync(launcherPath(real), "#!/bin/sh\n", "utf8");
			const previewed = await runInHome(preview, () => runUninstallCommand(["--dry-run"]));
			const executed = await runInHome(real, () => runUninstallCommand(["--force"]));

			// The old dry run appended a twenty-line "Binary removal guidance"
			// block that the real run never printed, so the preview was not the
			// run's own listing.
			const advice = /(finish removing|remove) the launcher/u;
			match(previewed.stdout, advice);
			match(executed.stdout, advice);
			ok(!/Binary removal guidance|npm prefix bin:|PATH lookup:/u.test(previewed.stdout));
		} finally {
			preview.cleanup();
			real.cleanup();
		}
	});

	it("refuses without a terminal and without --force, on stderr alone", async () => {
		const temp = home();
		const savedIsTty = process.stdin.isTTY;
		process.stdin.isTTY = false;
		try {
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand([]));
			strictEqual(code, 2);
			strictEqual(stdout, "", "a refusal must leave stdout clean for the caller parsing it");
			ok(existsSync(join(temp.configDir, "settings.yaml")), "nothing is removed on the refusal path");
		} finally {
			process.stdin.isTTY = savedIsTty;
			temp.cleanup();
		}
	});

	it("emits one JSON document naming every root with its status", async () => {
		const temp = home();
		try {
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--dry-run", "--json", "--keep-config"]));
			strictEqual(code, 0);

			const parsed = JSON.parse(stdout) as {
				command: string;
				method?: string;
				items: Array<{ label: string; path: string; status: string }>;
			};
			strictEqual(parsed.command, "uninstall");
			const byLabel = new Map(parsed.items.map((item) => [item.label, item]));
			strictEqual(byLabel.get("Config")?.status, "keep");
			strictEqual(byLabel.get("Config")?.path, temp.configDir);
			strictEqual(byLabel.get("Data")?.status, "remove");
			strictEqual(byLabel.get("State")?.path, temp.stateDir);
			strictEqual(byLabel.get("Launcher")?.status, "absent");
		} finally {
			temp.cleanup();
		}
	});
});
