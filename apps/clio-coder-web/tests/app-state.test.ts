import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WorkspaceService } from "../server/services/workspaces.js";
import { AppFiles } from "../server/state/files.js";
import { scratchHome } from "./harness/scratch-home.js";

test("app state serializes concurrent owners across three processes without lost rows", {
	timeout: 20000,
}, async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const state = join(home.path, "state"),
		files = new AppFiles(state);
	const children = Array.from(
		{ length: 3 },
		() =>
			new Promise<void>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					["--import", "tsx", fileURLToPath(new URL("./fixtures/state-writer.mjs", import.meta.url)), state],
					{ stdio: ["ignore", "ignore", "pipe"] },
				);
				let stderr = "";
				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});
				child.once("error", reject);
				child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`State writer ${code}: ${stderr}`))));
			}),
	);
	await Promise.all(children);
	const rows = await files.read("children");
	assert.ok(Array.isArray(rows));
	assert.equal(rows.length, 45);
	assert.equal(new Set(rows).size, 45);
});

test("workspace identity uses canonical directories and app state refuses symlink escape", async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const state = join(home.path, "state"),
		work = join(home.path, "workspace"),
		alias = join(home.path, "alias");
	await mkdir(work);
	await symlink(work, alias);
	const service = new WorkspaceService(new AppFiles(state));
	const a = await service.open(work),
		b = await service.open(alias);
	assert.equal(a.id, b.id);
	assert.equal(b.path, work);
	assert.equal((await service.list()).length, 1);
	await assert.rejects(service.open("relative"), /absolute/);
	const other = join(home.path, "other-state");
	await mkdir(other);
	await symlink(work, join(other, "web"));
	await assert.rejects(new AppFiles(other).read("children"), /escapes/);
});
