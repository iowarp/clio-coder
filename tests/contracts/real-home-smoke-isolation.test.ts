import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/smoke-real-home.sh");
test("real-home smoke resolves canonical config then pins all scratch roots before any mutation", {
	skip: process.platform === "win32",
}, () => {
	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-smoke-isolation-"));
	try {
		const bin = join(scratch, "bin"),
			config = join(scratch, "operator-config"),
			record = join(scratch, "calls.jsonl");
		mkdirSync(bin);
		mkdirSync(config);
		writeFileSync(join(config, "settings.yaml"), "fixture-settings\n");
		writeFileSync(join(config, "credentials.yaml"), "private-fixture\n", { mode: 0o600 });
		const wrapper = join(bin, "node");
		writeFileSync(
			wrapper,
			`#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '-e') {
 const result = cp.spawnSync(process.execPath, args, { stdio: 'inherit' });
 process.exit(result.status ?? 1);
}
const command = args[1];
if (command === 'paths') {
 console.log(JSON.stringify({ config: process.env.CLIO_CODER_CONFIG_DIR }));
 process.exit(0);
}
const roots = ['CONFIG','DATA','STATE','CACHE'].map(role => process.env['CLIO_CODER_' + role + '_DIR']);
if (roots.some(root => !root || !root.startsWith(process.env.CLIO_CODER_HOME + path.sep))) process.exit(31);
if (fs.readFileSync(path.join(roots[0], 'settings.yaml'), 'utf8') !== 'fixture-settings\\n') process.exit(32);
if (fs.readFileSync(path.join(roots[0], 'credentials.yaml'), 'utf8') !== 'private-fixture\\n') process.exit(33);
fs.appendFileSync(process.env.CLIO_SMOKE_TEST_RECORD, JSON.stringify({ command, args: args.slice(1), roots, home: process.env.CLIO_CODER_HOME }) + '\\n');
for (const root of roots) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'fixture-write'), 'scratch only'); }
if (command === 'run') console.log(JSON.stringify({ type: 'agent_end' }));
`,
		);
		chmodSync(wrapper, 0o755);
		const overrides = Object.fromEntries(
			["DATA", "STATE", "CACHE"].map((role) => [`CLIO_CODER_${role}_DIR`, join(scratch, `operator-${role}`)]),
		);
		const result = spawnSync("bash", [script, "--target", "fixture-target", "--model", "fixture/model", "--strict"], {
			encoding: "utf8",
			timeout: 15000,
			env: {
				...process.env,
				...overrides,
				PATH: `${bin}${delimiter}${process.env.PATH}`,
				TMPDIR: scratch,
				CLIO_CODER_CONFIG_DIR: config,
				CLIO_CODER_HOME: join(scratch, "operator-home"),
				CLIO_SMOKE_TEST_RECORD: record,
			},
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /smoke-real-home: ok/);
		assert.ok(!result.stdout.includes("private-fixture"));
		const calls = readFileSync(record, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			calls.map((call) => call.command),
			["doctor", "doctor", "run"],
		);
		assert.ok(calls[2].args.includes("fixture-target") && calls[2].args.includes("fixture/model"));
		for (const call of calls) assert.equal(existsSync(call.home), false, "Scratch state is removed after completion");
		for (const path of [config, ...Object.values(overrides)])
			assert.equal(existsSync(join(path, "fixture-write")), false);
		assert.equal(readFileSync(join(config, "settings.yaml"), "utf8"), "fixture-settings\n");
		assert.equal(readFileSync(join(config, "credentials.yaml"), "utf8"), "private-fixture\n");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("real-home smoke rejects missing option values before copying settings", {
	skip: process.platform === "win32",
}, () => {
	for (const flag of ["--settings", "--target", "--model"]) {
		const result = spawnSync("bash", [script, flag], { encoding: "utf8", timeout: 5000 });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /requires a value/);
	}
});
