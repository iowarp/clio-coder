import { createHash } from "node:crypto";

/** Funding describes observed or declared facts. It does not authorize or ration spending. */
export const FUNDING_SCHEMES = ["detected", "declared", "unknown"] as const;
export const FUNDING_PAYERS = ["personal", "sponsor", "employer", "none"] as const;
export const FUNDING_PERIODS = ["day", "week", "month", "year", "one-time"] as const;
export const FUNDING_SIGNALS = ["local-native", "oauth-login"] as const;

export type FundingScheme = (typeof FUNDING_SCHEMES)[number];
export type FundingPayer = (typeof FUNDING_PAYERS)[number];
export type FundingPeriod = (typeof FUNDING_PERIODS)[number];
export type FundingSignal = (typeof FUNDING_SIGNALS)[number];

export interface FundingPool {
	scheme: FundingScheme;
	payer?: FundingPayer;
	nativeUnit?: string;
	fee?: { amount: number; currency: string; period: FundingPeriod };
	grant?: { amount?: number; expiresAt: string };
	local?: { activeWatts?: number; idleWatts?: number; tariff?: { ratePerKwh: number; currency: string } };
}

export type FundingDefinitions = Record<string, FundingPool>;

export interface FundingObservation {
	signal: FundingSignal;
	loginStamp: string;
}

export interface FundingBinding {
	pool: string;
	detection?: FundingObservation & { verifiedAt: string };
}

export const FUNDING_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/u;
export const FUNDING_UNIT_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,47}$/u;
export const FUNDING_STAMP_PATTERN = /^[a-f0-9]{64}$/u;

let currencies: Set<string> | undefined;

export function isFundingCurrency(value: string): boolean {
	currencies ??= new Set(Intl.supportedValuesOf("currency"));
	return currencies.has(value);
}

export function isFundingInstant(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value.replace(/(?<!\.\d{3})Z$/u, ".000Z");
}

export function isInstitutionalPool(pool: FundingPool): boolean {
	return pool.payer === "sponsor" || pool.payer === "employer";
}

/** Only derived from route metadata and a non-secret credential revision, never a key or provider account number. */
export function makeFundingObservation(
	signal: FundingSignal,
	runtime: string,
	url: string | undefined,
	credentialRevision?: { ref: string; updatedAt: string; expires: number },
): FundingObservation {
	const loginStamp = createHash("sha256")
		.update(JSON.stringify(["funding-route-v1", signal, runtime, url ?? null, credentialRevision ?? null]))
		.digest("hex");
	return { signal, loginStamp };
}

export type FundingResolution =
	| { status: "unknown"; reason: "unbound" | "unknown-pool" | "unknown-scheme" | "unverified-login" | "login-changed" }
	| { status: "declared"; poolId: string; pool: FundingPool }
	| { status: "detected"; poolId: string; pool: FundingPool; detection: NonNullable<FundingBinding["detection"]> };

/** Resolve against the current local observation, never the route name alone. */
export function resolveFundingBinding(
	definitions: Readonly<FundingDefinitions>,
	binding: FundingBinding | undefined,
	observation: FundingObservation | undefined,
): FundingResolution {
	if (binding === undefined) return { status: "unknown", reason: "unbound" };
	const pool = Object.hasOwn(definitions, binding.pool) ? definitions[binding.pool] : undefined;
	if (pool === undefined) return { status: "unknown", reason: "unknown-pool" };
	if (pool.scheme === "unknown") return { status: "unknown", reason: "unknown-scheme" };
	if (pool.scheme === "declared") return { status: "declared", poolId: binding.pool, pool };
	const detection = binding.detection;
	if (detection === undefined || observation === undefined) return { status: "unknown", reason: "unverified-login" };
	if (detection.loginStamp !== observation.loginStamp || detection.signal !== observation.signal)
		return { status: "unknown", reason: "login-changed" };
	return { status: "detected", poolId: binding.pool, pool, detection };
}
