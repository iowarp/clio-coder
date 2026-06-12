import { createHash } from "node:crypto";
import type { RunEnvelope, RunReceipt, RunReceiptDraft, RunReceiptIntegrity } from "./types.js";

/**
 * Integrity versions. v1 predates the outcome/lineage/identity blocks; v2
 * folds them into the digest. Verification branches strictly on the version
 * recorded in the receipt's integrity block, never on field-presence
 * heuristics. Receipts written before the endpointId -> targetId rename are
 * stale dev state and no longer verify; per the no-migrations mandate they
 * are wiped, not read.
 */
export const RUN_RECEIPT_INTEGRITY_VERSION = 2;
export type ReceiptIntegrityVersion = 1 | 2;
const KNOWN_INTEGRITY_VERSIONS: ReadonlySet<number> = new Set([1, 2]);
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

function receiptDigestFields(receipt: RunReceipt | RunReceiptDraft, version: ReceiptIntegrityVersion): RunReceiptDraft {
	const draft: RunReceiptDraft = {
		runId: receipt.runId,
		agentId: receipt.agentId,
		task: receipt.task,
		targetId: receipt.targetId,
		wireModelId: receipt.wireModelId,
		runtimeId: receipt.runtimeId,
		runtimeKind: receipt.runtimeKind,
		startedAt: receipt.startedAt,
		endedAt: receipt.endedAt,
		exitCode: receipt.exitCode,
		tokenCount: receipt.tokenCount,
		costUsd: receipt.costUsd,
		compiledPromptHash: receipt.compiledPromptHash,
		staticCompositionHash: receipt.staticCompositionHash,
		clioVersion: receipt.clioVersion,
		piMonoVersion: receipt.piMonoVersion,
		platform: receipt.platform,
		nodeVersion: receipt.nodeVersion,
		toolCalls: receipt.toolCalls,
		toolStats: receipt.toolStats,
		sessionId: receipt.sessionId,
	};
	if (receipt.agentAudience !== undefined) {
		draft.agentAudience = receipt.agentAudience;
	}
	if (receipt.requestOrigin !== undefined) {
		draft.requestOrigin = receipt.requestOrigin;
	}
	if (receipt.failureMessage !== undefined) {
		draft.failureMessage = receipt.failureMessage;
	}
	if (receipt.inputTokenCount !== undefined) {
		draft.inputTokenCount = receipt.inputTokenCount;
	}
	if (receipt.outputTokenCount !== undefined) {
		draft.outputTokenCount = receipt.outputTokenCount;
	}
	if (receipt.cacheReadTokenCount !== undefined) {
		draft.cacheReadTokenCount = receipt.cacheReadTokenCount;
	}
	if (receipt.cacheWriteTokenCount !== undefined) {
		draft.cacheWriteTokenCount = receipt.cacheWriteTokenCount;
	}
	if (receipt.reasoningTokenCount !== undefined) {
		draft.reasoningTokenCount = receipt.reasoningTokenCount;
	}
	if (receipt.staticShellHash !== undefined) {
		draft.staticShellHash = receipt.staticShellHash;
	}
	if (receipt.sessionShellHash !== undefined) {
		draft.sessionShellHash = receipt.sessionShellHash;
	}
	if (receipt.dynamicHash !== undefined) {
		draft.dynamicHash = receipt.dynamicHash;
	}
	if (receipt.upstreamResponses !== undefined) {
		draft.upstreamResponses = receipt.upstreamResponses;
	}
	if (receipt.toolActivity !== undefined) {
		draft.toolActivity = receipt.toolActivity;
	}
	if (receipt.skillActivations !== undefined) {
		draft.skillActivations = receipt.skillActivations;
	}
	if (receipt.safety !== undefined) {
		draft.safety = receipt.safety;
	}
	if (receipt.reproducibility !== undefined) {
		draft.reproducibility = receipt.reproducibility;
	}
	if (receipt.runtimeResolution !== undefined) {
		draft.runtimeResolution = receipt.runtimeResolution;
	}
	if (version >= 2) {
		if (receipt.outcome !== undefined) draft.outcome = receipt.outcome;
		if (receipt.outcomeDetail !== undefined) draft.outcomeDetail = receipt.outcomeDetail;
		if (receipt.lineage !== undefined) draft.lineage = receipt.lineage;
		if (receipt.identity !== undefined) draft.identity = receipt.identity;
	}
	return draft;
}

function ledgerDigestFields(envelope: RunEnvelope, version: ReceiptIntegrityVersion): Record<string, unknown> {
	if (version >= 2) {
		return {
			...ledgerDigestFieldsV1(envelope),
			outcome: envelope.outcome ?? null,
			outcomeDetail: envelope.outcomeDetail ?? null,
			lineage: envelope.lineage ?? null,
			identity: envelope.identity ?? null,
		};
	}
	return ledgerDigestFieldsV1(envelope);
}

function ledgerDigestFieldsV1(envelope: RunEnvelope): Record<string, unknown> {
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
	};
}

function integrityPayload(
	receipt: RunReceipt | RunReceiptDraft,
	envelope: RunEnvelope,
	version: ReceiptIntegrityVersion,
): Record<string, unknown> {
	return {
		contract: "clio.runReceipt.integrity",
		version,
		sources: ["receipt", "run-ledger"],
		receipt: receiptDigestFields(receipt, version),
		ledger: ledgerDigestFields(envelope, version),
	};
}

export function computeReceiptIntegrity(
	receipt: RunReceipt | RunReceiptDraft,
	envelope: RunEnvelope,
	version: ReceiptIntegrityVersion = RUN_RECEIPT_INTEGRITY_VERSION,
): RunReceiptIntegrity {
	return {
		version,
		algorithm: RUN_RECEIPT_INTEGRITY_ALGORITHM,
		digest: sha256(canonicalJson(integrityPayload(receipt, envelope, version))),
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
		typeof candidate.version === "number" &&
		KNOWN_INTEGRITY_VERSIONS.has(candidate.version) &&
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
		// Lineage/identity are structural and covered by the digest; outcome is
		// scalar and cross-checked here for a precise mismatch reason.
		["outcome", receipt.outcome ?? null, envelope.outcome ?? null],
		["outcomeDetail", receipt.outcomeDetail ?? null, envelope.outcomeDetail ?? null],
	];
	for (const [field, receiptValue, ledgerValue] of sharedFields) {
		if (!Object.is(receiptValue, ledgerValue)) return field;
	}
	return null;
}

export function verifyReceiptIntegrity(receipt: RunReceipt, envelope: RunEnvelope): ReceiptIntegrityResult {
	if (!isReceiptIntegrity(receipt.integrity)) {
		return { ok: false, reason: "integrity invalid" };
	}
	const mismatch = firstLedgerMismatch(receipt, envelope);
	if (mismatch) {
		return { ok: false, reason: `ledger mismatch: ${mismatch}` };
	}
	const expected = computeReceiptIntegrity(receipt, envelope, receipt.integrity.version);
	if (expected.digest !== receipt.integrity.digest) {
		return { ok: false, reason: "integrity mismatch" };
	}
	return { ok: true };
}
