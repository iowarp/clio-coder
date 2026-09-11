import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installBackground } from "../server/launcher/background.js";
import { backgroundPaths, newBackgroundConfig } from "../server/launcher/background-config.js";
import { installLauncher, launcherStatus } from "../server/launcher/install.js";
import { prepareWebUninstall } from "../server/launcher/uninstall.js";

const launch = {
	node: process.execPath,
	loader: fileURLToPath(import.meta.resolve("tsx")),
	entry: fileURLToPath(new URL("../server/main.ts", import.meta.url)),
};

test("root cleanup previews without mutation and stops the owned service before removing its identity", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-uninstall-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const stateDir = join(root, "state"),
		desktopPrefix = join(root, "desktop"),
		directory = join(stateDir, "web/background");
	const config = await newBackgroundConfig(4317, launch, desktopPrefix);
	const files = backgroundPaths(directory),
		calls: string[] = [];
	let failDisable = false;
	const control = async (action: string) => {
		calls.push(action);
		if (action === "disable") {
			assert.ok(await readFile(files.config));
			if (failDisable) throw new Error("fixture stop failure");
		}
		return "";
	};
	await installBackground(directory, config, control, async () => {});
	const options = { stateDir, desktopPrefix, packageRoot: config.packageRoot };
	const start = calls.length;
	const plan = await prepareWebUninstall(options, control);
	assert.deepEqual(
		plan.items.map((item) => item.label),
		["Background service", "Desktop launcher"],
	);
	assert.ok(calls.slice(start).every((action) => action === "show"));
	const unit = await readFile(files.unitFile, "utf8");
	await writeFile(files.unitFile, `${unit}# operator change\n`);
	await assert.rejects(plan.remove(), /ownership/);
	await writeFile(files.unitFile, unit);
	failDisable = true;
	await assert.rejects(plan.remove(), /fixture stop failure/);
	assert.ok(await readFile(files.config));
	assert.equal((await launcherStatus(desktopPrefix)).status, "installed");
	failDisable = false;
	await plan.remove();
	assert.equal((await launcherStatus(desktopPrefix)).status, "absent");
	await assert.rejects(readFile(files.manifest), { code: "ENOENT" });
	assert.deepEqual((await prepareWebUninstall(options, control)).items, []);
});

test("root cleanup preserves changed and foreign desktop entries, and discovers a custom background directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-web-uninstall-custom-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const desktopPrefix = join(root, "desktop"),
		directory = join(root, "custom-background");
	const config = await newBackgroundConfig(4317, launch, desktopPrefix);
	const options = { stateDir: join(root, "state"), desktopPrefix, packageRoot: config.packageRoot };
	await installLauncher(desktopPrefix, launch);
	const desktop = await launcherStatus(desktopPrefix),
		entry = await readFile(desktop.entry, "utf8");
	await writeFile(desktop.entry, `${entry}# custom\n`);
	await assert.rejects(prepareWebUninstall(options), /ownership/);
	await writeFile(desktop.entry, entry);
	await assert.rejects(prepareWebUninstall({ ...options, packageRoot: root }), /another installation/);
	await (await prepareWebUninstall(options)).remove();
	await installBackground(
		directory,
		config,
		async () => "",
		async () => {},
	);
	const plan = await prepareWebUninstall(options, async () => "");
	assert.ok(plan.items.some((item) => item.path === directory));
	await plan.remove();
	assert.equal((await launcherStatus(desktopPrefix)).status, "absent");
});
