/**
 * Read-only GitHub Copilot account quota probe over the SDK client Clio already holds.
 *
 * Uses only the runtime's own signed-in identity (`getAuthStatus` + `rpc.account.getQuota({})`),
 * capability-detects `account.getQuota`, bounds every RPC call with a single timeout, never
 * retries in a loop, and never reads external credential files.
 */

import { COPILOT_LOGIN_MESSAGE, copilotClient, heldCopilotClient, holdCopilotClient } from "./client.js";

export const COPILOT_QUOTA_TIMEOUT_MS = 15_000;

export type CopilotQuotaUnit = "requests" | "ai_credits" | "nano_aiu" | "tokens" | "unknown";

export type CopilotQuotaQuantityKind = "authoritative_budget" | "advisory_balance" | "none" | "unknown";

export type CopilotQuotaObservationKind = "account_snapshot" | "admission_state" | "unknown";

export interface CopilotQuotaAccount {
	login: string;
	host: string;
}

export interface CopilotQuotaEntry {
	key: string;
	unit: CopilotQuotaUnit;
	quantityKind: CopilotQuotaQuantityKind;
	observationKind: CopilotQuotaObservationKind;
	unlimited: boolean;
	entitlement: number | null;
	used: number | null;
	remaining: number | null;
	overage: number | null;
	remainingPercentage: number | null;
	exhausted: boolean;
	tokenBasedBilling: boolean | null;
	usageAllowedWhenExhausted: boolean | null;
	overageAllowedWhenExhausted: boolean | null;
	resetsAt: string | null;
	reason: string | null;
}

export type CopilotQuotaReadResult =
	| { kind: "ok"; account: CopilotQuotaAccount; entries: CopilotQuotaEntry[] }
	| { kind: "no_credentials"; message: string }
	| { kind: "unsupported"; message: string }
	| { kind: "error"; message: string };

export interface CopilotQuotaRpcClient {
	getAuthStatus: () => Promise<{
		isAuthenticated: boolean;
		login?: string;
		host?: string;
		statusMessage?: string;
	}>;
	rpc?: {
		account?: {
			getQuota?: (params?: Record<string, never>) => Promise<unknown>;
		};
	};
}

export interface CopilotQuotaReadOptions {
	timeoutMs?: number;
	/** Test seam: inject a client stand-in without spawning the SDK daemon. */
	client?: () => Promise<CopilotQuotaRpcClient>;
}

const DEFAULT_HOST = "https://github.com";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePct(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toUtcIso(value: unknown): string | null {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) return null;
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const ms = Date.parse(value.trim());
		if (!Number.isFinite(ms)) return null;
		return new Date(ms).toISOString();
	}
	return null;
}

function parseUnit(value: unknown): CopilotQuotaUnit | null {
	switch (value) {
		case "requests":
		case "ai_credits":
		case "nano_aiu":
		case "tokens":
		case "unknown":
			return value;
		default:
			return null;
	}
}

function parseQuantityKind(value: unknown): CopilotQuotaQuantityKind | null {
	switch (value) {
		case "authoritative_budget":
		case "advisory_balance":
		case "none":
			return value;
		default:
			return null;
	}
}

function parseObservationKind(value: unknown): CopilotQuotaObservationKind | null {
	switch (value) {
		case "account_snapshot":
		case "admission_state":
			return value;
		default:
			return null;
	}
}

function parseProviderQuotaState(raw: unknown): CopilotQuotaEntry | null {
	if (!isRecord(raw)) return null;
	const key = nonEmptyString(raw.compatibilityKey) ?? nonEmptyString(raw.quotaId);
	if (!key) return null;
	const budget = isRecord(raw.budgetMetadata) ? raw.budgetMetadata : null;
	const monthly = isRecord(raw.monthlyUsage) ? raw.monthlyUsage : null;
	const tokenBasedBilling = typeof budget?.tokenBasedBilling === "boolean" ? budget.tokenBasedBilling : null;
	const explicitUnit = parseUnit(raw.unit);
	const unit: CopilotQuotaUnit = explicitUnit ?? (tokenBasedBilling === true ? "ai_credits" : "unknown");
	const quantityKind: CopilotQuotaQuantityKind = parseQuantityKind(raw.quantityKind) ?? "unknown";
	const observationKind: CopilotQuotaObservationKind = parseObservationKind(raw.observationKind) ?? "unknown";
	const unlimited =
		raw.capacityState === "unlimited" ||
		budget?.unlimited === true ||
		raw.entitledQuantity === -1 ||
		budget?.entitlement === -1;
	const entitlement = unlimited
		? null
		: (finiteNonNegative(budget?.entitlement) ?? finiteNonNegative(raw.entitledQuantity));
	const monthlyUnit = parseUnit(monthly?.unit);
	const monthlyConsumed =
		monthly?.state === "available" && unit !== "unknown" && monthlyUnit === unit
			? finiteNonNegative(monthly.consumedQuantity)
			: null;
	const used = finiteNonNegative(budget?.consumed) ?? monthlyConsumed;
	const remaining = finiteNonNegative(raw.availableQuantity);
	const overage = finiteNonNegative(budget?.overage);
	const remainingPercentage = finitePct(budget?.remainingPercentage);
	const exhausted = raw.capacityState === "exhausted" || raw.accessState === "denied";
	const resetsAt = toUtcIso(budget?.resetAtEpochMs) ?? toUtcIso(monthly?.resetOn);
	return {
		key,
		unit,
		quantityKind,
		observationKind,
		unlimited,
		entitlement,
		used,
		remaining,
		overage,
		remainingPercentage,
		exhausted,
		tokenBasedBilling,
		usageAllowedWhenExhausted:
			typeof budget?.usageAllowedWhenExhausted === "boolean" ? budget.usageAllowedWhenExhausted : null,
		overageAllowedWhenExhausted:
			typeof budget?.overageAllowedWhenExhausted === "boolean" ? budget.overageAllowedWhenExhausted : null,
		resetsAt,
		reason: nonEmptyString(raw.reason),
	};
}

function parseLegacyQuotaSnapshot(key: string, raw: unknown): CopilotQuotaEntry | null {
	if (!isRecord(raw)) return null;
	const tokenBasedBilling = typeof raw.tokenBasedBilling === "boolean" ? raw.tokenBasedBilling : null;
	const explicitUnit = parseUnit(raw.unit);
	const unit: CopilotQuotaUnit =
		explicitUnit && explicitUnit !== "unknown" ? explicitUnit : tokenBasedBilling === true ? "ai_credits" : "requests";
	const quantityKind: CopilotQuotaQuantityKind = parseQuantityKind(raw.quantityKind) ?? "authoritative_budget";
	const observationKind: CopilotQuotaObservationKind = parseObservationKind(raw.observationKind) ?? "account_snapshot";
	const unlimited =
		raw.isUnlimitedEntitlement === true ||
		raw.entitlementRequests === -1 ||
		raw.entitledQuantity === -1 ||
		raw.capacityState === "unlimited";
	const entitlement = unlimited
		? null
		: (finiteNonNegative(raw.entitledQuantity) ?? finiteNonNegative(raw.entitlementRequests));
	const used = finiteNonNegative(raw.usedRequests) ?? finiteNonNegative(raw.consumedQuantity);
	const remaining = finiteNonNegative(raw.availableQuantity);
	const overage = finiteNonNegative(raw.overage);
	const remainingPercentage = finitePct(raw.remainingPercentage);
	const usageAllowedWhenExhausted =
		typeof raw.usageAllowedWithExhaustedQuota === "boolean" ? raw.usageAllowedWithExhaustedQuota : null;
	const overageAllowedWhenExhausted =
		typeof raw.overageAllowedWithExhaustedQuota === "boolean" ? raw.overageAllowedWithExhaustedQuota : null;
	const exhausted =
		raw.capacityState === "exhausted" ||
		raw.accessState === "denied" ||
		raw.hasQuota === false ||
		(!unlimited &&
			entitlement !== null &&
			entitlement > 0 &&
			used !== null &&
			used >= entitlement &&
			usageAllowedWhenExhausted === false);
	const resetsAt = toUtcIso(raw.resetDate) ?? toUtcIso(raw.resetDateEpochMs) ?? toUtcIso(raw.resetAtEpochMs);
	return {
		key,
		unit,
		quantityKind,
		observationKind,
		unlimited,
		entitlement,
		used,
		remaining,
		overage,
		remainingPercentage,
		exhausted,
		tokenBasedBilling,
		usageAllowedWhenExhausted,
		overageAllowedWhenExhausted,
		resetsAt,
		reason: nonEmptyString(raw.reason),
	};
}

function unitDedupeFamily(unit: CopilotQuotaUnit): string {
	return unit === "nano_aiu" || unit === "ai_credits" ? "credits" : unit;
}

function entryDedupeKey(entry: CopilotQuotaEntry): string {
	return `${unitDedupeFamily(entry.unit)}\0${entry.key}`;
}

/**
 * Parse a raw `account.getQuota` payload into normalized entries without inventing defaults.
 * Returns `null` when the payload does not carry a recognized quota container.
 */
export function parseCopilotQuotaResponse(raw: unknown): CopilotQuotaEntry[] | null {
	if (!isRecord(raw)) return null;
	const hasProviderQuotas = Array.isArray(raw.providerQuotas);
	const hasSnapshots = isRecord(raw.quotaSnapshots);
	if (!hasProviderQuotas && !hasSnapshots) return null;

	const entries: CopilotQuotaEntry[] = [];
	const seen = new Set<string>();

	if (hasProviderQuotas) {
		for (const item of raw.providerQuotas as unknown[]) {
			const entry = parseProviderQuotaState(item);
			if (!entry) continue;
			const dedupeKey = entryDedupeKey(entry);
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
			entries.push(entry);
		}
	}

	if (hasSnapshots) {
		for (const [key, value] of Object.entries(raw.quotaSnapshots as Record<string, unknown>)) {
			if (!key.trim()) continue;
			const entry = parseLegacyQuotaSnapshot(key, value);
			if (!entry) continue;
			const dedupeKey = entryDedupeKey(entry);
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
			entries.push(entry);
		}
	}

	return entries;
}

class CopilotQuotaTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`GitHub Copilot quota poll timed out after ${timeoutMs}ms`);
		this.name = "CopilotQuotaTimeoutError";
	}
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
	const boundedMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : COPILOT_QUOTA_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new CopilotQuotaTimeoutError(boundedMs)), boundedMs);
		timer.unref?.();
	});
	// Absorb late rejections from the underlying RPC if the timeout wins the race.
	work.catch(() => {});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function errorCode(error: unknown): string | number | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isUnsupportedRpcError(error: unknown): boolean {
	const code = errorCode(error);
	if (code === -32601) return true;
	return /method not found|unknown method|not supported|not implemented|unsupported/i.test(errorMessage(error));
}

function isAuthError(error: unknown): boolean {
	const code = errorCode(error);
	if (code === "COPILOT_LOGIN_REQUIRED" || code === "COPILOT_SDK_UNAVAILABLE") return true;
	return /not authenticated|not signed in|unauthenticated|login required/i.test(errorMessage(error));
}

/**
 * Inspect the signed-in GitHub Copilot account ONLY from an already-running SDK client
 * (never spawns a Copilot runtime daemon and never reads external credential files).
 */
export async function readCopilotSignedInAccount(
	options: CopilotQuotaReadOptions = {},
): Promise<CopilotQuotaAccount | null> {
	const timeoutMs = options.timeoutMs ?? COPILOT_QUOTA_TIMEOUT_MS;
	const client = options.client ? await options.client() : (heldCopilotClient() as CopilotQuotaRpcClient | null);
	if (!client) return null;
	try {
		return await withTimeout(
			(async () => {
				const auth = await client.getAuthStatus();
				if (!auth.isAuthenticated || !auth.login) return null;
				return { login: auth.login, host: auth.host ?? DEFAULT_HOST };
			})(),
			timeoutMs,
		);
	} catch {
		return null;
	}
}

/**
 * Single read-only `account.getQuota({})` poll against the signed-in GitHub Copilot runtime.
 * Never retries in a loop and returns an explicit unsupported/error/no_credentials outcome
 * rather than guessing quota values.
 */
export async function readCopilotQuota(options: CopilotQuotaReadOptions = {}): Promise<CopilotQuotaReadResult> {
	const timeoutMs = options.timeoutMs ?? COPILOT_QUOTA_TIMEOUT_MS;
	const release = options.client ? null : holdCopilotClient();
	try {
		return await withTimeout(
			(async (): Promise<CopilotQuotaReadResult> => {
				const client = options.client ? await options.client() : ((await copilotClient()) as CopilotQuotaRpcClient);
				const auth = await client.getAuthStatus();
				if (!auth.isAuthenticated || !auth.login) {
					return { kind: "no_credentials", message: auth.statusMessage ?? COPILOT_LOGIN_MESSAGE };
				}
				const account: CopilotQuotaAccount = { login: auth.login, host: auth.host ?? DEFAULT_HOST };
				const accountRpc = client.rpc?.account;
				if (!accountRpc || typeof accountRpc.getQuota !== "function") {
					return {
						kind: "unsupported",
						message: "GitHub Copilot runtime does not expose account.getQuota (quota unknown)",
					};
				}
				const raw = await accountRpc.getQuota({});
				const entries = parseCopilotQuotaResponse(raw);
				if (entries === null) {
					return {
						kind: "error",
						message: "Unexpected GitHub Copilot account.getQuota response (quota unknown)",
					};
				}
				return { kind: "ok", account, entries };
			})(),
			timeoutMs,
		);
	} catch (error) {
		if (isAuthError(error)) {
			return { kind: "no_credentials", message: errorMessage(error) };
		}
		if (isUnsupportedRpcError(error)) {
			return {
				kind: "unsupported",
				message: `GitHub Copilot account.getQuota unavailable (quota unknown): ${errorMessage(error)}`,
			};
		}
		return { kind: "error", message: `GitHub Copilot quota poll failed (quota unknown): ${errorMessage(error)}` };
	} finally {
		release?.();
	}
}
