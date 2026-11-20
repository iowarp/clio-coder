import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE,
	type CompactionCallObservation,
	compact,
} from "../../src/domains/session/compaction/compact.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { syntheticCompactionSummary } from "../harness/compaction-summary.js";

const timestamp = "2026-11-07T00:00:00.000Z";
function message(turnId: string, role: MessageEntry["role"], payload: unknown): MessageEntry {
	return { kind: "message", turnId, parentTurnId: null, timestamp, role, payload };
}
function chain(entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({ ...entry, parentTurnId: entries[index - 1]?.turnId ?? null }));
}

// afterF-2: a turn ended right after a checkpoint whose kept suffix was one
// whole-file read. That suffix (3432 tokens) was under twice the checkpoint
// (2 x 2117), so the next request, 112 tokens over the window, compacted
// nothing and was refused.
describe("overflow compaction of a retained suffix", () => {
	let faux: ReturnType<typeof registerEngineFauxProvider>;
	let calls: number;
	beforeEach(() => {
		calls = 0;
		faux = registerEngineFauxProvider({ api: "overflow-fit-fixture", models: [{ id: "summary" }], tokensPerSecond: 0 });
		faux.setResponses(
			Array.from({ length: 2 }, () => (_context, _options, _state, resolved) => {
				calls += 1;
				return {
					role: "assistant",
					content: [{ type: "text", text: syntheticCompactionSummary("List the multipliers") }],
					api: resolved.api,
					provider: resolved.provider,
					model: resolved.id,
					stopReason: "stop",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			}),
		);
	});
	afterEach(() => faux.unregister());
	function model() {
		const resolved = faux.getModel("summary");
		ok(resolved);
		return { ...resolved, contextWindow: 32768, maxTokens: 4096 };
	}
	function session(): SessionEntry[] {
		const checkpoint: SessionEntry = {
			kind: "compactionSummary",
			turnId: "checkpoint",
			parentTurnId: null,
			timestamp,
			summary: `## Goal\nList the multipliers.\n\n## Progress\n${"Read src/mod_c.ts in full. ".repeat(40)}`,
			firstKeptTurnId: "a-read",
			tokensBefore: 15000,
		};
		return chain([
			message("u1", "user", { text: "Read src/mod_c.ts and src/mod_d.ts, then list the multipliers." }),
			message("a-read", "assistant", {
				content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/mod_d.ts" } }],
			}),
			message("r-read", "tool_result", {
				toolCallId: "call_read",
				toolName: "read",
				result: { content: [{ type: "text", text: "const scaled = x * 20 + 5;\n".repeat(60) }] },
				isError: false,
			}),
			checkpoint,
			message("answer", "assistant", { content: [{ type: "text", text: "h05 uses 20." }] }),
		]);
	}

	it("rewrites a checkpoint whose kept suffix is under twice its size when the request must fit", async () => {
		const entries = session();
		const checkpointTokens = estimateTokens(entries[3] as SessionEntry);
		const suffixTokens = estimateTokens(entries[1] as SessionEntry) + estimateTokens(entries[2] as SessionEntry);
		ok(suffixTokens > checkpointTokens && suffixTokens < 2 * checkpointTokens, `${suffixTokens} vs ${checkpointTokens}`);

		const automatic = await compact({ entries, model: model(), keepRecentTokens: 10000 });
		strictEqual(automatic.summary, "");
		strictEqual(automatic.emptyReason, "protected-recent");
		strictEqual(calls, 0, "an automatic pass does not pay to rewrite a small suffix");

		const overflow = await compact({ entries, model: model(), keepRecentTokens: 10000, requireFit: true });
		strictEqual(calls, 1);
		ok(overflow.summary.length > 0, "a request that cannot fit otherwise gets the rewrite");
		strictEqual(overflow.emptyReason, undefined);
	});
});

// MD10: a split fold's history and split-turn summaries on a route with a second slot free.
describe("split fold summaries on a capacity-two route", () => {
	type Mode = "pass" | "history-fails-split-held" | "split-done-history-fails";
	const turns = () => new Promise<void>((resolve) => setImmediate(resolve));
	async function fold(capacity: 1 | 2, mode: Mode = "pass") {
		const faux = registerEngineFauxProvider({
			api: "split-fold-fixture",
			models: [{ id: "summary" }],
			tokensPerSecond: 0,
		});
		const requests: string[] = [];
		const startsSeenAtSettle: Record<string, number> = {};
		const calls: CompactionCallObservation[] = [];
		let started = 0;
		let settled = 0;
		let releases = 0;
		const respond = (): FauxResponseFactory => async (context, options, _state, resolved) => {
			// Normalized: message timestamps are send times, not request content.
			const user = JSON.stringify(context.messages.map(({ timestamp: _sent, ...rest }) => rest));
			const split = user.includes(JSON.stringify(COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE).slice(1, 40));
			const kind = split ? "split" : "history";
			requests.push(JSON.stringify({ kind, user, maxTokens: options?.maxTokens }));
			started += 1;
			// Hold each response until both requests started; a serial build never sees the second start.
			for (let turn = 0; turn < 200 && started < 2; turn++) await turns();
			startsSeenAtSettle[kind] = started;
			let stopReason: "stop" | "error" = "stop";
			if (kind === "history") {
				// The split reply settles first, so installation order is the code's, not the arrival's.
				for (let turn = 0; turn < 200 && settled === 0 && started === 2; turn++) await turns();
				if (mode !== "pass") stopReason = "error";
			} else if (mode === "history-fails-split-held") {
				ok(options?.signal, "the split request carries a signal");
				const signal = options.signal;
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			}
			settled += 1;
			return {
				role: "assistant",
				content: [{ type: "text", text: split ? "Split detail" : syntheticCompactionSummary("History goal") }],
				api: resolved.api,
				provider: resolved.provider,
				model: resolved.id,
				stopReason,
				...(stopReason === "error" ? { errorMessage: "history summary failed" } : {}),
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		};
		faux.setResponses([respond(), respond()]);
		const resolved = faux.getModel("summary");
		ok(resolved);
		const entries: SessionEntry[] = chain([
			message("user-0", "user", { text: "Earlier work" }),
			message("user-1", "user", { text: "Continue" }),
			message("tail", "assistant", { text: "tail ".repeat(2000) }),
		]);
		try {
			const result = await compact({
				entries,
				model: { ...resolved, contextWindow: 32768, maxTokens: 4096 },
				keepRecentTokens: 100,
				onCall: (call) => calls.push(call),
				holdSecondSummarySlot: () =>
					capacity === 2
						? () => {
								releases += 1;
								strictEqual(settled + calls.length, 4, "the slot is released after both requests settle");
							}
						: null,
			}).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			return { result, requests: requests.sort(), startsSeenAtSettle, calls, releases };
		} finally {
			faux.unregister();
		}
	}

	it("overlaps the two summaries, installs history first, and commits nothing when either fails", async () => {
		const serial = await fold(1);
		const concurrent = await fold(2);
		ok("value" in serial.result && "value" in concurrent.result);
		strictEqual(concurrent.result.value.isSplitTurn, true);
		deepStrictEqual(concurrent.startsSeenAtSettle, { history: 2, split: 2 }, "both start before either settles");
		deepStrictEqual(serial.startsSeenAtSettle, { history: 1, split: 2 }, "capacity one runs them in sequence");
		deepStrictEqual(concurrent.requests, serial.requests, "request content equals the serial build's");
		strictEqual(concurrent.result.value.summary, serial.result.value.summary);
		const summary = concurrent.result.value.summary;
		ok(summary.indexOf("History goal") < summary.indexOf("**Turn Context (split turn):**"), summary);
		strictEqual(concurrent.result.value.usage?.apiCalls, 2);
		strictEqual(concurrent.releases, 1);

		const cancelled = await fold(2, "history-fails-split-held");
		ok("error" in cancelled.result && /history summary failed/.test(String(cancelled.result.error)));
		deepStrictEqual(cancelled.calls.map((call) => call.outcome).sort(), ["aborted", "error"]);
		strictEqual(cancelled.releases, 1);

		const charged = await fold(2, "split-done-history-fails");
		ok("error" in charged.result && /history summary failed/.test(String(charged.result.error)));
		const done = charged.calls.find((call) => call.outcome === "success");
		ok(done, "the completed sibling reports its call");
		ok(((done.usage as { totalTokens?: number }).totalTokens ?? 0) > 0, "and is charged its usage");
	});
});
