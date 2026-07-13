import { join } from "node:path";
import chalk from "chalk";
import { modelBootstrapGenerate, resolveBootstrapScoutRoute } from "../cli/bootstrap-generate.js";
import { runHeadlessMainAgent } from "../cli/modes/print.js";
import { BusChannels } from "../core/bus-events.js";
import { installBusTracer } from "../core/bus-trace.js";
import { type ClioSettings, readSettings, type SettingsMutator, updateSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { expandInlineFileReferencesAsync } from "../core/file-references.js";
import { configureGuardrails } from "../core/guardrails.js";
import { rememberRecentModel } from "../core/recent-models.js";
import { protectedResidencyModelIds } from "../core/residency-protection.js";
import {
	applyOverrides,
	applyRoutingPatch,
	applySessionRouting,
	diffRouting,
	getAtPath,
	isRoutingPath,
	mergeRoutingPatchIntoSettings,
	type RoutingPatch,
	restoreRoutingFields,
	routingChangeNotices,
	routingPatchForId,
	type SessionOverrides,
	seedSessionRouting,
	setAtPath,
} from "../core/session-routing.js";
import { getSharedBus } from "../core/shared-bus.js";
import { isSkillActivation } from "../core/skill-activation.js";
import { StartupTimer } from "../core/startup-timer.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { clioCacheDir, clioDataDir, clioStateDir } from "../core/xdg.js";
import { renderAgentCatalogSectionsFromSpecs } from "../domains/agents/catalog.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { type ContextContract, createContextDomainModule } from "../domains/context/index.js";
import { bootstrapInputFromInitOptions } from "../domains/context/init-options.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { createDispatchDedupRegistration } from "../domains/dispatch/dedup.js";
import { readGateDecisionArtifacts, readPendingGateDecisions } from "../domains/dispatch/gate-decisions.js";
import { createDispatchDomainModule } from "../domains/dispatch/index.js";
import { type ExtensionsContract, ExtensionsDomainModule } from "../domains/extensions/index.js";
import { ensureClioState, LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import {
	buildMemoryPromptSection,
	canonicalMemoryRepositoryIdentity,
	loadMemoryRecordsSync,
	TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
	type TaskMemoryModelClient,
} from "../domains/memory/index.js";
import { TaskMemoryBank } from "../domains/memory/task-bank.js";
import {
	createDetachedDispatchNudgeRegistration,
	createReadOnlyExplorationNudgeRegistration,
	openDetachedBatchViews,
} from "../domains/middleware/dispatch-nudge.js";
import {
	createHookReceiptLog,
	createMiddlewareToolChoiceControl,
	createSkillsReminderRegistration,
	type ExtensionHookRoot,
	installUserHooks,
	type MiddlewareContract,
	MiddlewareDomainModule,
	writeMiddlewareDiagnosticToStderr,
} from "../domains/middleware/index.js";
import { createMemoryInterventionRegistration } from "../domains/middleware/memory-intervention.js";
import { createTaskBoardReminderRegistration } from "../domains/middleware/task-board-reminder.js";
import { createTaskNudgeRegistration } from "../domains/middleware/task-nudge.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import type { ProvidersContract, TargetDescriptor, ThinkingLevel } from "../domains/providers/index.js";
import {
	applyModelCapabilityPatch,
	firstRuntimeResolutionError,
	isOrchestratorEligibleRuntime,
	ProvidersDomainModule,
	refineRuntimeTargetWithModelHints,
	resolveModelCapabilities,
	resolveModelRuntimeCapabilitiesForProviders,
	resolveRuntimeTarget,
	targetRequiresAuth,
	VALID_THINKING_LEVELS,
} from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import { createResourcesDomainModule, modelVisibleSkills, type ResourcesContract } from "../domains/resources/index.js";
import { DEFAULT_RECENT_ENTRY_LIMIT } from "../domains/safety/finish-contract.js";
import { createFinishContractRegistration } from "../domains/safety/finish-contract-registration.js";
import type { AutonomyLevel, SafetyContract } from "../domains/safety/index.js";
import { parseRigorOverride, resolveRigor, SafetyDomainModule } from "../domains/safety/index.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
import {
	createProtectedArtifactsRegistration,
	type ProtectedArtifactProtectEvent,
} from "../domains/safety/protected-artifacts-registration.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { type CompactResult, compact } from "../domains/session/compaction/compact.js";
import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import { ceilChars, estimateAgentContextTokens } from "../domains/session/context-accounting.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import type { CompactionSummaryEntry, CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { SessionDomainModule } from "../domains/session/index.js";
import {
	clearPendingProtectedArtifact,
	reconcilePendingProtectedArtifacts,
	stagePendingProtectedArtifact,
} from "../domains/session/protected-artifact-journal.js";
import {
	protectedArtifactEntryFromArtifact,
	protectedArtifactStateFromSessionEntries,
} from "../domains/session/protected-artifacts.js";
import { createTaskBoardStore } from "../domains/session/task-board.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import { type ShareContract, ShareDomainModule } from "../domains/share/index.js";
import { serveClioAcpAgent } from "../engine/acp/server.js";
import {
	type AcpJsonRpcPeerTransport,
	createStdioServerTransport,
	type StdioServerTransportOptions,
} from "../engine/acp/transport.js";
import { completeEngineText } from "../engine/ai.js";
import { setProtectedModelsProvider } from "../engine/apis/residency.js";
import {
	createLoopGuardRegistration,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	readOrchTurnToolCallBudget,
} from "../engine/loop-guard.js";
import { openSession, readSessionTailTurns } from "../engine/session.js";
import type { ImageContent, Model } from "../engine/types.js";
import { createChatLoop } from "../interactive/chat-loop.js";
import { buildReplayAgentMessagesFromTurns } from "../interactive/chat-renderer.js";
import { type RunIo, startInteractive } from "../interactive/index.js";
import {
	detectPlatformKeybindingWarnings,
	detectTerminalKeySupport,
	formatInvalidKeybindingNotice,
	formatPlatformKeybindingNotice,
	validateKeybindings,
} from "../interactive/keybinding-manager.js";
import { subscribeLoopGuardStop } from "../interactive/loop-guard-interrupt.js";
import { createToolProseRegistration } from "../interactive/tool-prose-registration.js";
import { type AskUserHandler, cancelledAskUserResult } from "../tools/ask-user.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { isGitRepository, recoverCleanupReadyCompeteGroups } from "../tools/compete-worktrees.js";
import { coalescePathSink, createFileMutationObserver, createSkillActivationObserver } from "../tools/observers.js";
import { createRegistry } from "../tools/registry.js";

export interface BootResult {
	exitCode: number;
	bootTimeMs: number;
}

export interface HeadlessSamplingOverrides {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	repeatPenalty?: number;
}

export interface BootOptions {
	/** Process-lifetime API key override applied to the active orchestrator target. */
	apiKey?: string;
	/** Suppress CLIO.md project-context injection for this run. */
	noContextFiles?: boolean;
	noSkills?: boolean;
	skillPaths?: ReadonlyArray<string>;
	/** Run one non-interactive main-agent turn. */
	headless?: {
		prompt: string;
		images?: ReadonlyArray<ImageContent>;
		workingContextPaths?: ReadonlyArray<string>;
		mode?: "text" | "json";
		jsonEvents?: "full" | "terminal";
		target?: string;
		model?: string;
		thinking?: ThinkingLevel;
		autonomy?: AutonomyLevel;
		sampling?: HeadlessSamplingOverrides;
		noSkills?: boolean;
		skillPaths?: ReadonlyArray<string>;
		steerChannel?: string;
	};
	/** Serve Clio as an Agent Client Protocol v1 agent over JSON-RPC stdio. */
	acp?: {
		transport?: AcpJsonRpcPeerTransport;
		transportOptions?: StdioServerTransportOptions;
	};
}

function buildBanner(): string {
	const { clio } = getVersionInfo();
	return `
  ${chalk.cyan("Clio Coder")}
  ${chalk.dim(`v${clio} · CLIO: Context Layer for I/O · HPC & scientific software · ready`)}
`;
}

function printJsonSessionHeader(meta: SessionMeta | null): Record<string, unknown> | null {
	if (!meta) return null;
	return {
		type: "session",
		version: meta.sessionFormatVersion ?? 1,
		id: meta.id,
		timestamp: meta.createdAt,
		cwd: meta.cwd,
		target: meta.target,
		model: meta.model,
		clioVersion: meta.clioVersion,
	};
}

function applyHeadlessSettingsOverlay(
	settings: ClioSettings,
	overrides: BootOptions["headless"] | undefined,
): ClioSettings {
	const next = structuredClone(settings);
	if (!overrides) return next;
	const previousTarget = next.orchestrator.target;
	if (overrides.target !== undefined) {
		next.orchestrator.target = overrides.target;
		if (overrides.model === undefined && (previousTarget !== overrides.target || !next.orchestrator.model)) {
			const target = next.targets.find((entry) => entry.id === overrides.target);
			if (target) next.orchestrator.model = target.defaultModel ?? null;
		}
	}
	if (overrides.model !== undefined) next.orchestrator.model = overrides.model;
	if (overrides.thinking !== undefined) next.orchestrator.thinkingLevel = overrides.thinking;
	if (overrides.autonomy !== undefined) next.autonomy = overrides.autonomy;
	return next;
}

interface CompactionResolution {
	model: Model<never>;
	targetId: string;
	apiKey?: string;
}

function resolveTarget(providers: ProvidersContract, targetId: string | null | undefined): TargetDescriptor | null {
	if (!targetId) return null;
	return providers.getTarget(targetId);
}

export function advanceThinkingLevel(current: ThinkingLevel, available: ReadonlyArray<ThinkingLevel>): ThinkingLevel {
	const levels = available.length > 0 ? available : VALID_THINKING_LEVELS;
	if (!levels.includes(current)) return levels[0] ?? "off";
	const normalized = current;
	const idx = levels.indexOf(normalized);
	return levels[(idx + 1) % levels.length] ?? "off";
}

async function resolveApiKeyForTarget(
	target: TargetDescriptor,
	providers: ProvidersContract,
): Promise<string | undefined> {
	const runtime = providers.getRuntime(target.runtime);
	if (!runtime) return undefined;
	if (!targetRequiresAuth(target, runtime)) return undefined;
	const resolved = await providers.auth.resolveForTarget(target, runtime);
	return resolved.apiKey;
}

const LOCAL_BACKGROUND_API_KEY_FALLBACK = "clio-local-target";

function createBackgroundMemoryModelClient(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): TaskMemoryModelClient | null {
	const targetId = settings.background.target?.trim();
	const wireModelId = settings.background.model?.trim();
	if (!targetId || !wireModelId) return null;
	const resolved = resolveRuntimeTarget(providers, {
		targetId,
		wireModelId,
		requestedThinkingLevel: settings.background.thinkingLevel,
		use: "orchestrator",
		requireTools: false,
		requireOutputBudget: true,
	});
	if (!resolved.ok) {
		const detail = firstRuntimeResolutionError(resolved.diagnostics) ?? "background target resolution failed";
		throw new Error(detail);
	}
	const kbHit = providers.knowledgeBase?.lookup(resolved.target.wireModelId) ?? null;
	const model = resolved.target.runtime.synthesizeModel(
		resolved.target.target,
		resolved.target.wireModelId,
		kbHit,
	) as unknown as Model<never>;
	const refined = refineRuntimeTargetWithModelHints(resolved.target, model, providers.knowledgeBase);
	applyModelCapabilityPatch(model, refined.capabilities);
	return {
		async complete(request) {
			const apiKey = targetRequiresAuth(refined.target, refined.runtime)
				? (await providers.auth.resolveForTarget(refined.target, refined.runtime)).apiKey
				: LOCAL_BACKGROUND_API_KEY_FALLBACK;
			return completeEngineText({
				model,
				systemPrompt: request.systemPrompt,
				userPrompt: request.userPrompt,
				maxTokens: request.maxTokens,
				thinkingLevel: refined.effectiveThinkingLevel,
				signal: request.signal,
				timeoutMs: TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
				...(apiKey === undefined ? {} : { apiKey }),
			});
		},
	};
}

export function synthesizeOrchestratorModel(
	providers: ProvidersContract,
	target: TargetDescriptor,
	wireModelId: string,
): Model<never> | null {
	const runtime = providers.getRuntime(target.runtime);
	if (!runtime) return null;
	let model: Model<never>;
	try {
		const kbHit = providers.knowledgeBase?.lookup(wireModelId) ?? null;
		model = runtime.synthesizeModel(target, wireModelId, kbHit) as unknown as Model<never>;
	} catch {
		return null;
	}
	try {
		const status = providers.list().find((entry) => entry.target.id === target.id);
		if (status) {
			const caps = resolveModelCapabilities(status, wireModelId, providers.knowledgeBase, {
				detectedReasoning: providers.getDetectedReasoning(target.id, wireModelId),
			});
			applyModelCapabilityPatch(model, caps);
		}
	} catch {
		// Older test doubles and degraded provider bundles may not expose live
		// status. The synthesized model still carries runtime and catalog caps.
	}
	return model;
}

async function resolveCompactionModel(
	settings: ClioSettings,
	providers: ProvidersContract,
): Promise<CompactionResolution | null> {
	const targetId = settings.orchestrator?.target ?? null;
	const wireModelId = settings.orchestrator?.model ?? null;
	if (!targetId || !wireModelId) return null;
	const target = resolveTarget(providers, targetId);
	if (!target) return null;
	const model = synthesizeOrchestratorModel(providers, target, wireModelId);
	if (!model) return null;
	const apiKey = await resolveApiKeyForTarget(target, providers);
	const resolution: CompactionResolution = { model, targetId };
	if (apiKey !== undefined) resolution.apiKey = apiKey;
	return resolution;
}

function readSessionEntriesForCompact(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns());
}

/**
 * The finish-contract only inspects the window since the last user message
 * (`recentEntries`, capped at 80), so it reads a bounded tail of the ledger
 * instead of parsing the whole file every turn_end. 160 = twice the 80-entry cap
 * leaves ample margin above any entries appended after the assistant turn, so the
 * assessed window is byte-identical to the whole-file read (see the
 * behaviour-equivalence contract test) while cost stays bounded by session
 * *shape*, not session *length*.
 */
const FINISH_CONTRACT_TAIL_ENTRIES = DEFAULT_RECENT_ENTRY_LIMIT * 2;

function readRecentSessionEntriesForContract(sessionId: string): SessionEntry[] {
	return collectSessionEntries(readSessionTailTurns(sessionId, FINISH_CONTRACT_TAIL_ENTRIES).entries);
}

function protectedArtifactStateForCurrentSession(
	session: SessionContract,
): ReturnType<typeof protectedArtifactStateFromSessionEntries> {
	const meta = session.current();
	if (!meta) return { artifacts: [] };
	reconcilePendingProtectedArtifacts(session);
	return protectedArtifactStateFromSessionEntries(readSessionEntriesForCompact(meta.id));
}

function appendProtectedArtifactRegistryEvent(
	session: SessionContract | undefined,
	event: ProtectedArtifactProtectEvent,
): void {
	const current = session?.current();
	if (session === undefined || current === null || current === undefined) {
		throw new Error("no active session is available for protected artifact persistence");
	}
	const pending = stagePendingProtectedArtifact(current.id, event);
	session.appendEntry(
		protectedArtifactEntryFromArtifact(event.artifact, {
			parentTurnId: event.turnId ?? null,
			toolName: event.toolName,
			...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
			...(event.runId !== undefined ? { runId: event.runId } : {}),
			...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
		}),
	);
	if (session.flushAppends === undefined) {
		throw new Error("session does not expose the durable append flush required by protected artifact persistence");
	}
	session.flushAppends();
	clearPendingProtectedArtifact(pending);
}

function appendSkillActivationRegistryEvent(
	session: SessionContract | undefined,
	activation: Parameters<SessionContract["recordSkillActivation"]>[0],
): void {
	if (!session?.current()) return;
	try {
		session.recordSkillActivation(activation);
	} catch {
		// Activation metadata should never alter the result of a completed
		// context(scope=skills) call. Missing ledger data is visible in diagnostics.
	}
}

async function runCompactionFlow(
	session: SessionContract,
	settings: ClioSettings,
	providers: ProvidersContract,
	instructions?: string,
	trigger?: CompactionTrigger,
): Promise<CompactResult | null> {
	const meta = session.current();
	if (!meta) {
		throw new Error("no current session to compact; start one with /new or /resume first");
	}
	const resolved = await resolveCompactionModel(settings, providers);
	if (!resolved) {
		throw new Error("no model configured; set orchestrator.target + orchestrator.model");
	}
	// Summarize only the active branch: after a /tree switch the raw file
	// still holds abandoned sibling turns, and a summary that folds them in
	// would persist abandoned content back into the active context. The full
	// file read stays in place for the task board, protected artifacts, and
	// the masking rewrite, which are session-global.
	const entries = filterEntriesToActivePath(readSessionEntriesForCompact(meta.id));
	if (entries.length === 0) return null;

	const result = await compact({
		entries,
		model: resolved.model,
		...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
		...(instructions !== undefined ? { instructions } : {}),
	});
	if (result.messagesSummarized === 0 || result.summary.length === 0) return null;

	const entry: Omit<CompactionSummaryEntry, "turnId" | "timestamp"> = {
		kind: "compactionSummary",
		parentTurnId: result.firstKeptTurnId ?? null,
		summary: result.summary,
		tokensBefore: result.tokensBefore,
		firstKeptTurnId: result.firstKeptTurnId ?? "",
		messagesSummarized: result.messagesSummarized,
		isSplitTurn: result.isSplitTurn,
		tokensAfter: estimateTokensAfterCompaction(entries, result),
	};
	if (trigger !== undefined) entry.trigger = trigger;
	session.appendEntry(entry);
	return result;
}

/**
 * Compose the production chat-loop compaction callback. Errors intentionally
 * propagate: the chat loop owns activity failure reporting and distinguishes
 * a thrown read/model/persistence failure from the legitimate null no-op that
 * `runCompactionFlow` returns for an empty session or an unavailable cut.
 */
export function createProductionAutoCompact(
	session: SessionContract,
	getSettings: () => ClioSettings,
	providers: ProvidersContract,
): (instructions?: string, trigger?: CompactionTrigger) => Promise<CompactResult | null> {
	return (instructions, trigger) => runCompactionFlow(session, getSettings(), providers, instructions, trigger);
}

function estimateTokensFromSummary(summary: string): number {
	// Mirrors the rough byte/4 heuristic the rest of the compaction stack
	// uses for unmeasured payloads. Kept inline because this is the only
	// caller; pi-mono's token estimator is provider-specific and we do not
	// have a model handle at the persistence layer.
	return Math.max(1, ceilChars(summary.length));
}

function estimateTokensAfterCompaction(entries: ReadonlyArray<SessionEntry>, result: CompactResult): number {
	const synthetic: CompactionSummaryEntry = {
		kind: "compactionSummary",
		turnId: "__pending_compaction__",
		parentTurnId: result.firstKeptTurnId ?? null,
		timestamp: new Date(0).toISOString(),
		summary: result.summary,
		tokensBefore: result.tokensBefore,
		firstKeptTurnId: result.firstKeptTurnId ?? "",
		messagesSummarized: result.messagesSummarized,
		isSplitTurn: result.isSplitTurn,
		tokensAfter: estimateTokensFromSummary(result.summary),
	};
	const messages = buildReplayAgentMessagesFromTurns([...entries, synthetic]);
	const tokens = estimateAgentContextTokens({ messages });
	return tokens > 0 ? tokens : estimateTokensFromSummary(result.summary);
}

/**
 * Alt+J / Alt+K step the orchestrator through the `scope` list of target
 * ids or target/model refs. Absent scope is a no-op so unconfigured users
 * feel nothing.
 */
export function advanceScopedTarget(
	settings: Readonly<ClioSettings>,
	direction: "forward" | "backward",
): { target: string; model: string | null } | null {
	const scope = settings.scope ?? [];
	if (scope.length === 0) return null;
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const filteredScope = scope.filter((entry) => {
		const [targetId] = entry.split("/");
		const target = settings.targets.find((e) => e.id === targetId);
		if (!target) return false;
		const runtime = registry.get(target.runtime);
		return runtime !== null && isOrchestratorEligibleRuntime(runtime);
	});
	if (filteredScope.length === 0) return null;
	const activeTarget = settings.orchestrator.target ?? "";
	const activeModel = settings.orchestrator.model ?? "";
	const activeCombinedRef = activeTarget.length > 0 && activeModel.length > 0 ? `${activeTarget}/${activeModel}` : "";
	const idx = filteredScope.findIndex((entry) => entry === activeCombinedRef || entry === activeTarget);
	const base = idx === -1 ? 0 : idx + (direction === "forward" ? 1 : filteredScope.length - 1);
	const next = filteredScope[base % filteredScope.length];
	if (!next) return null;
	const [targetId, ...modelParts] = next.split("/");
	if (!targetId) return null;
	if (modelParts.length > 0) {
		return { target: targetId, model: modelParts.join("/") };
	}
	if (activeTarget === targetId) {
		return { target: targetId, model: activeModel || null };
	}
	const descriptor = settings.targets.find((entry) => entry.id === targetId);
	return { target: targetId, model: descriptor?.defaultModel ?? null };
}

export async function bootOrchestrator(options: BootOptions = {}): Promise<BootResult> {
	const timer = new StartupTimer();
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	installBusTracer();
	termination.installSignalHandlers();

	ensureClioState();
	timer.mark("install check");

	// A hard-killed coordinator cannot run domain drains. Reconcile its compete
	// process leases before dispatch startup scans the ledger, so abandoned rows
	// observe dead workers and no stale worktree can be reused by this boot.
	if (isGitRepository(process.cwd())) {
		try {
			const pendingGate = readPendingGateDecisions();
			const pendingCompeteGroups = new Set<string>();
			for (const handle of pendingGate.records) {
				if (handle.record.kind === "output" && handle.record.topology === "compete") {
					pendingCompeteGroups.add(handle.record.group);
				} else if (handle.record.kind === "decision" && handle.record.decision.topology === "compete") {
					pendingCompeteGroups.add(handle.record.decision.group);
				}
			}
			const durableDecisions = readGateDecisionArtifacts();
			const confirmedGroups = new Set(
				durableDecisions
					.filter(
						({ artifact }) =>
							artifact.topology === "compete" &&
							(artifact.outcome === "operator-confirmed" || artifact.outcome === "full-auto-applied"),
					)
					.map(({ artifact }) => artifact.group),
			);
			for (const { artifact } of durableDecisions) {
				if (artifact.topology === "compete" && artifact.outcome === "winner" && !confirmedGroups.has(artifact.group)) {
					pendingCompeteGroups.add(artifact.group);
				}
			}
			const recovery = recoverCleanupReadyCompeteGroups(process.cwd(), {
				preserveActiveGroups: pendingCompeteGroups,
				preserveAllActive: pendingGate.errors.length > 0,
			});
			for (const failure of recovery.failed) {
				process.stderr.write(`[dispatch] compete recovery preserved ${failure.group}: ${failure.message}\n`);
			}
		} catch (err) {
			process.stderr.write(
				`[dispatch] compete recovery failed closed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}

	let effectiveSettingsForDispatch: (() => Readonly<ClioSettings>) | null = null;
	let protectedArtifactStateForDispatch: (() => ProtectedArtifactState) | null = null;

	const result = await loadDomains([
		ConfigDomainModule,
		ExtensionsDomainModule,
		createResourcesDomainModule({
			skills: () => ({
				disableDiscovery: options.noSkills === true || options.headless?.noSkills === true,
				...(options.skillPaths && options.skillPaths.length > 0
					? { explicitSkillPaths: options.skillPaths }
					: options.headless?.skillPaths && options.headless.skillPaths.length > 0
						? { explicitSkillPaths: options.headless.skillPaths }
						: {}),
			}),
		}),
		ShareDomainModule,
		createContextDomainModule({ noContextFiles: options.noContextFiles === true }),
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({
			noContextFiles: options.noContextFiles === true,
		}),
		AgentsDomainModule,
		MiddlewareDomainModule,
		SessionDomainModule,
		ObservabilityDomainModule,
		SchedulingDomainModule,
		// Dispatch resolves worker targets through the session's effective
		// settings view once it exists (assigned below, after the config
		// contract loads); until then it falls back to the shared snapshot.
		createDispatchDomainModule({
			getSettings: () => effectiveSettingsForDispatch?.(),
			getProtectedArtifactState: () => protectedArtifactStateForDispatch?.() ?? { artifacts: [] },
			autonomyOverride: options.headless?.autonomy !== undefined,
		}),
		LifecycleDomainModule,
	]);
	timer.mark(`domains loaded (${result.loaded.length})`);

	const dispatch = result.getContract<DispatchContract>("dispatch");
	if (dispatch) {
		termination.onDrain(async () => {
			await dispatch.drain();
		});
	}
	termination.onPersist(async () => {
		await result.stop();
	});

	bus.emit(BusChannels.SessionStart, { at: Date.now() });
	timer.mark("session_start fired");

	const acpMode = options.acp !== undefined;
	const interactive = !options.headless && !acpMode && process.env.CLIO_INTERACTIVE === "1";
	if (!interactive && !options.headless && !acpMode) {
		process.stdout.write(buildBanner());
		if (process.env.CLIO_TIMING === "1") process.stdout.write(`${timer.report()}\n`);
	}

	const config = result.getContract<ConfigContract>("config");
	const providers = result.getContract<ProvidersContract>("providers");
	timer.mark("providers resolved");

	if (options.apiKey) {
		if (!providers) {
			process.stderr.write("Clio Coder: --api-key supplied but providers domain unavailable; ignoring.\n");
		} else {
			const settingsNow = applyHeadlessSettingsOverlay(config?.get() ?? readSettings(), options.headless);
			const activeTargetId = settingsNow.orchestrator?.target;
			const target = resolveTarget(providers, activeTargetId);
			const runtime = target ? providers.getRuntime(target.runtime) : null;
			if (target && runtime) {
				providers.auth.setRuntimeOverrideForTarget(target, runtime, options.apiKey);
			} else {
				process.stderr.write("Clio Coder: --api-key supplied but no active orchestrator target is configured; ignoring.\n");
			}
		}
	}

	if (!interactive && !options.headless && !acpMode) {
		process.stdout.write(`${chalk.dim("  (non-interactive boot. pass CLIO_INTERACTIVE=1 to launch the TUI.)")}\n`);
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	const middleware = result.getContract<MiddlewareContract>("middleware");
	const observability = result.getContract<ObservabilityContract>("observability");
	const safety = result.getContract<SafetyContract>("safety");
	const session = result.getContract<SessionContract>("session");
	const prompts = result.getContract<PromptsContract>("prompts");
	const agents = result.getContract<AgentsContract>("agents");
	const resources = result.getContract<ResourcesContract>("resources");
	const extensions = result.getContract<ExtensionsContract>("extensions");
	const share = result.getContract<ShareContract>("share");
	const contextDomain = result.getContract<ContextContract>("context");
	const initialNotices = interactive ? [...(contextDomain?.startupHints() ?? [])] : [];
	if (!providers || !dispatch || !observability || !safety || !middleware) {
		process.stderr.write(
			"Clio Coder: chat mode requires safety + middleware + providers + dispatch + observability contracts; aborting.\n",
		);
		await termination.shutdown(1);
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
	}

	const resumeId = process.env.CLIO_RESUME_SESSION_ID?.trim();
	if (resumeId && session) {
		try {
			session.resume(resumeId);
		} catch (err) {
			process.stderr.write(
				`Clio Coder: failed to resume session ${resumeId}: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}
	Reflect.deleteProperty(process.env, "CLIO_RESUME_SESSION_ID");

	// Hook diagnostics ride the typed bus. The domain loader constructed the
	// bundle with the stderr default; swap in a sink that publishes
	// middleware.hookFailed (the interactive warn notice consumes it) and keep
	// stderr for non-interactive runs, which have no notice subscriber.
	middleware.setDiagnosticSink((diagnostic) => {
		bus.emit(BusChannels.MiddlewareHookFailed, {
			kind: diagnostic.kind,
			registrationId: diagnostic.registrationId,
			hook: diagnostic.hook,
			at: Date.now(),
			...(diagnostic.kind === "hook_failed"
				? { message: diagnostic.message }
				: {
						elapsedMs: diagnostic.elapsedMs,
						budgetMs: diagnostic.budgetMs,
						steadyStateWarn: diagnostic.steadyStateWarn,
						p50Ms: diagnostic.stats.p50Ms,
						p95Ms: diagnostic.stats.p95Ms,
						overCount: diagnostic.stats.overCount,
						windowSamples: diagnostic.stats.window,
					}),
		});
		if (!interactive) writeMiddlewareDiagnosticToStderr(diagnostic);
	});

	// Residency and runtime notices (model swaps, double residency, VRAM
	// stress) reach the operator through the interactive notice renderer; a
	// headless run has no subscriber, so mirror them to stderr there. Silent
	// model swaps are exactly the failure mode the residency policy forbids.
	if (!interactive) {
		bus.on(BusChannels.RuntimeNotice, (payload: unknown) => {
			const notice = payload as { level?: string; message?: string } | undefined;
			if (typeof notice?.message !== "string") return;
			process.stderr.write(`[clio:runtime] ${notice.level ?? "info"}: ${notice.message}\n`);
		});
	}

	// Guardrail policy (tool-call budgets, tool byte caps, dispatch ledger cap)
	// resolves settings-first with env as emergency override; install the
	// settings section before any guard registration or tool reads it.
	configureGuardrails((config?.get() ?? readSettings()).guardrails);

	// Guard registrations on the middleware contract, in order: loop guard,
	// protected artifacts (last among guards so it absorbs protect_path effects
	// from everything before it), dispatch dedup. Workers register their own
	// loop guard and protected-artifacts instances inside their subprocess in
	// worker-runtime.ts; the orchestrator instances carry the bus and the
	// session persistence sink.
	middleware.registerHook(
		createLoopGuardRegistration({
			safety,
			bus,
			turnBlockBudget: INTERACTIVE_LOOP_BLOCK_BUDGET,
			turnToolCallBudget: readOrchTurnToolCallBudget(),
			// Interactive/headless/ACP all share this orchestrator guard: at the
			// block budget, lock tools for the rest of the turn so the model
			// answers from what it gathered instead of hard-cancelling a turn that
			// may already hold the answer. The bounded backstop still cancels a
			// model that keeps calling tools.
			turnSynthesisLockout: true,
		}),
	);
	let initialProtectedArtifactState: ProtectedArtifactState | undefined;
	let initialProtectionReadError: string | null = null;
	if (session) {
		try {
			initialProtectedArtifactState = protectedArtifactStateForCurrentSession(session);
		} catch (error) {
			initialProtectionReadError = error instanceof Error ? error.message : String(error);
		}
	}
	const protectedArtifactsGuard = createProtectedArtifactsRegistration({
		...(initialProtectedArtifactState !== undefined ? { initialState: initialProtectedArtifactState } : {}),
		onProtect: (event) => appendProtectedArtifactRegistryEvent(session, event),
		onDurabilityFailure: (health) => {
			bus.emit(BusChannels.MiddlewareHookFailed, {
				kind: "hook_failed",
				registrationId: "guard.protected-artifacts",
				hook: "before_tool",
				at: Date.now(),
				message: health.reason,
			});
		},
	});
	if (initialProtectionReadError !== null) {
		protectedArtifactsGuard.markDegraded(
			`initial session protection history could not be read: ${initialProtectionReadError}`,
		);
	}
	protectedArtifactStateForDispatch = () => {
		const health = protectedArtifactsGuard.health();
		if (health.kind === "degraded") {
			throw new Error(`dispatch: protected artifact durability degraded: ${health.reason}`);
		}
		return protectedArtifactsGuard.state();
	};
	middleware.registerHook(protectedArtifactsGuard);
	middleware.registerHook(createDispatchDedupRegistration());
	// Observers run after the guards; they emit no effects and their sinks are
	// best-effort (session ledger, codewiki refresh).
	middleware.registerHook(
		createSkillActivationObserver((activation) => appendSkillActivationRegistryEvent(session, activation)),
	);
	// First-turn skills reminder: user-message-visible text is the one channel
	// the battery-tested local models act on; suggestion protocol only, the
	// operator load gate is untouched.
	if (resources) {
		middleware.registerHook(
			createSkillsReminderRegistration({
				countModelVisibleSkills: () => modelVisibleSkills(resources.skills(process.cwd()).items).length,
			}),
		);
	}
	// Task-board reminder: same user-message-visible channel, fired once per
	// session when a request literally enumerates three or more steps. The
	// static routing line and tasks hint ask for the same board; battery-tested
	// local models only comply when the instruction rides the user message.
	middleware.registerHook(createTaskBoardReminderRegistration());
	const taskMemoryBank = new TaskMemoryBank();
	middleware.registerHook(
		createMemoryInterventionRegistration({
			bank: taskMemoryBank,
			getModelClient: () => {
				const settings = effectiveSettingsForDispatch?.();
				return settings === undefined ? null : createBackgroundMemoryModelClient(providers, settings);
			},
		}),
	);
	if (contextDomain) {
		middleware.registerHook(
			createFileMutationObserver(coalescePathSink((paths) => contextDomain.noteFileChanges(paths))),
		);
	}
	// User-defined hooks: extensions and the project (.clio/hooks.yaml,
	// .clio/hooks.local.yaml) declare a conservative, receipted hook set on the
	// same effect machinery. They register after the guards, so safety stays
	// authoritative: a hook may add effects (including request block_tool) but
	// cannot grant a permission safety would deny. Loading is best-effort.
	const hookReceiptLog = createHookReceiptLog({ persistPath: join(clioStateDir(), "hook-receipts.json") });
	const extensionHookRoots: ExtensionHookRoot[] = (extensions?.list(process.cwd()) ?? [])
		.filter((ext) => ext.enabled && ext.effective)
		.map((ext) => ({ id: ext.id, rootPath: ext.rootPath }));
	const userHooks = installUserHooks({
		cwd: process.cwd(),
		extensions: extensionHookRoots,
		registerHook: (registration) => middleware.registerHook(registration),
		recordReceipt: (receipt) => hookReceiptLog.record(receipt),
	});
	if (!interactive) {
		for (const issue of userHooks.fileIssues) {
			process.stderr.write(`[clio:hooks] ${issue.message}\n`);
		}
		for (const issue of userHooks.issues) {
			process.stderr.write(`[clio:hooks] ${issue.source.sourcePath}#${issue.index}: ${issue.issues.join("; ")}\n`);
		}
	}
	termination.onDrain(() => hookReceiptLog.flush());
	// Autonomy is hot-reloaded for interactive and headless admissions. ACP
	// server prompts use the snapshot captured at session/new.
	let activeAcpSessionAutonomy: AutonomyLevel | null = null;
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	const toolRegistry = createRegistry({
		safety,
		middleware,
		onMiddlewareEffects: (effects) => middlewareToolChoice.apply(effects),
		autonomy: () =>
			activeAcpSessionAutonomy ??
			effectiveSettingsForDispatch?.().autonomy ??
			options.headless?.autonomy ??
			(config?.get() ?? readSettings()).autonomy ??
			"auto-edit",
	});
	const mainPermissionOrigin = acpMode ? "acp-server" : "main";
	toolRegistry.onPermissionRequired((call, decision, meta) => {
		bus.emit(BusChannels.PermissionRequested, {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			origin: mainPermissionOrigin,
			axis: meta.axis,
			...(decision.kind === "ask" ? { rejection: decision.rejection } : {}),
			...(decision.policy?.ruleId !== undefined ? { ruleId: decision.policy.ruleId } : {}),
			...(decision.policy?.policySource !== undefined ? { policySource: decision.policy.policySource } : {}),
			...(decision.policy?.reasonCode !== undefined ? { reasonCode: decision.policy.reasonCode } : {}),
		});
	});
	let askUserHandler: AskUserHandler | null = null;
	// ask_user is interactive-only by design: it is a human interview tool and
	// headless/ACP surfaces have no operator to interview, so the tool is not
	// registered there at all (documented in `clio run --help`). Skills that
	// interview fall back to their stated defaults when the tool is absent.
	const askUserBridge: AskUserHandler = async (questions, invokeOptions) =>
		askUserHandler ? await askUserHandler(questions, invokeOptions) : cancelledAskUserResult();
	// One task board per orchestrator: the tasks tool mutates it, the turn-end
	// open-tasks nudge reads it, and the footer/overlay render it. Keyed on the
	// current session id so resume/fork/new refolds it from taskLedger entries.
	const taskBoard = createTaskBoardStore({
		getSessionId: () => session?.current()?.id ?? null,
		readEntries: () => {
			const meta = session?.current();
			return meta ? readSessionEntriesForCompact(meta.id) : [];
		},
		appendEntry: (entry) => {
			session?.appendEntry(entry);
		},
	});
	// Link in-flight dispatch runs to the live board via the ledger's
	// activeRunIds field: a run is tracked from the moment its child process is
	// live until it finalizes either way. attach/detach are no-ops when no board
	// is declared, so an ambient dispatch never forces a board into existence.
	bus.on(BusChannels.DispatchStarted, (payload) => {
		if (typeof payload?.runId === "string") taskBoard.attachRun(payload.runId);
	});
	bus.on(BusChannels.DispatchCompleted, (payload) => {
		if (typeof payload?.runId !== "string") return;
		taskBoard.detachRun(payload.runId);
		// Fold worker skill activations from the completed run's receipt into
		// the session ledger, tagged with the runId, so worker skill provenance
		// sits next to main-agent activations. The orchestrator never observes
		// worker tool calls directly (separate subprocess registry), so this is
		// the only recording path and cannot double-record.
		for (const activation of payload.skillActivations ?? []) {
			if (!isSkillActivation(activation)) continue;
			appendSkillActivationRegistryEvent(session, { ...activation, runId: payload.runId });
		}
	});
	bus.on(BusChannels.DispatchFailed, (payload) => {
		if (typeof payload?.runId === "string") taskBoard.detachRun(payload.runId);
	});
	registerAllTools(toolRegistry, {
		...(session ? { session } : {}),
		taskBoard,
		dispatch,
		bus,
		...(interactive ? { askUser: askUserBridge } : {}),
		...(agents ? { getAgentCatalog: () => renderAgentCatalogSectionsFromSpecs(agents.listSpecs()).stable } : {}),
		// Same effective-autonomy resolution the registry admission uses, so plan
		// provenance and compete winner handling agree with the approval surface.
		getAutonomy: () =>
			activeAcpSessionAutonomy ??
			effectiveSettingsForDispatch?.().autonomy ??
			options.headless?.autonomy ??
			(config?.get() ?? readSettings()).autonomy ??
			"auto-edit",
		getCostCeilingUsd: () => result.getContract<SchedulingContract>("scheduling")?.ceilingUsd() ?? 0,
		getSkillLoaderOptions: () => ({
			trustProjectCompatRoots: config?.get().skills.trustProjectCompatRoots === true,
			disableDiscovery: options.noSkills === true || options.headless?.noSkills === true,
			...(options.skillPaths && options.skillPaths.length > 0
				? { explicitSkillPaths: options.skillPaths }
				: options.headless?.skillPaths && options.headless.skillPaths.length > 0
					? { explicitSkillPaths: options.headless.skillPaths }
					: {}),
		}),
	});

	// Live routing is owned by this process. Seed it once from saved settings
	// (with any headless CLI overrides baked in); from here on every consumer
	// reads the effective view — shared snapshot + session routing overlay — so
	// another process writing settings.yaml can update defaults and the
	// target catalog but never redirect this session's routing.
	const sessionRouting = seedSessionRouting(
		applyHeadlessSettingsOverlay(config?.get() ?? readSettings(), options.headless),
	);
	// Non-routing settings a session changed "for this session only" via the
	// /settings overlay. Layered under the routing overlay in the effective
	// view, so the live session reflects them immediately while settings.yaml
	// (the global default for new sessions) stays untouched until the operator
	// chooses to save globally.
	const sessionOverrides: SessionOverrides = new Map(
		options.headless?.autonomy === undefined ? [] : [["autonomy", options.headless.autonomy]],
	);
	const getCurrentSettings = (): ClioSettings => {
		// Recents live in the data dir (core/recent-models.ts), never in
		// settings.yaml; consumers that need them call listRecentModels
		// directly, so an Alt+L pick in another session does not churn the
		// config watcher here.
		return applySessionRouting(applyOverrides(config?.get() ?? readSettings(), sessionOverrides), sessionRouting);
	};
	effectiveSettingsForDispatch = getCurrentSettings;
	// Residency protection follows the live effective settings: the models the
	// operator's config references (orchestrator, worker default/profiles,
	// target defaults) may never be evicted by another Clio stream, and a
	// routing change updates the set on the next read.
	setProtectedModelsProvider(() => protectedResidencyModelIds(getCurrentSettings()));

	const validatedKeybindings = validateKeybindings((config?.get() ?? readSettings()).keybindings ?? {});
	const invalidBindings = validatedKeybindings.invalid;
	if (invalidBindings.length > 0) {
		const notice = formatInvalidKeybindingNotice(invalidBindings);
		if (interactive) initialNotices.push(notice);
		else process.stderr.write(notice);
	}
	const platformWarnings = process.stdin.isTTY
		? detectPlatformKeybindingWarnings(validatedKeybindings.valid, detectTerminalKeySupport(process.env))
		: [];
	if (platformWarnings.length > 0) {
		const notice = formatPlatformKeybindingNotice(platformWarnings);
		if (interactive) initialNotices.push(notice);
		else process.stderr.write(notice);
	}
	/**
	 * Locked read-modify-write of saved settings. Routes through the config
	 * contract (which refreshes its snapshot and dispatches change events) when
	 * available, else straight through core updateSettings. Either way the
	 * mutator runs against the freshest on-disk state under the advisory
	 * settings lock, so two processes saving defaults at the same time cannot
	 * interleave and drop each other's patches.
	 */
	const persistSavedMutation = (mutator: SettingsMutator): void => {
		if (config?.update) {
			config.update(mutator);
			return;
		}
		updateSettings(mutator);
	};
	/**
	 * Apply a routing change with one consistent scope: it takes effect in this
	 * session immediately and writes through to saved settings as the default
	 * for future sessions. Only the patched fields hit the file, so concurrent
	 * sessions cannot clobber each other's saved defaults wholesale.
	 */
	const updateSessionRouting = (patch: RoutingPatch, mutateSaved?: (saved: ClioSettings) => void): void => {
		applyRoutingPatch(sessionRouting, patch);
		persistSavedMutation((saved) => {
			mergeRoutingPatchIntoSettings(saved, patch);
			mutateSaved?.(saved);
		});
	};
	/**
	 * Persist a whole-settings blob coming from the effective view (the
	 * /settings overlay, favorites toggles). Routing edits in the blob are
	 * absorbed into the session state and written through; everything else is
	 * persisted without leaking this session's routing into the saved defaults.
	 */
	const applySettingsBlob = (next: ClioSettings): void => {
		const patch = diffRouting(getCurrentSettings(), next);
		if (patch) applyRoutingPatch(sessionRouting, patch);
		persistSavedMutation((fresh) => {
			const persisted = structuredClone(next);
			restoreRoutingFields(persisted, fresh);
			// A whole-blob write (providers, favorites) must not globalize a
			// session-only override: restore every overridden leaf from the
			// fresh file so it stays session-local until explicitly saved.
			for (const path of sessionOverrides.keys()) setAtPath(persisted, path, getAtPath(fresh, path));
			if (patch) mergeRoutingPatchIntoSettings(persisted, patch);
			return persisted;
		});
	};
	/**
	 * Commit a single /settings edit, keyed by its config-path id. `next` is the
	 * effective view with the one leaf already changed.
	 *   - scope "session": apply live only. Routing ids feed the routing state;
	 *     every other id becomes a session override. settings.yaml is untouched.
	 *   - scope "global": apply live and persist just that leaf as the new
	 *     default, clearing any prior session override for it.
	 * Restart-required ids (budget.concurrency, runtimePlugins) cannot apply
	 * live, so the overlay only offers "global" for them; the file write is what
	 * a later restart picks up.
	 */
	const commitSetting = (id: string, next: ClioSettings, scope: "session" | "global"): void => {
		if (isRoutingPath(id)) {
			// Build the patch from `next` keyed by the edited id, not by diffing
			// against the live view: a prior session-only apply already moved the
			// routing state, so a diff would be empty and the global save would
			// silently no-op. Only the touched fields are persisted, so concurrent
			// sessions never clobber each other's saved routing.
			const patch = routingPatchForId(id, next);
			if (!patch) return;
			applyRoutingPatch(sessionRouting, patch);
			if (scope === "global") persistSavedMutation((saved) => mergeRoutingPatchIntoSettings(saved, patch));
			return;
		}
		const value = getAtPath(next, id);
		if (scope === "session") {
			sessionOverrides.set(id, value);
			return;
		}
		sessionOverrides.delete(id);
		persistSavedMutation((saved) => setAtPath(saved, id, value));
	};
	/** Alt+J / Alt+K: step this session's orchestrator through the scope list. */
	const cycleScopedSession = (direction: "forward" | "backward"): void => {
		const next = advanceScopedTarget(getCurrentSettings(), direction);
		if (!next) return;
		updateSessionRouting({ orchestrator: { target: next.target, model: next.model } });
	};

	const readCurrentSessionEntries = (): ReadonlyArray<SessionEntry> => {
		if (session === undefined) return [];
		const meta = session.current();
		if (!meta) return [];
		reconcilePendingProtectedArtifacts(session);
		return readSessionEntriesForCompact(meta.id);
	};

	// turn_end assessors, fired by the chat-loop when the final assistant
	// message of a run lands. Tool-prose first so its hard-block interruption
	// precedes the finish-contract advisory in effect order.
	middleware.registerHook(createToolProseRegistration());
	middleware.registerHook(createTaskNudgeRegistration({ getBoard: () => taskBoard.snapshot() }));
	middleware.registerHook(createReadOnlyExplorationNudgeRegistration());
	middleware.registerHook(
		createDetachedDispatchNudgeRegistration({ getOpenBatches: () => openDetachedBatchViews(dispatch) }),
	);
	if (session) {
		middleware.registerHook(
			createFinishContractRegistration({
				// Tail-scoped: the contract only needs the last-user-message window, so
				// it parses a bounded ledger tail per turn_end rather than the whole
				// file (which grows unbounded with session length).
				readSessionEntries: () => {
					const meta = session.current();
					return meta ? readRecentSessionEntriesForContract(meta.id) : null;
				},
				resolveRigor: () => resolveRigor({ cwd: process.cwd(), override: parseRigorOverride(process.env.CLIO_RIGOR) }),
				recordDecision: (record) => safety.audit.recordCompletionContract?.(record),
			}),
		);
	}

	const chat = createChatLoop({
		getSettings: getCurrentSettings,
		providers,
		middleware,
		middlewareToolChoice,
		protectedArtifacts: {
			replace: (state) => protectedArtifactsGuard.replaceState(state),
			markDegraded: (reason) => protectedArtifactsGuard.markDegraded(reason),
		},
		knownTargets: () => new Set(providers.list().map((entry) => entry.target.id)),
		observability,
		bus,
		interactiveTui: interactive,
		...(prompts ? { prompts } : {}),
		...(session ? { session } : {}),
		getMemorySection: () => {
			try {
				const records = loadMemoryRecordsSync(clioDataDir());
				return buildMemoryPromptSection(records, {
					activeRepository: canonicalMemoryRepositoryIdentity(process.cwd()),
				}).section;
			} catch {
				return "";
			}
		},
		...(session
			? {
					readSessionEntries: readCurrentSessionEntries,
					autoCompact: createProductionAutoCompact(session, getCurrentSettings, providers),
				}
			: {}),
		toolRegistry,
	});

	if (options.acp) {
		// ACP-served sessions get the same routing isolation as interactive
		// ones, but ACP v1 has no channel for agent-initiated advisory text:
		// the session/update union (agent_message_chunk, agent_thought_chunk,
		// tool_call*, plan, …) carries turn content, and notifications outside
		// an active session/prompt would break strict clients (see the matching
		// note in src/engine/acp/server.ts). The external-divergence and
		// target-removed notices therefore go to the session ledger as `custom`
		// entries, where /resume and session tooling can surface them.
		// ACP is operatorless too: bound a runaway turn with the shared
		// interrupt->stop subscriber, the same way the headless path does.
		const unsubscribeAcpLoopGuardStop = subscribeLoopGuardStop(bus, chat);
		const unsubscribeAcpRoutingNotices = bus.on(BusChannels.ConfigNextTurn, (payload) => {
			const evt = payload as { diff?: { nextTurn?: string[] }; settings?: Readonly<ClioSettings> } | null | undefined;
			if (!evt?.settings || !Array.isArray(evt.diff?.nextTurn)) return;
			if (!session?.current()) return;
			const notices = routingChangeNotices(evt.diff.nextTurn, evt.settings, getCurrentSettings());
			for (const notice of notices) {
				try {
					session.appendEntry({
						kind: "custom",
						customType: "clio.routing-notice",
						parentTurnId: null,
						data: { kind: notice.kind, level: notice.level, text: notice.text },
					});
				} catch {
					// Advisory only; a ledger write failure must not affect the
					// ACP turn loop.
				}
			}
		});
		try {
			const transport = options.acp.transport ?? createStdioServerTransport(options.acp.transportOptions);
			const code = await serveClioAcpAgent({
				transport,
				chat,
				...(session ? { session } : {}),
				toolRegistry,
				bus,
				autonomy: () => getCurrentSettings().autonomy ?? "auto-edit",
				onActiveSessionAutonomyChange: (level) => {
					activeAcpSessionAutonomy = level;
				},
				cwd: process.cwd(),
				version: getVersionInfo().clio,
				permissionTimeoutMs: config?.get().delegation.defaults.permissionTimeoutMs ?? 120_000,
			});
			chat.dispose();
			await dispatch.drain();
			await result.stop();
			return { exitCode: code, bootTimeMs: timer.snapshot().totalMs };
		} finally {
			unsubscribeAcpRoutingNotices();
			unsubscribeAcpLoopGuardStop();
		}
	}

	if (options.headless) {
		// Operatorless: there is no TUI subscriber to turn a loop-guard interrupt
		// into a run stop, so a degenerate local model would spin until an
		// external timeout (each call blocked, the agent loop never aborted). Wire
		// the shared interrupt->stop subscriber so the run ends with the same
		// durable closing turn the interactive surface produces.
		const unsubscribeLoopGuardStop = subscribeLoopGuardStop(bus, chat);
		const headlessPermissionReason =
			"clio run cannot confirm permission requests; rerun interactively to approve this action.";
		const unsubscribeHeadlessPermission = toolRegistry.onPermissionRequired((call, decision, meta) => {
			bus.emit(BusChannels.PermissionResolved, {
				status: "denied",
				requestId: meta.requestId,
				origin: "main",
				decidedBy: "policy:no-operator",
				tool: call.tool,
				actionClass: decision.classification.actionClass,
				reason: headlessPermissionReason,
				requestedBy: "headless",
			});
			toolRegistry.cancelParkedCalls(headlessPermissionReason);
		});
		try {
			const parsedSkillRequest = resources?.parsePendingSkillRequests(options.headless.prompt, process.cwd(), {
				naturalLanguageTriggers: false,
			}) ?? { text: options.headless.prompt, pendingSkillRequests: [] };
			const promptExpansion = resources?.expandPromptTemplate(parsedSkillRequest.text, process.cwd());
			const fileExpansion = await expandInlineFileReferencesAsync(
				promptExpansion?.expanded ? promptExpansion.text : parsedSkillRequest.text,
				{
					cwd: process.cwd(),
					includeImages: true,
					missing: "leave",
				},
			);
			const images = [...(options.headless.images ?? []), ...fileExpansion.images];
			const workingContextPaths = [...(options.headless.workingContextPaths ?? []), ...fileExpansion.referencedPaths];
			const code = await runHeadlessMainAgent(chat, {
				prompt: fileExpansion.text,
				...(images.length > 0 ? { images } : {}),
				...(workingContextPaths.length > 0 ? { workingContextPaths } : {}),
				...(options.headless.sampling ? { sampling: options.headless.sampling } : {}),
				...(parsedSkillRequest.pendingSkillRequests.length > 0
					? { pendingSkillRequests: parsedSkillRequest.pendingSkillRequests }
					: {}),
				mode: options.headless.mode ?? "text",
				...(options.headless.jsonEvents ? { jsonEvents: options.headless.jsonEvents } : {}),
				...(options.headless.steerChannel ? { steerChannel: options.headless.steerChannel } : {}),
				getSessionHeader: () => printJsonSessionHeader(session?.current() ?? null),
			});
			await termination.shutdown(code);
			return { exitCode: code, bootTimeMs: timer.snapshot().totalMs };
		} finally {
			unsubscribeHeadlessPermission();
			unsubscribeLoopGuardStop();
		}
	}

	timer.mark("first TUI paint");
	await startInteractive({
		bus,
		providers,
		dispatch,
		...(agents ? { agents } : {}),
		observability,
		chat,
		...(initialNotices.length > 0 ? { initialNotices } : {}),
		...(resources ? { resources } : {}),
		...(extensions ? { extensions } : {}),
		...(share ? { share } : {}),
		toolRegistry,
		...(session ? { session } : {}),
		...(session ? { readSessionEntries: readCurrentSessionEntries } : {}),
		getTaskBoard: () => taskBoard.snapshot(),
		stateDir: clioStateDir(),
		dataDir: clioDataDir(),
		cacheDir: clioCacheDir(),
		registerAskUserHandler: (handler) => {
			askUserHandler = handler;
			return () => {
				if (askUserHandler === handler) askUserHandler = null;
			};
		},
		getSettings: getCurrentSettings,
		getFleetNodes: () => result.getContract<SchedulingContract>("scheduling")?.fleet?.list() ?? [],
		getWorkerDefault: () => {
			const workerDefault = getCurrentSettings().workers.default;
			const result: { target?: string; model?: string } = {};
			if (workerDefault.target) result.target = workerDefault.target;
			if (workerDefault.model) result.model = workerDefault.model;
			return result;
		},
		...(session ? { getSessionId: () => session.current()?.id ?? null } : {}),
		...(contextDomain
			? {
					getContextState: (cwd?: string) => contextDomain.contextState(cwd),
					onInit: async (
						options: {
							preview?: boolean;
							adopt?: boolean;
							applyClioMd?: boolean;
							rewriteClioMd?: boolean;
							proposeClioMd?: boolean;
							includeGlobalImports?: boolean;
							heuristic?: boolean;
						},
						runIo?: RunIo,
					) => {
						// Interactive context-init explores the repo with the configured target by
						// default, grounded in the freshly built codewiki, and falls back to the
						// deterministic heuristic when no target is reachable. --heuristic and
						// --preview skip model generation.
						const useModel = options.heuristic !== true && options.preview !== true;
						const bootstrapOptions = bootstrapInputFromInitOptions(options);
						await contextDomain.runBootstrap({
							cwd: process.cwd(),
							confirmGitignore: () => true,
							adopt: options.adopt === true,
							...bootstrapOptions,
							...(useModel
								? {
										generate: modelBootstrapGenerate({
											dispatch,
											resolveRoute: () => {
												if (!config) throw new Error("bootstrap Scout configuration unavailable");
												return resolveBootstrapScoutRoute(config.get());
											},
											onFallback: (err, mode) =>
												runIo?.stderr(
													`context init: Scout unavailable, using ${mode === "existing" ? "existing CLIO.md" : "heuristic"} (${err.message})\n`,
												),
										}),
										modelId: "configured-clio-target",
									}
								: {}),
						});
					},
					onContextClear: async (options: { all?: boolean; confirmed?: boolean; confirmedAll?: boolean }) => {
						await contextDomain.runContextClear({
							cwd: process.cwd(),
							all: options.all === true,
							io: {
								stdout: (s) => process.stdout.write(s),
								stderr: (s) => process.stderr.write(s),
							},
							confirmContext: () => options.confirmed === true,
							confirmAll: () => options.confirmedAll === true,
						});
					},
					onContextRefresh: async () => {
						await contextDomain.runContextRefresh({
							cwd: process.cwd(),
							io: {
								stdout: (s) => process.stdout.write(s),
								stderr: (s) => process.stderr.write(s),
							},
						});
					},
				}
			: {}),
		onSetThinkingLevel: (level) => {
			const current = getCurrentSettings();
			const nextLevel =
				resolveModelRuntimeCapabilitiesForProviders(
					providers,
					current.orchestrator.target,
					current.orchestrator.model,
					level,
				)?.thinking.effectiveLevel ?? "off";
			updateSessionRouting({ orchestrator: { thinkingLevel: nextLevel } });
		},
		onCycleThinking: () => {
			const current = getCurrentSettings();
			const thinking = resolveModelRuntimeCapabilitiesForProviders(
				providers,
				current.orchestrator.target,
				current.orchestrator.model,
				current.orchestrator.thinkingLevel ?? "off",
			)?.thinking;
			const effectiveAvailable = thinking?.supportedLevels ?? (["off"] as ThinkingLevel[]);
			const nextLevel = advanceThinkingLevel(
				thinking?.effectiveLevel ?? current.orchestrator.thinkingLevel ?? "off",
				effectiveAvailable,
			);
			updateSessionRouting({ orchestrator: { thinkingLevel: nextLevel } });
		},
		onSelectModel: ({ target, model }) => {
			const registry = getRuntimeRegistry();
			const settings = getCurrentSettings();
			const descriptor = settings.targets.find((e) => e.id === target);
			if (descriptor) {
				const runtime = registry.get(descriptor.runtime);
				if (!runtime) {
					throw new Error(
						`cannot use target '${target}' as orchestrator target because runtime '${descriptor.runtime}' is not registered`,
					);
				}
				if (!isOrchestratorEligibleRuntime(runtime)) {
					throw new Error(
						`cannot use target '${target}' as orchestrator target because runtime '${runtime.id}' is not an HTTP/native runtime`,
					);
				}
			}
			updateSessionRouting({ orchestrator: { target, model } });
			rememberRecentModel(`${target}/${model}`, getCurrentSettings().modelSelector.recentLimit);
		},
		onSetScope: (scope) => {
			updateSessionRouting({ scope: Array.from(scope) });
		},
		writeSettings: (next) => applySettingsBlob(next),
		commitSetting: (id, next, scope) => commitSetting(id, next, scope),
		...(session
			? {
					onResumeSession: (sessionId) => {
						try {
							session.resume(sessionId);
						} catch (err) {
							process.stderr.write(
								`[/resume] failed to resume ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
							);
						}
					},
					onNewSession: () => {
						session.create({ cwd: process.cwd() });
					},
					onForkSession: (parentTurnId) => {
						try {
							session.fork(parentTurnId);
						} catch (err) {
							process.stderr.write(
								`[/fork] failed at turn ${parentTurnId}: ${err instanceof Error ? err.message : String(err)}\n`,
							);
						}
					},
					onCompact: async (instructions) => {
						await chat.compact(instructions);
					},
				}
			: {}),
		onCycleScopedModelForward: () => cycleScopedSession("forward"),
		onCycleScopedModelBackward: () => cycleScopedSession("backward"),
		onShutdown: async () => {
			await termination.shutdown(0);
		},
	});
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}
