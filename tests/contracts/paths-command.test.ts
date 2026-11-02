import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runPathsCommand } from "../../src/cli/paths.js";
import { defaultInstallRoot } from "../../src/domains/lifecycle/install-method.js";
import { createLifecycleHome, runInHome } from "../harness/lifecycle-home.js";

test("paths names the installer root, the launcher and the project, and creates nothing", async (t) => {
	const temp = createLifecycleHome("clio-coder-test-paths-", { populate: false });
	t.after(temp.cleanup);
	const repo = join(temp.root, "repo");
	const deep = join(repo, "packages", "foo");
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(repo, ".git"), "gitdir: /nowhere\n");
	const cwd = process.cwd();
	process.chdir(deep);
	t.after(() => process.chdir(cwd));

	const { code, stdout } = await runInHome(temp, async () => runPathsCommand(["--json"]));
	strictEqual(code, 0);
	const paths = JSON.parse(stdout) as Record<string, unknown>;
	deepStrictEqual(Object.keys(paths), [
		"config",
		"data",
		"state",
		"cache",
		"install",
		"installActive",
		"launcher",
		"project",
	]);
	strictEqual(paths.config, temp.configDir);
	strictEqual(paths.install, join(temp.root, ".local", "share", "clio-coder-install"));
	strictEqual(paths.installActive, false);
	strictEqual(paths.launcher, join(temp.binDir, "clio-coder"));
	strictEqual(paths.project, realpathSync(repo));
	strictEqual(existsSync(temp.configDir), false, "paths is read-only");
});

test("the default installer root follows the installers' own order", () => {
	const env = (values: Record<string, string>): NodeJS.ProcessEnv => values;
	strictEqual(defaultInstallRoot(env({ CLIO_CODER_INSTALL_DIR: "/opt/clio", CLIO_CODER_HOME: "/h" })), "/opt/clio");
	strictEqual(defaultInstallRoot(env({ CLIO_CODER_HOME: "/h" })), join("/h", "install"));
	if (process.platform === "linux")
		strictEqual(defaultInstallRoot(env({ XDG_DATA_HOME: "/xdg" })), join("/xdg", "clio-coder-install"));
});
