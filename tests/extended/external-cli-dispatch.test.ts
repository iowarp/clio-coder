import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainName } from "../../src/core/domain-loader.js";
import { renderPromptContext } from "../../src/domains/context/prompt-context.js";
import { closeAgentLedger, openAgentLedger, readAgentLedger } from "../../src/domains/dispatch/agent-ledger-store.js";
import codexCliRuntime from "../../src/domains/providers/runtimes/codex/codex-cli.js";
import { opencodeCliRuntime, piCliRuntime } from "../../src/domains/providers/runtimes/external-cli-peers.js";
import { verifyRunRecordReport } from "../../src/interactive/view/artifacts.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const FAKE_CODEX = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
for await (const chunk of process.stdin) {}
const cwd = process.cwd();
const scenario = JSON.parse(readFileSync(join(cwd, "scenario.json"), "utf8"));
writeFileSync(join(cwd, "started"), "yes");
if (scenario.hang) setInterval(() => {}, 1000);
else {
  const answer = JSON.stringify({
    mutatedPaths: [], validations: [{ name: "fixture", passed: true, evidence: "PONG" }], summary: "PONG"
  });
  for (const event of [
    { type: "thread.started", thread_id: "fixture-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: answer } },
    { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }
  ]) process.stdout.write(JSON.stringify(event) + "\\n");
}
`;

let root: string;
let previousPath: string | undefined;
const sessionCwd = process.cwd();

beforeEach(async () => {
	await isolateDispatchState();
	root = mkdtempSync(join(tmpdir(), "clio-external-dispatch-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const executable = join(bin, "codex");
	writeFileSync(executable, FAKE_CODEX);
	chmodSync(executable, 0o755);
	writeFileSync(join(root, "scenario.json"), JSON.stringify({ hang: false }));
	previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
});

afterEach(() => {
	process.chdir(sessionCwd);
	process.env.PATH = previousPath;
	rmSync(root, { recursive: true, force: true });
	restoreDispatchState();
});

test("managed Codex CLI dispatch seals success and cancellation receipts", { timeout: 20_000 }, async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "codex-test", runtime: "codex-cli", defaultModel: "codex-cli-default" }];
	settings.fleet.default.target = "codex-test";
	settings.fleet.default.model = "codex-cli-default";
	settings.fleet.retry.maxRetries = 0;
	settings.safety.autonomy = "default";
	const bundle = makeDispatchBundle(
		dispatchStubContext({
			settings,
			runtime: codexCliRuntime,
			agentTools: ["read", "write"],
			useRuntimeDefaultAgentBudget: true,
		}),
		{
			getFlowPolicy: () => ({
				version: 1,
				policyHash: "ledger-flow",
				trusted: true,
				refusal: null,
				rules: [
					{
						id: "private",
						policyHash: "ledger-flow",
						paths: { root, sources: ["private"] },
						tools: [],
						recipients: [`target:${JSON.stringify(["codex-test", "codex-cli", null])}`],
						dangling: [],
					},
				],
			}),
		},
	);
	await bundle.extension.start();
	try {
		await openAgentLedger("external-board");
		const request = {
			ledger: { id: "external-board", sequence: 0 },
			agentId: "coder",
			target: "codex-test",
			task: "Reply PONG",
			readOnly: true as const,
			executionRole: "researcher" as const,
			requestOrigin: "user" as const,
			cwd: root,
		};
		const success = await bundle.contract.dispatch(request);
		const receipt = await success.finalPromise;
		ok(success.runId);
		equal(receipt.outcome, "succeeded");
		equal(receipt.exitCode, 0);
		match(receipt.output?.text ?? "", /PONG/);
		deepStrictEqual(receipt.spend.totalTokens, { kind: "measured", value: 4, source: "provider" });
		deepStrictEqual(receipt.externalTelemetry, {
			tokenUsage: "provider-reported",
			cost: "missing",
			sessionId: "fixture-thread",
			exitReason: "stop",
			toolTelemetry: "unavailable",
		});
		equal(receipt.spend.pricing.usd.kind, "unknown");
		equal(receipt.reproducibility?.cwd, root);
		const stateDir = process.env.CLIO_CODER_STATE_DIR;
		ok(stateDir);
		ok(verifyRunRecordReport(stateDir, success.runId).ok);

		writeFileSync(join(root, "scenario.json"), JSON.stringify({ hang: true }));
		rmSync(join(root, "started"), { force: true });
		const hanging = await bundle.contract.dispatch(request);
		const deadline = Date.now() + 5_000;
		while (!existsSync(join(root, "started"))) {
			ok(Date.now() < deadline, "fake CLI did not start");
			await sleep(10);
		}
		bundle.contract.abort(hanging.runId);
		const canceled = await hanging.finalPromise;
		equal(canceled.outcome, "canceled");
		ok(canceled.exitCode !== 0);
		equal(canceled.externalTelemetry?.exitReason, "aborted");
		ok(verifyRunRecordReport(stateDir, hanging.runId).ok);
		deepStrictEqual(bundle.contract.snapshot().running, []);
		await closeAgentLedger("external-board");
		const reports = readAgentLedger("external-board")?.entries ?? [];
		deepStrictEqual(
			reports.map((entry) => [entry.runId, entry.source]),
			[
				[success.runId, "receipt"],
				[hanging.runId, "receipt"],
			],
		);
		match(JSON.stringify(reports[0]?.body), /succeeded[\s\S]*PONG/);
		equal(receipt.safety?.flowRestrictions?.restrictions[0]?.ruleId, "private");
		deepStrictEqual(reports[0]?.flowRestrictions, receipt.safety?.flowRestrictions);
		match(JSON.stringify(reports[1]?.body), /canceled/);
	} finally {
		await bundle.extension.stop?.();
	}
});

test("a delegated Codex CLI run reads one compiled rule set in place of its AGENTS.md", {
	timeout: 30_000,
}, async () => {
	execFileSync("git", ["init", "-q", root]);
	// The session runs from the fixture repository, so its handbook is the session's and not a sister's.
	process.chdir(root);
	writeFileSync(
		join(root, "bin", "codex"),
		`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(join(process.cwd(), "seen.json"), JSON.stringify({ argv: process.argv.slice(2), stdin }));
const answer = JSON.stringify({ mutatedPaths: [], validations: [{ name: "fixture", passed: true, evidence: "PONG" }], summary: "PONG" });
for (const event of [
  { type: "thread.started", thread_id: "peer-thread" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: answer } },
  { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } },
]) process.stdout.write(JSON.stringify(event) + "\\n");
`,
	);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
	writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "cart.ts"), "export const cents = (value: number): number => value;\n");
	const sectioned =
		"# Demo\n\nDemo prices carts.\n\n## Hard invariants\n\n1. Never write to the operator's real home from tests.\n";
	writeFileSync(join(root, "CLIO-CODER.md"), sectioned);
	writeFileSync(
		join(root, "AGENTS.md"),
		"# Notes\n\n- Money is integer cents; see `src/cart.ts`.\n- Run `pnpm run test:all` before committing.\n",
	);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "codex-test", runtime: "codex-cli", defaultModel: "codex-cli-default" }];
	settings.fleet.default.target = "codex-test";
	settings.fleet.default.model = "codex-cli-default";
	settings.fleet.retry.maxRetries = 0;
	settings.safety.autonomy = "default";
	const base = dispatchStubContext({ settings, runtime: codexCliRuntime, agentTools: ["read", "write"] });
	const bundle = makeDispatchBundle({
		...base,
		getContract: ((name: DomainName) =>
			name === "context" ? { renderPromptContext } : base.getContract(name)) as typeof base.getContract,
	});
	await bundle.extension.start();
	const run = async () => {
		const dispatched = await bundle.contract.dispatch({
			agentId: "coder",
			target: "codex-test",
			task: "Reply PONG",
			readOnly: true,
			executionRole: "researcher",
			requestOrigin: "user",
			cwd: root,
		});
		const receipt = await dispatched.finalPromise;
		equal(receipt.outcome, "succeeded", receipt.failureMessage);
		const seen = JSON.parse(readFileSync(join(root, "seen.json"), "utf8")) as { argv: string[]; stdin: string };
		rmSync(join(root, "seen.json"));
		return { receipt, ...seen };
	};
	try {
		// Single source: Codex skips its AGENTS.md and reads the compiled rules alone.
		const single = await run();
		ok(single.argv.join(" ").includes("-c project_doc_max_bytes=0"), single.argv.join(" "));
		ok(single.stdin.includes("Never write to the operator's real home from tests."), single.stdin);
		ok(single.stdin.includes("Money is integer cents; see `src/cart.ts`."), single.stdin);
		ok(single.stdin.includes("The test command is `pnpm run test`, from `package.json` `scripts.test`."), single.stdin);
		ok(!single.stdin.includes("test:all"), single.stdin);
		const compiled = single.stdin.slice(
			single.stdin.indexOf("<project-handbook"),
			single.stdin.indexOf("</project-rules>"),
		);
		ok(compiled.length > 0, single.stdin);
		ok(!/AGENTS\.md|\bignore|\boverrid|\bcorrect/iu.test(compiled), compiled);
		deepStrictEqual(single.receipt.projectContext?.peerInstructions, {
			delivery: "single-source",
			files: ["AGENTS.md"],
			stale: 1,
			notCarried: 0,
		});
		// Coexist: a handbook of prose alone keeps its usual message, and Codex reads AGENTS.md beside it.
		writeFileSync(join(root, "CLIO-CODER.md"), "Demo prices carts. Keep money in integer cents.\n");
		const coexist = await run();
		ok(!coexist.argv.includes("project_doc_max_bytes=0"), coexist.argv.join(" "));
		ok(coexist.stdin.includes("Keep money in integer cents."), coexist.stdin);
		deepStrictEqual(coexist.receipt.projectContext?.peerInstructions, {
			delivery: "coexist",
			files: ["AGENTS.md"],
			stale: 1,
			notCarried: 0,
		});
	} finally {
		await bundle.extension.stop?.();
	}
});

test("OpenCode in a task worktree reads the compiled rules from its AGENTS.md, which never lands", {
	timeout: 30_000,
}, async () => {
	execFileSync("git", ["init", "-q", root]);
	// The session runs from the fixture repository, so its handbook is the session's and not a sister's.
	process.chdir(root);
	execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
	execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
	const seenPath = join(root, "bin", "seen.json");
	writeFileSync(
		join(root, "bin", "opencode"),
		`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(seenPath)}, JSON.stringify({ agents: readFileSync("AGENTS.md", "utf8"), stdin }));
writeFileSync("src/cart.ts", "export const cents = (value: number): number => Math.round(value);\\n");
appendFileSync("AGENTS.md", "- An edit the task did not ask for.\\n");
const answer = JSON.stringify({ mutatedPaths: ["src/cart.ts"], validations: [{ name: "fixture", passed: true, evidence: "edited" }], summary: "edited" });
for (const event of [
  { type: "text", sessionID: "session-1", part: { type: "text", text: answer } },
  { type: "step_finish", sessionID: "session-1", part: { type: "step-finish", cost: 0, tokens: { input: 3, output: 1 } } },
]) process.stdout.write(JSON.stringify(event) + "\\n");
`,
	);
	chmodSync(join(root, "bin", "opencode"), 0o755);
	writeFileSync(join(root, ".gitignore"), "bin/\n");
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
	writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "cart.ts"), "export const cents = (value: number): number => value;\n");
	writeFileSync(
		join(root, "CLIO-CODER.md"),
		"# Demo\n\nDemo prices carts.\n\n## Hard invariants\n\n1. Never write to the operator's real home from tests.\n",
	);
	const agents =
		"# Notes\n\n- Money is integer cents; see `src/cart.ts`.\n- Run `pnpm run test:all` before committing.\n";
	writeFileSync(join(root, "AGENTS.md"), agents);
	execFileSync("git", ["-C", root, "add", "."]);
	execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "opencode-test", runtime: "opencode-cli", defaultModel: "opencode-cli-default", trustedUnmediated: true },
	];
	settings.fleet.default.target = "opencode-test";
	settings.fleet.default.model = "opencode-cli-default";
	settings.fleet.retry.maxRetries = 0;
	settings.safety.autonomy = "default";
	const base = dispatchStubContext({
		settings,
		runtime: opencodeCliRuntime,
		agentTools: ["read", "write"],
		useRuntimeDefaultAgentBudget: true,
	});
	// Placement runs between the prompt and the spawn: a locked worktree root there makes the overlay write fail.
	let lockWorktree = false;
	const bundle = makeDispatchBundle(
		{
			...base,
			getContract: ((name: DomainName) =>
				name === "context" ? { renderPromptContext } : base.getContract(name)) as typeof base.getContract,
		},
		{
			resolveNode: (req) => {
				if (lockWorktree && req.taskWorktree !== undefined) chmodSync(req.taskWorktree.path, 0o555);
				return null;
			},
		},
	);
	await bundle.extension.start();
	const run = async (task: string) => {
		const dispatched = await bundle.contract.dispatch({
			agentId: "coder",
			target: "opencode-test",
			task,
			worktree: true,
			apply: "preserve",
			executionRole: "builder",
			requestOrigin: "user",
			cwd: root,
		});
		const receipt = await dispatched.finalPromise;
		equal(receipt.outcome, "succeeded", receipt.failureMessage);
		const seen = JSON.parse(readFileSync(seenPath, "utf8")) as { agents: string; stdin: string };
		rmSync(seenPath);
		return { receipt, ...seen };
	};
	try {
		const overlaid = await run("Round the cart total");
		ok(overlaid.agents.includes("Never write to the operator's real home from tests."), overlaid.agents);
		ok(overlaid.agents.includes("Money is integer cents; see `src/cart.ts`."), overlaid.agents);
		ok(overlaid.agents.includes("The test command is `pnpm run test`, from `package.json` `scripts.test`."));
		ok(!overlaid.agents.includes("test:all"), overlaid.agents);
		ok(!overlaid.stdin.includes("<project-rules>"), "the rules are not sent twice");
		deepStrictEqual(overlaid.receipt.projectContext?.peerInstructions, {
			delivery: "overlay",
			files: ["AGENTS.md"],
			stale: 1,
			notCarried: 0,
		});
		const worktree = overlaid.receipt.worktree;
		ok(worktree?.commit);
		deepStrictEqual(worktree.changedPaths, ["src/cart.ts"]);
		equal(readFileSync(join(worktree.path, "AGENTS.md"), "utf8"), agents);
		equal(execFileSync("git", ["-C", worktree.path, "status", "--porcelain"], { encoding: "utf8" }), "");
		equal(execFileSync("git", ["-C", root, "show", `${worktree.commit}:AGENTS.md`], { encoding: "utf8" }), agents);
		equal(readFileSync(join(root, "AGENTS.md"), "utf8"), agents);

		// A task that names the file edits the real one, so the harness reads it as it is.
		const named = await run("Tidy AGENTS.md and round the cart total");
		equal(named.agents, agents);
		equal(named.receipt.projectContext?.peerInstructions?.delivery, "coexist");
		ok(named.stdin.includes("<project-rules>"), named.stdin);

		// An overlay that cannot be written leaves the harness its own file and sends the rules in the message.
		lockWorktree = true;
		const unwritable = await run("Round the cart total");
		lockWorktree = false;
		const locked = unwritable.receipt.worktree?.path;
		ok(locked);
		chmodSync(locked, 0o755);
		equal(unwritable.agents, agents);
		equal(unwritable.receipt.projectContext?.peerInstructions?.delivery, "coexist");
		ok(unwritable.stdin.includes("The test command is `pnpm run test`, from `package.json` `scripts.test`."));
		equal(execFileSync("git", ["-C", locked, "ls-files", "-v", "AGENTS.md"], { encoding: "utf8" }), "H AGENTS.md\n");
	} finally {
		await bundle.extension.stop?.();
	}
});

test("managed Pi CLI dispatch seals peer-estimated cost and session identity", { timeout: 20_000 }, async () => {
	const executable = join(root, "bin", "pi");
	writeFileSync(
		executable,
		`#!/usr/bin/env node
for await (const chunk of process.stdin) {}
const answer = JSON.stringify({
  mutatedPaths: [], validations: [{ name: "fixture", passed: true, evidence: "PONG" }], summary: "PONG"
});

for (const event of [
  { type: "session", id: "pi-session" },
  { type: "message_end", message: { role: "assistant", model: "fixture", responseId: "pi-response",
    content: [{ type: "text", text: answer }], stopReason: "stop",
    usage: { input: 8, output: 4, totalTokens: 12, cost: { total: 0.02 } } } },
  { type: "agent_settled" }
]) process.stdout.write(JSON.stringify(event) + "\\n");
`,
	);
	chmodSync(executable, 0o755);
	const settings = structuredClone(DEFAULT_SETTINGS);
	// Pi has no OS read-only sandbox, so it runs only write-capable work, and only trusted.
	settings.targets = [{ id: "pi-test", runtime: "pi-cli", defaultModel: "pi-cli-default", trustedUnmediated: true }];
	settings.fleet.default.target = "pi-test";
	settings.fleet.default.model = "pi-cli-default";
	settings.fleet.retry.maxRetries = 0;
	settings.safety.autonomy = "default";
	const bundle = makeDispatchBundle(
		dispatchStubContext({
			settings,
			runtime: piCliRuntime,
			agentTools: ["read", "write"],
			useRuntimeDefaultAgentBudget: true,
		}),
	);
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch({
			agentId: "coder",
			target: "pi-test",
			task: "Reply PONG",
			executionRole: "researcher",
			requestOrigin: "user",
			cwd: root,
		});
		const receipt = await run.finalPromise;
		equal(receipt.outcome, "succeeded");
		deepStrictEqual(receipt.spend.totalTokens, { kind: "measured", value: 12, source: "provider" });
		deepStrictEqual(receipt.spend.pricing, {
			usd: { kind: "estimated", value: 0.02, method: "peer-report" },
			pricedBy: "provider",
		});
		deepStrictEqual(receipt.externalTelemetry, {
			tokenUsage: "provider-reported",
			cost: "peer-estimated",
			sessionId: "pi-session",
			exitReason: "stop",
			toolTelemetry: "unavailable",
		});
		const stateDir = process.env.CLIO_CODER_STATE_DIR;
		ok(stateDir);
		ok(verifyRunRecordReport(stateDir, run.runId).ok);
	} finally {
		await bundle.extension.stop?.();
	}
});

test("external edits distinguish current checkout, preserved worktree, and failed partial work", {
	timeout: 30_000,
}, async () => {
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
	execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "base.txt"), "base");
	execFileSync("git", ["-C", root, "add", "base.txt"]);
	execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
	const executable = join(root, "bin", "codex");
	writeFileSync(
		executable,
		`#!/usr/bin/env node
	import { writeFileSync } from "node:fs";
	import { join } from "node:path";
	let prompt = "";
	for await (const chunk of process.stdin) prompt += String(chunk);
	const failed = prompt.includes("Fail after edit");
	const changed = failed ? "failed.txt" : "changed.txt";
	writeFileSync(join(process.cwd(), changed), "edited by peer");
	const answer = JSON.stringify({
		mutatedPaths: [changed],
		validations: [{ name: "fixture", passed: true, evidence: "file written" }],
		summary: "edited",
	});
	for (const event of [
		{ type: "thread.started", thread_id: "edit-thread" },
		{ type: "turn.started" },
		{ type: "item.completed", item: { type: "agent_message", text: answer } },
		failed
			? { type: "turn.failed", error: { message: "fixture failure" } }
			: { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } },
	])
		process.stdout.write(JSON.stringify(event) + "\\n");
	`,
	);
	chmodSync(executable, 0o755);
	const settings = structuredClone(DEFAULT_SETTINGS);
	// Write-capable work on an unmediated CLI needs the operator's explicit trust (Q6).
	settings.targets = [
		{ id: "codex-test", runtime: "codex-cli", defaultModel: "codex-cli-default", trustedUnmediated: true },
	];
	settings.fleet.default.target = "codex-test";
	settings.fleet.default.model = "codex-cli-default";
	settings.fleet.retry.maxRetries = 0;
	settings.safety.autonomy = "default";
	const bundle = makeDispatchBundle(
		dispatchStubContext({
			settings,
			runtime: codexCliRuntime,
			agentTools: ["read", "write"],
			useRuntimeDefaultAgentBudget: true,
		}),
	);
	await bundle.extension.start();
	try {
		const request = {
			agentId: "coder",
			target: "codex-test",

			executionRole: "builder" as const,
			requestOrigin: "user" as const,
			cwd: root,
		};
		const current = await bundle.contract.dispatch({ ...request, task: "Edit in current checkout" });
		const currentReceipt = await current.finalPromise;
		equal(currentReceipt.outcome, "succeeded");
		equal(currentReceipt.worktree, undefined);
		deepStrictEqual(currentReceipt.checkoutChanges?.changedPaths, ["changed.txt"]);
		equal(currentReceipt.checkoutChanges?.attribution, "observed-delta");
		ok(existsSync(join(root, "changed.txt")));
		rmSync(join(root, "changed.txt"));

		const isolated = await bundle.contract.dispatch({
			...request,
			task: "Edit in isolated worktree",
			worktree: true,
			apply: "preserve",
		});
		const isolatedReceipt = await isolated.finalPromise;
		equal(isolatedReceipt.outcome, "succeeded");
		ok(isolatedReceipt.worktree);
		equal(isolatedReceipt.worktree.apply, "preserve");
		equal(isolatedReceipt.worktree.applied, false);
		deepStrictEqual(isolatedReceipt.worktree.changedPaths, ["changed.txt"]);
		ok(existsSync(join(isolatedReceipt.worktree.path, "changed.txt")));
		equal(existsSync(join(root, "changed.txt")), false);

		const failed = await bundle.contract.dispatch({
			...request,
			task: "Fail after edit",
			worktree: true,
			apply: "preserve",
		});
		const failedReceipt = await failed.finalPromise;
		equal(failedReceipt.outcome, "failed");
		ok(failedReceipt.worktree);
		equal(failedReceipt.worktree.snapshot, "working-tree");
		deepStrictEqual(failedReceipt.worktree.changedPaths, ["failed.txt"]);
		ok(failedReceipt.worktree.diffHash);
		ok(existsSync(join(failedReceipt.worktree.path, "failed.txt")));
		const stateDir = process.env.CLIO_CODER_STATE_DIR;
		ok(stateDir);
		ok(verifyRunRecordReport(stateDir, isolated.runId).ok);
		ok(verifyRunRecordReport(stateDir, failed.runId).ok);
	} finally {
		await bundle.extension.stop?.();
	}
});

test("the shipped coder recipe reaches an explicit Codex CLI target in write mode", { timeout: 20_000 }, async () => {
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
	execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "base.txt"), "base");
	execFileSync("git", ["-C", root, "add", "base.txt"]);
	execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
	const executable = join(root, "bin", "codex");
	writeFileSync(
		executable,
		`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
for await (const chunk of process.stdin) {}
const sandboxAt = process.argv.indexOf("--sandbox");
if (process.argv[sandboxAt + 1] !== "workspace-write") process.exit(7);
writeFileSync(join(process.cwd(), "proof.txt"), "HELLO");
const answer = JSON.stringify({ mutatedPaths: ["proof.txt"], validations: [{ name: "content", passed: true, evidence: "HELLO" }], summary: "Created proof.txt" });
for (const event of [
  { type: "thread.started", thread_id: "write-thread" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: answer } },
  { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } },
]) process.stdout.write(JSON.stringify(event) + "\\n");
`,
	);
	chmodSync(executable, 0o755);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "codex-test", runtime: "codex-cli", defaultModel: "codex-cli-default" }];
	settings.fleet.default.target = "codex-test";
	settings.fleet.default.model = "codex-cli-default";
	settings.fleet.retry.maxRetries = 0;
	settings.safety.autonomy = "default";
	const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime: codexCliRuntime }));
	await bundle.extension.start();
	try {
		await rejects(
			bundle.contract.dispatch({
				agentId: "coder",
				target: "codex-test",
				task: "Create proof.txt",
				cwd: root,

				executionRole: "builder",
				requestOrigin: "user",
				denyTools: ["write"],
			}),
			/denyTools cannot be enforced on an external CLI target/,
		);
		const writeRequest = {
			agentId: "coder",
			target: "codex-test",
			task: "Create proof.txt",
			cwd: root,

			executionRole: "builder" as const,
			requestOrigin: "user" as const,
			worktree: true as const,
			apply: "preserve" as const,
		};
		// Codex runs its own tool loop, so write-capable work is refused until the
		// operator marks the target trusted-unmediated, and the opt-in is sealed.
		await rejects(bundle.contract.dispatch(writeRequest), /refused write-capable work.*trustedUnmediated: true/u);
		const target = settings.targets[0];
		ok(target);
		target.trustedUnmediated = true;
		const run = await bundle.contract.dispatch(writeRequest);
		const receipt = await run.finalPromise;
		equal(receipt.safety?.permit?.trustedUnmediated, true);
		// The sealed ceiling states that Codex, not Clio, enforced this run's tools.
		equal(receipt.safety?.permit?.ceiling?.readOnly, false);
		equal(receipt.safety?.permit?.ceiling?.enforcement.perCallMediation, false);
		equal(receipt.safety?.permit?.ceiling?.enforcement.toolNarrowing, "none");
		equal(
			receipt.outcome,
			"succeeded",
			JSON.stringify({ failure: receipt.failureMessage, output: receipt.output?.text, quality: receipt.quality }),
		);
		equal(receipt.autonomy, "default");
		deepStrictEqual(receipt.worktree?.changedPaths, ["proof.txt"]);
		ok(receipt.worktree);
		equal(readFileSync(join(receipt.worktree.path, "proof.txt"), "utf8"), "HELLO");
	} finally {
		await bundle.extension.stop?.();
	}
});
