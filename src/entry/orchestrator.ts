import { join } from "node:path";
import chalk from "chalk";
import { runPrintMode } from "../cli/modes/index.js";
import { BusChannels } from "../core/bus-events.js";
import { installBusTracer } from "../core/bus-trace.js";
import { type ClioSettings, readSettings, writeSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { expandInlineFileReferencesAsync } from "../core/file-references.js";
import { getSharedBus } from "../core/shared-bus.js";
import { StartupTimer } from "../core/startup-timer.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { clioDataDir } from "../core/xdg.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { type ContextContract, ContextDomainModule } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { createDispatchDomainModule } from "../domains/dispatch/index.js";
import { type ExtensionsContract, ExtensionsDomainModule } from "../domains/extensions/index.js";
import { IntelligenceDomainModule } from "../domains/intelligence/index.js";
import { ensureClioState, LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import { buildMemoryPromptSection, loadMemoryRecordsSync } from "../domains/memory/index.js";
import type { MiddlewareContract } from "../domains/middleware/index.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import type { ModesContract } from "../domains/modes/index.js";
import { ModesDomainModule } from "../domains/modes/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import type { EndpointDescriptor, ProvidersContract, ThinkingLevel } from "../domains/providers/index.js";
import {
	availableThinkingLevels,
	ProvidersDomainModule,
	resolveModelCapabilities,
	targetRequiresAuth,
	VALID_THINKING_LEVELS,
} from "../domains/providers/index.js";
import { type ResourcesContract, ResourcesDomainModule } from "../domains/resources/index.js";
import type { SafetyContract } from "../domains/safety/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { type CompactResult, compact } from "../domains/session/compaction/compact.js";
import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import { estimateAgentContextTokens } from "../domains/session/context-accounting.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import type { CompactionSummaryEntry, CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { SessionDomainModule } from "../domains/session/index.js";
import {
	protectedArtifactEntryFromArtifact,
	protectedArtifactStateFromSessionEntries,
} from "../domains/session/protected-artifacts.js";
import { type ShareContract, ShareDomainModule } from "../domains/share/index.js";
import { openSession } from "../engine/session.js";
import type { ImageContent, Model } from "../engine/types.js";
import { createChatLoop } from "../interactive/chat-loop.js";
import { buildReplayAgentMessagesFromTurns } from "../interactive/chat-renderer.js";
import { startInteractive } from "../interactive/index.js";
import {
	detectPlatformKeybindingWarnings,
	detectTerminalKeySupport,
	formatInvalidKeybindingNotice,
	formatPlatformKeybindingNotice,
	validateKeybindings,
} from "../interactive/keybinding-manager.js";
import type { HarnessHandle, HarnessIntrospection, SelfDevMode } from "../selfdev/index.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { createRegistry, type ProtectedArtifactRegistryEvent } from "../tools/registry.js";

type SelfDevModule = typeof import("../selfdev/index.js");

const SELFDEV_IMPORT_SPECIFIER = ["..", "selfdev", "index.js"].join("/");
const SELFDEV_NOT_BUNDLED_MESSAGE =
	"clio --dev: not bundled in public releases; build from source with CLIO_BUILD_PRIVATE=1\n";

async function loadSelfDevModule(): Promise<SelfDevModule | null> {
	try {
		return (await import(SELFDEV_IMPORT_SPECIFIER)) as SelfDevModule;
	} catch {
		return null;
	}
}

function userRequestedSelfDev(cliDev: boolean): boolean {
	return cliDev || process.env.CLIO_DEV === "1" || process.env.CLIO_SELF_DEV === "1";
}

function emptyHarnessIntrospection(): HarnessIntrospection {
	return {
		last_restart_required_paths: [],
		last_hot_succeeded: null,
		last_hot_failed: null,
		queue_depth: 0,
	};
}

export interface BootResult {
	exitCode: number;
	bootTimeMs: number;
}

export interface BootOptions {
	/** Process-lifetime API key override applied to the active orchestrator endpoint. */
	apiKey?: string;
	/** Enable Clio self-development mode for the current process. */
	dev?: boolean;
	/** Suppress CLIO.md project-context injection for this run. */
	noContextFiles?: boolean;
	/** Run one non-interactive orchestrator turn and print the final text response. */
	print?: { prompt: string; images?: ReadonlyArray<ImageContent>; mode?: "text" | "json" };
}

function buildBanner(): string {
	const { clio } = getVersionInfo();
	return `
  ${chalk.cyan("Clio Coder")}
  ${chalk.dim(`v${clio} · IOWarp CLIO · HPC and scientific software · ready`)}
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
			const mutable = model as { contextWindow?: number; maxTokens?: number; reasoning?: boolean };
			mutable.contextWindow = caps.contextWindow;
			mutable.maxTokens = caps.maxTokens;
			mutable.reasoning = caps.reasoning;
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
	event: ProtectedArtifactRegistryEvent,
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
	if (summary.length === 0) return 0;
	return Math.max(1, Math.ceil(summary.length / 4));
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
 * Ctrl+P / Shift+Ctrl+P step the orchestrator through the `scope` list of
 * endpoint ids or endpoint/model refs. Absent scope is a no-op so unconfigured
 * users feel nothing.
 */
export function advanceScopedTarget(
	settings: Readonly<ClioSettings>,
	direction: "forward" | "backward",
): { endpoint: string; model: string | null } | null {
	const scope = settings.scope ?? [];
	if (scope.length === 0) return null;
	const activeEndpoint = settings.orchestrator.endpoint ?? "";
	const activeModel = settings.orchestrator.model ?? "";
	const activeCombinedRef =
		activeEndpoint.length > 0 && activeModel.length > 0 ? `${activeEndpoint}/${activeModel}` : "";
	const idx = scope.findIndex((entry) => entry === activeCombinedRef || entry === activeEndpoint);
	const base = idx === -1 ? 0 : idx + (direction === "forward" ? 1 : scope.length - 1);
	const next = scope[base % scope.length];
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

function cycleScoped(
	direction: "forward" | "backward",
	readCurrent: () => Readonly<ClioSettings> = readSettings,
	persist: (next: ClioSettings) => void = writeSettings,
): void {
	const current = structuredClone(readCurrent());
	const next = advanceScopedTarget(current, direction);
	if (!next) return;
	current.orchestrator.endpoint = next.endpoint;
	current.orchestrator.model = next.model;
	persist(current);
}

export async function bootOrchestrator(options: BootOptions = {}): Promise<BootResult> {
	const timer = new StartupTimer();
	const cliDev = options.dev === true;
	const userSignalledDev = userRequestedSelfDev(cliDev);
	const selfdev = userSignalledDev ? await loadSelfDevModule() : null;
	if (userSignalledDev && selfdev === null) {
		process.stderr.write(SELFDEV_NOT_BUNDLED_MESSAGE);
		return { exitCode: 2, bootTimeMs: timer.snapshot().totalMs };
	}
	let selfDev: SelfDevMode | null = selfdev?.resolveSelfDevMode({ cliDev }) ?? null;
	if (selfDev === null && userSignalledDev) {
		// resolveSelfDevMode already wrote a clear stderr message; surface the
		// gate failure as exit 1 instead of silently continuing in default mode.
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
	}
	if (selfDev && selfdev) {
		selfDev = await selfdev.ensureSelfDevBranch(selfDev);
		if (selfDev === null) {
			// Branch step refused or failed; ensureSelfDevBranch already wrote the
			// reason. The user explicitly signalled dev mode, so exit 1.
			return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
		}
	}
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	installBusTracer();
	termination.installSignalHandlers();

	ensureClioState();
	timer.mark("install check");

	let harness: HarnessHandle | null = null;
	const result = await loadDomains([
		ConfigDomainModule,
		ExtensionsDomainModule,
		ResourcesDomainModule,
		ShareDomainModule,
		ContextDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		ModesDomainModule,
		createPromptsDomainModule({
			noContextFiles: options.noContextFiles === true,
			...(selfDev
				? {
						devRepoRoot: selfDev.repoRoot,
						getHarnessIntrospection: () => harness?.state.introspection() ?? emptyHarnessIntrospection(),
						renderSelfDevMemory: async () => selfdev?.renderDevMemoryFragment(selfDev.repoRoot) ?? "",
					}
				: {}),
		}),
		AgentsDomainModule,
		MiddlewareDomainModule,
		SessionDomainModule,
		ObservabilityDomainModule,
		SchedulingDomainModule,
		createDispatchDomainModule({
			...(selfDev ? { selfDevMode: selfDev } : {}),
			...(selfDev && selfdev ? { selfDevToolNames: selfdev.selfDevWorkerToolNames() } : {}),
			...(selfDev ? { getSelfDevHarnessSnapshot: () => harness?.state.snapshot() ?? null } : {}),
		}),
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

	const interactive = !options.print && process.env.CLIO_INTERACTIVE === "1";
	const selfDevLine = selfDev
		? `${selfDev.source} | CLIO_SELF_DEV=1 | repo ${selfDev.repoRoot} | watching src/`
		: undefined;
	if (!interactive && !options.print) {
		process.stdout.write(buildBanner());
		if (selfDevLine) process.stdout.write(`  ${chalk.magenta(selfDevLine)}\n`);
		if (process.env.CLIO_TIMING === "1") process.stdout.write(`${timer.report()}\n`);
	}

	const config = result.getContract<ConfigContract>("config");
	const providers = result.getContract<ProvidersContract>("providers");

	if (options.apiKey) {
		if (!providers) {
			process.stderr.write("Clio Coder: --api-key supplied but providers domain unavailable; ignoring.\n");
		} else {
			const settingsNow = config?.get() ?? readSettings();
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

	if (!interactive && !options.print) {
		process.stdout.write(`${chalk.dim("  (non-interactive boot. pass CLIO_INTERACTIVE=1 to launch the TUI.)")}\n`);
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	const modes = result.getContract<ModesContract>("modes");
	const middleware = result.getContract<MiddlewareContract>("middleware");
	const observability = result.getContract<ObservabilityContract>("observability");
	const safety = result.getContract<SafetyContract>("safety");
	const session = result.getContract<SessionContract>("session");
	const prompts = result.getContract<PromptsContract>("prompts");
	const resources = result.getContract<ResourcesContract>("resources");
	const extensions = result.getContract<ExtensionsContract>("extensions");
	const share = result.getContract<ShareContract>("share");
	const contextDomain = result.getContract<ContextContract>("context");
	if (!modes || !providers || !dispatch || !observability || !safety || !middleware) {
		process.stderr.write(
			"Clio Coder: chat mode requires safety + modes + middleware + providers + dispatch + observability contracts; aborting.\n",
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

	const toolRegistry = createRegistry({
		safety,
		modes,
		middleware,
		...(session ? { protectedArtifacts: protectedArtifactStateForCurrentSession(session) } : {}),
		onProtectedArtifactEvent: (event) => appendProtectedArtifactRegistryEvent(session, event),
	});
	registerAllTools(toolRegistry, {
		...(session ? { session } : {}),
	});
	if (selfDev && selfdev) {
		selfdev.registerSelfDevTools(toolRegistry, {
			mode: selfDev,
			getHarnessIntrospection: () => harness?.state.introspection() ?? emptyHarnessIntrospection(),
		});
		selfdev.applySelfDevToolGuards(toolRegistry, selfDev, {
			getHarnessSnapshot: () => harness?.state.snapshot() ?? null,
		});
	}

	const allowedModesByName = new Map<string, ReadonlyArray<string>>();
	for (const spec of toolRegistry.listAll()) {
		if (spec.allowedModes) allowedModesByName.set(spec.name, spec.allowedModes);
	}

	const getCurrentSettings = (): ClioSettings => structuredClone(config?.get() ?? readSettings());

	const validatedKeybindings = validateKeybindings((config?.get() ?? readSettings()).keybindings ?? {});
	const invalidBindings = validatedKeybindings.invalid;
	if (invalidBindings.length > 0) {
		process.stderr.write(formatInvalidKeybindingNotice(invalidBindings));
	}
	const platformWarnings = detectPlatformKeybindingWarnings(
		validatedKeybindings.valid,
		detectTerminalKeySupport(process.env),
	);
	if (platformWarnings.length > 0) {
		process.stderr.write(formatPlatformKeybindingNotice(platformWarnings));
	}
	const persistSettings = (next: ClioSettings): void => {
		if (config?.set) {
			config.set(next);
			return;
		}
		writeSettings(next);
	};
	const updateSettings = (mutate: (current: ClioSettings) => void): void => {
		const current = getCurrentSettings();
		mutate(current);
		persistSettings(current);
	};

	const readCurrentSessionEntries = (): ReadonlyArray<SessionEntry> => {
		const meta = session?.current();
		if (!meta) return [];
		return readSessionEntriesForCompact(meta.id);
	};

	const chat = createChatLoop({
		getSettings: () => config?.get() ?? readSettings(),
		modes,
		providers,
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
							return await runCompactionFlow(session, config?.get() ?? readSettings(), providers, instructions, trigger);
						} catch {
							return null;
						}
					},
				}
			: {}),
		toolRegistry,
	});

	if (options.print) {
		const skillExpansion = resources?.expandSkillInvocation(options.print.prompt, process.cwd());
		const skillPrompt = skillExpansion?.expanded ? skillExpansion.text : options.print.prompt;
		const promptExpansion = resources?.expandPromptTemplate(skillPrompt, process.cwd());
		const fileExpansion = await expandInlineFileReferencesAsync(
			promptExpansion?.expanded ? promptExpansion.text : skillPrompt,
			{
				cwd: process.cwd(),
				includeImages: true,
				missing: "leave",
			},
		);
		const images = [...(options.print.images ?? []), ...fileExpansion.images];
		const code = await runPrintMode(chat, {
			prompt: fileExpansion.text,
			...(images.length > 0 ? { images } : {}),
			mode: options.print.mode ?? "text",
			getSessionHeader: () => printJsonSessionHeader(session?.current() ?? null),
		});
		await termination.shutdown(code);
		return { exitCode: code, bootTimeMs: timer.snapshot().totalMs };
	}

	if (selfDev && selfdev) {
		const repoRoot = selfDev.repoRoot;
		// Compile hot modules under the repo's node_modules so Node resolves
		// bare imports (e.g. typebox) via the repo's installed deps. An XDG
		// cache path would be outside any node_modules tree and break
		// bare-specifier resolution.
		const hotCacheRoot = join(repoRoot, "node_modules", ".clio-hot");
		harness = selfdev.startHarness({
			repoRoot,
			cacheRoot: hotCacheRoot,
			toolRegistry,
			bus,
			allowedModesByName,
			getSessionId: () => session?.current()?.id ?? null,
			shutdown: async (code?: number) => {
				await termination.shutdown(code ?? 0);
			},
		});
		termination.onDrain(() => {
			harness?.stop();
		});
	}
	const getSelfDevFooterLine = selfDev
		? (selfdev?.createSelfDevFooterLine({
				repoRoot: selfDev.repoRoot,
				getHarnessIntrospection: () => harness?.state.introspection() ?? emptyHarnessIntrospection(),
			}) ?? null)
		: null;

	await startInteractive({
		bus,
		modes,
		providers,
		dispatch,
		observability,
		chat,
		...(resources ? { resources } : {}),
		...(extensions ? { extensions } : {}),
		...(share ? { share } : {}),
		toolRegistry,
		...(session ? { session } : {}),
		...(session ? { readSessionEntries: readCurrentSessionEntries } : {}),
		...(selfDev ? { selfDevRepoRoot: selfDev.repoRoot } : {}),
		...(getSelfDevFooterLine ? { getSelfDevFooterLine } : {}),
		...(selfDev && selfdev ? { openSelfDevDiffOverlay: selfdev.openDevDiffOverlay } : {}),
		dataDir: clioDataDir(),
		getSettings: () => config?.get() ?? readSettings(),
		...(config
			? {
					getWorkerDefault: () => {
						const workerDefault = config.get().workers?.default;
						if (!workerDefault) return undefined;
						const result: { endpoint?: string; model?: string } = {};
						if (workerDefault.endpoint) result.endpoint = workerDefault.endpoint;
						if (workerDefault.model) result.model = workerDefault.model;
						return result;
					},
				}
			: {}),
		...(session ? { getSessionId: () => session.current()?.id ?? null } : {}),
		...(contextDomain
			? {
					onInit: async () => {
						await contextDomain.runBootstrap({
							cwd: process.cwd(),
							io: {
								stdout: (s) => process.stdout.write(s),
								stderr: (s) => process.stderr.write(s),
							},
							confirmGitignore: () => true,
						});
					},
				}
			: {}),
		onSetThinkingLevel: (level) => {
			updateSettings((current) => {
				current.orchestrator.thinkingLevel = level;
			});
		},
		onCycleThinking: () => {
			const current = getCurrentSettings();
			const status = providers.list().find((entry) => entry.endpoint.id === current.orchestrator.endpoint);
			const detectedReasoning =
				current.orchestrator.endpoint && current.orchestrator.model
					? providers.getDetectedReasoning(current.orchestrator.endpoint, current.orchestrator.model)
					: null;
			const available = status
				? availableThinkingLevels(
						resolveModelCapabilities(status, current.orchestrator.model, providers.knowledgeBase, {
							detectedReasoning,
						}),
						{
							runtimeId: status.runtime?.id ?? status.endpoint.runtime,
							...(current.orchestrator.model ? { modelId: current.orchestrator.model } : {}),
						},
					)
				: (["off"] as ThinkingLevel[]);
			updateSettings((next) => {
				next.orchestrator.thinkingLevel = advanceThinkingLevel(next.orchestrator.thinkingLevel ?? "off", available);
			});
		},
		onSelectModel: ({ endpoint, model }) => {
			updateSettings((current) => {
				current.orchestrator.endpoint = endpoint;
				current.orchestrator.model = model;
			});
		},
		onSetScope: (scope) => {
			updateSettings((current) => {
				current.scope = Array.from(scope);
			});
		},
		writeSettings: (next) => persistSettings(next),
		selfDev: Boolean(selfDev),
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
		onCycleScopedModelForward: () => cycleScoped("forward", getCurrentSettings, persistSettings),
		onCycleScopedModelBackward: () => cycleScoped("backward", getCurrentSettings, persistSettings),
		...(harness ? { harness } : {}),
		onShutdown: async () => {
			await termination.shutdown(0);
		},
	});
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}
