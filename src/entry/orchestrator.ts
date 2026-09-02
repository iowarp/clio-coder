import { join } from "node:path";
import chalk from "chalk";
import { modelBootstrapGenerate, resolveBootstrapRoute } from "../cli/bootstrap-generate.js";
import { runHeadlessMainAgent } from "../cli/modes/print.js";
import { formatBootTrace } from "../core/boot-trace.js";
import { BusChannels } from "../core/bus-events.js";
import { installBusTracer } from "../core/bus-trace.js";
import { type ClioSettings, readSettings, type SettingsMutator, updateSettings } from "../core/config.js";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../core/defaults.js";
import { loadDomains } from "../core/domain-loader.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { expandInlineFileReferencesAsync } from "../core/file-references.js";
import { setGitCommitAttributionEnabled } from "../core/git-commit-attribution.js";
import { configureGuardrails, guardrailValuesFromSettings } from "../core/guardrails.js";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../core/headless-permission.js";
import { rememberRecentModel } from "../core/recent-models.js";
import { protectedResidencyModels } from "../core/residency-protection.js";
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
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import { renderAgentCatalogSectionsFromSpecs } from "../domains/agents/catalog.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule, createConfigDomainModule } from "../domains/config/index.js";
import type { ContextContract } from "../domains/context/contract.js";
import { bootstrapInputFromInitOptions } from "../domains/context/init-options.js";
import { createContextDomainModule } from "../domains/context/runtime.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { createDispatchDedupRegistration } from "../domains/dispatch/dedup.js";
import { agentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import { readGateDecisionArtifacts, readPendingGateDecisions } from "../domains/dispatch/gate-decisions.js";
import { createDispatchDomainModule } from "../domains/dispatch/index.js";
import { configureRunEventJournal } from "../domains/dispatch/run-event-journal.js";
import { type ExtensionsContract, ExtensionsDomainModule } from "../domains/extensions/index.js";
import { type InteropContract, InteropDomainModule } from "../domains/interop/index.js";
import {
	describeUpgradeNotice,
	ensureClioState,
	LifecycleDomainModule,
	takeUpgradeNotice,
} from "../domains/lifecycle/index.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import {
	buildMemoryPromptSection,
	canonicalMemoryRepositoryIdentity,
	createTaskMemoryTelemetrySink,
	createTaskMemoryTrace,
	loadMemoryRecordsSync,
	proposeInjectedTaskMemory,
	readTaskMemorySpendSummary,
	renderTaskMemoryHandoffSource,
	seedTaskMemoryFromNewestHandoff,
	type TaskMemoryEntry,
	type TaskMemoryModelClient,
	type TaskMemoryStepUsage,
	taskMemoryBankSize,
	taskMemoryHandoffSeedOffer,
	taskMemoryTracePath,
} from "../domains/memory/index.js";
import { TaskMemoryBank } from "../domains/memory/task-bank.js";
import {
	createDetachedDispatchNudgeRegistration,
	createReadOnlyExplorationNudgeRegistration,
	createUnbackedWorkerClaimRegistration,
	openDetachedBatchViews,
} from "../domains/middleware/dispatch-nudge.js";
import {
	createHookReceiptLog,
	createMarketplaceOfferRegistration,
	createMiddlewareToolChoiceControl,
	createSkillsReminderRegistration,
	formatRegistrationConflict,
	type MiddlewareContract,
	MiddlewareDomainModule,
	writeMiddlewareDiagnosticToStderr,
} from "../domains/middleware/index.js";
import { createMemoryInterventionRegistration } from "../domains/middleware/memory-intervention.js";
import { announceMemoryStepEndpoint } from "../domains/middleware/memory-step-endpoint.js";
import { createTaskBoardReminderRegistration } from "../domains/middleware/task-board-reminder.js";
import { createTaskNudgeRegistration } from "../domains/middleware/task-nudge.js";
import { createWatchdogRegistration } from "../domains/middleware/watchdog.js";
import type { MuxContract } from "../domains/mux/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import { ObservabilityDomainModule, recordBackgroundMemoryStep } from "../domains/observability/index.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import type { ProvidersContract, TargetDescriptor, ThinkingLevel } from "../domains/providers/index.js";
import {
	AGENT_ROLE_TOOLS_REQUIRED_REASON,
	applyModelCapabilityPatch,
	canonicalEndpointKey,
	firstRuntimeResolutionError,
	foregroundStreamUsage,
	isOrchestratorEligibleRuntime,
	normalizeCostProvenance,
	ProvidersDomainModule,
	refineRuntimeTargetWithModelHints,
	registerForegroundStream,
	resolveModelCapabilities,
	resolveModelRuntimeCapabilitiesForProviders,
	resolveRuntimeTarget,
	supportsAgentRoleTools,
	targetRequiresAuth,
	VALID_THINKING_LEVELS,
} from "../domains/providers/index.js";
import { memoryInterventionModelMaxTokens } from "../domains/providers/model-runtime-capabilities.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import {
	createResourcesDomainModule,
	discoverMarketplaceSkills,
	installSkill,
	modelVisibleSkills,
	type ResourcesContract,
} from "../domains/resources/index.js";
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
import { estimateTokens } from "../domains/session/compaction/tokens.js";
import { ceilChars } from "../domains/session/context-accounting.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import { createDecisionBoardStore } from "../domains/session/decision-board.js";
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
import { ToolchainDomainModule } from "../domains/toolchain/index.js";
import { createUserTasksStore } from "../domains/user-tasks/store.js";
import { type AcpSafeSettingsPatch, type AcpSafeSettingsSnapshot, serveClioAcpAgent } from "../engine/acp/server.js";
import { createStdioServerTransport } from "../engine/acp/transport.js";
import { completeEngineText } from "../engine/ai.js";
import { setProtectedModelsProvider } from "../engine/apis/residency.js";
import {
	createLoopGuardRegistration,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	readOrchTurnToolCallBudget,
} from "../engine/loop-guard.js";
import { cwdHash, openSession, readSessionTailTurns, sessionCurrentPath, sessionPaths } from "../engine/session.js";
import type { EngineModel } from "../engine/types.js";
import { createChatLoop } from "../interactive/chat-loop.js";
import { type RunIo, startInteractive } from "../interactive/index.js";
import { buildModelReplayAgentMessagesFromTurns } from "../interactive/model-session-replay.js";
import type { BootOptions } from "./boot-options.js";
import { createExtensionReloadCoordinator } from "./extension-reload.js";
import { resolvePanesEnablement } from "./panes-activation.js";

export type { BootOptions, HeadlessSamplingOverrides } from "./boot-options.js";

import {
	detectPlatformKeybindingWarnings,
	detectTerminalKeySupport,
	formatInvalidKeybindingNotice,
	formatPlatformKeybindingNotice,
	validateKeybindings,
} from "../interactive/keybinding-manager.js";
import { subscribeLoopGuardStop } from "../interactive/loop-guard-interrupt.js";
import { BUILTIN_SLASH_COMMANDS } from "../interactive/slash-commands.js";
import { createToolProseRegistration } from "../interactive/tool-prose-registration.js";
import { runWatchdogReview } from "../interactive/watchdog-run.js";
import { type AskUserHandler, cancelledAskUserResult } from "../tools/ask-user.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { isGitRepository, recoverCleanupReadyCompeteGroups } from "../tools/compete-worktrees.js";
import { createDispatchBackgroundRegistry } from "../tools/dispatch-background.js";
import { dispatchSchemaCompositionFor } from "../tools/dispatch-schema.js";
import { createFileMutationObserver, createSkillActivationObserver } from "../tools/observers.js";
import { createRegistry } from "../tools/registry.js";
import { sweepExpiredToolOffloads } from "../tools/result-shaping.js";

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
	const { clio } = getVersionInfo();
	return `
  ${chalk.cyan("Clio Coder")}
  ${chalk.dim(`v${clio} · CLIO: Context Layer for I/O · HPC & scientific software`)}
  ${bannerConfigurationLine()}
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

interface CompactionResolution {
	model: EngineModel;
	targetId: string;
	endpointKey: string | null;
	apiKey?: string;
}

function resolveTarget(providers: ProvidersContract, targetId: string | null | undefined): TargetDescriptor | null {
	if (!targetId) return null;
	return providers.getTarget(targetId);
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

async function resolveApiKeyForTarget(
	target: TargetDescriptor,
	providers: ProvidersContract,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const runtime = providers.getRuntime(target.runtime);
	if (!runtime) return undefined;
	// A target that needs no credential still needs the placeholder. Returning
	// nothing here left compaction as the one path that did not send it, so
	// `/context compact` and every automatic compaction at the window threshold
	// failed on exactly the local runtimes Clio is built for, while ordinary
	// turns against the same target succeeded.
	if (!targetRequiresAuth(target, runtime)) return LOCAL_API_KEY_FALLBACK;
	const resolved = await providers.auth.resolveForTarget(target, runtime, signal ? { signal } : undefined);
	return resolved.apiKey;
}

/**
 * The background memory role, resolved to the endpoint it would call.
 *
 * The endpoint key is what lets the middleware decline a step that would land
 * on the same inference scheduler the chat target is streaming against (#229,
 * #250), and it is the same key dispatch admission counts slots on.
 */
interface BackgroundMemoryRoute {
	client: TaskMemoryModelClient;
	targetId: string;
	wireModelId: string;
	endpointKey: string | null;
	modelMaxTokens(configuredMaxTokens: number): number;
}

function createBackgroundMemoryModelClient(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
	timeoutMs: number,
	bus: Pick<SafeEventBus, "emit"> | null,
): BackgroundMemoryRoute | null {
	const targetId = settings.context.memory.target?.trim();
	const wireModelId = settings.context.memory.model?.trim();
	if (!targetId || !wireModelId) return null;
	// One model cannot both drive the action agent and think its way through a
	// memory step: the memory call would contend with the agent's own decoding on
	// the same server, and a reasoning model spends most of a memory step
	// deliberating over a task it is not executing. Memory falls back to its free
	// deterministic tier rather than degrading the work the operator asked for.
	if (backgroundSharesReasoningModelWithOrchestrator(providers, settings)) return null;
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
	const kbHit = providers.knowledgeBase?.lookup(resolved.target.wireModelId) ?? null;
	const model = resolved.target.runtime.synthesizeModel(resolved.target.target, resolved.target.wireModelId, kbHit);
	const refined = refineRuntimeTargetWithModelHints(resolved.target, model, providers.knowledgeBase);
	applyModelCapabilityPatch(model, refined.capabilities);
	const costProvenance = normalizeCostProvenance(refined.costProvenance);
	const endpointKey = canonicalEndpointKey(refined.target);
	return {
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
			// Wrapped at the layer that knows a request left the process: the step
			// holds endpoint capacity while it is out and publishes the cache
			// disturbance even when a timeout means the usage sink never sees it.
			complete: announceMemoryStepEndpoint({ bus, endpointKey, targetId }, async (request) => {
				const apiKey = targetRequiresAuth(refined.target, refined.runtime)
					? (await providers.auth.resolveForTarget(refined.target, refined.runtime, { signal: request.signal })).apiKey
					: LOCAL_API_KEY_FALLBACK;
				const startedAt = Date.now();
				const completion = await completeEngineText({
					model,
					systemPrompt: request.systemPrompt,
					userPrompt: request.userPrompt,
					maxTokens: request.maxTokens,
					// Always off, never the operator's chat thinking level. A model that
					// reasons anyway still works: `completeEngineText` keeps only text
					// blocks, and the memory output budget leaves room for the preamble.
					thinkingLevel: "off",
					signal: request.signal,
					timeoutMs,
					...(apiKey === undefined ? {} : { apiKey }),
				});
				// The step is billed here whatever the policy later decides about the
				// answer. A model that read a trajectory and chose silence spent the
				// same prefill as one that produced a reminder.
				return {
					text: completion.text,
					inputTokens: completion.inputTokens,
					outputTokens: completion.outputTokens,
					usage: {
						targetId,
						attributedModelId: refined.wireModelId,
						input: completion.usage.input,
						output: completion.usage.output,
						cacheRead: completion.usage.cacheRead,
						cacheWrite: completion.usage.cacheWrite,
						reasoning: completion.usage.reasoning,
						totalTokens: completion.usage.totalTokens,
						costUsd: completion.usage.costUsd,
						costProvenance,
						durationMs: Date.now() - startedAt,
						backend: completion.backend,
					},
				};
			}),
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

/**
 * True when the background role names the same model the orchestrator runs and
 * that model reasons. Distinct models, or a non-reasoning shared model, are both
 * fine; this only catches the one-model-does-everything configuration.
 */
function backgroundSharesReasoningModelWithOrchestrator(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): boolean {
	const backgroundModel = settings.context.memory.model?.trim();
	const orchestratorModel = settings.chat.model?.trim();
	if (!backgroundModel || backgroundModel !== orchestratorModel) return false;
	if (settings.context.memory.target?.trim() !== settings.chat.target?.trim()) return false;
	try {
		const status = providers.list().find((entry) => entry.target.id === settings.context.memory.target?.trim());
		if (!status) return false;
		return resolveModelCapabilities(status, backgroundModel, providers.knowledgeBase).reasoning === true;
	} catch {
		// An unresolvable capability is not evidence of a reasoning model; the
		// operator's explicit configuration stands.
		return false;
	}
}

function synthesizeOrchestratorModel(
	providers: ProvidersContract,
	target: TargetDescriptor,
	wireModelId: string,
): EngineModel | null {
	const runtime = providers.getRuntime(target.runtime);
	if (!runtime) return null;
	let model: EngineModel;
	try {
		const kbHit = providers.knowledgeBase?.lookup(wireModelId) ?? null;
		model = runtime.synthesizeModel(target, wireModelId, kbHit);
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
	const targetId = settings.chat?.target ?? null;
	const wireModelId = settings.chat?.model ?? null;
	if (!targetId || !wireModelId) return null;
	const target = resolveTarget(providers, targetId);
	if (!target) return null;
	const model = synthesizeOrchestratorModel(providers, target, wireModelId);
	if (!model) return null;
	const apiKey = await resolveApiKeyForTarget(target, providers);
	const resolution: CompactionResolution = { model, targetId, endpointKey: canonicalEndpointKey(target) };
	if (apiKey !== undefined) resolution.apiKey = apiKey;
	return resolution;
}

function readSessionEntriesForCompact(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
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
): Promise<CompactResult | null> {
	const meta = session.current();
	if (!meta) {
		throw new Error("no current session to compact; start one with /new or /resume first");
	}
	const resolved = await resolveCompactionModel(settings, providers);
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
	const activeLeafTurnId = session.tree(meta.id).leafId ?? undefined;
	const entries = filterEntriesToActivePath(readSessionEntriesForCompact(meta.id), activeLeafTurnId);
	if (entries.length === 0) return null;

	// A compaction summary is a full streamed request against the chat target.
	// Hold the same canonical endpoint slot as an ordinary turn, /btw round, or
	// pre-warm so dispatch admission and background memory see its real usage.
	const releaseEndpointSlot = resolved.endpointKey === null ? () => {} : registerForegroundStream(resolved.endpointKey);
	let result: CompactResult;
	try {
		result = await compact({
			entries,
			model: resolved.model,
			...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
			...(instructions !== undefined ? { instructions } : {}),
		});
	} finally {
		releaseEndpointSlot();
	}
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
		// The summarization call is a real model call. Persisting its provider
		// usage on the entry is what puts it in front of `/cost` and `clio-coder usage
		// report`, which folded the ledger and so counted every call but this one.
		...(result.usage !== undefined ? { usage: result.usage } : {}),
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
function createProductionAutoCompact(
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
function estimateTokensAfterCompaction(entries: ReadonlyArray<SessionEntry>, result: CompactResult): number {
	let droppedTokens = 0;
	for (const entry of entries.slice(0, result.firstKeptEntryIndex)) droppedTokens += estimateTokens(entry);
	const summaryTokens = estimateTokensFromSummary(result.summary);
	// The summary alone is the floor: a session whose dropped estimate exceeds
	// the measured anchor must not report a negative or sub-summary context.
	return Math.max(summaryTokens, result.tokensBefore - droppedTokens + summaryTokens);
}

/**
 * Alt+J / Alt+K step the orchestrator through the `scope` list of target
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
			? (phase) => {
					const line = formatBootTrace(phase);
					if (line) options.terminalLease?.deferDiagnostic("stderr", line);
				}
			: undefined,
	);
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	installBusTracer();
	termination.installSignalHandlers();

	ensureClioState();
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
				bootStderr(`[dispatch] compete recovery preserved ${failure.group}: ${failure.message}\n`);
			}
		} catch (err) {
			bootStderr(`[dispatch] compete recovery failed closed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}

	let effectiveSettingsForDispatch: (() => Readonly<ClioSettings>) | null = null;
	let protectedArtifactStateForDispatch: (() => ProtectedArtifactState) | null = null;

	// Panes are an interactive-surface projection. Headless, ACP, and worker boots
	// gate detection off so they never resolve a socket path or open a descriptor.
	// This mirrors the `interactive` predicate computed after the domains load.
	const muxInteractive = !options.headless && options.acp === undefined && process.env.CLIO_CODER_INTERACTIVE === "1";
	// The rung is settled before the config contract loads, off the settings the
	// interactive entry point already read strictly (`src/cli/clio.ts:31`) and
	// the `--with-panes` / `--no-panes` flag, which wins in both directions. This
	// is why `panes.enabled` is a restart-scoped row: the decision runs once,
	// here. An inactive rung loads nothing: the whole extension, mux domain
	// included, lives behind the dynamic import below.
	const muxEnablement = resolvePanesEnablement(options.panes, options.startupSettings?.interface.panes.enabled);
	const withPanes = muxInteractive && muxEnablement !== "off" ? await import("./with-panes.js") : null;

	const result = await loadDomains(
		[
			options.startupSettings ? createConfigDomainModule(options.startupSettings) : ConfigDomainModule,
			ExtensionsDomainModule,
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
			createContextDomainModule({ noContextFiles: options.noContextFiles === true }),
			ProvidersDomainModule,
			ToolchainDomainModule,
			SafetyDomainModule,
			createPromptsDomainModule({
				noContextFiles: options.noContextFiles === true,
			}),
			AgentsDomainModule,
			MiddlewareDomainModule,
			SessionDomainModule,
			ObservabilityDomainModule,
			SchedulingDomainModule,
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
				getSettings: () => effectiveSettingsForDispatch?.(),
				getProtectedArtifactState: () => protectedArtifactStateForDispatch?.() ?? { artifacts: [] },
				autonomyOverride: options.headless?.autonomy !== undefined,
				// The domain owns the durable journal here, not the dispatch
				// tool's event registry: `/run`, a watchdog run, and a model
				// dispatch all have to leave the same transcript behind, and only
				// the last of the three ever reaches that registry.
				journalRunEvents: true,
			}),
			LifecycleDomainModule,
		],
		{ diagnostic: bootStderr },
	);
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
	const interactive = !options.headless && !acpMode && process.env.CLIO_CODER_INTERACTIVE === "1";
	if (!interactive && !options.headless && !acpMode) {
		bootStdout(buildBanner());
		if (process.env.CLIO_CODER_TIMING === "1") bootStdout(`${timer.report()}\n`);
	}

	const config = result.getContract<ConfigContract>("config");
	const providers = result.getContract<ProvidersContract>("providers");
	timer.mark("providers resolved");

	if (options.apiKey) {
		if (!providers) {
			bootStderr("Clio Coder: --api-key supplied but providers domain unavailable; ignoring.\n");
		} else {
			const settingsNow = applyHeadlessSettingsOverlay(config?.get() ?? readSettings(), options.headless);
			const activeTargetId = settingsNow.chat?.target;
			const target = resolveTarget(providers, activeTargetId);
			const runtime = target ? providers.getRuntime(target.runtime) : null;
			if (target && runtime) {
				providers.auth.setRuntimeOverrideForTarget(target, runtime, options.apiKey);
			} else {
				bootStderr("Clio Coder: --api-key supplied but no active orchestrator target is configured; ignoring.\n");
			}
		}
	}

	if (!interactive && !options.headless && !acpMode) {
		bootStdout(`${chalk.dim("  (non-interactive boot. pass CLIO_CODER_INTERACTIVE=1 to launch the TUI.)")}\n`);
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
	const mux = result.getContract<MuxContract>("mux");
	const contextDomain = result.getContract<ContextContract>("context");
	const interop = result.getContract<InteropContract>("interop");
	// Boot detection resolves paths only: no `--version` subprocess and no skill
	// walk on the boot path. The hint is gated on `interactive`, which is already
	// false under headless and ACP.
	const interopReport = interactive && interop ? await interop.detect({ cwd: process.cwd() }) : null;
	const initialNotices = interactive ? [...(contextDomain?.startupHints() ?? [])] : [];
	// Once per version, interactive only: headless and ACP have no operator at
	// the keyboard to tell, and the record is left unclaimed for the boot that does.
	const upgrade = interactive ? takeUpgradeNotice() : null;
	if (upgrade !== null) initialNotices.push(describeUpgradeNotice(upgrade));
	if (interop && interopReport) {
		const interopHint = interop.bootHint(interopReport);
		if (interopHint !== null) initialNotices.push(interopHint);
	}
	if (!providers || !dispatch || !observability || !safety || !middleware) {
		bootStderr(
			"Clio Coder: chat mode requires safety + middleware + providers + dispatch + observability contracts; aborting.\n",
		);
		await termination.shutdown(1);
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
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
			resolvedResumeId = requestedResume.id;
		} else {
			const latest = session.history()[0];
			if (latest === undefined) headlessResumeFailure = `no previous session recorded for ${process.cwd()}`;
			else resolvedResumeId = latest.id;
		}
	}
	const resumeId = resolvedResumeId;
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
		bootStderr(`clio-coder run: ${headlessResumeFailure}\n`);
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

	// Install guardrail policy before any guard registration or tool reads it.
	// The effective session view replaces this boot projection below.
	const resolvedSettings = config?.get() ?? readSettings();
	configureGuardrails(guardrailValuesFromSettings(resolvedSettings));

	// The journal sink sits on the dispatch event path, where reading settings
	// would be both a cost and a throw site. The effective session view replaces
	// this boot projection below.
	configureRunEventJournal(resolvedSettings.fleet.history.journal);

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
			turnToolCallBudget: () => readOrchTurnToolCallBudget(),
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
				// Same lookup context(scope="skills") lists under its Marketplace
				// heading, minus what is already installed, so the count the
				// reminder quotes is the count the listing will show.
				countInstallableSkills: () => {
					const installed = new Set(resources.skills(process.cwd()).items.map((skill) => skill.name));
					return discoverMarketplaceSkills({ cwd: process.cwd() }).skills.filter((skill) => !installed.has(skill.name))
						.length;
				},
			}),
		);
	}
	// Task-board reminder: same user-message-visible channel, fired once per
	// session when a request literally enumerates three or more steps. The
	// static routing line and tasks hint ask for the same board; battery-tested
	// local models only comply when the instruction rides the user message.
	middleware.registerHook(createTaskBoardReminderRegistration());
	const taskMemoryBank = new TaskMemoryBank();
	let taskMemorySessionId = session?.current()?.id ?? null;
	const ensureTaskMemorySession = (): void => {
		const currentSessionId = session?.current()?.id ?? null;
		if (currentSessionId === taskMemorySessionId) return;
		taskMemoryBank.clear();
		taskMemorySessionId = currentSessionId;
	};
	const memorySettings = (config?.get() ?? readSettings()).context.memory;
	// Bound late: the registration is built here, but the buffer a deferred
	// reminder lands in belongs to the chat loop that has not been composed yet.
	let deferredMemoryReminderSink: ((message: string) => void) | null = null;
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
	let backgroundMemoryRoute: BackgroundMemoryRoute | null = null;
	/**
	 * Account for one background memory step exactly as a `/btw` side question is
	 * accounted for: the in-process cost tracker under its own label so `/cost`
	 * shows it while the session lives, and one durable out-of-turn row so
	 * `clio-coder usage report` can still see it afterwards.
	 *
	 * Accounting only. The client wrapper (`announceMemoryStepEndpoint`) holds the
	 * endpoint slot and publishes the disturbance; it sees the timed-out and
	 * thrown steps this sink never hears about because their usage stays null.
	 */
	const recordBackgroundMemoryUsage = (usage: TaskMemoryStepUsage): void => {
		const meta = session?.current() ?? null;
		try {
			recordBackgroundMemoryStep({
				usage,
				stateDir: clioStateDir(),
				sessionId: meta?.id ?? null,
				// The identity the session ledger is filed under, so `usage report
				// --repo` selects these rows with the same hash it selects ledgers with.
				repoIdentity: meta ? meta.cwdHash || cwdHash(meta.cwd || process.cwd()) : null,
				...(observability === undefined ? {} : { observability }),
			});
		} catch {
			// Accounting is bookkeeping. Its failure never reaches the memory step.
		}
	};
	const proposeInjectedMemoryEntries = (entries: ReadonlyArray<TaskMemoryEntry>): void => {
		const meta = session?.current() ?? null;
		void proposeInjectedTaskMemory(clioDataDir(), {
			sessionId: meta?.id ?? null,
			cwd: meta?.cwd || process.cwd(),
			entries,
		})
			.then((result) => {
				for (const error of result.errors) {
					process.stderr.write(`[clio-coder:memory] proposed record not written for ${error}\n`);
				}
			})
			.catch((error: unknown) => {
				process.stderr.write(
					`[clio-coder:memory] proposed records not written: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			});
	};
	const memoryIntervention = createMemoryInterventionRegistration({
		bank: taskMemoryBank,
		telemetry: createTaskMemoryTelemetrySink(),
		...(memoryTrace === null ? {} : { onEnvelope: (envelope) => memoryTrace.record(envelope) }),
		// A headless run submits no further turn, so a detached step could only
		// finish after the process that would have read it has exited.
		deliversDeferredReminders: options.headless === undefined,
		onDeferredReminder: (message) => deferredMemoryReminderSink?.(message),
		getSettings: () => {
			ensureTaskMemorySession();
			const memory = effectiveSettingsForDispatch?.().context.memory ?? memorySettings;
			return {
				enabled: memory.enabled,
				everyNTools: memory.cadenceToolCalls,
				windowSteps: memory.trajectorySteps,
				maxTokens: memory.maxOutputTokens,
				timeoutMs: memory.timeoutMs,
			};
		},
		getModelClient: () => {
			const settings = effectiveSettingsForDispatch?.();
			backgroundMemoryRoute =
				settings === undefined
					? null
					: createBackgroundMemoryModelClient(providers, settings, settings.context.memory.timeoutMs, bus);
			return backgroundMemoryRoute?.client ?? null;
		},
		getModelMaxTokens: (configuredMaxTokens) =>
			backgroundMemoryRoute?.modelMaxTokens(configuredMaxTokens) ?? configuredMaxTokens,
		// A single-slot local server serves one request at a time, so a memory step
		// started while the operator's turn is streaming either waits behind it or
		// makes the server swap the resident model out to answer. The chat loop
		// registers its stream on the endpoint it streams against, so the two are
		// compared by the same canonical key dispatch admission counts slots on.
		backgroundEndpointBusy: () => {
			const endpointKey = backgroundMemoryRoute?.endpointKey ?? null;
			if (endpointKey === null) return false;
			// This runs before the client wrapper registers the admitted step, so the
			// count contains other requests only and the step cannot refuse itself.
			return (foregroundStreamUsage()[endpointKey] ?? 0) > 0;
		},
		onStepUsage: (usage) => recordBackgroundMemoryUsage(usage),
		onInjectedEntries: (entries) => proposeInjectedMemoryEntries(entries),
	});
	middleware.registerHook(memoryIntervention);
	const unsubscribeMemoryLoop = bus.on(BusChannels.LoopBlocked, () => memoryIntervention.signalLoop());
	termination.onDrain(() => unsubscribeMemoryLoop());
	if (contextDomain) {
		middleware.registerHook(createFileMutationObserver(({ paths }) => contextDomain.noteFileChanges(paths)));
	}
	// User-defined hooks: extensions and the project (.clio-coder/hooks.yaml,
	// .clio-coder/hooks.local.yaml) declare a conservative, receipted hook set on the
	// same effect machinery. They register after the guards, so safety stays
	// authoritative: a hook may add effects (including request block_tool) but
	// cannot grant a permission safety would deny. Loading is best-effort.
	// The coordinator is the only writer of the "user-hooks" owner and the only
	// caller of the extensions reload; it publishes the extension generation
	// and the hook registrations with two adjacent assignments on one stack
	// and emits extensions.reloaded only after both. The boot generation is
	// published here too (the extensions bundle publishes nothing at start),
	// so no consumer ever sees extension resources paired with hooks from a
	// different generation. The owner slot is anchored here, so user hooks
	// keep evaluating after the guards and before the assessors below.
	const hookReceiptLog = createHookReceiptLog({ persistPath: join(clioStateDir(), "hook-receipts.json") });
	const extensionReload = createExtensionReloadCoordinator({
		extensions,
		middleware,
		cwd: () => process.cwd(),
		recordReceipt: (receipt) => hookReceiptLog.record(receipt),
		report: (line) => {
			if (!interactive) process.stderr.write(`${line}\n`);
		},
		onCommitted: (event) => bus.emit(BusChannels.ExtensionsReloaded, event),
	});
	extensionReload.applyBoot();
	termination.onDrain(() => hookReceiptLog.flush());
	// Autonomy is hot-reloaded for interactive and headless admissions. ACP
	// server prompts use the snapshot captured at session/new.
	let activeAcpSessionAutonomy: AutonomyLevel | null = null;
	// The one effective-autonomy resolution. Every admission surface (registry
	// admission, dispatch plan provenance, ACP session snapshot) resolves
	// through these two functions so a fallback added to one surface cannot
	// silently skip another.
	const resolveBaselineAutonomy = (): AutonomyLevel =>
		effectiveSettingsForDispatch?.().safety.autonomy ??
		options.headless?.autonomy ??
		(config?.get() ?? readSettings()).safety.autonomy ??
		"auto-edit";
	const resolveEffectiveAutonomy = (): AutonomyLevel => activeAcpSessionAutonomy ?? resolveBaselineAutonomy();
	// Marketplace self-promotion: coordinator-only by this wiring (never a
	// dispatch worker), local matcher, consented installs and full-auto
	// autonomous installs both pass the own-marketplace source gate inside the
	// registration. Registered here because it needs the effective-autonomy
	// resolution defined one line up.
	if (resources) {
		middleware.registerHook(
			createMarketplaceOfferRegistration({
				listInstalledSkillNames: () => resources.skills(process.cwd()).items.map((skill) => skill.name),
				listMarketplaceEntries: () => discoverMarketplaceSkills({ cwd: process.cwd() }).skills,
				getAutonomy: resolveEffectiveAutonomy,
				installEntry: (entry, scope) => {
					const installed = installSkill({ source: entry.sourceUrl, scope, name: entry.name, cwd: process.cwd() });
					return { path: installed.path, sourceUrl: installed.sourceUrl, installedHash: installed.installedHash };
				},
			}),
		);
	}
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	const toolRegistry = createRegistry({
		safety,
		middleware,
		onMiddlewareEffects: (effects) => middlewareToolChoice.apply(effects),
		autonomy: resolveEffectiveAutonomy,
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
	// registered there at all (documented in `clio-coder run --help`). Skills that
	// interview fall back to their stated defaults when the tool is absent.
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
			if (!meta) return [];
			const leafTurnId = session?.tree(meta.id).leafId ?? undefined;
			return filterEntriesToActivePath(readSessionEntriesForCompact(meta.id), leafTurnId);
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
			if (!meta) return [];
			const leafTurnId = session?.tree(meta.id).leafId ?? undefined;
			return filterEntriesToActivePath(readSessionEntriesForCompact(meta.id), leafTurnId);
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
	bus.on(BusChannels.DispatchCompleted, (payload) => {
		if (typeof payload?.runId !== "string") return;
		taskBoard.detachRun(payload.runId);
		foldDispatchSkillActivations(session, payload);
	});
	bus.on(BusChannels.DispatchFailed, (payload) => {
		if (typeof payload?.runId !== "string") return;
		taskBoard.detachRun(payload.runId);
		// A run that failed after loading a skill is the case the operator most
		// needs the provenance for, and the receipt already carried it here.
		foldDispatchSkillActivations(session, payload);
	});
	// Operator-initiated backgrounding is a TUI affordance: the registry is the
	// one object the dispatch tool and the keypress both hold.
	const dispatchBackground = createDispatchBackgroundRegistry();
	// One `PanesOperations` instance drives both the `panes` tool and the
	// `/panes` slash command, so the model and the operator cannot be told
	// different things about the same pane. It also owns the no-mux Yazi chooser,
	// while model tool registration below remains gated on a live pane host.
	const panes =
		withPanes && mux
			? withPanes.createPanesRuntime({
					mux,
					getSettings: () => getCurrentSettings(),
					getDispatchSnapshot: () => dispatch.snapshot(),
					getCwd: () => process.cwd(),
				})
			: null;
	registerAllTools(toolRegistry, {
		...(session
			? {
					session,
					readSessionEntries: () => {
						const meta = session.current();
						return meta ? readSessionEntriesForCompact(meta.id) : [];
					},
					onContextRecalled: (payload) => bus.emit(BusChannels.ContextRecalled, payload),
				}
			: {}),
		taskBoard,
		userTasks,
		dispatch,
		bus,
		...(interactive ? { askUser: askUserBridge } : {}),
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
	// Overrides are keyed by settings path, the same ids the /settings overlay
	// commits (`setAtPath` walks the dotted path). The headless `--autonomy`
	// flag was keyed by the bare word, which wrote a top-level `autonomy` key
	// nothing reads, so `run --autonomy full-auto` compiled and admitted at
	// whatever settings.yaml said.
	const sessionOverrides: SessionOverrides = new Map(
		options.headless?.autonomy === undefined ? [] : [["safety.autonomy", options.headless.autonomy]],
	);
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
		// Recents live in the data dir (core/recent-models.ts), never in
		// settings.yaml; consumers that need them call listRecentModels
		// directly, so an Alt+L pick in another session does not churn the
		// config watcher here.
		const base = config?.get();
		// No config domain (unit tests, degraded boot): readSettings() returns a
		// fresh object every call, so there is nothing stable to key a cache on.
		if (base === undefined) return applySessionRouting(applyOverrides(readSettings(), sessionOverrides), sessionRouting);
		if (
			cachedSettingsView !== null &&
			cachedSettingsBase === base &&
			cachedSettingsGeneration === sessionStateGeneration
		) {
			return cachedSettingsView;
		}
		const view = applySessionRouting(applyOverrides(base, sessionOverrides), sessionRouting);
		cachedSettingsBase = base;
		cachedSettingsGeneration = sessionStateGeneration;
		cachedSettingsView = view;
		return view;
	};
	effectiveSettingsForDispatch = getCurrentSettings;
	bumpSessionState();
	// The config bundle publishes saved values on reload; session-scoped
	// overrides must win, so re-derive every process-local projection from the
	// effective session view after it.
	const unsubscribeSettingsProjectionSync = bus.on(BusChannels.ConfigHotReload, () => bumpSessionState());
	termination.onDrain(() => unsubscribeSettingsProjectionSync());
	const getTaskMemorySeedOffer = (): { source: string; count: number } | null => {
		return taskMemoryHandoffSeedOffer(process.cwd(), getCurrentSettings().context.memory.enabled);
	};
	const seedCurrentTaskMemoryFromHandoff = () => {
		ensureTaskMemorySession();
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
	/**
	 * Apply a routing change with one consistent scope: it takes effect in this
	 * session immediately and writes through to saved settings as the default
	 * for future sessions. Only the patched fields hit the file, so concurrent
	 * sessions cannot clobber each other's saved defaults wholesale.
	 */
	const updateSessionRouting = (patch: RoutingPatch, mutateSaved?: (saved: ClioSettings) => void): void => {
		applyRoutingPatch(sessionRouting, patch);
		bumpSessionState();
		persistSavedMutation((saved) => {
			mergeRoutingPatchIntoSettings(saved, patch);
			mutateSaved?.(saved);
		});
	};
	/**
	 * A routing change at the scope the operator chose. "session" moves the live
	 * route and leaves settings.yaml alone, so a swap that points at a dead
	 * endpoint dies with the session that made it; "global" is the historical
	 * write-through. Nothing on this path writes durably without a scope.
	 */
	const applyRoutingAtScope = (patch: RoutingPatch, scope: "session" | "global"): void => {
		if (scope === "global") {
			updateSessionRouting(patch);
			return;
		}
		applyRoutingPatch(sessionRouting, patch);
		bumpSessionState();
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
		if (patch) {
			applyRoutingPatch(sessionRouting, patch);
			bumpSessionState();
		}
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
	 * Restart-required ids (budget.concurrency, runtimePlugins,
	 * terminal.tuiMode, terminal.fullscreenScrollbar) cannot apply
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
			bumpSessionState();
			if (scope === "global") persistSavedMutation((saved) => mergeRoutingPatchIntoSettings(saved, patch));
			return;
		}
		const value = getAtPath(next, id);
		if (scope === "session") {
			sessionOverrides.set(id, value);
			bumpSessionState();
			return;
		}
		sessionOverrides.delete(id);
		bumpSessionState();
		persistSavedMutation((saved) => setAtPath(saved, id, value));
	};
	/** Alt+J / Alt+K: step this session's orchestrator through the scope list. */
	const cycleScopedSession = (direction: "forward" | "backward"): boolean => {
		const next = advanceScopedTarget(getCurrentSettings(), direction);
		if (!next) return false;
		updateSessionRouting({ orchestrator: { target: next.target, model: next.model } });
		return true;
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
	middleware.registerHook(createUnbackedWorkerClaimRegistration());
	middleware.registerHook(
		createDetachedDispatchNudgeRegistration({ getOpenBatches: () => openDetachedBatchViews(dispatch) }),
	);
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
				// Tail-scoped: the contract only needs the last-user-message window, so
				// it parses a bounded ledger tail per turn_end rather than the whole
				// file (which grows unbounded with session length).
				readSessionEntries: () => {
					const meta = session.current();
					return meta ? readRecentSessionEntriesForContract(meta.id) : null;
				},
				resolveRigor: () =>
					resolveRigor({ cwd: process.cwd(), override: parseRigorOverride(process.env.CLIO_CODER_RIGOR) }),
				recordDecision: (record) => safety.audit.recordCompletionContract?.(record),
			}),
		);
	}

	const chat = createChatLoop({
		// The pre-warm holds one slot on its endpoint while it runs, so dispatch
		// admission (#250) sees it exactly as it sees the orchestrator's own turn.
		registerPrewarmEndpointSlot: (runtime) => {
			const key = canonicalEndpointKey(runtime.runtimeResolution.target);
			return key === null ? null : registerForegroundStream(key);
		},
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
		...(prompts ? { prompts } : {}),
		...(session ? { session } : {}),
		getMemorySection: () => {
			try {
				const records = loadMemoryRecordsSync(clioDataDir());
				const settings = getCurrentSettings();
				const targetId = session?.current()?.target ?? settings.chat?.target;
				const runtimeId = targetId ? providers.getTarget(targetId)?.runtime : undefined;
				return buildMemoryPromptSection(records, {
					scopes: ["global", "repo", "runtime"],
					activeRepository: canonicalMemoryRepositoryIdentity(process.cwd()),
					activeRuntime: runtimeId === undefined ? null : { kind: "runtime", key: runtimeId },
				}).section;
			} catch {
				return "";
			}
		},
		getTaskMemoryHandoffSource: () => {
			ensureTaskMemorySession();
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
					autoCompact: createProductionAutoCompact(session, getCurrentSettings, providers),
				}
			: {}),
		toolRegistry,
		hasAttachedDispatch: () => dispatchBackground.size() > 0,
		// The pre-warm buys latency for a person about to type the next turn. A
		// headless `run` submits its one prompt immediately and an unattended boot
		// never submits at all, so neither has latency to buy; the ACP surface has
		// an operator on the other end of the client and keeps it.
		isLatencySurface: () => interactive || acpMode,
	});

	// Coordinated shutdown (SIGINT/SIGTERM, TUI quit) must abort any in-flight
	// turn before domains stop. The agent abort fans out to every running
	// tool's AbortSignal, and bash-exec answers it by signalling the tool's
	// detached process group. Without this, a headless SIGINT exited the CLI
	// while a running tool's children survived as orphans of init.
	termination.onDrain(async () => {
		chat.dispose();
		// The abort fans out to running tools, but their results still land and
		// persist through the aborted run's subscribers. Domains (the session
		// writer among them) stop in the persist phase, strictly after drain, so
		// awaiting settlement here makes a session append after session stop
		// impossible by ordering.
		await chat.whenSettled();
	});

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
				// Scoped to the leaf resume landed on for the same reason the /resume
				// overlay is (issue #107): with a /tree pin persisted, the file still
				// holds the abandoned branch after the pinned turn, and replaying it
				// unfiltered seeds the provider with turns the next append does not
				// parent onto.
				chat.resetForSession(
					leafTurnId,
					buildModelReplayAgentMessagesFromTurns(
						readCurrentSessionEntries(),
						leafTurnId ? { activeLeafTurnId: leafTurnId } : {},
					),
				);
			} catch (err) {
				chat.resetForSession(leafTurnId);
				bootStderr(
					`Clio Coder: failed to replay resumed session context ${resumedMeta.id}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
	}

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
		try {
			const transport = options.acp.transport ?? createStdioServerTransport(options.acp.transportOptions);
			const code = await serveClioAcpAgent({
				transport,
				chat,
				...(session ? { session } : {}),
				...(session
					? {
							readSessionEntries: readSessionEntriesForCompact,
							buildReplayMessages: (entries: ReadonlyArray<SessionEntry>, leafTurnId: string | null) =>
								buildModelReplayAgentMessagesFromTurns(entries, leafTurnId === null ? {} : { activeLeafTurnId: leafTurnId }),
						}
					: {}),
				providers,
				settings: {
					read: readAcpSafeSettings,
					commit: commitAcpSafeSettings,
				},
				toolRegistry,
				bus,
				autonomy: resolveBaselineAutonomy,
				routing: () => {
					const settings = getCurrentSettings();
					return {
						target: settings.chat.target,
						model: settings.chat.model,
					};
				},
				onActiveSessionAutonomyChange: (level) => {
					activeAcpSessionAutonomy = level;
				},
				cwd: process.cwd(),
				version: getVersionInfo().clio,
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
			await chat.whenSettled();
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
		const headlessPermissionReason = HEADLESS_PERMISSION_DENIED_REASON;
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
			const parsedSkillRequest = resources?.parsePendingSkillRequests(options.headless.prompt, process.cwd()) ?? {
				text: options.headless.prompt,
				pendingSkillRequests: [],
			};
			const promptExpansion = resources?.expandPromptTemplate(parsedSkillRequest.text, process.cwd());
			// A prompt named as `/name` is a request for that template. When the
			// template refuses, the run says why and stops; sending the literal
			// `/name` on to the model spends a turn answering a command it cannot
			// run, and the operator never sees the refusal.
			if (promptExpansion?.expanded === false && promptExpansion.refusal) {
				process.stderr.write(`clio-coder: ${promptExpansion.refusal.message}\n`);
				await termination.shutdown(1);
				return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
			}
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

	if (options.terminalLease) {
		for (const diagnostic of options.terminalLease.takeDiagnostics()) {
			const text = diagnostic.text.trimEnd();
			if (text.length > 0) initialNotices.push(text);
		}
	}

	await startInteractive({
		bus,
		providers,
		dispatch,
		...(agents ? { agents } : {}),
		...(() => {
			const scheduling = result.getContract<SchedulingContract>("scheduling");
			return scheduling ? { scheduling } : {};
		})(),
		observability,
		chat,
		...(options.terminalLease
			? {
					terminalLease: options.terminalLease,
					onHydratedFrameCommit: () => timer.mark("Stage 1 hydration"),
				}
			: { onFirstFrameCommit: () => timer.mark("first TUI paint") }),
		...(initialNotices.length > 0 ? { initialNotices } : {}),
		...(resources ? { resources } : {}),
		...(extensions ? { extensions } : {}),
		reloadExtensions: () => extensionReload.reload(),
		...(interop ? { interop } : {}),
		...(share ? { share } : {}),
		...(mux ? { mux } : {}),
		...(panes ? { panes } : {}),
		...(panes ? { attachYaziBridge: (bridge) => panes.attachYazi(bridge) } : {}),
		// The interactive surface never imports the panes glue itself; the
		// factories arrive only on an active boot, through the same dynamic
		// import that loaded the mux domain.
		...(withPanes
			? {
					createMuxBridge: withPanes.createMuxBridge,
					createYaziBridge: withPanes.createYaziBridge,
					createWatchPane: withPanes.createWatchPaneController,
				}
			: {}),
		...(panes ? { attachWatchPane: (controller) => panes.attachWatch(controller) } : {}),
		toolRegistry,
		...(session ? { session } : {}),
		...(session ? { readSessionEntries: readCurrentSessionEntries } : {}),
		getTaskBoard: () => taskBoard.cachedSnapshot(),
		getDecisionBoard: () => decisionBoard.snapshot(),
		supersedeDecision: (interviewId, key, correction) => decisionBoard.supersede(interviewId, key, correction),
		userTasks,
		getTaskMemoryStatus: () => {
			ensureTaskMemorySession();
			const settings = getCurrentSettings();
			const bank = taskMemoryBank.snapshot();
			return {
				enabled: settings.context.memory.enabled,
				tier: settings.context.memory.target && settings.context.memory.model ? "llm" : "rules",
				size: taskMemoryBankSize(bank),
				lastDecision: memoryIntervention.lastDecision(),
				bank,
				activity: memoryIntervention.recentActivity(),
				stepInFlight: memoryIntervention.stepInFlight(),
				// Folded from the telemetry ledger, which is durable across sessions,
				// so `/memory` answers what the tier has cost since it was turned on
				// rather than what it cost since this process started.
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
		getFleetNodes: () => result.getContract<SchedulingContract>("scheduling")?.fleet?.list() ?? [],
		onBackgroundDispatch: () => dispatchBackground.backgroundNewest(),
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
		onSetThinkingLevel: (level, scope) => {
			const current = getCurrentSettings();
			const nextLevel =
				resolveModelRuntimeCapabilitiesForProviders(providers, current.chat.target, current.chat.model, level)?.thinking
					.effectiveLevel ?? "off";
			applyRoutingAtScope({ orchestrator: { thinkingLevel: nextLevel } }, scope ?? "global");
		},
		onCycleThinking: () => {
			const current = getCurrentSettings();
			const thinking = resolveModelRuntimeCapabilitiesForProviders(
				providers,
				current.chat.target,
				current.chat.model,
				current.chat.thinkingLevel ?? "off",
			)?.thinking;
			const effectiveAvailable = thinking?.supportedLevels ?? (["off"] as ThinkingLevel[]);
			const nextLevel = advanceThinkingLevel(
				thinking?.effectiveLevel ?? current.chat.thinkingLevel ?? "off",
				effectiveAvailable,
			);
			updateSessionRouting({ orchestrator: { thinkingLevel: nextLevel } });
		},
		onSelectModel: ({ target, model }, scope) => {
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
			applyRoutingAtScope({ orchestrator: { target, model } }, scope);
			// Recents live in the state dir, not settings.yaml, and are how a swap
			// stays reachable in the picker. A session-scoped swap still earns one.
			rememberRecentModel(`${target}/${model}`, getCurrentSettings().chat.modelPicker.recentLimit);
		},
		writeSettings: (next) => applySettingsBlob(next),
		commitSetting: (id, next, scope) => commitSetting(id, next, scope),
		...(session
			? {
					onResumeSession: (sessionId) => {
						try {
							const previousSessionId = session.current()?.id ?? null;
							session.resume(sessionId);
							taskBoard.snapshot();
							if (previousSessionId !== sessionId) ensureTaskMemorySession();
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
						taskBoard.snapshot();
						ensureTaskMemorySession();
					},
					onForkSession: (parentTurnId) => {
						try {
							session.fork(parentTurnId);
							taskBoard.snapshot();
							ensureTaskMemorySession();
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
