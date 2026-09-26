import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { it, mock } from "node:test";
import { stringify } from "yaml";
import { buildCompletionContractAuditRecord } from "../../src/domains/safety/audit.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import { createFinishContractRegistration } from "../../src/domains/safety/finish-contract-registration.js";
import { rigorResolution } from "../../src/domains/safety/rigor.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import {
	captureQualitySnapshot,
	loadQualityPolicy,
	QUALITY_POLICY_PATH,
} from "../../src/tools/verify/quality-policy.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function project(body: (root: string) => Promise<void>): Promise<void> {
	const scratch = await isolateClioEnv("quality-policy-");
	const previous = process.cwd();
	const root = join(scratch.dir, "project");
	try {
		mkdirSync(join(root, ".clio-coder"), { recursive: true });
		mkdirSync(join(root, "src"));
		execFileSync("git", ["init", "--quiet", root]);
		writeFileSync(join(root, "src/solver.ts"), "export const solver = 1;\n");
		writeFileSync(join(root, "check.cjs"), "process.exitCode = 0;\n");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { "test:solver": "node check.cjs", lint: "node check.cjs" } }),
		);
		policy(root);
		process.chdir(root);
		await body(root);
	} finally {
		process.chdir(previous);
		scratch.restore();
	}
}

function policy(root: string, allowLimitations = false, checks = ["test:solver"]): void {
	writeFileSync(
		join(root, QUALITY_POLICY_PATH),
		stringify({
			version: 1,
			rules: [{ id: "solver", paths: ["src/**"], inputs: ["src/**", "check.cjs"], checks, allowLimitations }],
		}),
	);
}

function mutation(filename = "src/solver.ts"): unknown[] {
	return [
		{ kind: "message", role: "user", payload: { text: "Fix solver" } },
		{
			kind: "message",
			role: "tool_call",
			payload: { name: "write", toolCallId: "write-1", args: { path: filename, content: "x" } },
		},
		{ kind: "message", role: "tool_result", payload: { toolCallId: "write-1", result: { kind: "ok" } } },
	];
}

async function verify(
	entries: unknown[],
	args: Record<string, unknown> = { check: "test:solver" },
): Promise<ToolResult> {
	const toolCallId = `verify-${entries.length}`;
	entries.push({ kind: "message", role: "tool_call", payload: { name: "verify", toolCallId, args } });
	const result = await verifyTool.run(args);
	entries.push({
		kind: "message",
		role: "tool_result",
		payload: {
			toolCallId,
			result: { content: [], details: { ...result.details, kind: result.kind } },
			isError: result.kind === "error",
		},
	});
	return result;
}

function limit(entries: unknown[], check = "test:solver"): void {
	const toolCallId = `limitation-${entries.length}`;
	entries.push(
		{
			kind: "message",
			role: "tool_call",
			payload: { name: "limitation", toolCallId, args: { scope: "solver checks", reason: "no-runner", paths: [check] } },
		},
		{ kind: "message", role: "tool_result", payload: { toolCallId, result: { content: [], details: { kind: "ok" } } } },
	);
}

it("discovers required checks and requires every applicable check", async () =>
	project(async (root) => {
		policy(root, false, ["test:solver", "lint"]);
		strictEqual(rigorResolution({ cwd: root }).source, "quality-policy");
		strictEqual(rigorResolution({ cwd: root }).rigor, "high");
		strictEqual(rigorResolution({ cwd: root, override: "normal" }).rigor, "normal");
		const listing = await verifyTool.run({});
		strictEqual(listing.kind, "ok");
		if (listing.kind === "ok") match(listing.output ?? "", /solver: src\/\*\* requires test:solver, lint/u);
		ok(listing.details?.qualityPolicy);
		const entries = mutation();
		await verify(entries);
		let assessment = assessFinishContract({ workspaceRoot: root, sessionEntries: entries });
		deepStrictEqual(
			assessment.quality?.map((finding) => finding.state),
			["passed", "missing"],
		);
		strictEqual(assessment.kind, "engage");
		await verify(entries, { check: "lint" });
		assessment = assessFinishContract({ workspaceRoot: root, sessionEntries: entries });
		strictEqual(assessment.kind, "ok");
		deepStrictEqual(
			assessment.quality?.map((finding) => finding.state),
			["passed", "passed"],
		);
	}));

it("invalidates passing checks after out-of-band source changes, additions and deletions", async () =>
	project(async (root) => {
		const entries = mutation();
		await verify(entries);
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).kind, "ok");
		writeFileSync(join(root, "src/solver.ts"), "export const solver = 2;\n");
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "stale");
		await verify(entries);
		writeFileSync(join(root, "src/new.ts"), "export const added = true;\n");
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "stale");
		await verify(entries);
		rmSync(join(root, "src/new.ts"));
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "stale");
	}));

it("invalidates a staged tracked deletion and accepts fresh verification after it", async () =>
	project(async (root) => {
		execFileSync("git", ["add", "--", "src/solver.ts"], { cwd: root });
		execFileSync(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=Quality fixture",
				"-c",
				"user.email=quality@example.test",
				"commit",
				"--quiet",
				"-m",
				"Track solver",
			],
			{ cwd: root },
		);
		const entries = mutation();
		await verify(entries);
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "passed");
		execFileSync("git", ["rm", "--quiet", "--", "src/solver.ts"], { cwd: root });
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "stale");
		await verify(entries);
		const assessment = assessFinishContract({ workspaceRoot: root, sessionEntries: entries });
		strictEqual(assessment.kind, "ok");
		strictEqual(assessment.quality?.[0]?.state, "passed");
	}));

it("invalidates policy and check declaration changes but ignores unrelated inputs", async () =>
	project(async (root) => {
		const entries = mutation();
		await verify(entries);
		writeFileSync(join(root, "notes.md"), "An unrelated note.");
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "passed");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { "test:solver": "node check.cjs --new-option" } }),
		);
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "stale");
		await verify(entries);
		policy(root, true);
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "stale");
	}));

it("uses the latest outcome in both directions", async () =>
	project(async (root) => {
		const entries = mutation();
		await verify(entries);
		writeFileSync(join(root, "check.cjs"), "process.exitCode = 1;\n");
		strictEqual((await verify(entries)).kind, "error");
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "failed");
		writeFileSync(join(root, "check.cjs"), "process.exitCode = 0;\n");
		await verify(entries);
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "passed");
	}));

it("does not certify a source-mutating check or narrowed invocation", async () =>
	project(async (root) => {
		const entries = mutation();
		writeFileSync(
			join(root, "check.cjs"),
			"require('node:fs').appendFileSync('src/solver.ts', '// changed by check\\n');\n",
		);
		const result = await verify(entries);
		strictEqual(result.kind, "ok");
		deepStrictEqual((result.details?.quality as { stable: boolean }).stable, false);
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "stale");
		writeFileSync(join(root, "check.cjs"), "process.exitCode = 0;\n");
		await verify(entries, { check: "test:solver", args: ["one-test-only"] });
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "stale");
		await verify(entries, { check: "test:solver", cwd: "." });
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "stale");
	}));

it("does not accept shell prose, unpaired receipts, or prior user-turn evidence", async () =>
	project(async (root) => {
		const old: unknown[] = [];
		await verify(old);
		const entries = [
			...old,
			...mutation(),
			{
				kind: "message",
				role: "tool_result",
				payload: { toolCallId: "unpaired", result: { kind: "ok", details: { exitCode: 0 } } },
			},
		];
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "missing");
		entries.push({ kind: "bashExecution", command: "npm run test:solver", exitCode: 0 });
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "missing");
	}));

it("accepts only explicitly permitted, check-scoped limitations and retains unverified status", async () =>
	project(async (root) => {
		const entries = mutation();
		limit(entries);
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).kind, "engage");
		policy(root, true);
		const assessment = assessFinishContract({ workspaceRoot: root, sessionEntries: entries });
		strictEqual(assessment.reason, "explicit_limitation");
		strictEqual(assessment.quality?.[0]?.state, "limited");
		const other = mutation();
		limit(other, "src/solver.ts");
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: other }).kind, "engage");
	}));

it("keeps normal-rigor advisories, requests scoped high-rigor recovery and audits findings", async () =>
	project(async () => {
		const entries = mutation();
		const audits: unknown[] = [];
		const normal = createFinishContractRegistration({
			readSessionEntries: () => entries,
			recordDecision: (input) => audits.push(buildCompletionContractAuditRecord(input)),
		});
		const effects = await normal.evaluate({ hook: "turn_end", text: "Fixed solver." });
		strictEqual(
			effects.some((effect) => effect.kind === "request_continuation"),
			false,
		);
		match(JSON.stringify(effects), /solver\/test:solver: missing/u);
		match(JSON.stringify(audits), /"state":"missing"/u);
		const high = createFinishContractRegistration({ readSessionEntries: () => entries, resolveRigor: () => "high" });
		const recovery = await high.evaluate({ hook: "turn_end", text: "Fixed solver." });
		strictEqual(
			recovery.some((effect) => effect.kind === "request_continuation"),
			true,
		);
		match(JSON.stringify(recovery), /solver\/test:solver: missing/u);
		const restricted = await high.evaluate({
			hook: "turn_end",
			text: "Fixed solver.",
			metadata: { activeToolNames: "read" },
		});
		strictEqual(
			restricted.some((effect) => effect.kind === "request_continuation"),
			false,
		);
		const limitationOnly = await high.evaluate({
			hook: "turn_end",
			text: "Fixed solver.",
			metadata: { activeToolNames: "limitation" },
		});
		strictEqual(
			limitationOnly.some((effect) => effect.kind === "request_continuation"),
			false,
		);
	}));

it("applies only to changed scopes, and policy edits activate all rules", async () =>
	project(async (root) => {
		strictEqual(
			assessFinishContract({ workspaceRoot: root, sessionEntries: mutation("docs/readme.md") }).quality,
			undefined,
		);
		strictEqual(
			assessFinishContract({ workspaceRoot: root, sessionEntries: mutation(QUALITY_POLICY_PATH) }).quality?.[0]?.state,
			"missing",
		);
	}));

it("fails visibly on malformed policies and refuses traversal and symlink inputs", async () =>
	project(async (root) => {
		writeFileSync(join(root, QUALITY_POLICY_PATH), "version: 1\nrules: []\n");
		strictEqual(loadQualityPolicy(root).ok, false);
		strictEqual((await verifyTool.run({ check: "test:solver" })).kind, "error");
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: mutation() }).kind, "engage");
		writeFileSync(
			join(root, QUALITY_POLICY_PATH),
			"version: 1\nrules:\n - id: solver\n   paths: ['../outside/**']\n   checks: [test:solver]\n",
		);
		strictEqual(loadQualityPolicy(root).ok, false);
		policy(root);
		symlinkSync(join(root, "check.cjs"), join(root, "src/linked.ts"));
		const entries = mutation();
		await verify(entries);
		strictEqual(
			assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state,
			"unavailable",
		);
		rmSync(join(root, "src/linked.ts"));
		symlinkSync(join(root, "missing.ts"), join(root, "src/dangling.ts"));
		await verify(entries);
		strictEqual(
			assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state,
			"unavailable",
		);
		rmSync(join(root, "src/dangling.ts"));
		const original = readFileSync(join(root, QUALITY_POLICY_PATH));
		rmSync(join(root, QUALITY_POLICY_PATH));
		writeFileSync(join(root, "policy.yaml"), original);
		symlinkSync(join(root, "policy.yaml"), join(root, QUALITY_POLICY_PATH));
		strictEqual(loadQualityPolicy(root).ok, false);
	}));

it("supports declared catalog checks and derived check provenance", async () =>
	project(async (root) => {
		writeFileSync(
			join(root, ".clio-coder/verifiers.yaml"),
			stringify({
				version: 2,
				checks: [
					{
						id: "solver-contract",
						description: "Check solver",
						command: [process.execPath, "check.cjs"],
						cwd: ".",
						timeoutMs: 5000,
						tags: ["test"],
					},
				],
			}),
		);
		policy(root, false, ["solver-contract"]);
		const entries = mutation();
		strictEqual((await verify(entries, { check: "solver-contract" })).kind, "ok");
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "passed");
		writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "solver"\nversion = "0.1.0"\n');
		policy(root, false, ["cargo-test"]);
		const loaded = loadQualityPolicy(root);
		ok(loaded.ok && loaded.policy);
		if (loaded.ok && loaded.policy)
			strictEqual(captureQualitySnapshot(root, loaded.policy, "cargo-test").check, "cargo-test");
	}));

it("preserves ordinary verification without a policy and diagnoses non-Git snapshot availability", async () =>
	project(async (root) => {
		rmSync(join(root, ".git"), { recursive: true });
		const entries = mutation();
		strictEqual((await verify(entries)).kind, "ok", "snapshot failure must not prevent ordinary verification");
		strictEqual(
			assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state,
			"unavailable",
		);
		rmSync(join(root, QUALITY_POLICY_PATH));
		const result = await verify(entries);
		strictEqual(result.kind, "ok");
		strictEqual(result.details?.quality, undefined);
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).kind, "ok");
		rmSync(join(root, ".clio-coder"), { recursive: true });
		mkdirSync(join(root, "shared-state"));
		symlinkSync(join(root, "shared-state"), join(root, ".clio-coder"));
		strictEqual(
			(await verifyTool.run({ check: "test:solver" })).kind,
			"ok",
			"a state-directory link without a quality policy must preserve ordinary verification",
		);
	}));

it("does not execute repository filesystem-monitor hooks and bounds oversized inputs", async () =>
	project(async (root) => {
		execFileSync("git", ["add", "src/solver.ts"], { cwd: root });
		writeFileSync(join(root, "monitor.cjs"), "require('node:fs').writeFileSync('monitor-ran', 'yes');\n");
		execFileSync("git", ["config", "core.fsmonitor", "node monitor.cjs"], { cwd: root });
		const entries = mutation();
		await verify(entries);
		strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state, "passed");
		strictEqual(existsSync(join(root, "monitor-ran")), false);
		writeFileSync(join(root, "src/large.ts"), Buffer.alloc(4 * 1024 * 1024 + 1));
		strictEqual((await verify(entries)).kind, "ok");
		strictEqual(
			assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).quality?.[0]?.state,
			"unavailable",
		);
	}));

it("does not certify an ignored covered mutation that was absent from its passing snapshot", async () =>
	project(async (root) => {
		writeFileSync(join(root, ".gitignore"), "src/generated.ts\n");
		writeFileSync(join(root, "src/generated.ts"), "export const generated = 1;\n");
		const entries = mutation("src/generated.ts");
		strictEqual((await verify(entries)).kind, "ok");
		writeFileSync(join(root, "src/generated.ts"), "export const generated = 2;\n");
		const assessment = assessFinishContract({ workspaceRoot: root, sessionEntries: entries });
		strictEqual(assessment.kind, "engage");
		strictEqual(assessment.quality?.[0]?.state, "unavailable");
		match(assessment.quality?.[0]?.message ?? "", /outside the Git-enumerated snapshot/u);
	}));

it("rejects directory symlink roots and wildcard ancestors in paths and inputs without following them", async () =>
	project(async (root) => {
		const outside = join(root, "..", "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.ts"), "This must not be read.\n");
		for (const target of [join(root, "missing-directory"), outside]) {
			symlinkSync(target, join(root, "src/linked"), "dir");
			for (const scope of [
				{ paths: ["src/linked/**"] },
				{ paths: ["src/*/**"] },
				{ paths: ["src/solver.ts"], inputs: ["src/linked/**"] },
			]) {
				writeFileSync(
					join(root, QUALITY_POLICY_PATH),
					stringify({ version: 1, rules: [{ id: "solver", checks: ["test:solver"], ...scope }] }),
				);
				const loaded = loadQualityPolicy(root);
				ok(loaded.ok && loaded.policy);
				if (!loaded.ok || !loaded.policy) throw new Error("fixture policy did not load");
				const reads = mock.method(fs, "readFileSync", fs.readFileSync);
				syncBuiltinESMExports();
				try {
					let failure: unknown;
					try {
						captureQualitySnapshot(root, loaded.policy, "test:solver");
					} catch (error) {
						failure = error;
					}
					ok(failure instanceof Error);
					match(failure.message, /symbolic link/u);
					ok(reads.mock.calls.every((call) => !String(call.arguments[0]).includes("secret.ts")));
				} finally {
					reads.mock.restore();
					syncBuiltinESMExports();
				}
			}
			rmSync(join(root, "src/linked"));
		}
	}));

it("retains passing policy findings in the audit when operator acceptance is still outstanding", async () =>
	project(async () => {
		const entries = mutation();
		await verify(entries);
		const audits: ReturnType<typeof buildCompletionContractAuditRecord>[] = [];
		const hook = createFinishContractRegistration({
			readSessionEntries: () => entries,
			resolveRigor: () => "high",
			readActiveAcceptance: () => ({ expectedOutputs: [], verification: [{ check: "lint", timeoutMs: 5000 }] }),
			recordDecision: (input) => audits.push(buildCompletionContractAuditRecord(input)),
		});
		const effects = await hook.evaluate({ hook: "turn_end", text: "Fixed solver." });
		ok(effects.some((effect) => effect.kind === "request_continuation"));
		match(JSON.stringify(effects), /operator acceptance still requires passing validation for: lint/u);
		strictEqual(audits[0]?.decision, "engage");
		strictEqual(audits[0]?.quality?.[0]?.state, "passed");
		strictEqual(audits[0]?.quality?.[0]?.check, "test:solver");
	}));

it("shares Git enumeration, declaration reads and input hashing across checks in one fresh assessment", async () =>
	project(async (root) => {
		const checks = ["typecheck", "lint", "test"];
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: Object.fromEntries(checks.map((check) => [check, "node check.cjs"])) }),
		);
		policy(root, false, checks);
		const entries = mutation();
		for (const check of checks) await verify(entries, { check });
		const reads = mock.method(fs, "readFileSync", fs.readFileSync);
		const commands = mock.method(childProcess, "execFileSync", childProcess.execFileSync);
		syncBuiltinESMExports();
		try {
			strictEqual(assessFinishContract({ workspaceRoot: root, sessionEntries: entries }).kind, "ok");
			strictEqual(reads.mock.calls.filter((call) => String(call.arguments[0]) === join(root, "src/solver.ts")).length, 1);
			strictEqual(
				reads.mock.calls.filter((call) => String(call.arguments[0]) === join(root, "package.json")).length,
				2,
				"one discovery read and one declaration fingerprint",
			);
			strictEqual(
				commands.mock.calls.filter((call) => Array.isArray(call.arguments[1]) && call.arguments[1].includes("ls-files"))
					.length,
				1,
			);
			writeFileSync(join(root, "src/solver.ts"), "export const solver = 2;\n");
			const later = assessFinishContract({ workspaceRoot: root, sessionEntries: entries });
			ok(later.quality?.every((finding) => finding.state === "stale"));
			strictEqual(
				reads.mock.calls.filter((call) => String(call.arguments[0]) === join(root, "src/solver.ts")).length,
				2,
				"the next assessment must read edited source again",
			);
		} finally {
			reads.mock.restore();
			commands.mock.restore();
			syncBuiltinESMExports();
		}
	}));

it("bounds total input reads across disjoint check scopes in one completion assessment", async () =>
	project(async (root) => {
		for (const scope of ["left", "right"]) {
			mkdirSync(join(root, "src", scope));
			for (let index = 0; index < 9; index++)
				writeFileSync(join(root, "src", scope, `${index}.bin`), Buffer.alloc(4 * 1024 * 1024, index));
		}
		writeFileSync(
			join(root, QUALITY_POLICY_PATH),
			stringify({
				version: 1,
				rules: [
					{ id: "left", paths: ["src/left/**"], checks: ["test:solver"] },
					{ id: "right", paths: ["src/right/**"], checks: ["lint"] },
				],
			}),
		);
		const entries = [...mutation("src/left/0.bin"), ...mutation("src/right/0.bin").slice(1)];
		strictEqual((await verify(entries)).kind, "ok");
		strictEqual((await verify(entries, { check: "lint" })).kind, "ok", "independent check snapshots each fit the bound");
		const reads = mock.method(fs, "readFileSync", fs.readFileSync);
		syncBuiltinESMExports();
		try {
			const assessment = assessFinishContract({ workspaceRoot: root, sessionEntries: entries });
			strictEqual(assessment.kind, "engage");
			ok(
				assessment.quality?.some((finding) => finding.state === "unavailable" && finding.message.includes("input bytes")),
			);
			const bytes = reads.mock.calls
				.filter((call) => String(call.arguments[0]).startsWith(join(root, "src")))
				.reduce((sum, call) => sum + (Buffer.isBuffer(call.result) ? call.result.length : 0), 0);
			ok(bytes <= 64 * 1024 * 1024, `completion read ${bytes} source bytes`);
		} finally {
			reads.mock.restore();
			syncBuiltinESMExports();
		}
	}));
