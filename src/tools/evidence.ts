import { Type } from "typebox";
import { assertSafeId } from "../core/safe-id.js";
import { ToolNames } from "../core/tool-names.js";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
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
		"Read canonical evidence as JSON. List recent bundles, inspect a bundle's overview, trust axes and tier, gate decisions, and findings, or build/read evidence for a run.",
	parameters: Type.Object({
		mode: StringEnum(["list", "inspect", "run"]),
		id: Type.Optional(Type.String({ description: "Evidence bundle id for inspect." })),
		runId: Type.Optional(Type.String({ description: "Run id for run." })),
	}),
	baseActionClass: "read",
	// Run mode may materialize a derived bundle in Clio's data directory.
	executionMode: "sequential",
	async run(args): Promise<ToolResult> {
		const mode = args.mode;
		if (mode !== "list" && mode !== "inspect" && mode !== "run") {
			return { kind: "error", message: "evidence: mode must be list, inspect, or run" };
		}
		try {
			const dataDir = clioDataDir();
			if (mode === "list") {
				const { evidenceInventorySnapshot } = await import("../domains/evidence/inventory.js");
				return boundedResult(await evidenceInventorySnapshot(Date.now, dataDir));
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
