/**
 * GitHub Copilot quota provider (read-only poll via `@github/copilot-sdk` `account.getQuota`).
 *
 * Uses the signed-in Copilot runtime identity through the `src/engine/ai.ts` lazy seam:
 * - never reads external credential files
 * - never infers a subscription plan (`plan` stays `null`)
 * - never applies a legacy request multiplier to AI credits (`nano_aiu / 1e9 = AI credits`)
 * - marks unlimited only per bucket when the provider explicitly reports unlimited or `-1`
 * - computes percentage only from an authoritative numerator and positive denominator
 * - keeps advisory vs authoritative explicit in the rendered display
 * - journals a bucket without an authoritative pair (unlimited, advisory, admission) as an allowance: unit, reset and
 *   status, never a percent
 * - states access only from the SDK's own verdict, else from an authoritative budget and its exhaustion policy, scoped
 *   to the bucket; a failed acquisition states nothing
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSettings } from "../../core/config.js";
import { copilotKeychainAllowed } from "../../core/copilot-keychain.js";
import type { EconomyUnit } from "../../core/telemetry/economy.js";
import { explicitAgentHome, interopDisabled, isClioHomeRelocated } from "../../core/xdg.js";
import {
	type CopilotQuotaAccount,
	type CopilotQuotaEntry,
	type CopilotQuotaReadOptions,
	type CopilotQuotaReadResult,
	copilotSdkSignedInAccount,
	readCopilotSdkQuota,
} from "../../engine/ai.js";
import { accountPseudonym } from "./pool-reading.js";
import {
	credentialFingerprint,
	type QuotaAccess,
	type QuotaOverage,
	type QuotaProvider,
	type QuotaQualification,
	type UsageAllowance,
	type UsageCredits,
	type UsageSnapshot,
	type UsageWindow,
} from "./types.js";

export const COPILOT_QUOTA_PROVIDER_ID = "copilot";
export const NANO_AIU_PER_AI_CREDIT = 1_000_000_000;

export interface CopilotQuotaOptions {
	readQuota?: (options?: CopilotQuotaReadOptions) => Promise<CopilotQuotaReadResult>;
	readAccount?: (options?: CopilotQuotaReadOptions) => Promise<CopilotQuotaAccount | null>;
	/** Override whether a `copilot-sdk` target is configured; defaults to checking settings. */
	hasConfiguredTarget?: () => boolean;
	timeoutMs?: number;
	now?: () => Date;
}

export interface MappedCopilotQuota {
	windows: UsageWindow[];
	allowances: UsageAllowance[];
	credits: UsageCredits | null;
	message: string | null;
}

const BUCKET_ORDER: Readonly<Record<string, number>> = {
	premium_interactions: 0,
	chat: 1,
	completions: 2,
};

function bucketSortKey(key: string): number {
	return BUCKET_ORDER[key] ?? 100;
}

function bucketLabel(key: string): { label: string; short: string } {
	switch (key) {
		case "premium_interactions":
			return { label: "Premium", short: "prem" };
		case "chat":
			return { label: "Chat", short: "chat" };
		case "completions":
			return { label: "Completions", short: "comp" };
		default: {
			const words = key
				.split(/[_-]+/)
				.filter((part) => part.length > 0)
				.map((part) => (part[0] ? part[0].toUpperCase() + part.slice(1) : part));
			const label = words.length > 0 ? words.join(" ") : key;
			const short = key.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "quota";
			return { label, short };
		}
	}
}

function unitLabel(entry: CopilotQuotaEntry): string | null {
	switch (entry.unit) {
		case "nano_aiu":
		case "ai_credits":
			return "AI credits";
		case "requests":
			return entry.key === "premium_interactions" ? "premium requests" : "requests";
		case "tokens":
			return "tokens";
		case "unknown":
			return null;
	}
}

function scaleNativeQuantity(value: number | null, unit: CopilotQuotaEntry["unit"]): number | null {
	if (value === null || !Number.isFinite(value) || value < 0) return null;
	if (unit === "nano_aiu") return value / NANO_AIU_PER_AI_CREDIT;
	return value;
}

function formatQuantity(value: number): string {
	if (Number.isInteger(value)) return String(value);
	const rounded = Math.round(value * 1000) / 1000;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/\.?0+$/, "");
}

function roundPct(numerator: number, denominator: number): number {
	return Math.min(100, Math.max(0, Math.round((numerator / denominator) * 10_000) / 100));
}

/** The native unit a bucket counts, as the SDK named it. */
function nativeUnit(entry: CopilotQuotaEntry): EconomyUnit {
	switch (entry.unit) {
		case "requests":
			return entry.key === "premium_interactions" ? "premium-requests" : "requests";
		case "ai_credits":
			return "provider-credits";
		case "nano_aiu":
			return "nano-aiu";
		case "tokens":
			return "tokens";
		case "unknown":
			return "unknown";
	}
}

function qualificationOf(entry: CopilotQuotaEntry): QuotaQualification | undefined {
	if (entry.observationKind === "admission_state") return "admission";
	switch (entry.quantityKind) {
		case "authoritative_budget":
			return "authoritative";
		case "advisory_balance":
			return "advisory";
		case "none":
			return "none";
		default:
			return undefined;
	}
}

/** The SDK received a service observation for the bucket (the legacy shape reports no acquisition status). */
function acquired(entry: CopilotQuotaEntry): boolean {
	return entry.acquisition !== "failed" && entry.acquisition !== "unavailable";
}

/**
 * One bucket's admission evidence. The SDK's own verdict (access state, then the service's admission flag) stands as
 * stated, whatever the balance. Without one, only an authoritative budget speaks: allowed when unlimited, when its
 * policy lets usage or overage continue, or when something remains; denied when exhausted (capacity exhausted or
 * nothing remaining) with usage and overage both refused past exhaustion. A failed acquisition states nothing.
 */
function copilotEntryAccess(entry: CopilotQuotaEntry): { access: QuotaAccess; overage: QuotaOverage } {
	if (!acquired(entry)) return { access: "unknown", overage: "unknown" };
	const overage: QuotaOverage =
		entry.overageAllowedWhenExhausted === true
			? "permitted"
			: entry.overageAllowedWhenExhausted === false
				? "refused"
				: "unknown";
	if (entry.accessState === "denied") return { access: "denied", overage };
	if (entry.accessState === "allowed" || entry.accessState === "not_required" || entry.hasQuota === true)
		return { access: "allowed", overage };
	if (entry.quantityKind !== "authoritative_budget") return { access: "unknown", overage };
	if (entry.unlimited || entry.usageAllowedWhenExhausted === true || entry.overageAllowedWhenExhausted === true)
		return { access: "allowed", overage };
	const remaining =
		entry.remaining ??
		(entry.entitlement !== null && entry.used !== null ? Math.max(0, entry.entitlement - entry.used) : null);
	if ((entry.exhausted || remaining === 0) && entry.overageAllowedWhenExhausted === false)
		return { access: "denied", overage };
	return { access: remaining !== null && remaining > 0 ? "allowed" : "unknown", overage };
}

/**
 * Account-wide evidence over the buckets. A bucket's verdict stays on its own window: the account is denied only when
 * every acquired bucket is, and allowed when any is. Overage holds where every bucket that states one agrees.
 */
function copilotPoolEvidence(
	entries: ReadonlyArray<CopilotQuotaEntry>,
): Pick<UsageSnapshot, "access" | "overage" | "resetsAt"> {
	const judged = entries.filter(acquired).map((entry) => ({ entry, ...copilotEntryAccess(entry) }));
	const overages = [...new Set(judged.map((bucket) => bucket.overage).filter((stated) => stated !== "unknown"))];
	const overage: QuotaOverage = overages.length === 1 ? (overages[0] ?? "unknown") : "unknown";
	if (judged.length > 0 && judged.every((bucket) => bucket.access === "denied")) {
		const resets = judged.flatMap((bucket) => (bucket.entry.resetsAt ? [bucket.entry.resetsAt] : [])).sort();
		return { access: "denied", overage, ...(resets.length > 0 ? { resetsAt: resets[resets.length - 1] ?? null } : {}) };
	}
	return { access: judged.some((bucket) => bucket.access === "allowed") ? "allowed" : "unknown", overage };
}

/** The pool of the GitHub account a reading belongs to: model-independent, and none without a known account. */
function copilotPool(accountScope: string | null | undefined): Pick<UsageSnapshot, "accountPseudonym"> {
	const pool = accountPseudonym("github-copilot", accountScope);
	return pool === undefined ? {} : { accountPseudonym: pool };
}

function isAuthoritativeEntry(entry: CopilotQuotaEntry): boolean {
	return entry.quantityKind === "authoritative_budget" && entry.observationKind !== "admission_state";
}

function qualificationLabel(entry: CopilotQuotaEntry): string {
	if (isAuthoritativeEntry(entry)) return "authoritative";
	if (entry.observationKind === "admission_state") {
		return entry.quantityKind === "advisory_balance" ? "advisory, admission state" : "admission state";
	}
	if (entry.quantityKind === "advisory_balance") return "advisory";
	if (entry.quantityKind === "none") return "no numeric balance";
	return "unqualified";
}

function formatBucketSegment(
	entry: CopilotQuotaEntry,
	label: string,
	unit: string | null,
	entitlement: number | null,
	used: number | null,
	remaining: number | null,
	overage: number | null,
): string {
	const unitSuffix = unit ? ` ${unit}` : "";
	let core: string;
	if (entry.unlimited) {
		core = used !== null && used > 0 ? `unlimited (${formatQuantity(used)}${unitSuffix} used)` : "unlimited";
	} else if (entitlement !== null && used !== null) {
		const remPart = remaining !== null ? `, ${formatQuantity(remaining)} remaining` : "";
		core = `${formatQuantity(used)}/${formatQuantity(entitlement)}${unitSuffix} used${remPart}`;
	} else if (entitlement !== null || used !== null || remaining !== null) {
		const parts: string[] = [];
		if (used !== null) parts.push(`${formatQuantity(used)}${unitSuffix} used`);
		if (entitlement !== null) parts.push(`${formatQuantity(entitlement)}${unitSuffix} entitlement`);
		if (remaining !== null) parts.push(`${formatQuantity(remaining)}${unitSuffix} remaining`);
		core = parts.join(", ");
	} else if (!acquired(entry)) {
		core = "not acquired";
	} else if (entry.exhausted) {
		core = "exhausted";
	} else {
		core = "balance unknown";
	}

	const overagePart = overage !== null && overage > 0 ? `, +${formatQuantity(overage)} overage` : "";
	const details: string[] = [qualificationLabel(entry)];
	if (entry.exhausted && core !== "exhausted") details.push("exhausted");
	if (entry.resetsAt !== null) details.push(`resets ${entry.resetsAt}`);
	return `${label}: ${core}${overagePart} (${details.join(", ")})`;
}

function unitSortKey(unit: CopilotQuotaEntry["unit"]): number {
	switch (unit) {
		case "ai_credits":
		case "nano_aiu":
			return 0;
		case "requests":
			return 1;
		case "tokens":
			return 2;
		default:
			return 3;
	}
}

function unitDisambiguator(unit: CopilotQuotaEntry["unit"]): { key: string; label: string; short: string } {
	switch (unit) {
		case "ai_credits":
		case "nano_aiu":
			return { key: "credits", label: "AI credits", short: "cr" };
		case "requests":
			return { key: "requests", label: "requests", short: "req" };
		case "tokens":
			return { key: "tokens", label: "tokens", short: "tok" };
		default:
			return { key: "unknown", label: "unknown", short: "unk" };
	}
}

/**
 * Pure mapper from parsed Copilot quota entries into existing `UsageSnapshot` fields.
 */
export function mapCopilotQuotaEntries(entries: ReadonlyArray<CopilotQuotaEntry>): MappedCopilotQuota {
	if (entries.length === 0) {
		return {
			windows: [],
			allowances: [],
			credits: null,
			message: "GitHub Copilot reported no quota buckets (quota unknown)",
		};
	}

	const sorted = [...entries].sort((a, b) => {
		const orderDiff = bucketSortKey(a.key) - bucketSortKey(b.key);
		if (orderDiff !== 0) return orderDiff;
		const keyDiff = a.key.localeCompare(b.key);
		return keyDiff !== 0 ? keyDiff : unitSortKey(a.unit) - unitSortKey(b.unit);
	});

	const keyCounts = new Map<string, number>();
	for (const entry of sorted) keyCounts.set(entry.key, (keyCounts.get(entry.key) ?? 0) + 1);

	const windows: UsageWindow[] = [];
	const allowances: UsageAllowance[] = [];
	const segments: string[] = [];

	for (const entry of sorted) {
		const baseLabel = bucketLabel(entry.key);
		const sharedKey = (keyCounts.get(entry.key) ?? 0) > 1;
		const suffix = sharedKey ? unitDisambiguator(entry.unit) : null;
		const windowKey = suffix ? `${entry.key}:${suffix.key}` : entry.key;
		const label = suffix ? `${baseLabel.label} (${suffix.label})` : baseLabel.label;
		const short = suffix ? `${baseLabel.short}-${suffix.short}` : baseLabel.short;
		const unit = unitLabel(entry);
		const authoritative = isAuthoritativeEntry(entry);
		const entitlement = entry.unlimited ? null : scaleNativeQuantity(entry.entitlement, entry.unit);
		const used = scaleNativeQuantity(entry.used, entry.unit);
		const explicitRemaining = scaleNativeQuantity(entry.remaining, entry.unit);
		const remaining =
			explicitRemaining !== null
				? explicitRemaining
				: authoritative && !entry.unlimited && entitlement !== null && used !== null
					? Math.max(0, entitlement - used)
					: null;
		const overage = scaleNativeQuantity(entry.overage, entry.unit);

		const qualification = qualificationOf(entry);
		const evidence = {
			key: windowKey,
			label,
			short,
			resetsAt: entry.resetsAt,
			unit: nativeUnit(entry),
			...(entry.periodSeconds === null ? {} : { durationSeconds: entry.periodSeconds }),
			access: copilotEntryAccess(entry).access,
			...(qualification === undefined ? {} : { qualification }),
		};
		const numerator =
			authoritative && !entry.unlimited && entitlement !== null && entitlement > 0
				? used !== null
					? used
					: explicitRemaining !== null && explicitRemaining <= entitlement
						? entitlement - explicitRemaining
						: null
				: null;
		if (numerator !== null && entitlement !== null) {
			windows.push({
				...evidence,
				usedPct: roundPct(numerator, entitlement),
				...(entry.exhausted ? { severity: "critical" } : {}),
			});
		} else if (acquired(entry)) {
			allowances.push({ ...evidence, ...(entry.unlimited ? { unlimited: true as const } : {}) });
		}

		segments.push(formatBucketSegment(entry, label, unit, entitlement, used, remaining, overage));
	}

	const singleWindow = windows.length === 1 ? windows[0] : undefined;
	return {
		windows,
		allowances,
		credits: {
			display: segments.join(" · "),
			usedPct: singleWindow ? singleWindow.usedPct : null,
		},
		message: null,
	};
}

function copilotDiscoveryAllowed(): boolean {
	if (explicitAgentHome("COPILOT_HOME")) return true;
	return !isClioHomeRelocated() && !interopDisabled();
}

function hasConfiguredCopilotTarget(): boolean {
	try {
		return readSettings().targets.some((target) => target.runtime === "copilot-sdk");
	} catch {
		return false;
	}
}

function statStamp(path: string): string | null {
	try {
		const info = statSync(path);
		return `${info.ino}:${info.size}:${Math.trunc(info.mtimeMs)}`;
	} catch {
		return null;
	}
}

interface CopilotLocalSignal {
	stamp: string;
	mayBeSignedIn: boolean;
}

/**
 * Local non-secret signal for detection and shared-state cache scope: stats only config metadata
 * (never reads file bytes or credentials) and never spawns the Copilot CLI daemon.
 */
function copilotLocalSignal(): CopilotLocalSignal {
	const copilotHome = explicitAgentHome("COPILOT_HOME") ?? join(homedir(), ".copilot");
	const ghConfigDir =
		process.env.GH_CONFIG_DIR?.trim() || join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "gh");
	const markers = [
		join(copilotHome, "config.json"),
		join(copilotHome, "hosts.json"),
		join(copilotHome, "apps.json"),
		join(ghConfigDir, "hosts.yml"),
	];
	const stamps = markers.map((marker) => `${marker}=${statStamp(marker) ?? "missing"}`);
	const hasMarker = stamps.some((entry) => !entry.endsWith("=missing"));
	const keychain = copilotKeychainAllowed();
	return {
		stamp: [`home=${copilotHome}`, `gh=${ghConfigDir}`, `keychain=${keychain ? "1" : "0"}`, ...stamps].join("\n"),
		mayBeSignedIn: hasMarker || keychain,
	};
}

export function createCopilotQuotaProvider(options: CopilotQuotaOptions = {}): QuotaProvider {
	const now = options.now ?? (() => new Date());
	const readOptions: CopilotQuotaReadOptions = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};
	const hasTarget =
		options.hasConfiguredTarget ??
		(options.readQuota !== undefined || options.readAccount !== undefined ? () => true : hasConfiguredCopilotTarget);
	const readQuota =
		options.readQuota ??
		(async (opts?: CopilotQuotaReadOptions): Promise<CopilotQuotaReadResult> => {
			if (!copilotDiscoveryAllowed()) {
				return {
					kind: "no_credentials",
					message: "GitHub Copilot quota discovery is disabled in an isolated CLIO_CODER_HOME",
				};
			}
			return readCopilotSdkQuota(opts);
		});
	let lastNoCredentialsStamp: string | null = null;

	const snapshot = (
		status: UsageSnapshot["status"],
		message: string | null,
		extra: Partial<UsageSnapshot> = {},
	): UsageSnapshot => ({
		providerId: COPILOT_QUOTA_PROVIDER_ID,
		displayName: "GitHub Copilot",
		status,
		plan: null,
		windows: [],
		credits: null,
		fetchedAt: now().toISOString(),
		...(message ? { message } : {}),
		...extra,
	});

	return {
		id: COPILOT_QUOTA_PROVIDER_ID,
		displayName: "GitHub Copilot",
		async detect(): Promise<boolean> {
			if (!hasTarget()) return false;
			if (options.readAccount) return (await options.readAccount(readOptions)) !== null;
			if (!copilotDiscoveryAllowed()) return false;
			const signal = copilotLocalSignal();
			if (lastNoCredentialsStamp === signal.stamp) return false;
			if (signal.mayBeSignedIn) return true;
			return (await copilotSdkSignedInAccount(readOptions)) !== null;
		},
		async credentialScope(): Promise<string | null> {
			if (!hasTarget()) return null;
			if (options.readAccount) {
				const account = await options.readAccount(readOptions);
				if (!account) return null;
				return credentialFingerprint(COPILOT_QUOTA_PROVIDER_ID, `${account.host}\0${account.login}`);
			}
			if (!copilotDiscoveryAllowed()) return null;
			const signal = copilotLocalSignal();
			if (signal.mayBeSignedIn) return credentialFingerprint(COPILOT_QUOTA_PROVIDER_ID, signal.stamp);
			const held = await copilotSdkSignedInAccount(readOptions);
			if (!held) return null;
			return credentialFingerprint(COPILOT_QUOTA_PROVIDER_ID, `${held.host}\0${held.login}`);
		},
		async fetch(): Promise<UsageSnapshot> {
			if (!hasTarget()) return snapshot("no_credentials", "No GitHub Copilot target is configured");
			const signal = options.readAccount ? null : copilotLocalSignal();
			if (!options.readQuota) {
				if (!copilotDiscoveryAllowed()) {
					return snapshot("no_credentials", "GitHub Copilot quota discovery is disabled in an isolated CLIO_CODER_HOME");
				}
				if (signal && !signal.mayBeSignedIn && (await copilotSdkSignedInAccount(readOptions)) === null) {
					lastNoCredentialsStamp = signal.stamp;
					return snapshot("no_credentials", "GitHub Copilot is not signed in");
				}
			}
			const result = await readQuota(readOptions);
			if (result.kind === "no_credentials") {
				if (signal) lastNoCredentialsStamp = signal.stamp;
				return snapshot("no_credentials", result.message);
			}
			lastNoCredentialsStamp = null;
			if (result.kind === "unsupported") return snapshot("error", result.message);
			if (result.kind === "error") return snapshot("error", result.message);
			const mapped = mapCopilotQuotaEntries(result.entries);
			// Buckets whose acquisition failed are no observation: no verdict, and no freshness.
			const observed = result.entries.length === 0 || result.entries.some(acquired);
			return snapshot(
				observed ? "ok" : "error",
				observed ? mapped.message : "GitHub Copilot acquired no quota observation (quota unknown)",
				{
					plan: null,
					windows: mapped.windows,
					allowances: mapped.allowances,
					credits: mapped.credits,
					...copilotPoolEvidence(result.entries),
					...copilotPool(result.accountScope),
				},
			);
		},
	};
}
