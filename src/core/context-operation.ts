import { boundedExternalDiagnostic } from "./external-diagnostic.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ContextActivityKind, ContextActivityPayload, ContextActivityPhase } from "./bus-events.js";

export type ContextOperationOutcome = "completed" | "previewed" | "unchanged" | "cancelled" | "failed";
export interface ContextOperationFact {
	kind:
		| "created"
		| "updated"
		| "indexed"
		| "ingested"
		| "preserved"
		| "omitted"
		| "removed"
		| "read"
		| "summarized"
		| "recalled";
	unit: "paths" | "source-files" | "rules" | "messages" | "entries" | "observations";
	count?: number;
	paths?: readonly string[];
}
/** Operation evidence, never a managed worker receipt or a verification claim. */
export interface ContextOperation {
	version: 1;
	id: string;
	kind: ContextActivityKind;
	sessionId: string | null;
	cwd: string;
	origin: "operator" | "automatic";
	reason: string;
	startedAt: string;
	elapsedMs?: number;
	outcome?: ContextOperationOutcome;
	facts?: readonly ContextOperationFact[];
	warnings?: readonly string[];
	/** Estimates from the same runtime accounting on both sides; not provider measurements. */
	tokens?: { before: number; after: number; basis: "runtime-estimate" };
}
export const ACP_CONTEXT_STATUS_METHOD = "_clio-coder/context/status";
/** Invocation reuses commands/invoke with command=context and the existing argv grammar. */
export const CONTEXT_ACTIVITY_EVENT_KIND = "context.activity";
export interface ContextOperationStatus {
	version: 1;
	active: ContextActivityPayload | null;
	latest: ContextOperation | null;
}
export const CONTEXT_OPERATION_CUSTOM_TYPE = "clio-coder.context-operation";
export type ContextOperationProgress = Omit<ContextActivityPayload, "kind" | "at" | "operation">;

export function createContextOperation(
	input: Pick<ContextOperation, "kind" | "sessionId" | "cwd" | "origin" | "reason">,
	emit: (event: ContextActivityPayload) => void,
) {
	const started = performance.now();
	const operation: ContextOperation = {
		...input,
		cwd: resolve(input.cwd),
		version: 1,
		id: randomUUID(),
		startedAt: new Date().toISOString(),
	};
	let settled = false;
	const progress = (event: ContextOperationProgress): void => {
		if (settled) return;
		emit({ ...event, kind: operation.kind, at: Date.now(), operation: { ...operation } });
	};
	return {
		operation,
		progress,
		finish(
			outcome: ContextOperationOutcome,
			message: string,
			evidence: Pick<ContextOperation, "facts" | "warnings" | "tokens"> = {},
		): ContextOperation {
			if (settled) return operation;
			Object.assign(operation, evidence, {
				warnings: [...(evidence.warnings ?? []), ...(outcome === "failed" || outcome === "cancelled" ? [message] : [])]
					.slice(0, 8)
					.map((warning) => boundedExternalDiagnostic(warning, 1024)),
				outcome,
				elapsedMs: Math.max(0, Math.round(performance.now() - started)),
			});
			progress({
				phase: "done",
				status: outcome === "failed" || outcome === "cancelled" ? "failed" : "completed",
				message,
			});
			settled = true;
			return operation;
		},
		start(phase: ContextActivityPhase, message: string): void {
			progress({ phase, status: "started", message });
		},
	};
}

export function formatContextOperationResult(operation: ContextOperation): string {
	const title =
		operation.kind === "compaction"
			? "Context compaction"
			: operation.kind.replace("context-", "Context ").replace("clear", "reset");
	const lines = [`${title}: ${operation.outcome ?? "running"}.`];
	for (const fact of operation.facts ?? []) {
		const label =
			operation.outcome === "previewed" && fact.kind === "indexed"
				? "Would index"
				: fact.kind[0]?.toUpperCase() + fact.kind.slice(1);
		lines.push(
			`${label}${fact.count === undefined ? "" : ` ${fact.count}`} ${fact.unit.replaceAll("-", " ")}${fact.paths?.length ? `: ${fact.paths.slice(0, 8).join(", ")}${fact.paths.length > 8 ? ` (+${fact.paths.length - 8})` : ""}` : ""}.`,
		);
	}
	if (operation.tokens) lines.push(`Estimated tokens: ${operation.tokens.before} → ${operation.tokens.after}.`);
	for (const warning of operation.warnings ?? []) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

export function readContextOperation(value: unknown): ContextOperation | null {
	if (!value || typeof value !== "object") return null;
	const op = value as ContextOperation;
	if (
		op.version !== 1 ||
		typeof op.id !== "string" ||
		op.id.length > 128 ||
		typeof op.cwd !== "string" ||
		typeof op.startedAt !== "string" ||
		!["context-init", "context-clear", "context-refresh", "context-recall", "context-recover", "compaction"].includes(
			op.kind,
		) ||
		!["operator", "automatic"].includes(op.origin) ||
		(op.sessionId !== null && typeof op.sessionId !== "string") ||
		typeof op.reason !== "string"
	)
		return null;
	if (op.elapsedMs !== undefined && (!Number.isFinite(op.elapsedMs) || op.elapsedMs < 0)) return null;
	if (op.outcome !== undefined && !["completed", "previewed", "unchanged", "cancelled", "failed"].includes(op.outcome))
		return null;
	if (
		op.facts !== undefined &&
		(!Array.isArray(op.facts) ||
			op.facts.some(
				(f) =>
					!f ||
					![
						"created",
						"updated",
						"indexed",
						"ingested",
						"preserved",
						"omitted",
						"removed",
						"read",
						"summarized",
						"recalled",
					].includes(f.kind) ||
					!["paths", "source-files", "rules", "messages", "entries", "observations"].includes(f.unit) ||
					(f.count !== undefined && (!Number.isSafeInteger(f.count) || f.count < 0)) ||
					(f.paths !== undefined && (!Array.isArray(f.paths) || !f.paths.every((p: unknown) => typeof p === "string"))),
			))
	)
		return null;
	if (op.warnings !== undefined && (!Array.isArray(op.warnings) || !op.warnings.every((w) => typeof w === "string")))
		return null;
	if (
		op.tokens !== undefined &&
		(!op.tokens ||
			!Number.isFinite(op.tokens.before) ||
			op.tokens.before < 0 ||
			!Number.isFinite(op.tokens.after) ||
			op.tokens.after < 0 ||
			op.tokens.basis !== "runtime-estimate")
	)
		return null;
	return {
		version: 1,
		id: op.id,
		kind: op.kind,
		sessionId: op.sessionId,
		cwd: op.cwd,
		origin: op.origin,
		reason: boundedExternalDiagnostic(op.reason, 1024),
		startedAt: op.startedAt,
		...(op.elapsedMs === undefined ? {} : { elapsedMs: op.elapsedMs }),
		...(op.outcome === undefined ? {} : { outcome: op.outcome }),
		...(op.facts === undefined
			? {}
			: {
					facts: op.facts.slice(0, 16).map((fact) => ({
						kind: fact.kind,
						unit: fact.unit,
						...(fact.count === undefined ? {} : { count: fact.count }),
						...(fact.paths === undefined
							? {}
							: { paths: fact.paths.slice(0, 16).map((path: string) => boundedExternalDiagnostic(path, 1024)) }),
					})),
				}),
		...(op.warnings === undefined
			? {}
			: { warnings: op.warnings.slice(0, 8).map((warning) => boundedExternalDiagnostic(warning, 1024)) }),
		...(op.tokens === undefined
			? {}
			: { tokens: { before: op.tokens.before, after: op.tokens.after, basis: op.tokens.basis } }),
	};
}
