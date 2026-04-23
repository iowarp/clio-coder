import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { BusChannels } from "../core/bus-events.js";
import { installBusTracer } from "../core/bus-trace.js";
import { type ClioSettings, readSettings, writeSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
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
import { LifecycleDomainModule, ensureInstalled } from "../domains/lifecycle/index.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import { ModesDomainModule } from "../domains/modes/index.js";
import type { ModesContract } from "../domains/modes/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { PromptsDomainModule } from "../domains/prompts/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import type { EndpointDescriptor, ProvidersContract, ThinkingLevel } from "../domains/providers/index.js";
import { VALID_THINKING_LEVELS, availableThinkingLevels } from "../domains/providers/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import type { SafetyContract } from "../domains/safety/index.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { type CompactResult, compact } from "../domains/session/compaction/compact.js";
import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { SessionDomainModule } from "../domains/session/index.js";
import { openSession } from "../engine/session.js";
import type { Model } from "../engine/types.js";
import { type HarnessHandle, startHarness } from "../harness/index.js";
import { createChatLoop } from "../interactive/chat-loop.js";
import { startInteractive } from "../interactive/index.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { createRegistry } from "../tools/registry.js";

export interface BootResult {
	exitCode: number;
	bootTimeMs: number;
}

function buildBanner(): string {
	const { clio } = getVersionInfo();
	return `
  ${chalk.cyan("◆ clio")}  IOWarp orchestrator coding-agent
  ${chalk.dim(`v${clio} · pi-mono 0.68.1 · ready`)}
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
	if (runtime.auth !== "api-key" && runtime.auth !== "oauth") return undefined;
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

	session.appendEntry({
		kind: "compactionSummary",
		parentTurnId: result.firstKeptTurnId ?? null,
		summary: result.summary,
		tokensBefore: result.tokensBefore,
		firstKeptTurnId: result.firstKeptTurnId ?? "",
	});
	return result;
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

function cycleScoped(direction: "forward" | "backward"): void {
	const current = readSettings();
	const next = advanceScopedTarget(current, direction);
	if (!next) return;
	current.orchestrator.endpoint = next.endpoint;
	current.orchestrator.model = next.model;
	writeSettings(current);
}

function resolveRepoRoot(): string | null {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		let cursor = here;
		for (let i = 0; i < 8; i++) {
			if (existsSync(join(cursor, "package.json")) && existsSync(join(cursor, "src"))) {
				return cursor;
			}
			const parent = dirname(cursor);
			if (parent === cursor) break;
			cursor = parent;
		}
	} catch {
		// fall through
	}
	return null;
}

export async function bootOrchestrator(): Promise<BootResult> {
	const timer = new StartupTimer();
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	installBusTracer();
	termination.installSignalHandlers();

	ensureInstalled();
	timer.mark("install check");

	const result = await loadDomains([
		ConfigDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		ModesDomainModule,
		PromptsDomainModule,
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

	process.stdout.write(buildBanner());
	if (process.env.CLIO_SELF_DEV === "1") {
		process.stdout.write(`  ${chalk.magenta("CLIO_SELF_DEV=1 · hot-reload on src/tools/*.ts · watching src/")}\n`);
	}
	if (process.env.CLIO_TIMING === "1") {
		process.stdout.write(`${timer.report()}\n`);
	}

	const runInteractive = process.env.CLIO_INTERACTIVE === "1" || process.env.CLIO_PHASE1_INTERACTIVE === "1";
	if (!runInteractive) {
		process.stdout.write(`${chalk.dim("  (non-interactive boot. pass CLIO_INTERACTIVE=1 to launch the TUI.)")}\n`);
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	const modes = result.getContract<ModesContract>("modes");
	const providers = result.getContract<ProvidersContract>("providers");
	const observability = result.getContract<ObservabilityContract>("observability");
	const safety = result.getContract<SafetyContract>("safety");
	if (!modes || !providers || !dispatch || !observability || !safety) {
		process.stderr.write(
			"clio: interactive mode requires safety + modes + providers + dispatch + observability contracts; aborting.\n",
		);
		await termination.shutdown(1);
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
	}
	const toolRegistry = createRegistry({ safety, modes });
	registerAllTools(toolRegistry);

	const allowedModesByName = new Map<string, ReadonlyArray<string>>();
	for (const spec of toolRegistry.listAll()) {
		if (spec.allowedModes) allowedModesByName.set(spec.name, spec.allowedModes);
	}

	const config = result.getContract<ConfigContract>("config");
	const session = result.getContract<SessionContract>("session");
	const prompts = result.getContract<PromptsContract>("prompts");

	const resumeId = process.env.CLIO_RESUME_SESSION_ID?.trim();
	if (resumeId && session) {
		try {
			session.resume(resumeId);
		} catch (err) {
			process.stderr.write(
				`clio: failed to resume session ${resumeId}: ${err instanceof Error ? err.message : String(err)}\n`,
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
		...(prompts ? { prompts } : {}),
		...(session ? { session } : {}),
		...(session
			? {
					readSessionEntries: (): ReadonlyArray<SessionEntry> => {
						const meta = session.current();
						if (!meta) return [];
						return readSessionEntriesForCompact(meta.id);
					},
					autoCompact: async (instructions?: string): Promise<CompactResult | null> => {
						try {
							return await runCompactionFlow(session, config?.get() ?? readSettings(), providers, instructions);
						} catch {
							return null;
						}
					},
				}
			: {}),
		toolRegistry,
	});

	let harness: HarnessHandle | null = null;
	if (process.env.CLIO_SELF_DEV === "1") {
		const repoRoot = resolveRepoRoot();
		if (!repoRoot) {
			process.stderr.write("clio: CLIO_SELF_DEV=1 but no repo checkout found; hot-reload disabled.\n");
		} else {
			// Compile hot modules under the repo's node_modules so Node resolves
			// bare imports (e.g. @sinclair/typebox) via the repo's installed deps.
			// An XDG cache path would be outside any node_modules tree and break
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
	}

	await startInteractive({
		bus,
		modes,
		providers,
		dispatch,
		observability,
		chat,
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
			const current = readSettings();
			current.orchestrator.thinkingLevel = level;
			writeSettings(current);
		},
		onCycleThinking: () => {
			const current = readSettings();
			const status = providers.list().find((entry) => entry.endpoint.id === current.orchestrator.endpoint);
			const available = status
				? availableThinkingLevels(status.capabilities, {
						runtimeId: status.runtime?.id ?? status.endpoint.runtime,
						...(current.orchestrator.model ? { modelId: current.orchestrator.model } : {}),
					})
				: (["off"] as ThinkingLevel[]);
			current.orchestrator.thinkingLevel = advanceThinkingLevel(current.orchestrator.thinkingLevel ?? "off", available);
			writeSettings(current);
		},
		onSelectModel: ({ endpoint, model }) => {
			const current = readSettings();
			current.orchestrator.endpoint = endpoint;
			current.orchestrator.model = model;
			writeSettings(current);
		},
		onSetScope: (scope) => {
			const current = readSettings();
			current.scope = Array.from(scope);
			writeSettings(current);
		},
		writeSettings: (next) => writeSettings(next),
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
		onCycleScopedModelForward: () => cycleScoped("forward"),
		onCycleScopedModelBackward: () => cycleScoped("backward"),
		...(harness ? { harness } : {}),
		onShutdown: async () => {
			await termination.shutdown(0);
		},
	});
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}
