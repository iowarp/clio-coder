import { match, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

function seedEndpoints(configDir: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml.replace(
		/^endpoints:.*$/m,
		[
			"endpoints:",
			"  - id: test-openai",
			"    runtime: openai",
			"    wireModels:",
			"      - gpt-4o",
			"      - gpt-4o-mini",
			"  - id: test-anthropic",
			"    runtime: anthropic",
			"    wireModels:",
			"      - claude-opus-4-6",
			"      - claude-sonnet-4-5",
		].join("\n"),
	);
	writeFileSync(p, patched, "utf8");
}

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
		seedEndpoints(join(scratch.dir, "config"));
		const result = await runCli(["providers", "--json", "--no-probe"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout);
		ok(Array.isArray(parsed), "providers --json should emit an array");
		ok(
			parsed.every((row) => row.tier === "cloud"),
			"seeded cloud endpoints should include a top-level tier",
		);
	});

	it("agents --json lists built-in recipes", async () => {
		await runCli(["install"], { env: scratch.env });
		const result = await runCli(["agents", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout);
		ok(Array.isArray(parsed) && parsed.length > 0, "expected at least one builtin agent");
	});

	it("list-models --json returns every wire model across endpoints", async () => {
		await runCli(["install"], { env: scratch.env });
		seedEndpoints(join(scratch.dir, "config"));
		const result = await runCli(["list-models", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const rows = JSON.parse(result.stdout) as Array<{ endpointId: string; modelId: string }>;
		strictEqual(rows.length, 4);
		ok(rows.some((r) => r.modelId === "gpt-4o"));
		ok(rows.some((r) => r.modelId === "claude-opus-4-6"));
	});

	it("list-models <search> positional filter keeps only rows whose endpoint/runtime/model contains the term", async () => {
		await runCli(["install"], { env: scratch.env });
		seedEndpoints(join(scratch.dir, "config"));
		const result = await runCli(["list-models", "gpt", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const rows = JSON.parse(result.stdout) as Array<{ modelId: string }>;
		strictEqual(rows.length, 2, `expected 2 gpt rows, got ${rows.length}`);
		ok(rows.every((r) => r.modelId.includes("gpt")));
	});

	it("list-models --endpoint <id> filter keeps only that endpoint's rows", async () => {
		await runCli(["install"], { env: scratch.env });
		seedEndpoints(join(scratch.dir, "config"));
		const result = await runCli(["list-models", "--endpoint", "test-anthropic", "--json"], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(result.code, 0);
		const rows = JSON.parse(result.stdout) as Array<{ endpointId: string }>;
		strictEqual(rows.length, 2);
		ok(rows.every((r) => r.endpointId === "test-anthropic"));
	});

	it("--api-key with no active orchestrator endpoint warns on stderr and exits 0", async () => {
		await runCli(["install"], { env: scratch.env });
		const result = await runCli(["--api-key", "OVERRIDE-sk-flag"], {
			env: scratch.env,
			timeoutMs: 15_000,
		});
		strictEqual(result.code, 0);
		match(result.stderr, /--api-key supplied but no active orchestrator endpoint is configured/);
	});

	it("clio run --api-key with no resolvable endpoint exits 2 with a stderr hint", async () => {
		await runCli(["install"], { env: scratch.env });
		const result = await runCli(["--api-key", "OVERRIDE-sk-flag", "run", "hello"], {
			env: scratch.env,
			timeoutMs: 15_000,
		});
		strictEqual(result.code, 2);
		match(result.stderr, /--api-key supplied but no endpoint resolved/);
	});

	it("list-models --endpoint <id> <search> combines both filters", async () => {
		await runCli(["install"], { env: scratch.env });
		seedEndpoints(join(scratch.dir, "config"));
		const result = await runCli(["list-models", "--endpoint", "test-openai", "mini", "--json"], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(result.code, 0);
		const rows = JSON.parse(result.stdout) as Array<{ endpointId: string; modelId: string }>;
		strictEqual(rows.length, 1);
		strictEqual(rows[0]?.modelId, "gpt-4o-mini");
	});
});
