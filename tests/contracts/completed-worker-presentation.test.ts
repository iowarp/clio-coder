import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { inspectRunReceiptTrustStatus } from "../../src/domains/evidence/trust-status.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { createDispatchBoardView, type DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { readWorkerReceiptFactsForReplay } from "../../src/interactive/worker-receipts.js";
import type { WorkerEntryState } from "../../src/interactive/worker-stream.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

function worker(
	text: string,
	kind: NonNullable<WorkerEntryState["receipt"]>["contractKind"] = "debugger-report",
): WorkerEntryState {
	const envelope = fixtureEnvelope("aa-run");
	const draft = fixtureReceiptDraft(envelope);
	draft.output = { text, truncated: false, state: "final", bytes: Buffer.byteLength(text) };
	draft.quality.resultContract = {
		sourceId: `agent-result-contract:${kind}:1`,
		validatorDigest: "a".repeat(64),
		conformance: "pass",
		quality: "unmeasured",
	};
	const trust = inspectRunReceiptTrustStatus(withReceiptIntegrity(draft, envelope), envelope).status;
	return {
		assignmentId: "a",
		runId: "aa-run",
		origin: "agent",
		agentId: "debugger",
		runtime: { kind: "clio", targetId: "test", wireModelId: "test" },
		text,
		droppedLines: 0,
		tools: [],
		attempts: [],
		pending: false,
		receipt: { trust, outcome: "succeeded", contract: "pass", contractKind: kind },
	};
}
function board(entry: WorkerEntryState, width: number): string[] {
	const contract = entry.receipt?.contract;
	const kind = entry.receipt?.contractKind;
	const row: DispatchBoardRow = {
		runId: entry.runId,
		agentId: entry.agentId,
		runtimeKind: "http",
		runtimeId: "test",
		targetId: "test",
		wireModelId: "test",
		status: entry.pending ? "running" : entry.receipt?.outcome === "failed" ? "failed" : "completed",
		elapsedMs: 0,
		tokenCount: 0,
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		ttftMs: null,
		...(kind && contract ? { resultContract: { kind, conformance: contract } } : {}),
		progress: {
			revision: 1,
			phase: entry.pending ? "writing" : "settled",
			settled: !entry.pending,
			tailText: entry.text,
			droppedLines: entry.droppedLines,
			droppedBytes: entry.progress?.droppedBytes ?? 0,
			currentAction: null,
			recentActions: [],
			toolNames: [],
		},
	};
	const view = createDispatchBoardView(
		() => [row],
		() => undefined,
	);
	view.toggleDetail();
	return view.render(width);
}
const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");

test("recognized settled debugger reports share diagnosis and reproduction truth at narrow widths", () => {
	const entry = worker(
		JSON.stringify({
			diagnosis: "Parser rejects valid input.",
			reproduction: "not-reproduced",
			evidence: Array.from({ length: 20 }, (_, i) => `Evidence ${i}: ${"detail ".repeat(12)}`),
		}),
	);
	for (const width of [43, 80, 120]) {
		const transcript = renderWorkerEntryLines(entry, width, { detail: transcriptDetail("standard") });
		const fleet = board(entry, width);
		for (const rows of [transcript, fleet]) {
			assert.match(plain(rows), /Parser rejects valid input/);
			assert.match(plain(rows), /reproduction not-reproduced/);
			assert.doesNotMatch(plain(rows), /"diagnosis"|"reproduction"/);
			for (const row of rows) assert.ok(visibleWidth(row) <= width);
		}
		assert.match(plain(fleet), /\/view/);
	}
});

test("live, failed-contract, partial, malformed and unknown answers never acquire a contract summary", () => {
	const raw = '{"diagnosis":"RAW_DIAGNOSIS","reproduction":"unknown","evidence":[]}';
	const cases = [
		worker(raw),
		worker(raw),
		worker(raw),
		worker(raw.slice(0, -1)),
		worker('{"unknown":9007199254740993}'),
	];
	const live = cases[0];
	const failed = cases[1];
	const truncated = cases[2];
	assert.ok(live && failed && truncated && failed.receipt);
	live.pending = true;
	failed.receipt.contract = "fail";
	truncated.droppedLines = 1;
	for (const entry of cases) {
		for (const rows of [
			renderWorkerEntryLines(entry, 120, { detail: transcriptDetail("detailed") }),
			board(entry, 120),
		]) {
			assert.doesNotMatch(plain(rows), /reproduction unknown/);
		}
	}
	assert.match(plain(renderWorkerEntryLines(worker('{"unknown":9007199254740993}'), 120, {})), /9007199254740993/);
});

test("export retains raw structured fields, source precision and secret redaction", () => {
	const raw =
		'{"diagnosis":"Investigate","reproduction":"unknown","evidence":[],"number":9007199254740993,"token":"x","context":"API_KEY=fixture-secret"}';
	const entry = worker(raw);
	const output = plain(renderWorkerEntryLines(entry, 120, { unbounded: true }));
	assert.match(output, /"diagnosis"/);
	assert.match(output, /9007199254740993/);
	assert.doesNotMatch(output, /fixture-secret/);
	assert.equal(entry.text, raw);
});

test("decoded Unicode and terminal controls stay safe on both production surfaces", () => {
	const entry = worker(
		JSON.stringify({
			diagnosis: "研究 \u001b]0;HIDDEN_TITLE\u0007invalid\u001b[31m input\u202e",
			reproduction: "unknown",
			evidence: [],
		}),
	);
	for (const rows of [renderWorkerEntryLines(entry, 43, {}), board(entry, 43)]) {
		const text = plain(rows);
		assert.match(text, /研究/);
		assert.doesNotMatch(text, /HIDDEN_TITLE|\u202e/);
		for (const row of rows) assert.ok(visibleWidth(row) <= 43);
	}
});

test("checkpoint questions and execution failures stay visible", () => {
	const checkpoint = worker(
		'needs_input: checkpoint:decision\nShould I reproduce on the production fixture?\n{"diagnosis":"Do not replace my question","reproduction":"unknown","evidence":[]}',
	);
	assert.match(
		plain(renderWorkerEntryLines(checkpoint, 80, { detail: transcriptDetail("compact") })),
		/Should I reproduce/,
	);
	assert.match(plain(board(checkpoint, 80)), /Should I reproduce/);
	const failed = worker('{"diagnosis":"The tool failed","reproduction":"unknown","evidence":[]}');
	assert.ok(failed.receipt);
	failed.receipt.outcome = "failed";
	failed.receipt.failureMessage = "Fixture could not start";
	assert.match(plain(renderWorkerEntryLines(failed, 80, {})), /Fixture could not start/);
	assert.match(plain(board(failed, 80)), /failed/);
});

test("scout numeric line tokens that cannot survive parsing remain source text", () => {
	const entry = worker(
		'{"findings":[{"claim":"Check here","path":"file.ts","line":1.00000000000000001}],"needsSplit":false}',
		"scout-report",
	);
	assert.ok(entry.receipt);
	assert.match(
		plain(renderWorkerEntryLines(entry, 120, { detail: transcriptDetail("detailed") })),
		/1\.00000000000000001/,
	);
	assert.match(plain(board(entry, 120)), /1\.00000000000000001/);
});

test("recognized verifier, research, world knowledge and scout reports retain limitations and provenance", () => {
	const cases = [
		{
			kind: "verifier-report",
			value: { verdict: "fail", checks: [{ name: "test", passed: false, evidence: "Could not reproduce" }] },
			expected: /verdict fail/,
		},
		{
			kind: "research-report",
			value: { source: "external", findings: [{ claim: "A reported claim", evidence: "Paper citation" }] },
			expected: /source external/,
		},
		{
			kind: "world-knowledge-report",
			value: {
				discovery: "unavailable",
				facts: [],
				synthesis: [],
				uncertainties: ["Not independently checked"],
				followUpVerification: ["Run a local test"],
			},
			expected: /discovery unavailable/,
		},
		{
			kind: "scout-report",
			value: { needsSplit: false, findings: [{ claim: "Inspect parser", path: "parser.ts", line: 12 }] },
			expected: /no split needed/,
		},
	] as const;
	for (const item of cases) {
		const entry = worker(JSON.stringify(item.value), item.kind);
		assert.ok(entry.receipt);
		for (const rows of [
			renderWorkerEntryLines(entry, 120, { detail: transcriptDetail("detailed") }),
			board(entry, 120),
		]) {
			assert.match(plain(rows), item.expected);
			assert.doesNotMatch(plain(rows), /"findings"|"checks"/);
		}
	}
});

for (const mode of ["verified", "tampered", "missing-ledger", "retired"] as const) {
	test(`receipt reader to production replay admits only verified summaries: ${mode}`, () => {
		const stateDir = mkdtempSync(join(tmpdir(), "aa2-receipt-"));
		try {
			mkdirSync(join(stateDir, "receipts"));
			const envelope = fixtureEnvelope("aa2");
			const draft = fixtureReceiptDraft(envelope);
			draft.output = {
				text: '{"diagnosis":"Recorded diagnosis","reproduction":"reproduced","evidence":[]}',
				truncated: false,
				state: "final",
				bytes: Buffer.byteLength('{"diagnosis":"Recorded diagnosis","reproduction":"reproduced","evidence":[]}'),
			};
			draft.quality.resultContract = {
				sourceId: "agent-result-contract:debugger-report:1",
				validatorDigest: "a".repeat(64),
				conformance: "pass",
				quality: "unmeasured",
			};
			const receipt = withReceiptIntegrity(draft, envelope);
			const stored = mode === "retired" ? { ...receipt, integrity: { ...receipt.integrity, version: 1 } } : receipt;
			if (mode === "tampered") {
				assert.ok(stored.output);
				stored.output.text = stored.output.text.replace("Recorded", "Altered");
			}
			const receiptPath = join(stateDir, "receipts", "aa2.json");
			const bytes = JSON.stringify(stored);
			writeFileSync(receiptPath, bytes);
			if (mode !== "missing-ledger") writeFileSync(join(stateDir, "runs.json"), JSON.stringify([envelope]));
			const facts = readWorkerReceiptFactsForReplay("aa2", stateDir);
			assert.ok(facts);
			assert.equal(
				facts.trust?.artifactIntegrity.state,
				mode === "verified" ? "verified" : mode === "tampered" ? "failed" : mode === "retired" ? "unknown" : undefined,
			);
			for (const style of ["compact", "standard", "detailed"] as const) {
				const panel = createChatPanel({ getOutputStyle: () => style });
				rehydrateChatPanelFromTurns(
					panel,
					[
						{
							kind: "workerRun",
							turnId: "worker",
							parentTurnId: null,
							timestamp: "2026-09-17T00:00:00Z",
							assignmentId: "a",
							runId: "aa2",
							origin: "user",
							agentId: "debugger",
							runtime: { kind: "clio" },
						},
					],
					{ readWorkerReceipt: (id) => readWorkerReceiptFactsForReplay(id, stateDir) },
				);
				const output = plain(panel.render(120));
				if (mode === "verified") assert.match(output, /reproduction reproduced/);
				else {
					assert.doesNotMatch(output, /reproduction reproduced/);
					assert.match(output, /raw output, not admitted as evidence/);
					assert.match(
						output,
						mode === "retired" ? /seal retired/ : mode === "tampered" ? /seal broken/ : /integrity unavailable/,
					);
				}
			}
			const exported = createChatPanel({ unboundedToolBodies: true });
			rehydrateChatPanelFromTurns(
				exported,
				[
					{
						kind: "workerRun",
						turnId: "worker",
						parentTurnId: null,
						timestamp: "2026-09-17T00:00:00Z",
						assignmentId: "a",
						runId: "aa2",
						origin: "user",
						agentId: "debugger",
						runtime: { kind: "clio" },
					},
				],
				{ readWorkerReceipt: (id) => readWorkerReceiptFactsForReplay(id, stateDir), unboundedToolBodies: true },
			);
			assert.match(plain(exported.render(120)), /"diagnosis"/);
			assert.equal(readFileSync(receiptPath, "utf8"), bytes);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});
}

test("whole-object admission preserves fenced checkpoints across styles and rejects surrounding limitations", () => {
	const json = '{"diagnosis":"Diagnosis","reproduction":"unknown","evidence":[]}';
	for (const raw of [json, `\`\`\`json\n${json}\n\`\`\``]) {
		assert.match(plain(renderWorkerEntryLines(worker(raw), 120, {})), /reproduction unknown/);
	}
	const checkpoint = worker(
		`\`\`\`json\nneeds_input: checkpoint:decision\nShould I run expensive validation?\n${json}\n\`\`\``,
	);
	for (const width of [43, 80, 120]) {
		for (const style of ["compact", "standard", "detailed"] as const) {
			const rows = renderWorkerEntryLines(checkpoint, width, { detail: transcriptDetail(style) });
			assert.match(plain(rows), /Should I run expensive validation/);
			assert.match(plain(rows), /needs input/);
			assert.doesNotMatch(plain(rows), /reproduction unknown/);
			assert.ok(rows.length <= 20);
			for (const row of rows) assert.ok(visibleWidth(row) <= width);
		}
		const rows = board(checkpoint, width);
		assert.match(plain(rows).replace(/[│\s]+/gu, " "), /Should I run expensive validation/);
		assert.ok(
			rows.filter(
				(row) => stripTerminalSequences(row).includes("│           │") || stripTerminalSequences(row).includes("│ answer"),
			).length <= 7,
		);
		for (const row of rows) assert.ok(visibleWidth(row) <= width);
	}
	for (const raw of [
		`\`\`\`json\nLimitation: validation unavailable\n${json}\n\`\`\``,
		`${json}\nLimitation: validation unavailable`,
		`{unparsed limitation}\n${json}`,
	]) {
		for (const rows of [
			renderWorkerEntryLines(worker(raw), 120, { detail: transcriptDetail("detailed") }),
			board(worker(raw), 120),
		]) {
			assert.match(plain(rows), /[Ll]imitation/);
			assert.doesNotMatch(plain(rows), /reproduction unknown/);
		}
	}
});

test("Scout escaped and literal keys preserve unsafe numeric tokens and admit exact positive controls", () => {
	for (const key of ['"line"', String.raw`"\u006cine"`, String.raw`"li\u006ee"`]) {
		for (const token of [
			"1.00000000000000001",
			"9007199254740993",
			"1e400",
			"-0",
			"123456789012345678901234567890",
			"12",
		]) {
			const raw = `{"findings":[{"claim":"Inspect","path":"file.ts",${key}:${token}}],"needsSplit":false}`;
			const entry = worker(raw, "scout-report");
			for (const rows of [
				renderWorkerEntryLines(entry, 120, { detail: transcriptDetail("detailed") }),
				board(entry, 120),
			]) {
				const output = plain(rows);
				if (token === "12") assert.match(output, /file.ts:12/);
				else {
					assert.ok(output.includes(token), output);
					assert.doesNotMatch(output, /file.ts:1\b|no split needed/);
				}
			}
			assert.ok(plain(renderWorkerEntryLines(entry, 120, { unbounded: true })).includes(token));
			assert.equal(entry.text, raw);
		}
	}
});
