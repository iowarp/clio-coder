import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { modelBootstrapGenerate, resolveBootstrapRoute } from "../cli/bootstrap-generate.js";
import { runHeadlessMainAgent } from "../cli/modes/print.js";
import type { RunJsonMainSessionFrame } from "../cli/modes/run-json-schema.js";
import { RUN_JSON_SCHEMA_VERSION } from "../cli/modes/run-json-schema.js";
import { startRunOutput, writeRunDiagnostic } from "../cli/run-failure.js";
import { formatBootTrace } from "../core/boot-trace.js";
import { readClioVersionLabel } from "../core/build-info.js";
import { BusChannels, type PluginsReloadedPayload } from "../core/bus-events.js";
import { installBusTracer } from "../core/bus-trace.js";
import { classifyCallFailure } from "../core/call-failure.js";
import { codexAccountScope } from "../core/codex-account.js";
import { type ClioSettings, readSettings, type SettingsMutator, updateSettings } from "../core/config.js";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../core/defaults.js";
import { writeDiagnostic } from "../core/diagnostics.js";
import { loadDomains } from "../core/domain-loader.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { detectSupportedImageMimeType, expandInlineFileReferencesAsync } from "../core/file-references.js";
import { setCommitDecisionRefsProvider, setGitCommitAttributionEnabled } from "../core/git-commit-attribution.js";
import { configureGuardrails, guardrailValuesFromSettings } from "../core/guardrails.js";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../core/headless-permission.js";
import { installInternalGitPolicy } from "../core/internal-git.js";
import type { SideCallAuth } from "../core/oauth-retry.js";
import { flushPackageActivities, recordPackageActivity } from "../core/package-activity.js";
import { pruneProviderCheckpoints } from "../core/provider-checkpoint.js";
import { hostFramedTexts } from "../core/reminder-framing.js";
import { protectedResidencyModels } from "../core/residency-protection.js";
import { armRestartHandoff } from "../core/restart-handoff.js";
import { consumeRestartIntent } from "../core/restart-intent.js";
import { type RouteProvenance, resolveRouteProvenance } from "../core/route-provenance.js";
import {
	SAFE_EXEC_DEFAULT_KILL_GRACE_MS,
	SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS,
	SAFE_EXEC_PIPE_DRAIN_BOUND_MS,
} from "../core/safe-exec.js";
import { sandboxAvailability } from "../core/sandbox/availability.js";
import { sandboxEnvPolicy } from "../core/sandbox/env-scrub.js";
import { createGitHooksFingerprinter } from "../core/sandbox/git-hooks-fingerprint.js";
import { mainShellContained, yoloScriptSandboxState } from "../core/sandbox/main-session.js";
import {
	applyOverrides,
	applyRoutingPatch,
	applySessionRouting,
	commitRoutingPatch,
	createRoutingGestures,
	diffRouting,
	getAtPath,
	isRoutingPath,
	mergeRoutingPatchIntoSettings,
	planResumedRouting,
	type RoutingPatch,
	resolveMemoryRoute,
	restoreRoutingFields,
	routingChangeNotices,
	routingPatchForId,
	type SessionOverrides,
	seedSessionRouting,
	setAtPath,
} from "../core/session-routing.js";
import { settingsSourceFor, updateProjectLocalSettings } from "../core/settings-layers.js";
import { getSharedBus } from "../core/shared-bus.js";
import { isSkillActivation } from "../core/skill-activation.js";
import { StartupTimer } from "../core/startup-timer.js";
import { getTerminationCoordinator, resolveShutdownHookBudgetMs } from "../core/termination.js";
import { yieldToEventLoop } from "../core/timers.js";
import { ToolNames } from "../core/tool-names.js";
import { narrowTurnConstraints, templateToolConstraints, turnAllowsTool } from "../core/turn-constraints.js";
import { captureProjectSurface, projectSurfaceTrustNotice } from "../core/workspace-trust.js";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import { yoloRootRefusal } from "../core/yolo-host.js";
import { renderAgentCatalogSectionsFromSpecs } from "../domains/agents/catalog.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { AGENT_CATEGORY_PURPOSE, AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule, createConfigDomainModule } from "../domains/config/index.js";
import { CLIO_KEYBINDINGS, type ClioKeybinding } from "../domains/config/keybindings.js";
import type { ContextContract } from "../domains/context/contract.js";
import { bootstrapInputFromInitOptions } from "../domains/context/init-options.js";
import { createContextDomainModule } from "../domains/context/runtime.js";
import { runOperatorRecall } from "../domains/context/working-set/operator-recall.js";
import type { ReadRecallPort } from "../domains/context/working-set/reread.js";
import { createRereadRecallPort } from "../domains/context/working-set/reread.js";
import { endpointCapacityUsage } from "../domains/dispatch/capacity-lease.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { createDispatchDedupRegistration } from "../domains/dispatch/dedup.js";
import { agentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import { readGateDecisionArtifacts, readPendingGateDecisions } from "../domains/dispatch/gate-decisions.js";
import { scheduleSpeculativeHold } from "../domains/dispatch/held-workers.js";
import {
	compileFleetRunPreview,
	createDispatchDomainModule,
	executeFleetRun,
	fleetRouteResolver,
} from "../domains/dispatch/index.js";
import { configureRunEventJournal } from "../domains/dispatch/run-event-journal.js";
import { normalizeYoloGateOutcome } from "../domains/dispatch/yolo-ids.js";
import {
	createExtensionRuntimeHookBridge,
	type ExtensionsContract,
	ExtensionsDomainModule,
	isLoadableExtension,
} from "../domains/extensions/index.js";
import { type InteropContract, InteropDomainModule } from "../domains/interop/index.js";
import { describeUpgradeNotice, ensureClioState, takeUpgradeNotice } from "../domains/lifecycle/index.js";
import type { BackgroundRouteFacts } from "../domains/memory/background-budget.js";
import { decideBackgroundStep } from "../domains/memory/background-budget.js";
import { createHistoryReviewSource } from "../domains/memory/history-review.js";
import {
	buildDispatchMemorySection,
	canonicalMemoryRepositoryIdentity,
	completedLessonSource,
	createMemoryLessonJudge,
	createTaskMemoryTelemetrySink,
	createTaskMemoryTrace,
	loadMemoryRecordsSync,
	MemoryRuntime,
	memoryStatus,
	OBSERVATION_PROMPT,
	readTaskMemorySpendSummary,
	renderTaskMemoryHandoffSource,
	seedTaskMemoryFromNewestHandoff,
	type TaskMemoryModelClient,
	type TaskMemoryStepUsage,
	taskMemoryBankSize,
	taskMemoryHandoffSeedOffer,
	taskMemoryTracePath,
} from "../domains/memory/index.js";
import { createMemoryPromptReader } from "../domains/memory/prompt-cache.js";
import { createMemoryRelevance } from "../domains/memory/relevance-source.js";
import { readMemoryStoreSnapshot } from "../domains/memory/store.js";
import {
	deleteTaskBankSnapshot,
	loadTaskBankSnapshot,
	saveTaskBankSnapshot,
} from "../domains/memory/task-bank-store.js";
import type { TaskMemoryModelRequest } from "../domains/memory/task-memory-policy.js";
import {
	TaskMemoryBudgetSkipError,
	TaskMemoryEndpointBusyError,
	TaskMemoryInformationFlowBlockedError,
} from "../domains/memory/task-memory-policy.js";
import { createHistoryReviewActivity, projectTaskMemoryActivity } from "../domains/memory/task-memory-status.js";
import { createCapabilityGate } from "../domains/middleware/capability-gate.js";
import { createDecisionHintsRegistration } from "../domains/middleware/decision-hints.js";
import {
	createDetachedDispatchNudgeRegistration,
	createReadOnlyExplorationNudgeRegistration,
	createUnbackedWorkerClaimRegistration,
	finishedDetachedBatchIds,
	openDetachedBatchViews,
} from "../domains/middleware/dispatch-nudge.js";
import { createGuidanceRegistration } from "../domains/middleware/guidance.js";
import {
	createMarketplaceOfferRegistration,
	createMiddlewareToolChoiceControl,
	createSkillsReminderRegistration,
	formatRegistrationConflict,
	type MiddlewareContract,
	MiddlewareDomainModule,
	writeMiddlewareDiagnosticToStderr,
} from "../domains/middleware/index.js";
import type { MemoryGuardian, MemoryGuardianState } from "../domains/middleware/memory-guardian.js";
import { MEMORY_INTERVENTION_ACTIVITY_LIMIT } from "../domains/middleware/memory-intervention.js";
import { announceMemoryStepEndpoint } from "../domains/middleware/memory-step-endpoint.js";
import { createPlanCloseRegistration } from "../domains/middleware/plan-close.js";
import { createTaskBoardReminderRegistration } from "../domains/middleware/task-board-reminder.js";
import { createTaskNudgeRegistration } from "../domains/middleware/task-nudge.js";
import { createWatchdogRegistration } from "../domains/middleware/watchdog.js";
import type { MuxContract } from "../domains/mux/index.js";
import type { BackgroundMemoryUsageSink } from "../domains/observability/background-memory-usage.js";
import type { CallJournalOptions } from "../domains/observability/call-scope.js";
import { openCallScope } from "../domains/observability/call-scope.js";
import { recordFailedCompactionCalls } from "../domains/observability/compaction-usage.js";
import { aggregateCostEntries } from "../domains/observability/cost-rows.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import { committedPluginSnapshot, PluginsDomainModule, pluginSnapshotFor } from "../domains/plugins/index.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import { resolveEffectivePricing } from "../domains/providers/catalog.js";
import { credentialsPresent } from "../domains/providers/credentials.js";
import type { CostProvenance, ProvidersContract, TargetDescriptor, ThinkingLevel } from "../domains/providers/index.js";
import {
	AGENT_ROLE_TOOLS_REQUIRED_REASON,
	applyModelCapabilityPatch,
	backgroundMemoryAdmissionLimit,
	canonicalEndpointKey,
	createProvidersDomainModule,
	endpointThroughput,
	firstRuntimeResolutionError,
	isOrchestratorEligibleRuntime,
	modelEndpointKey,
	modelStreamUsage,
	normalizeCostProvenance,
	probeCapabilitiesForModel,
	recordEndpointThroughput,
	refineRuntimeTargetWithModelHints,
	registerForegroundStream,
	resolveEndpointCapacities,
	resolveModelCapabilities,
	resolveModelRuntimeCapabilitiesForProviders,
	resolveRuntimeTarget,
	supportsAgentRoleTools,
	targetRequiresAuth,
	VALID_THINKING_LEVELS,
} from "../domains/providers/index.js";
import { hasLiveModelCatalog, modelResidencyForStatus } from "../domains/providers/model-discovery.js";
import { memoryInterventionModelMaxTokens } from "../domains/providers/model-runtime-capabilities.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { resolveModelReference } from "../domains/providers/resolver.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import { resolveSideCallAuth } from "../domains/providers/side-call-auth.js";
import { createVisionSidecar } from "../domains/providers/vision-sidecar.js";
import {
	anthropicQuotaNotice,
	observedAnthropicQuota,
	observedCodexQuota,
	onAnthropicQuotaChange,
} from "../domains/quota/index.js";
import { observedQuota } from "../domains/quota/observed.js";
import { quotaProviderIdForRuntime } from "../domains/quota/registry.js";
import {
	createResourcesDomainModule,
	discoverMarketplaceSkills,
	installedSkillNames,
	installSkill,
	modelVisibleSkills,
	type ResourcesContract,
} from "../domains/resources/index.js";
import { expandSubmitText } from "../domains/resources/submit-expansion.js";
import { createCitationGroundingRegistration } from "../domains/safety/citation-grounding.js";
import { DEFAULT_RECENT_ENTRY_LIMIT } from "../domains/safety/finish-contract.js";
import { createFinishContractRegistration } from "../domains/safety/finish-contract-registration.js";
import { createGitHookDriftGuard, type GitHookDriftGuard, gitHookDriftNotice } from "../domains/safety/hook-drift.js";
import type { AutonomyLevel, FlowRestrictionSet, SafetyContract } from "../domains/safety/index.js";
import {
	EMPTY_INFORMATION_FLOW_POLICY,
	flowTransferRefusal,
	flowUnmediatedAgentRefusal,
	isFlowRestrictionSet,
	mergeFlowRestrictions,
	modelMayActivateSkills,
	parseRigorOverride,
	resolveModelDestination,
	resolveRigor,
	SafetyDomainModule,
} from "../domains/safety/index.js";
import { workerFlowPolicyInput } from "../domains/safety/information-flow.js";
import { createInternalGitPolicy } from "../domains/safety/internal-git-policy.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
import {
	createProtectedArtifactsRegistration,
	type ProtectedArtifactProtectEvent,
} from "../domains/safety/protected-artifacts-registration.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import type { SafetyJudgeSeat } from "../domains/safety/safety-judge.js";
import { createSessionCodeConsent } from "../domains/safety/session-code-consent.js";
import { createRunCostCap, runCostCeilingUsd } from "../domains/scheduling/budget.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import { createSchedulingDomainModule } from "../domains/scheduling/index.js";
import { serializeConversation } from "../domains/session/compaction/branch-summary.js";
import type { CompactionCallObservation } from "../domains/session/compaction/compact.js";
import { type CompactInput, type CompactResult, compact } from "../domains/session/compaction/compact.js";
import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import { estimateTokens } from "../domains/session/compaction/tokens.js";
import { ceilChars, estimateAgentContextTokens } from "../domains/session/context-accounting.js";
import { continuityPayloadFromFold } from "../domains/session/continuity/carry.js";
import { continuityProjectionTokens, resolveContinuityProjection } from "../domains/session/continuity/projection.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import { activeDecisionRefs, createDecisionBoardStore } from "../domains/session/decision-board.js";
import type { CompactionSummaryEntry, CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { withProviderCheckpointMeasurements } from "../domains/session/entries.js";
import { commitHandoff, type HandoffServiceDeps, prepareHandoff } from "../domains/session/handoff-service.js";
import {
	observationCheckpoint,
	observationSourceUnits,
	parseSessionEntries,
	SessionDomainModule,
} from "../domains/session/index.js";
import {
	clearPendingProtectedArtifact,
	reconcilePendingProtectedArtifacts,
	stagePendingProtectedArtifact,
} from "../domains/session/protected-artifact-journal.js";
import {
	protectedArtifactEntryFromArtifact,
	protectedArtifactStateFromSessionEntries,
} from "../domains/session/protected-artifacts.js";
import { sessionLedgersForRoots } from "../domains/session/related-ledgers.js";
import { resumedSessionRoute } from "../domains/session/resumed-route.js";
import { createTaskBoardStore } from "../domains/session/task-board.js";
import { appendSessionThinkingLevel } from "../domains/session/thinking-route.js";
import { writeTranscriptExport } from "../domains/session/transcript-export.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import { reseedSessionUsageFromLedger } from "../domains/session/usage-reseed.js";
import { latestUserImages } from "../domains/session/vision-images.js";
import { probeWorkspaceAsync } from "../domains/session/workspace/index.js";
import { archiveCommandHost, type ShareContract, ShareDomainModule } from "../domains/share/index.js";
import { capabilitySettings } from "../domains/system-one/capability-settings.js";
import type { LlmRequestAdmission, OneShotPort, SystemOneInstance } from "../domains/system-one/index.js";
import { createSystemOne } from "../domains/system-one/index.js";
import { createFollowUpTracker, observePermissionOutcomes } from "../domains/system-one/outcomes.js";
import { createRelevanceRanker } from "../domains/system-one/rank.js";
import { anchorSessionRows, createRecorder, SESSION_ROW_CUSTOM_TYPE } from "../domains/system-one/recorder/index.js";
import { TURN_SITE } from "../domains/system-one/sites/turn.js";
import type { TurnControlRecord } from "../domains/turn-control/index.js";
import type { UserTaskAcceptance } from "../domains/user-tasks/acceptance.js";
import { activeUserTaskAcceptance } from "../domains/user-tasks/active-acceptance.js";
import { createUserTasksStore } from "../domains/user-tasks/store.js";
import {
	createWorkspaceSnapshots,
	pruneWorkspaceSnapshots,
	workspaceSnapshotRepositoryPresent,
} from "../domains/workspace-snapshots/index.js";
import { type AcpHostReport, acpCommandControl } from "../engine/acp/commands.js";
import {
	bindBoardActions,
	createAcpInterviewChannel,
	createHostToolEvents,
	draftsToJudge,
	followWorkerRuns,
	judgeDraftsAtSite,
	oracleBriefingFromEntries,
	runHostDispatch,
} from "../engine/acp/host-members.js";
import {
	type AcpHandoffControl,
	type AcpSafeSettingsPatch,
	type AcpSafeSettingsSnapshot,
	serveClioAcpAgent,
} from "../engine/acp/server.js";
import { createStdioServerTransport } from "../engine/acp/transport.js";
import { completeEngineText, type EngineTextCompletionResult } from "../engine/ai.js";
import {
	declareRuntimeNoticeProducer,
	EXIT_RELEASE_MS,
	releaseClioLoadedModelsOnExit,
	setProtectedModelsProvider,
} from "../engine/apis/residency.js";
import {
	createLoopGuardRegistration,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	readOrchTurnToolCallBudget,
} from "../engine/loop-guard.js";
import { cwdHash, openSession, readSessionTailTurns, sessionCurrentPath, sessionPaths } from "../engine/session.js";
import type { EngineModel } from "../engine/types.js";
import type { RunIo } from "../interactive/index.js";
import { createChatLoop, createTurnControlRunner, runOutOfTurnRound } from "../session-control/chat-loop.js";
import { clampThinkingLevel, replayCurrentSession, resolvePermission, selectModel } from "../session-control/index.js";
import {
	buildModelReplayAgentMessagesFromTurns,
	continuityContextFromSession,
} from "../session-control/model-session-replay.js";
import { createTurnOutcomeCollector } from "../session-control/turn-outcome-collector.js";
import { effectiveToolNames } from "../tools/agent-tools.js";
import { surfaceSpecPlacement } from "../tools/surface.js";
import { resizeImage } from "../utils/image-resize.js";
import { prepareBackgroundModelMetadata } from "./background-model-metadata.js";
import type { BootOptions } from "./boot-options.js";
import { readCompactionSystemPrompt } from "./compaction-prompt.js";
import { createExtensionReloadCoordinator, extensionHookReceiptSink, hookReceiptLog } from "./extension-reload.js";
import { createFlowLedger, FLOW_RESTRICTION_ENTRY_TYPE } from "./flow-ledger.js";
import { createJobHost } from "./job-host.js";
import { bindSessionPackageActivity } from "./package-activity.js";
import { resolvePanesEnablement } from "./panes-activation.js";
import { reloadPluginResourcesAndNotify } from "./plugin-reload.js";
import { backgroundSlotKey, relevanceStartRefusal } from "./relevance-eligibility.js";
import { createReloadClasses } from "./reload-classes.js";
import { createSafetyJudgeCompletion, createSafetyJudgeHost } from "./safety-judge-host.js";
import { createDecisionUsageTally, createSystemOneHost, createSystemOneRequestAdmission } from "./system-one-host.js";
import { bindTaskMemoryLifecycle, captureTaskMemoryUsage } from "./task-memory-lifecycle.js";

export type { BootOptions, HeadlessSamplingOverrides } from "./boot-options.js";

import {
	boundKeyLabel,
	detectPlatformKeybindingWarnings,
	detectTerminalKeySupport,
	formatInvalidKeybindingNotice,
	formatPlatformKeybindingNotice,
	validateKeybindings,
} from "../interactive/keybinding-manager.js";
import type { BootInteractivity } from "../interactive/terminal-lease.js";
import { createToolProseRegistration } from "../interactive/tool-prose-registration.js";
import { subscribeLoopGuardStop } from "../session-control/loop-guard-interrupt.js";
import { BUILTIN_SLASH_COMMANDS } from "../session-control/slash-commands.js";
import { runWatchdogReview } from "../session-control/watchdog-run.js";
import { type AskUserHandler, cancelledAskUserResult } from "../tools/ask-user.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { isGitRepository, recoverCleanupReadyCompeteGroups } from "../tools/compete-worktrees.js";
import { createDispatchBackgroundRegistry } from "../tools/dispatch-background.js";
import { dispatchSchemaCompositionFor } from "../tools/dispatch-schema.js";
import { createFileMutationObserver, createSkillActivationObserver } from "../tools/observers.js";
import { createRegistry } from "../tools/registry.js";
import { sweepExpiredToolOffloads } from "../tools/result-shaping.js";
import { gitCheckoutRoot, recoverTaskWorktrees } from "../tools/task-worktree.js";
import { allowedWorktreeParents } from "../tools/worktree-root.js";

export interface BootResult {
	exitCode: number;
	bootTimeMs: number;
}

/**
 * The bannered boot is the whole of what a piped or CI invocation of bare
 * `clio` shows, so it is the entire first impression for a stranger who is not
 * on a TTY. It used to end in a hardcoded `ready`, a word with no relationship
 * to anything: a machine with no target configured at all printed it and
 * exited 0, which is the one state where the installation can do nothing.
 *
 * What the line reports now is the orchestrator target the settings actually
 * declare, and when none is declared it says so and names the command that
 * fixes it. The exit status stays 0 either way, because this path answers
 * "did Clio boot", which it did, and CI scripts already depend on that
 * answer; the readiness of the configuration is reported in words instead.
 */
function bannerConfigurationLine(): string {
	let settings: ClioSettings;
	try {
		settings = readSettings();
	} catch {
		return chalk.yellow("settings.yaml is not valid. Run `clio-coder doctor` for the exact keys.");
	}
	// A dangling chat target normalizes to null in the schema, so a deleted
	// target arrives here as no target at all rather than as a name to report.
	const targetId = settings.chat?.target;
	if (!targetId) {
		return chalk.yellow("no model target configured. Run `clio-coder configure` to add one.");
	}
	const model = settings.chat?.model;
	return chalk.dim(`target ${targetId}${model ? ` · model ${model}` : " · no default model"}`);
}

function buildBanner(): string {
	const clio = readClioVersionLabel();
	return `
  ${chalk.cyan("Clio Coder")}
  ${chalk.dim(`v${clio} · CLIO: Context Layer for I/O · HPC & scientific software`)}
  ${bannerConfigurationLine()}
`;
}

function printJsonSessionHeader(meta: SessionMeta | null): RunJsonMainSessionFrame | null {
	if (!meta) return null;
	return {
		type: "session",
		schemaVersion: RUN_JSON_SCHEMA_VERSION,
		mode: "main",
		version: meta.sessionFormatVersion ?? 1,
		id: meta.id,
		timestamp: meta.createdAt,
		cwd: meta.cwd,
		target: meta.target,
		model: meta.model,
		clioCoderVersion: meta.clioCoderVersion,
	};
}

function applyHeadlessSettingsOverlay(
	settings: ClioSettings,
	overrides: BootOptions["headless"] | undefined,
): ClioSettings {
	const next = structuredClone(settings);
	if (!overrides) return next;
	const previousTarget = next.chat.target;
	if (overrides.target !== undefined) {
		next.chat.target = overrides.target;
		if (overrides.model === undefined && (previousTarget !== overrides.target || !next.chat.model)) {
			const target = next.targets.find((entry) => entry.id === overrides.target);
			if (target) next.chat.model = target.defaultModel ?? null;
		}
	}
	if (overrides.model !== undefined) next.chat.model = overrides.model;
	if (overrides.thinking !== undefined) next.chat.thinkingLevel = overrides.thinking;
	if (overrides.autonomy !== undefined) next.safety.autonomy = overrides.autonomy;
	return next;
}

interface CompactionResolution extends SideCallAuth {
	model: EngineModel;
	costProvenance: CostProvenance;
	targetId: string;
	runtimeId: string;
	endpointKey: string | null;
	wireModelId: string;
	headers?: Record<string, string>;
	apiKey?: string;
}

function resolveTarget(providers: ProvidersContract, targetId: string | null | undefined): TargetDescriptor | null {
	if (!targetId) return null;
	return providers.getTarget(targetId);
}

/**
 * The routes a `clio-coder run --max-cost-usd` run can reach whose cost is
 * unknown: the chat route, the compaction route, the default worker route,
 * every fleet profile (recipe pins in `fleet.agentProfiles` and coordinator
 * profile picks resolve to one), every roster member, and each configured
 * target at its default model, which a coordinator pin naming only a target
 * takes. Paid-request admission checks only known or estimated pricing, so
 * the cap cannot bound these; LiteLLM stays unknown until its target declares
 * `pricing`. A model a coordinator names one-off is not known at boot.
 */
function unpricedRunRoutes(settings: Readonly<ClioSettings>, providers: ProvidersContract | undefined): string[] {
	if (!providers) return [];
	const routes: Array<{ target: string | null | undefined; model?: string | null | undefined }> = [
		settings.chat,
		settings.fleet.default,
		...Object.values(settings.fleet.profiles),
		...Object.values(settings.fleet.rosters).flatMap((roster) => roster.members),
		...settings.targets.map((target) => ({ target: target.id })),
	];
	const compaction = settings.context.compaction.model;
	if (compaction) {
		try {
			const selected = resolveModelReference(compaction, providers, { use: "chat" });
			if (selected.ref && !selected.warning) routes.push(selected.ref);
		} catch {
			// An invalid compaction pattern fails compaction itself with its own message.
		}
	}
	const unpriced = new Set<string>();
	for (const route of routes) {
		const target = resolveTarget(providers, route.target);
		const runtime = target ? providers.getRuntime(target.runtime) : null;
		const model = route.model ?? target?.defaultModel;
		if (!target || !runtime || !model) continue;
		if (resolveEffectivePricing(target, runtime, model).provenance === "unknown") unpriced.add(`${target.id}/${model}`);
	}
	return [...unpriced];
}

/**
 * Every attended dispatch path (the dispatch tool, slash commands, turn control)
 * receives this one contract, so the durable memory section headless `run`
 * builds is sealed here once rather than at each request builder. A request
 * that already carries a section keeps it; an unreadable store sends none.
 */
function withDispatchMemory(
	contract: DispatchContract | undefined,
	getSettings: () => Readonly<ClioSettings> | undefined,
): DispatchContract | undefined {
	if (contract === undefined) return undefined;
	const withMemory = (request: DispatchRequest): DispatchRequest => {
		if (request.memorySection !== undefined) return request;
		const settings = getSettings() ?? readSettings();
		let section = "";
		try {
			section = buildDispatchMemorySection({
				dataDir: clioDataDir(),
				cwd: process.cwd(),
				settings,
				route: {
					agentId: request.agentId,
					...(request.target !== undefined ? { target: request.target } : {}),
					...(request.workerProfile !== undefined ? { workerProfile: request.workerProfile } : {}),
					...(request.workerRuntime !== undefined ? { workerRuntime: request.workerRuntime } : {}),
				},
			});
		} catch {
			// Memory is advisory; a store that cannot be read must not block the dispatch.
		}
		return section.length > 0 ? { ...request, memorySection: section } : request;
	};
	return {
		...contract,
		dispatch: (request, observer, preparation) => contract.dispatch(withMemory(request), observer, preparation),
		dispatchBatch: (requests, preparation) => contract.dispatchBatch(requests.map(withMemory), preparation),
	};
}

function settingsTargetRuntime(settings: Readonly<ClioSettings>, targetId: string | null | undefined): string | null {
	if (!targetId) return null;
	return settings.targets.find((entry) => entry.id === targetId)?.runtime ?? null;
}

function advanceThinkingLevel(current: ThinkingLevel, available: ReadonlyArray<ThinkingLevel>): ThinkingLevel {
	const levels = available.length > 0 ? available : VALID_THINKING_LEVELS;
	if (!levels.includes(current)) return levels[0] ?? "off";
	const normalized = current;
	const idx = levels.indexOf(normalized);
	return levels[(idx + 1) % levels.length] ?? "off";
}

/**
 * pi-ai's openai-completions provider refuses to stream without an apiKey even
 * when the target is a local server that ignores the Authorization header
 * entirely. The chat loop, the dispatch workers, and the background memory
 * model all send this placeholder so a local llama.cpp or LM Studio endpoint
 * works without the user inventing a credential.
 */
const LOCAL_API_KEY_FALLBACK = "clio-coder-local-target";

/**
 * The background memory role, resolved to the endpoint it would call.
 *
 * The endpoint key joins the existing dispatch capacity evidence and local
 * request holds. A gateway key does not identify one physical model server or
 * imply a one-slot limit; the configured protocol owns downstream routing.
 */
interface BackgroundMemoryRoute {
	client: TaskMemoryModelClient;
	selection: "dedicated" | "chat-default" | "chat-fallback";
	fallbackReason?: string;
	targetId: string;
	wireModelId: string;
	endpointKey: string | null;
	modelMaxTokens(configuredMaxTokens: number): number;
}

/**
 * What the background budget reads beside the route itself. Settings are the
 * snapshot the route was resolved from; spend is read when a step asks.
 */
interface BackgroundBudgetInputs {
	settings: Readonly<ClioSettings>;
	/** Priced session spend; absent where no session ledger exists, which reads as none. */
	sessionSpendUsd?: () => number;
}

function backgroundRouteFacts(
	refined: ReturnType<typeof prepareBackgroundMemoryModel>["refined"],
): BackgroundRouteFacts {
	const pricing = resolveEffectivePricing(refined.target, refined.runtime, refined.wireModelId);
	return {
		provenance: pricing.provenance,
		rates: pricing.rates,
		runtime: refined.runtime,
		quotaProviderId: quotaProviderIdForRuntime(refined.runtimeId),
	};
}

type AdmitBackgroundModelFlow = (destination: {
	targetId: string;
	runtimeId: string;
	wireModelId: string;
}) => string | null;

export function createBackgroundMemoryModelClient(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
	timeoutMs: number,
	bus: Pick<SafeEventBus, "emit"> | null,
	fallbackOnly = false,
	admitModelFlow?: AdmitBackgroundModelFlow,
	sessionSpendUsd?: () => number,
): BackgroundMemoryRoute | null {
	if (!settings.context.memory.enabled) return null;
	const budget: BackgroundBudgetInputs = { settings, ...(sessionSpendUsd === undefined ? {} : { sessionSpendUsd }) };
	const memoryRoute = resolveMemoryRoute(settings);
	const configuredTarget = memoryRoute.target?.trim();
	const configuredModel = memoryRoute.model?.trim();
	if (!configuredTarget || !configuredModel) return null;
	if (memoryRoute.source === "chat") {
		if (fallbackOnly) return null;
		return prepareBackgroundMemoryRoute(
			providers,
			configuredTarget,
			configuredModel,
			timeoutMs,
			bus,
			"chat-default",
			settings.targets,
			admitModelFlow,
			budget,
		);
	}
	const chatTarget = settings.chat.target?.trim();
	const chatModel = settings.chat.model?.trim();
	const sameRoute = configuredTarget === chatTarget && configuredModel === chatModel;
	if (fallbackOnly && sameRoute) return null;
	let fallbackReason: string | undefined;
	if (!fallbackOnly) {
		try {
			return prepareBackgroundMemoryRoute(
				providers,
				configuredTarget,
				configuredModel,
				timeoutMs,
				bus,
				"dedicated",
				settings.targets,
				admitModelFlow,
				budget,
			);
		} catch (error) {
			fallbackReason = `configured route unavailable: ${memoryRouteFailureCause(error)}`;
		}
	} else fallbackReason = "configured route client error";
	if (!chatTarget || !chatModel || sameRoute) {
		if (fallbackOnly) return null;
		throw new Error("configured memory route is unavailable and no distinct chat fallback can run");
	}
	try {
		return {
			...prepareBackgroundMemoryRoute(
				providers,
				chatTarget,
				chatModel,
				timeoutMs,
				bus,
				"chat-fallback",
				settings.targets,
				admitModelFlow,
				budget,
			),
			fallbackReason,
		};
	} catch {
		if (fallbackOnly) return null;
		throw new Error("neither the configured memory route nor the active chat fallback is available");
	}
}

function prepareBackgroundMemoryModel(providers: ProvidersContract, targetId: string, wireModelId: string) {
	const status = providers.list().find((entry) => entry.target.id === targetId);
	if (status) {
		if (!status.available) throw new Error(status.reason || "configured target unavailable");
		if (status.health.status === "down") throw new Error(status.health.lastError || "endpoint unreachable");
		if (hasLiveModelCatalog(status) && !status.discoveredModels.includes(wireModelId)) {
			throw new Error(`unknown model: ${wireModelId}`);
		}
		const residency = modelResidencyForStatus(status, wireModelId);
		if (residency === "absent" || residency === "loading") throw new Error(`model ${wireModelId} is ${residency}`);
	}
	const resolved = resolveRuntimeTarget(providers, {
		targetId,
		wireModelId,
		// Memory reads a trajectory and writes a fixed envelope. Reasoning adds
		// latency and, on a small local model, routinely consumes the entire
		// output budget before the envelope is ever written.
		requestedThinkingLevel: "off",
		use: "orchestrator",
		requireTools: false,
		requireOutputBudget: true,
	});
	if (!resolved.ok) {
		const detail = firstRuntimeResolutionError(resolved.diagnostics) ?? "background target resolution failed";
		throw new Error(detail);
	}
	const kbHit = providers.knowledgeBase?.lookup(resolved.target.wireModelId, resolved.target.runtime.id) ?? null;
	const model = resolved.target.runtime.synthesizeModel(resolved.target.target, resolved.target.wireModelId, kbHit);
	const refined = refineRuntimeTargetWithModelHints(resolved.target, model, providers.knowledgeBase);
	applyModelCapabilityPatch(model, refined.capabilities);
	return { model, refined };
}

/** A bounded preparation capacity when no foreground actor budget exists. Never activates actor context. */
function memoryObservationCapacity(providers: ProvidersContract, settings: Readonly<ClioSettings>): number {
	const route = resolveMemoryRoute(settings);
	if (!route.target || !route.model) return 0;
	try {
		const { model } = prepareBackgroundMemoryModel(providers, route.target, route.model);
		return Math.max(
			0,
			model.contextWindow -
				estimateAgentContextTokens({ systemPrompt: OBSERVATION_PROMPT, messages: [] }) -
				settings.context.memory.maxOutputTokens -
				64,
		);
	} catch {
		return 0; /* An unknown route preserves raw-history fallback. */
	}
}

/**
 * One tool-free completion for a System One engine that reads an ordinary chat
 * target, for the runtimes that have no chat-completions wire of their own
 * (subscription and CLI-backed ones). Target and model resolve the way the
 * background memory role resolves them, and the round runs beside the session
 * without ever becoming a turn. The answer is text, so an engine behind this
 * port can vote but cannot read logprobs.
 */
function createSystemOneOneShot(providers: ProvidersContract, admitRequest: LlmRequestAdmission): OneShotPort {
	return async (request) => {
		const target = providers.getTarget(request.targetId);
		const wireModelId = request.model ?? target?.defaultModel ?? null;
		if (target === null || wireModelId === null) {
			throw new Error(`target '${request.targetId}' names no model to ask`);
		}
		const { model, refined } = prepareBackgroundMemoryModel(providers, request.targetId, wireModelId);
		const sideAuth = await resolveSideCallAuth(
			providers.auth,
			refined.target,
			refined.runtime,
			LOCAL_API_KEY_FALLBACK,
			request.signal,
		);
		let recordUsage: Awaited<ReturnType<LlmRequestAdmission>> | undefined;
		const result = await runOutOfTurnRound({
			model,
			messages: [],
			systemPrompt: request.system,
			userText: request.user,
			maxTokens: request.maxTokens,
			// A vote, resolved for thinking off the way the memory role resolves;
			// the round must ask for the same.
			thinkingLevel: "off",
			signal: request.signal,
			runtimeId: refined.runtime.id,
			beforeRequest: async () => {
				recordUsage = await admitRequest({ targetId: request.targetId, model: wireModelId, signal: request.signal });
			},
			onUsage: (usage, observation) => recordUsage?.(usage, observation),
			...sideAuth,
			...(request.schema !== undefined
				? { responseSchema: { name: "system_one_vote", schema: request.schema as Record<string, unknown> } }
				: {}),
		});
		if (result.aborted) throw new Error("the one-shot round was aborted");
		return {
			text: result.text,
			...(result.usage !== null ? { usage: { input: result.usage.input, output: result.usage.output } } : {}),
		};
	};
}

/**
 * The slot bound background memory admits against on the route's endpoint.
 * Unlike dispatch, an endpoint whose capacity nothing proves is one slot here;
 * see `backgroundMemoryAdmissionLimit`. The middleware's pre-check and the
 * reservation in the client both read this one function over the same target
 * set, so route selection, capacity and reservation cannot disagree.
 */
function memoryAdmissionLimitFor(
	providers: ProvidersContract,
	endpointKey: string,
	targets: ReadonlyArray<TargetDescriptor>,
): number {
	const capacity = resolveEndpointCapacities({
		statuses: providers.list(),
		targets,
		runtimeFor: (id) => providers.getRuntime(id),
	})[endpointKey];
	return backgroundMemoryAdmissionLimit(capacity);
}

/**
 * The slot key a background memory step admits against. Behind a model-routed
 * gateway that nothing bounds (no override, no discovered slots), the step's
 * own model is the scheduler it competes with, so it counts only that model's
 * streams; another model's turn through the same gateway no longer reads as
 * busy. Once the gateway carries a bound, the step admits against the
 * gateway total exactly as before, so optional work never exceeds what the
 * operator declared.
 */
function backgroundMemoryEndpointKey(
	providers: ProvidersContract,
	target: TargetDescriptor,
	wireModelId: string,
	targets: ReadonlyArray<TargetDescriptor>,
): string | null {
	return backgroundSlotKey(
		target,
		wireModelId,
		(gateway) =>
			resolveEndpointCapacities({
				statuses: providers.list(),
				targets,
				runtimeFor: (id) => providers.getRuntime(id),
			})[gateway] !== undefined,
	);
}

function backgroundMemoryEndpointBusy(
	providers: ProvidersContract,
	endpointKey: string | null,
	targets: ReadonlyArray<TargetDescriptor>,
): boolean {
	if (endpointKey === null) return false;
	const limit = memoryAdmissionLimitFor(providers, endpointKey, targets);
	return modelStreamUsage(endpointCapacityUsage(), endpointKey) >= limit;
}

function prepareBackgroundMemoryRoute(
	providers: ProvidersContract,
	targetId: string,
	wireModelId: string,
	timeoutMs: number,
	bus: Pick<SafeEventBus, "emit"> | null,
	selection: BackgroundMemoryRoute["selection"],
	targets: ReadonlyArray<TargetDescriptor>,
	admitModelFlow?: AdmitBackgroundModelFlow,
	budget?: BackgroundBudgetInputs,
): BackgroundMemoryRoute {
	const initial = prepareBackgroundMemoryModel(providers, targetId, wireModelId);
	const { refined } = initial;
	const gatewayKey = canonicalEndpointKey(refined.target);
	const endpointKey = backgroundMemoryEndpointKey(providers, refined.target, refined.wireModelId, targets);
	const routeFacts = backgroundRouteFacts(refined);
	return {
		selection,
		targetId,
		wireModelId: refined.wireModelId,
		endpointKey,
		modelMaxTokens: (configuredMaxTokens) =>
			memoryInterventionModelMaxTokens({
				configuredMaxTokens,
				thinkingMechanism: refined.modelRuntime.thinking.mechanism,
				modelMaxTokens: refined.capabilityDecisions.maxTokens,
			}),
		client: {
			// The route this client is bound to. The middleware reads it for the
			// telemetry row, so a fallback client names the target that served the step.
			route: { targetId, modelId: refined.wireModelId },
			// Wrapped at the layer that knows a request left the process: the step
			// holds endpoint capacity while it is out and publishes the cache
			// disturbance even when a timeout means the usage sink never sees it.
			complete: async (request) => {
				let usageObserved = false;
				try {
					// Decided before the metadata probe, auth or any byte leaves, so a
					// skipped step costs nothing; the next cadence tick decides again.
					const nowMs = Date.now();
					const throughput = endpointThroughput(endpointKey);
					let routeQuota = routeFacts.quotaProviderId === null ? null : observedQuota(routeFacts.quotaProviderId, nowMs);
					if (initial.refined.runtimeId === "openai-codex") {
						const status = providers.auth.statusForTarget(initial.refined.target, initial.refined.runtime);
						const stored = providers.auth.getStored(status.providerId);
						const scope =
							status.source === "stored-oauth" && stored?.type === "oauth" ? codexAccountScope(stored.access) : null;
						routeQuota = observedCodexQuota(targetId, scope, nowMs);
					} else if (initial.refined.runtimeId === "anthropic-max") {
						const status = providers.auth.statusForTarget(initial.refined.target, initial.refined.runtime);
						const profile = status.source === "stored-oauth" ? status.providerId : null;
						// #423: the provider-wide poll belongs only to Clio's default OAuth profile.
						if (profile !== "anthropic-max") routeQuota = null;
						const streamed = observedAnthropicQuota(targetId, nowMs, profile);
						if (streamed !== null && !streamed.stale) routeQuota = streamed;
					}
					const decision = decideBackgroundStep({
						route: routeFacts,
						inputTokens: ceilChars(request.systemPrompt.length + request.userPrompt.length),
						maxOutputTokens: budget?.settings.context.memory.maxOutputTokens ?? request.maxTokens,
						timeoutCapMs: timeoutMs,
						nowMs,
						session: {
							spendUsd: budget?.sessionSpendUsd?.() ?? 0,
							ceilingUsd: budget?.settings.safety.limits.sessionCostUsd ?? 0,
						},
						quota: routeQuota,
						endpoint: {
							occupied: endpointKey === null ? 0 : modelStreamUsage(endpointCapacityUsage(), endpointKey),
							admissionLimit:
								endpointKey === null ? Number.POSITIVE_INFINITY : memoryAdmissionLimitFor(providers, endpointKey, targets),
							prefillTokensPerSecond: throughput?.prefillTokensPerSecond ?? null,
							generationTokensPerSecond: throughput?.generationTokensPerSecond ?? null,
						},
					});
					if (!decision.admit) {
						if (decision.reason === "endpoint_busy") {
							throw new TaskMemoryEndpointBusyError("endpoint occupancy exhausts the background memory slot bound");
						}
						throw new TaskMemoryBudgetSkipError(decision.reason, decision.resumeAt);
					}
					await prepareBackgroundModelMetadata(providers, targetId, request.signal);
					const { model, refined } = prepareBackgroundMemoryModel(providers, targetId, wireModelId);
					if (refined.runtimeId !== initial.refined.runtimeId || canonicalEndpointKey(refined.target) !== gatewayKey) {
						throw new Error("background memory target changed during preparation");
					}
					if (request.purpose) {
						const inputTokens = estimateAgentContextTokens({
							systemPrompt: request.systemPrompt,
							messages: [{ role: "user", content: [{ type: "text", text: request.userPrompt }], timestamp: Date.now() }],
						});
						if (!(model.contextWindow > 0) || inputTokens + request.maxTokens + 64 > model.contextWindow)
							throw new TaskMemoryBudgetSkipError("time_budget");
					}
					const costProvenance = normalizeCostProvenance(refined.costProvenance);
					const sideAuth = await resolveSideCallAuth(
						providers.auth,
						refined.target,
						refined.runtime,
						LOCAL_API_KEY_FALLBACK,
						request.signal,
					);
					request.signal.throwIfAborted();
					const refusal =
						admitModelFlow?.({ targetId, runtimeId: refined.runtimeId, wireModelId: refined.wireModelId }) ?? null;
					if (refusal !== null) throw new TaskMemoryInformationFlowBlockedError(refusal);
					// Preparation yielded after the middleware's first check. The wrapper
					// rechecks occupancy and registers the preemptible hold in one
					// synchronous step, so no local request can take the last slot between.
					const admissionLimit =
						endpointKey === null ? Number.POSITIVE_INFINITY : memoryAdmissionLimitFor(providers, endpointKey, targets);
					return await announceMemoryStepEndpoint(
						{
							bus,
							endpointKey,
							targetId,
							admissionLimit,
							admit: () => endpointKey === null || modelStreamUsage(endpointCapacityUsage(), endpointKey) < admissionLimit,
						},
						async (request: TaskMemoryModelRequest) => {
							const startedAt = performance.now();
							let observedUsage: TaskMemoryStepUsage | undefined;
							const mapUsage = (
								completion: Pick<EngineTextCompletionResult, "usage" | "backend" | "failure">,
							): TaskMemoryStepUsage => ({
								...completion.usage,
								...(completion.failure === undefined ? {} : { failure: completion.failure }),
								targetId,
								attributedModelId: refined.wireModelId,
								costProvenance: completion.usage.missingTokenCalls ? "unknown" : costProvenance,
								durationMs: performance.now() - startedAt,
								backend: completion.backend,
							});
							const completion = await completeEngineText({
								...(request.callTelemetry ? { callTelemetry: request.callTelemetry } : {}),
								model,
								systemPrompt: request.systemPrompt,
								userPrompt: request.userPrompt,
								maxTokens:
									refined.capabilityDecisions.maxTokens > 0
										? Math.min(request.maxTokens, refined.capabilityDecisions.maxTokens)
										: request.maxTokens,
								// Always off, never the operator's chat thinking level. A model that
								// reasons anyway still works: `completeEngineText` keeps only text
								// blocks, and the memory output budget leaves room for the preamble.
								thinkingLevel: "off",
								// Memory decides what to keep; the same completed task must get the same answer.
								// A live Ornith review retained a validator recipe in one run and abstained on
								// the identical trajectory in the next, at the server's default temperature.
								deterministicRuntimeId: refined.runtimeId,
								signal: request.signal,
								timeoutMs: decision.timeoutMs,
								onUsage: (observation) => {
									usageObserved = true;
									observedUsage = mapUsage(observation);
									request.onUsage?.(observedUsage);
								},
								...sideAuth,
								...(refined.target.auth?.headers ? { headers: refined.target.auth.headers } : {}),
							});
							recordEndpointThroughput(endpointKey, completion.backend);
							// The step is billed here whatever the policy later decides about the
							// answer. A model that read a trajectory and chose silence spent the
							// same prefill as one that produced a reminder.
							return {
								text: completion.text,
								inputTokens: completion.inputTokens,
								outputTokens: completion.outputTokens,
								usage: observedUsage ?? mapUsage(completion),
							};
						},
					)(request);
				} catch (error) {
					if (
						!usageObserved &&
						!(error instanceof TaskMemoryBudgetSkipError) &&
						!(error instanceof TaskMemoryEndpointBusyError) &&
						!(error instanceof TaskMemoryInformationFlowBlockedError)
					)
						request.onUsage?.({
							targetId,
							attributedModelId: initial.refined.wireModelId,
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							reasoning: 0,
							totalTokens: 0,
							costUsd: 0,
							costProvenance: "unknown",
							durationMs: 0,
							backend: null,
							failure: classifyCallFailure(error, { invoked: false, aborted: request.signal.aborted }),
						});
					throw error;
				}
			},
		},
	};
}

const emitMemoryFlowNotice = declareRuntimeNoticeProducer("background-memory-flow", ["memory-flow-blocked"]);
const emitQuotaNotice = declareRuntimeNoticeProducer("anthropic-quota", ["stress"]);

const emitRouteFallbackNotice = declareRuntimeNoticeProducer("background-memory-route", ["route-fallback"]);

function memoryRouteFailureCause(error: unknown): string {
	return (
		redactSecretString(error instanceof Error ? error.message : String(error))
			.split("\n", 1)[0]
			?.slice(0, 180) || "unknown route error"
	);
}

/** Production callback composition shared with routing/capacity contracts. */
export function createBackgroundMemoryRouting(
	providers: ProvidersContract,
	getSettings: () => Readonly<ClioSettings> | undefined,
	bus: Pick<SafeEventBus, "emit"> | null,
	admitModelFlow?: AdmitBackgroundModelFlow,
	/** False for a second routing instance whose fallback the first already announces. */
	announceFallback = true,
	/** Priced session spend the metered budget adds a step's projected cost to. */
	sessionSpendUsd?: () => number,
	callJournal?: (targetId: string, modelId: string) => CallJournalOptions | undefined,
) {
	let route: BackgroundMemoryRoute | null = null;
	let snapshot: Readonly<ClioSettings> | undefined;
	let lastNotice: string | null = null;
	let clientFailure: string | null = null;
	const observeClient = (client: TaskMemoryModelClient | null): TaskMemoryModelClient | null => {
		if (!client) return null;
		return {
			...client,
			async complete(request) {
				const destination = client.route;
				const options = destination ? callJournal?.(destination.targetId, destination.modelId) : undefined;
				const scope = await openCallScope(options, {
					api: options ? (providers.getRuntime(options.runtimeId)?.apiFamily ?? "unknown") : "unknown",
					id: destination?.modelId ?? "unknown",
				});
				const callTelemetry = {
					...scope,
					startAttempt() {
						const identity = scope.startAttempt();
						if (identity && options) {
							try {
								request.onCall?.({ ...identity, sessionId: options.origin.id, repoIdentity: options.origin.cwdHash });
							} catch {
								writeDiagnostic("[clio-coder:telemetry] memory call reference was not recorded\n");
							}
						}
					},
				};
				callTelemetry.startAttempt();
				try {
					return await scope.withContext(() => client.complete({ ...request, callTelemetry }));
				} catch (error) {
					// Engine attempts settle first; only failures in preparation reach this fallback (#434).
					scope.settle({
						stopReason: request.signal.aborted ? "aborted" : "error",
						failure: classifyCallFailure(error, { invoked: false, aborted: request.signal.aborted }),
					});
					throw error;
				} finally {
					await scope.close();
				}
			},
		};
	};
	const noteFallback = (): void => {
		if (route?.selection !== "chat-fallback") {
			lastNotice = null;
			return;
		}
		const message = `Memory: ${route.fallbackReason}; selected chat fallback ${route.targetId}/${route.wireModelId} for this step, subject to available endpoint capacity.`;
		if (message === lastNotice) return;
		lastNotice = message;
		if (!bus || !announceFallback) return;
		emitRouteFallbackNotice(
			{
				kind: "route-fallback",
				level: "info",
				message,
				targetId: route.targetId,
				runtimeId: providers.getTarget(route.targetId)?.runtime ?? "unknown",
				model: route.wireModelId,
			},
			bus,
		);
	};
	return {
		getModelClient: (): TaskMemoryModelClient | null => {
			const current = getSettings();
			snapshot = current === undefined ? undefined : structuredClone(current);
			route =
				snapshot === undefined
					? null
					: createBackgroundMemoryModelClient(
							providers,
							snapshot,
							snapshot.context.memory.timeoutMs,
							bus,
							false,
							admitModelFlow,
							sessionSpendUsd,
						);
			noteFallback();
			clientFailure = null;
			const client = observeClient(route?.client ?? null);
			return client
				? {
						...client,
						complete: async (request) => {
							try {
								return await client.complete(request);
							} catch (error) {
								clientFailure = memoryRouteFailureCause(error);
								throw error;
							}
						},
					}
				: null;
		},
		getFallbackModelClient: (): TaskMemoryModelClient | null => {
			if (route?.selection !== "dedicated" || snapshot === undefined) return null;
			route = createBackgroundMemoryModelClient(
				providers,
				snapshot,
				snapshot.context.memory.timeoutMs,
				bus,
				true,
				admitModelFlow,
				sessionSpendUsd,
			);
			if (route && clientFailure) route.fallbackReason = `configured route client error: ${clientFailure}`;
			noteFallback();
			return observeClient(route?.client ?? null);
		},
		getModelMaxTokens: (configured: number): number => route?.modelMaxTokens(configured) ?? configured,
		backgroundEndpointBusy: (): boolean => {
			if (route?.endpointKey == null || snapshot === undefined) return false;
			return backgroundMemoryEndpointBusy(providers, route.endpointKey, snapshot.targets);
		},
	};
}

/**
 * Warn about a configured agent-role model the provider reports cannot call
 * tools. Selection already refuses these, so reaching here means the config
 * predates the check or was hand-edited; a run would otherwise fail later at
 * dispatch admission with a message that names a missing tool rather than the
 * model that cannot use any.
 */
function agentRoleToolWarnings(providers: ProvidersContract, settings: Readonly<ClioSettings>): string[] {
	const roles: ReadonlyArray<{ label: string; target: string | null; model: string | null }> = [
		{ label: "orchestrator", target: settings.chat.target, model: settings.chat.model },
		{ label: "workers.default", target: settings.fleet.default.target, model: settings.fleet.default.model },
	];
	const warnings: string[] = [];
	for (const role of roles) {
		const targetId = role.target?.trim();
		const wireModelId = role.model?.trim();
		if (!targetId || !wireModelId) continue;
		try {
			const status = providers.list().find((entry) => entry.target.id === targetId);
			if (!status) continue;
			const capabilities = resolveModelCapabilities(status, wireModelId, providers.knowledgeBase);
			if (supportsAgentRoleTools(capabilities)) continue;
			// A target that was never probed has reported nothing about this model:
			// the flag is only the runtime's conservative floor. Dispatch admission
			// probes the route itself before it refuses a worker.
			const declared =
				status.target.capabilities?.tools ??
				providers.knowledgeBase?.lookup(wireModelId, status.runtime?.id ?? status.target.runtime)?.entry.capabilities
					?.tools;
			if (
				declared === undefined &&
				status.health.lastCheckAt === null &&
				probeCapabilitiesForModel(status, wireModelId) === null
			)
				continue;
			warnings.push(
				`${role.label} model '${wireModelId}' on target '${targetId}' ${AGENT_ROLE_TOOLS_REQUIRED_REASON}. ` +
					`Pick another model, or state the correction in a model-catalog.d entry if the provider's flag is wrong.`,
			);
		} catch {
			// An unresolvable capability is not evidence of a missing one.
		}
	}
	return warnings;
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
		costProvenance: route.costProvenance,
		targetId: route.targetId,
		runtimeId: route.runtime.id,
		wireModelId: route.wireModelId,
		endpointKey: modelEndpointKey(route.target, route.wireModelId),
		...sideAuth,
		...(route.target.auth?.headers ? { headers: route.target.auth.headers } : {}),
	};
}

function readSessionEntriesForCompact(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
}

/** Only flow custom entries need validation here; message payloads never enter this ledger. */
function readFlowSessionEntries(sessionId: string): ReadonlyArray<unknown> {
	return openSession(sessionId)
		.turns()
		.filter(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"customType" in entry &&
				entry.customType === FLOW_RESTRICTION_ENTRY_TYPE,
		);
}

/**
 * The read tool's reread port over the live session. The hash index it keeps
 * is rebuilt only when an eviction event lands (`ContextPruned`) or the
 * session changes, so an ordinary read never re-parses the ledger.
 */
function createSessionRereadPort(session: SessionContract, bus: SafeEventBus): ReadRecallPort {
	const port = createRereadRecallPort({
		sessionId: () => session.current()?.id ?? null,
		readEntries: () => {
			const meta = session.current();
			return meta ? session.readEntries() : [];
		},
		activeLeafTurnId: () => {
			const meta = session.current();
			return meta ? (session.tree(meta.id).leafId ?? undefined) : undefined;
		},
		cwd: () => session.current()?.cwd ?? null,
		appendEntry: (entry) => session.appendEntry(entry),
		onRecalled: (payload) => bus.emit(BusChannels.ContextRecalled, payload),
	});
	bus.on(BusChannels.ContextPruned, () => port.invalidate());
	return port;
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
	return collectSessionEntries(
		readSessionTailTurns(sessionId, FINISH_CONTRACT_TAIL_ENTRIES).entries,
		sessionCurrentPath(sessionId),
	);
}

function protectedArtifactStateForCurrentSession(
	session: SessionContract,
): ReturnType<typeof protectedArtifactStateFromSessionEntries> {
	const meta = session.current();
	if (!meta) return { artifacts: [] };
	reconcilePendingProtectedArtifacts(session);
	return protectedArtifactStateFromSessionEntries(session.readEntries());
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

/**
 * Fold a terminal dispatch payload's worker skill activations into the session
 * ledger, tagged with the runId, so worker skill provenance sits next to
 * main-agent activations.
 *
 * Both terminal channels carry them and the run finalizer emits exactly one of
 * the two, so this cannot double-record. The orchestrator never observes worker
 * tool calls directly, because a worker runs its own registry in its own
 * subprocess, which makes this the only recording path there is. Returns how
 * many were folded.
 */
function foldDispatchSkillActivations(
	session: SessionContract | undefined,
	payload: { runId?: unknown; skillActivations?: ReadonlyArray<unknown> } | undefined,
): number {
	const runId = payload?.runId;
	if (typeof runId !== "string") return 0;
	let folded = 0;
	for (const activation of payload?.skillActivations ?? []) {
		if (!isSkillActivation(activation)) continue;
		appendSkillActivationRegistryEvent(session, { ...activation, runId });
		folded += 1;
	}
	return folded;
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
	observability?: BackgroundMemoryUsageSink,
	budget?: Pick<
		CompactInput,
		| "providerCompaction"
		| "providerFallbackReason"
		| "keepRecentTokens"
		| "preserveUserTurnId"
		| "pendingOperatorTurn"
		| "skillContextState"
		| "signal"
		| "beforeSummaryCall"
		| "checkpointForSummary"
		| "checkpointTokenFigures"
		| "skipSummaryDigest"
	>,
	summarize?: CompactInput["summarize"],
	admission?: {
		scheduling?: SchedulingContract;
		headless?: boolean;
		getCeilingUsd?: () => number;
		/** Information-flow admission of the summarizer request; the block reason or null. */
		admitFlow?: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
		memory?: MemoryRuntime;
		summaryAdmitted?: boolean;
	},
): Promise<CompactResult | null> {
	const meta = session.current();
	if (!meta) {
		throw new Error("no current session to compact; start one with /new or /resume first");
	}
	const stateDir = clioStateDir();
	const activeLeafTurnId = session.tree(meta.id).leafId ?? undefined;
	const isOriginCurrent = () =>
		session.current()?.id === meta.id && (session.tree(meta.id).leafId ?? undefined) === activeLeafTurnId;
	const entries = withProviderCheckpointMeasurements(filterEntriesToActivePath(session.readEntries(), activeLeafTurnId));
	if (entries.length === 0) return null;
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
	const preserveCalls = () =>
		recordFailedCompactionCalls(
			{
				stateDir,
				sessionId: meta.id,
				repoIdentity: meta.cwdHash || cwdHash(meta.cwd),
				target: resolved.targetId,
				model: resolved.wireModelId,
			},
			calls,
			isOriginCurrent() ? observability : undefined,
		);

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
	const admitSummary = async (): Promise<void> => {
		if (admission?.summaryAdmitted) return;
		await budget?.beforeSummaryCall?.();
		if (resolved.costProvenance === "known" || resolved.costProvenance === "estimated") {
			await admission?.scheduling?.admitPaidRequest?.({
				waitForRaise: admission.headless !== true,
				...(admission.getCeilingUsd ? { getCeilingUsd: admission.getCeilingUsd } : {}),
				...(budget?.signal ? { signal: budget.signal } : {}),
			});
		}
	};

	let result: CompactResult;
	try {
		result = await compact({
			...(observability?.acquireTelemetrySession
				? {
						telemetry: {
							origin: meta,
							acquire: observability.acquireTelemetrySession,
							label: "compaction",
							targetId: resolved.targetId,
							runtimeId: resolved.runtimeId,
							costProvenance: resolved.costProvenance,
						},
					}
				: {}),
			entries,
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
			beforeSummaryCall: () => {
				if (flowViolation !== undefined && flowViolation !== null) throw new Error(`compaction refused: ${flowViolation}`);
				if (!nativeEnabled || !providerCompaction) return admitSummary();
				nativeAdmission ??= admitSummary();
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
	} catch (error) {
		try {
			preserveCalls();
		} catch (recordingError) {
			throw new AggregateError([error, recordingError], "compaction failed and its usage could not be fully recorded");
		}
		throw error;
	} finally {
		releaseEndpointSlot();
	}
	if (budget?.signal?.aborted) {
		preserveCalls();
		budget.signal.throwIfAborted();
	}
	if (!isOriginCurrent()) {
		preserveCalls();
		throw new Error("compaction session or branch changed; summary discarded and originating usage retained");
	}
	if (result.messagesSummarized === 0 || result.summary.length === 0) {
		preserveCalls();
		if (calls.length > 0) throw new Error("compaction returned no summary; reported usage retained without a checkpoint");
		// The empty result carries why nothing was summarized, which the
		// operation's conclusion names (#422).
		return result;
	}
	if (estimateTokensAfterCompaction(entries, result, continuityNote.tokens) >= result.tokensBefore) {
		preserveCalls();
		return { ...result, noGain: true };
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
			costProvenance: resolved.costProvenance,
		};
	const entry: Omit<CompactionSummaryEntry, "timestamp"> = {
		kind: "compactionSummary",
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
		tokensAfter: estimateTokensAfterCompaction(entries, result, continuityNote.tokens),
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
		preserveCalls();
		budget.signal.throwIfAborted();
	}
	if (!isOriginCurrent()) {
		preserveCalls();
		throw new Error("compaction ownership changed before publication");
	}
	try {
		result.publishProviderCheckpoint?.();
	} catch {
		preserveCalls();
		budget?.signal?.throwIfAborted();
		const { providerCompaction: _native, ...portableBudget } = budget ?? {};
		return runCompactionFlow(
			session,
			settings,
			providers,
			instructions,
			trigger,
			observability,
			{ ...portableBudget, providerFallbackReason: "checkpoint-publication-failed" },
			summarize,
			{ ...admission, summaryAdmitted: true },
		);
	}
	try {
		session.appendEntry(entry);
	} catch (error) {
		// A write may have reached the ledger before its caller threw. Reconcile
		// this exact checkpoint identity before choosing a second accounting store.
		try {
			if (!compactionCheckpointWasWritten(sessionPaths(meta).current, entry.turnId)) {
				preserveCalls();
				if (result.providerCheckpoint) pruneProviderCheckpoints(result.providerCheckpoint);
			}
		} catch (recordingError) {
			throw new AggregateError(
				[error, recordingError],
				"compaction checkpoint persistence is unresolved; usage was not duplicated",
			);
		}
		throw error;
	}
	session.flushAppends?.();
	if (calls.some((call) => call.outcome !== "success")) {
		try {
			recordFailedCompactionCalls(
				{
					stateDir,
					sessionId: meta.id,
					repoIdentity: meta.cwdHash || cwdHash(meta.cwd),
					target: resolved.targetId,
					model: resolved.wireModelId,
				},
				calls.filter((call) => call.outcome !== "success"),
				observability,
			);
		} catch {
			// The cut is already durable; a secondary accounting failure must not invalidate it (#423).
			process.emitWarning("Compaction completed, but failed-attempt usage could not be saved", {
				code: "CLIO_CODER_COMPACTION_USAGE_PERSISTENCE_FAILED",
			});
		}
	}
	return result;
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

/**
 * Compose the production chat-loop compaction callback. Errors intentionally
 * propagate: the chat loop owns activity failure reporting and distinguishes
 * a thrown read/model/persistence failure from the legitimate no-op that
 * `runCompactionFlow` returns: null for an empty session, and a result with no
 * summary and its `emptyReason` for an unavailable cut.
 */
export function createProductionAutoCompact(
	session: SessionContract,
	getSettings: () => ClioSettings,
	providers: ProvidersContract,
	observability?: BackgroundMemoryUsageSink,
	summarize?: CompactInput["summarize"],
	admission?: {
		scheduling?: SchedulingContract;
		headless?: boolean;
		getCeilingUsd?: () => number;
		/** Information-flow admission of the summarizer request; the block reason or null. */
		admitFlow?: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
		memory?: MemoryRuntime;
	},
): (
	instructions?: string,
	trigger?: CompactionTrigger,
	budget?: Pick<
		CompactInput,
		| "providerCompaction"
		| "providerFallbackReason"
		| "keepRecentTokens"
		| "preserveUserTurnId"
		| "pendingOperatorTurn"
		| "skillContextState"
		| "signal"
		| "beforeSummaryCall"
		| "checkpointForSummary"
		| "checkpointTokenFigures"
		| "skipSummaryDigest"
	>,
) => Promise<CompactResult | null> {
	return (instructions, trigger, budget) =>
		runCompactionFlow(
			session,
			getSettings(),
			providers,
			instructions,
			trigger,
			observability,
			budget,
			summarize,
			admission,
		);
}

function estimateTokensFromSummary(result: CompactResult): number {
	return estimateTokens({
		kind: "compactionSummary",
		turnId: "estimate",
		parentTurnId: null,
		timestamp: "",
		summary: result.summary,
		...(result.providerCheckpoint ? { providerCheckpoint: result.providerCheckpoint } : {}),
		...(result.providerFallbackReason ? { providerFallbackReason: result.providerFallbackReason } : {}),
		firstKeptTurnId: result.firstKeptTurnId ?? "",
		tokensBefore: result.tokensBefore,
		...(result.skillContext ? { skillContext: result.skillContext } : {}),
		...(result.userContext ? { userContext: result.userContext } : {}),
	});
}

/**
 * The post-compaction size, on the same scale as `tokensBefore`.
 *
 * `tokensBefore` is a whole-prompt figure: `calculateContextTokens` anchors it
 * on the last assistant call's measured usage, so it carries the system prompt
 * and tool schemas that compaction never touches. The after figure has to stay
 * on that scale to be comparable, and the persistence layer has no model handle
 * to re-measure with, so it is arithmetic on that same scale: drop what stops
 * being replayed and add the summary that replaces it.
 *
 * Estimating it from the rebuilt message list instead reported `tokensBefore`
 * back unchanged, which is what made /tree render "~16276 -> ~16276 tokens"
 * beside a footer that said 16276 -> 11008 for the same compaction. That
 * estimator anchors on the newest assistant usage, and the retained suffix
 * still holds the assistant message whose usage describes the pre-compaction
 * prompt. Anchoring on it reports precisely the number compaction removed.
 */
function estimateTokensAfterCompaction(
	entries: ReadonlyArray<SessionEntry>,
	result: CompactResult,
	/**
	 * The projected continuity note, which survives the reduction and is
	 * therefore on both sides. It is already inside `tokensBefore` and the
	 * subtraction below never removes it, because continuity records estimate at
	 * zero; it only has to be restored on the floor branch, which discards
	 * `tokensBefore` entirely.
	 */
	continuityNoteTokens = 0,
): number {
	let droppedTokens = 0;
	for (const entry of entries.slice(0, result.firstKeptEntryIndex)) droppedTokens += estimateTokens(entry);
	const summaryTokens = estimateTokensFromSummary(result);
	// The summary alone is the floor: a session whose dropped estimate exceeds
	// the measured anchor must not report a negative or sub-summary context.
	return Math.max(summaryTokens + continuityNoteTokens, result.tokensBefore - droppedTokens + summaryTokens);
}

/**
 * Scoped model cycle actions step the orchestrator through the `scope` list of target
 * ids or target/model refs. Absent scope is a no-op so unconfigured users
 * feel nothing.
 */
function advanceScopedTarget(
	settings: Readonly<ClioSettings>,
	direction: "forward" | "backward",
): { target: string; model: string | null } | null {
	const scope = settings.chat.modelPicker.cycleSet ?? [];
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
	const activeTarget = settings.chat.target ?? "";
	const activeModel = settings.chat.model ?? "";
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
	const { registerRunningBuild } = await import("../core/running-build.js");
	const bootSurface = options.acp ? "acp" : options.headless ? "run" : "tui";
	registerRunningBuild(bootSurface);
	// Every session this boot opens names its surface in the live record (#439).
	(await import("../domains/session/heartbeat.js")).configureSessionHeartbeat({
		surface: bootSurface,
		terminate: (notice) => {
			const termination = getTerminationCoordinator();
			termination.notice(notice);
			void termination.shutdown(143);
		},
	});
	let capabilityGate = createCapabilityGate();
	const bootStdout = (text: string): void => {
		if (options.terminalLease) options.terminalLease.writeDiagnostic("stdout", text);
		else process.stdout.write(text);
	};
	const bootStderr = (text: string): void => {
		if (options.terminalLease) options.terminalLease.writeDiagnostic("stderr", text);
		else process.stderr.write(text);
	};
	const timer = new StartupTimer(
		options.terminalLease
			? (phase, detail) => {
					const line = formatBootTrace(phase, detail);
					if (line) options.terminalLease?.deferDiagnostic("stderr", line);
				}
			: undefined,
	);
	// The Stage 0 shell answers the terminal only when the event loop turns.
	// Boot yields at each phase boundary, so typing, submits, Ctrl+C, resize and
	// signals are handled while Stage 1 hydrates. Once Ctrl+C or a signal closes
	// the lease, hydration stops at the next boundary and the shutdown that
	// closed the lease owns the exit.
	const lease = options.terminalLease;
	const bootPhaseBoundary = lease
		? async (): Promise<void> => {
				await yieldToEventLoop();
				lease.abortSignal.throwIfAborted();
			}
		: undefined;
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	installBusTracer();
	termination.installSignalHandlers();

	ensureClioState();
	const { applyPendingMigrationsAtBoot, takeBootMigrationNotices, takePendingMigrationNotices } = await import(
		"../domains/lifecycle/boot-migrations.js"
	);
	await applyPendingMigrationsAtBoot(
		!options.headless && options.acp === undefined && process.env.CLIO_CODER_INTERACTIVE === "1",
	);
	const bootConversions = takeBootMigrationNotices();
	{
		// A workspace's `.clio-coder/` converts the first time Clio opens it, before any domain reads it.
		const { convertWorkspaceOnce, describeConversion } = await import("../domains/lifecycle/canonical-names.js");
		const converted = convertWorkspaceOnce(process.cwd());
		if (converted) bootConversions.push(describeConversion(converted, "this workspace"));
	}
	// The leased TUI turns boot diagnostics into transcript notices. Without a
	// lease (instant shell off) stderr would print before the first frame, so
	// the interactive boot holds trust notices for the transcript instead (C-4).
	const holdTrustNotices =
		options.terminalLease === undefined &&
		!options.headless &&
		options.acp === undefined &&
		process.env.CLIO_CODER_INTERACTIVE === "1";
	const heldTrustNotices: string[] = [];
	for (const surface of ["safety", "settings", "extensions", "plugins"] as const) {
		const snapshot = captureProjectSurface(process.cwd(), surface);
		if (snapshot.verdict === "trusted") continue;
		for (const file of snapshot.files) {
			if (file.text !== null || file.error !== undefined) {
				const notice = `[clio-coder:trust] ${projectSurfaceTrustNotice(snapshot, file.path)}`;
				if (holdTrustNotices) heldTrustNotices.push(notice);
				else bootStderr(`${notice}\n`);
			}
		}
	}
	sweepExpiredToolOffloads();
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
							(artifact.outcome === "operator-confirmed" || normalizeYoloGateOutcome(artifact.outcome) === "yolo-applied"),
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
				bootStderr(`[dispatch] compete recovery preserved ${failure.group}: ${failure.message}\n`);
			}
		} catch (err) {
			bootStderr(`[dispatch] compete recovery failed closed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
		// Task worktrees (`worktree: true`) get the same restart sweep: a dead
		// owner's empty worktree goes, one holding work stays and is named once.
		try {
			// Dispatch creates them under the checkout root, which a session started
			// in a subdirectory is not.
			const checkout = gitCheckoutRoot(process.cwd()) ?? process.cwd();
			// A configured absolute root is only known from settings; the disk and
			// tmpfs locations are recognized whatever the settings say.
			const worktreeRootSetting = options.startupSettings?.fleet.worktrees.root ?? startupWorktreeRootSetting();
			const recovery = recoverTaskWorktrees(checkout, allowedWorktreeParents(worktreeRootSetting, checkout));
			for (const kept of recovery.preserved) {
				bootStderr(
					`[dispatch] task worktree recovery preserved ${kept.runId}: ${kept.reason} on ${kept.branch}; inspect with git log ${kept.base}..${kept.branch}\n`,
				);
			}
			for (const failure of recovery.failed) {
				bootStderr(`[dispatch] task worktree recovery preserved ${failure.runId}: ${failure.message}\n`);
			}
		} catch (err) {
			bootStderr(`[dispatch] task worktree recovery failed closed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}
	// The first turn since the orchestrator graph loaded.
	await bootPhaseBoundary?.();

	let effectiveSettingsForDispatch: (() => Readonly<ClioSettings>) | null = null;
	let protectedArtifactStateForDispatch: (() => ProtectedArtifactState) | null = null;
	// Bound once the session flow ledger exists; dispatch reads it per request.
	let flowRestrictionsForDispatch: (() => FlowRestrictionSet | null) | null = null;
	let sessionIdForDispatch: (() => string | null) | null = null;
	// Bound once the safety judge and the autonomy resolver exist; a worker ask
	// that arrives before then finds no judge and is denied.
	let workerAskJudgeForDispatch: {
		seat: () => SafetyJudgeSeat;
		autonomy: () => AutonomyLevel;
		hookDrift: () => GitHookDriftGuard;
	} | null = null;

	// Panes are an interactive-surface projection. Headless, ACP, and worker boots
	// gate detection off so they never resolve a socket path or open a descriptor.
	// This mirrors the `interactive` predicate computed after the domains load.
	const muxInteractive = !options.headless && options.acp === undefined && process.env.CLIO_CODER_INTERACTIVE === "1";
	// An ACP client counts as attended only when it advertised so at initialize.
	// The deferred front answers initialize before this boot, so the handshake is
	// already settled here; a plain client advertises nothing and keeps the
	// unattended behavior (no ask_user, no merge card, worker asks denied at once).
	const acpHandshake = options.acp?.handshake;
	const acpInterviews = acpHandshake?.initialized === true && acpHandshake.interviewsEnabled;
	const acpWorkerPermissions = acpHandshake?.initialized === true && acpHandshake.workerPermissionsEnabled;
	const acpInterviewChannel = acpInterviews ? createAcpInterviewChannel() : undefined;
	// The rung is settled before the config contract loads, off the settings the
	// interactive entry point already read strictly (`src/cli/clio.ts:31`) and
	// the `--with-panes` / `--no-panes` flag, which wins in both directions. This
	// is why `panes.enabled` is a restart-scoped row: the decision runs once,
	// here. An inactive rung loads nothing: the whole extension, mux domain
	// included, lives behind the dynamic import below.
	const muxEnablement = resolvePanesEnablement(options.panes, options.startupSettings?.interface.panes.enabled);
	const withPanes = muxInteractive && muxEnablement !== "off" ? await import("./with-panes.js") : null;

	// Assigned once the extension reload coordinator exists, after the domains
	// load; a worker dispatched before that carries no extension hooks.
	let workerHookSource: import("./extension-reload.js").ExtensionReloadCoordinator["workerHooks"] | null = null;
	const memoryOwner = new MemoryRuntime();
	let getMemoryLessonJudge: (() => ReturnType<typeof createMemoryLessonJudge> | null) | null = null;
	const result = await loadDomains(
		[
			options.startupSettings
				? createConfigDomainModule(options.startupSettings, { holdReloads: bootPhaseBoundary !== undefined })
				: ConfigDomainModule,
			ExtensionsDomainModule,
			PluginsDomainModule,
			InteropDomainModule,
			createResourcesDomainModule({
				reservedPromptNames: new Set(BUILTIN_SLASH_COMMANDS.map((entry) => entry.name)),
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
			createContextDomainModule({
				noContextFiles: options.noContextFiles === true,
				...(options.headless ? { headless: options.headless.mode === "json" ? ("json" as const) : ("text" as const) } : {}),
			}),
			// Live probes exercise this session's chat model once the effective view
			// exists (assigned below with dispatch's); until then, the shared snapshot.
			createProvidersDomainModule({ getSettings: () => effectiveSettingsForDispatch?.() }),
			SafetyDomainModule,
			createPromptsDomainModule({
				noContextFiles: options.noContextFiles === true,
				noSkills: options.noSkills === true || options.headless?.noSkills === true,
			}),
			AgentsDomainModule,
			MiddlewareDomainModule,
			{
				manifest: { name: "memory", dependsOn: [] },
				createExtension: () => ({
					contract: memoryOwner.contract,
					extension: { start: () => {}, stop: () => memoryOwner.dispose() },
				}),
			},
			SessionDomainModule,
			ObservabilityDomainModule,
			// Budget alerts and the plan baseline read the ceiling through the
			// session's effective view, where `--max-cost-usd` sets it.
			createSchedulingDomainModule({ getSettings: () => effectiveSettingsForDispatch?.() }),
			...(withPanes
				? [
						withPanes.createMuxDomainModule({
							enabled: muxEnablement,
							log: (level, message) => {
								if (level === "warning") bootStderr(`[mux] ${message}\n`);
							},
						}),
					]
				: []),
			// Dispatch resolves worker targets through the session's effective
			// settings view once it exists (assigned below, after the config
			// contract loads); until then it falls back to the shared snapshot.
			createDispatchDomainModule({
				getCapabilityGate: () => capabilityGate,
				budgetWaitForRaise: !options.headless && !options.acp,
				// Only an operator surface answers worker escalations (F9): the TUI
				// overlay, or an ACP client that advertised it forwards them to a person.
				workerPermissionResponder: !options.headless && (!options.acp || acpWorkerPermissions),
				// A headless steer channel reaches the main session only.
				workerSteering: !options.headless,
				// Under fleet.permissions.mode=judge the main session's safety judge
				// reviews native workers' ordinary asks in this process.
				workerAskJudge: {
					seat: () => workerAskJudgeForDispatch?.seat(),
					autonomy: () => workerAskJudgeForDispatch?.autonomy() ?? "default",
					hookDrift: () => workerAskJudgeForDispatch?.hookDrift(),
				},
				// The merge card rides the same attended gate, and asks through
				// whichever ask_user handler the TUI or the ACP client has by then.
				...(!options.headless && (!options.acp || acpInterviews)
					? { operatorAsk: { available: () => askUserHandler !== null, ask: (q, o) => askUserBridge(q, o) } }
					: {}),
				getSettings: () => effectiveSettingsForDispatch?.(),
				// A native worker's tool calls reach this session's extension hooks.
				workerHooks: {
					declarations: () => workerHookSource?.declarations() ?? [],
					dropped: () => workerHookSource?.dropped() ?? [],
					evaluate: async (request, run) => (await workerHookSource?.evaluate(request, run)) ?? [],
					notify: (message) => workerHookSource?.notify(message),
				},
				getProtectedArtifactState: () => protectedArtifactStateForDispatch?.() ?? { artifacts: [] },
				getFlowRestrictions: () => flowRestrictionsForDispatch?.() ?? null,
				getFlowPolicy: () => workerFlowPolicyInput(safety?.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY),
				// Stamps every run with the session that dispatched it, which is what
				// keeps a sibling Clio process's runs and batches out of this one.
				getSessionId: () => sessionIdForDispatch?.() ?? null,
				// The domain owns the durable journal here, not the dispatch
				// tool's event registry: `/run`, a watchdog run, and a model
				// dispatch all have to leave the same transcript behind, and only
				// the last of the three ever reaches that registry.
				journalRunEvents: true,
			}),
		],
		{ diagnostic: bootStderr, ...(bootPhaseBoundary ? { beforeEach: bootPhaseBoundary } : {}) },
	);
	timer.mark(`domains loaded (${result.loaded.length})`);

	const dispatch = withDispatchMemory(result.getContract<DispatchContract>("dispatch"), () =>
		effectiveSettingsForDispatch?.(),
	);
	let unsubscribeDispatchShutdown: (() => void) | undefined;
	if (dispatch) {
		let dispatchDrain: Promise<void> | undefined;
		const beginDispatchDrain = (): Promise<void> => (dispatchDrain ??= dispatch.drain());
		unsubscribeDispatchShutdown = bus.on(BusChannels.ShutdownRequested, () => {
			// Admission closes before sequential drain hooks can wait on another resource.
			void beginDispatchDrain().catch(() => {
				// The awaited drain hook reports this same rejection.
			});
		});
		termination.onDrain(
			async () => {
				unsubscribeDispatchShutdown?.();
				await beginDispatchDrain();
			},
			{
				timeoutMs: Math.min(2 ** 31 - 1, (dispatch.drainAllowanceMs?.() ?? 0) + resolveShutdownHookBudgetMs()),
			},
		);
	}
	// The loader caps each domain separately. The outer hook must allow the
	// whole sequence to finish, including cleanup after a timed-out domain and
	// the dispatch stop's own allowance for its async durable writes (#428).
	termination.onPersist((signal) => result.stop(signal), {
		timeoutMs: Math.min(
			2 ** 31 - 1,
			(result.loaded.length + 1) * resolveShutdownHookBudgetMs() + (dispatch?.drainAllowanceMs?.() ?? 0),
		),
	});

	bus.emit(BusChannels.SessionStart, { at: Date.now() });
	timer.mark("session_start fired");

	const acpMode = options.acp !== undefined;
	const interactive = !options.headless && !acpMode && process.env.CLIO_CODER_INTERACTIVE === "1";
	if (!interactive && !options.headless && !acpMode) {
		bootStdout(buildBanner());
		if (process.env.CLIO_CODER_TIMING === "1") bootStdout(`${timer.report()}\n`);
	}

	const config = result.getContract<ConfigContract>("config");
	const providers = result.getContract<ProvidersContract>("providers");
	timer.mark("providers resolved");

	if (!interactive && !options.headless && !acpMode) {
		bootStdout(`${chalk.dim("  (non-interactive boot. pass CLIO_CODER_INTERACTIVE=1 to launch the TUI.)")}\n`);
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	const middleware = result.getContract<MiddlewareContract>("middleware");
	const observability = result.getContract<ObservabilityContract>("observability");
	const safety = result.getContract<SafetyContract>("safety");
	const session = result.getContract<SessionContract>("session");
	observability?.resetSession(session?.current()?.id ?? null);
	// One durable union of restricted sources per session. Every model send,
	// mediated outbound call and System One request is judged against it.
	const flowLedger = createFlowLedger({
		session: session ?? null,
		readEntries: readFlowSessionEntries,
		hasSourceRules: () => (safety?.policy?.informationFlow?.().rules.length ?? 0) > 0,
	});
	// An operator shell line's output joins the context the next request sends,
	// so a source it names is labeled first, the way a bash tool call is. The
	// terminal's `!` and ACP's `_clio-coder/session/shell` share this one gate.
	const labelOperatorCommand = (command: string, cwd: string): string | null => {
		const unavailable = safety?.policy?.informationFlow?.().refusal ?? null;
		if (unavailable !== null) return unavailable;
		const labels = safety?.policy?.flowRestrictionsFor?.({ tool: ToolNames.Bash, args: { command, cwd } }) ?? null;
		if (labels === null) return null;
		flowLedger.absorb(labels, { tool: "operator-bash" });
		return flowLedger.refusal();
	};
	flowRestrictionsForDispatch = () => {
		// A worker launched while the ledger cannot vouch would carry unlabeled
		// context; the refusal surfaces at its first model request instead.
		const refusal = flowLedger.refusal();
		if (refusal !== null) throw new Error(refusal);
		return flowLedger.current();
	};
	/**
	 * Block reason when the session's restricted context may not reach a
	 * configured target as it is configured now, or null. The live target
	 * descriptor is read at every request, so a URL changed behind the id is
	 * judged on what it is now.
	 */
	const admitModelFlow = (destination: { targetId: string; runtimeId: string; wireModelId: string }): string | null => {
		const refusal = flowLedger.refusal();
		if (refusal !== null) return refusal;
		const target = providers?.getTarget(destination.targetId);
		return flowTransferRefusal(
			safety?.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY,
			flowLedger.current(),
			resolveModelDestination({
				targetId: destination.targetId,
				runtimeId: destination.runtimeId,
				url: target?.url ?? null,
				model: destination.wireModelId,
			}),
		);
	};
	/** The same admission for a round that sends the live agent runtime's context. */
	const admitRuntimeFlow = (runtime: { targetId: string; runtimeId: string; wireModelId: string }): string | null =>
		admitModelFlow({ targetId: runtime.targetId, runtimeId: runtime.runtimeId, wireModelId: runtime.wireModelId });
	sessionIdForDispatch = () => session?.current()?.id ?? null;
	const prompts = result.getContract<PromptsContract>("prompts");
	const agents = result.getContract<AgentsContract>("agents");
	const resources = result.getContract<ResourcesContract>("resources");
	const extensions = result.getContract<ExtensionsContract>("extensions");
	const share = result.getContract<ShareContract>("share");
	const mux = result.getContract<MuxContract>("mux");
	const contextDomain = result.getContract<ContextContract>("context");
	const interop = result.getContract<InteropContract>("interop");
	const initialNotices = interactive ? [...heldTrustNotices, ...(contextDomain?.startupHints() ?? [])] : [];
	// Once per version, interactive only: headless and ACP have no operator at
	// the keyboard to tell, and the record is left unclaimed for the boot that does.
	const upgrade = interactive ? takeUpgradeNotice() : null;
	if (upgrade !== null) initialNotices.push(describeUpgradeNotice(upgrade));
	if (interactive) initialNotices.push(...takePendingMigrationNotices());
	// One notice per conversion; a surface with no operator at the keyboard gets it on stderr.
	for (const conversion of bootConversions) {
		if (interactive) initialNotices.push(conversion);
		else bootStderr(`${conversion}\n`);
	}
	if (!providers || !dispatch || !observability || !safety || !middleware) {
		bootStderr(
			"Clio Coder: chat mode requires safety + middleware + providers + dispatch + observability contracts; aborting.\n",
		);
		await termination.shutdown(1);
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
	}

	if (session) {
		const unbindActivity = bindSessionPackageActivity(session, observability);
		termination.onDrain(unbindActivity);
		termination.onDrain(bus.on(BusChannels.SessionResumed, () => flushPackageActivities()));
	}
	// A headless `--session`/`--continue` resolves here, where the session
	// domain exists. It is a hard requirement rather than a hint: a caller that
	// asked to continue a conversation must not receive an answer written
	// without that conversation's history.
	const requestedResume = options.headless?.resumeSession;
	let headlessResumeFailure: string | null = null;
	let resolvedResumeId: string | undefined;
	if (requestedResume !== undefined) {
		if (!session) {
			headlessResumeFailure = "session continuation requires the session domain, which is not loaded";
		} else if (requestedResume.kind === "id") {
			const ids = session.history().map((meta) => meta.id);
			const matches = ids.filter((id) => id.startsWith(requestedResume.id));
			if (ids.includes(requestedResume.id) || matches.length === 0) {
				resolvedResumeId = requestedResume.id;
			} else if (matches.length === 1) {
				resolvedResumeId = matches[0];
			} else {
				headlessResumeFailure = `session prefix ${requestedResume.id} is ambiguous; matches: ${matches.join(", ")}`;
			}
		} else {
			const latest = session.history().find((meta) => meta.hasModelTurn !== false);
			if (latest === undefined)
				headlessResumeFailure = `no previous session with a model turn recorded for ${process.cwd()}`;
			else resolvedResumeId = latest.id;
		}
	}
	const resumeId = resolvedResumeId ?? (interactive ? consumeRestartIntent(clioStateDir(), process.cwd()) : undefined);
	let resumedSessionAtBoot = false;
	if (resumeId && session && headlessResumeFailure === null) {
		try {
			session.resume(resumeId);
			resumedSessionAtBoot = true;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			if (requestedResume !== undefined) headlessResumeFailure = `failed to resume session ${resumeId}: ${detail}`;
			else bootStderr(`Clio Coder: failed to resume session ${resumeId}: ${detail}\n`);
		}
	}
	if (headlessResumeFailure !== null) {
		writeRunDiagnostic(`clio-coder run: ${headlessResumeFailure}\n`);
		await termination.shutdown(2);
		return { exitCode: 2, bootTimeMs: timer.snapshot().totalMs };
	}

	// Hook diagnostics ride the typed bus. The domain loader constructed the
	// bundle with the stderr default; swap in a sink that publishes
	// middleware.hookFailed (the interactive warn notice consumes it) and keep
	// stderr for non-interactive runs, which have no notice subscriber.
	middleware.setDiagnosticSink((diagnostic) => {
		if (diagnostic.kind === "registration_conflict") {
			// Registration bookkeeping has no hook occurrence; the affected owner
			// today declares user hooks, which never run on on_compaction, so the
			// payload's hook slot carries that as the "no evaluation" marker.
			bus.emit(BusChannels.MiddlewareHookFailed, {
				kind: "registration_conflict",
				registrationId: diagnostic.registrationId,
				hook: "on_compaction",
				at: Date.now(),
				message: formatRegistrationConflict(diagnostic),
			});
			if (!interactive) writeMiddlewareDiagnosticToStderr(diagnostic);
			return;
		}
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
			process.stderr.write(`[clio-coder:runtime] ${notice.level ?? "info"}: ${notice.message}\n`);
		});
	}

	termination.onDrain(
		onAnthropicQuotaChange((targetId, snapshot) => {
			const notice = anthropicQuotaNotice(snapshot);
			if (notice !== null)
				emitQuotaNotice(
					{
						kind: "stress",
						...notice,
						targetId,
						runtimeId: "anthropic-max",
						model: "",
					},
					bus,
				);
		}),
	);

	// Install guardrail policy before any guard registration or tool reads it.
	// The effective session view replaces this boot projection below.
	const resolvedSettings = config?.get() ?? readSettings();
	configureGuardrails(guardrailValuesFromSettings(resolvedSettings));

	// The journal sink sits on the dispatch event path, where reading settings
	// would be both a cost and a throw site. The effective session view replaces
	// this boot projection below.
	configureRunEventJournal(resolvedSettings.fleet.history.journal);

	// Register the loop and dispatch guards first. The protected-artifact guard
	// is constructed here but registered after user hooks below, so it can
	// absorb their protect_path effects. Workers register their own guards in
	// worker-runtime.ts; these instances carry the bus and session persistence.
	const loopGuard = createLoopGuardRegistration({
		safety,
		bus,
		turnBlockBudget: INTERACTIVE_LOOP_BLOCK_BUDGET,
		turnToolCallBudget: () => readOrchTurnToolCallBudget(),
		// Interactive/headless/ACP all share this orchestrator guard: at the
		// block budget, lock tools for the rest of the turn so the model
		// answers from what it gathered instead of hard-cancelling a turn that
		// may already hold the answer. The bounded backstop still cancels a
		// model that keeps calling tools.
		turnSynthesisLockout: true,
	});
	middleware.registerHook(loopGuard);
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
	const dispatchDedup = createDispatchDedupRegistration();
	middleware.registerHook(dispatchDedup.registration);
	// Observers run after the guards; they emit no effects and their sinks are
	// best-effort (session ledger, codewiki refresh).
	middleware.registerHook(
		createSkillActivationObserver((activation) => appendSkillActivationRegistryEvent(session, activation)),
	);
	// Task-board reminder: same user-message-visible channel, fired once per
	// session when a request literally enumerates three or more steps. The
	// static routing line and tasks hint ask for the same board; battery-tested
	// local models only comply when the instruction rides the user message.
	middleware.registerHook(createTaskBoardReminderRegistration());
	const taskMemoryBank = memoryOwner.bank;
	const memorySettings = (config?.get() ?? readSettings()).context.memory;
	// Bound late: the registration is built here, but the buffer a deferred
	// reminder lands in belongs to the chat loop that has not been composed yet.
	let deferredMemoryReminderSink: ((message: string, isCurrent?: () => boolean) => void) | null = null;
	// The watchdog's findings are for the operator, not the model, so they take
	// the transcript-notice path rather than the reminder buffer. Bound late for
	// the same reason: the chat loop that owns the transcript is composed below.
	let deferredWatchdogNoticeSink: ((text: string) => void) | null = null;
	// Content-bearing, so it exists only when the operator named a file. The
	// telemetry row says which silence happened; this says what the model wrote.
	const memoryTracePath = taskMemoryTracePath();
	const memoryTrace = memoryTracePath === null ? null : createTaskMemoryTrace(memoryTracePath);
	// The route the last resolved memory client would call, kept so the endpoint
	// check and the cost row read the same resolution the step itself used.
	/**
	 * Account for one background memory step exactly as a `/btw` side question is
	 * accounted for: the in-process cost tracker under its own label so `/usage`
	 * shows it while the session lives, and one durable out-of-turn row so
	 * `clio-coder usage report` can still see it afterwards.
	 *
	 * Accounting only. The client wrapper (`announceMemoryStepEndpoint`) holds the
	 * endpoint slot and publishes the disturbance; it sees the timed-out and
	 * thrown steps that report no usage. Late reported usage still reaches this sink.
	 */
	// The spend the scheduling gate admits paid requests against, so a memory
	// step's projected cost meets the same ceiling chat and dispatch do.
	const backgroundSessionSpendUsd = (): number =>
		result.getContract<SchedulingContract>("scheduling")?.preflight().currentUsd ?? observability?.sessionCost() ?? 0;
	const backgroundCallJournal = (targetId: string, modelId: string): CallJournalOptions | undefined => {
		const origin = session?.current();
		const acquire = observability?.acquireTelemetrySession;
		const target = providers.getTarget(targetId);
		const runtime = target ? providers.getRuntime(target.runtime) : null;
		if (!origin || !acquire || !target || !runtime) return undefined;
		return {
			origin,
			acquire,
			label: "memory",
			targetId,
			runtimeId: runtime.id,
			costProvenance: resolveEffectivePricing(target, runtime, modelId).provenance,
		};
	};
	const captureBackgroundMemoryUsage = () => {
		const meta = session?.current() ?? null;
		return captureTaskMemoryUsage({
			stateDir: clioStateDir(),
			sessionId: meta?.id ?? null,
			repoIdentity: meta ? meta.cwdHash || cwdHash(meta.cwd || process.cwd()) : null,
			...(observability === undefined ? {} : { observability }),
		});
	};
	// Lesson gate decisions reach the operator through the transcript notice
	// path once the chat loop has bound it; before that, a diagnostic line.
	const memoryNotice = (line: string): void => {
		if (deferredWatchdogNoticeSink) deferredWatchdogNoticeSink(line);
		else writeDiagnostic(`[clio-coder:memory] ${line}\n`);
	};
	const memoryDiagnostic = (line: string): void => writeDiagnostic(`[clio-coder:memory] ${line}\n`);
	const memoryFlowNoticedSessions = new Set<string | null>();
	const admitMemoryFlow: AdmitBackgroundModelFlow = (destination) => {
		const refusal = admitModelFlow(destination);
		const sessionId = session?.current()?.id ?? null;
		if (refusal !== null && !memoryFlowNoticedSessions.has(sessionId)) {
			memoryFlowNoticedSessions.add(sessionId);
			emitMemoryFlowNotice(
				{
					kind: "memory-flow-blocked",
					level: "info",
					message: `Memory skipped target ${destination.targetId}: ${refusal}`,
					targetId: destination.targetId,
					runtimeId: destination.runtimeId,
					model: destination.wireModelId,
				},
				bus,
			);
		}
		return refusal;
	};
	const getCurrentMemoryEnabled = (): boolean =>
		(effectiveSettingsForDispatch?.().context.memory ?? memorySettings).enabled;
	const memoryTelemetry = createTaskMemoryTelemetrySink();
	const historyReviews = createHistoryReviewActivity(
		memoryTelemetry,
		() => session?.current()?.id ?? null,
		MEMORY_INTERVENTION_ACTIVITY_LIMIT,
	);
	const memoryWorkspaceRoot = (): string => session?.current()?.cwd || process.cwd();
	// Bound late: the guardian needs the registration, and the registration
	// reports turn boundaries and step activity to the guardian.
	let memoryGuardian: MemoryGuardian | null = null;
	let isChatStreaming: () => boolean = () => false;
	let publishedGuardianState: MemoryGuardianState | null = null;
	/**
	 * The one guardian state every surface projects: a boundary step the
	 * middleware launched counts as reviewing even though the guardian did not
	 * start it.
	 */
	const currentGuardianState = (): MemoryGuardianState => {
		const state = memoryOwner.contract.guardianState();
		return state !== "off" && memoryOwner.contract.interventionStatus().stepInFlight ? "reviewing" : state;
	};
	const publishGuardianState = (): void => {
		const state = currentGuardianState();
		if (state === publishedGuardianState) return;
		publishedGuardianState = state;
		bus.emit(BusChannels.MemoryGuardianChanged, { sessionId: session?.current()?.id ?? null, state });
	};
	const memoryIntervention = memoryOwner.createIntervention({
		telemetry: memoryTelemetry,
		workspaceRoot: memoryWorkspaceRoot,
		onTurnBoundary: (kind) => memoryGuardian?.wake(kind === "end" ? "turn-end" : "turn-start"),
		onStepActivity: () => {
			publishGuardianState();
			memoryGuardian?.wake("step-settled");
		},
		...(memoryTrace === null ? {} : { onEnvelope: (envelope) => memoryTrace.record(envelope) }),
		// A headless run submits no further turn, so a detached step could only
		// finish after the process that would have read it has exited.
		deliversDeferredReminders: options.headless === undefined,
		onDeferredReminder: (message, isCurrent) => deferredMemoryReminderSink?.(message, isCurrent),
		getSettings: () => {
			const memory = effectiveSettingsForDispatch?.().context.memory ?? memorySettings;
			return {
				enabled: memory.enabled,
				everyNTools: memory.cadenceToolCalls,
				windowSteps: memory.trajectorySteps,
				maxTokens: memory.maxOutputTokens,
				timeoutMs: memory.timeoutMs,
			};
		},
		...createBackgroundMemoryRouting(
			providers,
			() => effectiveSettingsForDispatch?.(),
			bus,
			admitMemoryFlow,
			true,
			backgroundSessionSpendUsd,
			backgroundCallJournal,
		),
		captureStepUsage: captureBackgroundMemoryUsage,
	});
	middleware.registerHook(memoryIntervention);
	const memoryRouteAvailable = (): boolean => {
		const settings = effectiveSettingsForDispatch?.() ?? config?.get() ?? readSettings();
		const route = resolveMemoryRoute(settings);
		return settings.context.memory.enabled && Boolean(route.target?.trim()) && Boolean(route.model?.trim());
	};
	memoryGuardian = memoryOwner.startGuardian({
		// A headless run exits after its turn, so there is no idle time to use.
		enabled: () => options.headless === undefined && memoryRouteAvailable(),
		isForegroundActive: () => isChatStreaming(),
		live: memoryIntervention,
		scopeKey: () => `${session?.current()?.id ?? ""}\u0000${memoryWorkspaceRoot()}`,
		historySource: () =>
			createHistoryReviewSource({
				stateDir: clioStateDir(),
				cwd: memoryWorkspaceRoot(),
				currentSessionId: session?.current()?.id ?? null,
			}),
		client: createBackgroundMemoryRouting(
			providers,
			() => effectiveSettingsForDispatch?.(),
			bus,
			admitMemoryFlow,
			false,
			backgroundSessionSpendUsd,
			backgroundCallJournal,
		),
		settings: () => {
			const memory = effectiveSettingsForDispatch?.().context.memory ?? memorySettings;
			return { maxTokens: memory.maxOutputTokens, timeoutMs: memory.timeoutMs };
		},
		workspaceRoot: memoryWorkspaceRoot,
		captureStepUsage: captureBackgroundMemoryUsage,
		telemetry: historyReviews.telemetry,
		onStateChange: publishGuardianState,
	});
	let memoryProjection: {
		sessionId: string;
		pinned: string | null;
		entries: readonly SessionEntry[];
		active: readonly SessionEntry[];
		lesson: ReturnType<typeof completedLessonSource>;
		observation: {
			checkpoint: ReturnType<typeof observationCheckpoint>;
			units: ReturnType<typeof observationSourceUnits>;
		};
	} | null = null;
	const memoryActiveEntries = () => {
		const meta = session?.current();
		if (!meta || !session) return null;
		const entries = session.readEntries();
		const pinned = meta.pinnedLeafTurnId ?? null;
		// Session's frozen snapshot changes on append, replacement or external writes. A /tree pin is separate authority.
		if (
			memoryProjection?.entries !== entries ||
			memoryProjection.sessionId !== meta.id ||
			memoryProjection.pinned !== pinned
		) {
			const active = filterEntriesToActivePath(entries, session.tree(meta.id).leafId ?? undefined);
			const checkpointIndex = active.reduce(
				(last, entry, index) => (entry.kind === "compactionSummary" ? index : last),
				-1,
			);
			memoryProjection = {
				sessionId: meta.id,
				pinned,
				entries,
				active,
				lesson: completedLessonSource(active, meta.cwd),
				observation: {
					checkpoint: observationCheckpoint(active),
					units: observationSourceUnits(active.slice(checkpointIndex + 1)),
				},
			};
		}
		return memoryProjection;
	};
	/**
	 * The main route's live history capacity after fixed prompt and reserves,
	 * and how much of it the conversation occupies. Null while the live budget
	 * is unavailable or only a persisted measurement exists.
	 */
	const liveHistoryBudget = (): { usable: number; used: number } | null => {
		const budget = chat.inspectLiveBudget();
		if (
			budget.status !== "available" ||
			budget.view.historical ||
			!budget.view.breakdown ||
			budget.view.outputReserveTokens === null
		)
			return null;
		const view = budget.view;
		return {
			usable:
				(view.effectiveWindow ?? 0) -
				(view.outputReserveTokens ?? 0) -
				(view.breakdown?.systemPromptTokens ?? 0) -
				(view.breakdown?.toolSchemaTokens ?? 0) -
				64,
			used: (view.breakdown?.messageTokens ?? 0) + (view.breakdown?.pendingUserTokens ?? 0),
		};
	};
	memoryOwner.configure({
		stateDir: clioStateDir,
		dataDir: clioDataDir,
		cwd: memoryWorkspaceRoot,
		currentSession: () => {
			const meta = session?.current();
			return meta ? { id: meta.id, cwd: meta.cwd || process.cwd() } : null;
		},
		notice: memoryNotice,
		diagnostic: memoryDiagnostic,
		getLessonJudge: () => getMemoryLessonJudge?.() ?? null,
		observerHistoryTokens: () =>
			memoryObservationCapacity(providers, effectiveSettingsForDispatch?.() ?? getCurrentSettings()),
		lessonSource: () => {
			return memoryActiveEntries()?.lesson ?? null;
		},
		closedLessonSource: (sessionId) => {
			const ledger = sessionLedgersForRoots(clioStateDir(), [memoryWorkspaceRoot()]).find(
				(candidate) => candidate.sessionId === sessionId,
			);
			if (!ledger) return null;
			const read = parseSessionEntries(readFileSync(ledger.path, "utf8"), ledger.path);
			const active = filterEntriesToActivePath(read.entries, undefined);
			// A restricted ledger is reviewed only under its own session's flow admission.
			if (
				read.errors.length > 0 ||
				active.some((entry) => entry.kind === "custom" && entry.customType === FLOW_RESTRICTION_ENTRY_TYPE)
			)
				return null;
			const source = completedLessonSource(active, ledger.root);
			return source ? { scope: { sessionId, branchAnchorTurnId: active.at(-1)?.turnId ?? null }, source } : null;
		},

		settings: () => effectiveSettingsForDispatch?.().context.memory ?? memorySettings,
		source: () => {
			const meta = session?.current();
			const authority = memoryIntervention.captureMemoryAuthority();
			if (!meta || !session || !authority || authority.scope.sessionId !== meta.id) return null;
			const projection = memoryActiveEntries();
			if (!projection) return null;
			return {
				...authority.scope,
				...projection.observation,
			};
		},
		usableHistoryTokens: () => liveHistoryBudget()?.usable ?? 0,
		historyPressure: () => {
			const live = liveHistoryBudget();
			return live === null || live.usable <= 0 ? null : live.used / live.usable;
		},
		client: createBackgroundMemoryRouting(
			providers,
			() => effectiveSettingsForDispatch?.(),
			bus,
			admitMemoryFlow,
			false,
			backgroundSessionSpendUsd,
			backgroundCallJournal,
		),
		captureStepUsage: captureBackgroundMemoryUsage,
	});
	const guardedMemory = memoryGuardian;
	const unsubscribeMemoryLoop = bus.on(BusChannels.LoopBlocked, () => memoryIntervention.signalLoop());
	const unsubscribeGuardianWakes = [
		bus.on(BusChannels.SessionStart, () => guardedMemory.reset()),
		bus.on(BusChannels.ConfigHotReload, () => {
			memoryOwner.settingsChanged();
			guardedMemory.wake("settings");
		}),
		bus.on(BusChannels.ConfigNextTurn, () => {
			memoryOwner.settingsChanged();
			guardedMemory.wake("settings");
		}),
	];
	const disposeMemoryLifecycle = bindTaskMemoryLifecycle(bus, memoryOwner, {
		save: (sessionId) => {
			saveTaskBankSnapshot(clioStateDir(), sessionId, taskMemoryBank.snapshot());
		},
		restore: (sessionId) => {
			const snapshot = loadTaskBankSnapshot(clioStateDir(), sessionId);
			// Consumed on read: a crash after `/tree` cleared the bank must not find
			// this snapshot again on the next resume.
			deleteTaskBankSnapshot(clioStateDir(), sessionId);
			if (snapshot !== null && getCurrentMemoryEnabled()) taskMemoryBank.restore(snapshot);
		},
		discard: (sessionId) => deleteTaskBankSnapshot(clioStateDir(), sessionId),
	});
	termination.onDrain(() => {
		unsubscribeMemoryLoop();
		for (const off of unsubscribeGuardianWakes) off();
		disposeMemoryLifecycle();
	});
	// The main agent's first test runner in an attended session asks before it
	// runs repository code, whoever wrote that code (#377 follow-up). The
	// consent is per session: a park or a resume clears it. A headless run
	// denies every ask, so it keeps #377's allow.
	const sessionCodeConsent = createSessionCodeConsent({ headless: options.headless !== undefined });
	bus.on(BusChannels.SessionParked, () => sessionCodeConsent.reset());
	bus.on(BusChannels.SessionResumed, () => sessionCodeConsent.reset());
	// The codewiki refreshes the written paths when the context domain is loaded.
	middleware.registerHook(
		createFileMutationObserver(({ paths }) => {
			contextDomain?.noteFileChanges(paths);
		}),
	);
	// User-defined hooks: extensions and the project (.clio-coder/hooks.yaml,
	// .clio-coder/hooks.local.yaml) declare a conservative, receipted hook set on the
	// same effect machinery. A hook may add effects (including request block_tool)
	// but cannot grant a permission safety would deny. The protected-artifact
	// guard follows them to consume protect_path before tool execution.
	// The coordinator is the only writer of the "user-hooks" owner and the only
	// caller of the extensions reload; it publishes the extension generation
	// and the hook registrations with two adjacent assignments on one stack
	// and reloads plugin resources only after both. The boot generation is
	// published here too (the extensions bundle publishes nothing at start),
	// so no consumer ever sees extension resources paired with hooks from a
	// different generation. The owner slot is anchored here, so user hooks
	// keep evaluating before the protection consumer and assessors below.
	const hookReceipts = hookReceiptLog();
	let bootHookNotices = true;
	const reloadPlugins = () =>
		reloadPluginResourcesAndNotify(process.cwd(), (event) => bus.emit(BusChannels.PluginsReloaded, event));
	const reloadClasses = createReloadClasses({
		config,
		bus,
		cwd: () => process.cwd(),
		library: () => committedPluginSnapshot(process.cwd()),
		reloadLibrary: reloadPlugins,
		extensions: () => extensions?.snapshot()?.packages ?? [],
	});
	// Every main session hosts api 2 runtimes: the TUI itself, a headless run
	// and ACP through `startExtensionHost`. Workers never do.
	const runtimeHooks = createExtensionRuntimeHookBridge();
	const extensionReload = createExtensionReloadCoordinator({
		extensions,
		middleware,
		runtimeHooks,
		// The gateway is registered after this coordinator; the lookup runs at call time.
		mcpOwner: (tool) => toolBootstrap.mcpCapabilities?.ownerIdOf(tool) ?? null,
		cwd: () => process.cwd(),
		recordReceipt: extensionHookReceiptSink(hookReceipts, () => session?.current()?.id),
		report: (line) => {
			if (reloadClasses.captureIssue(line)) return;
			if (!interactive) process.stderr.write(`${line}\n`);
			else if (bootHookNotices) initialNotices.push(line);
			else bus.emit(BusChannels.ExtensionsLoadIssue, { message: line });
		},
		onCommitted: () => {
			if (!reloadClasses.active) reloadPlugins();
		},
	});
	workerHookSource = extensionReload.workerHooks;
	await bootPhaseBoundary?.();
	extensionReload.applyBoot();
	middleware.registerHook(protectedArtifactsGuard);
	bootHookNotices = false;
	await bootPhaseBoundary?.();
	termination.onDrain(() => hookReceipts.flush());
	// Autonomy is hot-reloaded for interactive and headless admissions. ACP
	// server prompts use the snapshot captured at session/new.
	let activeAcpSessionAutonomy: AutonomyLevel | null = null;
	// Root outside a container never runs yolo (#407). The uid and the
	// container do not change while the process runs, so it is read once.
	const yoloRefusal = yoloRootRefusal();
	// The one effective-autonomy resolution. Every admission surface (registry
	// admission, dispatch plan provenance, ACP session snapshot) resolves
	// through these two functions so a fallback added to one surface cannot
	// silently skip another. The root refusal is enforced here too, so no
	// surface that reaches yolo some other way (a hot-reloaded settings file)
	// runs it.
	const resolveBaselineAutonomy = (): AutonomyLevel => {
		const level =
			effectiveSettingsForDispatch?.().safety.autonomy ??
			(options.headless !== undefined ? (options.headless.autonomy ?? "default") : undefined) ??
			options.autonomy ??
			(config?.get() ?? readSettings()).safety.autonomy ??
			"default";
		return level === "yolo" && yoloRefusal !== null ? "default" : level;
	};
	const resolveEffectiveAutonomy = (): AutonomyLevel => {
		const level = activeAcpSessionAutonomy ?? resolveBaselineAutonomy();
		return level === "yolo" && yoloRefusal !== null ? "default" : level;
	};
	const skillDiscoveryEnabled = options.noSkills !== true && options.headless?.noSkills !== true;
	let readySkillSnapshot: { key: string; count: number; skills: ReturnType<typeof modelVisibleSkills> } | undefined;
	const getReadySkillCount = (): number => {
		if (!resources) return 0;
		const cwd = process.cwd();
		// Skill loading reads and hashes the filesystem. Reuse the count across
		// warm/real requests and reminders until the same source epoch that
		// invalidates prompt composition changes (/library reload, config, etc.).
		if (!prompts) {
			const skills = modelVisibleSkills(resources.skills(cwd).items);
			readySkillSnapshot = { key: cwd, count: skills.length, skills };
			return skills.length;
		}
		const key = JSON.stringify([
			cwd,
			prompts.inputEpoch(),
			skillDiscoveryEnabled,
			config?.get().integrations.projectResources.trustProjectImports === true,
			options.skillPaths ?? options.headless?.skillPaths ?? [],
		]);
		if (readySkillSnapshot?.key === key) return readySkillSnapshot.count;
		const skills = modelVisibleSkills(resources.skills(cwd).items);
		const count = skills.length;
		readySkillSnapshot = { key, count, skills };
		return count;
	};
	// FW-1: task-ranked advice is cheap enough for attended and headless turns;
	// it names loadable workflows directly and preserves the activation policy.
	if (resources && skillDiscoveryEnabled) {
		middleware.registerHook(
			createSkillsReminderRegistration({
				getTurnConstraints: () => chat.currentTurnConstraints?.(),
				contextPlacement: () => {
					const spec = toolRegistry.get(ToolNames.Context);
					return spec ? surfaceSpecPlacement(spec, null) : "direct";
				},
				countModelVisibleSkills: getReadySkillCount,
				rankCapabilities: (task) => {
					const constraints = chat.currentTurnConstraints?.();
					if (!turnAllowsTool(constraints, "gateway")) return [];
					const surface = new Set(
						effectiveToolNames({ registry: toolRegistry, ...(constraints ? { turnConstraints: constraints } : {}) }),
					);
					return capabilityGate.rank({
						kind: "capabilities",
						task,
						limit: 3,
						candidates: toolRegistry
							.listGateway()
							.filter((spec) => surface.has(spec.name) && surfaceSpecPlacement(spec, surface) === "gateway")
							.map((spec) => ({ id: spec.name, description: spec.description })),
					});
				},
				rankSkills: (task) => {
					getReadySkillCount();
					return capabilityGate.rank({
						kind: "skills",
						task,
						workspace: process.cwd(),
						candidates: (readySkillSnapshot?.skills ?? []).map((skill) => ({
							id: skill.name,
							description: skill.description,
							triggers: Array.isArray(skill.metadata.triggers)
								? skill.metadata.triggers.filter((value): value is string => typeof value === "string")
								: [],
						})),
					});
				},
				// Same lookup context(scope="skills") lists under its Marketplace
				// heading, minus what is already installed, so the count the
				// reminder quotes is the count the listing will show.
				countInstallableSkills: () => {
					if (!skillDiscoveryEnabled) return 0;
					const installed = installedSkillNames(resources.skills(process.cwd()).items, process.cwd());
					return discoverMarketplaceSkills({ cwd: process.cwd() }).skills.filter((skill) => !installed.has(skill.name))
						.length;
				},
				modelMayActivateSkills: () => modelMayActivateSkills(),
			}),
		);
	}
	// Marketplace self-promotion: coordinator-only by this wiring (never a
	// dispatch worker), local matcher and operator-consented installs at every autonomy level. The
	// registration also checks the own-marketplace source gate before installing.
	if (resources && skillDiscoveryEnabled) {
		middleware.registerHook(
			createMarketplaceOfferRegistration({
				interactive,
				listInstalledSkillNames: () => [...installedSkillNames(resources.skills(process.cwd()).items, process.cwd())],
				listMarketplaceEntries: () => discoverMarketplaceSkills({ cwd: process.cwd() }).skills,
				installEntry: (entry, scope) => {
					const installed = installSkill({ source: `skill:${entry.name}`, scope, name: entry.name, cwd: process.cwd() });
					return {
						path: installed.path,
						sourceUrl: installed.sourceUrl,
						installedHash: installed.installedHash,
						warnings: installed.warnings,
					};
				},
			}),
		);
	}
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	// The safety judge reviews what autonomy default would park for the operator
	// against the operator's own messages. Its round goes through System One's
	// one-shot port and request admission, built further down; nothing calls the
	// judge before the first tool call.
	const safetyJudge = createSafetyJudgeHost({
		settings: () => getCurrentSettings(),
		complete: createSafetyJudgeCompletion({
			providers,
			oneShot: () => safetyJudgeOneShot,
			flowRefusal: (destination) => admitModelFlow(destination),
		}),
		session: () => session,
		safety,
	});
	// The git hook drift guard takes its baseline now, at session start: a hook
	// file added or changed later, however it got there, makes the next git
	// command that would run it outside the sandbox an operator-only ask.
	const hookFingerprinter = createGitHooksFingerprinter(process.cwd());
	const hookDrift = createGitHookDriftGuard({
		workspace: process.cwd(),
		fingerprint: () => hookFingerprinter.fingerprint(),
		// The cheap path Clio's own status and diff probes check before each run.
		config: (dir) => hookFingerprinter.config(dir),
		onDrift: (changes) =>
			bus.emit(BusChannels.GitHooksChanged, {
				message: gitHookDriftNotice(changes, process.cwd()),
				changes: changes.map(({ path, kind, key, size, firstLine }) => ({
					path,
					kind,
					...(key !== undefined ? { key } : {}),
					size,
					firstLine,
				})),
			}),
	});
	// Git Clio runs itself (task worktrees, landing worker results) runs
	// outside any sandbox, so after drift it runs with hooks off at default
	// (src/domains/safety/internal-git-policy.ts, src/core/internal-git.ts).
	installInternalGitPolicy(
		createInternalGitPolicy({
			workspace: process.cwd(),
			guard: hookDrift,
			autonomy: resolveEffectiveAutonomy,
			emptyHooksDir: join(clioStateDir(), "git", "no-hooks"),
			onDrift: (record) =>
				bus.emit(BusChannels.InternalGitDrift, {
					message: record.message,
					announce: record.announce,
					operation: record.operation,
					hardened: record.hardened,
					outcome: record.outcome,
					changes: record.changes.map(({ path, kind, key }) => ({
						path,
						kind,
						...(key !== undefined ? { key } : {}),
					})),
				}),
		}),
	);
	// The same seat answers dispatched workers' asks, so worker and main-session
	// blocks share one session's escalation counts.
	workerAskJudgeForDispatch = {
		seat: () => safetyJudge,
		autonomy: resolveEffectiveAutonomy,
		hookDrift: () => hookDrift,
	};
	// Sessions whose snapshot start-of-session prune has run in this process.
	const snapshotPrunedSessions = new Set<string>();
	const toolRegistry = createRegistry({
		safety,
		middleware,
		onMiddlewareEffects: (effects) => middlewareToolChoice.apply(effects),
		// Awaited extension hooks return after the guard's own before_tool step.
		absorbAwaitedEffects: (effects, input) => protectedArtifactsGuard.absorbAwaited(input, effects),
		autonomy: resolveEffectiveAutonomy,
		// Only this registry carries the operator's own scope (#419): its yolo,
		// and its containment at default, where shell calls run in the
		// main-session sandbox and a snapshot precedes a destructive call.
		scratchRoots: () => getCurrentSettings().safety.scratchRoots,
		scriptSandbox: () => yoloScriptSandboxState(getCurrentSettings().safety.sandbox, sandboxAvailability()),
		containment: () => {
			const safety = getCurrentSettings().safety;
			return {
				sandbox: mainShellContained(safety.sandbox, sandboxAvailability()),
				snapshots: safety.snapshots !== "off" && workspaceSnapshotRepositoryPresent(process.cwd()),
			};
		},
		sandboxEnv: () => sandboxEnvPolicy(getCurrentSettings()),
		sandboxUnixSockets: () => getCurrentSettings().safety.sandboxUnixSockets,
		mutationEpoch: (turnId) => loopGuard.mutationEpoch(turnId),
		// System One reads what the deterministic checks cannot: content other people
		// wrote, and an unrecognized command that yolo would run unread. Both are read
		// through the host so the registry never learns which engine answered, and
		// both are experimental and only record: neither holds, parks or changes a
		// call. The result screen reads on every surface. The gate is wired on the
		// interactive registry alone because headless and ACP have nobody to label
		// what it recorded.
		screenToolResult: (source, content, ref, restrictions) =>
			systemOneHost.screenToolResult(source, content, ref, restrictions),
		flow: {
			carried: () => flowLedger.current(),
			refusal: () => flowLedger.refusal(),
			absorb: (set, origin) => flowLedger.absorb(set, origin),
			// The gateway is registered after this registry; the lookup runs at call time.
			mcpTransport: (tool) => toolBootstrap.mcpCapabilities?.transportOf(tool) ?? null,
		},
		...(interactive ? { observeToolCallGate: (subject, ref) => systemOneHost.observeToolCallGate(subject, ref) } : {}),
		sessionCodeConsent,
		safetyJudge,
		hookDrift,
		// Recoverability for the main agent on every surface; workers never snapshot.
		workspaceSnapshot: async ({ sessionId: requested, ...request }) => {
			if (getCurrentSettings().safety.snapshots === "off") return null;
			const sessionId = requested ?? session?.current()?.id;
			if (sessionId === undefined) return null;
			const outcome = await createWorkspaceSnapshots({ stateDir: clioStateDir(), sessionId, cwd: process.cwd() }).snapshot(
				request,
			);
			// A session's first snapshot is when it starts holding snapshot state,
			// so it is also when idle sessions' refs and state are pruned.
			if (!snapshotPrunedSessions.has(sessionId)) {
				snapshotPrunedSessions.add(sessionId);
				void pruneWorkspaceSnapshots({ stateDir: clioStateDir(), cwd: process.cwd(), keepSessionId: sessionId }).catch(
					() => undefined,
				);
			}
			return outcome;
		},
		// `acp` takes no read-only flag; only a client ceiling makes its turns read-only.
		...(acpMode ? { hostReadOnlySource: "acp-ceiling" as const } : {}),
	});
	// Reloaded settings can change what refused a call, so the memory of it goes.
	bus.on(BusChannels.ConfigHotReload, () => toolRegistry.forgetRefusals());
	const mainPermissionOrigin = acpMode ? "acp-server" : "main";
	toolRegistry.onPermissionRequired((call, decision, meta) => {
		bus.emit(BusChannels.PermissionRequested, {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
			...(meta.turnId !== undefined ? { turnId: meta.turnId } : {}),
			origin: mainPermissionOrigin,
			axis: meta.axis,
			...(decision.kind === "ask" ? { rejection: decision.rejection } : {}),
			...(decision.policy?.ruleId !== undefined ? { ruleId: decision.policy.ruleId } : {}),
			...(decision.policy?.policySource !== undefined ? { policySource: decision.policy.policySource } : {}),
			...(decision.policy?.reasonCode !== undefined ? { reasonCode: decision.policy.reasonCode } : {}),
		});
	});
	let askUserHandler: AskUserHandler | null = acpInterviewChannel?.ask ?? null;
	// ask_user is a human interview tool, so it is registered only where a person
	// answers: the TUI, or an ACP client that advertised interviews. Headless and
	// plain ACP surfaces have no operator, so the tool is absent there (documented
	// in `clio-coder run --help`). Skills that interview fall back to their stated
	// defaults when the tool is absent.
	const askUserBridge: AskUserHandler = async (questions, invokeOptions) =>
		askUserHandler ? await askUserHandler(questions, invokeOptions) : cancelledAskUserResult();
	const userTasks = createUserTasksStore({ cwd: process.cwd() });
	// One task board per orchestrator: the tasks tool mutates it, the turn-end
	// open-tasks nudge reads it, and the footer/overlay render it. Keyed on the
	// current session id so resume/fork/new refolds it from taskLedger entries.
	// Folding through filterEntriesToActivePath (not the raw file) is what
	// keeps a /resume from picking up whichever branch happened to write its
	// taskLedger entry last in file order; readEntries here used to skip that
	// filter entirely (issue #94).
	const taskBoard = createTaskBoardStore({
		getSessionId: () => session?.current()?.id ?? null,
		readEntries: () => {
			const meta = session?.current();
			if (!session || !meta) return [];
			const leafTurnId = session?.tree(meta.id).leafId ?? undefined;
			return filterEntriesToActivePath(session.readEntries(), leafTurnId);
		},
		appendEntry: (entry) => {
			session?.appendEntry(entry);
		},
	});
	// Prime the projection once at composition. Interactive repaint paths use
	// cachedSnapshot() below, so a first paint can never become a ledger read.
	taskBoard.snapshot();
	const decisionBoard = createDecisionBoardStore({
		getSessionId: () => session?.current()?.id ?? null,
		readEntries: () => {
			const meta = session?.current();
			if (!session || !meta) return [];
			const leafTurnId = session?.tree(meta.id).leafId ?? undefined;
			return filterEntriesToActivePath(session.readEntries(), leafTurnId);
		},
		getActiveLeafTurnId: () => {
			const meta = session?.current();
			return meta ? (session?.tree(meta.id).leafId ?? null) : null;
		},
		appendEntry: (entry) => {
			if (!session) throw new Error("decision board: no session ledger is available");
			session.appendEntry(entry);
		},
	});
	// Every Clio-spawned commit from this session is stamped with the decisions
	// active on the board at spawn time, the same way it is stamped as assisted.
	setCommitDecisionRefsProvider(() => activeDecisionRefs(decisionBoard.snapshot()));
	// getSessionId alone never notices a /tree switch: it moves the active
	// append point inside the same session, so the id-keyed cache above kept
	// showing the abandoned branch's board (issue #94). SessionTurnSwitched is
	// the signal that switch actually happened; invalidate() forces the next
	// read to refold from the now-current leaf.
	bus.on(BusChannels.SessionTurnSwitched, () => {
		taskBoard.invalidate();
		// The tree switch is the I/O boundary: refold eagerly here so the 250-ms
		// island ticker remains a cache-only consumer after changing branches.
		taskBoard.snapshot();
		decisionBoard.invalidate();
	});
	// Link in-flight dispatch runs to the live board via the ledger's
	// activeRunIds field: a run is tracked from the moment its child process is
	// live until it finalizes either way. attach/detach are no-ops when no board
	// is declared, so an ambient dispatch never forces a board into existence.
	bus.on(BusChannels.DispatchStarted, (payload) => {
		if (typeof payload?.runId === "string") taskBoard.attachRun(payload.runId);
	});
	// The receipt's flow label is absorbed the moment a run settles, attached or
	// detached, so any later injection of its output (a collect, a continuation,
	// a resume) already finds the session ledger carrying it.
	const absorbDispatchFlow = (payload: { runId?: unknown; flowRestrictions?: unknown } | undefined): void => {
		if (typeof payload?.runId !== "string" || !isFlowRestrictionSet(payload.flowRestrictions)) return;
		flowLedger.absorb(payload.flowRestrictions, { tool: "dispatch", toolCallId: payload.runId });
	};
	bus.on(BusChannels.DispatchCompleted, (payload) => {
		if (typeof payload?.runId !== "string") return;
		taskBoard.detachRun(payload.runId);
		absorbDispatchFlow(payload);
		foldDispatchSkillActivations(session, payload);
	});
	bus.on(BusChannels.DispatchFailed, (payload) => {
		if (typeof payload?.runId !== "string") return;
		taskBoard.detachRun(payload.runId);
		absorbDispatchFlow(payload);
		// A run that failed after loading a skill is the case the operator most
		// needs the provenance for, and the receipt already carried it here.
		foldDispatchSkillActivations(session, payload);
	});
	// Operator-initiated backgrounding is a TUI affordance: the registry is the
	// one object the dispatch tool and the keypress both hold.
	const dispatchBackground = createDispatchBackgroundRegistry();
	// The music pane rides the same pane host. It exists on every panes boot so
	// `/music` can name what is missing; the model's `music` tool is gated
	// separately at registration below.
	const music =
		withPanes && mux
			? withPanes.createMusicSession({
					mux,
					getSettings: () => getCurrentSettings().integrations.music,
					getCwd: () => process.cwd(),
				})
			: null;
	// One `PanesOperations` instance drives both the `panes` tool and the
	// `/panes` slash command, so the model and the operator cannot be told
	// different things about the same pane. It also owns the no-mux Yazi chooser,
	// while model tool registration below remains gated on a live pane host. The
	// music facts it reports come from the session whether or not the model may
	// control the player: what is playing is knowledge, control stays gated.
	const panes =
		withPanes && mux
			? withPanes.createPanesRuntime({
					mux,
					getSettings: () => getCurrentSettings(),
					getDispatchSnapshot: () => dispatch.snapshot(),
					agentRefusal: () =>
						flowUnmediatedAgentRefusal(safety?.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY, null),
					getCwd: () => process.cwd(),
					...(music ? { musicState: () => music.state() } : {}),
				})
			: null;

	// The effective view has to exist before anything below composes against it.
	// `systemOne.bound("consult")` reads it while the tool registry is assembled,
	// and a `const` declared after that call is still in its temporal dead zone:
	// bound() swallows the ReferenceError, so every start read as an unbound site
	// and the consult tool never registered.
	// Live routing is owned by this process. Seed it once from saved settings
	// (with any headless CLI overrides baked in); from here on every consumer
	// reads the effective view — shared snapshot + session routing overlay — so
	// another process writing settings.yaml can update defaults and the
	// target catalog but never redirect this session's routing.
	const initialRoutingSettings = applyHeadlessSettingsOverlay(config?.get() ?? readSettings(), options.headless);
	if (options.headless?.model !== undefined && providers) {
		// An explicit typed model resolves once, before the concrete session route is seeded (#416).
		try {
			await providers.probeAllLive();
		} catch (err) {
			bootStderr(
				`Clio Coder: model refresh failed; resolving cached catalog: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		const selected = resolveModelReference(
			options.headless.model,
			options.headless.target === undefined
				? providers
				: { ...providers, list: () => providers.list().filter((status) => status.target.id === options.headless?.target) },
			{
				use: "chat",
				...(initialRoutingSettings.chat.target ? { preferTarget: initialRoutingSettings.chat.target } : {}),
			},
		);
		if (selected.ref) {
			initialRoutingSettings.chat.target = selected.ref.target;
			initialRoutingSettings.chat.model = selected.ref.model;
			if (options.headless.thinking === undefined && selected.ref.thinkingLevel) {
				initialRoutingSettings.chat.thinkingLevel = selected.ref.thinkingLevel;
			}
			if (selected.warning) bootStderr(`Clio Coder: ${selected.warning}\n`);
		} else if (selected.error || options.apiKey) {
			const exitCode = options.apiKey || selected.error?.includes("not chat-eligible") ? 2 : 1;
			writeRunDiagnostic(
				`Clio Coder: ${selected.error ?? "--api-key supplied but the model target could not be resolved"}\n`,
			);
			await termination.shutdown(exitCode);
			return { exitCode, bootTimeMs: timer.snapshot().totalMs };
		}
	}
	const sessionRouting = seedSessionRouting(initialRoutingSettings);
	// Non-routing settings a session changed "for this session only" via the
	// /settings overlay. Layered under the routing overlay in the effective
	// view, so the live session reflects them immediately while settings.yaml
	// (the global default for new sessions) stays untouched until the operator
	// chooses to save globally.
	// Overrides are keyed by settings path, the same ids the /settings overlay
	// commits (`setAtPath` walks the dotted path). The headless `--autonomy`
	// flag was keyed by the bare word, which wrote a top-level `autonomy` key
	// nothing reads, so `run --autonomy yolo` compiled and admitted at
	// whatever settings.yaml said.
	// The interactive `clio-coder --autonomy <level>` seeds the same override.
	// yolo is a grant from a present human to the main agent. A headless run has
	// no human to have granted it, so it runs at default unless its own command
	// line says --autonomy yolo; a settings.yaml yolo does not carry over (D1).
	const startupAutonomy = options.headless !== undefined ? (options.headless.autonomy ?? "default") : options.autonomy;
	if (
		options.headless !== undefined &&
		options.headless.autonomy === undefined &&
		(config?.get() ?? readSettings()).safety.autonomy === "yolo"
	) {
		process.stderr.write(
			"clio-coder run: autonomy default (settings.yaml sets yolo, which a headless run takes only from --autonomy yolo)\n",
		);
	}
	// An interactive session that would start at yolo holds at default when yolo
	// is refused here, and until the operator has accepted it once; the
	// acceptance card then asks (#407). Headless `--autonomy yolo` and an ACP
	// client's mode choice count as acceptance.
	const savedSafety = (config?.get() ?? readSettings()).safety;
	let bootAutonomy = startupAutonomy;
	let yoloHeldAtBoot = false;
	if (options.headless === undefined && (startupAutonomy ?? savedSafety.autonomy) === "yolo") {
		if (yoloRefusal !== null) {
			bootAutonomy = "default";
			if (interactive) initialNotices.push(`Autonomy is default. ${yoloRefusal}`);
			else process.stderr.write(`clio-coder: autonomy default. ${yoloRefusal}\n`);
		} else if (interactive && savedSafety.yoloAccepted !== true) {
			bootAutonomy = "default";
			yoloHeldAtBoot = true;
		}
	}
	const startupOverrides: SessionOverrides = new Map(
		bootAutonomy === undefined ? [] : [["safety.autonomy", bootAutonomy]],
	);
	if (options.demo !== undefined) startupOverrides.set("interface.demo", options.demo);
	const conversationOverrides = new Map<string, SessionOverrides>();
	let overrideSessionId = session?.current()?.id ?? null;
	let sessionOverrides: SessionOverrides = new Map();
	let forkParentId: string | null = null;
	let loadingSessionId: string | null = null;
	const syncConversationOverrides = (resumedId: string | null = loadingSessionId): boolean => {
		const incomingId = session?.current()?.id ?? null;
		if (incomingId === overrideSessionId) return false;
		if (overrideSessionId !== null) conversationOverrides.set(overrideSessionId, sessionOverrides);
		// AUD-3 finding 1: a draft's choices belong to its first newly created
		// conversation, while resuming an existing ID discards the draft. A fork
		// continues its parent, so inherit a copy; later resumes load its own map.
		// SessionResuming marks loads before replacement, so earlier resume observers see the same choice.
		let incomingOverrides = incomingId === null ? undefined : conversationOverrides.get(incomingId);
		if (incomingOverrides === undefined && incomingId !== null && incomingId !== resumedId) {
			if (overrideSessionId === null) incomingOverrides = sessionOverrides;
			else if (forkParentId === overrideSessionId) incomingOverrides = new Map(sessionOverrides);
		}
		overrideSessionId = incomingId;
		sessionOverrides = incomingOverrides ?? new Map();
		forkParentId = null;
		loadingSessionId = null;
		return true;
	};
	// The effective view is derived by deep-cloning the saved snapshot, and it
	// is read on the tool-admission hot path (every call resolves autonomy
	// through it). Memoize on the two things it depends on: the config
	// domain's snapshot identity (swapped wholesale on every update and
	// external hot reload) and a generation counter bumped by every session
	// routing/override mutation below. Without this, one tool call cost a full
	// settings structuredClone.
	let sessionStateGeneration = 0;
	let cachedSettingsBase: Readonly<ClioSettings> | null = null;
	let cachedSettingsGeneration = -1;
	let cachedSettingsView: ClioSettings | null = null;
	const bumpSessionState = (): void => {
		sessionStateGeneration += 1;
		const settings = getCurrentSettings();
		configureGuardrails(guardrailValuesFromSettings(settings));
		configureRunEventJournal(settings.fleet.history.journal);
		setGitCommitAttributionEnabled(settings.integrations.git.commitAttribution);
	};
	const getCurrentSettings = (): ClioSettings => {
		// AUD-3 finding 1: lazy creates and forks do not emit SessionResumed.
		// Check identity before a cached view can expose the outgoing conversation.
		if (syncConversationOverrides()) bumpSessionState();
		// Recents live in the data dir (core/recent-models.ts), never in
		// settings.yaml; consumers that need them call listRecentModels
		// directly, so an Alt+M pick in another session does not churn the
		// config watcher here.
		const base = config?.get();
		// No config domain (unit tests, degraded boot): readSettings() returns a
		// fresh object every call, so there is nothing stable to key a cache on.
		if (base === undefined) {
			return applySessionRouting(
				applyOverrides(readSettings(), new Map([...startupOverrides, ...sessionOverrides])),
				sessionRouting,
			);
		}
		if (
			cachedSettingsView !== null &&
			cachedSettingsBase === base &&
			cachedSettingsGeneration === sessionStateGeneration
		) {
			return cachedSettingsView;
		}
		const view = applySessionRouting(
			applyOverrides(base, new Map([...startupOverrides, ...sessionOverrides])),
			sessionRouting,
		);
		cachedSettingsBase = base;
		cachedSettingsGeneration = sessionStateGeneration;
		cachedSettingsView = view;
		return view;
	};
	const persistCurrentThinkingLevel = (): void => {
		const meta = session?.current();
		if (!session || !meta) return;
		const chat = getCurrentSettings().chat;
		const level = chat.thinkingLevel ?? "off";
		const resolved =
			chat.target && chat.model
				? resolveRuntimeTarget(providers, {
						targetId: chat.target,
						wireModelId: chat.model,
						requestedThinkingLevel: level,
						use: "orchestrator",
						requireTools: false,
					})
				: null;
		const effort = resolved?.ok
			? (resolved.target.modelRuntime.thinking.effort ??
				(resolved.target.effectiveThinkingLevel === "off" ? "none" : resolved.target.effectiveThinkingLevel))
			: undefined;
		appendSessionThinkingLevel(session, level, effort, session.tree(meta.id).leafId);
	};

	effectiveSettingsForDispatch = getCurrentSettings;
	// Recomputed on every read from live state, so a compaction summary that
	// dropped a session-only route cannot change what Clio says about it (DF-7).
	const routeProvenance = (): RouteProvenance => {
		const sources = config?.sources?.() ?? {};
		return resolveRouteProvenance(getCurrentSettings(), config?.get() ?? readSettings(), (path) =>
			settingsSourceFor(sources, path),
		);
	};
	bumpSessionState();
	// AUD-3 finding 1: resume/branch switches publish after replacement; new
	// conversations and forks only park, so refresh those after replacement.
	const unsubscribeConversationOverrides = [
		bus.on(BusChannels.SessionResuming, ({ sessionId }) => {
			loadingSessionId = sessionId;
			queueMicrotask(() => {
				if (loadingSessionId === sessionId) loadingSessionId = null;
			});
		}),
		bus.on(BusChannels.SessionResumed, ({ sessionId }) => {
			if (syncConversationOverrides(sessionId)) bumpSessionState();
		}),
		bus.on(BusChannels.SessionParked, ({ sessionId, reason }) => {
			forkParentId = reason === "fork" ? sessionId : null;
			queueMicrotask(() => getCurrentSettings());
		}),
	];
	termination.onDrain(() => {
		for (const unsubscribe of unsubscribeConversationOverrides) unsubscribe();
	});
	// The config bundle publishes saved values on reload; session-scoped
	// overrides must win, so re-derive every process-local projection from the
	// effective session view after it.
	const unsubscribeSettingsProjectionSync = [BusChannels.ConfigHotReload, BusChannels.ConfigNextTurn].map((channel) =>
		bus.on(channel, () => bumpSessionState()),
	);
	termination.onDrain(() => {
		for (const unsubscribe of unsubscribeSettingsProjectionSync) unsubscribe();
	});
	// System One: one recorder and one instance for the process. Every call
	// leaves a compact row that reaches the ledger at the next turn boundary or
	// settle, and, when the operator opted in, a redacted record for the dataset.
	const currentSessionId = (): string | null => session?.current()?.id ?? null;
	const systemOneRecorder = createRecorder({
		currentSession: currentSessionId,
		settings: () => getCurrentSettings(),
		// The park flush writes a session's rows before it closes, so a call that
		// started in a session that is no longer current is a late answer for a ledger
		// this process has closed; its dataset copy, when recording, is already queued
		// under the session it started in.
		appendSessionRow: () => {},
	});
	const decisionUsage = createDecisionUsageTally(systemOneRecorder);
	const sessionScheduling = result.getContract<SchedulingContract>("scheduling");
	const systemOneAdmissionDeps = {
		providers,
		...(sessionScheduling ? { scheduling: sessionScheduling } : {}),
		...(observability ? { observability } : {}),
		getCeilingUsd: () => getCurrentSettings().safety.limits.sessionCostUsd,
		currentSession: currentSessionId,
		repoIdentity: () => {
			const meta = session?.current();
			return meta ? meta.cwdHash || cwdHash(meta.cwd || process.cwd()) : null;
		},
		stateDir: clioStateDir(),
	};
	const admitSystemOneRequest = createSystemOneRequestAdmission(systemOneAdmissionDeps);
	const safetyJudgeOneShot = createSystemOneOneShot(
		providers,
		createSystemOneRequestAdmission({ ...systemOneAdmissionDeps, label: "safety-judge" }),
	);
	const systemOneEndpointCapacity = (targetId: string): number => {
		const target = providers.getTarget(targetId);
		const key = target === null ? null : canonicalEndpointKey(target);
		if (key === null) return Number.POSITIVE_INFINITY;
		const capacity = resolveEndpointCapacities({
			statuses: providers.list(),
			targets: getCurrentSettings().targets,
			runtimeFor: (runtimeId) => providers.getRuntime(runtimeId),
		})[key];
		// An endpoint with no fixed slot count (a cloud API, vllm, sglang) reports no
		// limit, and the engine applies its own default.
		return capacity?.limit ?? Number.POSITIVE_INFINITY;
	};
	const systemOneCore = createSystemOne({
		settings: () => capabilitySettings(getCurrentSettings()),
		// Every engine request is judged against the restrictions it inherited
		// before a byte leaves, typed and LLM engines alike. The runner treats a
		// throw as abstention, so this only ever returns.
		flowCheck: (request) => {
			const refusal = flowLedger.refusal();
			if (refusal !== null) return { allowed: false, reason: refusal };
			const inherited = isFlowRestrictionSet(request.inherited) ? request.inherited : null;
			const reason = flowTransferRefusal(
				safety.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY,
				mergeFlowRestrictions(inherited, flowLedger.current()),
				resolveModelDestination({
					targetId: request.destination.targetId,
					runtimeId: request.destination.runtime,
					url: request.destination.url,
					model: request.destination.model,
				}),
			);
			return reason === null ? { allowed: true } : { allowed: false, reason };
		},
		providers,
		credentialsPresent,
		oneShot: createSystemOneOneShot(providers, admitSystemOneRequest),
		admitLlmRequest: admitSystemOneRequest,
		// Each call is bound to the session it starts in. A slow turn-end answer can
		// settle after /new, /resume or a branch switch, and reading the session when
		// it settles would file it under the wrong one.
		currentSession: currentSessionId,
		endpointCapacity: systemOneEndpointCapacity,
		recorder: () => decisionUsage.recorder,
	});
	// Every caller that reaches System One through this instance inherits the
	// session's restrictions on its request unless it already names a narrower
	// set, so the flow check above sees them whoever asked.
	const systemOne: SystemOneInstance = {
		bound: (site) => systemOneCore.bound(site),
		shadowed: (site, moment) => systemOneCore.shadowed(site, moment),
		describe: () => systemOneCore.describe(),
		identity: (site) => systemOneCore.identity?.(site) ?? null,
		settled: (maxWaitMs) => systemOneCore.settled(maxWaitMs),
		...(systemOneCore.limits !== undefined ? { limits: (site, task) => systemOneCore.limits?.(site, task) ?? null } : {}),
		run: (site, object, options) => {
			const carried = flowLedger.current();
			const given = options as { flow?: unknown } | undefined;
			const flow = given?.flow !== undefined ? given.flow : carried;
			const merged = { ...(options ?? {}), ...(flow !== null && flow !== undefined ? { flow } : {}) };
			return systemOneCore.run(site, object, merged);
		},
	};
	getMemoryLessonJudge = () => (systemOne.bound("consult") ? createMemoryLessonJudge(systemOne) : null);
	// How each approval the main agent parked was answered, joined to the card's
	// advisory and the yolo gate by the request id both carried.
	termination.onDrain(
		observePermissionOutcomes({
			bus,
			registry: toolRegistry,
			record: (outcome) => systemOneRecorder.outcome(outcome),
		}),
	);
	const followUps = createFollowUpTracker((outcome) => systemOneRecorder.outcome(outcome));
	const systemOneHost = createSystemOneHost({
		systemOne,
		usage: decisionUsage,
		readSessionEntries: () => readCurrentSessionEntries(),
		listRecipes: () =>
			agents !== undefined && getCurrentSettings().fleet.speculativeDispatch
				? agents
						.listSpecs()
						.filter((spec) => spec.audience !== "internal")
						.map((spec) => ({
							id: spec.id,
							description: spec.description,
							...(spec.category !== "internal"
								? { categories: [{ id: spec.category, label: spec.category, purpose: AGENT_CATEGORY_PURPOSE[spec.category] }] }
								: {}),
						}))
				: null,
		currentSession: currentSessionId,
		recording: () => getCurrentSettings().systemOne.record,
	});
	let lastMemoryPromptRuntimeId: string | undefined;
	const memoryReader = createMemoryPromptReader({
		getDataDir: clioDataDir,
		onSelection: (selection) => memoryOwner.recordPromptSelection(selection),
		// A section built under a ranking joins each record it admitted to that
		// ranking's call, so the dataset can tell a useful ordering from a neutral one.
		onRankedSelection: (ids) => {
			for (const id of ids) followUps.used("memory", id);
		},
	});
	// Optional ranking never starts on the chat's own model, through any route of
	// the binding or any target alias for it, nor on an endpoint whose declared
	// slots are already in use. Memory, skills and the gateway all reach this one
	// ranker, so the policy covers every caller; a cached answer is still served.
	const relevanceMayStart = (): boolean => {
		const settings = getCurrentSettings();
		return (
			relevanceStartRefusal({
				settings: capabilitySettings(settings),
				getTarget: (targetId) => providers.getTarget(targetId),
				capacities: resolveEndpointCapacities({
					statuses: providers.list(),
					targets: settings.targets,
					runtimeFor: (runtimeId) => providers.getRuntime(runtimeId),
				}),
				usage: endpointCapacityUsage(),
			}) === null
		);
	};
	const relevanceRanker = createRelevanceRanker({
		maxPending: 1,
		systemOne,
		flow: () => flowLedger.current(),
		task: () => systemOneHost.task(),
		tracker: followUps,
		recording: () => getCurrentSettings().systemOne.record,
		mayStart: relevanceMayStart,
	});
	// A ranking asked under a session, branch or binding that is gone cannot help
	// the next listing, so it stops holding the ranker's slot and its endpoint, and
	// the old owner's finished rankings go with it so their refs join nothing new.
	// A new operator task supersedes at `readTurn` below. Shutdown aborts every
	// fill and starts none before System One's settle wait.
	const unsubscribeRelevanceLifecycle = [
		bus.on(BusChannels.SessionStart, () => relevanceRanker.release("session started")),
		bus.on(BusChannels.SessionResumed, () => relevanceRanker.release("session resumed")),
		bus.on(BusChannels.SessionParked, () => relevanceRanker.release("session parked")),
		bus.on(BusChannels.SessionTurnSwitched, () => relevanceRanker.release("branch switched")),
		bus.on(BusChannels.ConfigHotReload, () => relevanceRanker.abortStale()),
		bus.on(BusChannels.ConfigNextTurn, () => relevanceRanker.abortStale()),
		bus.on(BusChannels.ShutdownRequested, () => relevanceRanker.dispose()),
	];
	termination.onDrain(() => {
		for (const unsubscribe of unsubscribeRelevanceLifecycle) unsubscribe();
		relevanceRanker.dispose();
	});
	capabilityGate = createCapabilityGate({
		relevance: relevanceRanker,
		relevanceCandidateLimit: () =>
			systemOne.describe().find((binding) => binding.site === "relevance")?.kind === "llm" ? 12 : 64,
	});
	const catalogRanker = Object.assign(
		(request: Parameters<typeof relevanceRanker>[0]) => {
			if (request.use === "memory") return relevanceRanker(request);
			const ranked = capabilityGate.rank({
				kind: request.use,
				task: request.need || systemOneHost.task(),
				candidates: request.candidates.map((candidate) => ({ id: candidate.id, description: candidate.summary })),
				limit: 10,
			});
			return ranked.length
				? { scores: Object.fromEntries(ranked.map((hit) => [hit.id, hit.score])), source: "capability gate", ref: "" }
				: null;
		},
		{ asks: () => true },
	);

	/**
	 * Write what System One recorded since the last flush as ledger entries. A row goes under the
	 * turn its ref names when the tree holds that turn and under the current leaf otherwise, so a
	 * slow answer stays with its own turn after a later turn or a `/tree` switch moved the leaf.
	 * The drain empties the buffer, so a second call finds nothing and writes nothing. The settle,
	 * park and shutdown callers can therefore overlap.
	 */
	const flushSystemOne = (): void => {
		const meta = session?.current();
		if (!meta) return;
		const calls = systemOneRecorder.drain(meta.id);
		if (calls.length === 0) return;
		try {
			const tree = session?.tree(meta.id);
			if (!tree) return;
			for (const group of anchorSessionRows(calls, tree)) {
				session?.appendEntry({
					kind: "custom",
					customType: SESSION_ROW_CUSTOM_TYPE,
					parentTurnId: group.parentTurnId,
					display: false,
					data: { calls: group.calls },
				});
			}
		} catch {
			// Recording System One is best effort and cannot change the turn.
		}
	};
	// A session's pending rows have to reach its own ledger before it parks. After
	// an ACP session/close nothing drains again, and after /new, /resume, /fork or a
	// branch switch the next drain belongs to another session, so the rows would be
	// dropped. The emit is synchronous and fires while the session is still current
	// with its writer open. A fork emits from inside forkFromState, before it closes
	// the parent's writer, so /fork and ACP session/fork need no flush of their own.
	bus.on(BusChannels.SessionParked, ({ sessionId }) => {
		if (session?.current()?.id === sessionId) flushSystemOne();
		systemOneHost.forgetOperatorTexts();
	});
	// A resume or a `/tree` switch can keep the session id and still change which
	// requests precede the next turn, so the kept texts go and the ledger is read once.
	bus.on(BusChannels.SessionResumed, () => systemOneHost.forgetOperatorTexts());
	bus.on(BusChannels.SessionTurnSwitched, () => systemOneHost.forgetOperatorTexts());
	const visionSidecar = createVisionSidecar({ getSettings: () => getCurrentSettings(), providers });
	const jobHost = createJobHost({
		registry: toolRegistry,
		bus,
		...(session ? { session } : {}),
		cwd: process.cwd(),
		attended: options.headless === undefined,
		safety,
		autonomy: resolveEffectiveAutonomy,
		sessionCodeConsentPending: () => sessionCodeConsent.pending(),
		createSession: () => {
			const settings = getCurrentSettings();
			session?.create({
				cwd: process.cwd(),
				...(settings.chat.target ? { target: settings.chat.target } : {}),
				...(settings.chat.model ? { model: settings.chat.model } : {}),
			});
			persistCurrentThinkingLevel();
		},
		notice: (text) => {
			if (deferredWatchdogNoticeSink) deferredWatchdogNoticeSink(text);
			else bootStderr(`${text}\n`);
		},
	});
	const toolBootstrap = registerAllTools(toolRegistry, {
		jobTool: jobHost.tool,
		jobs: jobHost.operations,
		flow: {
			carried: () => flowLedger.current(),
			refusal: () => flowLedger.refusal(),
			absorb: (set, origin) => flowLedger.absorb(set, origin),
		},
		...(resolvedSettings.fleet.profiles.vision?.target
			? {
					visionSidecar,
					getRecentVisionImages: () => {
						const meta = session?.current();
						if (!session || !meta) return [];
						const leaf = session?.tree(meta.id).leafId ?? undefined;
						return latestUserImages(session.readEntries(), leaf);
					},
				}
			: {}),
		// Discovery shares the pre-turn gate; optional calibrated rankings arrive from its nonblocking cache.
		rankRelevance: catalogRanker,
		onSkillLoaded: (name) => {
			followUps.used("skills", name);
			capabilityGate.used("skills", name);
		},
		onCapabilityCalled: (name) => {
			followUps.used("capabilities", name);
			capabilityGate.used("capabilities", name);
		},
		// consult exists only when its site is bound at startup, so an operator who
		// never bound it keeps the registry, tool signature and prompt they had. A
		// binding removed mid-session answers "no usable answer". bound() reads the
		// effective settings view built above, which is why that block precedes this call.
		...(systemOne.bound("consult")
			? {
					consult: {
						systemOne,
						cwd: () => process.cwd(),
						// The evidence files consult reads itself never pass a read tool, so
						// they are labeled here before the request; the runner's flow check
						// then judges the labels. A throw makes consult send nothing.
						flowFor: (files) => {
							// Neither an unusable policy nor an unusable ledger may let evidence leave.
							const refusal = safety.policy?.informationFlow?.().refusal ?? flowLedger.refusal();
							if (refusal !== null) throw new Error(refusal);
							const labels = safety.policy?.flowRestrictionsForPaths?.(files, process.cwd()) ?? null;
							if (labels !== null) {
								flowLedger.absorb(labels, { tool: "consult" });
								const unlabeled = flowLedger.refusal();
								if (unlabeled !== null) throw new Error(unlabeled);
							}
							return mergeFlowRestrictions(labels, flowLedger.current());
						},
					},
				}
			: {}),
		getContextBudget: () => chat.inspectLiveBudget(),
		requestSelfCompact: (note, toolCallId, signal) => chat.requestSelfCompact(note, toolCallId, signal),
		// Read-only recall over the stores the main prompt draws from, under the
		// same repository and runtime gates; the agent scope stays with workers.
		memoryRecall: {
			onRecall: (ids) => memoryOwner.recordRecall(ids),
			bank: () => taskMemoryBank.snapshot(),
			records: () => loadMemoryRecordsSync(clioDataDir()),
			eligibility: () => {
				// The session header keeps the target the session was created with;
				// routing changed in the TUI or over ACP only appends ledger entries.
				// The prompt path reports the runtime it actually compiled for.
				const settingsTarget = getCurrentSettings().chat.target;
				const runtimeId =
					lastMemoryPromptRuntimeId ?? (settingsTarget ? providers.getTarget(settingsTarget)?.runtime : undefined);
				return {
					// The session's workspace, which a GUI or resumed session need not share with the process.
					activeRepository: canonicalMemoryRepositoryIdentity(memoryWorkspaceRoot()),
					activeRuntime: runtimeId === undefined ? null : { kind: "runtime", key: runtimeId },
					activeAgent: null,
				};
			},
		},
		getSettings: () => getCurrentSettings(),
		getRouteProvenance: routeProvenance,
		termination,
		captureWorkerContext: () => chat.captureWorkerContext?.() ?? null,
		...(session
			? {
					session,
					readSessionEntries: () => {
						const meta = session.current();
						return meta ? session.readEntries() : [];
					},
					onContextRecalled: (payload) => bus.emit(BusChannels.ContextRecalled, payload),
					readRecall: createSessionRereadPort(session, bus),
				}
			: {}),
		taskBoard,
		decisionBoard,
		getDecisionBoard: () => decisionBoard.snapshot(),
		userTasks,
		dispatch,
		bus,
		...(interactive || acpInterviews ? { askUser: askUserBridge } : {}),
		...(agents ? { getAgentCatalog: () => renderAgentCatalogSectionsFromSpecs(agents.listSpecs()).stable } : {}),
		...(agents ? { getAgentSpecs: () => agents.listSpecs() } : {}),
		...(agents ? { getAgentRoleFacts: agentRoleFactsResolver((id: string) => agents.getSpec(id)) } : {}),
		// Same effective-autonomy resolution the registry admission uses, so plan
		// provenance and compete winner handling agree with the approval surface.
		getAutonomy: resolveEffectiveAutonomy,
		...(interactive ? { dispatchBackground } : {}),
		...(mux ? { competeMuxWorktrees: mux } : {}),
		// Registered only when a pane host answered detection, so the tool is
		// absent from the prompt on a machine with none rather than present and
		// always refusing.
		...(panes && mux?.mode !== "none" ? { panes } : {}),
		// The operator opts the model in with integrations.music.agentControl, and
		// the tool exists only when music could actually play at startup, so a
		// session without it carries no tool schema and no prompt bytes for it.
		...(music && getCurrentSettings().integrations.music.agentControl && music.unavailableReason() === null
			? { music }
			: {}),
		getCostCeilingUsd: () => result.getContract<SchedulingContract>("scheduling")?.ceilingUsd() ?? 0,
		...(config ? { getWorkerRosters: () => config.get().fleet.rosters } : {}),
		...(config ? { getDispatchSchemaComposition: () => dispatchSchemaCompositionFor(config.get().fleet) } : {}),
		getSkillLoaderOptions: () => ({
			trustProjectCompatRoots: config?.get().integrations.projectResources.trustProjectImports === true,
			disableDiscovery: options.noSkills === true || options.headless?.noSkills === true,
			...(options.skillPaths && options.skillPaths.length > 0
				? { explicitSkillPaths: options.skillPaths }
				: options.headless?.skillPaths && options.headless.skillPaths.length > 0
					? { explicitSkillPaths: options.headless.skillPaths }
					: {}),
		}),
	});
	// Runtime tools are served after the core and command tools hold their
	// names; the gateway keeps the provider schema set unchanged as each
	// generation swaps them.
	extensionReload.attachRuntimeTools(toolRegistry);

	const getTaskMemorySeedOffer = (): { source: string; count: number } | null => {
		return taskMemoryHandoffSeedOffer(process.cwd(), getCurrentSettings().context.memory.enabled);
	};
	const seedCurrentTaskMemoryFromHandoff = () => {
		return seedTaskMemoryFromNewestHandoff(taskMemoryBank, process.cwd(), getCurrentSettings().context.memory.enabled);
	};
	if (resumedSessionAtBoot) {
		const offer = getTaskMemorySeedOffer();
		if (offer && offer.count > 0) {
			initialNotices.push(
				`task memory: ${offer.count} handoff entr${offer.count === 1 ? "y" : "ies"} available from ${offer.source}; run /memory seed to import`,
			);
		}
	}
	for (const warning of agentRoleToolWarnings(providers, getCurrentSettings())) {
		if (interactive) initialNotices.push(warning);
		else process.stderr.write(`${warning}\n`);
	}
	// Residency protection follows the live effective settings: the models the
	// operator's config references (orchestrator, worker default/profiles,
	// target defaults) may never be evicted by another Clio stream, and a
	// routing change updates the set on the next read.
	setProtectedModelsProvider(() => protectedResidencyModels(getCurrentSettings()));

	const validatedKeybindings = validateKeybindings((config?.get() ?? readSettings()).interface.keybindings ?? {});
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
		if (config?.update) config.update(mutator);
		else updateSettings(mutator);
		bumpSessionState();
	};
	const persistProjectMutation = (mutator: SettingsMutator): void => {
		if (config?.updateProject) config.updateProject(mutator);
		else updateProjectLocalSettings(process.cwd(), mutator);
		bumpSessionState();
	};
	/**
	 * Apply a routing change with one consistent scope: it takes effect in this
	 * session immediately and writes through to saved settings as the default
	 * for future sessions. Only the patched fields hit the file, so concurrent
	 * sessions cannot clobber each other's saved defaults wholesale. A save the
	 * file refuses puts the live route back (commitRoutingPatch) and rethrows.
	 */
	const updateSessionRouting = (patch: RoutingPatch, mutateSaved?: (saved: ClioSettings) => void): void => {
		commitRoutingPatch(
			sessionRouting,
			patch,
			() =>
				persistSavedMutation((saved) => {
					mergeRoutingPatchIntoSettings(saved, patch);
					mutateSaved?.(saved);
				}),
			bumpSessionState,
		);
		persistCurrentThinkingLevel();
	};
	/**
	 * A routing change at the scope the operator chose. "session" moves the live
	 * route and leaves settings.yaml alone, so a swap that points at a dead
	 * endpoint dies with the session that made it; "global" is the historical
	 * write-through. Nothing on this path writes durably without a scope.
	 */
	const applyRoutingAtScope = (patch: RoutingPatch, scope: "session" | "project" | "global"): void => {
		if (scope === "global") {
			updateSessionRouting(patch);
			return;
		}
		if (scope === "project") {
			persistProjectMutation((saved) => mergeRoutingPatchIntoSettings(saved, patch));
		}
		applyRoutingPatch(sessionRouting, patch);
		bumpSessionState();
		persistCurrentThinkingLevel();
	};
	const readAcpSafeSettings = (): AcpSafeSettingsSnapshot => {
		const settings = getCurrentSettings();
		return {
			target: settings.chat.target,
			model: settings.chat.model,
			thinkingLevel: settings.chat.thinkingLevel ?? "off",
			autonomy: settings.safety.autonomy,
		};
	};
	/**
	 * ACP safe settings are one atomic persisted mutation followed by infallible
	 * in-process routing assignment. Persisting first avoids reporting a live
	 * route that failed to become the future-session default.
	 */
	const commitAcpSafeSettings = (patch: AcpSafeSettingsPatch): AcpSafeSettingsSnapshot => {
		const orchestrator: NonNullable<RoutingPatch["orchestrator"]> = {};
		if (patch["chat.target"] !== undefined) orchestrator.target = patch["chat.target"];
		if (patch["chat.model"] !== undefined) orchestrator.model = patch["chat.model"];
		if (patch["chat.thinkingLevel"] !== undefined) {
			orchestrator.thinkingLevel = patch["chat.thinkingLevel"];
		}
		const routingPatch: RoutingPatch | null = Object.keys(orchestrator).length > 0 ? { orchestrator } : null;
		persistSavedMutation((saved) => {
			if (routingPatch !== null) mergeRoutingPatchIntoSettings(saved, routingPatch);
			if (patch["safety.autonomy"] !== undefined) saved.safety.autonomy = patch["safety.autonomy"];
		});
		if (routingPatch !== null) {
			applyRoutingPatch(sessionRouting, routingPatch);
			bumpSessionState();
		}
		persistCurrentThinkingLevel();
		return readAcpSafeSettings();
	};
	/**
	 * Persist a whole-settings blob coming from the effective view (the
	 * /settings overlay, favorites toggles). Routing edits in the blob are
	 * absorbed into the session state and written through; everything else is
	 * persisted without leaking this session's routing into the saved defaults.
	 */
	const applySettingsBlob = (next: ClioSettings): void => {
		const patch = diffRouting(getCurrentSettings(), next);
		commitRoutingPatch(
			sessionRouting,
			patch ?? {},
			() =>
				persistSavedMutation((fresh) => {
					const persisted = structuredClone(next);
					restoreRoutingFields(persisted, fresh);
					// A whole-blob write (providers, favorites) must not globalize a
					// session-only override: restore every overridden leaf from the
					// fresh file so it stays session-local until explicitly saved.
					for (const path of [...startupOverrides.keys(), ...sessionOverrides.keys()]) {
						setAtPath(persisted, path, getAtPath(fresh, path));
					}
					if (patch) mergeRoutingPatchIntoSettings(persisted, patch);
					return persisted;
				}),
			bumpSessionState,
		);
		persistCurrentThinkingLevel();
	};
	/**
	 * Commit a single /settings edit, keyed by its config-path id. `next` is the
	 * effective view with the one leaf already changed.
	 *   - scope "session": apply live only. Routing ids feed the routing state;
	 *     every other id becomes a session override. settings.yaml is untouched.
	 *   - scope "global": apply live and persist just that leaf as the new
	 *     default, clearing any prior session override for it.
	 * Restart-required ids (budget.concurrency, runtimePlugins,
	 * terminal.tuiMode, terminal.fullscreenScrollbar) cannot apply
	 * live, so the overlay only offers "global" for them; the file write is what
	 * a later restart picks up.
	 */
	const commitSetting = (id: string, next: ClioSettings, scope: "session" | "project" | "global"): void => {
		if (isRoutingPath(id)) {
			// Build the patch from `next` keyed by the edited id, not by diffing
			// against the live view: a prior session-only apply already moved the
			// routing state, so a diff would be empty and the global save would
			// silently no-op. Only the touched fields are persisted, so concurrent
			// sessions never clobber each other's saved routing.
			const patch = routingPatchForId(id, next);
			if (!patch) return;
			if (scope === "global") {
				updateSessionRouting(patch);
				return;
			}
			applyRoutingAtScope(patch, scope);
			return;
		}
		getCurrentSettings();
		const value = getAtPath(next, id);
		if (scope === "session") {
			sessionOverrides.set(id, value);
			bumpSessionState();
			return;
		}
		if (scope === "project") {
			persistProjectMutation((saved) => setAtPath(saved, id, value));
			sessionOverrides.delete(id);
			bumpSessionState();
			return;
		}
		// Same contract as a routing save: a refused write leaves the session
		// override it would have replaced in place.
		const hadOverride = sessionOverrides.has(id);
		const priorOverride = sessionOverrides.get(id);
		sessionOverrides.delete(id);
		bumpSessionState();
		try {
			persistSavedMutation((saved) => setAtPath(saved, id, value));
		} catch (error) {
			if (hadOverride) sessionOverrides.set(id, priorOverride);
			bumpSessionState();
			throw error;
		}
	};
	// Shift+Tab and the scoped model cycle move this session only; see createRoutingGestures.
	const routingGestures = createRoutingGestures({
		nextThinkingLevel: () => {
			const current = getCurrentSettings();
			const thinking = resolveModelRuntimeCapabilitiesForProviders(
				providers,
				current.chat.target,
				current.chat.model,
				current.chat.thinkingLevel ?? "off",
			)?.thinking;
			const effectiveAvailable = thinking?.supportedLevels ?? (["off"] as ThinkingLevel[]);
			return advanceThinkingLevel(thinking?.effectiveLevel ?? current.chat.thinkingLevel ?? "off", effectiveAvailable);
		},
		nextScopedTarget: (direction) => advanceScopedTarget(getCurrentSettings(), direction),
		apply: applyRoutingAtScope,
	});
	/**
	 * Put the live route back on the one the current, just-resumed session last
	 * ran on (planResumedRouting), at session scope: settings.yaml keeps
	 * whatever default some session saved, possibly in another project. When
	 * the session is going to run on a different route anyway (an explicit CLI
	 * flag, a recorded target that is gone), record that route immediately so
	 * the next resume keeps the accepted choice (AUD-3 findings 2 and 3).
	 * Returns the operator notice, if any; the caller knows where it can go.
	 */
	const restoreResumedSessionRoute = (pinned?: { route?: boolean; thinking?: boolean }): string | null => {
		const meta = session?.current();
		if (!session || !meta) return null;
		let recorded: ReturnType<typeof resumedSessionRoute>;
		try {
			recorded = resumedSessionRoute(meta, session.readEntries());
		} catch {
			// An unreadable ledger has no route to offer; the session keeps the
			// current one, which is what resume did before it looked.
			return null;
		}
		const plan = planResumedRouting(
			recorded,
			getCurrentSettings(),
			pinned,
			(config?.get() ?? readSettings()).chat.thinkingLevel ?? "off",
		);
		if (plan.patch) {
			applyRoutingPatch(sessionRouting, plan.patch);
			bumpSessionState();
		}
		const effective = getCurrentSettings().chat;
		const parentTurnId = (() => {
			try {
				return session.tree(meta.id).leafId;
			} catch {
				return null;
			}
		})();
		try {
			const runtimeId = settingsTargetRuntime(getCurrentSettings(), effective.target);
			if (
				effective.target &&
				effective.model &&
				runtimeId &&
				(effective.target !== recorded.target || effective.model !== recorded.model)
			) {
				session.appendEntry({
					kind: "modelChange",
					parentTurnId,
					provider: runtimeId,
					modelId: effective.model,
					target: effective.target,
				});
			}
			persistCurrentThinkingLevel();
		} catch {
			// Best effort, like the chat loop's own markers: a lost row only means
			// the next resume restores the older route.
		}
		return plan.notice;
	};
	// A headless `--session`/`--continue` resumed before the route was seeded;
	// restore it now, letting an explicit --target/--model/--thinking win.
	if (resumedSessionAtBoot) {
		const notice = restoreResumedSessionRoute({
			route: options.headless?.target !== undefined || options.headless?.model !== undefined,
			thinking: options.headless?.thinking !== undefined,
		});
		if (notice !== null) bootStderr(`Clio Coder: ${notice}\n`);
	}
	if (options.apiKey) {
		const target = resolveTarget(providers, getCurrentSettings().chat.target);
		const runtime = target ? providers.getRuntime(target.runtime) : null;
		if (!target || !runtime) {
			bootStderr("Clio Coder: --api-key supplied but no active orchestrator target could be resolved; refusing.\n");
			await termination.shutdown(2);
			return { exitCode: 2, bootTimeMs: timer.snapshot().totalMs };
		}
		providers.auth.setRuntimeOverrideForTarget(target, runtime, options.apiKey);
	}
	// Every later resume (/resume, ACP session/load) goes through the session
	// domain, which announces it synchronously before the caller replays the
	// transcript. A `/tree` branch switch is a different event and keeps the
	// route the operator is on.
	const unsubscribeResumedRoute = bus.on(BusChannels.SessionResumed, (payload) => {
		const event = payload as { sessionId?: unknown; via?: unknown } | null | undefined;
		if (event?.via !== "resume" || session?.current()?.id !== event.sessionId) return;
		const notice = restoreResumedSessionRoute();
		if (notice === null) return;
		if (interactive && deferredWatchdogNoticeSink) {
			deferredWatchdogNoticeSink(notice);
		} else if (options.acp !== undefined) {
			// ACP has no advisory channel outside a prompt; record it where the
			// routing notices already go (see the ConfigNextTurn subscriber below).
			try {
				session?.appendEntry({
					kind: "custom",
					customType: "clio-coder.routing-notice",
					parentTurnId: null,
					data: { kind: "resumed-route-unavailable", level: "warning", text: notice },
				});
			} catch {
				// Advisory only.
			}
		} else {
			bootStderr(`Clio Coder: ${notice}\n`);
		}
	});
	termination.onDrain(() => unsubscribeResumedRoute());

	const readCurrentSessionEntries = (): ReadonlyArray<SessionEntry> => {
		if (session === undefined) return [];
		const meta = session.current();
		if (!meta) return [];
		reconcilePendingProtectedArtifacts(session);
		return session.readEntries();
	};

	const reseedUsage = (): void => {
		const meta = session?.current();
		if (!meta || !observability || !session) return;
		reseedSessionUsageFromLedger(
			observability,
			readCurrentSessionEntries(),
			{
				target: meta.target,
				model: meta.model,
				sessionId: meta.id,
				journalDirectory: join(clioStateDir(), "sessions", meta.cwdHash, meta.id),
			},
			session.tree(meta.id).leafId,
		);
	};
	termination.onDrain(bus.on(BusChannels.SessionResumed, reseedUsage));
	termination.onDrain(bus.on(BusChannels.SessionTurnSwitched, reseedUsage));

	const turnOutcomeCollector = createTurnOutcomeCollector();
	let outcomeSessionId: string | null = null;
	const seedOutcomeFromSession = (): void => {
		const meta = session?.current();
		outcomeSessionId = meta?.id ?? null;
		let streak = 0;
		try {
			const latest = meta
				? [...readRecentSessionEntriesForContract(meta.id)]
						.reverse()
						.find((entry) => entry.kind === "custom" && entry.customType === "turnOutcome")
				: undefined;
			if (latest?.kind === "custom") {
				const data = latest.data as { conversation?: { clarificationStreak?: unknown } } | null;
				if (typeof data?.conversation?.clarificationStreak === "number") streak = data.conversation.clarificationStreak;
			}
		} catch {
			// An unreadable tail provides no previous measurement; it must not prevent opening a session.
		}
		turnOutcomeCollector.seedClarificationStreak(streak);
	};
	seedOutcomeFromSession();
	const unsubscribeOutcomeResume = bus.on(BusChannels.SessionResumed, seedOutcomeFromSession);
	termination.onDrain(() => unsubscribeOutcomeResume());
	middleware.registerHook(turnOutcomeCollector);

	// turn_end assessors, fired by the chat-loop when the final assistant
	// message of a run lands. Tool-prose first so its hard-block interruption
	// precedes the finish-contract advisory in effect order.
	middleware.registerHook(createToolProseRegistration());
	middleware.registerHook(createTaskNudgeRegistration({ getBoard: () => taskBoard.snapshot() }));
	const explorationNudge = createReadOnlyExplorationNudgeRegistration({ workspaceRoot: memoryWorkspaceRoot });
	middleware.registerHook(explorationNudge.registration);
	middleware.registerHook(createUnbackedWorkerClaimRegistration());
	middleware.registerHook(
		createDetachedDispatchNudgeRegistration({ getOpenBatches: () => openDetachedBatchViews(dispatch) }),
	);
	const taskEstablished = (): boolean => {
		const board = taskBoard.snapshot();
		return (
			board?.tasks.some((task) => task.status === "active" || task.status === "pending" || task.status === "blocked") ===
				true || userTasks.snapshot().some((task) => task.status === "handed" || task.status === "picked")
		);
	};
	const turnControl = createTurnControlRunner({
		getSettings: getCurrentSettings,
		getAutonomy: resolveEffectiveAutonomy,
		dispatch,
		agents,
		toolRegistry,
		getInvokeOptions: () => {
			const sessionId = session?.current()?.id;
			return sessionId === undefined ? {} : { sessionId };
		},
		getTurnConstraints: () => chat.currentTurnConstraints?.(),
		isContinuation: () => false,
		// The turn site answered with acts and a breadth under cuts fitted to the
		// build that produced them, so an unmeasured model never starts harness work.
		// A wait is bounded by the deadline the turn call itself runs under.
		readInterpretation: async (wait) => {
			if (wait === undefined) return systemOneHost.interpretation();
			const binding = getCurrentSettings().systemOne.sites.turn;
			const bindingTimeoutMs = typeof binding === "object" ? binding.timeoutMs : undefined;
			return systemOneHost.awaitInterpretation(bindingTimeoutMs ?? TURN_SITE.deadlineMs, wait.signal);
		},
		facts: {
			turnIndex: () =>
				readCurrentSessionEntries().filter(
					(entry) =>
						entry.kind === "message" &&
						entry.role === "user" &&
						(entry.payload as { synthetic?: unknown } | null)?.synthetic !== true,
				).length,
			taskEstablished,
			clarificationStreak: () => turnOutcomeCollector.clarificationStreak(),
			finishedDetachedBatchIds: () => finishedDetachedBatchIds(dispatch),
		},
		cwd: process.cwd(),
		bus,
		emitNotice: (text) => {
			if (deferredWatchdogNoticeSink) deferredWatchdogNoticeSink(text);
			else bootStderr(`${text}\n`);
		},
		...(agents ? { getAgentRoleFacts: agentRoleFactsResolver((id: string) => agents.getSpec(id)) } : {}),
		rememberOrientation(turnId, runId, succeeded) {
			dispatchDedup.rememberHarnessOrientation(turnId, runId);
			if (succeeded) explorationNudge.rememberHarnessScout(turnId);
		},
	});
	const seedOrientationFromSession = (): void => {
		let snapshot: TurnControlRecord["orientation"];
		try {
			const meta = session?.current();
			const latest = meta
				? [...readRecentSessionEntriesForContract(meta.id)]
						.reverse()
						.find(
							(entry) =>
								entry.kind === "custom" &&
								entry.customType === "turnControl" &&
								(entry.data as TurnControlRecord | null)?.orientation !== undefined,
						)
				: undefined;
			if (latest?.kind === "custom") snapshot = (latest.data as TurnControlRecord).orientation;
		} catch {
			/* S6: an unreadable tail cannot seed reuse. */
		}
		turnControl.seedOrientation(snapshot ?? null);
	};
	seedOrientationFromSession();
	const unsubscribeOrientationResume = bus.on(BusChannels.SessionResumed, seedOrientationFromSession);
	termination.onDrain(() => unsubscribeOrientationResume());
	// The opt-in turn-end watchdog. Headless and ACP runs pass `false` for the
	// surface: neither has an operator reading a transcript, so a notice they
	// cannot see would be a worker run spent on nothing whatever the setting says.
	middleware.registerHook(
		createWatchdogRegistration({
			firesOnThisSurface: interactive,
			getSettings: () => (effectiveSettingsForDispatch?.() ?? getCurrentSettings()).safety.review,
			getScope: () => {
				const board = taskBoard.snapshot();
				if (board === null) return null;
				const active = board.tasks.find((task) => task.status === "active");
				return active ? `${board.title}: ${active.id} ${active.title}` : board.title;
			},
			run: (trigger) =>
				runWatchdogReview(trigger, {
					dispatch,
					bus,
					...(agents ? { getAgentRoleFacts: agentRoleFactsResolver((id: string) => agents.getSpec(id)) } : {}),
					target: (effectiveSettingsForDispatch?.() ?? getCurrentSettings()).safety.review.target,
					...(deferredWatchdogNoticeSink ? { emitNotice: deferredWatchdogNoticeSink } : {}),
				}),
		}),
	);
	if (session) {
		middleware.registerHook(
			createFinishContractRegistration({
				getTurnConstraints: () => chat.currentTurnConstraints?.(),
				// Tail-scoped: the contract only needs the last-user-message window, so
				// it parses a bounded ledger tail per turn_end rather than the whole
				// file (which grows unbounded with session length).
				readSessionEntries: () => {
					const meta = session.current();
					return meta ? readRecentSessionEntriesForContract(meta.id) : null;
				},
				resolveRigor: () =>
					resolveRigor({ cwd: process.cwd(), override: parseRigorOverride(process.env.CLIO_CODER_RIGOR) }),
				readActiveAcceptance: (window) =>
					activeUserTaskAcceptance(userTasks.snapshot(), taskBoard.snapshot(), session.current()?.id ?? null, window),
				recordDecision: (record) => {
					turnOutcomeCollector.recordCompletion(
						record.turnId,
						record.decision,
						record.mutatedPaths.length,
						record.evidenceKinds,
					);
					safety.audit.recordCompletionContract?.(record);
				},
			}),
		);
	}

	// DF-1: a final answer that cites line numbers no tool printed gets one
	// continuation to re-read with line_numbers. Every surface, headless included.
	middleware.registerHook(createCitationGroundingRegistration());

	if (!options.headless && !options.acp) {
		middleware.registerHook(
			createPlanCloseRegistration({
				// Yolo's turn-ending contract stops a plan at its stated assumptions
				// instead of a "Carry out this plan?" card, which parked unattended
				// runs (#421), so the close nudge would contradict it there.
				canAsk: () => askUserHandler !== null && resolveEffectiveAutonomy() !== "yolo",
				isPlan: () => {
					const interpretation = systemOneHost.interpretation();
					return interpretation === undefined ? undefined : interpretation.intent === "plan";
				},
			}),
		);
		// Demo guidance: operator-only capability tips after a turn. Everything it
		// does, profile writes included, stops while interface.demo is off.
		middleware.registerHook(
			createGuidanceRegistration({
				enabled: () => getCurrentSettings().interface.demo,
				autonomy: () => resolveEffectiveAutonomy(),
				keyFor: (actionId) =>
					Object.hasOwn(CLIO_KEYBINDINGS, actionId) ? boundKeyLabel(actionId as ClioKeybinding) : null,
				hasProjectContext: () => existsSync(join(process.cwd(), "CLIO-CODER.md")),
				contextPressure: () => {
					const ledger = chat.contextLedger();
					return ledger.contextWindow > 0 ? ledger.usedTokens / ledger.contextWindow : null;
				},
			}),
		);
	}
	// The turn site's hints for the main agent. Registered on every surface that
	// runs a chat turn; with the site unbound or unfitted the verdict carries no
	// line and the registration contributes nothing.
	middleware.registerHook(
		createDecisionHintsRegistration({
			getHints: () => systemOneHost.hints(),
			controllerActed: () => turnControl.controllerActed(),
			getTurnConstraints: () => chat.currentTurnConstraints?.(),
		}),
	);
	// No boundary from here to `lease.adopt`. The chat loop starts a target probe
	// and a prewarm timer whose notices, like the lease diagnostics taken below,
	// reach only subscribers the interactive application registers; a loop turn
	// in between would deliver them to nobody.
	let cancelQueuedSpeculativeHold: (() => void) | null = null;
	let previousSpeculativeStats = dispatch?.speculativeStats?.() ?? { held: 0, adopted: 0, discarded: 0, live: 0 };
	// The prewarm reads the turn reading where the hints do, as the prompt is
	// built, so a reading that has not landed by then holds no worker. The hold
	// is queued before the request goes out, so an immediate dispatch can adopt
	// it; settlement cancels a queued hold first.
	middleware.registerHook({
		id: "observer.decision-prewarm",
		description: "holds the worker a landed turn reading predicts",
		hooks: ["turn_start"],
		evaluate(input) {
			if (input.metadata?.requestContinuation === true) return [];
			const prediction = systemOneHost.prewarm();
			if (prediction === null) return [];
			cancelQueuedSpeculativeHold?.();
			cancelQueuedSpeculativeHold = scheduleSpeculativeHold(() => {
				cancelQueuedSpeculativeHold = null;
				dispatch?.speculate?.(prediction);
			});
			return [];
		},
	});
	const chat = createChatLoop({
		...(acpInterviews ? { eggAsk: askUserBridge } : {}),
		turnControl,
		turnOutcomeCollector,
		...(dispatch ? { outcomeDispatch: dispatch } : {}),
		getDecisionUsage: (userTurnId) => decisionUsage.read(userTurnId),
		getTaskEstablished: taskEstablished,
		visionSidecar,
		getReadySkillCount,
		...(options.headless === undefined ? { getRouteSources: () => routeProvenance().active } : {}),
		interactiveGuidance: !options.headless && !options.acp,
		// Headless binds its single task's ceiling after template expansion (#423).
		...(options.headless === undefined && options.toolLimits !== undefined
			? { sessionToolLimits: options.toolLimits }
			: {}),
		...(acpInterviews ? { operatorInterviews: true } : {}),
		headless: options.headless !== undefined,
		// Without a steer channel nothing can reach a headless run mid-turn.
		...(options.headless !== undefined && options.headless.steerChannel === undefined ? { liveSteering: false } : {}),
		// The pre-warm holds one slot on its endpoint while it runs, so dispatch
		// admission (#250) sees it exactly as it sees the orchestrator's own turn.
		registerPrewarmEndpointSlot: (runtime) => {
			const key = modelEndpointKey(runtime.runtimeResolution.target, runtime.wireModelId);
			return key === null ? null : registerForegroundStream(key);
		},
		getSettings: getCurrentSettings,
		getAutonomy: resolveEffectiveAutonomy,
		providers,
		middleware,
		// The turn_start observation rides the prompt seam, so it names the line
		// the operator typed (or a hook's rewrite of it), never an expanded
		// template body.
		promptSubmit: async ({ typed, text }: { typed: string; text: string }) => {
			const gate = extensionReload.promptGate();
			const verdict =
				gate !== null && gate.size > 0
					? await gate.run(typed, typed === text)
					: { kind: "pass" as const, text: typed, notices: [] };
			const executor = runtimeHooks.current();
			for (const notice of verdict.notices) executor?.notify(notice);
			if (verdict.kind === "block") return { kind: "block" as const, reason: verdict.reason };
			executor?.observeTurnStart?.(verdict.text);
			return { kind: "pass" as const, text: verdict.text === typed ? text : verdict.text };
		},
		middlewareToolChoice,
		protectedArtifacts: {
			replace: (state) => protectedArtifactsGuard.replaceState(state),
			markDegraded: (reason) => protectedArtifactsGuard.markDegraded(reason),
		},
		knownTargets: () => new Set(providers.list().map((entry) => entry.target.id)),
		observability,
		...(sessionScheduling ? { scheduling: sessionScheduling } : {}),
		bus,
		...(prompts ? { prompts } : {}),
		...(session ? { session } : {}),
		getMemorySection: (request) => {
			lastMemoryPromptRuntimeId = request.runtimeId;
			return memoryReader(request);
		},
		getMemoryRecordStatuses: (ids) => {
			try {
				const records = new Map(readMemoryStoreSnapshot(clioDataDir()).records.map((record) => [record.id, record]));
				return new Map(
					ids.map((id) => {
						const record = records.get(id);
						return [id, record ? memoryStatus(record) : "deleted"] as const;
					}),
				);
			} catch {
				// An unreadable store cannot establish a withdrawal (#423).
				return new Map();
			}
		},
		// Memory is ranked while the prompt composes, and only when the order decides
		// what the section carries: more eligible records than it admits and no
		// ranking pinned earlier in the session.
		getMemoryRelevance: createMemoryRelevance({ reader: memoryReader, rank: relevanceRanker }),
		readTurn: (input) => {
			if ((session?.current()?.id ?? null) !== outcomeSessionId) {
				seedOutcomeFromSession();
				seedOrientationFromSession();
			}
			// A new operator task makes every ranking still in flight answer the old
			// one; cancelling it here keeps it off the endpoint this turn needs. Turn
			// settle and cancel keep the task, so a continuation may still use them.
			relevanceRanker.supersede("new operator task");
			systemOneHost.readTurn(input);
		},
		readSteer: (input) => systemOneHost.readSteer(input),
		currentOperatorTask: () => systemOneHost.task(),
		// Held processes a turn did not use die with the turn, cancelled or not.
		onTurnSettled: () => {
			// Calls made mid-turn (gateway ranking, consult, an approval card) belong
			// to the turn that made them, not to the next one.
			flushSystemOne();
			// The verdict is about the request that just finished; a continuation or
			// the next turn must not read it.
			systemOneHost.clearVerdict();
			cancelQueuedSpeculativeHold?.();
			cancelQueuedSpeculativeHold = null;
			dispatch?.releaseSpeculative?.("turn settled");
			const current = dispatch?.speculativeStats?.();
			if (current === undefined) return;
			const counts = {
				held: Math.max(0, current.held - previousSpeculativeStats.held),
				adopted: Math.max(0, current.adopted - previousSpeculativeStats.adopted),
				discarded: Math.max(0, current.discarded - previousSpeculativeStats.discarded),
			};
			previousSpeculativeStats = current;
			if (counts.held === 0 && counts.adopted === 0 && counts.discarded === 0) return;
			try {
				const meta = session?.current();
				if (!meta) return;
				session?.appendEntry({
					kind: "custom",
					customType: "speculativeDispatch",
					parentTurnId: session?.tree(meta.id).leafId ?? null,
					display: false,
					data: counts,
				});
				return counts;
			} catch {
				// Accounting is best effort and cannot change turn settlement.
			}
		},
		flushSystemOne,
		recordTurnEnd: (turn) => systemOneHost.recordTurnEnd(turn),
		recordOutcome: (outcome) => systemOneHost.recordOutcome(outcome),
		getTaskMemoryHandoffSource: () => {
			const meta = session?.current();
			if (!meta) throw new Error("task memory handoff requires an active session");
			const settings = getCurrentSettings();
			const targetId = meta.target ?? settings.chat?.target;
			const runtimeId = targetId ? providers.getTarget(targetId)?.runtime : undefined;
			return renderTaskMemoryHandoffSource(taskMemoryBank.snapshot(), {
				sessionId: meta.id,
				evidenceRefs: [`session-${meta.id}`],
				runtimeIds: runtimeId === undefined ? [] : [runtimeId],
				agentIds: [],
			});
		},
		memoryCommitBridge: memoryIntervention,
		onMemoryRequestSubmitted: (messages, systemPrompt) =>
			memoryOwner.recordSubmittedMemoryContext(hostFramedTexts(messages), systemPrompt),
		registerDeferredReminderSink: (sink) => {
			deferredMemoryReminderSink = sink;
		},
		registerDeferredNoticeSink: (sink) => {
			deferredWatchdogNoticeSink = sink;
		},
		onAskUserFinalized: (policy) => {
			decisionBoard.recordFinalizedInterview(policy);
		},
		...(session
			? {
					readSessionEntries: readCurrentSessionEntries,
					autoCompact: createProductionAutoCompact(session, getCurrentSettings, providers, observability, undefined, {
						...(sessionScheduling ? { scheduling: sessionScheduling } : {}),
						headless: options.headless !== undefined,
						getCeilingUsd: () => getCurrentSettings().safety.limits.sessionCostUsd,
						admitFlow: admitModelFlow,
						memory: memoryOwner,
					}),
				}
			: {}),
		toolRegistry,
		admitFlow: admitModelFlow,
		admitRuntimeFlow,
		labelReferencedPaths: (paths) => {
			const labels = safety?.policy?.flowRestrictionsForPaths?.(paths, process.cwd()) ?? null;
			if (labels !== null) flowLedger.absorb(labels, { tool: "file-reference" });
		},
		hasAttachedDispatch: () => dispatchBackground.size() > 0,
		// The pre-warm buys latency for a person about to type the next turn. A
		// headless `run` submits its one prompt immediately and an unattended boot
		// never submits at all, so neither has latency to buy; the ACP surface has
		// an operator on the other end of the client and keeps it.
		isLatencySurface: () => interactive || acpMode,
		isPrewarmBusy: () => Boolean(options.terminalLease?.editor.getText().trim()),
	});
	// The guardian works during a turn only through endpoint admission and
	// reads history shallowly while one streams, so it needs the live answer.
	isChatStreaming = () => chat.isStreaming();
	jobHost.attachChat(chat);
	memoryGuardian.wake("ready");

	// Stop preparation and tool admission synchronously at the shutdown edge;
	// settlement still owns terminal events and accepted session appends.
	let chatSettlement: Promise<void> | undefined;
	const beginChatSettlement = (): Promise<void> => {
		if (chatSettlement) return chatSettlement;
		chat.dispose();
		chatSettlement = (async () => {
			await jobHost.close();
			await chat.whenSettled();
		})();
		return chatSettlement;
	};
	const unsubscribeChatShutdown = bus.on(BusChannels.ShutdownRequested, () => {
		void beginChatSettlement().catch(() => {
			// The awaited drain hook reports this same rejection.
		});
	});
	// Safe-exec has the longest local tool grace; external CLI grace is shorter.
	const chatShutdownAllowanceMs =
		SAFE_EXEC_DEFAULT_KILL_GRACE_MS +
		SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS +
		SAFE_EXEC_PIPE_DRAIN_BOUND_MS +
		resolveShutdownHookBudgetMs();
	termination.onDrain(
		async () => {
			unsubscribeChatShutdown();
			// Tool cleanup precedes terminal accounting and accepted writes; the
			// extra hook allowance covers settlement before domain persistence closes.
			await beginChatSettlement();
		},
		{ timeoutMs: chatShutdownAllowanceMs },
	);

	// System One rows reach the ledger at turn boundaries, so whatever was recorded
	// since the last settle (a /draft judgment, an answer that arrived after its
	// deadline) is still pending here and would die with the process. Registered
	// after the chat hook so the aborted turn's calls are in, and the persist phase
	// that closes the session runs after it. The ledger rows go before the dataset
	// queue.
	// A turn waits about a second for the turn-end reading and then moves on, while
	// the call itself runs to its deadline and records whenever it settles. Quitting
	// inside that gap would end the process before the row exists, so the hook waits
	// for calls still in flight first. The bound is the longest default site deadline,
	// and with nothing in flight the wait is a resolved promise, so a quit that has
	// nothing to record is no slower. The hook budget covers the wait plus the flush.
	const SYSTEM_ONE_SHUTDOWN_WAIT_MS = 5_000;
	termination.onDrain(
		async () => {
			try {
				await systemOne.settled(SYSTEM_ONE_SHUTDOWN_WAIT_MS);
				flushSystemOne();
			} finally {
				systemOneRecorder.flush();
			}
		},
		{ timeoutMs: SYSTEM_ONE_SHUTDOWN_WAIT_MS + resolveShutdownHookBudgetMs() },
	);
	// Every Ollama chat pins its model with keep_alive -1, and the ownership
	// record dies with this process, so release the models this process loaded
	// once the drain above has stopped the turn that could pin them again
	// (#379). Terminate runs on every coordinated exit: a finished or failed
	// headless run, --timeout, SIGINT, SIGTERM, and interactive quit. The
	// release bounds itself, so an unreachable server never stalls the exit.
	termination.onTerminate(() => releaseClioLoadedModelsOnExit(), { timeoutMs: EXIT_RELEASE_MS + 500 });

	// A boot-time resume (headless --session or --continue) must replay the resumed
	// session into the chat loop the same way the interactive /resume overlay
	// does. Without this, the first submit runs with an empty provider context
	// and parents its user turn at null, appending a second root that silently
	// abandons the resumed session's active path. The leaf id is restored even
	// when rebuilding replay messages fails, so parenting stays correct and
	// only the provider context degrades.
	if (resumedSessionAtBoot && session) {
		const resumedMeta = session.current();
		if (resumedMeta) {
			let leafTurnId: string | null = null;
			try {
				leafTurnId = session.tree(resumedMeta.id).leafId;
			} catch (err) {
				bootStderr(
					`Clio Coder: failed to read resumed session tree ${resumedMeta.id}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
			try {
				const resumedEntries = readCurrentSessionEntries();
				if (observability) {
					reseedSessionUsageFromLedger(
						observability,
						resumedEntries,
						{
							target: resumedMeta.target,
							model: resumedMeta.model,
							sessionId: resumedMeta.id,
							journalDirectory: join(clioStateDir(), "sessions", resumedMeta.cwdHash, resumedMeta.id),
						},
						leafTurnId,
					);
				}
				// Scoped to the leaf resume landed on for the same reason the /resume
				// overlay is (issue #107): with a /tree pin persisted, the file still
				// holds the abandoned branch after the pinned turn, and replaying it
				// unfiltered seeds the provider with turns the next append does not
				// parent onto.
				replayCurrentSession({ session, chat, readEntries: () => resumedEntries }, resumedMeta.id, "leaf", leafTurnId);
			} catch (err) {
				chat.resetForSession(leafTurnId);
				bootStderr(
					`Clio Coder: failed to replay resumed session context ${resumedMeta.id}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
	}

	const taskMemoryTier = (): "llm" | "rules" => {
		return memoryRouteAvailable() ? "llm" : "rules";
	};

	// One context-init runner for the TUI and ACP hosts.
	const runContextInit = async (
		options: {
			preview?: boolean;
			adopt?: boolean;
			applyClioMd?: boolean;
			rewriteClioMd?: boolean;
			proposeClioMd?: boolean;
			includeGlobalImports?: boolean;
			heuristic?: boolean;
			depth?: "quick" | "standard" | "deep";
		},
		runIo?: RunIo,
	) => {
		// Context init explores the repo with the configured target by
		// default, grounded in the freshly built codewiki, and falls back to the
		// deterministic heuristic when no target is reachable. --heuristic and
		// --preview skip model generation.
		const useModel = options.heuristic !== true && options.preview !== true;
		const bootstrapOptions = bootstrapInputFromInitOptions(options);
		if (!contextDomain) throw new Error("context domain unavailable");
		return contextDomain.runBootstrap({
			cwd: process.cwd(),
			...(runIo ? { io: runIo } : {}),
			confirmGitignore: () => true,
			adopt: options.adopt === true,
			...bootstrapOptions,
			...(useModel
				? {
						generate: modelBootstrapGenerate({
							dispatch,
							resolveRoute: () => {
								if (!config) throw new Error("context-bootstrap configuration unavailable");
								return resolveBootstrapRoute(config.get());
							},
							// Names the agent that actually ran and reports the throw as
							// what it is. "Scout unavailable" was wrong twice over: the
							// agent is context-bootstrap, and the same line was printed
							// for a worker that failed, a worker whose answer the loop
							// guard removed, and a worker that succeeded and whose
							// payload the reader then refused.
							onFallback: (err, mode) =>
								runIo?.stderr(
									`context init: context-bootstrap did not produce a handbook, using ${mode === "existing" ? "the existing CLIO-CODER.md" : "the heuristic writer"} (${err.message})\n`,
								),
						}),
						modelId: "configured-clio-target",
					}
				: {}),
		});
	};

	// A context operation that writes progress to a RunIo answers an ACP client with what it wrote.
	const captureRunIo = () => {
		const written: string[] = [];
		let warned = false;
		return {
			io: {
				stdout: (text: string) => {
					written.push(text);
				},
				stderr: (text: string) => {
					warned = true;
					written.push(text);
				},
			} satisfies RunIo,
			report: (fallback: string): AcpHostReport => ({
				level: warned ? "warn" : "success",
				text: written.join("").trim() || fallback,
			}),
		};
	};

	/**
	 * The api 2 runtime host of a headless run or an ACP session; the TUI hosts
	 * its own. Loaded only when an installed api 2 extension could run, so a
	 * session without one pays nothing. Disposed with the drain, which closes
	 * the session for each runtime.
	 */
	const startSessionExtensionHost = async (
		mode: "headless" | "acp",
		ask?: AskUserHandler,
	): Promise<import("./extension-host.js").ExtensionHost | null> => {
		if (!extensions) return null;
		const hostable = (cwd: string) =>
			extensions.list(cwd, { all: true }).filter((entry) => isLoadableExtension(entry) && entry.runtimeV2 !== undefined);
		if (hostable(process.cwd()).length === 0) return null;
		const { startExtensionHost } = await import("./extension-host.js");
		const host = startExtensionHost({
			mode,
			list: hostable,
			runtimeHooks,
			bus,
			chat,
			sessionId: () => session?.current()?.id ?? null,
			targetId: () => options.headless?.target ?? getCurrentSettings().chat.target ?? "",
			frozenTools: toolRegistry
				.listAll()
				.flatMap((tool) => (tool.sourceInfo?.extension ? [tool.sourceInfo.extension] : [])),
			embed: async (request, signal, workspace) => {
				const { embedForExtension } = await import("../domains/semantic-app/index.js");
				return embedForExtension({ projectRoot: workspace }, request, signal);
			},
			sandboxUnixSockets: () => getCurrentSettings().safety.sandboxUnixSockets,
			notify: (line) => process.stderr.write(`clio-coder: ${line}\n`),
			...(ask ? { ask } : {}),
		});
		termination.onDrain(() => host.dispose(), { timeoutMs: 6500 });
		return host;
	};

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
						customType: "clio-coder.routing-notice",
						parentTurnId: null,
						data: { kind: notice.kind, level: notice.level, text: notice.text },
					});
				} catch {
					// Advisory only; a ledger write failure must not affect the
					// ACP turn loop.
				}
			}
		});
		const acpWorkerRuns = followWorkerRuns(bus);
		const acpHostToolEvents = createHostToolEvents();
		// A client that answers no interviews gets each tool interview cancelled
		// with reason headless, the way a run without an operator does.
		const acpExtensionAsk = acpInterviews ? askUserBridge : undefined;
		let acpExtensionHost = await startSessionExtensionHost("acp", acpExtensionAsk);
		// A session that booted with nothing to host gets its host from the
		// reload that admits an extension installed later.
		let acpExtensionHostStart: Promise<void> | undefined;
		// Built on the first usage read: provider adapters and the quota cache are
		// not worth constructing for a session that never opens the view.
		let acpQuota: { read(): Promise<ReadonlyArray<import("../domains/quota/types.js").UsageSnapshot>> } | null = null;
		// The fleet this ACP agent started and has not seen settle. A second start
		// is refused while one runs, as the terminal's /fleet run refuses it, since
		// two fleets would race over one workspace.
		let acpFleetInFlight: { name: string; fleetRootId: string } | null = null;
		try {
			const transport = options.acp.transport ?? createStdioServerTransport(options.acp.transportOptions);
			const code = await serveClioAcpAgent({
				transport,
				...(options.acp.handshake ? { handshake: options.acp.handshake } : {}),
				...(options.acp.onReady ? { onReady: options.acp.onReady } : {}),
				...(acpInterviewChannel ? { interviews: acpInterviewChannel } : {}),
				...(acpWorkerPermissions && dispatch?.resolveWorkerPermission
					? {
							workerPermissions: {
								resolve: (runId: string, requestId: string, decision: "approve" | "deny") =>
									dispatch.resolveWorkerPermission?.(runId, requestId, decision),
							},
						}
					: {}),
				chat,
				...(session
					? {
							session: {
								...session,
								create(input) {
									const meta = session.create(input);
									persistCurrentThinkingLevel();
									return meta;
								},
							},
						}
					: {}),
				...(session
					? {
							readSessionEntries: readSessionEntriesForCompact,
							// Ownership is read at call time, not captured: an ACP client
							// can switch sessions between turns, and a fork opened this way
							// must separate its own transactions from the ones it inherited
							// exactly as the interactive path does.
							// `upto` is the /tree switch's historical cut, the same option the
							// terminal passes there; a live leaf keeps sidecars written after it.
							buildReplayMessages: (
								entries: ReadonlyArray<SessionEntry>,
								leafTurnId: string | null,
								scope: "leaf" | "upto" = "leaf",
							) =>
								buildModelReplayAgentMessagesFromTurns(entries, {
									...(leafTurnId === null
										? {}
										: scope === "upto"
											? { uptoTurnId: leafTurnId }
											: { activeLeafTurnId: leafTurnId }),
									continuity: continuityContextFromSession(session),
								}),
						}
					: {}),
				// /fleet run's approval, split across preview and run. Both compile
				// through the dispatch domain exactly as the terminal overlay does.
				...(agents
					? {
							fleet: {
								preview: (name: string, vars: Readonly<Record<string, string>>, resume?: string) => {
									const roleFacts = agentRoleFactsResolver((id: string) => agents.getSpec(id));
									const budget = result.getContract<SchedulingContract>("scheduling")?.preflight();
									return compileFleetRunPreview({
										workspaceRoot: process.cwd(),
										name,
										vars,
										getAgentSpec: (agentId) => agents.getSpec(agentId),
										roleFacts,
										...(budget ? { budget } : {}),
										...(resume !== undefined ? { resume } : {}),
										resolveRoute: fleetRouteResolver(dispatch.preview, roleFacts, undefined, chat.toolLimits?.()),
									});
								},
								run: (preview, turnConstraints) =>
									new Promise((resolve) => {
										if (acpFleetInFlight !== null) {
											// No root is minted for a run that never starts; the running
											// root is named in the reason, not reported as this run's id.
											resolve({
												status: "refused",
												reason: `fleet ${acpFleetInFlight.name} (root=${acpFleetInFlight.fleetRootId}) is still running; a new fleet run is refused until it settles. Nothing was dispatched`,
											});
											return;
										}
										const fleetRootId = `fleet-${randomBytes(6).toString("hex")}`;
										// Read before the single-run guard is taken: a throw here would
										// otherwise leave it set and refuse every later fleet run.
										const attributionEnabled = getCurrentSettings().integrations.git.commitAttribution;
										acpFleetInFlight = { name: preview.name, fleetRootId };
										let admitted = false;
										let started = false;
										let admissionCap: ReturnType<typeof setTimeout> | undefined;
										const admit = () => {
											if (admitted) return;
											admitted = true;
											clearTimeout(admissionCap);
											resolve({ status: "started", fleetRootId });
										};
										// A first step that waits on proposals or endpoint capacity is running, not
										// failed; the answer stops waiting before a client's own deadline does. The
										// cap starts with the run, so a slow workspace lock never reads as started.
										const onStarted = () => {
											started = true;
											admissionCap = setTimeout(admit, 30_000);
											admissionCap.unref?.();
										};
										const refuse = (reason: string) => {
											if (admitted) return false;
											admitted = true;
											clearTimeout(admissionCap);
											resolve({ status: "failed", fleetRootId, reason });
											return true;
										};
										// Progress reaches the client as dispatch events; a run that ends before its
										// first step answers the request with why, as the terminal's notice does.
										void executeFleetRun({
											plan: preview.plan,
											playbookName: preview.name,
											commands: preview.commands,
											workspaceRoot: process.cwd(),
											fleetRootId,
											dispatch,
											agents: { getSpec: (agentId) => agents.getSpec(agentId) },
											getDecisionBoard: () => decisionBoard.snapshot(),
											attributionEnabled,
											vars: preview.vars,
											...(preview.resume !== undefined
												? { resume: { record: preview.resume.record, replayed: preview.resume.replayed } }
												: {}),
											...(turnConstraints !== undefined ? { turnConstraints } : {}),
											onStarted,
											onStepDispatched: admit,
											onNotice: (text) => process.stderr.write(`[clio-coder:acp] fleet ${preview.name}: ${text}\n`),
										})
											.then(
												(outcome) => {
													refuse(
														`the run ended before dispatching a step: ${outcome.succeededStepCount}/${outcome.requiredStepCount} steps succeeded`,
													);
												},
												(error: unknown) => {
													const message = error instanceof Error ? error.message : String(error);
													// The run never started: another process's fleet holds this
													// workspace, the lock timed out, or the birth token was missing.
													// The id minted here never ran and is not reported.
													if (!started && !admitted) {
														admitted = true;
														clearTimeout(admissionCap);
														resolve({ status: "refused", reason: message });
														return;
													}
													if (!refuse(message)) process.stderr.write(`[clio-coder:acp] fleet ${preview.name} failed: ${message}\n`);
												},
											)
											.finally(() => {
												acpFleetInFlight = null;
											});
									}),
							},
						}
					: {}),
				// /handoff runs the lifecycle the terminal runs. The successor is minted
				// the way session/new mints one, so its route matches a fresh session.
				...(session
					? {
							handoff: bindAcpHandoff({
								session,
								extract: (goal, extractOptions) => chat.extractHandoff(goal, extractOptions ?? {}),
								readEntries: readSessionEntriesForCompact,
								isTurnInFlight: () => chat.isStreaming(),
								createSession: () => {
									const settings = getCurrentSettings();
									session.create({
										cwd: process.cwd(),
										...(settings.chat.target ? { target: settings.chat.target } : {}),
										...(settings.chat.model ? { model: settings.chat.model } : {}),
									});
									persistCurrentThinkingLevel();
									observability?.resetSession(session.current()?.id ?? null);
									taskBoard.snapshot();
								},
								getDecisionBoard: () => decisionBoard.snapshot(),
							}),
						}
					: {}),
				providers,
				// The fleet controls `_clio-coder/dispatch/steer` reaches. The server
				// takes the two operations by structure, never the whole contract, so
				// no ACP client can enqueue or route dispatch work through it.
				dispatch: {
					steer: (runId, text) => {
						dispatch.steer(runId, text);
					},
					abort: (runId) => {
						dispatch.abort(runId);
					},
					snapshot: () => dispatch.snapshot(),
				},
				settings: {
					read: readAcpSafeSettings,
					commit: commitAcpSafeSettings,
				},
				// A request typed in an ACP client means what it means in the terminal: skills,
				// prompt templates and `@path` references expand the same way. Attached images
				// are judged by their bytes, never by the client's label, and resized like a
				// referenced image file before the model sees them.
				expandPrompt: async (text, attached, signal) => {
					const expansion = await expandSubmitText(text, resources, process.cwd(), signal ? { signal } : {});
					const images = [...expansion.images];
					for (const image of attached) {
						const mimeType = detectSupportedImageMimeType(Buffer.from(image.data, "base64"));
						if (!mimeType) throw new Error("An attached file is not a PNG, JPEG, GIF or WebP image.");
						const resized = await resizeImage({ type: "image", mimeType, data: image.data });
						images.push(
							resized
								? { type: "image", mimeType: resized.mimeType, data: resized.data }
								: { type: "image", mimeType, data: image.data },
						);
					}
					return { ...expansion, images };
				},
				// The read half of the terminal's /tasks, /decisions and /memory views.
				board: () => {
					const memory = getCurrentSettings().context.memory;
					return {
						operatorTasks: userTasks.snapshot(),
						plan: taskBoard.cachedSnapshot(),
						decisions: decisionBoard.snapshot(),
						memory: {
							enabled: memory.enabled,
							tier: taskMemoryTier(),
							bank: taskMemoryBank.snapshot(),
							stepInFlight: memoryIntervention.stepInFlight(),
							observations: memoryOwner.contract.observationStatus(),
							retention: memoryOwner.contract.retentionStatus(),
						},
					};
				},
				// The operator-command host. Only the members the thirteen
				// allowlisted commands actually reach are passed; every TUI-only
				// member stays absent, which is what makes the registry take its
				// documented non-TUI fallback instead of trying to draw an overlay.
				//
				// A command that submits a user turn (`/share`, `/oracle`,
				// `/skill <name>`, `/tasks hand`) is refused by the server while a
				// prompt is active. Outside one, the turn is persisted to the ledger
				// and replayed on the next `session/load`, but it emits no live
				// `session/update`: ACP v1 has no channel for agent content outside a
				// prompt, the same constraint recorded above for routing notices.
				...(dispatch && providers
					? {
							commands: acpCommandControl({
								jobs: jobHost.operations,
								dispatch,
								bus,
								providers,
								cwd: process.cwd(),
								runDoctor: async ({ deep }) => {
									const { collectDoctorFindings, doctorNotice } = await import("../cli/doctor.js");
									return doctorNotice(
										await collectDoctorFindings({
											workspaceRoot: process.cwd(),
											deep: deep ? { providers, autonomy: resolveBaselineAutonomy() } : false,
										}),
									);
								},
								clearSkillSurface: () => chat.clearSkillSurface(),
								eggsCommand: (action, id) => chat.eggsCommand?.(action, id) ?? "No active eggs.",
								// Narrowed exactly as `interactive-slash-runtime.ts` narrows it:
								// the store's `note` parameter has no command-line spelling, and
								// a handoff is attributed to the session that asked for it.
								userTasks: {
									add: (title: string, acceptance?: UserTaskAcceptance) => userTasks.add(title, undefined, acceptance),
									hand: (id: string) => userTasks.hand(id, chat.getSessionId() ?? undefined),
									done: (id: string) => userTasks.done(id),
									drop: (id: string) => userTasks.drop(id),
								},
								getDecisionBoard: () => decisionBoard.snapshot(),
								isTurnInFlight: () => chat.isStreaming(),
								standingTurnConstraints: () => chat.toolLimits?.(),
								seedTaskMemory: seedCurrentTaskMemoryFromHandoff,
								// Recovery continues the engine without new input. It runs inside the
								// prompt turn that asked for it, so its output streams there, and the
								// reply waits for it so the next prompt cannot race it.
								runHandoffRecovery: async (handoffId: string, action: "reduce" | "deliver"): Promise<AcpHostReport> => {
									if (chat.isStreaming())
										return { level: "error", text: "Wait for the current turn to settle before recovery." };
									await chat.recoverHandoff(handoffId, action);
									return {
										level: "success",
										text: action === "deliver" ? "Handoff delivered." : "Handoff reduced; the paused turn continued.",
									};
								},
								// `/council` enters the registry as the dispatch call a model makes, under
								// a call id the turn announces, so its plan approval binds to that call.
								runCouncilDispatch: (args, turnConstraints) =>
									runHostDispatch(toolRegistry, acpHostToolEvents, args, turnConstraints),
								// `/share` picks from the runs this process watched, folded from the
								// dispatch lifecycle exactly as the terminal's worker blocks are.
								listWorkerRuns: () => acpWorkerRuns.list(),
								...(session
									? {
											exportTranscript: (path?: string): AcpHostReport =>
												writeTranscriptExport({
													sessionId: chat.getSessionId(),
													leafTurnId: (id) => session.tree(id).leafId,
													readEntries: readSessionEntriesForCompact,
													cwd: process.cwd(),
													...(path === undefined ? {} : { path }),
												}),
										}
									: {}),
								...(share ? archiveCommandHost(share) : {}),
								...(session
									? {
											oracleBriefing: () => {
												const sessionId = chat.getSessionId();
												if (sessionId === null) return { decisions: [], tasks: [], compactionSummary: null };
												return oracleBriefingFromEntries(
													readSessionEntriesForCompact(sessionId),
													session.tree(sessionId).leafId ?? undefined,
												);
											},
										}
									: {}),
								// The context verbs the TUI reaches through its hub. Each answers the
								// wire client with how it ended, because nothing else reaches one.
								...(session
									? {
											runCompact: async (instructions: string | undefined): Promise<AcpHostReport> => {
												// Compaction rewrites the context a running turn is reading.
												if (chat.isStreaming())
													return { level: "error", text: "Wait for the current turn to finish before compacting." };
												// chat.compact says nothing when it compacts. Every notice it raises
												// is a refusal, a failure, or an empty cut, so none reads as success.
												const notices: string[] = [];
												let failed = false;
												const stop = chat.onEvent((event) => {
													if (event.type !== "notice") return;
													notices.push(event.text);
													if (event.level === "error") failed = true;
												});
												try {
													await chat.compact(instructions);
												} finally {
													stop();
												}
												if (notices.length === 0)
													return { level: "success", text: "Context compacted. The next request starts from the summary." };
												const empty = notices.every((text) => text.includes("nothing to compact"));
												return { level: failed ? "error" : empty ? "info" : "warn", text: notices.join("\n") };
											},
											runContextRecall: async (ref: string): Promise<AcpHostReport> => {
												const outcome = runOperatorRecall(ref, {
													getSessionId: () => session.current()?.id ?? null,
													onActivity: (event) => bus.emit(BusChannels.ContextActivity, event),
													hasSession: () => session.current() !== null,
													readEntries: readCurrentSessionEntries,
													activeLeafTurnId: () => {
														const meta = session.current();
														return meta ? (session.tree(meta.id).leafId ?? undefined) : undefined;
													},
													appendEntry: (entry) => session.appendEntry(entry),
													onRecalled: (payload) => bus.emit(BusChannels.ContextRecalled, payload),
												});
												// The body answers the person; like the TUI's replay block it never becomes model context.
												return outcome.ok
													? { level: "success", text: `${outcome.headline}\n${outcome.body}` }
													: { level: "error", text: outcome.message };
											},
										}
									: {}),
								...(contextDomain
									? {
											runContextRefresh: async (): Promise<AcpHostReport> => {
												const capture = captureRunIo();
												await contextDomain.runContextRefresh({ cwd: process.cwd(), io: capture.io });
												return capture.report("Project context refreshed.");
											},
											// The terminal confirms a reset in its chooser; over ACP the operator's
											// confirmation is the --yes flag, checked by the command bridge.
											runContextClear: async (clear: {
												all?: boolean;
												confirmed?: boolean;
												confirmedAll?: boolean;
											}): Promise<AcpHostReport> => {
												// The command bridge refuses an unconfirmed reset before it gets here.
												if (clear.confirmed !== true) return { level: "warn", text: "Nothing was changed." };
												if (chat.isStreaming())
													return { level: "error", text: "Wait for the current turn to finish before resetting context." };
												const capture = captureRunIo();
												await contextDomain.runContextClear({
													cwd: process.cwd(),
													all: clear.all === true,
													io: capture.io,
													confirmContext: () => true,
													confirmAll: () => clear.confirmedAll === true,
												});
												return capture.report(
													clear.all === true ? "Project context and CLIO-CODER.md reset." : "Project context reset.",
												);
											},
											runInit: async (initOptions: Parameters<typeof runContextInit>[0]): Promise<AcpHostReport> => {
												const capture = captureRunIo();
												await runContextInit(initOptions, capture.io);
												return capture.report("Project context initialized.");
											},
										}
									: {}),
								...(agents ? { getAgentRoleFacts: agentRoleFactsResolver((id: string) => agents.getSpec(id)) } : {}),
								...(config ? { getWorkerRosters: () => config.get().fleet.rosters } : {}),
								...(resources
									? {
											parsePendingSkillRequests: (text: string, commandCwd?: string) =>
												resources.parsePendingSkillRequests(text, commandCwd ?? process.cwd()),
											// The prompt screen asks the same question the terminal editor
											// does before refusing a `/name` line: does a loaded template own it.
											expandPromptTemplate: (text: string, commandCwd?: string) =>
												resources.expandPromptTemplate(text, commandCwd ?? process.cwd()),
											listPromptNames: () => resources.promptsForDisplay(process.cwd()).items.map((prompt) => prompt.name),
										}
									: {}),
								submitTurn: (text, submitOptions) => {
									void chat
										.submit(
											text,
											submitOptions.pendingSkillRequests === undefined
												? {}
												: { pendingSkillRequests: [...submitOptions.pendingSkillRequests] },
										)
										.catch(() => undefined);
								},
								submitOperatorNote: (text) => {
									void chat.submit(text).catch(() => undefined);
								},
							}),
						}
					: {}),
				toolRegistry,
				labelOperatorCommand,
				hostToolEvents: acpHostToolEvents,
				...(session
					? {
							boardActions: bindBoardActions({
								decisionBoard,
								taskBank: () => taskMemoryBank.snapshot(),
								currentSession: () => session.current(),
								dataDir: clioDataDir(),
							}),
						}
					: {}),
				contextLedger: () => chat.contextLedger(),
				...(contextDomain
					? {
							cancelContextOperation: (sessionId: string, cwd: string, operationId?: string) =>
								contextDomain.cancelOperation?.(sessionId, cwd, operationId) ?? false,
						}
					: {}),
				// The plan rows the standard `plan` update carries, and the Git facts
				// the terminal footer shows, pushed instead of polled.
				plan: () => taskBoard.snapshot(),
				workspace: (cwd) => probeWorkspaceAsync(cwd),
				// /view's providers, bound to the session this host is running.
				...(session
					? {
							artifacts: {
								deps: (sessionId: string) => {
									const meta = session.current();
									if (!meta || meta.id !== sessionId) return null;
									return {
										stateDir: clioStateDir(),
										dataDir: clioDataDir(),
										...(dispatch ? { dispatch } : {}),
										sessionMeta: meta,
										readSessionEntries: readCurrentSessionEntries,
									};
								},
							},
						}
					: {}),
				...(extensions
					? {
							extensions: {
								list: () => extensions.list(process.cwd(), { all: true }),
								// The runtimes restart on the generation this commit published.
								reload: () => {
									const outcome = extensionReload.reload();
									if (outcome.status !== "committed") return outcome;
									if (acpExtensionHost) void acpExtensionHost.restart();
									else
										acpExtensionHostStart ??= startSessionExtensionHost("acp", acpExtensionAsk)
											.then(
												(host) => {
													acpExtensionHost = host;
												},
												(err) => {
													process.stderr.write(
														`[clio-coder:acp] extension host failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
													);
												},
											)
											.finally(() => {
												acpExtensionHostStart = undefined;
											});
									return outcome;
								},
							},
						}
					: {}),
				// /usage: the overlay's own fold of the cost ledger, and the quota service
				// behind its cache, so reopening the view does not spend a provider read.
				...(observability
					? {
							usage: {
								resetSession: (sessionId: string) => observability.resetSession(sessionId),
								subscribe: (listener: () => void) => observability.subscribe(listener),
								session: () => ({
									cost: observability.sessionCostSummary(),
									rows: aggregateCostEntries(observability.costEntries()),
								}),
								quota: async () => {
									if (acpQuota === null) {
										const { createQuotaService } = await import("../domains/quota/service.js");
										acpQuota = createQuotaService();
									}
									return acpQuota.read();
								},
							},
						}
					: {}),
				// /btw and /draft run the chat loop's own out-of-turn rounds, and a
				// draft is judged by the same `drafts` System One site the overlay uses.
				aside: {
					ask: (question, signal) => chat.askSideQuestion(question, { signal }),
					draft: async (request, count, signal) => {
						const outcome = await chat.draftCandidates(request, count, { signal });
						if (outcome.status === "refused" || outcome.aborted) return outcome;
						const drafted = draftsToJudge(outcome.candidates);
						const judgment =
							"reason" in drafted ? drafted : await judgeDraftsAtSite({ systemOne }, request, drafted.texts, signal);
						return { ...outcome, judgment };
					},
				},
				// The same reload /library reload runs, with the generation change the
				// PluginsReloaded event reports. A throw is a failed reload.
				libraryReload: () => {
					let reloaded: PluginsReloadedPayload | null = null;
					reloadPluginResourcesAndNotify(process.cwd(), (event) => {
						reloaded = event;
						bus.emit(BusChannels.PluginsReloaded, event);
					});
					const event = reloaded as PluginsReloadedPayload | null;
					if (event === null) throw new Error("plugin reload reported no generation");
					return { generation: event.generation, previousGeneration: event.previousGeneration, changed: event.changed };
				},
				...(toolBootstrap.mcpCapabilities ? { mcpCapabilities: toolBootstrap.mcpCapabilities } : {}),
				bus,
				autonomy: resolveBaselineAutonomy,
				routing: () => {
					const settings = getCurrentSettings();
					return {
						target: settings.chat.target,
						model: settings.chat.model,
					};
				},
				setSessionRouting: (patch) => {
					const current = getCurrentSettings();
					const target = patch.target ?? current.chat.target;
					const model = patch.model ?? current.chat.model;
					if (target && model && (patch.target !== undefined || patch.model !== undefined)) {
						selectModel(
							providers,
							{ target, model, thinkingLevel: patch.thinkingLevel ?? current.chat.thinkingLevel },
							(selected) => applyRoutingAtScope({ orchestrator: selected }, "session"),
							current.chat.modelPicker.recentLimit,
						);
						// ACP acknowledges choices before a turn; resume must see them even without inference (Y4 finding 4).
						const meta = session?.current();
						if (session && meta) {
							const recorded = resumedSessionRoute(meta, session.readEntries());
							if (recorded.target !== target || recorded.model !== model) {
								session.appendEntry({
									kind: "modelChange",
									parentTurnId: session.tree(meta.id).leafId,
									provider: providers.getTarget(target)?.runtime ?? target,
									target,
									modelId: model,
								});
								session.flushAppends?.();
							}
						}
					} else {
						applyRoutingAtScope(
							{
								orchestrator: {
									...patch,
									thinkingLevel: clampThinkingLevel(providers, target, model, patch.thinkingLevel ?? current.chat.thinkingLevel),
								},
							},
							"session",
						);
					}
				},
				onActiveSessionAutonomyChange: (level) => {
					activeAcpSessionAutonomy = level;
				},
				yoloRefusal: () => yoloRefusal,
				cwd: process.cwd(),
				version: readClioVersionLabel(),
				// Stdout belongs to JSON-RPC. Text this process did not author, such
				// as a provider's failure body, is kept off the wire and written to
				// the unstructured stderr tail instead.
				diagnostics: (line) => {
					process.stderr.write(`[clio-coder:acp] ${line}\n`);
				},
				permissionTimeoutMs:
					options.acp.permissionTimeoutMs ??
					config?.get().integrations.externalAgents.defaults.permissionTimeoutMs ??
					DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS,
			});
			// Same ordering the termination drain hook relies on: an aborted turn's
			// tool results still land and persist through the run's subscribers,
			// and the session writer stops in result.stop() below. Awaiting
			// settlement here makes a session append after session stop impossible
			// by ordering rather than by timing.
			await beginChatSettlement();
			// The drain hook that disposes the extension host never runs on this
			// path either, and its runtime children would keep the process alive
			// after the client left. Disposal is idempotent.
			await acpExtensionHostStart;
			await acpExtensionHost?.dispose();
			unsubscribeChatShutdown();
			unsubscribeDispatchShutdown?.();
			await dispatch.drain();
			await toolBootstrap.close();
			// A client that closes the session ends ACP here, outside the
			// termination coordinator, so its terminate hook never runs. Release
			// the Ollama models this process and its workers loaded on this path
			// too (#379); SIGINT and SIGTERM still reach the hook. The release
			// bounds itself by EXIT_RELEASE_MS and never throws.
			await releaseClioLoadedModelsOnExit();
			await result.stop();
			return { exitCode: code, bootTimeMs: timer.snapshot().totalMs };
		} finally {
			// A throw from the serve loop or settlement skips the disposal above,
			// and the runtime children would still hold the process open.
			await acpExtensionHostStart;
			await acpExtensionHost?.dispose();
			acpWorkerRuns.dispose();
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
		const headlessPermissionReason = HEADLESS_PERMISSION_DENIED_REASON;
		let headlessExtensionHost: import("./extension-host.js").ExtensionHost | null = null;
		// `--max-cost-usd` bounds what this run adds, so a continued session's
		// earlier spend does not count against it. It becomes the session
		// ceiling every paid request already passes: the main agent's, each
		// compaction's and each dispatch's admission. A lower configured
		// ceiling still holds.
		const runCostCap =
			options.headless.maxCostUsd === undefined
				? null
				: createRunCostCap(observability?.sessionCost() ?? 0, options.headless.maxCostUsd);
		if (runCostCap !== null) {
			startupOverrides.set(
				"safety.limits.sessionCostUsd",
				runCostCeilingUsd({
					spentUsd: runCostCap.startUsd,
					runMaxUsd: runCostCap.maxUsd,
					configuredUsd: getCurrentSettings().safety.limits.sessionCostUsd,
				}),
			);
			bumpSessionState();
			result.getContract<SchedulingContract>("scheduling")?.setRunCostCap?.(runCostCap);
		}
		const unpricedRoutes = runCostCap === null ? [] : unpricedRunRoutes(getCurrentSettings(), providers);
		if (unpricedRoutes.length > 0) {
			process.stderr.write(
				`clio-coder run: --max-cost-usd does not bound unpriced routes: ${unpricedRoutes.join(", ")}; declare targets[].pricing to bound them\n`,
			);
		}
		const unsubscribeHeadlessPermission = toolRegistry.onPermissionRequired((call, decision, meta) => {
			resolvePermission(
				{ bus, registry: toolRegistry },
				{
					action: "stop",
					payload: {
						status: "denied",
						requestId: meta.requestId,
						origin: "main",
						decidedBy: "policy:no-operator",
						tool: call.tool,
						actionClass: decision.classification.actionClass,
						reason: headlessPermissionReason,
						requestedBy: "headless",
					},
				},
			);
		});
		try {
			const parsedSkillRequest = resources?.parsePendingSkillRequests(options.headless.prompt, process.cwd()) ?? {
				text: options.headless.prompt,
				pendingSkillRequests: [],
			};
			const promptExpansion = resources?.expandPromptTemplate(parsedSkillRequest.text, process.cwd());
			if (promptExpansion?.expanded && promptExpansion.template.sourceInfo.owner)
				recordPackageActivity({
					type: "clio_coder_plugin_resource_use",
					kind: "prompt",
					owner: promptExpansion.template.sourceInfo.owner,
					outcome: "expanded",
					details: { name: promptExpansion.template.name },
				});
			// A prompt named as `/name` is a request for that template. When the
			// template refuses, the run says why and stops; sending the literal
			// `/name` on to the model spends a turn answering a command it cannot
			// run, and the operator never sees the refusal.
			if (promptExpansion?.expanded === false && promptExpansion.refusal) {
				writeRunDiagnostic(`clio-coder: ${promptExpansion.refusal.message}\n`);
				await termination.shutdown(1);
				return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
			}
			// A display-only template that reached boot (the CLI preflight answers
			// most of them earlier) is printed for the operator and the run ends;
			// its body was never model text.
			if (promptExpansion?.expanded === false && promptExpansion.display) {
				process.stdout.write(`${promptExpansion.display.text}\n`);
				await termination.shutdown(0);
				return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
			}
			// Started only for a run that reaches the model, so the early exits
			// above spawn no runtime. No operator answers here, so a tool's
			// interview is cancelled with reason headless.
			headlessExtensionHost = await startSessionExtensionHost("headless");
			// The first turn's turn_start reaches a runtime only once the startup
			// generation has committed. A run whose startup failed goes on without runtimes.
			await headlessExtensionHost?.ready.catch(() => undefined);
			const fileExpansion = await expandInlineFileReferencesAsync(
				promptExpansion?.expanded ? promptExpansion.text : parsedSkillRequest.text,
				{
					cwd: process.cwd(),
					includeImages: true,
					missing: "leave",
				},
			);
			// A template's allowed-tools and delegated-tools narrow the run's own
			// --allow-tools and --delegate-tools scope, never widen it.
			const template = promptExpansion?.expanded ? promptExpansion.template : undefined;
			const constraints = narrowTurnConstraints(
				options.headless.constraints,
				template?.allowedTools || template?.delegatedTools ? templateToolConstraints(template) : undefined,
			);
			// A headless template and its flags bind once for the whole run (#423).
			chat.setToolCeiling?.([constraints]);
			const images = [...(options.headless.images ?? []), ...fileExpansion.images];
			const workingContextPaths = [...(options.headless.workingContextPaths ?? []), ...fileExpansion.referencedPaths];
			startRunOutput();
			const code = await runHeadlessMainAgent(chat, {
				prompt: fileExpansion.text,
				...(constraints ? { constraints } : {}),
				...(images.length > 0 ? { images } : {}),
				...(workingContextPaths.length > 0 ? { workingContextPaths } : {}),
				...(options.headless.sampling ? { sampling: options.headless.sampling } : {}),
				...(parsedSkillRequest.pendingSkillRequests.length > 0
					? { pendingSkillRequests: parsedSkillRequest.pendingSkillRequests }
					: {}),
				mode: options.headless.mode ?? "text",
				...(options.headless.jsonEvents ? { jsonEvents: options.headless.jsonEvents } : {}),
				...(options.headless.steerChannel ? { steerChannel: options.headless.steerChannel } : {}),
				...(options.headless.failOnNoop === true ? { failOnNoop: true } : {}),
				...(options.headless.deadline !== undefined ? { deadline: options.headless.deadline } : {}),
				...(dispatch ? { dispatch } : {}),
				scopeNotices: (listener) => bus.on(BusChannels.DispatchScopeNotice, listener),
				...(observability ? { costEntries: () => observability.costEntries() } : {}),
				...(runCostCap !== null ? { costCap: { maxUsd: runCostCap.maxUsd, unpricedRoutes } } : {}),
				getSessionHeader: () => printJsonSessionHeader(session?.current() ?? null),
			});
			if (code === 0) {
				const deadline = options.headless.deadline;
				await memoryOwner.retainTask(
					"headless",
					deadline?.expired() ? 0 : Math.min(5000, deadline?.remainingMs?.() ?? 5000),
				);
				const meta = session?.current();
				if (meta) saveTaskBankSnapshot(clioStateDir(), meta.id, taskMemoryBank.snapshot());
			}
			await termination.shutdown(code);
			return { exitCode: code, bootTimeMs: timer.snapshot().totalMs };
		} finally {
			unsubscribeHeadlessPermission();
			unsubscribeLoopGuardStop();
			// A run that throws skips the termination drain; the host's runtime
			// children would otherwise keep the process alive. Disposal is idempotent.
			await headlessExtensionHost?.dispose();
		}
	}

	if (options.terminalLease) {
		for (const diagnostic of options.terminalLease.takeDiagnostics()) {
			const text = diagnostic.text.trimEnd();
			if (text.length > 0) initialNotices.push(text);
		}
	}

	const activePluginIds = () =>
		pluginSnapshotFor(process.cwd())
			.packages.filter((p) => p.loadable && (p.kind === undefined || p.kind === "plugin"))
			.map((p) => p.id);
	let dashboardPlugins = activePluginIds();
	const unsubscribeDashboardPlugins = bus.on(BusChannels.PluginsReloaded, () => {
		dashboardPlugins = activePluginIds();
	});
	termination.onTerminate(() => unsubscribeDashboardPlugins());
	const { startInteractive } = await import("../interactive/index.js");
	await startInteractive({
		jobs: jobHost.operations,
		getConnections: () => ({
			mcp: toolBootstrap.mcpCapabilities?.connectedIds({ readyOnly: true }) ?? [],
			plugins: dashboardPlugins,
		}),
		bus,
		providers,
		dispatch,
		...(agents ? { agents } : {}),
		...(() => {
			const scheduling = result.getContract<SchedulingContract>("scheduling");
			return scheduling ? { scheduling } : {};
		})(),
		systemOne,
		recordOutcome: (outcome) => systemOneHost.recordOutcome(outcome),
		observability,
		chat,
		...(options.terminalLease
			? {
					terminalLease: options.terminalLease,
					onHydratedFrameCommit: (frameId: number | null, interactivity: BootInteractivity) => {
						timer.mark("Stage 1 hydration", frameId === null ? undefined : `frameId=${frameId}`);
						const line = formatBootTrace("Stage 0 input blocked", `max=${interactivity.inputBlockedMaxMs.toFixed(1)}ms`);
						if (line) options.terminalLease?.deferDiagnostic("stderr", line);
						// Every reload subscriber exists now; a settings write held
						// during hydration reloads here.
						config?.releaseReloads?.();
					},
				}
			: { onFirstFrameCommit: () => timer.mark("first TUI paint") }),
		...(initialNotices.length > 0 ? { initialNotices } : {}),
		yoloRefusal,
		...(yoloHeldAtBoot ? { yoloHeldAtBoot: true } : {}),
		...(resources ? { resources } : {}),
		...(extensions ? { extensions } : {}),
		runtimeHooks,
		reloadExtensions: () => {
			const outcome = extensionReload.reload();
			for (const issue of outcome.diagnostics.entries) reloadClasses.captureIssue(`${issue.type}: ${issue.message}`);
			return outcome;
		},
		reloadPlugins,
		reloadClasses,
		armRestartHandoff: () => armRestartHandoff(clioStateDir(), termination),
		...(interop ? { interop } : {}),
		...(share ? { share } : {}),
		...(mux ? { mux } : {}),
		...(panes ? { panes } : {}),
		...(music ? { music } : {}),
		...(panes ? { attachYaziBridge: (bridge) => panes.attachYazi(bridge) } : {}),
		// The interactive surface never imports the panes glue itself; the
		// factories arrive only on an active boot, through the same dynamic
		// import that loaded the mux domain.
		...(withPanes
			? {
					createMuxBridge: withPanes.createMuxBridge,
					createPeerInbox: withPanes.createPeerInbox,
					createYaziBridge: withPanes.createYaziBridge,
					createWatchPane: withPanes.createWatchPaneController,
				}
			: {}),
		...(panes ? { attachWatchPane: (controller) => panes.attachWatch(controller) } : {}),
		toolRegistry,
		...(session ? { session } : {}),
		...(session ? { readSessionEntries: readCurrentSessionEntries } : {}),
		gitHookChanges: () => hookDrift.sessionChanges(),
		labelOperatorCommand,
		getTaskBoard: () => taskBoard.cachedSnapshot(),
		getDecisionBoard: () => decisionBoard.snapshot(),
		supersedeDecision: (interviewId, key, correction) => decisionBoard.supersede(interviewId, key, correction),
		userTasks,
		getTaskMemoryStatus: () => {
			const settings = getCurrentSettings();
			const bank = memoryOwner.contract.taskSnapshot();
			return {
				enabled: settings.context.memory.enabled,
				tier: taskMemoryTier(),
				route: resolveMemoryRoute(settings),
				size: taskMemoryBankSize(bank),
				bank,
				...projectTaskMemoryActivity(
					memoryOwner.contract.interventionStatus(),
					historyReviews.recent(session?.current()?.id ?? null),
					MEMORY_INTERVENTION_ACTIVITY_LIMIT,
				),
				stepInFlight: memoryIntervention.stepInFlight(),
				guardian: currentGuardianState(),
				observations: memoryOwner.contract.observationStatus(),
				retention: memoryOwner.contract.retentionStatus(),
				promptSelection: memoryOwner.contract.promptSelection?.() ?? null,
				// Fold available retained telemetry across sessions; rotation bounds this history.
				spend: readTaskMemorySpendSummary(clioStateDir()),
			};
		},
		getTaskMemorySeedOffer,
		seedTaskMemory: seedCurrentTaskMemoryFromHandoff,
		stateDir: clioStateDir(),
		dataDir: clioDataDir(),
		registerAskUserHandler: (handler) => {
			askUserHandler = handler;
			return () => {
				if (askUserHandler === handler) askUserHandler = null;
			};
		},
		getSettings: getCurrentSettings,
		onConfigure: async () => {
			const before = readSettings();
			const current = getCurrentSettings();
			config?.holdReloads?.(
				current.targets.filter(
					(target) => target.id === current.chat.target && !before.targets.some((saved) => saved.id === target.id),
				),
			);
			let code: number;
			try {
				const { runConfigureCommand } = await import("../cli/configure.js");
				code = await runConfigureCommand([]);
			} finally {
				try {
					const after = readSettings();
					// Only setup's saved routing delta supersedes this session's route.
					// Apply it before publishing reload events so they see the new route.
					const patch = diffRouting(before, after);
					if (patch) {
						if (patch.orchestrator && (before.chat.target !== after.chat.target || before.chat.model !== after.chat.model)) {
							patch.orchestrator.target = after.chat.target;
							patch.orchestrator.model = after.chat.model;
						}
						applyRoutingPatch(sessionRouting, patch);
					}
					bumpSessionState();
					persistCurrentThinkingLevel();
					config?.reload?.();
				} finally {
					config?.releaseReloads?.();
				}
			}
			if (code !== 0 && code !== 130) throw new Error("Configure could not complete.");
			if (JSON.stringify(before) === JSON.stringify(readSettings())) return "No changes saved.";
			const route = getCurrentSettings().chat;
			return `Setup saved. Active route: ${route.target ?? "(none)"}/${route.model ?? "(no model)"}.`;
		},
		getFleetNodes: () => result.getContract<SchedulingContract>("scheduling")?.fleet?.list() ?? [],
		getRouteBreakers: () => result.getContract<DispatchContract>("dispatch")?.routeBreakers?.() ?? [],
		onBackgroundDispatch: () => dispatchBackground.backgroundNewest(),
		// A boot-time resume opens onto an existing conversation, so the welcome
		// header starts collapsed rather than offering fresh-start onboarding.
		...(resumedSessionAtBoot ? { startsResumed: true } : {}),
		...(session ? { getSessionId: () => session.current()?.id ?? null } : {}),
		...(contextDomain
			? {
					getContextState: (cwd?: string) => contextDomain.contextState(cwd),
					onInit: runContextInit,
					onContextClear: async (options: { all?: boolean; confirmed?: boolean; confirmedAll?: boolean }, runIo?: RunIo) => {
						await contextDomain.runContextClear({
							cwd: process.cwd(),
							all: options.all === true,
							...(runIo ? { io: runIo } : {}),
							confirmContext: () => options.confirmed === true,
							confirmAll: () => options.confirmedAll === true,
						});
					},
					onContextRefresh: async (runIo?: RunIo) => {
						await contextDomain.runContextRefresh({
							cwd: process.cwd(),
							...(runIo ? { io: runIo } : {}),
						});
					},
				}
			: {}),
		onSetThinkingLevel: (level, scope) => {
			const current = getCurrentSettings();
			const nextLevel = clampThinkingLevel(providers, current.chat.target, current.chat.model, level);
			// An unscoped caller gets the scope that cannot outlive this session.
			applyRoutingAtScope({ orchestrator: { thinkingLevel: nextLevel } }, scope ?? "session");
		},
		onCycleThinking: () => routingGestures.cycleThinking(),
		onSelectModel: ({ target, model }, scope) => {
			const settings = getCurrentSettings();
			selectModel(
				providers,
				{ target, model, thinkingLevel: settings.chat.thinkingLevel },
				(selected) => applyRoutingAtScope({ orchestrator: selected }, scope),
				settings.chat.modelPicker.recentLimit,
			);
		},
		writeSettings: (next) => applySettingsBlob(next),
		commitSetting: (id, next, scope) => commitSetting(id, next, scope),
		...(session
			? {
					onResumeSession: (sessionId) => {
						try {
							session.resume(sessionId);
							taskBoard.snapshot();
						} catch (err) {
							process.stderr.write(
								`[/resume] failed to resume ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
							);
						}
					},
					onNewSession: () => {
						const settings = getCurrentSettings();
						const input: { cwd: string; target?: string; model?: string } = { cwd: process.cwd() };
						if (settings.chat.target) input.target = settings.chat.target;
						if (settings.chat.model) input.model = settings.chat.model;
						session.create(input);
						persistCurrentThinkingLevel();
						observability?.resetSession(session.current()?.id ?? null);
						taskBoard.snapshot();
					},
					onForkSession: (parentTurnId) => {
						try {
							session.fork(parentTurnId);
							taskBoard.snapshot();
						} catch (err) {
							process.stderr.write(
								`[/fork] failed at turn ${parentTurnId}: ${err instanceof Error ? err.message : String(err)}\n`,
							);
						}
					},
					onRecoverHandoff: (handoffId, action) => chat.recoverHandoff(handoffId, action),
					onCompact: async (instructions) => {
						await chat.compact(instructions);
					},
				}
			: {}),
		onCycleScopedModelForward: () => routingGestures.cycleScopedModel("forward"),
		onCycleScopedModelBackward: () => routingGestures.cycleScopedModel("backward"),
		onShutdown: async () => {
			await termination.shutdown(0);
		},
	});
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}

/** The shared handoff service, bound to one host's session and chat for the ACP server. */
function bindAcpHandoff(deps: HandoffServiceDeps): AcpHandoffControl {
	return {
		prepare: (goal) => prepareHandoff(deps, goal),
		commit: (draft, document) => commitHandoff(deps, draft, document),
	};
}

/** The configured task worktree root, or the default when settings cannot be read this early in boot. */
function startupWorktreeRootSetting(): string {
	try {
		return readSettings().fleet.worktrees.root;
	} catch {
		return "disk";
	}
}
