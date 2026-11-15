import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_WORKING_SET_VIEW, type PolicyInput } from "../../src/domains/context/working-set/contract.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import type { PathIndex } from "../../src/domains/context/working-set/path-index.js";
import { isProtected } from "../../src/domains/context/working-set/protect.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";

const TS = "2026-11-15T00:00:00.000Z";
const SKILL = { name: "desk-manage", path: "/skills/desk-manage/SKILL.md", hash: "h1", source: "plugin" };

function skillLoad(turnId: string): SessionEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId: null,
		timestamp: TS,
		role: "tool_result",
		payload: {
			toolCallId: turnId,
			toolName: "gateway",
			result: { content: [{ type: "text", text: "x".repeat(4000) }], details: { ...SKILL, capability: "context" } },
			isError: false,
		},
	};
}

function protectedIds(entries: SessionEntry[]): string[] {
	const input: PolicyInput = {
		entries,
		view: EMPTY_WORKING_SET_VIEW,
		cwd: null,
		settings: DEFAULT_WORKING_SET_SETTINGS,
		pressure: { tokens: 90_000, contextWindow: 100_000, threshold: 0.8, target: 0.6 },
		estimateTokens: () => 1000,
	};
	const index = { chainMembers: new Map(), byRef: new Map() } as unknown as PathIndex;
	return entries.flatMap((entry, entryIndex) =>
		entry.kind === "message" &&
		entry.role === "tool_result" &&
		isProtected(entry, { entryIndex, cutoffIndex: 99, input, index })
			? [entry.turnId]
			: [],
	);
}

const activation: SessionEntry = {
	kind: "skillActivation",
	turnId: "act-1",
	parentTurnId: null,
	timestamp: TS,
	activation: { name: SKILL.name, filePath: SKILL.path, hash: SKILL.hash, source: "plugin", triggeredBy: "tool" },
} as SessionEntry;

function state(refs: string[]): SessionEntry {
	return {
		kind: "custom",
		turnId: `state-${refs.length}`,
		parentTurnId: null,
		timestamp: TS,
		customType: "skillContextState",
		data: { version: 1, activationRefs: refs },
	} as SessionEntry;
}

test("eviction keeps the newest body of a skill the session still runs, and only that one", () => {
	strictEqual(protectedIds([skillLoad("load-1"), activation, state(["act-1"])]).join(","), "load-1");
	strictEqual(
		protectedIds([skillLoad("load-1"), activation, skillLoad("load-2"), state(["act-1"])]).join(","),
		"load-2",
	);
	// The operator turned skills off: nothing is pinned.
	strictEqual(protectedIds([skillLoad("load-1"), activation, state([])]).join(","), "");
});
