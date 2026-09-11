import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { desktopArgument, desktopEntry } from "../server/launcher/desktop-entry.js";
import { installLauncher, launcherStatus, uninstallLauncher } from "../server/launcher/install.js";

test("Linux launcher installs absolute checkout paths, verifies ownership, and leaves changed or unrelated files alone", async (t) => {
	const prefix = await mkdtemp(join(tmpdir(), "clio web launcher-"));
	t.after(() => rm(prefix, { recursive: true, force: true }));
	const paths = {
		node: process.execPath,
		loader: fileURLToPath(import.meta.resolve("tsx")),
		entry: fileURLToPath(new URL("../server/main.ts", import.meta.url)),
	};
	const installed = await installLauncher(prefix, paths);
	assert.equal(installed.status, "installed");
	const text = await readFile(installed.entry, "utf8");
	assert.equal(text, desktopEntry(paths));
	assert.match(text, /"--open" "--idle-exit" "60000"/);
	assert.match(text, /Terminal=false/);
	const validation = spawnSync("desktop-file-validate", [installed.entry], { encoding: "utf8" });
	if (!validation.error) assert.equal(validation.status, 0, validation.stderr);
	assert.equal((await installLauncher(prefix, paths)).status, "installed");
	assert.equal((await launcherStatus(prefix)).status, "installed");
	await writeFile(join(installed.directory, "unrelated.desktop"), "keep");
	await writeFile(installed.entry, `${text}# User change\n`);
	assert.equal((await launcherStatus(prefix)).status, "conflict");
	await assert.rejects(uninstallLauncher(prefix), /ownership/);
	await assert.rejects(installLauncher(prefix, paths));
	await writeFile(installed.entry, text);
	assert.equal((await uninstallLauncher(prefix)).status, "absent");
	assert.equal(await readFile(join(installed.directory, "unrelated.desktop"), "utf8"), "keep");
	assert.equal((await uninstallLauncher(prefix)).status, "absent");
	const movedEntry = join(prefix, "moved.ts");
	await writeFile(movedEntry, "export {};");
	await installLauncher(prefix, { ...paths, entry: movedEntry });
	await rm(movedEntry);
	assert.equal((await launcherStatus(prefix)).status, "unavailable");
	assert.equal((await uninstallLauncher(prefix)).status, "absent");
	await symlink(join(installed.directory, "unrelated.desktop"), installed.entry);
	await assert.rejects(installLauncher(prefix, paths));
	for (const platform of ["darwin", "win32"] as const)
		await assert.rejects(launcherStatus(prefix, platform), /Linux only/);
	await assert.rejects(launcherStatus("relative"), /absolute/);
});

test("desktop quoting survives GLib parsing of spaces, quotes, backslashes, dollar and percent field codes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "clio-web-launcher-quoting-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const entry = join(dir, 'entry "quote" $literal `tick` %f \\ file.js');
	await writeFile(
		entry,
		'require("node:fs").writeFileSync(process.env.QUOTING_LOG, JSON.stringify(process.argv.slice(2)))',
	);
	const paths = { node: process.execPath, loader: "/not-used", entry };
	const desktop = desktopEntry(paths).replace(`${desktopArgument("--import")} ${desktopArgument(paths.loader)} `, "");
	const file = join(dir, "quoting.desktop"),
		log = join(dir, "args.json");
	await writeFile(file, desktop);
	const launch = spawnSync("gio", ["launch", file], {
		cwd: "/",
		env: { ...process.env, QUOTING_LOG: log },
		encoding: "utf8",
	});
	if (launch.error) {
		t.skip("GLib gio is not installed");
		return;
	}
	assert.equal(launch.status, 0, launch.stderr);
	for (let i = 0; i < 100; i++) {
		try {
			assert.deepEqual(JSON.parse(await readFile(log, "utf8")), ["--open", "--idle-exit", "60000"]);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("GLib did not execute the entry with literal special characters");
});
