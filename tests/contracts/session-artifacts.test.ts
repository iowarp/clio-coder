import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { foldSessionArtifacts } from "../../src/domains/session/session-artifacts.js";

function toolResult(input: {
	turnId: string;
	toolName: string;
	paths?: unknown;
	timestamp?: string;
	isError?: boolean;
	outcome?: string;
	kind?: string;
}): unknown {
	return {
		kind: "message",
		turnId: input.turnId,
		parentTurnId: "user-1",
		timestamp: input.timestamp ?? `2026-08-19T10:0${input.turnId.slice(-1)}:00.000Z`,
		role: "tool_result",
		payload: {
			toolName: input.toolName,
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { paths: input.paths ?? [], ...(input.kind ? { kind: input.kind } : {}) },
			},
			...(input.isError === undefined ? {} : { isError: input.isError }),
			...(input.outcome === undefined ? {} : { outcome: input.outcome }),
		},
	};
}

describe("contracts/session-artifacts", () => {
	it("folds successful workspace mutations, keeps last writer, and counts normalized-path overwrites", () => {
		const artifacts = foldSessionArtifacts(
			[
				toolResult({ turnId: "turn-1", toolName: "artifact", paths: ["docs/PLAN.md"], kind: "plan" }),
				toolResult({ turnId: "turn-2", toolName: "write", paths: ["/workspace/src/new.ts"] }),
				toolResult({ turnId: "turn-3", toolName: "edit", paths: ["docs/../docs/PLAN.md"] }),
			],
			{ workspace: "/workspace" },
		);
		deepStrictEqual(artifacts, [
			{
				path: "docs/../docs/PLAN.md",
				tool: "edit",
				turnId: "turn-3",
				timestamp: "2026-08-19T10:03:00.000Z",
				overwrites: 1,
			},
			{
				path: "/workspace/src/new.ts",
				tool: "write",
				turnId: "turn-2",
				timestamp: "2026-08-19T10:02:00.000Z",
				overwrites: 0,
			},
		]);
	});

	it("retains artifact kinds and rejects errors, blocks, malformed paths, unrelated tools, and workspace escapes", () => {
		const artifacts = foldSessionArtifacts(
			[
				toolResult({ turnId: "turn-1", toolName: "artifact", paths: ["REPORT.md"], kind: "report" }),
				toolResult({ turnId: "turn-2", toolName: "write", paths: ["failed.ts"], isError: true }),
				toolResult({ turnId: "turn-3", toolName: "write", paths: ["failed-outcome.ts"], outcome: "error" }),
				toolResult({ turnId: "turn-4", toolName: "edit", paths: ["blocked.ts"], outcome: "blocked" }),
				toolResult({ turnId: "turn-5", toolName: "write", paths: ["../escape.ts"] }),
				toolResult({ turnId: "turn-6", toolName: "read", paths: ["inside.ts"] }),
				toolResult({ turnId: "turn-7", toolName: "write", paths: [7, ""] }),
			],
			{ workspace: "/workspace" },
		);
		deepStrictEqual(artifacts, [
			{
				path: "REPORT.md",
				tool: "artifact",
				artifactKind: "report",
				turnId: "turn-1",
				timestamp: "2026-08-19T10:01:00.000Z",
				overwrites: 0,
			},
		]);
	});

	it("deduplicates the same normalized path within one tool result", () => {
		deepStrictEqual(
			foldSessionArtifacts(
				[toolResult({ turnId: "turn-1", toolName: "write", paths: ["src/a.ts", "/workspace/src/a.ts"] })],
				{ workspace: "/workspace" },
			),
			[
				{
					path: "src/a.ts",
					tool: "write",
					turnId: "turn-1",
					timestamp: "2026-08-19T10:01:00.000Z",
					overwrites: 0,
				},
			],
		);
	});
});
