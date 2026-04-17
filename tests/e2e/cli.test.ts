import { match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

describe("clio cli e2e", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome();
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("--version exits 0 and prints clio + node versions", async () => {
		const result = await runCli(["--version"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /^clio /m);
		match(result.stdout, /^node /m);
	});

	it("--help exits 0 and prints usage", async () => {
		const result = await runCli(["--help"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /Usage:/);
		match(result.stdout, /clio doctor/);
	});

	it("unknown subcommand exits 2 and prints help", async () => {
		const result = await runCli(["notacmd"], { env: scratch.env });
		strictEqual(result.code, 2);
		match(result.stderr + result.stdout, /unknown subcommand/);
	});

	it("install bootstraps scratch home", async () => {
		const result = await runCli(["install"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /config dir/);
		match(result.stdout, /data dir/);
		match(result.stdout, /cache dir/);
	});

	it("doctor runs and reports findings", async () => {
		await runCli(["install"], { env: scratch.env });
		const result = await runCli(["doctor"], { env: scratch.env, timeoutMs: 20_000 });
		ok(result.code === 0 || result.code === 1, `doctor exit=${result.code}`);
		ok(result.stdout.length > 0, "doctor produced no output");
	});

	it("providers --json --no-probe returns an array", async () => {
		await runCli(["install"], { env: scratch.env });
		const result = await runCli(["providers", "--json", "--no-probe"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout);
		ok(Array.isArray(parsed), "providers --json should emit an array");
	});

	it("agents --json lists built-in recipes", async () => {
		await runCli(["install"], { env: scratch.env });
		const result = await runCli(["agents", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout);
		ok(Array.isArray(parsed) && parsed.length > 0, "expected at least one builtin agent");
	});
});
