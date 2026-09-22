import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { createWorkerAgentLedgerPort, WORKER_AGENT_LEDGER_POST_CAP } from "../../src/worker/ledger-mirror.js";
import type {
	AgentLedgerBody,
	AgentLedgerEntry,
	AgentLedgerPort,
	WorkerControlFrame,
} from "../../src/worker/protocol.js";

/**
 * The ledger tool through a worker registry bound to the real worker-side
 * port. The orchestrator is the only stand-in: posts land as control frames in
 * an array, and the board it would push back arrives through acceptDelta.
 */

function workerLedger(ledger: { id: string; sequence: number } | null = { id: "ledger-1", sequence: 0 }) {
	const frames: WorkerControlFrame[] = [];
	const port = createWorkerAgentLedgerPort({
		...(ledger ? { ledger } : {}),
		emitControlFrame: (frame) => frames.push(frame),
	});
	return { frames, port, call: registryCall(port) };
}

function registryCall(port?: AgentLedgerPort) {
	const registry = createWorkerToolRegistry(
		undefined,
		createWorkerSafety(),
		undefined,
		undefined,
		undefined,
		undefined,
		port,
	);
	return async (args: Record<string, unknown>): Promise<ToolResult> => {
		const verdict = await registry.invoke({ tool: ToolNames.Ledger, args });
		if (verdict.kind !== "ok") throw new Error(`ledger was not admitted: ${JSON.stringify(verdict)}`);
		return verdict.result;
	};
}

function entry(sequence: number, agentId: string, body: AgentLedgerBody): AgentLedgerEntry {
	return {
		id: `e${sequence}`,
		sequence,
		at: `2026-09-22T00:00:0${sequence}.000Z`,
		runId: `run-${agentId}`,
		assignmentId: `assign-${agentId}`,
		agentId,
		nodeId: "local",
		body,
	};
}

function errorMessage(result: ToolResult): string {
	if (result.kind !== "error") throw new Error(`expected error, got ${JSON.stringify(result)}`);
	return result.message;
}

describe("ledger tool", () => {
	it("posts typed entries as control frames and repairs weak-model argument shapes first", async () => {
		const f = workerLedger();
		const claimed = await f.call({ action: "post", kind: "claim", scope: '["src/tools", "tests"]', intent: "add tests" });
		strictEqual(claimed.kind, "ok", JSON.stringify(claimed));
		if (claimed.kind === "ok") {
			deepStrictEqual(claimed.details, { action: "post", kind: "claim", ledger: true });
			ok(claimed.output.startsWith("posted a claim\n\n"), claimed.output);
		}
		const reviewed = await f.call({ action: "post", kind: "review", target: 3, passed: false, evidence: "reran it" });
		strictEqual(reviewed.kind, "ok", JSON.stringify(reviewed));
		const finding = await f.call({ action: "post", kind: "finding", claim: "  cap is 20  ", path: "src/x.ts", line: 4 });
		strictEqual(finding.kind, "ok", JSON.stringify(finding));
		deepStrictEqual(f.frames, [
			{ kind: "ledger_post", body: { kind: "claim", scope: ["src/tools", "tests"], intent: "add tests" } },
			{ kind: "ledger_post", body: { kind: "review", target: "e3", passed: false, evidence: "reran it" } },
			{ kind: "ledger_post", body: { kind: "finding", claim: "cap is 20", path: "src/x.ts", line: 4 } },
		]);
	});

	it("reads the pushed board with its watermark and narrows it by kind and sequence", async () => {
		const f = workerLedger();
		const empty = await f.call({ action: "read" });
		strictEqual(empty.kind, "ok");
		if (empty.kind === "ok")
			match(empty.output, /No peer contributions yet\.\n\nboard as of sequence 0 \(local mirror\)/);
		f.port.acceptDelta([
			entry(1, "scout", { kind: "claim", scope: ["src/parser"], intent: "rewrite the tokenizer" }),
			entry(2, "reviewer", { kind: "finding", claim: "tokenizer drops tabs", path: "src/parser/lex.ts", line: 12 }),
		]);
		// A replayed delta is deduped by sequence rather than listed twice.
		f.port.acceptDelta([entry(2, "reviewer", { kind: "finding", claim: "tokenizer drops tabs" })]);
		const board = await f.call({ action: "read" });
		strictEqual(board.kind, "ok");
		if (board.kind !== "ok") return;
		deepStrictEqual(board.details, { action: "read", ledger: true });
		match(board.output, /rewrite the tokenizer/);
		match(board.output, /tokenizer drops tabs/);
		match(board.output, /board as of sequence 2 \(local mirror\)/);
		const findings = await f.call({ action: "read", kinds: '["finding"]' });
		ok(findings.kind === "ok" && !findings.output.includes("rewrite the tokenizer"), JSON.stringify(findings));
		const since = await f.call({ action: "read", since: 1 });
		ok(since.kind === "ok" && !since.output.includes("rewrite the tokenizer"), JSON.stringify(since));
		ok(since.kind === "ok" && since.output.includes("tokenizer drops tabs"), JSON.stringify(since));
		strictEqual(f.frames.length, 0, "reads never post");
	});

	it("refuses each malformed post by naming the field, and posts nothing", async () => {
		const f = workerLedger();
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ action: "write" }, /action must be one of post, read; got 'write'/],
			[{ action: "post", kind: "note" }, /kind must be one of claim, finding, review; got 'note'/],
			[{ action: "post", kind: "claim", scope: ["src"] }, /a claim requires intent/],
			[{ action: "post", kind: "claim", intent: "x" }, /a claim requires scope/],
			[{ action: "post", kind: "finding" }, /a finding requires claim/],
			[{ action: "post", kind: "finding", claim: "x", line: 0 }, /finding line must be a positive safe integer/],
			[{ action: "post", kind: "review", passed: true, evidence: "x" }, /a review requires target/],
			[{ action: "post", kind: "review", target: "e1", evidence: "x" }, /a review requires passed/],
			[{ action: "post", kind: "review", target: "e1", passed: true }, /a review requires evidence/],
			[
				{ action: "post", kind: "review", target: "latest", passed: true, evidence: "x" },
				/review target must be a ledger entry id/,
			],
			[
				{ action: "post", kind: "claim", scope: ["src"], intent: "i".repeat(201) },
				/claim intent must be 1\.\.200 characters/,
			],
		];
		for (const [args, expected] of cases) match(errorMessage(await f.call(args)), expected, JSON.stringify(args));
		deepStrictEqual(f.frames, []);
	});

	it("stops at the per-run post cap with a refusal the model can act on", async () => {
		const f = workerLedger();
		for (let i = 0; i < WORKER_AGENT_LEDGER_POST_CAP; i += 1) {
			strictEqual((await f.call({ action: "post", kind: "finding", claim: `observation ${i}` })).kind, "ok");
		}
		match(
			errorMessage(await f.call({ action: "post", kind: "finding", claim: "one too many" })),
			/used all 20 of its ledger posts/,
		);
		strictEqual(f.frames.length, WORKER_AGENT_LEDGER_POST_CAP);
	});

	it("answers without a board when the run has no peers, whether or not a port is bound", async () => {
		for (const call of [workerLedger(null).call, registryCall()]) {
			const read = await call({ action: "read" });
			deepStrictEqual(read, {
				kind: "ok",
				output: "There is no coordination ledger for this run: no peers are running alongside it.",
				details: { action: "read", ledger: false },
			});
			match(
				errorMessage(await call({ action: "post", kind: "finding", claim: "x" })),
				/^ledger: There is no coordination ledger/,
			);
		}
	});
});
