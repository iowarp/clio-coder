import { Type } from "typebox";
import { assertSafeId } from "../core/safe-id.js";
import { ToolNames } from "../core/tool-names.js";
import { clioStateDir } from "../core/xdg.js";
import { dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

export const EVIDENCE_TOOL_MAX_BYTES = 16_384;

/** Keep truncated results valid JSON and never hide an unbounded copy in details. */
function boundedResult(value: unknown): ToolResult {
	const serialized = JSON.stringify(value, null, 2);
	if (Buffer.byteLength(serialized, "utf8") <= EVIDENCE_TOOL_MAX_BYTES) {
		return { kind: "ok", output: serialized, details: { truncated: false } };
	}
	const hint = "Inspect one run to narrow the output; this preview is incomplete JSON text.";
	let preview = truncateUtf8(serialized, EVIDENCE_TOOL_MAX_BYTES, "");
	let output = JSON.stringify({ truncated: true, hint, preview });
	while (Buffer.byteLength(output, "utf8") > EVIDENCE_TOOL_MAX_BYTES) {
		const excess = Buffer.byteLength(output, "utf8") - EVIDENCE_TOOL_MAX_BYTES;
		preview = truncateUtf8(preview, Math.max(0, Buffer.byteLength(preview, "utf8") - excess), "");
		output = JSON.stringify({ truncated: true, hint, preview });
	}
	return { kind: "ok", output, details: { truncated: true } };
}

/**
 * The runs a session may read: those its own session dispatched, and those that ran in its project. The ledger row
 * decides visibility only; what the tool reports comes from the run's sealed scope (#434).
 */
async function visibleRuns(sessionId: string | undefined): Promise<{
	sees(runId: string): boolean;
	known(runId: string): boolean;
	cwd(runId: string): string | null;
}> {
	const ownership = dispatchOwnership(dispatchOwnerOf({}, sessionId));
	const { openLedger } = await import("../domains/dispatch/state.js");
	const rows = new Map(
		openLedger()
			.list()
			.map((row) => [row.id, row] as const),
	);
	return {
		sees(runId) {
			const row = rows.get(runId);
			return row !== undefined && ownership.seesRun(row);
		},
		known: (runId) => rows.has(runId),
		cwd: (runId) => rows.get(runId)?.cwd ?? null,
	};
}

export const evidenceTool: ToolSpec = {
	name: ToolNames.Evidence,
	description:
		"Read canonical run evidence as JSON. List recent runs' assessments, inspect one run's trust status, findings and gate verdicts, or get a bounded summary for this session.",
	parameters: Type.Object({
		mode: StringEnum(["list", "inspect", "session"]),
		runId: Type.Optional(Type.String({ description: "Run id for inspect." })),
		sessionId: Type.Optional(Type.String({ description: "This session's id for a bounded session summary." })),
		cursor: Type.Optional(Type.String({ description: "Next cursor from a prior evidence list page." })),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
	async run(args, options): Promise<ToolResult> {
		const mode = args.mode;
		if (mode !== "list" && mode !== "inspect" && mode !== "session") {
			return { kind: "error", message: "evidence: mode must be list, inspect, or session" };
		}
		try {
			const stateDir = clioStateDir();
			const visible = await visibleRuns(options?.sessionId);
			const sees = (runId: string) => visible.sees(runId);
			if (mode === "list") {
				if (args.cursor !== undefined && typeof args.cursor !== "string") {
					return { kind: "error", message: "evidence: cursor must be a string" };
				}
				if (args.cursor !== undefined) assertSafeId(args.cursor, "evidence cursor");
				const { evidenceInventorySnapshot, EVIDENCE_INVENTORY_MAX_ARTIFACTS } = await import(
					"../domains/evidence/inventory.js"
				);
				for (let limit = EVIDENCE_INVENTORY_MAX_ARTIFACTS; limit > 0; limit -= 1) {
					const snapshot = await evidenceInventorySnapshot(Date.now, stateDir, (run) => sees(run.runId), {
						...(args.cursor === undefined ? {} : { cursor: args.cursor }),
						limit,
					});
					if (Buffer.byteLength(JSON.stringify(snapshot, null, 2), "utf8") <= EVIDENCE_TOOL_MAX_BYTES || limit === 1) {
						return boundedResult(snapshot);
					}
				}
				throw new Error("unable to produce bounded evidence page");
			}
			if (mode === "session") {
				const sessionId = args.sessionId;
				if (typeof sessionId !== "string" || sessionId.length === 0) {
					return { kind: "error", message: "evidence: session requires sessionId" };
				}
				assertSafeId(sessionId, "session");
				if (options?.sessionId !== sessionId) {
					return {
						kind: "error",
						message: `evidence: session '${sessionId}' belongs to another session; only its owner can request this summary`,
						details: { code: "evidence_foreign", artifactAbsent: false },
					};
				}
				const { evidenceInventorySnapshot } = await import("../domains/evidence/inventory.js");
				const inventory = await evidenceInventorySnapshot(
					Date.now,
					stateDir,
					(run) => run.sessionId === sessionId && sees(run.runId),
				);
				const { readSessionEntriesForId } = await import("../domains/session/index.js");
				const { filterEntriesToActivePath } = await import("../domains/session/tree/active-path.js");
				const { foldTaskBoard, taskBoardCounts } = await import("../domains/session/task-board.js");
				const session = await readSessionEntriesForId(stateDir, sessionId);
				if (session.missing && inventory.artifacts.length === 0) {
					return {
						kind: "error",
						message: `evidence: no runs or session ledger found for '${sessionId}'`,
						details: { code: "artifact_absent", artifactAbsent: true },
					};
				}
				const board = session.missing
					? null
					: foldTaskBoard(filterEntriesToActivePath(session.entries, session.leafTurnId));
				return boundedResult({
					version: 1,
					sessionId,
					runs: inventory.artifacts,
					runsTruncated: inventory.truncated,
					taskBoard: board === null ? null : taskBoardCounts(board),
				});
			}
			const id = args.runId;
			if (typeof id !== "string" || id.length === 0) {
				return { kind: "error", message: "evidence: inspect requires runId" };
			}
			assertSafeId(id, "run");
			if (!visible.known(id)) {
				return {
					kind: "error",
					message: `evidence: run '${id}' not found`,
					details: { code: "artifact_absent", artifactAbsent: true },
				};
			}
			if (!sees(id)) {
				return {
					kind: "error",
					message: `evidence: run '${id}' is not one this session dispatched or that ran in its project`,
					details: { code: "evidence_foreign", artifactAbsent: false },
				};
			}
			const { inspectRunEvidence } = await import("../domains/evidence/index.js");
			const evidence = await inspectRunEvidence(stateDir, id);
			if (evidence.settled === null && evidence.integrity.state !== "failed") {
				return {
					kind: "error",
					message: `evidence: run '${id}' has not settled; it has no evidence yet`,
					details: { code: "artifact_absent", artifactAbsent: true },
				};
			}
			const { authenticatedRunWorktree } = await import("../domains/evidence/worktree.js");
			const worktree = await authenticatedRunWorktree(stateDir, id, visible.cwd(id));
			return boundedResult({ ...(worktree === null ? {} : { worktree }), ...evidence });
		} catch (error) {
			return {
				kind: "error",
				message: truncateUtf8(
					`evidence: ${error instanceof Error ? error.message : String(error)}`,
					EVIDENCE_TOOL_MAX_BYTES - 3,
					"...",
				),
				details: { code: "evidence_error", artifactAbsent: false },
			};
		}
	},
};
