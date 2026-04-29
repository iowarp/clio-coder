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

	it("--version exits 0 and prints only the Clio Coder version", async () => {
		const result = await runCli(["--version"], { env: scratch.env });
		strictEqual(result.code, 0);
		strictEqual(result.stdout, "Clio Coder 0.1.3\n");
	});

	it("--help exits 0 and prints usage", async () => {
		const result = await runCli(["--help"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /Clio Coder command line/);
		match(result.stdout, /Usage:/);
		match(result.stdout, /clio doctor/);
		match(result.stdout, /--no-context-files/);
	});

	it("--no-context-files is accepted at the top level without breaking subcommand parsing", async () => {
		const result = await runCli(["--no-context-files", "--version"], { env: scratch.env });
		strictEqual(result.code, 0);
		strictEqual(result.stdout, "Clio Coder 0.1.3\n");
	});

	it("-nc alias is accepted at the top level", async () => {
		const result = await runCli(["-nc", "--version"], { env: scratch.env });
		strictEqual(result.code, 0);
		strictEqual(result.stdout, "Clio Coder 0.1.3\n");
	});

	it("--no-context-files boots the orchestrator (non-interactive) and exits 0", async () => {
		// Real boot smoke: bare `clio` with no subcommand and stdin not a TTY
		// (runCli pipes stdin) routes through `runClioCommand` →
		// `bootOrchestrator`, which loads every domain (including prompts with
		// `noContextFiles: true`) and exits 0 after the non-interactive banner.
		// This proves the cli → orchestrator → prompts-extension plumbing for
		// the flag wires up without crashing, complementing the unit test in
		// tests/unit/prompts.test.ts that asserts the fragment is suppressed.
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["--no-context-files"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0, `expected clean boot, got code=${result.code} stderr=${result.stderr}`);
		match(result.stdout, /Clio Coder/);
		match(result.stdout, /non-interactive boot/);
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

	it("doctor --json emits a machine-readable report", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["doctor", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout) as {
			ok: boolean;
			fix: boolean;
			findings: Array<{ ok: boolean; name: string; detail: string }>;
		};
		strictEqual(parsed.ok, true);
		strictEqual(parsed.fix, false);
		ok(Array.isArray(parsed.findings) && parsed.findings.length > 0, "expected non-empty findings");
		ok(
			parsed.findings.every((f) => typeof f.ok === "boolean" && typeof f.name === "string"),
			"each finding has ok+name",
		);
	});

	it("targets --json returns an object with a targets array", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		seedTargets(join(scratch.dir, "config"));
		const result = await runCli(["targets", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout);
		ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), "targets --json should emit an object");
		ok(Array.isArray(parsed.targets), "targets --json should expose a targets array");
		ok(
			parsed.targets.every((row: { tier: string }) => row.tier === "cloud"),
			"seeded cloud targets should include a top-level tier",
		);
	});

	it("targets --json exposes detectedReasoning and reasoningCandidateModelId so /thinking probe state is observable from CLI", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		seedTargets(join(scratch.dir, "config"));
		const result = await runCli(["targets", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout) as {
			targets: Array<{
				detectedReasoning: boolean | null;
				reasoningCandidateModelId: string | null;
				target: { id: string; defaultModel?: string | null };
			}>;
		};
		ok(Array.isArray(parsed.targets) && parsed.targets.length > 0, "expected at least one seeded target");
		for (const row of parsed.targets) {
			ok(
				Object.hasOwn(row, "detectedReasoning"),
				`target ${row.target.id} must include detectedReasoning (was ${JSON.stringify(row)})`,
			);
			ok(
				Object.hasOwn(row, "reasoningCandidateModelId"),
				`target ${row.target.id} must include reasoningCandidateModelId`,
			);
			// Without --probe the reasoning cache stays cold; assert the
			// negative-detection signal so a regression that swallows the
			// cache miss surfaces here.
			strictEqual(
				row.detectedReasoning,
				null,
				`without --probe the reasoning cache must report null, got ${row.detectedReasoning}`,
			);
		}
	});

	it("agents --json lists built-in recipes", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["agents", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout);
		ok(Array.isArray(parsed) && parsed.length > 0, "expected at least one builtin agent");
	});

	it("components --json lists harness components in a stable envelope", async () => {
		const result = await runCli(["components", "--json"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout) as {
			version: number;
			generatedAt: string;
			root: string;
			components: Array<{ id: string; kind: string; contentHash: string }>;
		};
		strictEqual(parsed.version, 1);
		ok(parsed.root.length > 0);
		ok(/\d{4}-\d{2}-\d{2}T/.test(parsed.generatedAt));
		ok(parsed.components.some((component) => component.id === "context-file:CLIO.md"));
		ok(parsed.components.some((component) => component.id === "safety-rule-pack:base"));
		ok(parsed.components.every((component) => component.contentHash.length === 64));
	});

	it("components snapshot --out writes the JSON snapshot", async () => {
		const outPath = join(scratch.dir, "components", "snapshot.json");
		const result = await runCli(["components", "snapshot", "--out", outPath], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(result.code, 0);
		match(result.stdout, /ok: wrote /);
		const parsed = JSON.parse(readFileSync(outPath, "utf8")) as {
			version: number;
			components: Array<{ id: string }>;
		};
		strictEqual(parsed.version, 1);
		ok(parsed.components.some((component) => component.id === "context-file:CLIO.md"));
	});

	it("components diff --from --to summarizes snapshot changes", async () => {
		const fromPath = join(scratch.dir, "components-from.json");
		const toPath = join(scratch.dir, "components-to.json");
		writeFileSync(fromPath, `${JSON.stringify(componentSnapshot("a", "b"), null, 2)}\n`, "utf8");
		writeFileSync(toPath, `${JSON.stringify(componentSnapshot("c", "b", true), null, 2)}\n`, "utf8");
		const result = await runCli(["components", "diff", "--from", fromPath, "--to", toPath], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(result.code, 0);
		match(result.stdout, /1 added, 0 removed, 1 changed, 1 unchanged/);
		match(result.stdout, /\+ prompt-fragment/);
		match(result.stdout, /~ context-file/);
		match(result.stdout, /\[contentHash\]/);
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

function componentSnapshot(contextHashSeed: string, docHashSeed: string, includeAdded = false): object {
	const components = [
		{
			id: "context-file:CLIO.md",
			kind: "context-file",
			path: "CLIO.md",
			ownerDomain: "repository",
			mutable: true,
			authority: "advisory",
			reloadClass: "hot",
			contentHash: contextHashSeed.repeat(64),
		},
		{
			id: "doc-spec:docs/specs/base.md",
			kind: "doc-spec",
			path: "docs/specs/base.md",
			ownerDomain: "docs",
			mutable: true,
			authority: "descriptive",
			reloadClass: "static",
			contentHash: docHashSeed.repeat(64),
		},
	];
	if (includeAdded) {
		components.push({
			id: "prompt-fragment:src/domains/prompts/fragments/new.md",
			kind: "prompt-fragment",
			path: "src/domains/prompts/fragments/new.md",
			ownerDomain: "prompts",
			mutable: true,
			authority: "advisory",
			reloadClass: "hot",
			contentHash: "d".repeat(64),
		});
	}
	return {
		version: 1,
		generatedAt: "2026-04-29T00:00:00.000Z",
		root: "/repo",
		components,
	};
}
