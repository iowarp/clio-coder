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
 */

import { explicitAgentHome, interopDisabled, isClioHomeRelocated } from "../../core/xdg.js";
import {
	type CopilotQuotaAccount,
	type CopilotQuotaEntry,
	type CopilotQuotaReadOptions,
	type CopilotQuotaReadResult,
	copilotSdkSignedInAccount,
	readCopilotSdkQuota,
} from "../../engine/ai.js";
import {
	credentialFingerprint,
	type QuotaProvider,
	type UsageCredits,
	type UsageSnapshot,
	type UsageWindow,
} from "./types.js";

export const COPILOT_QUOTA_PROVIDER_ID = "copilot";
export const NANO_AIU_PER_AI_CREDIT = 1_000_000_000;

export interface CopilotQuotaOptions {
	readQuota?: (options?: CopilotQuotaReadOptions) => Promise<CopilotQuotaReadResult>;
	readAccount?: (options?: CopilotQuotaReadOptions) => Promise<CopilotQuotaAccount | null>;
	timeoutMs?: number;
	now?: () => Date;
}

export interface MappedCopilotQuota {
	windows: UsageWindow[];
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

/**
 * Pure mapper from parsed Copilot quota entries into existing `UsageSnapshot` fields.
 */
export function mapCopilotQuotaEntries(entries: ReadonlyArray<CopilotQuotaEntry>): MappedCopilotQuota {
	if (entries.length === 0) {
		return {
			windows: [],
			credits: null,
			message: "GitHub Copilot reported no quota buckets (quota unknown)",
		};
	}

	const sorted = [...entries].sort((a, b) => {
		const orderDiff = bucketSortKey(a.key) - bucketSortKey(b.key);
		return orderDiff !== 0 ? orderDiff : a.key.localeCompare(b.key);
	});

	const windows: UsageWindow[] = [];
	const segments: string[] = [];

	for (const entry of sorted) {
		const { label, short } = bucketLabel(entry.key);
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

		if (authoritative && !entry.unlimited && entitlement !== null && entitlement > 0) {
			const numerator =
				used !== null
					? used
					: explicitRemaining !== null && explicitRemaining <= entitlement
						? entitlement - explicitRemaining
						: null;
			if (numerator !== null) {
				windows.push({
					key: entry.key,
					label,
					short,
					usedPct: roundPct(numerator, entitlement),
					resetsAt: entry.resetsAt,
					...(entry.exhausted ? { severity: "critical" } : {}),
				});
			}
		}

		segments.push(formatBucketSegment(entry, label, unit, entitlement, used, remaining, overage));
	}

	const singleWindow = windows.length === 1 ? windows[0] : undefined;
	return {
		windows,
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

export function createCopilotQuotaProvider(options: CopilotQuotaOptions = {}): QuotaProvider {
	const now = options.now ?? (() => new Date());
	const readOptions: CopilotQuotaReadOptions = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};
	const readAccount =
		options.readAccount ??
		(async (opts?: CopilotQuotaReadOptions) => {
			if (!copilotDiscoveryAllowed()) return null;
			return copilotSdkSignedInAccount(opts);
		});
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
			return (await readAccount(readOptions)) !== null;
		},
		async credentialScope(): Promise<string | null> {
			const account = await readAccount(readOptions);
			if (!account) return null;
			return credentialFingerprint(COPILOT_QUOTA_PROVIDER_ID, `${account.host}\0${account.login}`);
		},
		async fetch(): Promise<UsageSnapshot> {
			const result = await readQuota(readOptions);
			if (result.kind === "no_credentials") return snapshot("no_credentials", result.message);
			if (result.kind === "unsupported") return snapshot("error", result.message);
			if (result.kind === "error") return snapshot("error", result.message);
			const mapped = mapCopilotQuotaEntries(result.entries);
			return snapshot("ok", mapped.message, {
				plan: null,
				windows: mapped.windows,
				credits: mapped.credits,
			});
		},
	};
}
