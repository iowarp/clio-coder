/**
 * One capacity-aware model-residency reconciler, shared by every local runtime
 * that pins weights in VRAM. Both the interactive chat loop and the headless
 * worker drive the provider stream path, so calling the reconciler at the top
 * of each manageable runtime's stream gives exactly one place that decides
 * load and evict for both paths.
 *
 * Co-residency is the default. Local servers are multi-model hosts with finite
 * VRAM, not single-model slots: when the runtime advertises capacity (the
 * llama.cpp router's `max_instances`) and a slot is free, Clio loads without
 * evicting anything; when the runtime loads just-in-time and fails an
 * oversized load cleanly (LM Studio), Clio attempts the co-resident load first
 * and swaps only after that failure; when the server schedules fits itself
 * (Ollama), Clio releases only its own unprotected stragglers. Eviction is the
 * exception, taken only when a slot must be freed, and it never selects a
 * protected resident while an unprotected one is available.
 *
 * Protection is symmetric and role-aware. Residents tagged `pinned:true` or
 * `role:scout` by the server operator are never evicted. Residents referenced
 * by the operator's own Clio configuration (see
 * {@link setProtectedModelsProvider}) carry the role they serve (chat, memory,
 * worker, target default) and are never evicted by another Clio stream while an
 * unprotected candidate exists, and only with a loud warning naming the role
 * when capacity is exhausted. No Clio profile silently evicts another profile's
 * model, and no chat switch silently unloads the memory plane.
 *
 * The reconciler is best-effort and non-blocking. A slow or unreachable
 * server, or a malformed resident listing, degrades to observe-only and never
 * crashes a turn. `CLIO_CODER_RESIDENCY=observe` and an explicit target
 * `lifecycle: user-managed` both force observe-only on every runtime path.
 * Every collision or stress case emits a notice over the event bus instead of
 * a thrown error. One reconcile decision holds per (target, model) within a
 * TTL, and mutations for a target are serialized across processes through a
 * state-dir lock file so a worker and the orchestrator cannot interleave
 * unload/load against the same server.
 */

import { BusChannels, type RuntimeNoticeKind, type RuntimeNoticePayload } from "../../core/bus-events.js";
import type { ProtectedModelRef, ResidencyRole } from "../../core/residency-protection.js";
import { getSharedBus } from "../../core/shared-bus.js";
import { withResidencyLock } from "./residency-lock.js";
import { type ResidentModelInfo, residentMatchesKeep } from "./resident-models.js";

export type ResidencyNotice = RuntimeNoticePayload;
export type { RuntimeNoticeKind };

// --- notice sink -----------------------------------------------------------

export type ResidencyNoticeSink = (notice: ResidencyNotice) => void;

function busNoticeSink(notice: ResidencyNotice): void {
	getSharedBus().emit(BusChannels.RuntimeNotice, notice);
}

let noticeSink: ResidencyNoticeSink = busNoticeSink;

/**
 * Override where residency notices go. The main process keeps the default,
 * which emits on the shared bus that the interactive layer renders. The worker
 * subprocess installs a stderr sink so headless runs still surface the reason.
 * Passing null restores the bus sink.
 */
export function setResidencyNoticeSink(sink: ResidencyNoticeSink | null): void {
	noticeSink = sink ?? busNoticeSink;
}

/** Emit one notice through the active sink. Never throws into a turn. */
export function emitResidencyNotice(notice: ResidencyNotice): void {
	try {
		noticeSink(notice);
	} catch {
		// A notice is informational; a sink failure must never escape into a turn.
	}
}

// --- configured-model protection ---------------------------------------------

// Wire model ids the operator's own configuration references, with the role
// each one serves (chat, memory, worker, target default). The provider is
// installed by the composition root: the orchestrator entry derives it from the
// live effective settings, and the worker entry from the protectedModels list
// carried on its WorkerSpec, so every process protects the same set. A bare
// string is accepted for an id whose role the caller does not know.
export type ProtectedModelEntry = string | ProtectedModelRef;

let protectedModelsProvider: (() => ReadonlyArray<ProtectedModelEntry>) | null = null;

export function setProtectedModelsProvider(provider: (() => ReadonlyArray<ProtectedModelEntry>) | null): void {
	protectedModelsProvider = provider;
}

/** Configured model ids mapped to the role that references them, when known. */
function configProtectedRoles(): ReadonlyMap<string, ResidencyRole | undefined> {
	const roles = new Map<string, ResidencyRole | undefined>();
	try {
		for (const entry of protectedModelsProvider?.() ?? []) {
			const modelId = (typeof entry === "string" ? entry : entry.modelId).trim();
			if (modelId.length === 0) continue;
			const role = typeof entry === "string" ? undefined : entry.role;
			if (!roles.has(modelId) || roles.get(modelId) === undefined) roles.set(modelId, role);
		}
	} catch {
		return new Map();
	}
	return roles;
}

/** True when the runtime tagged this resident as operator-pinned (llama.cpp router tags). */
export function residentTagProtected(tags: ReadonlyArray<string> | undefined): boolean {
	if (!tags) return false;
	return tags.includes("pinned:true") || tags.includes("role:scout");
}

// --- Clio-loaded registry --------------------------------------------------

// Models Clio itself loaded, keyed by a stable per-server target key. The
// registry is per-process; a resident model absent from it may still be
// another Clio process's model, which is why eviction relies on the symmetric
// protection above rather than on attribution alone.
const clioLoaded = new Map<string, Set<string>>();

/** Record that Clio loaded `modelId` on the target identified by `targetKey`. */
export function markClioLoaded(targetKey: string, modelId: string): void {
	let set = clioLoaded.get(targetKey);
	if (!set) {
		set = new Set();
		clioLoaded.set(targetKey, set);
	}
	set.add(modelId);
}

function forgetClioLoaded(targetKey: string, modelId: string): void {
	clioLoaded.get(targetKey)?.delete(modelId);
}

function isClioLoaded(targetKey: string, entry: ResidentModelInfo): boolean {
	const set = clioLoaded.get(targetKey);
	if (!set) return false;
	if (set.has(entry.modelId)) return true;
	return (entry.aliasIds ?? []).some((id) => set.has(id));
}

// --- TTL fast path ---------------------------------------------------------

/** Skip the listResident round-trip for this long after a clean reconcile. */
export const RECONCILE_TTL_MS = 60_000;
const reconcileCache = new Map<string, { modelId: string; decision: "reconcile" | "observe"; at: number }>();

/** Test-only: clear the cross-call Clio-loaded registry and TTL cache. */
export function resetResidencyState(): void {
	clioLoaded.clear();
	reconcileCache.clear();
}

// --- residency decision (pure) ----------------------------------------------

/**
 * How the runtime makes a requested model resident, which decides when an
 * eviction is even on the table:
 *   - "router": Clio must POST an explicit load (llama.cpp router) and the
 *     server advertises a slot capacity. A free slot loads without eviction;
 *     a full server frees exactly the slots needed; unknown capacity falls
 *     back to a conservative swap of unprotected residents.
 *   - "jit": the runtime loads on open and fails an oversized load cleanly
 *     (LM Studio with gpuStrictVramCap). Nothing is evicted up front; the
 *     plan carries ranked `fallbackEvict` candidates for a retry after a
 *     will-not-fit failure.
 *   - "scheduler": the server places and fits models itself (Ollama). Only
 *     Clio's own unprotected stragglers are released, because Clio pins them
 *     with keep_alive -1 and nothing else ever reclaims them.
 */
export type ResidencyStrategy = "router" | "jit" | "scheduler";

/** Why a resident model may not be evicted, when it may not. */
export type ResidencyProtection = "tag" | "config";

export interface ResidentClassified extends ResidentModelInfo {
	/** True when this process's Clio-loaded registry attributes the model to Clio. */
	loadedByClio: boolean;
	/** Set when the resident is protected from eviction (server tag or operator config). */
	protection?: ResidencyProtection;
	/** Which configured plane references this resident, when the protection came from config. */
	role?: ResidencyRole;
}

export interface ResidencyFacts {
	targetId: string;
	runtimeId: string;
	keepModelId: string;
	resident: ReadonlyArray<ResidentClassified>;
	/** False when the env or explicit target lifecycle opt-out asks Clio to only observe. */
	managed: boolean;
	strategy: ResidencyStrategy;
	/** Max co-resident models when the runtime advertises it (llama.cpp router max_instances). */
	capacity?: number;
	/**
	 * True when the runtime tags the keep model itself as operator-pinned, so it
	 * will be excluded from every eviction tier once it is resident. Such a model
	 * may only take an unprotected slot: evicting a config-protected resident for
	 * it would be a one-way swap the configured role could never undo (#72).
	 */
	keepTagProtected?: boolean;
	contextLength?: number;
	modelMaxContext?: number;
}

export type ResidencyDecision = "reconcile" | "observe" | "decline";

export interface ResidencyPlan {
	decision: ResidencyDecision;
	/** Residents the plan releases before making the keep model resident. */
	evict: ResidentModelInfo[];
	/** Ranked swap candidates for after a failed co-resident JIT load ("jit" strategy only). */
	fallbackEvict: ResidentModelInfo[];
	/** True when the keep model is already resident on the target. */
	keepResident: boolean;
	notices: ResidencyNotice[];
}

function gib(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function makeNotice(
	facts: ResidencyFacts,
	kind: RuntimeNoticeKind,
	level: ResidencyNotice["level"],
	message: string,
	detail?: ResidencyNotice["detail"],
): ResidencyNotice {
	const notice: ResidencyNotice = {
		kind,
		level,
		targetId: facts.targetId,
		runtimeId: facts.runtimeId,
		model: facts.keepModelId,
		message,
	};
	if (detail) notice.detail = detail;
	return notice;
}

function clioLoadedFirst(entries: ReadonlyArray<ResidentClassified>): ResidentClassified[] {
	return [...entries.filter((entry) => entry.loadedByClio), ...entries.filter((entry) => !entry.loadedByClio)];
}

/** `the memory model` / `the chat model` for a notice, or the bare id's article. */
function describeRole(role: ResidencyRole | undefined): string {
	if (role === "chat") return "the chat model";
	if (role === "memory") return "the memory model";
	if (role === "worker") return "a worker model";
	if (role === "target-default") return "a target default model";
	return "a configured model";
}

function evictionNotice(facts: ResidencyFacts, entry: ResidentClassified): ResidencyNotice {
	if (entry.protection === "config") {
		return makeNotice(
			facts,
			"swap",
			"warning",
			`evicting '${entry.modelId}' from '${facts.targetId}' to make room for '${facts.keepModelId}' even though settings still reference it as ${describeRole(entry.role)}: every slot is taken and no unprotected resident is left. Another profile pointed at it will reload it.`,
			{ swappedOut: entry.modelId, configProtected: true, ...(entry.role ? { role: entry.role } : {}) },
		);
	}
	if (entry.loadedByClio) {
		return makeNotice(
			facts,
			"about-to-evict",
			"info",
			`evicting Clio-loaded model '${entry.modelId}' from '${facts.targetId}' to free a slot for '${facts.keepModelId}'.`,
			entry.sizeVramBytes !== undefined ? { freedVramBytes: entry.sizeVramBytes } : undefined,
		);
	}
	return makeNotice(
		facts,
		"swap",
		"warning",
		`swapping resident '${entry.modelId}' for requested '${facts.keepModelId}' on '${facts.targetId}' (Clio did not load it; recorded transition instead of a silent unload; set CLIO_CODER_RESIDENCY=observe or lifecycle: user-managed to forbid swaps).`,
		{
			...(entry.sizeVramBytes !== undefined ? { freedVramBytes: entry.sizeVramBytes } : {}),
			swappedOut: entry.modelId,
		},
	);
}

/**
 * Decide what to do with the target's resident set, purely from already
 * gathered facts. The async {@link reconcileResidency} wraps this with the
 * round-trips; keeping the decision pure makes the capacity math, protection
 * tiers, eviction order, and every notice case directly testable without a
 * server.
 */
export function decideResidency(facts: ResidencyFacts): ResidencyPlan {
	const notices: ResidencyNotice[] = [];
	const keepResident = facts.resident.some((entry) => residentMatchesKeep(entry, facts.keepModelId));
	const others = facts.resident.filter((entry) => !residentMatchesKeep(entry, facts.keepModelId));

	// Stress: requested context window above the model's advertised maximum.
	if (
		facts.contextLength !== undefined &&
		facts.modelMaxContext !== undefined &&
		facts.modelMaxContext > 0 &&
		facts.contextLength > facts.modelMaxContext
	) {
		notices.push(
			makeNotice(
				facts,
				"stress",
				"warning",
				`context length ${facts.contextLength} exceeds ${facts.keepModelId}'s ${facts.modelMaxContext}-token limit on '${facts.targetId}'; lower the context window to avoid a truncated or split load.`,
				{ requestedContext: facts.contextLength, modelMaxContext: facts.modelMaxContext },
			),
		);
	}

	// Stress: a resident model is partly on CPU (its total weight footprint is
	// larger than its GPU-resident bytes), so the GPU is already oversubscribed.
	for (const entry of facts.resident) {
		if (entry.sizeBytes !== undefined && entry.sizeVramBytes !== undefined && entry.sizeBytes > entry.sizeVramBytes) {
			notices.push(
				makeNotice(
					facts,
					"stress",
					"warning",
					`model '${entry.modelId}' on '${facts.targetId}' is split across CPU and GPU (${gib(entry.sizeVramBytes)} of ${gib(entry.sizeBytes)} on GPU); expect slow generation.`,
					{ residentVramBytes: entry.sizeVramBytes, residentTotalBytes: entry.sizeBytes },
				),
			);
		}
	}

	// Observe-only: an explicit opt-out. Never evict; only report.
	if (!facts.managed) {
		return { decision: "observe", evict: [], fallbackEvict: [], keepResident, notices };
	}

	// The keep model is already served: co-residents stay, whoever loaded them.
	// Report the sharing once per TTL so a genuinely oversubscribed box is
	// never silent, but a fitting co-residency is normal, not a defect.
	if (keepResident) {
		if (others.length > 0) {
			const names = others.map((entry) => (entry.role ? `${entry.modelId} (${entry.role})` : entry.modelId)).join(", ");
			if (facts.capacity !== undefined && facts.resident.length > facts.capacity) {
				notices.push(
					makeNotice(
						facts,
						"stress",
						"warning",
						`'${facts.targetId}' holds ${facts.resident.length} models (${names} alongside '${facts.keepModelId}') above its ${facts.capacity}-instance capacity; unload one or raise the server's limit.`,
						{ residentCount: facts.resident.length, maxInstances: facts.capacity },
					),
				);
			} else {
				notices.push(
					makeNotice(
						facts,
						"co-resident",
						"info",
						`'${facts.targetId}' serves '${facts.keepModelId}' alongside ${names}. Clio leaves co-resident models loaded; keep the setup only while weights and KV caches fit in GPU memory.`,
						facts.capacity !== undefined
							? { residentCount: facts.resident.length, maxInstances: facts.capacity }
							: { residentCount: facts.resident.length },
					),
				);
			}
		}
		return { decision: "reconcile", evict: [], fallbackEvict: [], keepResident, notices };
	}

	// The keep model is not resident. Rank potential evictions by protection
	// tier: unprotected residents first (Clio-attributed before foreign), then
	// config-protected ones as a loud last resort. Tag-pinned residents are
	// never candidates. A keep model that will itself come back tag-pinned may
	// not displace the config tier: once resident it is never a candidate, so
	// the configured role could not reclaim its slot.
	const tierUnprotected = clioLoadedFirst(others.filter((entry) => entry.protection === undefined));
	const tierConfig = clioLoadedFirst(others.filter((entry) => entry.protection === "config"));
	const configEvictable = facts.keepTagProtected !== true;

	let evict: ResidentClassified[] = [];
	let fallbackEvict: ResidentClassified[] = [];

	if (facts.strategy === "jit") {
		// Attempt the co-resident load first; the runtime turns an oversized
		// load into a clean failure, and only that failure justifies a swap.
		fallbackEvict = configEvictable ? [...tierUnprotected, ...tierConfig] : tierUnprotected;
	} else if (facts.strategy === "scheduler") {
		// The server fits and places models itself. Release only Clio's own
		// unprotected stragglers; foreign and protected residents stay.
		evict = tierUnprotected.filter((entry) => entry.loadedByClio);
	} else if (facts.capacity === undefined) {
		// Router without readable capacity: no way to prove a free slot, so
		// fall back to swapping the unprotected residents before the load.
		evict = tierUnprotected;
	} else {
		const slotsNeeded = facts.resident.length + 1 - facts.capacity;
		if (slotsNeeded > 0) {
			const candidates = configEvictable ? [...tierUnprotected, ...tierConfig] : tierUnprotected;
			if (
				candidates.length < slotsNeeded &&
				!configEvictable &&
				tierUnprotected.length + tierConfig.length >= slotsNeeded
			) {
				// The load would only fit by evicting a configured model in favour of
				// a pinned one. Decline up front instead of stranding the config role.
				const blocked = tierConfig.slice(0, slotsNeeded - tierUnprotected.length);
				const names = blocked.map((entry) => `'${entry.modelId}' (${describeRole(entry.role)})`).join(", ");
				notices.push(
					makeNotice(
						facts,
						"will-not-fit",
						"error",
						`cannot load pinned '${facts.keepModelId}' on '${facts.targetId}': it would evict ${names} that settings still reference, and a pinned model is never evicted, so the configured model could not return. Unload one manually, unpin '${facts.keepModelId}' on the server, or raise the server's max instances.`,
						{
							residentCount: facts.resident.length,
							maxInstances: facts.capacity,
							configProtected: true,
							...(blocked[0]?.role ? { role: blocked[0].role } : {}),
						},
					),
				);
				return { decision: "decline", evict: [], fallbackEvict: [], keepResident, notices };
			}
			if (candidates.length < slotsNeeded) {
				notices.push(
					makeNotice(
						facts,
						"will-not-fit",
						"error",
						`cannot load '${facts.keepModelId}' on '${facts.targetId}': all ${facts.capacity} instance slots hold pinned models (${others.map((entry) => entry.modelId).join(", ")}). Unload one manually or raise the server's max instances.`,
						{ residentCount: facts.resident.length, maxInstances: facts.capacity },
					),
				);
				return { decision: "decline", evict: [], fallbackEvict: [], keepResident, notices };
			}
			evict = candidates.slice(0, slotsNeeded);
		} else if (others.length > 0) {
			notices.push(
				makeNotice(
					facts,
					"co-resident",
					"info",
					`loading '${facts.keepModelId}' alongside ${others.map((entry) => entry.modelId).join(", ")} on '${facts.targetId}' (${facts.resident.length + 1}/${facts.capacity} instances).`,
					{ residentCount: facts.resident.length + 1, maxInstances: facts.capacity },
				),
			);
		}
	}

	for (const entry of evict) notices.push(evictionNotice(facts, entry));
	return { decision: "reconcile", evict, fallbackEvict, keepResident, notices };
}

// --- async reconciler ------------------------------------------------------

/**
 * Per-runtime hooks the reconciler drives. Each manageable runtime builds an
 * adapter that closes over its own client (the LM Studio SDK socket, the
 * Ollama HTTP client, the llama.cpp router's HTTP surface) so the reconciler
 * itself stays runtime-agnostic.
 */
export interface ResidencyAdapter {
	/** Stable per-server key for the Clio-loaded registry, TTL cache, and lock file. */
	targetKey: string;
	targetId: string;
	runtimeId: string;
	keepModelId: string;
	/** False when the env or explicit target lifecycle opt-out asks Clio to only observe. */
	managed: boolean;
	strategy: ResidencyStrategy;
	contextLength?: number;
	modelMaxContext?: number;
	listResident(): Promise<ResidentModelInfo[]>;
	/**
	 * Runtime tags of the keep model itself, when the runtime lists them before
	 * the load (the llama.cpp router lists tags for unloaded models too). Called
	 * after {@link listResident}, so an adapter may serve it from that snapshot.
	 */
	keepModelTags?(): Promise<ReadonlyArray<string> | undefined>;
	unload(modelId: string): Promise<void>;
	/** Router-style servers: read the max co-resident instance count. */
	capacity?(): Promise<number | undefined>;
	/**
	 * Router-style servers: make the keep model resident. Must be idempotent
	 * (a loaded model returns immediately) and bounded by the runtime's load
	 * wait. A thrown error propagates to the caller and fails the turn with
	 * its message.
	 */
	load?(modelId: string): Promise<void>;
	/** Cross-process mutation serializer; defaults to the state-dir lock file. */
	withLock?<T>(targetKey: string, fn: () => Promise<T>): Promise<T>;
	now?: () => number;
	ttlMs?: number;
}

export type ReconcileResult = ResidencyPlan;

/**
 * Gather the resident set and capacity facts, decide, emit notices, and
 * perform the mutations under the cross-process lock. List and unload probes
 * are best-effort and degrade to observe-only; an explicit `load` failure
 * propagates so the turn fails with the router's reason instead of a bare
 * connection error.
 */
export async function reconcileResidency(adapter: ResidencyAdapter): Promise<ReconcileResult> {
	const now = adapter.now ?? Date.now;
	const ttl = adapter.ttlMs ?? RECONCILE_TTL_MS;

	const cached = reconcileCache.get(adapter.targetKey);
	if (cached && cached.modelId === adapter.keepModelId && now() - cached.at < ttl) {
		return {
			decision: cached.decision,
			evict: [],
			fallbackEvict: [],
			keepResident: cached.decision === "reconcile",
			notices: [],
		};
	}

	let resident: ResidentModelInfo[];
	try {
		resident = await adapter.listResident();
	} catch {
		// Unreachable or slow server: never block the turn, just observe.
		return { decision: "observe", evict: [], fallbackEvict: [], keepResident: false, notices: [] };
	}

	let capacity: number | undefined;
	if (adapter.capacity) {
		try {
			capacity = await adapter.capacity();
		} catch {
			capacity = undefined;
		}
	}

	let keepTagProtected = false;
	if (adapter.keepModelTags) {
		try {
			keepTagProtected = residentTagProtected(await adapter.keepModelTags());
		} catch {
			keepTagProtected = false;
		}
	}

	const protectedRoles = configProtectedRoles();
	const classified: ResidentClassified[] = resident.map((entry) => {
		const configId = [entry.modelId, ...(entry.aliasIds ?? [])].find((id) => protectedRoles.has(id));
		const protection: ResidencyProtection | undefined = residentTagProtected(entry.tags)
			? "tag"
			: configId !== undefined
				? "config"
				: undefined;
		const role = configId === undefined ? undefined : protectedRoles.get(configId);
		return {
			...entry,
			loadedByClio: isClioLoaded(adapter.targetKey, entry),
			...(protection ? { protection } : {}),
			...(role ? { role } : {}),
		};
	});

	const facts: ResidencyFacts = {
		targetId: adapter.targetId,
		runtimeId: adapter.runtimeId,
		keepModelId: adapter.keepModelId,
		resident: classified,
		managed: adapter.managed,
		strategy: adapter.strategy,
		...(capacity !== undefined ? { capacity } : {}),
		...(keepTagProtected ? { keepTagProtected } : {}),
		...(adapter.contextLength !== undefined ? { contextLength: adapter.contextLength } : {}),
		...(adapter.modelMaxContext !== undefined ? { modelMaxContext: adapter.modelMaxContext } : {}),
	};

	const plan = decideResidency(facts);
	for (const notice of plan.notices) emitResidencyNotice(notice);

	if (plan.decision === "reconcile") {
		const mutate = async (): Promise<void> => {
			for (const entry of plan.evict) {
				try {
					await adapter.unload(entry.modelId);
					forgetClioLoaded(adapter.targetKey, entry.modelId);
				} catch {
					// Best-effort: a failed unload self-heals on the next reconcile.
				}
			}
			if (adapter.load) await adapter.load(adapter.keepModelId);
		};
		// Serialize actual mutations across processes; a keep model that is
		// already fully resident needs no lock (the load hook is a no-op) and
		// waiting on a still-loading model is read-only polling.
		if (plan.evict.length > 0 || (adapter.load && !plan.keepResident)) {
			const lock = adapter.withLock ?? withResidencyLock;
			await lock(adapter.targetKey, mutate);
		} else {
			await mutate();
		}
		// Attribute the keep model to Clio only when Clio is the one loading it.
		if (!plan.keepResident) markClioLoaded(adapter.targetKey, adapter.keepModelId);
		reconcileCache.set(adapter.targetKey, { modelId: adapter.keepModelId, decision: "reconcile", at: now() });
	} else if (plan.decision === "observe" && !adapter.managed) {
		// Cache the opt-out observation so its notices dedupe per TTL; a
		// degraded observe (listResident failure) is never cached, so the next
		// stream re-probes.
		reconcileCache.set(adapter.targetKey, { modelId: adapter.keepModelId, decision: "observe", at: now() });
	}

	return plan;
}

/**
 * The env-level residency opt-out. Clio manages residency for every
 * manageable runtime by default; `CLIO_CODER_RESIDENCY=observe` (or off/0/false/
 * user) flips the whole process to observe-only. Per-target opt-out goes
 * through {@link residencyManagedFor}.
 */
export function residencyManaged(env: NodeJS.ProcessEnv = process.env): boolean {
	const opt = (env.CLIO_CODER_RESIDENCY ?? "").trim().toLowerCase();
	if (opt === "observe" || opt === "off" || opt === "0" || opt === "false" || opt === "user" || opt === "user-managed") {
		return false;
	}
	return true;
}

/**
 * Combined residency opt-out for one target: the process-wide env switch plus
 * the target's explicit `lifecycle: user-managed`. An absent lifecycle means
 * the operator made no choice, and Clio manages by default; runtime synthesis
 * only sets the metadata field when settings carry an explicit value.
 */
export function residencyManagedFor(
	lifecycle: "user-managed" | "clio-managed" | undefined,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (lifecycle === "user-managed") return false;
	return residencyManaged(env);
}
