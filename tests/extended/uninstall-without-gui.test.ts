import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// A terminal-only build: a package root with no dist/gui. The root is cached on first use, so it is
// fixed before anything resolves it, and this file runs in its own process.
const bareRoot = mkdtempSync(join(tmpdir(), "clio-coder-test-bare-root-"));
writeFileSync(join(bareRoot, "package.json"), '{"name":"@iowarp/clio-coder","version":"0.0.0"}\n', "utf8");
process.env.CLIO_CODER_PACKAGE_ROOT = bareRoot;

const { prepareGuiUninstall } = await import("../../src/cli/gui.js");
const { runUninstallCommand } = await import("../../src/cli/uninstall.js");
const { createLifecycleHome, runInHome } = await import("../harness/lifecycle-home.js");

after(() => rmSync(bareRoot, { recursive: true, force: true }));

describe("extended/uninstall-without-gui", () => {
	it("reports graphical files it cannot verify instead of importing a bundle that is not there", async () => {
		const temp = createLifecycleHome("clio-coder-test-uninstall-bare-");
		try {
			const prefix = join(temp.root, ".local/share");
			const background = join(temp.stateDir, "gui/background");
			const entry = join(prefix, "applications/io.iowarp.ClioCoder.desktop");
			mkdirSync(background, { recursive: true });
			writeFileSync(join(background, "config.json"), "{}\n", "utf8");
			mkdirSync(join(prefix, "applications"), { recursive: true });
			writeFileSync(entry, "[Desktop Entry]\n", "utf8");

			const plan = await prepareGuiUninstall({ stateDir: temp.stateDir, desktopPrefix: prefix });
			deepStrictEqual(plan.items, []);
			deepStrictEqual(
				plan.unmanaged.map((item) => item.path),
				[background, entry],
			);

			const preview = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));
			strictEqual(preview.code, 0);
			match(preview.stdout, /– Desktop launcher: .*no graphical application/u);
			match(preview.stdout, /– Graphical background service: /u);
			match(preview.stdout, /clio-coder gui background uninstall && clio-coder gui launcher uninstall/u);
			doesNotMatch(preview.stdout, /Cannot find module/u);

			const real = await runInHome(temp, () => runUninstallCommand(["--force"]));
			strictEqual(real.code, 0);
			match(real.stdout, /Removed State, except gui/u);
			// The service's own configuration and the launcher survive; everything else in state is gone.
			ok(existsSync(join(background, "config.json")));
			ok(existsSync(entry));
			ok(!existsSync(join(temp.stateDir, "install.json")));
			ok(!existsSync(join(temp.stateDir, "sessions")));
			ok(!existsSync(temp.configDir));
			ok(!existsSync(temp.dataDir));
		} finally {
			temp.cleanup();
		}
	});

	it("stays silent and deletes state whole when there is no graphical file", async () => {
		const temp = createLifecycleHome("clio-coder-test-uninstall-bare-");
		try {
			const real = await runInHome(temp, () => runUninstallCommand(["--force"]));
			strictEqual(real.code, 0);
			doesNotMatch(real.stdout, /[Gg]raphical/u);
			ok(!existsSync(temp.stateDir));
		} finally {
			temp.cleanup();
		}
	});
});
