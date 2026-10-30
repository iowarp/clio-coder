import { createHash } from "node:crypto";
import { isExecutionRole } from "./execution-role.js";
import { RECEIPT_HASH_SET, undeclaredReceiptHashes } from "./receipt-hashes.js";
import { isRouteDecisionAgentSelection } from "./route-decision.js";
import { ROUTE_POLICY_VERSION } from "./route-policy.js";
import { isRoutingIntent } from "./routing-intent.js";
import type {
	RunEnvelope,
	RunReceipt,
	RunReceiptDraft,
	RunReceiptIntegrity,
	RunReceiptLedgerCommitment,
	RunReceiptQuality,
} from "./types.js";

/**
 * The single receipt integrity contract. Historical receipts sealed under
 * this version retain their digest coverage when optional fields change.
 */
export const RUN_RECEIPT_INTEGRITY_VERSION: RunReceiptIntegrity["version"] = 21;
export type ReceiptIntegrityVersion = RunReceiptIntegrity["version"];
export type ReceiptIntegrityField = keyof RunReceiptDraft;
export const RUN_RECEIPT_INTEGRITY_ALGORITHM = "sha256";

/** `ledgerEvicted` means the receipt's own seal verified while its ledger row was no longer available (#434). */
export type ReceiptIntegrityResult = { ok: true; ledgerEvicted?: true } | { ok: false; reason: string };

function sha256(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Sorted-key JSON, the one serialization every Clio digest over a JSON value uses. */
export function canonicalJson(value: unknown): string {
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
export const RECEIPT_INTEGRITY_FIELD_COVERAGE = {
	runId: true,
	cwd: true,
	agentId: true,
	executionRole: true,
	agentAudience: true,
	requestOrigin: true,
	task: true,
	intent: true,
	pathScope: true,
	// Historical receipts omit this field, so their receipt and ledger payloads remain unchanged.
	budget: true,
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
	attestation: true,
	reroutes: true,
	pipeline: true,
	gate: true,
	council: true,
	plan: true,
	fleetGate: true,
	personaOverride: true,
	// Absent unless the parent board held decisions, so older receipts and
	// decision-free runs digest exactly as before.
	decisionRefs: true,
	projectContext: true,
	// Always set on receipts written after #104 landed; absent only on older
	// receipts, which omit these fields from canonical serialization.
	rulesApplied: true,
	operatorProfileApplied: true,
	exitCode: true,
	failureMessage: true,
	tokenCount: true,
	apiCalls: true,
	toolRounds: true,
	missingTokenCalls: true,
	costSummary: true,
	inputTokenCount: true,
	outputTokenCount: true,
	cacheReadTokenCount: true,
	cacheWriteTokenCount: true,
	cacheWrite1hTokenCount: true,
	reasoningTokenCount: true,
	upstreamResponses: true,
	output: true,
	costUsd: true,
	costProvenance: true,
	externalTelemetry: true,
	checkoutChanges: true,
	compiledPromptHash: true,
	staticCompositionHash: true,
	staticShellHash: true,
	sessionShellHash: true,
	dynamicHash: true,
	promptSignature: true,
	toolSignature: true,
	clioCoderVersion: true,
	piMonoVersion: true,
	platform: true,
	nodeVersion: true,
	toolCalls: true,
	toolStats: true,
	toolActivity: true,
	verification: true,
	hostVerification: true,
	worktree: true,
	routingIntent: true,
	// Absent on receipts sealed before the field existed, so those digest
	// exactly as they did.
	effectiveFailover: true,
	quality: true,
	skillActivations: true,
	// Keep the historical field in the digest so older sealed receipts still verify.
	autonomyEnforcement: true,
	autonomy: true,
	safety: true,
	// Optional and absent on worker receipts and on older main-agent receipts,
	// so those digest exactly as they did before the field existed.
	noop: true,
	reproducibility: true,
	runtimeResolution: true,
	delegation: true,
	findingsSummary: true,
	// Both are optional and absent unless the run produced the condition they
	// name, so a receipt that carries neither digests exactly as it did before
	// they existed and the integrity version stays where it is.
	validationGrounding: true,
	capabilityMismatch: true,
	// Same reasoning: absent unless the run had an agent ledger, so a receipt
	// without one omits the field from canonical serialization.
	ledgerContribution: true,
	sessionId: true,
	briefing: true,
	workerContext: true,
	outcomeCode: true,
	steering: true,
	routeDecision: true,
	// Absent unless `clio-coder run --max-cost-usd` capped the run, so every
	// other receipt digests exactly as it did before the field existed.
	costCap: true,
	callIds: true,
	terminalReason: true,
	hashSet: true,
} as const satisfies Record<ReceiptIntegrityField, true> & { autonomyEnforcement: true };

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

function receiptDigestFields(receipt: RunReceipt | RunReceiptDraft): Record<string, unknown> {
	const result = selectedReceiptFields(receipt, RECEIPT_FIELDS);
	result.briefing = receipt.briefing ?? null;
	result.outcomeCode = receipt.outcomeCode ?? null;
	result.steering = receipt.steering ?? null;
	return result;
}

function ledgerDigestFields(envelope: RunEnvelope): Record<string, unknown> {
	return {
		id: envelope.id,
		agentId: envelope.agentId,
		executionRole: envelope.executionRole,
		task: envelope.task,
		...(envelope.budget !== undefined ? { budget: envelope.budget } : {}),
		...(envelope.decisionRefs !== undefined ? { decisionRefs: envelope.decisionRefs } : {}),
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
		...(envelope.costSummary ? { costSummary: envelope.costSummary } : {}),
		...(envelope.apiCalls === undefined ? {} : { apiCalls: envelope.apiCalls }),
		...(envelope.missingTokenCalls === undefined ? {} : { missingTokenCalls: envelope.missingTokenCalls }),
		cacheReadTokenCount: envelope.cacheReadTokenCount,
		cacheWriteTokenCount: envelope.cacheWriteTokenCount,
		cacheWrite1hTokenCount: envelope.cacheWrite1hTokenCount,
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
		briefing: envelope.briefing ?? null,
		...(envelope.workerContext !== undefined ? { workerContext: envelope.workerContext } : {}),
		outcomeCode: envelope.outcomeCode ?? null,
		steering: envelope.steering ?? null,
	};
}

function ledgerCommitment(envelope: RunEnvelope): RunReceiptLedgerCommitment {
	return {
		label: "commitment",
		function: "sha256",
		canonicalization: "json-sorted-v1",
		subject: "run-ledger-projection",
		digest: sha256(
			canonicalJson({
				contract: "clio-coder.runLedger.projection",
				version: RUN_RECEIPT_INTEGRITY_VERSION,
				ledger: ledgerDigestFields(envelope),
			}),
		),
	};
}

/** The seal covers the receipt and a commitment to its ledger row, never the row itself (#434). */
function receiptDigest(receipt: RunReceipt | RunReceiptDraft, ledger: RunReceiptLedgerCommitment): string {
	return sha256(
		canonicalJson({
			contract: "clio-coder.runReceipt.integrity",
			version: RUN_RECEIPT_INTEGRITY_VERSION,
			sources: ["receipt", "run-ledger-commitment"],
			receipt: receiptDigestFields(receipt),
			ledger,
		}),
	);
}

function computeReceiptIntegrity(receipt: RunReceipt | RunReceiptDraft, envelope: RunEnvelope): RunReceiptIntegrity {
	const ledger = ledgerCommitment(envelope);
	return {
		version: RUN_RECEIPT_INTEGRITY_VERSION,
		algorithm: RUN_RECEIPT_INTEGRITY_ALGORITHM,
		digest: receiptDigest(receipt, ledger),
		ledger,
	};
}

function isReceiptQuality(value: unknown): value is RunReceiptQuality {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const quality = value as Record<string, unknown>;
	if (quality.version !== 1 || !Array.isArray(quality.typedValidations)) return false;
	if (
		!quality.typedValidations.every(
			(fact) =>
				fact !== null &&
				typeof fact === "object" &&
				typeof (fact as Record<string, unknown>).sourceId === "string" &&
				typeof (fact as Record<string, unknown>).validatorDigest === "string" &&
				/^[0-9a-f]{64}$/.test(String((fact as Record<string, unknown>).validatorDigest)) &&
				typeof (fact as Record<string, unknown>).passed === "boolean",
		)
	)
		return false;
	const schema = quality.responseSchema;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const responseSchema = schema as Record<string, unknown>;
	const resultContract = quality.resultContract;
	const validResultContract =
		resultContract === null ||
		(resultContract !== undefined &&
			typeof resultContract === "object" &&
			!Array.isArray(resultContract) &&
			typeof (resultContract as Record<string, unknown>).sourceId === "string" &&
			typeof (resultContract as Record<string, unknown>).validatorDigest === "string" &&
			/^[0-9a-f]{64}$/.test(String((resultContract as Record<string, unknown>).validatorDigest)) &&
			((resultContract as Record<string, unknown>).conformance === "pass" ||
				(resultContract as Record<string, unknown>).conformance === "fail" ||
				(resultContract as Record<string, unknown>).conformance === "not-reached") &&
			((resultContract as Record<string, unknown>).quality === "pass" ||
				(resultContract as Record<string, unknown>).quality === "fail" ||
				(resultContract as Record<string, unknown>).quality === "unmeasured"));
	return (
		(responseSchema.sourceId === null || typeof responseSchema.sourceId === "string") &&
		(responseSchema.schemaDigest === null ||
			(typeof responseSchema.schemaDigest === "string" && /^[0-9a-f]{64}$/.test(responseSchema.schemaDigest))) &&
		typeof responseSchema.runtimeEnforceable === "boolean" &&
		(responseSchema.enforcementPassed === null || typeof responseSchema.enforcementPassed === "boolean") &&
		validResultContract
	);
}

function isCurrentRouteDecision(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const decision = value as Record<string, unknown>;
	return (
		decision.policyVersion === ROUTE_POLICY_VERSION &&
		(decision.mode === "fixed" || decision.mode === "shadow" || decision.mode === "active") &&
		isRouteDecisionAgentSelection(decision.agentSelection) &&
		typeof decision.decisionHash === "string" &&
		/^[0-9a-f]{64}$/u.test(decision.decisionHash)
	);
}

export function withReceiptIntegrity(receipt: RunReceiptDraft, envelope: RunEnvelope): RunReceipt {
	if (!isReceiptQuality(receipt.quality)) throw new Error("receipt integrity: required quality block invalid");
	if (!isExecutionRole(receipt.executionRole)) throw new Error("receipt integrity: required execution role invalid");
	if (!isRoutingIntent(receipt.routingIntent)) {
		throw new Error("receipt integrity: required routing intent invalid");
	}
	if (receipt.routeDecision !== undefined && !isCurrentRouteDecision(receipt.routeDecision)) {
		throw new Error("receipt integrity: route decision is invalid or retired");
	}
	// R7: a hash without a declared function, canonicalization, subject and label is never sealed (#434).
	const undeclared = undeclaredReceiptHashes(receipt, receipt.agentId);
	if (undeclared.length > 0) throw new Error(`receipt integrity: undeclared hashes ${undeclared.join(", ")}`);
	const declared: RunReceiptDraft = { ...receipt, hashSet: RECEIPT_HASH_SET };
	return {
		...declared,
		routingIntent: receipt.routingIntent,
		integrity: computeReceiptIntegrity(declared, envelope),
	};
}

export function isReceiptIntegrity(value: unknown): value is RunReceiptIntegrity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	const ledger = candidate.ledger as Record<string, unknown> | null | undefined;
	return (
		candidate.version === RUN_RECEIPT_INTEGRITY_VERSION &&
		candidate.algorithm === RUN_RECEIPT_INTEGRITY_ALGORITHM &&
		typeof candidate.digest === "string" &&
		/^[0-9a-f]{64}$/.test(candidate.digest) &&
		typeof ledger === "object" &&
		ledger !== null &&
		ledger.label === "commitment" &&
		ledger.function === "sha256" &&
		ledger.canonicalization === "json-sorted-v1" &&
		ledger.subject === "run-ledger-projection" &&
		typeof ledger.digest === "string" &&
		/^[0-9a-f]{64}$/.test(ledger.digest)
	);
}

function firstLedgerMismatch(receipt: RunReceipt, envelope: RunEnvelope): string | null {
	const sharedFields: Array<[string, unknown, unknown]> = [
		["runId", receipt.runId, envelope.id],
		["agentId", receipt.agentId, envelope.agentId],
		["executionRole", receipt.executionRole, envelope.executionRole],
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
		["apiCalls", receipt.apiCalls ?? null, envelope.apiCalls ?? null],
		["missingTokenCalls", receipt.missingTokenCalls ?? null, envelope.missingTokenCalls ?? null],
		["cacheReadTokenCount", receipt.cacheReadTokenCount ?? 0, envelope.cacheReadTokenCount ?? 0],
		["cacheWriteTokenCount", receipt.cacheWriteTokenCount ?? 0, envelope.cacheWriteTokenCount ?? 0],
		["cacheWrite1hTokenCount", receipt.cacheWrite1hTokenCount ?? 0, envelope.cacheWrite1hTokenCount ?? 0],
		["reasoningTokenCount", receipt.reasoningTokenCount ?? 0, envelope.reasoningTokenCount ?? 0],
		["staticShellHash", receipt.staticShellHash ?? null, envelope.staticShellHash ?? null],
		["sessionShellHash", receipt.sessionShellHash ?? null, envelope.sessionShellHash ?? null],
		["dynamicHash", receipt.dynamicHash ?? null, envelope.dynamicHash ?? null],
		["costUsd", receipt.costUsd, envelope.costUsd],
		["sessionId", receipt.sessionId, envelope.sessionId],
		["outcome", receipt.outcome ?? null, envelope.outcome ?? null],
		["outcomeDetail", receipt.outcomeDetail ?? null, envelope.outcomeDetail ?? null],
		["nodeId", receipt.node?.id ?? null, envelope.node?.id ?? null],
		["outcomeCode", receipt.outcomeCode ?? null, envelope.outcomeCode ?? null],
	];
	for (const [field, receiptValue, ledgerValue] of sharedFields) {
		if (!Object.is(receiptValue, ledgerValue)) return field;
	}
	if (canonicalJson(receipt.costSummary ?? null) !== canonicalJson(envelope.costSummary ?? null)) return "costSummary";
	if (receipt.cwd !== undefined && receipt.cwd !== envelope.cwd) return "cwd";
	if (canonicalJson(receipt.briefing ?? null) !== canonicalJson(envelope.briefing ?? null)) return "briefing";
	if (canonicalJson(receipt.workerContext ?? null) !== canonicalJson(envelope.workerContext ?? null))
		return "workerContext";
	if (canonicalJson(receipt.budget ?? null) !== canonicalJson(envelope.budget ?? null)) return "budget";
	if (canonicalJson(receipt.steering ?? null) !== canonicalJson(envelope.steering ?? null)) return "steering";
	return null;
}

/**
 * Verify the receipt's own seal, then its ledger row when the ring still holds
 * it. A null envelope is an evicted row: the seal alone verifies, and the
 * result says the ledger could not be compared (#434).
 */
export function verifyReceiptIntegrity(receipt: RunReceipt, envelope: RunEnvelope | null): ReceiptIntegrityResult {
	if (!isReceiptQuality(receipt.quality) || !isReceiptIntegrity(receipt.integrity)) {
		return { ok: false, reason: "integrity invalid" };
	}
	if (!isExecutionRole(receipt.executionRole)) return { ok: false, reason: "execution role invalid" };
	if (!isRoutingIntent(receipt.routingIntent)) {
		return { ok: false, reason: "routing intent invalid" };
	}
	if (receipt.routeDecision !== undefined && !isCurrentRouteDecision(receipt.routeDecision)) {
		return { ok: false, reason: "route decision invalid" };
	}
	if (receiptDigest(receipt, receipt.integrity.ledger) !== receipt.integrity.digest) {
		return { ok: false, reason: "integrity mismatch" };
	}
	if (envelope === null) return { ok: true, ledgerEvicted: true };
	const mismatch = firstLedgerMismatch(receipt, envelope);
	if (mismatch) {
		return { ok: false, reason: `ledger mismatch: ${mismatch}` };
	}
	if (ledgerCommitment(envelope).digest !== receipt.integrity.ledger.digest) {
		return { ok: false, reason: "ledger mismatch: commitment" };
	}
	return { ok: true };
}
