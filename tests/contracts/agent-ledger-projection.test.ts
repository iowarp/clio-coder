import assert from "node:assert/strict";
import { test } from "node:test";
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
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { parseAgentLedgerEntry } from "../../src/worker/protocol.js";
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
		receiptPath: null,
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
	const receipt = withReceiptIntegrity(draft, sealed);
	const runs = [sealed, running];
	const readReceipt = (run: { id: string }): RunReceipt | null => (run.id === sealed.id ? receipt : null);
	return {
		sealed,
		running,
		receipt,
		runs,
		assignments: projectLedgerAssignments(runs, readReceipt),
		receiptFindings: projectReceiptFindings(runs, readReceipt),
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
	assert.match(board, /Findings \(from receipt\):[\s\S]*Entry \(src\/main.ts:3\)[\s\S]*Uncited \[ungrounded lead\]/u);
	const bounded = renderAgentLedger([], { ...p, maxChars: board.indexOf("Findings") });
	assert.match(bounded, /scout-1/u);
	assert.match(bounded, /scout-2/u);
	assert.doesNotMatch(bounded, /Findings/u);
	assert.equal(
		verifyReceiptIntegrity(p.receipt, { ...p.sealed, projection: { ...p.sealed.projection, readRoots: ["changed"] } }).ok,
		true,
	);
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
