import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ConfigEnv, UserConfig } from "vite";
import { staleBundle } from "../client/shell/stale-bundle-model.js";
import { stagedClient } from "../scripts/staged-client.js";

test("a window whose bundle was built for another version than the server's is told to reload, and only then", () => {
	assert.deepEqual(staleBundle("0.6.6", "0.6.7"), {
		title: "This window runs CLIO Coder 0.6.6, and the server runs 0.6.7.",
		detail: "Reload this window to use the version the server runs. It does not reload on its own.",
	});
	assert.equal(staleBundle("0.6.6", "0.6.6"), null);
	// A build that stamped no version, or a server not yet read, never prompts.
	assert.equal(staleBundle(null, "0.6.7"), null);
	assert.equal(staleBundle("0.6.6", undefined), null);
});

test("a client rebuild stages beside the served directory and swaps in only a finished build", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "clio-coder-gui-staged-"));
	try {
		const live = join(scratch, "dist", "client");
		const root = join(scratch, "client");
		const build = (outDir: string) => {
			const plugin = stagedClient(live);
			const config = plugin.config as (config: UserConfig, env: ConfigEnv) => UserConfig | undefined;
			return { plugin, config: config({ root, build: { outDir } }, { command: "build", mode: "production" }) };
		};
		mkdirSync(live, { recursive: true });
		writeFileSync(join(live, "index.html"), "old");
		const { plugin, config } = build("../dist/client");
		assert.deepEqual(config, { build: { outDir: `${live}.next` } });
		mkdirSync(`${live}.next`);
		writeFileSync(join(`${live}.next`, "index.html"), "new");
		// While the build writes, the served directory still holds the previous client.
		assert.equal(readFileSync(join(live, "index.html"), "utf8"), "old");
		(plugin.closeBundle as () => void)();
		assert.equal(readFileSync(join(live, "index.html"), "utf8"), "new");
		assert.deepEqual(readdirSync(join(scratch, "dist")), ["client"]);
		// A failed build leaves the served client as it was.
		const failed = build("../dist/client");
		mkdirSync(`${live}.next`);
		writeFileSync(join(`${live}.next`, "index.html"), "broken");
		(failed.plugin.buildEnd as (error?: Error) => void)(new Error("syntax"));
		(failed.plugin.closeBundle as () => void)();
		assert.equal(readFileSync(join(live, "index.html"), "utf8"), "new");
		// A caller that names its own output directory owns it.
		assert.equal(build(join(scratch, "elsewhere")).config, undefined);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
