import { match, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

function seedTargets(configDir: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml.replace(
		/^targets:.*$/m,
		[
			"targets:",
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

	it("--version exits 0 and prints only the clio version", async () => {
		const result = await runCli(["--version"], { env: scratch.env });
		strictEqual(result.code, 0);
		strictEqual(result.stdout, "clio 0.1.1\n");
	});

	it("--help exits 0 and prints usage", async () => {
		const result = await runCli(["--help"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /Clio Coder command line/);
		match(result.stdout, /Usage:/);
		match(result.stdout, /clio doctor/);
	});

	it("configure --help exits 0 and prints target usage", async () => {
		const result = await runCli(["configure", "--help"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /Configure model targets/);
		match(result.stdout, /clio configure --list/);
	});

	it("unknown subcommand exits 2 and prints help", async () => {
		const result = await runCli(["notacmd"], { env: scratch.env });
		strictEqual(result.code, 2);
		match(result.stderr + result.stdout, /unknown subcommand/);
	});

	it("doctor --fix bootstraps scratch home", async () => {
		const result = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /config dir/);
		match(result.stdout, /data dir/);
		match(result.stdout, /cache dir/);
	});

	it("doctor runs and reports findings", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["doctor"], { env: scratch.env, timeoutMs: 20_000 });
		ok(result.code === 0 || result.code === 1, `doctor exit=${result.code}`);
		ok(result.stdout.length > 0, "doctor produced no output");
		match(result.stdout, /engine runtime/);
	});

	it("doctor does not create state without --fix", async () => {
		const result = await runCli(["doctor"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 1);
		match(result.stdout, /settings.yaml\s+missing/);
	});

	it("targets --json returns an array", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		seedTargets(join(scratch.dir, "config"));
		const result = await runCli(["targets", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout);
		ok(Array.isArray(parsed), "targets --json should emit an array");
		ok(
			parsed.every((row) => row.tier === "cloud"),
			"seeded cloud targets should include a top-level tier",
		);
	});

	it("agents --json lists built-in recipes", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["agents", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout);
		ok(Array.isArray(parsed) && parsed.length > 0, "expected at least one builtin agent");
	});

	it("models --json returns every wire model across targets", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		seedTargets(join(scratch.dir, "config"));
		const result = await runCli(["models", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const rows = JSON.parse(result.stdout) as Array<{ targetId: string; modelId: string }>;
		strictEqual(rows.length, 4);
		ok(rows.some((r) => r.modelId === "gpt-4o"));
		ok(rows.some((r) => r.modelId === "claude-opus-4-6"));
	});

	it("models <search> positional filter keeps only rows whose target/runtime/model contains the term", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		seedTargets(join(scratch.dir, "config"));
		const result = await runCli(["models", "gpt", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const rows = JSON.parse(result.stdout) as Array<{ modelId: string }>;
		strictEqual(rows.length, 2, `expected 2 gpt rows, got ${rows.length}`);
		ok(rows.every((r) => r.modelId.includes("gpt")));
	});

	it("models --target <id> filter keeps only that target's rows", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		seedTargets(join(scratch.dir, "config"));
		const result = await runCli(["models", "--target", "test-anthropic", "--json"], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(result.code, 0);
		const rows = JSON.parse(result.stdout) as Array<{ targetId: string }>;
		strictEqual(rows.length, 2);
		ok(rows.every((r) => r.targetId === "test-anthropic"));
	});

	it("--api-key with no active orchestrator target warns on stderr and exits 0", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["--api-key", "OVERRIDE-sk-flag"], {
			env: scratch.env,
			timeoutMs: 15_000,
		});
		strictEqual(result.code, 0);
		match(result.stderr, /--api-key supplied but no active orchestrator target is configured/);
	});

	it("clio run --api-key with no resolvable target exits 2 with a stderr hint", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["--api-key", "OVERRIDE-sk-flag", "run", "hello"], {
			env: scratch.env,
			timeoutMs: 15_000,
		});
		strictEqual(result.code, 2);
		match(result.stderr, /--api-key supplied but no target resolved/);
	});

	it("models --target <id> <search> combines both filters", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		seedTargets(join(scratch.dir, "config"));
		const result = await runCli(["models", "--target", "test-openai", "mini", "--json"], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(result.code, 0);
		const rows = JSON.parse(result.stdout) as Array<{ targetId: string; modelId: string }>;
		strictEqual(rows.length, 1);
		strictEqual(rows[0]?.modelId, "gpt-4o-mini");
	});

	it("auth login --api-key is parsed by auth, not the global startup flag", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const login = await runCli(["auth", "login", "openai", "--api-key", "sk-e2e"], {
			env: scratch.env,
			timeoutMs: 15_000,
		});
		strictEqual(login.code, 0);
		match(login.stdout, /authenticated openai/);

		const status = await runCli(["auth", "status", "openai"], { env: scratch.env, timeoutMs: 15_000 });
		strictEqual(status.code, 0);
		match(status.stdout, /openai\s+api_key\s+present/);
	});

	it("old lifecycle command names are rejected", async () => {
		for (const command of ["install", "setup", "providers", "list-models", "connect", "disconnect", "login", "logout"]) {
			const result = await runCli([command], { env: scratch.env, timeoutMs: 20_000 });
			strictEqual(result.code, 2, `${command} should be unknown`);
			match(result.stderr + result.stdout, new RegExp(`unknown subcommand: ${command}`));
		}
	});
});
