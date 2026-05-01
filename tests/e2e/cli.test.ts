import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
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
		strictEqual(result.stdout, "Clio Coder 0.1.4\n");
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
		strictEqual(result.stdout, "Clio Coder 0.1.4\n");
	});

	it("-nc alias is accepted at the top level", async () => {
		const result = await runCli(["-nc", "--version"], { env: scratch.env });
		strictEqual(result.code, 0);
		strictEqual(result.stdout, "Clio Coder 0.1.4\n");
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

	it("evolve manifest init prints a valid deterministic template", async () => {
		const first = await runCli(["evolve", "manifest", "init"], { env: scratch.env, timeoutMs: 20_000 });
		const second = await runCli(["evolve", "manifest", "init"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(first.code, 0);
		strictEqual(second.code, 0);
		strictEqual(first.stdout, second.stdout);
		const parsed = JSON.parse(first.stdout) as {
			version: number;
			iterationId: string;
			changes: Array<{ evidenceRefs: string[] }>;
		};
		strictEqual(parsed.version, 1);
		strictEqual(parsed.iterationId, "exploratory-1");
		ok(Array.isArray(parsed.changes[0]?.evidenceRefs));
	});

	it("evolve manifest validate accepts valid manifests and rejects invalid ones", async () => {
		const validPath = join(scratch.dir, "change-manifest.json");
		const invalidPath = join(scratch.dir, "invalid-change-manifest.json");
		writeFileSync(validPath, `${JSON.stringify(changeManifest(), null, 2)}\n`, "utf8");
		writeFileSync(
			invalidPath,
			`${JSON.stringify(
				changeManifest({
					changes: [
						{
							...manifestChange(),
							authorityLevel: "cli",
							predictedRegressions: [],
						},
					],
				}),
				null,
				2,
			)}\n`,
			"utf8",
		);

		const valid = await runCli(["evolve", "manifest", "validate", validPath], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(valid.code, 0);
		match(valid.stdout, /ok: manifest valid \(1 change\)/);

		const invalid = await runCli(["evolve", "manifest", "validate", invalidPath], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(invalid.code, 1);
		match(invalid.stderr, /manifest invalid/);
		match(invalid.stderr, /high-authority changes require an entry/);
	});

	it("evolve manifest summarize prints compact manifest details", async () => {
		const manifestPath = join(scratch.dir, "summary-change-manifest.json");
		writeFileSync(manifestPath, `${JSON.stringify(changeManifest(), null, 2)}\n`, "utf8");

		const result = await runCli(["evolve", "manifest", "summarize", manifestPath], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(result.code, 0);
		match(result.stdout, /iteration: iter-2026-04-29/);
		match(result.stdout, /base sha: abc123/);
		match(result.stdout, /changes: 1/);
		match(result.stdout, /authority levels: cli/);
		match(result.stdout, /components: cli:src\/cli\/evolve.ts/);
		match(result.stdout, /files changed: src\/cli\/evolve.ts/);
		match(result.stdout, /predicted regressions: command parser rejects valid legacy input/);
		match(result.stdout, /validation steps: 2/);
	});

	it("evidence build, inspect, and list operate on run ledger receipts", async () => {
		const fixture = seedEvidenceFixture(join(scratch.dir, "data"));
		const build = await runCli(["evidence", "build", "--run", fixture.runId], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(build.code, 0);
		match(build.stdout, new RegExp(`ok: wrote ${fixture.evidenceId}`));

		const inspect = await runCli(["evidence", "inspect", fixture.evidenceId], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(inspect.code, 0);
		match(inspect.stdout, new RegExp(`evidence: ${fixture.evidenceId}`));
		match(inspect.stdout, /source: run e2e-run/);
		match(inspect.stdout, /blocked tools: 1/);
		match(inspect.stdout, /tags: blocked-tool, session-missing/);
		match(inspect.stdout, /findings: 2/);

		const list = await runCli(["evidence", "list"], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(list.code, 0);
		match(list.stdout, /1 evidence artifacts/);
		match(list.stdout, new RegExp(fixture.evidenceId));
	});

	it("memory commands propose from evidence and manage approval state", async () => {
		const fixture = seedEvidenceFixture(join(scratch.dir, "data"));
		await runCli(["evidence", "build", "--run", fixture.runId], {
			env: scratch.env,
			timeoutMs: 20_000,
		});

		const help = await runCli(["memory", "--help"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(help.code, 0);
		match(help.stdout, /clio memory propose --from-evidence/);

		const empty = await runCli(["memory", "list"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(empty.code, 0);
		match(empty.stdout, /0 memory records/);

		const missing = await runCli(["memory", "propose", "--from-evidence", "missing-evidence"], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(missing.code, 1);
		match(missing.stderr, /evidence artifact not found: missing-evidence/);

		const propose = await runCli(["memory", "propose", "--from-evidence", fixture.evidenceId], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(propose.code, 0, `stdout=${propose.stdout} stderr=${propose.stderr}`);
		match(propose.stdout, /status: proposed/);
		match(propose.stdout, new RegExp(`evidence: ${fixture.evidenceId}`));
		const memoryId = propose.stdout.match(/^memory: (mem-[a-f0-9]{16})$/m)?.[1];
		ok(memoryId, `missing memory id in stdout: ${propose.stdout}`);

		const approve = await runCli(["memory", "approve", memoryId], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(approve.code, 0);
		match(approve.stdout, new RegExp(`approved ${memoryId}`));

		const approvedList = await runCli(["memory", "list"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(approvedList.code, 0);
		match(approvedList.stdout, new RegExp(`${memoryId}\\s+approved\\s+repo`));

		const reject = await runCli(["memory", "reject", memoryId], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(reject.code, 0);
		match(reject.stdout, new RegExp(`rejected ${memoryId}`));

		const rejectedList = await runCli(["memory", "list"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(rejectedList.code, 0);
		match(rejectedList.stdout, new RegExp(`${memoryId}\\s+rejected\\s+repo`));

		const prune = await runCli(["memory", "prune", "--stale"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(prune.code, 0);
		match(prune.stdout, /pruned 0 stale memory records/);
	});

	it("eval run, report, help, and compare routing are wired", async () => {
		const taskFile = join(scratch.dir, "tasks.yaml");
		writeFileSync(
			taskFile,
			[
				"version: 1",
				"tasks:",
				"  - id: cli-pass",
				'    prompt: "Run the verifier."',
				'    cwd: "."',
				"    setup: []",
				"    verifier:",
				'      - "true"',
				"    timeoutMs: 10000",
				"    tags:",
				'      - "cli"',
				"",
			].join("\n"),
			"utf8",
		);

		const help = await runCli(["eval", "--help"], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(help.code, 0);
		match(help.stdout, /clio eval run --task-file/);
		match(help.stdout, /clio eval report/);

		const run = await runCli(["eval", "run", "--task-file", taskFile, "--repeat", "1"], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(run.code, 0, `stdout=${run.stdout} stderr=${run.stderr}`);
		match(run.stdout, /passed: 1/);
		const evalId = run.stdout.match(/^eval: (eval-[^\n]+)$/m)?.[1];
		ok(evalId, `missing eval id in stdout: ${run.stdout}`);
		const evidenceId = run.stdout.match(/^evidence: (eval-[^\n]+)$/m)?.[1];
		ok(evidenceId, `missing evidence id in stdout: ${run.stdout}`);

		const report = await runCli(["eval", "report", evalId], { env: scratch.env, timeoutMs: 20_000 });
		strictEqual(report.code, 0);
		match(report.stdout, new RegExp(`eval: ${evalId}`));
		match(report.stdout, new RegExp(`evidence: ${evidenceId}`));
		match(report.stdout, /tokens: 0/);
		match(report.stdout, /cost USD: 0\.000000/);

		const inspectEvidence = await runCli(["evidence", "inspect", evidenceId], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(inspectEvidence.code, 0);
		match(inspectEvidence.stdout, new RegExp(`evidence: ${evidenceId}`));
		match(inspectEvidence.stdout, new RegExp(`source: eval ${evalId}`));
		match(inspectEvidence.stdout, /tool calls: 1/);

		const rebuildEvidence = await runCli(["evidence", "build", "--eval", evalId], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(rebuildEvidence.code, 0);
		match(rebuildEvidence.stdout, new RegExp(`ok: wrote ${evidenceId}`));

		const compare = await runCli(["eval", "compare", evalId, evalId], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(compare.code, 0);
		match(compare.stdout, new RegExp(`baseline eval: ${evalId}`));
		match(compare.stdout, new RegExp(`candidate eval: ${evalId}`));
		match(compare.stdout, /matching: taskId\+repeatIndex/);
		match(compare.stdout, /matched: 1/);
		match(compare.stdout, /added: 0/);
		match(compare.stdout, /missing: 0/);
		match(compare.stdout, /regressions: 0/);

		const missingCompare = await runCli(["eval", "compare", "missing-eval", evalId], {
			env: scratch.env,
			timeoutMs: 20_000,
		});
		strictEqual(missingCompare.code, 1);
		match(missingCompare.stderr, /eval artifact not found: missing-eval/);
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
		match(status.stdout, /openai\s+OpenAI\s+api_key\s+present/);
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

function changeManifest(overrides: object = {}): object {
	return {
		version: 1,
		iterationId: "iter-2026-04-29",
		baseGitSha: "abc123",
		createdAt: "2026-04-29T00:00:00.000Z",
		changes: [manifestChange()],
		...overrides,
	};
}

function manifestChange(overrides: object = {}): object {
	return {
		id: "change-1",
		componentIds: ["cli:src/cli/evolve.ts"],
		filesChanged: ["src/cli/evolve.ts"],
		authorityLevel: "cli",
		evidenceRefs: ["manual:e2e"],
		rootCause: "The evolution plane lacks a typed manifest command.",
		targetedFix: "Add clio evolve manifest commands.",
		predictedFixes: ["Change proposals become inspectable."],
		predictedRegressions: ["command parser rejects valid legacy input"],
		validationPlan: ["npm run test", "npm run test:e2e"],
		rollbackPlan: "Revert src/cli/evolve.ts and src/domains/evolution.",
		expectedBudgetImpact: {
			risk: "same",
		},
		...overrides,
	};
}

function seedEvidenceFixture(dataDir: string): { runId: string; evidenceId: string } {
	const runId = "e2e-run";
	const receiptPath = join(dataDir, "receipts", `${runId}.json`);
	const envelope: RunEnvelope = {
		id: runId,
		agentId: "scout",
		task: "inspect blocked tool evidence",
		endpointId: "local",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt: "2026-04-29T00:00:00.000Z",
		endedAt: "2026-04-29T00:00:02.000Z",
		status: "completed",
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath,
		sessionId: "session-e2e",
		cwd: "/repo",
		tokenCount: 10,
		costUsd: 0.01,
	};
	const receiptDraft: RunReceiptDraft = {
		runId,
		agentId: "scout",
		task: envelope.task,
		endpointId: "local",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt: envelope.startedAt,
		endedAt: "2026-04-29T00:00:02.000Z",
		exitCode: 0,
		tokenCount: 10,
		costUsd: 0.01,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.3-e2e",
		piMonoVersion: "0.70.2",
		platform: "linux",
		nodeVersion: "v22.0.0",
		toolCalls: 1,
		toolStats: [
			{
				tool: "bash",
				count: 1,
				ok: 0,
				errors: 0,
				blocked: 1,
				totalDurationMs: 25,
			},
		],
		sessionId: "session-e2e",
	};
	mkdirSync(join(dataDir, "state"), { recursive: true });
	mkdirSync(join(dataDir, "receipts"), { recursive: true });
	writeFileSync(join(dataDir, "state", "runs.json"), `${JSON.stringify([envelope], null, 2)}\n`, "utf8");
	writeFileSync(receiptPath, `${JSON.stringify(withReceiptIntegrity(receiptDraft, envelope), null, 2)}\n`, "utf8");
	return { runId, evidenceId: "run-e2e-run" };
}
