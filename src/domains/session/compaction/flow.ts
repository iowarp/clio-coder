/**
 * The compaction flow: resolve the summarizer route, admit and run the summary
 * call, and publish the checkpoint onto the live session ledger. The composition
 * root only binds the session-control replay through `CompactionReplay`, since a
 * domain may not reach session-control.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ClioSettings } from "../../../core/config.js";
import type { SideCallAuth } from "../../../core/oauth-retry.js";
import { pruneProviderCheckpoints } from "../../../core/provider-checkpoint.js";
import { providerCheckpointFromMessage } from "../../../core/provider-checkpoint-handle.js";
import type { EventPayload } from "../../../core/telemetry/events.js";
import { telemetryHub } from "../../../core/telemetry/hub.js";
import { pricesCalls, pricingBasisFields } from "../../../core/telemetry/pricing.js";
import { sessionPaths } from "../../../engine/session.js";
import type { AgentMessage, EngineModel } from "../../../engine/types.js";
import type { MemoryRuntime } from "../../memory/runtime.js";
import { prepareBackgroundModelMetadata } from "../../providers/background-model-metadata.js";
import type { ProvidersContract, ResolvedRuntimeTarget } from "../../providers/index.js";
import {
	applyModelCapabilityPatch,
	modelEndpointKey,
	refineRuntimeTargetWithModelHints,
	registerForegroundStream,
	resolveRuntimeTarget,
	targetRequiresAuth,
} from "../../providers/index.js";
import { resolveModelReference } from "../../providers/resolver.js";
import { LOCAL_API_KEY_FALLBACK, resolveSideCallAuth } from "../../providers/side-call-auth.js";
import type { SchedulingContract } from "../../scheduling/contract.js";
import type { AdmissionHold } from "../../telemetry/call-scope.js";
import type { TelemetryContract } from "../../telemetry/index.js";
import { estimateAgentContextBreakdown } from "../context-accounting.js";
import { continuityPayloadFromFold } from "../continuity/carry.js";
import { continuityProjectionTokens, resolveContinuityProjection } from "../continuity/projection.js";
import type { SessionContract } from "../contract.js";
import type { CompactionSummaryEntry, CompactionTrigger, SessionEntry } from "../entries.js";
import { withProviderCheckpointMeasurements } from "../entries.js";
import { observationCheckpoint, observationSourceUnits } from "../memory-source.js";
import { filterEntriesToActivePath } from "../tree/active-path.js";
import { serializeConversation } from "./branch-summary.js";
import { type CompactInput, type CompactionCallObservation, type CompactResult, compact } from "./compact.js";
import { readCompactionSystemPrompt } from "./system-prompt.js";

/** The live budget a caller threads into one compaction. */
export type CompactionFlowBudget = Pick<
	CompactInput,
	| "providerCompaction"
	| "livePrefix"
	| "providerFallbackReason"
	| "providerReplayFallback"
	| "keepRecentTokens"
	| "requireFit"
	| "preserveUserTurnId"
	| "pendingOperatorTurn"
	| "skillContextState"
	| "signal"
	| "beforeSummaryCall"
	| "onSummaryOutput"
	| "checkpointForSummary"
	| "checkpointTokenFigures"
	| "skipSummaryDigest"
>;

/** How the summarizer request is admitted and what memory it may offer. */
export interface CompactionFlowAdmission {
	scheduling?: SchedulingContract;
	headless?: boolean;
	getCeilingUsd?: () => number;
	/** Information-flow admission of the summarizer request; the block reason or null. */
	admitFlow?: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
	memory?: MemoryRuntime;
}

/** Replays a branch of the session as the model would see it; session-control owns the replay rules. */
export type CompactionReplay = (
	session: SessionContract,
	history: ReadonlyArray<SessionEntry>,
	activeLeafTurnId: string | undefined,
) => AgentMessage[];

export interface CompactionResolution extends SideCallAuth {
	model: EngineModel;
	pricedBy: ResolvedRuntimeTarget["pricedBy"];
	freeRule?: ResolvedRuntimeTarget["freeRule"];
	targetId: string;
	runtimeId: string;
	endpointKey: string | null;
	wireModelId: string;
	headers?: Record<string, string>;
	apiKey?: string;
}

async function resolveCompactionModel(
	settings: ClioSettings,
	providers: ProvidersContract,
	signal?: AbortSignal,
): Promise<CompactionResolution | null> {
	const override = settings.context.compaction.model;
	let targetId = settings.chat.target;
	let wireModelId = settings.chat.model;
	if (override !== undefined && override !== null) {
		let selected: ReturnType<typeof resolveModelReference>;
		try {
			selected = resolveModelReference(override, providers, { use: "chat" });
		} catch {
			throw new Error("context.compaction.model is an invalid pattern; set a unique target/model reference");
		}
		if (!selected.ref || selected.warning) {
			throw new Error(
				"context.compaction.model must match exactly one chat-eligible configured model; set a unique target/model reference on a loaded HTTP target with chat enabled",
			);
		}
		targetId = selected.ref.target;
		wireModelId = selected.ref.model;
	}
	if (!targetId || !wireModelId) return null;
	await prepareBackgroundModelMetadata(providers, targetId, signal);
	const status = providers.list().find((entry) => entry.target.id === targetId);
	if (!status?.available) {
		throw new Error("context.compaction.model target is unavailable; check the selected target with clio-coder targets");
	}
	const resolved = resolveRuntimeTarget(providers, {
		targetId,
		wireModelId,
		use: "orchestrator",
		requestedThinkingLevel: "off",
		requireTools: false,
		requireStreaming: true,
	});
	if (!resolved.ok) {
		// Configured identifiers and provider diagnostics can contain terminal controls.
		// Keep the failure actionable without echoing arbitrary provider/config text.
		throw new Error("context.compaction.model cannot run as a summarizer; select an available HTTP chat model");
	}
	const route = resolved.target;
	let model: EngineModel;
	try {
		model = route.runtime.synthesizeModel(
			route.target,
			route.wireModelId,
			providers.knowledgeBase?.lookup(route.wireModelId, route.runtime.id) ?? null,
		);
	} catch {
		throw new Error("context.compaction.model could not be prepared; check the selected target/model configuration");
	}
	const refined = refineRuntimeTargetWithModelHints(route, model, providers.knowledgeBase);
	applyModelCapabilityPatch(model, refined.capabilities);
	const sideAuth = await resolveSideCallAuth(
		providers.auth,
		route.target,
		route.runtime,
		LOCAL_API_KEY_FALLBACK,
		signal,
	);
	if (targetRequiresAuth(route.target, route.runtime) && !sideAuth.apiKey) {
		throw new Error(
			"context.compaction.model authentication is unavailable; authenticate the selected target with clio-coder auth",
		);
	}
	return {
		model,
		...pricingBasisFields(route),
		targetId: route.targetId,
		runtimeId: route.runtime.id,
		wireModelId: route.wireModelId,
		endpointKey: modelEndpointKey(route.target, route.wireModelId),
		...sideAuth,
		...(route.target.auth?.headers ? { headers: route.target.auth.headers } : {}),
	};
}

/** What a compaction needs of telemetry: its session's journal. */
export type CompactionTelemetry = Pick<TelemetryContract, "acquireTelemetrySession">;

export async function runCompactionFlow(
	replay: CompactionReplay,
	session: SessionContract,
	settings: ClioSettings,
	providers: ProvidersContract,
	instructions?: string,
	trigger?: CompactionTrigger,
	telemetry?: CompactionTelemetry,
	budget?: CompactionFlowBudget,
	summarize?: CompactInput["summarize"],
	admission?: CompactionFlowAdmission & { summaryAdmitted?: boolean },
): Promise<CompactResult | null> {
	const meta = session.current();
	if (!meta) {
		throw new Error("no current session to compact; start one with /new or /resume first");
	}
	const activeLeafTurnId = session.leafId(meta.id) ?? undefined;
	const isOriginCurrent = () =>
		session.current()?.id === meta.id && (session.leafId(meta.id) ?? undefined) === activeLeafTurnId;
	const entries = withProviderCheckpointMeasurements(filterEntriesToActivePath(session.readEntries(), activeLeafTurnId));
	if (entries.length === 0) return null;
	// Keep this owner alive through checkpoint publication, after individual streams close (#434).
	const lease = await telemetry?.acquireTelemetrySession?.(meta, { role: "compaction", id: meta.id });
	const callIds = new Set<string>();
	const closure: EventPayload<"compaction.settled"> = { callIds: [], outcome: "failed", checkpointTurnId: null };
	try {
		// Folded over the full applicable ledger before this compaction cuts it, so
		// the carry written below reflects every durable transition, including ones
		// older than the cut. Resolved once and used for three things: the payload
		// the summary carries, the note's one-time price on both sides of the
		// before/after comparison, and nothing else. Inspection never executes the
		// action it proposes.
		const continuity = resolveContinuityProjection({
			entries,
			sessionId: meta.id,
			...(meta.parentSessionId && meta.parentTurnId
				? { fork: { parentSessionId: meta.parentSessionId, parentTurnId: meta.parentTurnId } }
				: {}),
		});
		// Only this session's own validated fold is carried forward. An inherited
		// note is recall: writing it into this session's summary would republish
		// another branch's transaction under this one's compaction.
		const continuityNote = {
			tokens: continuityProjectionTokens(continuity),
			anchorTurnId: continuity.noteAnchorTurnId,
		};
		budget?.signal?.throwIfAborted();
		const systemPrompt = await readCompactionSystemPrompt(settings.context.compaction.systemPrompt, meta.cwd);
		budget?.signal?.throwIfAborted();
		const resolved = await resolveCompactionModel(settings, providers, budget?.signal);
		budget?.signal?.throwIfAborted();
		if (!resolved) {
			throw new Error("no model configured; set chat.target + chat.model");
		}
		// Summarize only the active branch: after a /tree switch the raw file
		// still holds abandoned sibling turns, and a summary that folds them in
		// would persist abandoned content back into the active context. The full
		// file read stays in place for protected artifacts and the masking
		// rewrite, which are session-global. The task board is not: it used to
		// read the full file too (last taskLedger entry in file order, with no
		// branch filter at all), which was a second, independent instance of this
		// same bug. See the taskBoard wiring below for the fix.
		if (!isOriginCurrent()) throw new Error("compaction session or branch changed before summarization");
		const calls: CompactionCallObservation[] = [];
		// A compaction summary is a full streamed request against its resolved target.
		// The whole transcript goes to it, so the session's restrictions decide first.
		const flowViolation = admission?.admitFlow?.({
			targetId: resolved.targetId,
			runtimeId: resolved.runtimeId,
			wireModelId: resolved.wireModelId,
		});

		// Hold the same canonical endpoint slot as an ordinary turn, /btw round, or
		// pre-warm so dispatch admission and background memory see its real usage.
		const releaseEndpointSlot = resolved.endpointKey === null ? () => {} : registerForegroundStream(resolved.endpointKey);
		const { providerCompaction, ...compactionBudget } = budget ?? {};
		const nativeEnabled =
			settings.context.compaction.provider === "native" &&
			!settings.context.compaction.model &&
			resolved.runtimeId === "openai-codex";
		let nativeAdmission: Promise<void> | undefined;
		const admitSummary = async (hold: AdmissionHold): Promise<void> => {
			if (admission?.summaryAdmitted) return;
			await budget?.beforeSummaryCall?.(hold);
			if (pricesCalls(resolved.pricedBy)) {
				await admission?.scheduling?.admitPaidRequest?.({
					waitForRaise: admission.headless !== true,
					...(admission.getCeilingUsd ? { getCeilingUsd: admission.getCeilingUsd } : {}),
					// The ceiling held this summary call, so its admission stage reads as a budget wait (#424, #434).
					onBlocked: () => {
						hold.waitedOn = "budget";
					},
					...(budget?.signal ? { signal: budget.signal } : {}),
				});
			}
		};

		let result: CompactResult;
		try {
			result = await compact({
				...(telemetry?.acquireTelemetrySession
					? {
							telemetry: {
								origin: meta,
								acquire: telemetry.acquireTelemetrySession,
								role: "compaction",
								targetId: resolved.targetId,
								runtimeId: resolved.runtimeId,
								...pricingBasisFields(resolved),
								onSettled: (facts) => {
									callIds.add(facts.callId);
								},
							},
						}
					: {}),
				entries,
				cwd: meta.cwd,
				offerMemory: (slice, ordinary, projected) => {
					const scope = admission?.memory?.observationStatus().scope;
					if (!scope) return null;
					// Units come from the raw ledger slice, the material the batches were
					// prepared from; an uncovered unit is serialized from the projected
					// entries so it costs what the ordinary summary would have paid for it.
					return (
						admission?.memory?.offerCompaction({
							source: { ...scope, checkpoint: observationCheckpoint(entries), units: observationSourceUnits(slice) },
							ordinary,
							serialize: (refs) => serializeConversation(projected.filter((entry) => refs.includes(entry.turnId))),
						}) ?? null
					);
				},
				continuityNote,
				...compactionBudget,
				...(nativeEnabled && providerCompaction ? { providerCompaction } : {}),
				...(nativeEnabled ? { providerCheckpointSource: { sessionId: meta.id, archive: sessionPaths(meta).current } } : {}),
				...(settings.context.compaction.provider === "native" && !nativeEnabled
					? { providerFallbackReason: "non-codex-or-compaction-override" }
					: {}),
				// Native rejection and its portable retry share one transaction admission (#423).
				beforeSummaryCall: (hold) => {
					if (flowViolation !== undefined && flowViolation !== null) throw new Error(`compaction refused: ${flowViolation}`);
					if (!nativeEnabled || !providerCompaction) return admitSummary(hold);
					nativeAdmission ??= admitSummary(hold);
					return nativeAdmission;
				},
				...(summarize ? { summarize } : {}),
				onCall: (call) => calls.push(call),
				model: resolved.model,
				...(systemPrompt !== undefined ? { systemPrompt } : {}),
				...(resolved.headers !== undefined ? { headers: resolved.headers } : {}),
				...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
				...(resolved.refreshApiKey ? { refreshApiKey: resolved.refreshApiKey } : {}),
				...(instructions !== undefined ? { instructions } : {}),
			});
		} finally {
			releaseEndpointSlot();
		}
		if (budget?.signal?.aborted) {
			budget.signal.throwIfAborted();
		}
		if (!isOriginCurrent()) {
			throw new Error("compaction session or branch changed; summary discarded and originating usage retained");
		}
		if (result.messagesSummarized === 0 || result.summary.length === 0) {
			closure.outcome = "discarded";
			if (calls.length > 0)
				throw new Error("compaction returned no summary; reported usage retained without a checkpoint");
			// The empty result carries why nothing was summarized, which the
			// operation's conclusion names (#422).
			return result;
		}
		if (result.usage) {
			result.usage = { ...result.usage, targetId: resolved.targetId, modelId: resolved.wireModelId };
		}

		// Refold before publishing the carry. The projection above was resolved
		// before prompt loading, route resolution and the summary stream, and a
		// transition appended during any of those awaits leaves the message leaf
		// untouched, so the origin check just above passes while the carry in hand
		// still says `ready`. §3 requires the summary to embed the *current*
		// validated fold, so the ledger is re-read and refolded here. Only the carry
		// is re-derived: `result` indexes the entry array the cut was computed
		// against, which must not move under it.
		const settledContinuity = resolveContinuityProjection({
			entries: filterEntriesToActivePath(session.readEntries(), activeLeafTurnId),
			sessionId: meta.id,
			...(meta.parentSessionId && meta.parentTurnId
				? { fork: { parentSessionId: meta.parentSessionId, parentTurnId: meta.parentTurnId } }
				: {}),
		});
		// A suppressed projection publishes no authoritative carry: the adapter marks
		// its own fold unvalidated, and `continuityPayloadFromFold` refuses one.
		const continuityCarry =
			settledContinuity.current === null ? null : continuityPayloadFromFold(settledContinuity.current);

		if (result.usage)
			result.usage = {
				...result.usage,
				targetId: resolved.targetId,
				modelId: resolved.wireModelId,
			};
		const entry: Omit<CompactionSummaryEntry, "timestamp"> = {
			kind: "compactionSummary",
			...(result.callIds === undefined ? {} : { callIds: result.callIds }),
			turnId: randomUUID(),
			parentTurnId: result.checkpointParentTurnId ?? result.firstKeptTurnId ?? null,
			summary: result.summary,
			...(result.providerCheckpoint ? { providerCheckpoint: result.providerCheckpoint } : {}),
			...(result.providerFallbackReason ? { providerFallbackReason: result.providerFallbackReason } : {}),
			...(result.skillContext ? { skillContext: result.skillContext } : {}),
			...(result.userContext ? { userContext: result.userContext } : {}),
			...(result.memoryReceipt ? { memoryReceipt: result.memoryReceipt } : {}),
			tokensBefore: result.tokensBefore,
			firstKeptTurnId: result.firstKeptTurnId ?? "",
			messagesSummarized: result.messagesSummarized,
			isSplitTurn: result.isSplitTurn,
			// The latest validated fold, carried so the transaction survives the cut
			// that is about to remove its earlier records from replay. It preserves
			// the immutable identity, accepted note, original policy and commit; it
			// never manufactures a commit and never turns an eviction-only outcome
			// into a summarized one. A later ordinary compaction with no handoff of
			// its own still carries the newest validated payload forward, which is
			// what keeps an eviction-only commit's state alive across summary cycles.
			...(continuityCarry === null ? {} : { continuity: continuityCarry }),
			// The summarization call is a real model call. Persisting its provider
			// usage on the entry is what puts it in front of `/usage` and `clio-coder usage
			// report`, which folded the ledger and so counted every call but this one.
			...(result.usage !== undefined ? { usage: result.usage } : {}),
		};
		const replayTokens = (history: ReadonlyArray<SessionEntry>): number =>
			estimateAgentContextBreakdown({
				messages: replay(session, history, activeLeafTurnId).map((message) => {
					const checkpoint = providerCheckpointFromMessage(message);
					if (!checkpoint || checkpoint.replayInputTokens === undefined) return message;
					// Replay input includes the static prefix and tail. Only native output
					// prices the opaque contribution on this message-only basis (#422).
					const { replayInputTokens: _inclusive, ...contribution } = checkpoint;
					return { ...message, clioProviderCheckpoint: contribution };
				}),
			}).messageTokens;
		// Raw rows include already summarized or evicted bodies. Price both live
		// projections without stale provider usage anchors before publishing (#422).
		// An unusable native handle is removed by destination replay before the cut (#422).
		const comparisonEntries = budget?.providerReplayFallback
			? entries.filter((entry) => entry.kind !== "compactionSummary" || !entry.providerCheckpoint)
			: entries;
		const replayBefore = replayTokens(comparisonEntries);
		const replayAfter = replayTokens([...comparisonEntries, { ...entry, timestamp: new Date().toISOString() }]);
		if (replayAfter >= replayBefore) {
			closure.outcome = "discarded";
			return { ...result, noGain: true };
		}
		// Preserve an inclusive provider anchor's unchanged prefix when no runtime
		// figures are available, applying only the current replay's reduction (#422).
		entry.tokensBefore = Math.max(result.tokensBefore, replayBefore);
		entry.tokensAfter = entry.tokensBefore + replayAfter - replayBefore;
		if (budget?.checkpointTokenFigures) {
			const figures = budget.checkpointTokenFigures(entry);
			entry.tokensBefore = figures.tokensBefore;
			entry.tokensAfter = figures.tokensAfter;
		}
		if (budget?.checkpointForSummary) {
			entry.continuity = budget.checkpointForSummary(entry.turnId, entry.tokensBefore, entry.tokensAfter ?? 0);
		}
		if (trigger !== undefined) entry.trigger = trigger;
		// No asynchronous work may separate private publication from the owned ledger append (#423).
		if (budget?.signal?.aborted) {
			budget.signal.throwIfAborted();
		}
		if (!isOriginCurrent()) {
			throw new Error("compaction ownership changed before publication");
		}
		try {
			result.publishProviderCheckpoint?.();
		} catch {
			budget?.signal?.throwIfAborted();
			const { providerCompaction: _native, ...portableBudget } = budget ?? {};
			return runCompactionFlow(
				replay,
				session,
				settings,
				providers,
				instructions,
				trigger,
				telemetry,
				{ ...portableBudget, providerFallbackReason: "checkpoint-publication-failed" },
				summarize,
				{ ...admission, summaryAdmitted: true },
			);
		}
		closure.checkpointTurnId = entry.turnId;
		closure.outcome = "unresolved";
		try {
			session.appendEntry(entry);
		} catch (error) {
			// A write may have reached the ledger before its caller threw. Reconcile
			// this exact checkpoint identity before choosing a second accounting store.
			try {
				if (!compactionCheckpointWasWritten(sessionPaths(meta).current, entry.turnId)) {
					closure.outcome = "failed";
					if (result.providerCheckpoint) pruneProviderCheckpoints(result.providerCheckpoint);
				} else closure.outcome = "committed";
			} catch (recordingError) {
				throw new AggregateError(
					[error, recordingError],
					"compaction checkpoint persistence is unresolved; usage was not duplicated",
				);
			}
			throw error;
		}
		session.flushAppends?.();
		closure.outcome = "committed";
		return result;
	} finally {
		if (lease && callIds.size > 0)
			telemetryHub().emit("compaction.settled", { ...closure, callIds: [...callIds] }, lease.context);
		await lease?.release();
	}
}

function compactionCheckpointWasWritten(path: string, turnId: string): boolean {
	let malformed = false;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (
				entry &&
				typeof entry === "object" &&
				"turnId" in entry &&
				entry.turnId === turnId &&
				"kind" in entry &&
				entry.kind === "compactionSummary"
			)
				return true;
		} catch {
			malformed = true;
		}
	}
	if (malformed) throw new Error("cannot prove checkpoint absence in a malformed session ledger");
	return false;
}
