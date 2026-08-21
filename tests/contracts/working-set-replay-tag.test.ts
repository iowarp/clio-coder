import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarker } from "../../src/domains/context/working-set/marker.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

const BODY = `${"grep hit line\n".repeat(40)}the body only the ledger keeps`;
const TS = "2026-08-08T00:00:00.000Z";

function turns(withEviction: boolean, leafBranch: "a" | "b" = "a"): SessionEntry[] {
	const entries: SessionEntry[] = [
		{ kind: "message", role: "user", turnId: "u1", parentTurnId: null, timestamp: TS, payload: { text: "search" } },
		{
			kind: "message",
			role: "tool_call",
			turnId: "c1",
			parentTurnId: "u1",
			timestamp: TS,
			payload: { toolCallId: "call-1", toolName: "grep", args: { pattern: "hit" } },
		},
		{
			kind: "message",
			role: "tool_result",
			turnId: "t1",
			parentTurnId: "c1",
			timestamp: TS,
			payload: {
				toolCallId: "call-1",
				toolName: "grep",
				result: { content: [{ type: "text", text: BODY }] },
				isError: false,
				resultSummary: { bytes: BODY.length, truncated: false },
			},
		},
		{ kind: "message", role: "user", turnId: "u2", parentTurnId: "t1", timestamp: TS, payload: { text: "next" } },
	];
	if (withEviction) {
		entries.push({
			kind: "contextEviction",
			turnId: "e1",
			parentTurnId: leafBranch === "a" ? "u2" : "u3",
			timestamp: TS,
			policyId: "age-horizon",
			trigger: "pressure",
			evicted: [
				{
					ref: { entry: "t1" },
					reason: "age_horizon",
					tokensFreed: 140,
					marker: renderMarker({ ref: { entry: "t1" }, reason: "age_horizon", toolName: "grep", text: BODY }),
				},
			],
			tokensBefore: 900,
			tokensAfter: 760,
			pressureBefore: 0.88,
			snapshotIdBefore: null,
		});
	}
	return entries;
}

describe("contracts/working-set replay tag", () => {
	it("tags an evicted tool row with its reason", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, turns(true));
		const rendered = strip(panel.render(120).join("\n"));
		ok(rendered.includes("evicted · age_horizon"), `expected an evicted tag, got:\n${rendered}`);
	});

	it("leaves an untouched ledger untagged", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, turns(false));
		const rendered = strip(panel.render(120).join("\n"));
		strictEqual(rendered.includes("evicted"), false);
	});

	it("still renders the full body: the transcript shows the ledger, not the projection", () => {
		const panel = createChatPanel({ getOutputVerbosity: () => "verbose" });
		rehydrateChatPanelFromTurns(panel, turns(true));
		const rendered = strip(panel.render(120).join("\n"));
		ok(rendered.includes("the body only the ledger keeps"), "the evicted body must still replay in the transcript");
		ok(rendered.includes("evicted · age_horizon"), "the expanded row carries the tag too");
		strictEqual(rendered.includes("[evicted ref=t1"), false, "the marker belongs to the projection, not the transcript");
	});

	it("does not tag a row from an abandoned branch (#94)", () => {
		// Branch B forks off t1 and evicts it; branch A never did. A replay
		// pinned to branch A must not inherit branch B's eviction.
		const entries = turns(false);
		entries.push({
			kind: "message",
			role: "user",
			turnId: "u3",
			parentTurnId: "t1",
			timestamp: TS,
			payload: { text: "other branch" },
		});
		entries.push(...turns(true, "b").filter((entry) => entry.kind === "contextEviction"));

		const branchA = createChatPanel();
		rehydrateChatPanelFromTurns(branchA, entries, { activeLeafTurnId: "u2" });
		strictEqual(strip(branchA.render(120).join("\n")).includes("evicted"), false);

		const branchB = createChatPanel();
		rehydrateChatPanelFromTurns(branchB, entries, { activeLeafTurnId: "u3" });
		ok(strip(branchB.render(120).join("\n")).includes("evicted · age_horizon"));
	});
});
