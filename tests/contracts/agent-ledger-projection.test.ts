import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	projectLedgerAssignments,
	projectReceiptFindings,
	renderAgentLedger,
} from "../../src/domains/dispatch/agent-ledger.js";
import {
	appendAgentLedgerReport,
	closeAgentLedger,
	openAgentLedger,
	readAgentLedger,
	renderAgentLedgerBoard,
} from "../../src/domains/dispatch/agent-ledger-store.js";
import { buildDynamicPromptMessages } from "../../src/domains/dispatch/extension.js";
import { finishRunResult, settleFinishedRun } from "../../src/domains/dispatch/run-settlement.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import type { SettledRunRecord } from "../../src/domains/telemetry/index.js";
import { parseAgentLedgerEntry } from "../../src/worker/protocol.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function projection() {
	const sealed = {
		...fixtureEnvelope("scout-1"),
		agentId: "scout",
		task: "  Locate\n the entry point  ",
		projection: {
			version: 1 as const,
			ledgerId: "board",
			readRoots: ["src/"],
			writeRoots: [],
			scopeSource: "intent" as const,
		},
	};
	const running = {
		...fixtureEnvelope("scout-2"),
		agentId: "scout",
		status: "running" as const,
		outcome: null,
	};
	const draft = fixtureReceiptDraft(sealed);
	draft.toolCalls = 7;
	draft.validationGrounding = { claimed: 2, grounded: 1, ungrounded: ["lint"], basis: "unmatched-command" };
	draft.quality.resultContract = {
		sourceId: "scout",
		validatorDigest: "a".repeat(64),
		conformance: "pass",
		quality: "pass",
	};
	draft.output = {
		state: "final",
		text: "{}",
		bytes: 2,
		truncated: false,
		structured: {
			version: 1,
			kind: "scout-report",
			data: { findings: [{ claim: "Entry", path: "src/main.ts", line: 3 }, { claim: "Uncited" }] },
		},
	};
	const receipt = finishRunResult(draft, sealed, {
		terminal: { terminalReason: draft.terminalReason ?? "completed" },
		processExitCode: sealed.exitCode,
		frameType: null,
		usage: undefined,
	}).result;
	const settlement = settleFinishedRun(receipt, {
		terminal: { terminalReason: "completed" },
		processExitCode: 0,
		frameType: null,
		usage: undefined,
	});
	const record = {
		settled: { ...settlement.facts, at: receipt.endedAt },
		result: { state: "resolved", value: settlement.result },
	} as unknown as SettledRunRecord;
	const runs = [sealed, running];
	const readRun = (run: { id: string }): SettledRunRecord | null => (run.id === sealed.id ? record : null);
	return {
		sealed,
		running,
		receipt,
		runs,
		assignments: projectLedgerAssignments(runs, readRun),
		receiptFindings: projectReceiptFindings(runs, readRun),
	};
}

test("scheduler facts precede receipt findings and oldest posts drop before findings, never assignments", () => {
	const p = projection();
	assert.equal(p.assignments[0]?.task, "Locate the entry point");
	assert.equal(p.assignments[0]?.toolCalls, 7);
	assert.equal(p.assignments[0]?.grounding, "claimed:2 grounded:1");
	assert.equal(p.assignments[1]?.toolCalls, null);
	const board = renderAgentLedger([], p);
	assert.match(board, /^Assignments:/u);
	assert.match(board, /scope undeclared/u);
	assert.match(board, /Findings \(from run record\):[\s\S]*Entry \(src\/main.ts:3\)[\s\S]*Uncited \[ungrounded lead\]/u);
	const bounded = renderAgentLedger([], { ...p, maxChars: board.indexOf("Findings") });
	assert.match(bounded, /scout-1/u);
	assert.match(bounded, /scout-2/u);
	assert.doesNotMatch(bounded, /Findings/u);
});

test("projection survives run-row resume and renders an empty board and worker snapshot without a claim prerequisite", async () => {
	const env = await isolateClioEnv("clio-ledger-projection-");
	try {
		const p = projection();
		const ledger = openLedger();
		ledger.create({ ...p.sealed, cwd: env.dir });
		await ledger.persist();
		assert.deepEqual(openLedger().get(p.sealed.id)?.projection, p.sealed.projection);
		await openAgentLedger("board");
		assert.match(renderAgentLedgerBoard("board", p) ?? "", /Assignments:/u);
		const messages = buildDynamicPromptMessages(
			{ agentId: "scout", executionRole: "researcher", task: "Inspect", ledger: { id: "board", sequence: 0 } },
			{ ledgerToolAvailable: true, ledgerAssignments: p.assignments },
		);
		const text = messages.find((message) => message.id === "dispatch-agent-ledger")?.body ?? "";
		assert.match(text, /Your assignment and scope are already on the board/u);
		assert.match(text, /Assignments:/u);
		assert.doesNotMatch(text, /post your own path claim/u);
		const restrictions = {
			version: 1 as const,
			restrictions: [{ ruleId: "private", policyHash: "hash", sourceRef: "runtime:claude-sdk", recipients: [] }],
		};
		const attribution = {
			runId: "sdk-run",
			assignmentId: "assignment",
			agentId: "reviewer",
			nodeId: "local",
			flowRestrictions: restrictions,
		};
		const report = {
			...p.receipt,
			output: { state: "final" as const, text: `Observed ${"界".repeat(1000)}`, bytes: 3009, truncated: false },
		};
		const posted = await appendAgentLedgerReport("board", attribution, report);
		assert.equal(posted.ok, true);
		if (!posted.ok) return;
		assert.equal(posted.entry.source, "receipt");
		assert.deepEqual(parseAgentLedgerEntry(posted.entry)?.flowRestrictions, restrictions);
		assert.equal(posted.entry.body.kind, "message");
		if (posted.entry.body.kind !== "message") return;
		assert.ok(Buffer.byteLength(posted.entry.body.text) <= 1000);
		assert.match(renderAgentLedgerBoard("board") ?? "", /final report[\s\S]*fleet view sdk-run[\s\S]*preview truncated/u);
		await closeAgentLedger("board");
		assert.deepEqual(await appendAgentLedgerReport("board", attribution, report), posted);
		assert.equal(readAgentLedger("board")?.entries.length, 1);
	} finally {
		env.restore();
	}
});

test("members of one board batch share their prompt prefix, so the stagger holds the rest behind the first", async () => {
	await isolateDispatchState();
	const spawned: Array<{ leaderDone: boolean; finish: () => void }> = [];
	let leaderDone = false;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.staggerSharedPrefix = true;
	settings.fleet.retry.maxRetries = 0;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		spawnWorker: () => {
			let finish!: (result: SpawnedWorkerResult) => void;
			const promise = new Promise<SpawnedWorkerResult>((resolve) => {
				finish = resolve;
			});
			const index = spawned.length;
			const end = () => {
				if (index === 0) leaderDone = true;
				finish({ exitCode: 0, signal: null });
			};
			spawned.push({ leaderDone, finish: end });
			// The leader never streams, so only its exit releases a held follower. Unheld followers end it at once.
			if (index === 0) setTimeout(end, 1_000);
			if (index === 2) spawned[0]?.finish();
			const worker: SpawnedWorker = {
				pid: 6_000 + index,
				promise,
				heartbeatAt: { current: 5, monotonic: 3 },
				events: (async function* () {
					yield { type: "message_start" };
					await promise;
				})(),
				abort: end,
			};
			return worker;
		},
	});
	await bundle.extension.start();
	try {
		await openAgentLedger("board-batch");
		const request = {
			agentId: "scout",
			executionRole: "researcher" as const,
			task: "Inspect the fixture.",
			requestOrigin: "internal" as const,
			ledger: { id: "board-batch", sequence: 0 },
		};
		const batch = await bundle.contract.dispatchBatch([request, request, request]);
		for (const member of spawned) member.finish();
		await batch.finalPromise.catch(() => undefined);
		assert.equal(spawned.length, 3);
		assert.deepEqual(
			spawned.map((member) => member.leaderDone),
			[false, true, true],
			"members 2 and 3 started before the first member's prefix was written",
		);
	} finally {
		for (const member of spawned) member.finish();
		await bundle.extension.stop?.();
		restoreDispatchState();
	}
});

test("the board roster rides after the shared prompt prefix, in each member's own tail", async () => {
	const env = await isolateClioEnv("clio-ledger-roster-tail-");
	try {
		await openAgentLedger("board");
		const p = projection();
		const member = (count: number) =>
			buildDynamicPromptMessages(
				{
					agentId: "scout",
					executionRole: "researcher",
					task: "Inspect",
					ledger: { id: "board", sequence: 0 },
					briefing: "Shared batch briefing.",
					memorySection: "Shared memory.",
				},
				{ ledgerToolAvailable: true, ledgerAssignments: p.assignments.slice(0, count) },
			);
		const [first, second] = [member(1), member(2)];
		const ids = first.map((message) => message.id);
		// Only the board differs between members, and nothing shared follows it.
		assert.deepEqual(ids, ["dispatch-memory", "dispatch-briefing", "dispatch-agent-ledger"]);
		assert.notEqual(first.at(-1)?.body, second.at(-1)?.body);
		assert.deepEqual(first.slice(0, -1), second.slice(0, -1));
	} finally {
		env.restore();
	}
});
