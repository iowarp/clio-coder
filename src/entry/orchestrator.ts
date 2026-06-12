import chalk from "chalk";
import { modelBootstrapGenerate } from "../cli/bootstrap-generate.js";
import { runHeadlessMainAgent } from "../cli/modes/print.js";
import { BusChannels } from "../core/bus-events.js";
import { installBusTracer } from "../core/bus-trace.js";
import { type ClioSettings, readSettings, type SettingsMutator, updateSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { expandInlineFileReferencesAsync } from "../core/file-references.js";
import { listRecentModels, rememberRecentModel } from "../core/recent-models.js";
import {
	applyRoutingPatch,
	applySessionRouting,
	diffRouting,
	mergeRoutingPatchIntoSettings,
	type RoutingPatch,
	restoreRoutingFields,
	routingChangeNotices,
	seedSessionRouting,
} from "../core/session-routing.js";
import { getSharedBus } from "../core/shared-bus.js";
import { StartupTimer } from "../core/startup-timer.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { clioDataDir } from "../core/xdg.js";
import { renderAgentCatalogSectionsFromSpecs } from "../domains/agents/catalog.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { type ContextContract, ContextDomainModule } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { createDispatchDedupRegistration } from "../domains/dispatch/dedup.js";
import { createDispatchDomainModule } from "../domains/dispatch/index.js";
import { type ExtensionsContract, ExtensionsDomainModule } from "../domains/extensions/index.js";
import { IntelligenceDomainModule } from "../domains/intelligence/index.js";
import { ensureClioState, LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import { buildMemoryPromptSection, loadMemoryRecordsSync } from "../domains/memory/index.js";
import type { MiddlewareContract } from "../domains/middleware/index.js";
import { MiddlewareDomainModule, writeMiddlewareDiagnosticToStderr } from "../domains/middleware/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import type { EndpointDescriptor, ProvidersContract, ThinkingLevel } from "../domains/providers/index.js";
import {
	applyModelCapabilityPatch,
	isTargetEligibleRuntime,
	ProvidersDomainModule,
	resolveModelCapabilities,
	resolveModelRuntimeCapabilitiesForProviders,
	targetRequiresAuth,
	VALID_THINKING_LEVELS,
} from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import { createResourcesDomainModule, type ResourcesContract } from "../domains/resources/index.js";
import { createFinishContractRegistration } from "../domains/safety/finish-contract-registration.js";
import type { SafetyContract } from "../domains/safety/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import {
	createProtectedArtifactsRegistration,
	type ProtectedArtifactProtectEvent,
} from "../domains/safety/protected-artifacts-registration.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { type CompactResult, compact } from "../domains/session/compaction/compact.js";
import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import { ceilChars, estimateAgentContextTokens } from "../domains/session/context-accounting.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import type { CompactionSummaryEntry, CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { SessionDomainModule } from "../domains/session/index.js";
import {
	protectedArtifactEntryFromArtifact,
	protectedArtifactStateFromSessionEntries,
} from "../domains/session/protected-artifacts.js";
import { type ShareContract, ShareDomainModule } from "../domains/share/index.js";
import { serveClioAcpAgent } from "../engine/acp/server.js";
import {
	type AcpJsonRpcPeerTransport,
	createStdioServerTransport,
	type StdioServerTransportOptions,
} from "../engine/acp/transport.js";
import { createLoopGuardRegistration, INTERACTIVE_LOOP_BLOCK_BUDGET } from "../engine/loop-guard.js";
import { openSession } from "../engine/session.js";
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
import { createToolProseRegistration } from "../interactive/tool-prose-registration.js";
import { type AskUserHandler, cancelledAskUserResult } from "../tools/ask-user.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { createFileMutationObserver, createSkillActivationObserver } from "../tools/observers.js";
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
	/** Process-lifetime API key override applied to the active orchestrator endpoint. */
	apiKey?: string;
	/** Suppress CLIO.md project-context injection for this run. */
	noContextFiles?: boolean;
	noSkills?: boolean;
	skillPaths?: ReadonlyArray<string>;
	/** Run one non-interactive main-agent turn. */
	headless?: {
		prompt: string;
		images?: ReadonlyArray<ImageContent>;
		mode?: "text" | "json";
		target?: string;
		model?: string;
		thinking?: ThinkingLevel;
		sampling?: HeadlessSamplingOverrides;
		noSkills?: boolean;
		skillPaths?: ReadonlyArray<string>;
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
		endpoint: meta.endpoint,
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
	const previousEndpoint = next.orchestrator.endpoint;
	if (overrides.target !== undefined) {
		next.orchestrator.endpoint = overrides.target;
		if (overrides.model === undefined && (previousEndpoint !== overrides.target || !next.orchestrator.model)) {
			const endpoint = next.endpoints.find((entry) => entry.id === overrides.target);
			if (endpoint) next.orchestrator.model = endpoint.defaultModel ?? null;
		}
	}
	if (overrides.model !== undefined) next.orchestrator.model = overrides.model;
	if (overrides.thinking !== undefined) next.orchestrator.thinkingLevel = overrides.thinking;
	return next;
}

interface CompactionResolution {
	model: Model<never>;
	endpointId: string;
	apiKey?: string;
}

function resolveEndpoint(
	providers: ProvidersContract,
	endpointId: string | null | undefined,
): EndpointDescriptor | null {
	if (!endpointId) return null;
	return providers.getEndpoint(endpointId);
}

export function advanceThinkingLevel(current: ThinkingLevel, available: ReadonlyArray<ThinkingLevel>): ThinkingLevel {
	const levels = available.length > 0 ? available : VALID_THINKING_LEVELS;
	if (!levels.includes(current)) return levels[0] ?? "off";
	const normalized = current;
	const idx = levels.indexOf(normalized);
	return levels[(idx + 1) % levels.length] ?? "off";
}

async function resolveApiKeyForEndpoint(
	endpoint: EndpointDescriptor,
	providers: ProvidersContract,
): Promise<string | undefined> {
	const runtime = providers.getRuntime(endpoint.runtime);
	if (!runtime) return undefined;
	if (!targetRequiresAuth(endpoint, runtime)) return undefined;
	const resolved = await providers.auth.resolveForTarget(endpoint, runtime);
	return resolved.apiKey;
}

export function synthesizeOrchestratorModel(
	providers: ProvidersContract,
	endpoint: EndpointDescriptor,
	wireModelId: string,
): Model<never> | null {
	const runtime = providers.getRuntime(endpoint.runtime);
	if (!runtime) return null;
	let model: Model<never>;
	try {
		const kbHit = providers.knowledgeBase?.lookup(wireModelId) ?? null;
		model = runtime.synthesizeModel(endpoint, wireModelId, kbHit) as unknown as Model<never>;
	} catch {
		return null;
	}
	try {
		const status = providers.list().find((entry) => entry.endpoint.id === endpoint.id);
		if (status) {
			const caps = resolveModelCapabilities(status, wireModelId, providers.knowledgeBase, {
				detectedReasoning: providers.getDetectedReasoning(endpoint.id, wireModelId),
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
	const endpointId = settings.orchestrator?.endpoint ?? null;
	const wireModelId = settings.orchestrator?.model ?? null;
	if (!endpointId || !wireModelId) return null;
	const endpoint = resolveEndpoint(providers, endpointId);
	if (!endpoint) return null;
	const model = synthesizeOrchestratorModel(providers, endpoint, wireModelId);
	if (!model) return null;
	const apiKey = await resolveApiKeyForEndpoint(endpoint, providers);
	const resolution: CompactionResolution = { model, endpointId };
	if (apiKey !== undefined) resolution.apiKey = apiKey;
	return resolution;
}

function readSessionEntriesForCompact(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns());
}

function protectedArtifactStateForCurrentSession(
	session: SessionContract,
): ReturnType<typeof protectedArtifactStateFromSessionEntries> {
	const meta = session.current();
	if (!meta) return { artifacts: [] };
	return protectedArtifactStateFromSessionEntries(readSessionEntriesForCompact(meta.id));
}

function appendProtectedArtifactRegistryEvent(
	session: SessionContract | undefined,
	event: ProtectedArtifactProtectEvent,
): void {
	if (!session?.current()) return;
	try {
		session.appendEntry(
			protectedArtifactEntryFromArtifact(event.artifact, {
				parentTurnId: event.turnId ?? null,
				toolName: event.toolName,
				...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
				...(event.runId !== undefined ? { runId: event.runId } : {}),
				...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
			}),
		);
	} catch {
		// Protected state is already live in memory. Session persistence is
		// best-effort so a transient write failure cannot change tool behavior.
	}
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
		// read_skill call. Missing ledger data is visible in diagnostics.
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
		throw new Error("no model configured; set orchestrator.endpoint + orchestrator.model");
	}
	const entries = readSessionEntriesForCompact(meta.id);
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
 * Alt+J / Alt+K step the orchestrator through the `scope` list of endpoint
 * ids or endpoint/model refs. Absent scope is a no-op so unconfigured users
 * feel nothing.
 */
export function advanceScopedTarget(
	settings: Readonly<ClioSettings>,
	direction: "forward" | "backward",
): { endpoint: string; model: string | null } | null {
	const scope = settings.scope ?? [];
	if (scope.length === 0) return null;
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const filteredScope = scope.filter((entry) => {
		const [endpointId] = entry.split("/");
		const endpoint = settings.endpoints.find((e) => e.id === endpointId);
		if (!endpoint) return false;
		const runtime = registry.get(endpoint.runtime);
		return runtime !== null && isTargetEligibleRuntime(runtime);
	});
	if (filteredScope.length === 0) return null;
	const activeEndpoint = settings.orchestrator.endpoint ?? "";
	const activeModel = settings.orchestrator.model ?? "";
	const activeCombinedRef =
		activeEndpoint.length > 0 && activeModel.length > 0 ? `${activeEndpoint}/${activeModel}` : "";
	const idx = filteredScope.findIndex((entry) => entry === activeCombinedRef || entry === activeEndpoint);
	const base = idx === -1 ? 0 : idx + (direction === "forward" ? 1 : filteredScope.length - 1);
	const next = filteredScope[base % filteredScope.length];
	if (!next) return null;
	const [endpoint, ...modelParts] = next.split("/");
	if (!endpoint) return null;
	if (modelParts.length > 0) {
		return { endpoint, model: modelParts.join("/") };
	}
	if (activeEndpoint === endpoint) {
		return { endpoint, model: activeModel || null };
	}
	const endpointDescriptor = settings.endpoints.find((entry) => entry.id === endpoint);
	return { endpoint, model: endpointDescriptor?.defaultModel ?? null };
}

export async function bootOrchestrator(options: BootOptions = {}): Promise<BootResult> {
	const timer = new StartupTimer();
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	installBusTracer();
	termination.installSignalHandlers();

	ensureClioState();
	timer.mark("install check");

	let effectiveSettingsForDispatch: (() => Readonly<ClioSettings>) | null = null;

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
		ContextDomainModule,
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
		createDispatchDomainModule({ getSettings: () => effectiveSettingsForDispatch?.() }),
		IntelligenceDomainModule,
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

	if (options.apiKey) {
		if (!providers) {
			process.stderr.write("Clio Coder: --api-key supplied but providers domain unavailable; ignoring.\n");
		} else {
			const settingsNow = applyHeadlessSettingsOverlay(config?.get() ?? readSettings(), options.headless);
			const activeEndpointId = settingsNow.orchestrator?.endpoint;
			const endpoint = resolveEndpoint(providers, activeEndpointId);
			const runtime = endpoint ? providers.getRuntime(endpoint.runtime) : null;
			if (endpoint && runtime) {
				providers.auth.setRuntimeOverrideForTarget(endpoint, runtime, options.apiKey);
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

	// Q1 second half: hook diagnostics ride the typed bus. The domain loader
	// constructed the bundle with the stderr default; swap in a sink that
	// publishes middleware.hookFailed (the interactive warn notice consumes
	// it) and keep stderr for non-interactive runs, which have no notice
	// subscriber.
	middleware.setDiagnosticSink((diagnostic) => {
		bus.emit(BusChannels.MiddlewareHookFailed, {
			kind: diagnostic.kind,
			registrationId: diagnostic.registrationId,
			hook: diagnostic.hook,
			at: Date.now(),
			...(diagnostic.kind === "hook_failed"
				? { message: diagnostic.message }
				: { elapsedMs: diagnostic.elapsedMs, budgetMs: diagnostic.budgetMs }),
		});
		if (!interactive) writeMiddlewareDiagnosticToStderr(diagnostic);
	});

	// Guard registrations on the middleware contract, in order: loop guard,
	// protected artifacts (last among guards so it absorbs protect_path effects
	// from everything before it), dispatch dedup. Workers register their own
	// loop guard and protected-artifacts instances inside their subprocess in
	// worker-runtime.ts; the orchestrator instances carry the bus and the
	// session persistence sink.
	middleware.registerHook(createLoopGuardRegistration({ safety, bus, turnBlockBudget: INTERACTIVE_LOOP_BLOCK_BUDGET }));
	const protectedArtifactsGuard = createProtectedArtifactsRegistration({
		...(session ? { initialState: protectedArtifactStateForCurrentSession(session) } : {}),
		onProtect: (event) => appendProtectedArtifactRegistryEvent(session, event),
	});
	middleware.registerHook(protectedArtifactsGuard);
	middleware.registerHook(createDispatchDedupRegistration());
	// Observers run after the guards; they emit no effects and their sinks are
	// best-effort (session ledger, codewiki refresh).
	middleware.registerHook(
		createSkillActivationObserver((activation) => appendSkillActivationRegistryEvent(session, activation)),
	);
	if (contextDomain) {
		middleware.registerHook(createFileMutationObserver((event) => contextDomain.noteFileChanges(event.paths)));
	}
	const toolRegistry = createRegistry({ safety, middleware });
	let askUserHandler: AskUserHandler | null = null;
	const askUserBridge: AskUserHandler = async (questions, invokeOptions) =>
		askUserHandler ? await askUserHandler(questions, invokeOptions) : cancelledAskUserResult();
	registerAllTools(toolRegistry, {
		...(session ? { session } : {}),
		dispatch,
		bus,
		...(interactive ? { askUser: askUserBridge } : {}),
		...(agents ? { getAgentCatalog: () => renderAgentCatalogSectionsFromSpecs(agents.listSpecs()).stable } : {}),
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
	// endpoint catalog but never redirect this session's routing.
	const sessionRouting = seedSessionRouting(
		applyHeadlessSettingsOverlay(config?.get() ?? readSettings(), options.headless),
	);
	const getCurrentSettings = (): ClioSettings => {
		const view = applySessionRouting(config?.get() ?? readSettings(), sessionRouting);
		// Recents live in the data dir (core/recent-models.ts), not in
		// settings.yaml, so an Alt+L pick in another session no longer churns
		// the config watcher here. The overlay keeps state.recentModels readable
		// for every existing consumer and migrates a legacy settings list once.
		view.state.recentModels = listRecentModels({
			migrateFrom: view.state.recentModels ?? [],
			limit: view.modelSelector.recentLimit,
		});
		return view;
	};
	effectiveSettingsForDispatch = getCurrentSettings;

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
			if (patch) mergeRoutingPatchIntoSettings(persisted, patch);
			return persisted;
		});
	};
	/** Alt+J / Alt+K: step this session's orchestrator through the scope list. */
	const cycleScopedSession = (direction: "forward" | "backward"): void => {
		const next = advanceScopedTarget(getCurrentSettings(), direction);
		if (!next) return;
		updateSessionRouting({ orchestrator: { endpoint: next.endpoint, model: next.model } });
	};

	const readCurrentSessionEntries = (): ReadonlyArray<SessionEntry> => {
		const meta = session?.current();
		if (!meta) return [];
		return readSessionEntriesForCompact(meta.id);
	};

	// turn_end assessors, fired by the chat-loop when the final assistant
	// message of a run lands. Tool-prose first so its hard-block interruption
	// precedes the finish-contract advisory in effect order.
	middleware.registerHook(createToolProseRegistration());
	if (session) {
		middleware.registerHook(
			createFinishContractRegistration({
				readSessionEntries: () => (session.current() ? readCurrentSessionEntries() : null),
			}),
		);
	}

	const chat = createChatLoop({
		getSettings: getCurrentSettings,
		providers,
		middleware,
		protectedArtifacts: { replace: (state) => protectedArtifactsGuard.replaceState(state) },
		knownEndpoints: () => new Set(providers.list().map((entry) => entry.endpoint.id)),
		observability,
		bus,
		...(prompts ? { prompts } : {}),
		...(session ? { session } : {}),
		getMemorySection: () => {
			try {
				const records = loadMemoryRecordsSync(clioDataDir());
				return buildMemoryPromptSection(records).section;
			} catch {
				return "";
			}
		},
		...(session
			? {
					readSessionEntries: readCurrentSessionEntries,
					autoCompact: async (instructions?: string, trigger?: CompactionTrigger): Promise<CompactResult | null> => {
						try {
							return await runCompactionFlow(session, getCurrentSettings(), providers, instructions, trigger);
						} catch {
							return null;
						}
					},
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
		}
	}

	if (options.headless) {
		const headlessPermissionReason =
			"clio run cannot confirm permission requests; rerun interactively to approve this action.";
		const unsubscribeHeadlessPermission = toolRegistry.onPermissionRequired((call, decision) => {
			bus.emit(BusChannels.PermissionResolved, {
				status: "denied",
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
			const code = await runHeadlessMainAgent(chat, {
				prompt: fileExpansion.text,
				...(images.length > 0 ? { images } : {}),
				...(options.headless.sampling ? { sampling: options.headless.sampling } : {}),
				...(parsedSkillRequest.pendingSkillRequests.length > 0
					? { pendingSkillRequests: parsedSkillRequest.pendingSkillRequests }
					: {}),
				mode: options.headless.mode ?? "text",
				getSessionHeader: () => printJsonSessionHeader(session?.current() ?? null),
			});
			await termination.shutdown(code);
			return { exitCode: code, bootTimeMs: timer.snapshot().totalMs };
		} finally {
			unsubscribeHeadlessPermission();
		}
	}

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
		dataDir: clioDataDir(),
		registerAskUserHandler: (handler) => {
			askUserHandler = handler;
			return () => {
				if (askUserHandler === handler) askUserHandler = null;
			};
		},
		getSettings: getCurrentSettings,
		getWorkerDefault: () => {
			const workerDefault = getCurrentSettings().workers.default;
			const result: { endpoint?: string; model?: string } = {};
			if (workerDefault.endpoint) result.endpoint = workerDefault.endpoint;
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
							proposeClioMd?: boolean;
							includeGlobalImports?: boolean;
							heuristic?: boolean;
						},
						_runIo?: RunIo,
					) => {
						// Interactive context-init explores the repo with the configured target by
						// default, grounded in the freshly built codewiki, and falls back to the
						// deterministic heuristic when no target is reachable. --heuristic and
						// --preview skip model generation.
						const useModel = options.heuristic !== true && options.preview !== true;
						await contextDomain.runBootstrap({
							cwd: process.cwd(),
							confirmGitignore: () => true,
							...(options.preview === undefined ? {} : { preview: options.preview }),
							adopt: options.adopt === true,
							...(options.applyClioMd === undefined ? {} : { applyClioMd: options.applyClioMd }),
							...(options.proposeClioMd === undefined ? {} : { proposeClioMd: options.proposeClioMd }),
							...(options.includeGlobalImports === undefined ? {} : { includeGlobalImports: options.includeGlobalImports }),
							...(useModel
								? {
										generate: modelBootstrapGenerate({
											dispatch,
											onFallback: () => undefined,
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
				}
			: {}),
		onSetThinkingLevel: (level) => {
			const current = getCurrentSettings();
			const nextLevel =
				resolveModelRuntimeCapabilitiesForProviders(
					providers,
					current.orchestrator.endpoint,
					current.orchestrator.model,
					level,
				)?.thinking.effectiveLevel ?? "off";
			updateSessionRouting({ orchestrator: { thinkingLevel: nextLevel } });
		},
		onCycleThinking: () => {
			const current = getCurrentSettings();
			const thinking = resolveModelRuntimeCapabilitiesForProviders(
				providers,
				current.orchestrator.endpoint,
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
		onSelectModel: ({ endpoint, model }) => {
			const registry = getRuntimeRegistry();
			const settings = getCurrentSettings();
			const target = settings.endpoints.find((e) => e.id === endpoint);
			if (target) {
				const runtime = registry.get(target.runtime);
				if (!runtime) {
					throw new Error(
						`cannot use target '${endpoint}' as orchestrator target because runtime '${target.runtime}' is not registered`,
					);
				}
				if (!isTargetEligibleRuntime(runtime)) {
					throw new Error(
						`cannot use target '${endpoint}' as orchestrator target because runtime '${runtime.id}' is not an HTTP/native runtime`,
					);
				}
			}
			updateSessionRouting({ orchestrator: { endpoint, model } });
			rememberRecentModel(`${endpoint}/${model}`, getCurrentSettings().modelSelector.recentLimit);
		},
		onSetScope: (scope) => {
			updateSessionRouting({ scope: Array.from(scope) });
		},
		writeSettings: (next) => applySettingsBlob(next),
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
