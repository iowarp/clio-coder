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
import { isLocalEngineId } from "../domains/providers/catalog.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { VALID_THINKING_LEVELS, resolveModelPattern, resolveModelScope } from "../domains/providers/resolver.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { type CompactResult, compact } from "../domains/session/compaction/compact.js";
import type { SessionContract } from "../domains/session/contract.js";
import { fromLegacyTurn } from "../domains/session/entries.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { SessionDomainModule } from "../domains/session/index.js";
import { getModel, resolveLocalModelId } from "../engine/ai.js";
import { openSession } from "../engine/session.js";
import type { Model } from "../engine/types.js";
import { createChatLoop } from "../interactive/chat-loop.js";
import { startInteractive } from "../interactive/index.js";
import { renderCompactionSummaryLine } from "../interactive/renderers/compaction-summary.js";

export interface BootResult {
	exitCode: number;
	bootTimeMs: number;
}

function buildBanner(): string {
	const { clio } = getVersionInfo();
	return `
  ${chalk.cyan("◆ clio")}  IOWarp orchestrator coding-agent
  ${chalk.dim(`v${clio} · pi-mono 0.67.4 · ready`)}
`;
}

const LOCAL_API_KEY_FALLBACK = "clio-local-endpoint";

function envApiKeyName(providerId: string): string {
	return `${providerId.replaceAll("-", "_").toUpperCase()}_API_KEY`;
}

/**
 * Resolve the model that should generate the compaction summary.
 * Precedence (plan §4):
 *   1. `settings.compaction.model` via resolveModelPattern, when set and
 *      resolvable. Otherwise fall through silently — an unresolvable user
 *      override should not suppress the orchestrator fallback.
 *   2. `settings.orchestrator.{provider,model,endpoint}` via the same
 *      `modelId@endpoint` composition the chat-loop uses.
 * Returns `null` when neither path yields a model; the caller surfaces an
 * actionable /compact error in that case.
 */
function resolveCompactionModel(
	settings: ClioSettings,
): { model: Model<never>; providerId: string; endpointSpec?: { api_key?: string } } | null {
	const patternRaw = settings.compaction?.model?.trim();
	if (patternRaw) {
		const resolved = resolveModelPattern(patternRaw);
		const first = resolved.matches[0];
		if (first) {
			try {
				const model = getModel(first.providerId, first.modelId);
				return { model, providerId: first.providerId };
			} catch {
				// fall through to orchestrator fallback
			}
		}
	}
	const providerId = settings.orchestrator?.provider?.trim();
	const modelId = settings.orchestrator?.model?.trim();
	if (!providerId || !modelId) return null;
	const endpoint = settings.orchestrator?.endpoint?.trim();
	const lookupId = resolveLocalModelId(providerId, modelId, endpoint);
	try {
		const model = getModel(providerId, lookupId);
		let endpointSpec: { api_key?: string } | undefined;
		if (isLocalEngineId(providerId) && endpoint) {
			const raw = settings.providers?.[providerId]?.endpoints?.[endpoint];
			if (raw) endpointSpec = { ...(raw.api_key ? { api_key: raw.api_key } : {}) };
		}
		return endpointSpec ? { model, providerId, endpointSpec } : { model, providerId };
	} catch {
		return null;
	}
}

/**
 * Resolve the API key for a compaction call. Mirrors chat-loop.ts so the
 * compaction model inherits the same key pool as the orchestrator.
 */
function resolveCompactionApiKey(
	providerId: string,
	endpointSpec: { api_key?: string } | undefined,
): string | undefined {
	if (endpointSpec?.api_key && endpointSpec.api_key.length > 0) return endpointSpec.api_key;
	const envKey = process.env[envApiKeyName(providerId)];
	if (envKey) return envKey;
	return endpointSpec ? LOCAL_API_KEY_FALLBACK : undefined;
}

/**
 * Load the current session's entries from disk for compaction input.
 * Slice 12c reads legacy ClioTurnRecord lines only; rich SessionEntry lines
 * are detected and skipped so the compaction engine never receives
 * partially-shaped records. 12d replaces this with a unified reader.
 */
function readSessionEntriesForCompact(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	const turns = reader.turns();
	const out: SessionEntry[] = [];
	for (const record of turns) {
		const anyRecord = record as unknown as { id?: unknown; at?: unknown; kind?: unknown };
		if (typeof anyRecord.id === "string" && typeof anyRecord.at === "string" && typeof anyRecord.kind === "string") {
			out.push(fromLegacyTurn(record));
		}
	}
	return out;
}

/**
 * Shared compaction flow used by both the `/compact` slash-command handler
 * and the chat-loop auto-trigger (slice 12d). Throws on configuration errors
 * that warrant user feedback (no session, no model); returns null on
 * no-op cases (no entries yet, no cut crossed) so the caller can decide
 * whether to stay silent (auto-path) or print a status line (manual path).
 *
 * On success, writes the compactionSummary entry via `session.appendEntry`
 * and returns the CompactResult the chat-loop needs to swap its in-memory
 * AgentMessage list.
 */
async function runCompactionFlow(
	session: SessionContract,
	settings: ClioSettings,
	instructions?: string,
): Promise<CompactResult | null> {
	const meta = session.current();
	if (!meta) {
		throw new Error("no current session to compact; start one with /new or /resume first");
	}
	const resolved = resolveCompactionModel(settings);
	if (!resolved) {
		throw new Error("no model configured; set orchestrator.model or compaction.model");
	}
	const apiKey = resolveCompactionApiKey(resolved.providerId, resolved.endpointSpec);
	const entries = readSessionEntriesForCompact(meta.id);
	if (entries.length === 0) return null;

	const result = await compact({
		entries,
		model: resolved.model,
		...(apiKey !== undefined ? { apiKey } : {}),
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
 * Ctrl+P / Shift+Ctrl+P step the orchestrator target through the resolved
 * `provider.scope` set. A no-op when scope is empty or resolves to nothing, so
 * unconfigured users feel no phantom behavior.
 */
function cycleScoped(direction: "forward" | "backward"): void {
	const current = readSettings();
	const patterns = current.provider.scope ?? [];
	if (patterns.length === 0) return;
	const resolved = resolveModelScope(patterns).matches;
	if (resolved.length === 0) return;
	const active = `${current.orchestrator.provider ?? ""}::${current.orchestrator.model ?? ""}`;
	const idx = resolved.findIndex((r) => `${r.providerId}::${r.modelId}` === active);
	const base = idx === -1 ? 0 : idx + (direction === "forward" ? 1 : resolved.length - 1);
	const next = resolved[base % resolved.length];
	if (!next) return;
	current.orchestrator.provider = next.providerId;
	current.orchestrator.model = next.modelId;
	if (next.thinkingLevel) current.orchestrator.thinkingLevel = next.thinkingLevel;
	writeSettings(current);
}

export async function bootOrchestrator(): Promise<BootResult> {
	const timer = new StartupTimer();
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	// CLIO_BUS_TRACE=1 turns on the stderr bus tracer used by diag scripts
	// (see src/core/bus-trace.ts). Off by default; no production overhead.
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
		// scheduling before dispatch: dispatch consults scheduling.preflight()
		// during admission to gate on the session budget ceiling.
		DispatchDomainModule,
		IntelligenceDomainModule,
		LifecycleDomainModule,
	]);
	timer.mark(`domains loaded (${result.loaded.length})`);

	// DRAIN: abort active dispatch runs and persist the ledger before domain teardown.
	// PERSIST: invoke domain-loader stop() (reverse topo order) to run each domain's stop hook.
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
	if (process.env.CLIO_TIMING === "1") {
		process.stdout.write(`${timer.report()}\n`);
	}

	// CLIO_INTERACTIVE=1 is the current env; CLIO_PHASE1_INTERACTIVE=1 is a
	// backward-compat alias from Phase 1's stub loop. Both route into the
	// minimal interactive TUI introduced in Phase 9.
	const runInteractive = process.env.CLIO_INTERACTIVE === "1" || process.env.CLIO_PHASE1_INTERACTIVE === "1";
	if (!runInteractive) {
		process.stdout.write(`${chalk.dim("  (non-interactive boot. pass CLIO_INTERACTIVE=1 to launch the TUI.)")}\n`);
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	const modes = result.getContract<ModesContract>("modes");
	const providers = result.getContract<ProvidersContract>("providers");
	const observability = result.getContract<ObservabilityContract>("observability");
	if (!modes || !providers || !dispatch || !observability) {
		process.stderr.write(
			"clio: interactive mode requires modes + providers + dispatch + observability contracts; aborting.\n",
		);
		await termination.shutdown(1);
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
	}

	const config = result.getContract<ConfigContract>("config");
	const session = result.getContract<SessionContract>("session");
	const prompts = result.getContract<PromptsContract>("prompts");
	const chat = createChatLoop({
		getSettings: () => config?.get() ?? readSettings(),
		modes,
		knownProviders: () => new Set(providers.list().map((entry) => entry.id)),
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
							return await runCompactionFlow(session, config?.get() ?? readSettings(), instructions);
						} catch {
							// Auto-path is silent on configuration errors so the
							// chat-loop does not spam the user on every turn.
							// /compact still surfaces the error for manual runs.
							return null;
						}
					},
				}
			: {}),
	});
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
		getOrchestratorModel: () => {
			const settings = config?.get() ?? readSettings();
			const providerId = settings.orchestrator?.provider?.trim();
			const modelId = settings.orchestrator?.model?.trim();
			if (!providerId || !modelId) return undefined;
			const endpoint = settings.orchestrator?.endpoint?.trim();
			const lookupId = resolveLocalModelId(providerId, modelId, endpoint);
			try {
				return getModel(providerId, lookupId);
			} catch {
				return undefined;
			}
		},
		...(config ? { getWorkerDefault: () => config.get().workers?.default } : {}),
		...(session ? { getSessionId: () => session.current()?.id ?? null } : {}),
		onSetThinkingLevel: (level) => {
			const current = readSettings();
			current.orchestrator.thinkingLevel = level;
			writeSettings(current);
		},
		onCycleThinking: () => {
			const current = readSettings();
			const idx = VALID_THINKING_LEVELS.indexOf(current.orchestrator.thinkingLevel ?? "off");
			const next = VALID_THINKING_LEVELS[(idx + 1) % VALID_THINKING_LEVELS.length] ?? "off";
			current.orchestrator.thinkingLevel = next;
			writeSettings(current);
		},
		onSelectModel: ({ providerId, modelId, endpoint }) => {
			const current = readSettings();
			current.orchestrator.provider = providerId;
			current.orchestrator.model = modelId;
			if (endpoint) current.orchestrator.endpoint = endpoint;
			else Reflect.deleteProperty(current.orchestrator, "endpoint");
			writeSettings(current);
		},
		onSetScope: (scope) => {
			const current = readSettings();
			current.provider.scope = scope;
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
						try {
							const result = await runCompactionFlow(session, config?.get() ?? readSettings(), instructions);
							if (result === null) {
								process.stdout.write("[/compact] nothing to compact; session is empty or no cut crossed\n");
								return;
							}
							process.stdout.write(
								`${renderCompactionSummaryLine({
									messagesSummarized: result.messagesSummarized,
									summaryChars: result.summary.length,
									tokensBefore: result.tokensBefore,
									isSplitTurn: result.isSplitTurn,
								})}\n`,
							);
						} catch (err) {
							process.stderr.write(`[/compact] ${err instanceof Error ? err.message : String(err)}\n`);
						}
					},
				}
			: {}),
		onCycleScopedModelForward: () => cycleScoped("forward"),
		onCycleScopedModelBackward: () => cycleScoped("backward"),
		onShutdown: async () => {
			await termination.shutdown(0);
		},
	});
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}
