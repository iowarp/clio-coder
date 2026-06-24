/**
 * One VRAM-aware model-residency reconciler, shared by every local runtime that
 * pins weights in VRAM. Both the interactive chat loop and the headless worker
 * drive the provider stream path, so calling the reconciler at the top of each
 * manageable runtime's runStream gives exactly one place that decides load and
 * evict for both paths.
 *
 * The reconciler is best-effort and non-blocking. A slow or unreachable server,
 * or a malformed resident listing, degrades to observe-only and never crashes a
 * turn. It evicts only models Clio itself loaded; a foreign-loaded model makes
 * the target look shared, so the reconciler backs off to observe-only and never
 * evicts another tenant's model. Every collision or stress case emits a notice
 * over the event bus instead of a thrown error; a genuine VRAM miss surfaces
 * that same notice content rather than a bare SDK failure.
 */

import { BusChannels, type RuntimeNoticeKind, type RuntimeNoticePayload } from "../../core/bus-events.js";
import { getSharedBus } from "../../core/shared-bus.js";
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

// --- Clio-loaded registry --------------------------------------------------

// Models Clio itself loaded, keyed by a stable per-server target key. A
// resident model absent from this set was loaded by something other than Clio,
// so the reconciler treats the server as shared and never evicts it.
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
const reconcileCache = new Map<string, { modelId: string; at: number }>();

/** Test-only: clear the cross-call Clio-loaded registry and TTL cache. */
export function resetResidencyState(): void {
	clioLoaded.clear();
	reconcileCache.clear();
}

// --- VRAM fit decision (pure) ----------------------------------------------

export interface VramSnapshot {
	totalBytes?: number;
	freeBytes?: number;
}

export interface ResidentClassified extends ResidentModelInfo {
	/** True when the Clio-loaded registry attributes this resident model to Clio. */
	loadedByClio: boolean;
}

export interface ResidencyFacts {
	targetId: string;
	runtimeId: string;
	keepModelId: string;
	resident: ReadonlyArray<ResidentClassified>;
	/** False when an env or per-target opt-out asks Clio to only observe. */
	managed: boolean;
	contextLength?: number;
	modelMaxContext?: number;
	vram?: VramSnapshot;
	requestedFootprintBytes?: number;
}

export type ResidencyDecision = "skip" | "reconcile" | "observe" | "decline";

export interface ResidencyPlan {
	decision: ResidencyDecision;
	/** Clio-loaded models the plan releases before loading the keep model. */
	evict: ResidentModelInfo[];
	/** True when the keep model is already resident on the target. */
	keepResident: boolean;
	/** Defined only when the runtime exposed VRAM and footprint numbers. */
	fits?: boolean;
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

/**
 * Decide what to do with the target's resident set, purely from already
 * gathered facts. The async {@link reconcileResidency} wraps this with the
 * round-trips; keeping the decision pure makes the fit math, eviction order,
 * foreign back-off, and every notice case directly testable without a server.
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
		return { decision: "observe", evict: [], keepResident, notices };
	}

	// Foreign-managed server: a resident model Clio did not load. Back off to
	// observe-only so Clio never evicts another tenant's model.
	const foreign = others.filter((entry) => !entry.loadedByClio);
	if (foreign.length > 0) {
		const names = foreign.map((entry) => entry.modelId).join(", ");
		notices.push(
			makeNotice(
				facts,
				"foreign-backoff",
				"info",
				`'${facts.targetId}' already has a model Clio did not load (${names}); backing off to observe-only and leaving residency to you.`,
				{ foreignCount: foreign.length },
			),
		);
		return { decision: "observe", evict: [], keepResident, notices };
	}

	// Every remaining resident model is one Clio loaded, so it is safe to evict.
	const evict = others;
	for (const entry of evict) {
		notices.push(
			makeNotice(
				facts,
				"about-to-evict",
				"info",
				`evicting Clio-loaded model '${entry.modelId}' from '${facts.targetId}' to free VRAM for '${facts.keepModelId}'.`,
				entry.sizeVramBytes !== undefined ? { freedVramBytes: entry.sizeVramBytes } : undefined,
			),
		);
	}

	// VRAM fit, when the runtime exposed the numbers. Available VRAM is what is
	// free now plus what the evicted Clio models give back.
	let fits: boolean | undefined;
	if (facts.vram?.freeBytes !== undefined && facts.requestedFootprintBytes !== undefined) {
		const reclaimable = evict.reduce((sum, entry) => sum + (entry.sizeVramBytes ?? 0), 0);
		const available = facts.vram.freeBytes + reclaimable;
		fits = facts.requestedFootprintBytes <= available;
		if (!fits) {
			const atContext = facts.contextLength ? ` at context ${facts.contextLength}` : "";
			notices.push(
				makeNotice(
					facts,
					"will-not-fit",
					"error",
					`'${facts.keepModelId}' needs ~${gib(facts.requestedFootprintBytes)} of VRAM but only ${gib(available)} is available on '${facts.targetId}'${atContext}. Lower the context window, use a smaller KV-cache quant, or pick a smaller model or tier.`,
					{
						requestedFootprintBytes: facts.requestedFootprintBytes,
						availableBytes: available,
						freeBytes: facts.vram.freeBytes,
						reclaimableBytes: reclaimable,
						...(facts.contextLength ? { contextLength: facts.contextLength } : {}),
					},
				),
			);
			// Declining leaves the resident set untouched: evicting a usable model
			// to load one that still will not fit only makes the target worse.
			return { decision: "decline", evict: [], keepResident, fits, notices };
		}
	}

	const plan: ResidencyPlan = { decision: "reconcile", evict, keepResident, notices };
	if (fits !== undefined) plan.fits = fits;
	return plan;
}

// --- async reconciler ------------------------------------------------------

/**
 * Per-runtime hooks the reconciler drives. Each manageable runtime builds an
 * adapter that closes over its own client (the LM Studio SDK socket, the Ollama
 * HTTP client) so the reconciler itself stays runtime-agnostic.
 */
export interface ResidencyAdapter {
	/** Stable per-server key for the Clio-loaded registry and TTL cache. */
	targetKey: string;
	targetId: string;
	runtimeId: string;
	keepModelId: string;
	/** False when an env or per-target opt-out asks Clio to only observe. */
	managed: boolean;
	contextLength?: number;
	modelMaxContext?: number;
	listResident(): Promise<ResidentModelInfo[]>;
	unload(modelId: string): Promise<void>;
	detectVram?(): Promise<VramSnapshot | undefined>;
	estimateFootprintBytes?(): Promise<number | undefined>;
	now?: () => number;
	ttlMs?: number;
}

export type ReconcileResult = ResidencyPlan;

/**
 * Gather the resident set and VRAM facts, decide, emit notices, and perform the
 * evictions. Best-effort throughout: any probe failure degrades the result
 * rather than throwing.
 */
export async function reconcileResidency(adapter: ResidencyAdapter): Promise<ReconcileResult> {
	const now = adapter.now ?? Date.now;
	const ttl = adapter.ttlMs ?? RECONCILE_TTL_MS;

	if (adapter.managed) {
		const cached = reconcileCache.get(adapter.targetKey);
		if (cached && cached.modelId === adapter.keepModelId && now() - cached.at < ttl) {
			return { decision: "skip", evict: [], keepResident: true, notices: [] };
		}
	}

	let resident: ResidentModelInfo[];
	try {
		resident = await adapter.listResident();
	} catch {
		// Unreachable or slow server: never block the turn, just observe.
		return { decision: "observe", evict: [], keepResident: false, notices: [] };
	}

	let vram: VramSnapshot | undefined;
	if (adapter.detectVram) {
		try {
			vram = await adapter.detectVram();
		} catch {
			vram = undefined;
		}
	}
	let requestedFootprintBytes: number | undefined;
	if (adapter.estimateFootprintBytes) {
		try {
			requestedFootprintBytes = await adapter.estimateFootprintBytes();
		} catch {
			requestedFootprintBytes = undefined;
		}
	}

	const classified: ResidentClassified[] = resident.map((entry) => ({
		...entry,
		loadedByClio: isClioLoaded(adapter.targetKey, entry),
	}));

	const facts: ResidencyFacts = {
		targetId: adapter.targetId,
		runtimeId: adapter.runtimeId,
		keepModelId: adapter.keepModelId,
		resident: classified,
		managed: adapter.managed,
		...(adapter.contextLength !== undefined ? { contextLength: adapter.contextLength } : {}),
		...(adapter.modelMaxContext !== undefined ? { modelMaxContext: adapter.modelMaxContext } : {}),
		...(vram ? { vram } : {}),
		...(requestedFootprintBytes !== undefined ? { requestedFootprintBytes } : {}),
	};

	const plan = decideResidency(facts);
	for (const notice of plan.notices) emitResidencyNotice(notice);

	for (const entry of plan.evict) {
		try {
			await adapter.unload(entry.modelId);
			forgetClioLoaded(adapter.targetKey, entry.modelId);
		} catch {
			// Best-effort: a failed unload self-heals on the next reconcile.
		}
	}

	if (plan.decision === "reconcile") {
		// Attribute the keep model to Clio only when Clio is the one loading it.
		if (!plan.keepResident) markClioLoaded(adapter.targetKey, adapter.keepModelId);
		reconcileCache.set(adapter.targetKey, { modelId: adapter.keepModelId, at: now() });
	}

	return plan;
}

/**
 * The single residency opt-out. Clio manages residency for every manageable
 * runtime by default and relies on foreign-model detection to spot a shared
 * server, so the operator does not set a lifecycle by hand for the common case.
 * `CLIO_RESIDENCY=observe` (or off/0/false/user) flips one target or the whole
 * process to observe-only.
 */
export function residencyManaged(env: NodeJS.ProcessEnv = process.env): boolean {
	const opt = (env.CLIO_RESIDENCY ?? "").trim().toLowerCase();
	if (opt === "observe" || opt === "off" || opt === "0" || opt === "false" || opt === "user" || opt === "user-managed") {
		return false;
	}
	return true;
}
