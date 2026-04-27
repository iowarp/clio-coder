import { join } from "node:path";
import chalk from "chalk";
import { BusChannels } from "../core/bus-events.js";
import { installBusTracer } from "../core/bus-trace.js";
import { type ClioSettings, readSettings, writeSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { buildSelfDevPrompt, resolveSelfDevMode } from "../core/self-dev.js";
import { getSharedBus } from "../core/shared-bus.js";
import { StartupTimer } from "../core/startup-timer.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { clioDataDir } from "../core/xdg.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import { IntelligenceDomainModule } from "../domains/intelligence/index.js";
import { ensureClioState, LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
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
import type { SafetyContract } from "../domains/safety/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { type CompactResult, compact } from "../domains/session/compaction/compact.js";
import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { CompactionSummaryEntry, CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { SessionDomainModule } from "../domains/session/index.js";
import { openSession } from "../engine/session.js";
import type { Model } from "../engine/types.js";
import { type HarnessHandle, startHarness } from "../harness/index.js";
import { createChatLoop } from "../interactive/chat-loop.js";
import { startInteractive } from "../interactive/index.js";
import {
	detectPlatformKeybindingWarnings,
	detectTerminalKeySupport,
	formatInvalidKeybindingNotice,
	formatPlatformKeybindingNotice,
	validateKeybindings,
} from "../interactive/keybinding-manager.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { createRegistry } from "../tools/registry.js";
import { applySelfDevToolGuards } from "../tools/self-dev-guards.js";

export interface BootResult {
	exitCode: number;
	bootTimeMs: number;
}

export interface BootOptions {
	/** Process-lifetime API key override applied to the active orchestrator endpoint. */
	apiKey?: string;
	/** Enable Clio self-development mode for the current process. */
	dev?: boolean;
	/** Suppress AGENTS.md / CLAUDE.md / CODEX.md context-file injection for this run. */
	noContextFiles?: boolean;
}

function buildBanner(): string {
	const { clio } = getVersionInfo();
	return `
  ${chalk.cyan("Clio Coder")}
  ${chalk.dim(`v${clio} · supervised repository work · ready`)}
`;
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

function synthesizeOrchestratorModel(
	providers: ProvidersContract,
	endpoint: EndpointDescriptor,
	wireModelId: string,
): Model<never> | null {
	const runtime = providers.getRuntime(endpoint.runtime);
	if (!runtime) return null;
	try {
		return runtime.synthesizeModel(endpoint, wireModelId, null) as unknown as Model<never>;
	} catch {
		return null;
	}
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
		tokensAfter: estimateTokensFromSummary(result.summary),
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
	const selfDev = resolveSelfDevMode({ cliDev: options.dev === true });
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	installBusTracer();
	termination.installSignalHandlers();

	ensureClioState();
	timer.mark("install check");

	const result = await loadDomains([
		ConfigDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		ModesDomainModule,
		createPromptsDomainModule({
			noContextFiles: options.noContextFiles === true,
			...(selfDev ? { devRepoRoot: selfDev.repoRoot } : {}),
		}),
		AgentsDomainModule,
		SessionDomainModule,
		ObservabilityDomainModule,
		SchedulingDomainModule,
		DispatchDomainModule,
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

	const interactive = process.env.CLIO_INTERACTIVE === "1";
	const selfDevLine = selfDev
		? `${selfDev.source} | CLIO_SELF_DEV=1 | repo ${selfDev.repoRoot} | watching src/`
		: undefined;
	if (!interactive) {
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

	if (!interactive) {
		process.stdout.write(`${chalk.dim("  (non-interactive boot. pass CLIO_INTERACTIVE=1 to launch the TUI.)")}\n`);
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	const modes = result.getContract<ModesContract>("modes");
	const observability = result.getContract<ObservabilityContract>("observability");
	const safety = result.getContract<SafetyContract>("safety");
	if (!modes || !providers || !dispatch || !observability || !safety) {
		process.stderr.write(
			"Clio Coder: interactive mode requires safety + modes + providers + dispatch + observability contracts; aborting.\n",
		);
		await termination.shutdown(1);
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
	}
	const toolRegistry = createRegistry({ safety, modes });
	registerAllTools(toolRegistry);
	if (selfDev) applySelfDevToolGuards(toolRegistry, selfDev);

	const allowedModesByName = new Map<string, ReadonlyArray<string>>();
	for (const spec of toolRegistry.listAll()) {
		if (spec.allowedModes) allowedModesByName.set(spec.name, spec.allowedModes);
	}

	const session = result.getContract<SessionContract>("session");
	const prompts = result.getContract<PromptsContract>("prompts");
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

	const chat = createChatLoop({
		getSettings: () => config?.get() ?? readSettings(),
		modes,
		providers,
		knownEndpoints: () => new Set(providers.list().map((entry) => entry.endpoint.id)),
		observability,
		bus,
		...(selfDev ? { selfDevPrompt: buildSelfDevPrompt(selfDev) } : {}),
		...(prompts ? { prompts } : {}),
		...(session ? { session } : {}),
		...(session
			? {
					readSessionEntries: (): ReadonlyArray<SessionEntry> => {
						const meta = session.current();
						if (!meta) return [];
						return readSessionEntriesForCompact(meta.id);
					},
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

	let harness: HarnessHandle | null = null;
	if (selfDev) {
		const repoRoot = selfDev.repoRoot;
		// Compile hot modules under the repo's node_modules so Node resolves
		// bare imports (e.g. typebox) via the repo's installed deps. An XDG
		// cache path would be outside any node_modules tree and break
		// bare-specifier resolution.
		const hotCacheRoot = join(repoRoot, "node_modules", ".clio-hot");
		harness = startHarness({
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

	await startInteractive({
		bus,
		modes,
		providers,
		dispatch,
		observability,
		chat,
		toolRegistry,
		...(session ? { session } : {}),
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
