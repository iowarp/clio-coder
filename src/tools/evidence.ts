import { Type } from "typebox";
import { assertSafeId } from "../core/safe-id.js";
import { ToolNames } from "../core/tool-names.js";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import { dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import type { EvidenceOverview } from "../domains/evidence/types.js";
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

export const evidenceTool: ToolSpec = {
	name: ToolNames.Evidence,
	description:
		"Read canonical evidence as JSON. List recent bundles, inspect one bundle, build/read evidence for a run, or get a bounded summary for this session.",
	parameters: Type.Object({
		mode: StringEnum(["list", "inspect", "run", "session"]),
		id: Type.Optional(Type.String({ description: "Evidence bundle id for inspect." })),
		runId: Type.Optional(Type.String({ description: "Run id for run." })),
		sessionId: Type.Optional(Type.String({ description: "This session's id for a bounded session summary." })),
		cursor: Type.Optional(Type.String({ description: "Next cursor from a prior evidence list page." })),
		sourceKind: Type.Optional(
			StringEnum(["run", "session"], { description: "Limit list pages to run or session bundles." }),
		),
	}),
	baseActionClass: "read",
	// Run mode may materialize a derived bundle in Clio's data directory.
	executionMode: "sequential",
	async run(args, options): Promise<ToolResult> {
		const mode = args.mode;
		if (mode !== "list" && mode !== "inspect" && mode !== "run" && mode !== "session") {
			return { kind: "error", message: "evidence: mode must be list, inspect, run, or session" };
		}
		try {
			const dataDir = clioDataDir();
			// Bundles live in the machine-wide data dir. One is readable from the
			// session it belongs to or from a session in the project its runs
			// executed in; any other bundle stays out of the model's context.
			const ownership = dispatchOwnership(dispatchOwnerOf({}, options?.sessionId));
			if (mode === "list") {
				if (args.cursor !== undefined && typeof args.cursor !== "string") {
					return { kind: "error", message: "evidence: cursor must be a string" };
				}
				if (args.cursor !== undefined) assertSafeId(args.cursor, "evidence cursor");
				if (args.sourceKind !== undefined && args.sourceKind !== "run" && args.sourceKind !== "session") {
					return { kind: "error", message: "evidence: sourceKind must be run or session" };
				}
				const { evidenceInventorySnapshot, EVIDENCE_INVENTORY_MAX_ARTIFACTS } = await import(
					"../domains/evidence/inventory.js"
				);
				const include = (overview: EvidenceOverview) =>
					ownership.seesBundle(overview) && (args.sourceKind === undefined || overview.source.kind === args.sourceKind);
				for (let limit = EVIDENCE_INVENTORY_MAX_ARTIFACTS; limit > 0; limit -= 1) {
					const snapshot = await evidenceInventorySnapshot(Date.now, dataDir, include, {
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
				// Generated session ids preserve their spelling in artifact ids; reject
				// aliases that could sanitize onto a different session's bundle.
				if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
					return {
						kind: "error",
						message: "evidence: invalid session id",
						details: { code: "evidence_error", artifactAbsent: false },
					};
				}
				const { buildEvidence, hasSessionRunEvidence } = await import("../domains/evidence/build.js");
				const { listEvidenceOverviews } = await import("../domains/evidence/index.js");
				const existing = (await listEvidenceOverviews(dataDir)).find(
					(overview) => overview.source.kind === "session" && overview.source.sessionId === sessionId,
				);
				if (existing === undefined && !(await hasSessionRunEvidence(clioStateDir(), sessionId))) {
					return {
						kind: "error",
						message: `evidence: session artifact not found for '${sessionId}'`,
						details: { code: "artifact_absent", artifactAbsent: true },
					};
				}
				if (ownership.owner.sessionId !== sessionId) {
					return {
						kind: "error",
						message: `evidence: session '${sessionId}' belongs to another session; only its owner can request this summary`,
						details: { code: "evidence_foreign", artifactAbsent: false },
					};
				}
				const overview = existing ?? (await buildEvidence({ dataDir, stateDir: clioStateDir(), sessionId })).overview;
				const evidenceId = overview.evidenceId;
				const { evidenceInventorySnapshot } = await import("../domains/evidence/inventory.js");
				const inventory = await evidenceInventorySnapshot(
					Date.now,
					dataDir,
					(overview) =>
						overview.evidenceId === evidenceId &&
						overview.source.kind === "session" &&
						overview.source.sessionId === sessionId,
				);
				const artifact = inventory.artifacts[0];
				if (artifact === undefined) throw new Error(`session summary unavailable: ${evidenceId}`);
				const { readSessionEntriesForId } = await import("../domains/session/index.js");
				const { filterEntriesToActivePath } = await import("../domains/session/tree/active-path.js");
				const { foldTaskBoard, taskBoardCounts } = await import("../domains/session/task-board.js");
				const session = await readSessionEntriesForId(clioStateDir(), sessionId);
				const board = session.missing
					? null
					: foldTaskBoard(filterEntriesToActivePath(session.entries, session.leafTurnId));
				return boundedResult({
					version: 1,
					sessionId,
					artifact,
					taskBoard: board === null ? null : taskBoardCounts(board),
					toolEvents: {
						total: overview.totals.toolEvents,
						linked: overview.totals.linkedToolEvents,
					},
				});
			}
			const id = mode === "inspect" ? args.id : args.runId;
			if (typeof id !== "string" || id.length === 0) {
				return { kind: "error", message: `evidence: ${mode} requires ${mode === "inspect" ? "id" : "runId"}` };
			}
			assertSafeId(id, mode === "inspect" ? "evidence" : "run");
			const { buildEvidence, EvidenceNotFoundError, inspectEvidence, loadEvidenceGateDecisions } = await import(
				"../domains/evidence/index.js"
			);
			const { evidenceDetailSnapshot } = await import("../domains/evidence/detail.js");
			let evidenceId = mode === "run" ? `run-${id}` : id;
			let inspected: Awaited<ReturnType<typeof inspectEvidence>>;
			try {
				inspected = await inspectEvidence(dataDir, evidenceId);
			} catch (error) {
				if (mode !== "run" || !(error instanceof EvidenceNotFoundError)) throw error;
				try {
					evidenceId = (await buildEvidence({ dataDir, stateDir: clioStateDir(), runId: id })).evidenceId;
				} catch (buildError) {
					if (
						buildError instanceof Error &&
						(buildError.message === "run ledger not found" || buildError.message === `run not found: ${id}`)
					)
						throw new EvidenceNotFoundError(evidenceId);
					throw buildError;
				}
				inspected = await inspectEvidence(dataDir, evidenceId);
			}
			if (!ownership.seesBundle(inspected.overview)) {
				return {
					kind: "error",
					message: `evidence: ${evidenceId} belongs to another project; only sessions in that project can read it`,
					details: { code: "evidence_foreign", artifactAbsent: false },
				};
			}
			return boundedResult({
				...inspected,
				...(await evidenceDetailSnapshot(evidenceId, Date.now, dataDir)),
				gateDecisions: await loadEvidenceGateDecisions(dataDir, evidenceId),
			});
		} catch (error) {
			const absent = error instanceof Error && error.name === "EvidenceNotFoundError";
			return {
				kind: "error",
				message: truncateUtf8(
					`evidence: ${error instanceof Error ? error.message : String(error)}`,
					EVIDENCE_TOOL_MAX_BYTES - 3,
					"...",
				),
				details: { code: absent ? "artifact_absent" : "evidence_error", artifactAbsent: absent },
			};
		}
	},
};
