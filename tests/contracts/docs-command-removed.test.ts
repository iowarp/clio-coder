import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeScratchHome } from "../harness/scratch-env.js";

test("the CLI rejects docs and its former flags while normal help omits it", (t) => {
	const home = makeScratchHome("clio-docs-removed-");
	t.after(home.cleanup);
	const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
	const run = (args: string[]) =>
		spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entry, ...args], {
			env: { ...process.env, ...home.env },
			encoding: "utf8",
			timeout: 20_000,
		});
	const help = run(["--help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.doesNotMatch(help.stdout, /clio-coder docs/u);
	for (const flags of [["--help"], ["--stop"], ["safety", "--no-open"], ["--foreground"]]) {
		const result = run(["docs", ...flags]);
		assert.equal(result.status, 2, result.stdout + result.stderr);
		assert.match(result.stderr, /unknown subcommand: docs/u);
	}
});
