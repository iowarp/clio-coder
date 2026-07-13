import { createHash } from "node:crypto";
import type { RunEnvelope, RunReceipt, RunReceiptDraft, RunReceiptIntegrity } from "./types.js";

/** New receipts use v5; verification retains the exact historical v4 contract. */
export const RUN_RECEIPT_INTEGRITY_VERSION = 5;
export type ReceiptIntegrityVersion = 4 | typeof RUN_RECEIPT_INTEGRITY_VERSION;
export type ReceiptIntegrityField = keyof RunReceiptDraft;
export const RUN_RECEIPT_INTEGRITY_ALGORITHM = "sha256";

export type ReceiptIntegrityResult = { ok: true } | { ok: false; reason: string };

function sha256(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
	return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`receipt integrity: non-finite number ${String(value)} is not representable`);
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "bigint") throw new Error("receipt integrity: bigint is not representable");
	if (typeof value === "symbol" || typeof value === "function") {
		throw new Error(`receipt integrity: ${typeof value} is not representable`);
	}
	if (value === undefined) throw new Error("receipt integrity: undefined is not representable at root");
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (let i = 0; i < value.length; i++) {
			if (!(i in value) || value[i] === undefined) {
				parts.push("null");
				continue;
			}
			parts.push(serializeCanonical(value[i]));
		}
		return `[${parts.join(",")}]`;
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		const parts: string[] = [];
		for (const key of keys) {
			const child = obj[key];
			if (child === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${serializeCanonical(child)}`);
		}
		return `{${parts.join(",")}}`;
	}
	throw new Error(`receipt integrity: unsupported value of type ${typeof value}`);
}

/**
 * Every public draft field enters the digest. This map is deliberately
 * exhaustive: adding a receipt field without registering it here is a compile
 * error, so a new field can never ship outside integrity coverage.
 */
const V4_RECEIPT_INTEGRITY_FIELD_COVERAGE = {
	runId: true,
	agentId: true,
	agentAudience: true,
	requestOrigin: true,
	task: true,
	targetId: true,
	wireModelId: true,
	runtimeId: true,
	runtimeKind: true,
	startedAt: true,
	endedAt: true,
	outcome: true,
	outcomeDetail: true,
	lineage: true,
	identity: true,
	node: true,
	reroutes: true,
	pipeline: true,
	gate: true,
	plan: true,
	personaOverride: true,
	projectContext: true,
	exitCode: true,
	failureMessage: true,
	tokenCount: true,
	inputTokenCount: true,
	outputTokenCount: true,
	cacheReadTokenCount: true,
	cacheWriteTokenCount: true,
	reasoningTokenCount: true,
	upstreamResponses: true,
	output: true,
	costUsd: true,
	costProvenance: true,
	compiledPromptHash: true,
	staticCompositionHash: true,
	staticShellHash: true,
	sessionShellHash: true,
	dynamicHash: true,
	promptSignature: true,
	toolSignature: true,
	clioVersion: true,
	piMonoVersion: true,
	platform: true,
	nodeVersion: true,
	toolCalls: true,
	toolStats: true,
	toolActivity: true,
	verification: true,
	skillActivations: true,
	autonomyEnforcement: true,
	safety: true,
	reproducibility: true,
	runtimeResolution: true,
	delegation: true,
	findingsSummary: true,
	sessionId: true,
} as const;

export const RECEIPT_INTEGRITY_FIELD_COVERAGE = {
	...V4_RECEIPT_INTEGRITY_FIELD_COVERAGE,
	briefing: true,
	outcomeCode: true,
} as const satisfies Record<ReceiptIntegrityField, true>;

const V4_RECEIPT_FIELDS = Object.keys(V4_RECEIPT_INTEGRITY_FIELD_COVERAGE);
const RECEIPT_FIELDS = Object.keys(RECEIPT_INTEGRITY_FIELD_COVERAGE) as ReceiptIntegrityField[];

function selectedReceiptFields(
	receipt: RunReceipt | RunReceiptDraft,
	fields: ReadonlyArray<string>,
): Record<string, unknown> {
	const source = receipt as unknown as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const field of fields) {
		const value = source[field];
		if (value !== undefined) result[field] = value;
	}
	return result;
}

function receiptDigestFieldsV4(receipt: RunReceipt | RunReceiptDraft): Record<string, unknown> {
	return selectedReceiptFields(receipt, V4_RECEIPT_FIELDS);
}

function receiptDigestFieldsV5(receipt: RunReceipt | RunReceiptDraft): Record<string, unknown> {
	const result = selectedReceiptFields(receipt, RECEIPT_FIELDS);
	result.briefing = receipt.briefing ?? null;
	result.outcomeCode = receipt.outcomeCode ?? null;
	return result;
}

/** Frozen historical projection. Do not add v5 fields here. */
function ledgerDigestFieldsV4(envelope: RunEnvelope): Record<string, unknown> {
	return {
		id: envelope.id,
		agentId: envelope.agentId,
		task: envelope.task,
		targetId: envelope.targetId,
		wireModelId: envelope.wireModelId,
		runtimeId: envelope.runtimeId,
		runtimeKind: envelope.runtimeKind,
		startedAt: envelope.startedAt,
		endedAt: envelope.endedAt,
		status: envelope.status,
		exitCode: envelope.exitCode,
		sessionId: envelope.sessionId,
		cwd: envelope.cwd,
		tokenCount: envelope.tokenCount,
		cacheReadTokenCount: envelope.cacheReadTokenCount,
		cacheWriteTokenCount: envelope.cacheWriteTokenCount,
		reasoningTokenCount: envelope.reasoningTokenCount,
		staticShellHash: envelope.staticShellHash,
		sessionShellHash: envelope.sessionShellHash,
		dynamicHash: envelope.dynamicHash,
		costUsd: envelope.costUsd,
		agentAudience: envelope.agentAudience ?? null,
		requestOrigin: envelope.requestOrigin ?? null,
		outcome: envelope.outcome ?? null,
		outcomeDetail: envelope.outcomeDetail ?? null,
		lineage: envelope.lineage ?? null,
		identity: envelope.identity ?? null,
		node: envelope.node ?? null,
		reroutes: envelope.reroutes ?? null,
		pipeline: envelope.pipeline ?? null,
		gate: envelope.gate ?? null,
		plan: envelope.plan ?? null,
		personaOverride: envelope.personaOverride ?? null,
		inputTokenCount: envelope.inputTokenCount ?? 0,
		outputTokenCount: envelope.outputTokenCount ?? 0,
		promptSignature: envelope.promptSignature ?? null,
		toolSignature: envelope.toolSignature ?? null,
	};
}

function ledgerDigestFieldsV5(envelope: RunEnvelope): Record<string, unknown> {
	return {
		...ledgerDigestFieldsV4(envelope),
		briefing: envelope.briefing ?? null,
		outcomeCode: envelope.outcomeCode ?? null,
	};
}

function integrityPayloadV4(receipt: RunReceipt | RunReceiptDraft, envelope: RunEnvelope): Record<string, unknown> {
	return {
		contract: "clio.runReceipt.integrity",
		version: 4,
		sources: ["receipt", "run-ledger"],
		receipt: receiptDigestFieldsV4(receipt),
		ledger: ledgerDigestFieldsV4(envelope),
	};
}

function integrityPayloadV5(receipt: RunReceipt | RunReceiptDraft, envelope: RunEnvelope): Record<string, unknown> {
	return {
		contract: "clio.runReceipt.integrity",
		version: RUN_RECEIPT_INTEGRITY_VERSION,
		sources: ["receipt", "run-ledger"],
		receipt: receiptDigestFieldsV5(receipt),
		ledger: ledgerDigestFieldsV5(envelope),
	};
}

function computeReceiptIntegrityV4(receipt: RunReceipt, envelope: RunEnvelope): RunReceiptIntegrity {
	return {
		version: 4,
		algorithm: RUN_RECEIPT_INTEGRITY_ALGORITHM,
		digest: sha256(canonicalJson(integrityPayloadV4(receipt, envelope))),
	};
}

export function computeReceiptIntegrity(
	receipt: RunReceipt | RunReceiptDraft,
	envelope: RunEnvelope,
): RunReceiptIntegrity {
	return {
		version: RUN_RECEIPT_INTEGRITY_VERSION,
		algorithm: RUN_RECEIPT_INTEGRITY_ALGORITHM,
		digest: sha256(canonicalJson(integrityPayloadV5(receipt, envelope))),
	};
}

export function withReceiptIntegrity(receipt: RunReceiptDraft, envelope: RunEnvelope): RunReceipt {
	return {
		...receipt,
		integrity: computeReceiptIntegrity(receipt, envelope),
	};
}

export function isReceiptIntegrity(value: unknown): value is RunReceiptIntegrity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		(candidate.version === 4 || candidate.version === RUN_RECEIPT_INTEGRITY_VERSION) &&
		candidate.algorithm === RUN_RECEIPT_INTEGRITY_ALGORITHM &&
		typeof candidate.digest === "string" &&
		/^[0-9a-f]{64}$/.test(candidate.digest)
	);
}

function firstLedgerMismatch(receipt: RunReceipt, envelope: RunEnvelope): string | null {
	const sharedFields: Array<[string, unknown, unknown]> = [
		["runId", receipt.runId, envelope.id],
		["agentId", receipt.agentId, envelope.agentId],
		["agentAudience", receipt.agentAudience, envelope.agentAudience],
		["requestOrigin", receipt.requestOrigin, envelope.requestOrigin],
		["task", receipt.task, envelope.task],
		["targetId", receipt.targetId, envelope.targetId],
		["wireModelId", receipt.wireModelId, envelope.wireModelId],
		["runtimeId", receipt.runtimeId, envelope.runtimeId],
		["runtimeKind", receipt.runtimeKind, envelope.runtimeKind],
		["startedAt", receipt.startedAt, envelope.startedAt],
		["endedAt", receipt.endedAt, envelope.endedAt],
		["exitCode", receipt.exitCode, envelope.exitCode],
		["tokenCount", receipt.tokenCount, envelope.tokenCount],
		["cacheReadTokenCount", receipt.cacheReadTokenCount ?? 0, envelope.cacheReadTokenCount ?? 0],
		["cacheWriteTokenCount", receipt.cacheWriteTokenCount ?? 0, envelope.cacheWriteTokenCount ?? 0],
		["reasoningTokenCount", receipt.reasoningTokenCount ?? 0, envelope.reasoningTokenCount ?? 0],
		["staticShellHash", receipt.staticShellHash ?? null, envelope.staticShellHash ?? null],
		["sessionShellHash", receipt.sessionShellHash ?? null, envelope.sessionShellHash ?? null],
		["dynamicHash", receipt.dynamicHash ?? null, envelope.dynamicHash ?? null],
		["costUsd", receipt.costUsd, envelope.costUsd],
		["sessionId", receipt.sessionId, envelope.sessionId],
		["outcome", receipt.outcome ?? null, envelope.outcome ?? null],
		["outcomeDetail", receipt.outcomeDetail ?? null, envelope.outcomeDetail ?? null],
		["nodeId", receipt.node?.id ?? null, envelope.node?.id ?? null],
	];
	for (const [field, receiptValue, ledgerValue] of sharedFields) {
		if (!Object.is(receiptValue, ledgerValue)) return field;
	}
	return null;
}

function firstLedgerMismatchV5(receipt: RunReceipt, envelope: RunEnvelope): string | null {
	const mismatch = firstLedgerMismatch(receipt, envelope);
	if (mismatch !== null) return mismatch;
	if (canonicalJson(receipt.briefing ?? null) !== canonicalJson(envelope.briefing ?? null)) return "briefing";
	if (!Object.is(receipt.outcomeCode ?? null, envelope.outcomeCode ?? null)) return "outcomeCode";
	return null;
}

export function verifyReceiptIntegrity(receipt: RunReceipt, envelope: RunEnvelope): ReceiptIntegrityResult {
	if (!isReceiptIntegrity(receipt.integrity)) {
		return { ok: false, reason: "integrity invalid" };
	}
	if (receipt.integrity.version === 4) {
		// v4 never authenticated these v5 additions. Reject the property shape
		// itself (including explicit null/undefined) so callers cannot mistake
		// unauthenticated data for verified provenance after a successful check.
		for (const field of ["briefing", "outcomeCode"] as const) {
			if (Object.hasOwn(receipt, field) || Object.hasOwn(envelope, field)) {
				return { ok: false, reason: `integrity invalid: v4 contains unauthenticated ${field}` };
			}
		}
	}
	const mismatch =
		receipt.integrity.version === 4 ? firstLedgerMismatch(receipt, envelope) : firstLedgerMismatchV5(receipt, envelope);
	if (mismatch) {
		return { ok: false, reason: `ledger mismatch: ${mismatch}` };
	}
	const expected =
		receipt.integrity.version === 4
			? computeReceiptIntegrityV4(receipt, envelope)
			: computeReceiptIntegrity(receipt, envelope);
	if (expected.digest !== receipt.integrity.digest) {
		return { ok: false, reason: "integrity mismatch" };
	}
	return { ok: true };
}
