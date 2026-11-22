/**
 * Comparable quota evidence (token economy S5b): which funding pool a reading belongs to, whether the provider says
 * that pool may send, and the binding denial a dispatch admission reads.
 *
 * A pool is keyed by a local pseudonym of the provider's stable billing identity: an HMAC under a random key this
 * install generates once, so the journal never holds an account id and two installs never share a pool key. An
 * adapter without a verified billing identity reports no pool, and readings without one are never pooled together.
 *
 * Deny status comes only from what a provider says. `denied` needs the provider's own reached-limit or rejected
 * signal with no usable credits or overage; a window measured full is not a denial by itself.
 */

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStatePath } from "../../core/xdg.js";
import type { QuotaReading } from "./reading.js";
import type { QuotaAccess, QuotaOverage, UsageSnapshot, UsageWindow } from "./types.js";

/** The billing namespaces a pseudonym is keyed under; adapters that spend one account share one namespace. */
export type BillingNamespace = "chatgpt" | "anthropic" | "antigravity" | "github-copilot";

const KEY_FILE = "quota-pool.key";
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const KEY_LOCK_TIMEOUT_MS = 2_000;
const keys = new Map<string, Buffer>();

function readKey(path: string): Buffer | null {
	try {
		const text = readFileSync(path, "utf8").trim();
		return KEY_PATTERN.test(text) ? Buffer.from(text, "hex") : null;
	} catch {
		return null;
	}
}

/**
 * This install's pool key, created on first use under the state file lock and published by atomic rename, so every
 * process reads the one key the first creator wrote. Null when the state root cannot hold one; a failure is not cached,
 * so a later reading retries.
 */
function installKey(): Buffer | null {
	const path = join(clioStatePath(), KEY_FILE);
	const cached = keys.get(path);
	if (cached !== undefined) return cached;
	let key = readKey(path);
	if (key === null) {
		try {
			key = withStateFileLockSync(
				path,
				() => {
					const existing = readKey(path);
					if (existing !== null) return existing;
					const created = randomBytes(32);
					safeResourceWrite(path, `${created.toString("hex")}\n`, { mode: 0o600 });
					return created;
				},
				{ timeoutMs: KEY_LOCK_TIMEOUT_MS },
			);
		} catch {
			key = null;
		}
	}
	if (key !== null) keys.set(path, key);
	return key;
}

/**
 * The pool pseudonym of one stable billing identity, or undefined without an identity or an install key. The identity
 * is the provider's account or billing entity (a ChatGPT account, an Anthropic organization, a Cloud Code project, a
 * GitHub account),
 * never a credential: a rotating token would split one pool into many.
 */
export function accountPseudonym(namespace: BillingNamespace, identity: string | null | undefined): string | undefined {
	if (!identity) return undefined;
	const key = installKey();
	if (key === null) return undefined;
	return createHmac("sha256", key).update(`quota-pool\0${namespace}\0${identity}`).digest("hex").slice(0, 32);
}

/** Codex's limit and credit signals, from the usage poll's `rate_limit`/`credits` or the stream's `codex.rate_limits`. */
export interface CodexLimitSignal {
	allowed: boolean | null;
	limitReached: boolean | null;
	credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
}

/**
 * Codex pool access: denied only when the provider reports the limit reached or the request not allowed and no
 * credits can pay past it. Usable credits are the overage Codex states.
 */
export function codexAccess(signal: CodexLimitSignal): { access: QuotaAccess; overage: QuotaOverage } {
	const credits = signal.credits;
	const balance = credits?.balance === null || credits?.balance === undefined ? null : Number(credits.balance);
	const usable: boolean | null =
		credits === null
			? false
			: credits.unlimited === true || (balance !== null && Number.isFinite(balance) && balance > 0)
				? true
				: credits.hasCredits === false || balance === 0
					? false
					: null;
	const overage: QuotaOverage =
		credits === null ? "unknown" : usable === true ? "permitted" : usable === false ? "refused" : "unknown";
	const limited = signal.limitReached === true || signal.allowed === false;
	const access: QuotaAccess = limited
		? usable === true
			? "allowed"
			: usable === false
				? "denied"
				: "unknown"
		: signal.limitReached === false || signal.allowed === true
			? "allowed"
			: "unknown";
	return { access, overage };
}

const UNITS = { m: 60, h: 3_600, d: 86_400 } as const;

/** Seconds a provider's own window name states: "5h", "7d", "30m" or "weekly". Anything else states none. */
export function namedWindowSeconds(name: string): number | undefined {
	if (name.toLowerCase() === "weekly") return 7 * 86_400;
	const match = /^(\d{1,6})([mhd])$/.exec(name);
	if (!match) return undefined;
	const seconds = Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
	return seconds > 0 ? seconds : undefined;
}

function resetOf(value: string | undefined): string | null {
	if (value === undefined || value.trim() === "") return null;
	const at = new Date(Number(value) * 1000);
	return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

function anthropicStatus(value: string | undefined): QuotaAccess {
	return value === "rejected" ? "denied" : value === "allowed" || value === "allowed_warning" ? "allowed" : "unknown";
}

/**
 * Anthropic's unified rate-limit headers as pool evidence: each family's status, the window its name states, the pool
 * status and reset, and the overage status. A family rejected while overage is refused denies the pool even when the
 * overall status is missing or the family reports no utilization, and its reset then stands for the pool's; the overall
 * status, when present, already weighs overage.
 */
export function withAnthropicEvidence(snapshot: UsageSnapshot, accountScope: string | null): UsageSnapshot {
	const headers = snapshot.rateLimit ?? {};
	const family = (key: string): string => (key === "session" ? "5h" : key === "weekly" ? "7d" : key);
	const overageStatus = anthropicStatus(headers["overage-status"]);
	const overage: QuotaOverage =
		overageStatus === "allowed" ? "permitted" : overageStatus === "denied" ? "refused" : "unknown";
	const windows: UsageWindow[] = snapshot.windows.map((window) => {
		const name = family(window.key);
		const seconds = namedWindowSeconds(name);
		const status = headers[`${name}-status`];
		return {
			...window,
			unit: "percent",
			...(seconds === undefined ? {} : { durationSeconds: seconds }),
			...(status === undefined ? {} : { access: anthropicStatus(status) }),
		};
	});
	// Every family the headers name, measured or not: a rejection binds even without a utilization to show.
	const rejected = Object.keys(headers)
		.flatMap((key) => /^(.+)-status$/.exec(key)?.[1] ?? [])
		.filter((name) => name !== "overage" && anthropicStatus(headers[`${name}-status`]) === "denied");
	const overall = anthropicStatus(headers.status);
	const access: QuotaAccess =
		overall !== "unknown" ? overall : overage === "refused" && rejected.length > 0 ? "denied" : "unknown";
	const familyResets = rejected.flatMap((name) => resetOf(headers[`${name}-reset`]) ?? []).sort();
	const resetsAt = resetOf(headers.reset) ?? (access === "denied" ? (familyResets.at(-1) ?? null) : null);
	const pool = accountPseudonym("anthropic", accountScope);
	return {
		...snapshot,
		windows,
		access,
		overage,
		resetsAt,
		...(pool === undefined ? {} : { accountPseudonym: pool }),
	};
}

/** The binding denial of one reading: the window that holds it, when the reading names one, and when it lifts. */
export interface QuotaDenial {
	provider: string;
	targetId: string;
	/** The pool the denial belongs to; null when the reading had no verified billing identity. */
	pool: string | null;
	/** The window that binds; null when the provider denied without naming or measuring one. */
	window: { key: string; label: string | null; durationSeconds: number | null; resetsAt: string | null } | null;
	/** When the denial lifts: the binding window's reset, else the pool's, else unknown. */
	resetsAt: string | null;
	observedAt: string;
	validUntil: string | null;
	/** True while the reading is inside its freshness window and was not served stale. */
	fresh: boolean;
}

/**
 * The provider denial a reading carries, or null when the provider did not deny. The binding window is the one the
 * provider itself denied, else a window it measured full, choosing the latest known reset; a denial with neither
 * still stands, with no window. Freshness is reported, not judged: an admission refuses only on a fresh denial.
 */
export function quotaDenial(reading: QuotaReading, nowMs = Date.now()): QuotaDenial | null {
	if (reading.access !== "denied") return null;
	const denied = reading.windows.filter((window) => window.access === "denied");
	const candidates =
		denied.length > 0
			? denied
			: reading.windows.filter((window) => window.usedPct.kind === "measured" && window.usedPct.value >= 100);
	const binding = [...candidates].sort(
		(left, right) =>
			(right.resetsAt ? Date.parse(right.resetsAt) : Number.NEGATIVE_INFINITY) -
			(left.resetsAt ? Date.parse(left.resetsAt) : Number.NEGATIVE_INFINITY),
	)[0];
	const validUntil = reading.validUntil ?? null;
	return {
		provider: reading.provider,
		targetId: reading.targetId,
		pool: reading.accountPseudonym ?? null,
		window: binding
			? {
					key: binding.key,
					label: binding.label ?? null,
					durationSeconds: binding.durationSeconds ?? null,
					resetsAt: binding.resetsAt ?? null,
				}
			: null,
		resetsAt: binding?.resetsAt ?? reading.resetsAt ?? null,
		observedAt: reading.observedAt,
		validUntil,
		fresh: validUntil !== null && Date.parse(validUntil) > nowMs && reading.stale !== true,
	};
}
