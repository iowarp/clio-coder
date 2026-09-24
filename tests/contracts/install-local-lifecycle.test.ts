import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeScratchHome } from "../harness/scratch-env.js";

test("source installer applies migrations before repair and supports launcher paths containing spaces", (t) => {
	const home = makeScratchHome("clio-source-install-");
	t.after(home.cleanup);
	const checkout = join(home.dir, "source checkout");
	const bin = join(home.dir, "my bin");
	const log = join(home.dir, "calls.jsonl");
	mkdirSync(join(checkout, "scripts"), { recursive: true });
	mkdirSync(join(checkout, "dist/cli"), { recursive: true });
	copyFileSync(new URL("../../scripts/install-local.sh", import.meta.url), join(checkout, "scripts/install-local.sh"));
	writeFileSync(join(checkout, "package.json"), '{"name":"@iowarp/clio-coder","engines":{"node":">=22.19.0"}}');
	writeFileSync(
		join(checkout, "dist/cli/index.js"),
		`#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2))+'\\n'); if (process.argv[2] === '--version') console.log('Clio fixture'); if (process.argv[2] === 'upgrade' && process.env.FAIL_MIGRATION) process.exitCode = 1;`,
	);
	const run = (env: NodeJS.ProcessEnv = {}) =>
		spawnSync("bash", [join(checkout, "scripts/install-local.sh"), "--skip-deps", "--no-build"], {
			env: { ...process.env, ...home.env, CLIO_CODER_BIN_DIR: bin, CALL_LOG: log, ...env },
			encoding: "utf8",
			timeout: 15_000,
		});
	const first = run();
	assert.equal(first.status, 0, first.stdout + first.stderr);
	assert.match(first.stdout, /ok: Clio fixture/);
	assert.deepEqual(
		readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line)),
		[["--version"], ["upgrade", "--post-install"], ["doctor", "--fix"]],
	);
	writeFileSync(log, "");
	const failure = run({ FAIL_MIGRATION: "1" });
	assert.equal(failure.status, 1, failure.stdout + failure.stderr);
	assert.doesNotMatch(readFileSync(log, "utf8"), /doctor/);
});
