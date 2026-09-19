/**
 * One capacity-aware model-residency reconciler, shared by every local runtime
 * that manages loaded models. Both the interactive chat loop and the headless
 * worker drive the provider stream path, so calling the reconciler at the top
 * of each manageable runtime's stream gives exactly one place that decides
 * load and evict for both paths.
 *
 * Co-residency is the default. Local servers are multi-model hosts with finite
 * VRAM, not single-model slots: when the runtime advertises capacity (the
 * llama.cpp router's `max_instances`) and a slot is free, Clio loads without
 * evicting anything; when the runtime loads just-in-time (LM Studio), Clio
 * attempts the co-resident load first and considers swapping only after an
 * explicit capacity rejection; when the server schedules fits itself
 * (Ollama), Clio releases only its own unprotected stragglers. Eviction is the
 * exception, using only Clio-attributed loads. It never selects a protected
 * resident while an unprotected owned one is available.
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
 * Failed metadata reads degrade to observe-only. Explicit mutation failures
 * propagate after rollback, and router adapters must honor a declined plan
 * before allowing an inference request to trigger an automatic load.
 * An explicit target `lifecycle: user-managed` forces observe-only.
 * Collision and stress notices travel over the event bus. One successful
 * reconcile decision holds per (target, model) within a
 * TTL, and mutations for a target are serialized across processes through a
 * state-dir lock file so a worker and the orchestrator cannot interleave
 * unload/load against the same server.
 */

import {
	BusChannels,
	type DeclaredRuntimeNotice,
	type ResidencyMutationPayload,
	type RuntimeNoticeKind,
	type RuntimeNoticePayload,
} from "../../core/bus-events.js";
import { canonicalEndpointUrl } from "../../core/endpoint-key.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import type { ProtectedModelRef, ResidencyRole } from "../../core/residency-protection.js";
import { residencyTargetKey } from "../../core/residency-target-key.js";
import { getSharedBus } from "../../core/shared-bus.js";
import { withResidencyLock } from "./residency-lock.js";
import { type ResidentModelInfo, residentMatchesKeep } from "./resident-models.js";

export type ResidencyNotice = RuntimeNoticePayload;
export type { RuntimeNoticeKind };

// --- notice sink -----------------------------------------------------------

export type ResidencyNoticeSink = (notice: ResidencyNotice) => void;

function busNoticeSink(notice: ResidencyNotice): void {
	getSharedBus().emit(BusChannels.RuntimeNotice, notice as DeclaredRuntimeNotice);
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

/**
 * Deliver one notice through the active sink, or onto `bus` when the producer
 * was handed one explicitly. Never throws into a turn.
 */
function deliverNotice(notice: ResidencyNotice, bus?: Pick<SafeEventBus, "emit">): void {
	try {
		if (bus) bus.emit(BusChannels.RuntimeNotice, notice as DeclaredRuntimeNotice);
		else noticeSink(notice);
	} catch {
		// A notice is informational; a sink failure must never escape into a turn.
	}
}

// --- notice producers ----------------------------------------------------------

const noticeProducers = new Map<string, ReadonlySet<RuntimeNoticeKind>>();

/**
 * Emitter bound to the kinds its producer declared; any other kind is a type
 * error. A producer that owns an injected bus passes it; otherwise the notice
 * goes to the active sink.
 */
export type RuntimeNoticeEmitter<K extends RuntimeNoticeKind> = (
	notice: ResidencyNotice & { kind: K },
	bus?: Pick<SafeEventBus, "emit">,
) => void;

/**
 * Declare a module as the producer of some {@link RuntimeNoticeKind} members
 * and get back the only way to emit them. Emission goes exclusively through
 * these emitters, so a registered kind always has code that emits it, and a
 * contract test checks that every member of the union is registered by some
 * producer. Call once at module scope.
 */
export function declareRuntimeNoticeProducer<const K extends RuntimeNoticeKind>(
	producer: string,
	kinds: ReadonlyArray<K>,
): RuntimeNoticeEmitter<K> {
	noticeProducers.set(producer, new Set(kinds));
	return deliverNotice;
}

/** Every declared producer with the kinds it emits. */
export function runtimeNoticeProducers(): ReadonlyMap<string, ReadonlySet<RuntimeNoticeKind>> {
	return noticeProducers;
}

type ReconcilerNoticeKind = "will-not-fit" | "about-to-evict" | "swap" | "co-resident" | "stress";
type ReconcilerNotice = ResidencyNotice & { kind: ReconcilerNoticeKind };

const emitReconcilerNotice = declareRuntimeNoticeProducer<ReconcilerNoticeKind>("residency-reconciler", [
	"will-not-fit",
	"about-to-evict",
	"swap",
	"co-resident",
	"stress",
]);

/** Publish one successful residency mutation to in-process cache telemetry. */
export function emitResidencyMutation(mutation: Omit<ResidencyMutationPayload, "at">): void {
	getSharedBus().emit(BusChannels.ResidencyMutation, { ...mutation, at: Date.now() });
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
// another Clio process's model. Those loads are foreign to this session.
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

/**
 * Drop a model Clio released outside the reconciler, such as the release on
 * process exit, so neither the registry nor the TTL fast path still believes
 * it resident.
 */
export function forgetReleasedModel(targetKey: string, modelId: string): void {
	forgetClioLoaded(targetKey, modelId);
	workerLoaded.get(targetKey)?.delete(modelId);
	reconcileCache.delete(targetKey);
}

export function isClioLoaded(targetKey: string, entry: ResidentModelInfo): boolean {
	const set = clioLoaded.get(targetKey);
	if (!set) return false;
	if (set.has(entry.modelId)) return true;
	return (entry.aliasIds ?? []).some((id) => set.has(id));
}

// --- worker-loaded models --------------------------------------------------

// Models a dispatched worker loaded, adopted by the orchestrator so its release
// on exit covers them (#379). Kept apart from clioLoaded because they carry
// eviction protection: another dispatch may still be using one.
const workerLoaded = new Map<string, Set<string>>();

function isWorkerLoaded(targetKey: string, entry: ResidentModelInfo): boolean {
	const set = workerLoaded.get(targetKey);
	if (!set) return false;
	return [entry.modelId, ...(entry.aliasIds ?? [])].some((id) => set.has(id));
}

/** One model a request loaded and pinned, as a runtime reports it. */
export interface ClioModelLoad {
	runtimeId: string;
	targetId: string;
	modelId: string;
	aliasIds: string[];
}

let loadReportSink: ((load: ClioModelLoad) => void) | null = null;

/**
 * Where a runtime's load reports go. The worker entry installs a sink that
 * forwards each report to the orchestrator over the control lane; the
 * orchestrator installs none, because its own loads are already in its
 * registries. Passing null removes the sink.
 */
export function setModelLoadReportSink(sink: ((load: ClioModelLoad) => void) | null): void {
	loadReportSink = sink;
}

/**
 * Report a model this process loaded and pinned, when both residency
 * registries attribute it to this process: the reconciler saw it absent before
 * Clio's request, and the runtime then recorded ownership. A model that was
 * resident before this process touched it is never reported. Never throws.
 */
export function reportClioModelLoad(load: ClioModelLoad, targetKey: string): void {
	if (!loadReportSink || !isClioLoaded(targetKey, { modelId: load.modelId, aliasIds: load.aliasIds })) return;
	try {
		loadReportSink(load);
	} catch {
		// A report is best-effort; losing one leaves the model pinned, never a turn failed.
	}
}

/** How to reach the server a worker loaded a model on, from the orchestrator's own settings. */
export interface WorkerModelLoadEndpoint {
	runtimeId: string;
	baseUrl: string;
	headers: Record<string, string>;
}

type WorkerLoadAdopter = (targetKey: string, endpoint: WorkerModelLoadEndpoint, modelIds: string[]) => void;

const workerLoadAdopters = new Map<string, WorkerLoadAdopter>();

/** Register how a runtime takes ownership of a model a worker loaded. */
export function registerWorkerLoadAdopter(runtimeId: string, adopter: WorkerLoadAdopter): void {
	workerLoadAdopters.set(runtimeId, adopter);
}

/**
 * Adopt a model a dispatched worker loaded, so this process releases it on
 * exit and no stream here evicts it first. Returns false when the runtime has
 * no adopter or the endpoint has no residency key.
 */
export function adoptWorkerLoadedModel(
	endpoint: WorkerModelLoadEndpoint,
	load: Pick<ClioModelLoad, "modelId" | "aliasIds">,
): boolean {
	const adopter = workerLoadAdopters.get(endpoint.runtimeId);
	const targetKey = residencyTargetKey(endpoint.runtimeId, endpoint.baseUrl);
	if (!adopter || targetKey === null) return false;
	const ids = [load.modelId, ...load.aliasIds];
	let set = workerLoaded.get(targetKey);
	if (!set) {
		set = new Set();
		workerLoaded.set(targetKey, set);
	}
	for (const id of ids) {
		set.add(id);
		markClioLoaded(targetKey, id);
	}
	adopter(targetKey, endpoint, ids);
	return true;
}

// --- release on exit ------------------------------------------------------

/** Total time the release on exit may take before shutdown moves on without it. */
export const EXIT_RELEASE_MS = 2_000;

/**
 * Narrows a release to some models. Called with the target key and every id
 * the resident entry answers to; true releases the model.
 */
export type ReleaseScope = (targetKey: string, modelIds: ReadonlyArray<string>) => boolean;

/**
 * A release scope for one probe: the server reached at any of `baseUrls` and
 * a resident entry answering to any of `modelIds`. Urls are compared by the
 * same canonical endpoint the residency registry keys on.
 */
export function releaseScopeFor(
	baseUrls: ReadonlyArray<string | null | undefined>,
	modelIds: ReadonlyArray<string | null | undefined>,
): ReleaseScope {
	const keys = new Set(
		baseUrls
			.filter((url): url is string => typeof url === "string" && url.length > 0)
			.map((url) => canonicalEndpointUrl(url) ?? url),
	);
	const ids = new Set(modelIds.filter((id): id is string => typeof id === "string" && id.length > 0));
	return (targetKey, entryIds) => keys.has(targetKey) && entryIds.some((id) => ids.has(id));
}

const exitReleasers = new Set<(scope?: ReleaseScope) => Promise<void>>();

/**
 * Register a runtime's release of the models this process loaded and pinned.
 * A runtime registers when its module loads, so a process that never reached
 * the runtime has nothing to release and pays nothing at exit.
 */
export function registerExitRelease(release: (scope?: ReleaseScope) => Promise<void>): void {
	exitReleasers.add(release);
}

/**
 * Run every registered release. Each release bounds itself by
 * {@link EXIT_RELEASE_MS}; a failure is swallowed so the exit code never
 * depends on a server that is gone.
 */
export async function releaseClioLoadedModelsOnExit(scope?: ReleaseScope): Promise<void> {
	await Promise.all(
		[...exitReleasers].map((release) =>
			release(scope).catch(() => {
				// Best-effort: the model stays pinned.
			}),
		),
	);
}

/**
 * Run `task`, then release every model that became Clio-loaded while it ran,
 * whether it settled or threw. A one-shot inference probe uses this so it never
 * leaves a pinned model behind in a process that has no release on exit (#379).
 * A model Clio had already loaded before the task stays pinned for the turn
 * that loaded it, and a model resident before Clio touched it is never
 * Clio-loaded in the first place (#313). The release is bounded by
 * {@link EXIT_RELEASE_MS}.
 *
 * `scope` narrows the release further. In a process that also runs chat
 * turns, "became Clio-loaded while the task ran" includes a model a concurrent
 * turn loaded, so an in-session probe passes the one target and model it
 * exercised and leaves every other load to the turn that made it.
 */
export async function releaseModelsLoadedDuring<T>(task: () => Promise<T>, scope?: ReleaseScope): Promise<T> {
	const before = new Set<string>();
	for (const [targetKey, ids] of clioLoaded) for (const id of ids) before.add(`${targetKey}\n${id}`);
	try {
		return await task();
	} finally {
		await releaseClioLoadedModelsOnExit(
			(targetKey, ids) =>
				!ids.some((id) => before.has(`${targetKey}\n${id}`)) && (scope === undefined || scope(targetKey, ids)),
		);
	}
}

// --- TTL fast path ---------------------------------------------------------

/** Skip the listResident round-trip for this long after a clean reconcile. */
export const RECONCILE_TTL_MS = 60_000;
const reconcileCache = new Map<string, { modelId: string; decision: "reconcile" | "observe"; at: number }>();

// --- residency decision (pure) ----------------------------------------------

/**
 * How the runtime makes a requested model resident, which decides when an
 * eviction is even on the table:
 *   - "router": Clio must POST an explicit load (llama.cpp router) and the
 *     server advertises a slot capacity. A free slot loads without eviction;
 *     a full server frees exactly the slots needed; unknown capacity with existing residents declines the load.
 *   - "jit": the runtime loads on open. Nothing is evicted up front; the
 *     plan carries ranked `fallbackEvict` candidates for a retry after a
 *     will-not-fit failure.
 *   - "scheduler": the server places and fits models itself (Ollama). Only
 *     Clio's own unprotected stragglers are released, because Clio pins them
 *     with keep_alive -1 and nothing else ever reclaims them.
 */
export type ResidencyStrategy = "router" | "jit" | "scheduler";

/**
 * Why a resident model may not be evicted, when it may not. `worker` marks a
 * model a dispatched worker loaded and the orchestrator adopted: a later
 * dispatch may still use it, so no Clio stream evicts it mid-session and the
 * release on exit reclaims it instead.
 */
export type ResidencyProtection = "tag" | "config" | "worker";

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
	notices: ReconcilerNotice[];
}

function gib(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function makeNotice(
	facts: ResidencyFacts,
	kind: ReconcilerNoticeKind,
	level: ResidencyNotice["level"],
	message: string,
	detail?: ResidencyNotice["detail"],
): ReconcilerNotice {
	const notice: ReconcilerNotice = {
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

/** `the memory model` / `the chat model` for a notice, or the bare id's article. */
function describeRole(role: ResidencyRole | undefined): string {
	if (role === "chat") return "the chat model";
	if (role === "memory") return "the memory model";
	if (role === "worker") return "a worker model";
	if (role === "target-default") return "a target default model";
	return "a configured model";
}

function evictionNotice(facts: ResidencyFacts, entry: ResidentClassified): ReconcilerNotice {
	if (entry.protection === "config") {
		return makeNotice(
			facts,
			"swap",
			"warning",
			`evicting '${entry.modelId}' from '${facts.targetId}' to make room for '${facts.keepModelId}' even though settings still reference it as ${describeRole(entry.role)}: every slot is taken and no unprotected resident is left. Another profile pointed at it will reload it.`,
			{ swappedOut: entry.modelId, configProtected: true, ...(entry.role ? { role: entry.role } : {}) },
		);
	}
	return makeNotice(
		facts,
		"about-to-evict",
		"info",
		`evicting Clio-loaded model '${entry.modelId}' from '${facts.targetId}' to free a slot for '${facts.keepModelId}'.`,
		entry.sizeVramBytes !== undefined ? { freedVramBytes: entry.sizeVramBytes } : undefined,
	);
}

/**
 * Decide what to do with the target's resident set, purely from already
 * gathered facts. The async {@link reconcileResidency} wraps this with the
 * round-trips; keeping the decision pure makes the capacity math, protection
 * tiers, eviction order, and every notice case directly testable without a
 * server.
 */
function decideResidency(facts: ResidencyFacts): ResidencyPlan {
	const notices: ReconcilerNotice[] = [];
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

	// Only loads attributed to this Clio session may be eviction candidates.
	// Configured model names describe demand, not ownership of foreign loads.
	const owned = others.filter((entry) => entry.loadedByClio);
	const tierUnprotected = owned.filter((entry) => entry.protection === undefined);
	const tierConfig = owned.filter((entry) => entry.protection === "config");
	const configEvictable = facts.keepTagProtected !== true;

	let evict: ResidentClassified[] = [];
	let fallbackEvict: ResidentClassified[] = [];

	if (facts.strategy === "jit") {
		// Attempt co-residency first; only an explicit capacity failure
		// justifies swapping an owned instance. GPU fit is not guaranteed.
		fallbackEvict = configEvictable ? [...tierUnprotected, ...tierConfig] : tierUnprotected;
	} else if (facts.strategy === "scheduler") {
		// The server fits and places models itself. Release only Clio's own
		// unprotected stragglers; foreign and protected residents stay.
		evict = tierUnprotected;
	} else if (facts.capacity === undefined) {
		// Without a capacity bound, a load can silently displace another model.
		// Preserve the current serving set rather than guess how much to evict.
		if (others.length > 0) {
			notices.push(
				makeNotice(
					facts,
					"will-not-fit",
					"error",
					`cannot load '${facts.keepModelId}' on '${facts.targetId}': router capacity is unknown while other models are resident. Restore capacity inspection or load the model on the server.`,
				),
			);
			return { decision: "decline", evict: [], fallbackEvict: [], keepResident, notices };
		}
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
						`cannot load '${facts.keepModelId}' on '${facts.targetId}': its ${facts.capacity} instance slots cannot be freed using Clio-owned, evictable models (${others.map((entry) => entry.modelId).join(", ")}). Unload one manually or raise the server's max instances.`,
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
 * adapter that closes over its own transport (LM Studio REST, the Ollama HTTP
 * client, the llama.cpp router's HTTP surface) so the reconciler
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
	signal?: AbortSignal;
	/**
	 * Runtime tags of the keep model itself, when the runtime lists them before
	 * the load (the llama.cpp router lists tags for unloaded models too). Called
	 * after {@link listResident}, so an adapter may serve it from that snapshot.
	 */
	keepModelTags?(): Promise<ReadonlyArray<string> | undefined>;
	unload(modelId: string): Promise<void>;
	/**
	 * Reject with a {@link ResidencyPreconditionError} when the server cannot
	 * make the keep model resident at all, most often because the model is not
	 * in its catalog. Consulted only when the plan would evict, and only from
	 * facts the adapter already holds, so it costs no extra round trip.
	 *
	 * Adapters that cannot know this ahead of the load omit the hook, which
	 * keeps the previous behaviour of letting the load itself report the failure.
	 */
	assertLoadable?(): Promise<void>;
	/** Router-style servers: read the max co-resident instance count. */
	capacity?(): Promise<number | undefined>;
	/**
	 * Router-style servers: make the keep model resident. Must be idempotent
	 * (a loaded model returns immediately) and bounded by the runtime's load
	 * wait. A thrown error propagates to the caller and fails the turn with
	 * its message.
	 */
	load?(modelId: string): Promise<void>;
	/**
	 * Make a model the reconciler just evicted resident again, after the load
	 * that eviction made room for was rejected. Distinct from
	 * {@link ResidencyAdapter.load}, which serves the keep model and may consult
	 * a listing snapshot taken before the eviction: that snapshot still shows
	 * the evicted model as resident, so reusing it here would restore nothing.
	 * Implementations must therefore force the load rather than short-circuit on
	 * cached state.
	 *
	 * Adapters that omit the hook keep the previous behaviour, where a failed
	 * load leaves the evicted model unloaded.
	 */
	reloadEvicted?(modelId: string): Promise<void>;
	/** Cross-process mutation serializer; defaults to the state-dir lock file. */
	withLock?<T>(targetKey: string, fn: () => Promise<T>): Promise<T>;
	now?: () => number;
	ttlMs?: number;
}

export type ReconcileResult = ResidencyPlan;

/**
 * Put back the models an eviction removed once the load it made room for has
 * failed. Best-effort by construction: the load failure is the error the caller
 * must see, so a restore that also fails is reported as a notice and never
 * replaces it. Restores run in eviction order, and the freed slots are known to
 * be available because the keep model did not take them.
 */
async function restoreEvictedModels(
	adapter: ResidencyAdapter,
	evicted: ReadonlyArray<ResidentModelInfo>,
	loadError: unknown,
): Promise<void> {
	if (evicted.length === 0) return;
	const reason = loadError instanceof Error ? loadError.message : String(loadError);
	const restored: string[] = [];
	const failed: string[] = [];
	for (const entry of evicted) {
		if (!adapter.reloadEvicted) {
			failed.push(entry.modelId);
			continue;
		}
		try {
			await adapter.reloadEvicted(entry.modelId);
			markClioLoaded(adapter.targetKey, entry.modelId);
			restored.push(entry.modelId);
			emitResidencyMutation({
				targetKey: adapter.targetKey,
				targetId: adapter.targetId,
				runtimeId: adapter.runtimeId,
				model: entry.modelId,
				operation: "load",
			});
		} catch {
			failed.push(entry.modelId);
		}
	}
	if (restored.length > 0) {
		emitReconcilerNotice({
			kind: "swap",
			level: "warning",
			targetId: adapter.targetId,
			runtimeId: adapter.runtimeId,
			model: adapter.keepModelId,
			message: `loading '${adapter.keepModelId}' on '${adapter.targetId}' failed (${reason}); restored ${restored.map((id) => `'${id}'`).join(", ")} so the target keeps serving.`,
			detail: { restored: restored.join(", ") },
		});
	}
	if (failed.length > 0) {
		emitReconcilerNotice({
			kind: "will-not-fit",
			level: "error",
			targetId: adapter.targetId,
			runtimeId: adapter.runtimeId,
			model: adapter.keepModelId,
			message: `loading '${adapter.keepModelId}' on '${adapter.targetId}' failed (${reason}) and ${failed.map((id) => `'${id}'`).join(", ")} could not be restored; the target may now serve nothing. Reload it on the server.`,
			detail: { unrestored: failed.join(", ") },
		});
	}
}

/**
 * Thrown by an adapter's {@link ResidencyAdapter.assertLoadable} when the
 * server cannot make the keep model resident at all, most often because the
 * model is not in the server's catalog. It is a precondition failure, not a
 * transport failure: the reconciler must not evict anything for a load that is
 * already known to be impossible, because the eviction would succeed, the load
 * would fail, and the target would be left holding nothing (#127).
 *
 * The reconciler answers it by declining the reconcile and emitting a
 * `will-not-fit` notice, so the turn continues to the provider call and fails
 * with the server's own error for the unknown model instead of with a silent
 * outage on the node. It is the fast path in front of the restore that
 * {@link reconcileResidency} performs when a load fails for any other reason.
 */
export class ResidencyPreconditionError extends Error {
	override readonly name = "ResidencyPreconditionError";
}

/**
 * Gather the resident set and capacity facts, decide, emit notices, and
 * perform the mutations under the cross-process lock. List and unload probes
 * are best-effort and degrade to observe-only; an explicit `load` failure
 * propagates so the turn fails with the router's reason instead of a bare
 * connection error.
 */
export async function reconcileResidency(adapter: ResidencyAdapter): Promise<ReconcileResult> {
	return reconcileResidencyState(adapter, false);
}

async function reconcileResidencyState(adapter: ResidencyAdapter, lockHeld: boolean): Promise<ReconcileResult> {
	adapter.signal?.throwIfAborted();
	const now = adapter.now ?? (() => performance.now());
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
	// Router capacity and its eviction plan must describe the server after the
	// previous lock holder finished loading, not a snapshot from before the wait.
	if (adapter.managed && adapter.strategy === "router" && !lockHeld) {
		const reconcile = () => reconcileResidencyState(adapter, true);
		return adapter.withLock
			? adapter.withLock(adapter.targetKey, reconcile)
			: withResidencyLock(adapter.targetKey, reconcile, adapter.signal);
	}

	let resident: ResidentModelInfo[];
	try {
		resident = await adapter.listResident();
	} catch {
		adapter.signal?.throwIfAborted();
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
				: isWorkerLoaded(adapter.targetKey, entry)
					? "worker"
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
	adapter.signal?.throwIfAborted();

	// An eviction is only justified if the load it makes room for can succeed.
	// Unloading first and discovering afterwards that the keep model does not
	// exist leaves the target serving nothing, which took a shared node out of
	// service on the live fleet (#127). Nothing has mutated yet at this point;
	// the adapter can stop the request with the loadability diagnostic.
	if (plan.decision === "reconcile" && plan.evict.length > 0 && adapter.assertLoadable) {
		try {
			await adapter.assertLoadable();
		} catch (error) {
			if (!(error instanceof ResidencyPreconditionError)) throw error;
			const notice: ReconcilerNotice = {
				kind: "will-not-fit",
				level: "error",
				targetId: adapter.targetId,
				runtimeId: adapter.runtimeId,
				model: adapter.keepModelId,
				message: error.message,
			};
			emitReconcilerNotice(notice);
			return { decision: "decline", evict: [], fallbackEvict: [], keepResident: false, notices: [notice] };
		}
	}

	// Emitted after the loadability gate so the operator never reads an eviction
	// notice for a swap that the gate then refuses.
	for (const notice of plan.notices) emitReconcilerNotice(notice);

	if (plan.decision === "reconcile") {
		const mutate = async (): Promise<void> => {
			adapter.signal?.throwIfAborted();
			const evicted: ResidentModelInfo[] = [];
			try {
				for (const entry of plan.evict) {
					await adapter.unload(entry.modelId);
					forgetClioLoaded(adapter.targetKey, entry.modelId);
					evicted.push(entry);
					emitResidencyMutation({
						targetKey: adapter.targetKey,
						targetId: adapter.targetId,
						runtimeId: adapter.runtimeId,
						model: entry.modelId,
						operation: "evict",
					});
				}
				if (!adapter.load) return;
				await adapter.load(adapter.keepModelId);
				if (!plan.keepResident) {
					emitResidencyMutation({
						targetKey: adapter.targetKey,
						targetId: adapter.targetId,
						runtimeId: adapter.runtimeId,
						model: adapter.keepModelId,
						operation: "load",
					});
				}
			} catch (error) {
				// The eviction bought nothing: the slot it freed is still empty and
				// the target is now serving less than before the reconcile. Put back
				// what was taken before surfacing the load's own failure, so a
				// rejected load costs the node a request rather than its resident
				// model (#127). The gate above catches the knowable case ahead of any
				// mutation; this covers the rest, including an out-of-memory load, a
				// 5xx, a load wait that times out, and a preset removed between the
				// listing and the load.
				await restoreEvictedModels(adapter, evicted, error);
				throw error;
			}
		};
		// Serialize actual mutations across processes; a keep model that is
		// already fully resident needs no lock (the load hook is a no-op) and
		// waiting on a still-loading model is read-only polling.
		if (!lockHeld && (plan.evict.length > 0 || (adapter.load && !plan.keepResident))) {
			if (adapter.withLock) await adapter.withLock(adapter.targetKey, mutate);
			else await withResidencyLock(adapter.targetKey, mutate, adapter.signal);
		} else {
			await mutate();
		}
		// Attribute the keep model to Clio only when Clio is the one loading it.
		if (!plan.keepResident && adapter.load) markClioLoaded(adapter.targetKey, adapter.keepModelId);
		// A scheduler/JIT plan does not load anything itself. A failed upcoming
		// chat must not turn that plan into a cached claim that the model is resident.
		if (plan.keepResident || adapter.load) {
			reconcileCache.set(adapter.targetKey, { modelId: adapter.keepModelId, decision: "reconcile", at: now() });
		} else {
			reconcileCache.delete(adapter.targetKey);
		}
	} else if (plan.decision === "observe" && !adapter.managed) {
		// Cache the opt-out observation so its notices dedupe per TTL; a
		// degraded observe (listResident failure) is never cached, so the next
		// stream re-probes.
		reconcileCache.set(adapter.targetKey, { modelId: adapter.keepModelId, decision: "observe", at: now() });
	}

	return plan;
}

/**
 * Residency policy for one target. An absent lifecycle means the operator made
 * no choice and Clio manages by default; runtime synthesis only sets the
 * metadata field when settings carry an explicit value.
 */
export function residencyManagedFor(lifecycle: "user-managed" | "clio-coder-managed" | undefined): boolean {
	return lifecycle !== "user-managed";
}
