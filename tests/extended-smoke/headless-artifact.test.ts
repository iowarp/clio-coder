import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { evidenceDirectory } from "../../src/domains/evidence/store.js";
import { readEvidenceIndex } from "../../src/domains/observability/evidence-index.js";
import {
	closeServer,
	hasToolExchange,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { readRunJournal } from "../harness/run-journal.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const CLI = new URL("../../dist/cli/index.js", import.meta.url).pathname;

function hasTool(request: Record<string, unknown>, name: string): boolean {
	return (
		Array.isArray(request.tools) &&
		request.tools.some((tool) => (tool as { function?: { name?: string } })?.function?.name === name)
	);
}

function assertTerminalArtifact(stdout: string): void {
	const events = stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const results = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "gateway");
	strictEqual(results.length, 1);
	strictEqual(results[0].isError, false);
	strictEqual(results[0].result.details.capability, "artifact");
	strictEqual(results[0].result.terminate, true);
	const calls = events.filter((event) => event.type === "tool_execution_start" && event.toolName === "gateway");
	strictEqual(calls.length, 1);
	strictEqual(calls[0].toolCallId, results[0].toolCallId);
	strictEqual(calls[0].args.op, "call");
	strictEqual(calls[0].args.capability, "artifact");
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ cwd, env, timeout: 40_000, maxBuffer: 2_000_000 },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") {
					reject(error);
					return;
				}
				resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
			},
		);
	});
}

for (const scenario of ["clean", "recovered", "terminal-error"] as const) {
	test(`built headless artifact: ${scenario}`, async () => {
		const scratch = makeScratchHome("clio-coder-headless-artifact-");
		const fixture = await startOpenAICompatFixture("unexpected follow-up", {
			toolCall: {
				name: "gateway",
				arguments: { op: "call", capability: "artifact", args: { kind: "report", content: "fixture report\n" } },
			},
			usage: {
				prompt_tokens: 17,
				completion_tokens: 5,
				total_tokens: 22,
				prompt_tokens_details: { cached_tokens: 10 },
				completion_tokens_details: { reasoning_tokens: 2 },
			},
			...(scenario === "clean"
				? {}
				: {
						initialErrors: {
							count: 1,
							status: scenario === "recovered" ? 503 : 401,
							message: "fixture provider unavailable",
						},
					}),
		});
		try {
			const env = {
				...process.env,
				...scratch.env,
				TMPDIR: scratch.dir,
				NODE_ENV: "test",
				CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
			};
			const workspace = join(scratch.dir, "workspace");
			mkdirSync(workspace);
			const doctor = await run(["doctor", "--fix"], workspace, env);
			strictEqual(doctor.code, 0, doctor.stderr);
			seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), fixture.url, "full-auto");
			const direct = await run(
				["run", "--json", "--autonomy", "full-auto", "Write a report artifact containing exactly: fixture report"],
				workspace,
				env,
			);
			const succeeded = scenario !== "terminal-error";
			strictEqual(direct.code === 0, succeeded, direct.stderr);
			doesNotMatch(direct.stderr, /auto-build failed|receipt write failed/u);
			if (succeeded) {
				strictEqual(readFileSync(join(workspace, ".clio-coder/artifacts/REPORT.md"), "utf8"), "fixture report\n");
				assertTerminalArtifact(direct.stdout);
				doesNotMatch(direct.stdout, /unexpected follow-up/u);
				const events = direct.stdout
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
				const completed = events.filter(
					(event) =>
						event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "toolUse",
				);
				strictEqual(completed.length, 1);
				ok(completed[0].message.content.some((block: { type: string }) => block.type === "toolCall"));
				ok(
					completed[0].message.content.every(
						(block: { type: string; text?: string }) => block.type !== "text" || !block.text,
					),
				);
			}
			if (scenario === "recovered") {
				match(direct.stdout, /"stopReason":"error"/u);
				match(direct.stdout, /"phase":"recovered"/u);
			}
			strictEqual(fixture.requests.filter((request) => request.stream !== false).length, scenario === "recovered" ? 2 : 1);
			ok(
				fixture.requests
					.filter((request) => request.stream !== false)
					.every((request) => hasTool(request, "gateway") && !hasTool(request, "artifact")),
			);
			// The sealed receipt is the durable account of the ending: it must
			// authenticate against its ledger row and agree with the exit status.
			const journal = readRunJournal(join(scratch.dir, "state"));
			ok(journal);
			strictEqual(journal.receipts.length, 1);
			const receipt = journal.receipts[0];
			ok(receipt);
			const envelope = journal.envelopes.get(receipt.runId);
			ok(envelope);
			ok(verifyReceiptIntegrity(receipt, envelope).ok);
			strictEqual(receipt.exitCode, direct.code);
			strictEqual(receipt.outcome, succeeded ? "succeeded" : "failed");
		} finally {
			await closeServer(fixture.server);
			scratch.cleanup();
		}
	});
}

// Issue #331 reported `[clio-coder:evidence] auto-build failed for run <id>:
// run ledger not found` on a healthy headless run under a fresh pinned state
// directory whose dispatch reached DispatchCompleted. The evidence auto-build
// starts on that event and reads `<stateDir>/runs.json`, which the emitting
// finalizer persists first. This drives that exact shape without a model: the
// main agent dispatches one worker whose terminal text satisfies its result
// contract, then ends the turn with the artifact tool.
test("built headless artifact: a completed dispatch builds its evidence under a fresh pinned state dir", async () => {
	const scratch = makeScratchHome("clio-coder-headless-artifact-dispatch-");
	const fixture = await startOpenAICompatFixture("worker done: nothing to change\n", {
		// The worker's own conversation has no dispatch tool and gets the text
		// reply, which the artifact-report contract accepts as-is.
		toolCall: (request) => {
			if (!hasTool(request, "dispatch")) return null;
			if (!hasToolExchange(request)) return { name: "dispatch", arguments: { task: "Say hello", agent: "wiki-writer" } };
			return {
				name: "gateway",
				arguments: { op: "call", capability: "artifact", args: { kind: "report", content: "fixture report\n" } },
				id: "call-clio-tool-2",
			};
		},
	});
	try {
		const env = {
			...process.env,
			...scratch.env,
			TMPDIR: scratch.dir,
			NODE_ENV: "test",
			CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
		};
		const workspace = join(scratch.dir, "workspace");
		mkdirSync(workspace);
		const doctor = await run(["doctor", "--fix"], workspace, env);
		strictEqual(doctor.code, 0, doctor.stderr);
		seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), fixture.url, "full-auto");
		// Pinned the way an outer harness pins it: an empty directory with no runs.json.
		const stateDir = mkdtempSync(join(scratch.dir, "pinned-state-"));
		const direct = await run(
			["run", "--json", "--autonomy", "full-auto", "Dispatch a worker, then write a report artifact"],
			workspace,
			{ ...env, CLIO_CODER_STATE_DIR: stateDir },
		);
		strictEqual(direct.code, 0, direct.stderr);
		doesNotMatch(direct.stderr, /auto-build failed|receipt write failed/u);
		match(direct.stdout, /"toolName":"dispatch"/u);
		assertTerminalArtifact(direct.stdout);
		strictEqual(readFileSync(join(workspace, ".clio-coder/artifacts/REPORT.md"), "utf8"), "fixture report\n");
		const streaming = fixture.requests.filter((request) => request.stream !== false);
		// One parent dispatch, one worker reply, and one terminal gateway call.
		// Repeated calls to the obsolete direct artifact surface used to grow
		// this history until the fixture answered a checkpoint request with worker prose.
		strictEqual(streaming.length, 3);
		strictEqual(streaming.filter((request) => hasTool(request, "dispatch")).length, 2);
		ok(streaming.every((request) => !hasTool(request, "artifact")));
		ok(streaming.filter((request) => hasTool(request, "dispatch")).every((request) => hasTool(request, "gateway")));
		const journal = readRunJournal(stateDir);
		ok(journal);
		const dispatched = journal.receipts.filter((receipt) => receipt.agentId === "wiki-writer");
		strictEqual(dispatched.length, 1);
		strictEqual(dispatched[0]?.outcome, "succeeded");
		strictEqual(journal.receipts.filter((receipt) => receipt.agentId === "main-agent").length, 1);
		const rows = readEvidenceIndex(stateDir).filter((row) => row.runId === dispatched[0]?.runId);
		strictEqual(rows.length, 1, JSON.stringify(readEvidenceIndex(stateDir)));
		strictEqual(rows[0]?.succeeded, true);
		ok(existsSync(join(evidenceDirectory(join(scratch.dir, "data"), rows[0]?.evidenceId ?? ""), "overview.json")));
	} finally {
		await closeServer(fixture.server);
		scratch.cleanup();
	}
});
