import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { PendingSkillRequest } from "../core/skill-activation.js";
import { clioConfigDir } from "../core/xdg.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { agentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import type { ExtensionsContract } from "../domains/extensions/index.js";
import {
	type ProvidersContract,
	type ResolvedThinkingCapability,
	resolveModelRuntimeCapabilitiesForProviders,
	type ThinkingLevel,
	thinkingLevelChoiceLabel,
} from "../domains/providers/index.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import { installSkill } from "../domains/resources/skills/marketplace.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";
import type { ShareContract } from "../domains/share/index.js";
import type { UserTasksStore } from "../domains/user-tasks/store.js";
import { stripTerminalSequences } from "../engine/tui.js";
import type { ImageContent } from "../engine/types.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import type { ChatLoop } from "./chat-loop.js";
import { type ChatPanel, createChatPanel } from "./chat-panel.js";
import { rehydrateChatPanelFromTurns } from "./chat-renderer.js";
import { runCompactWithNotice } from "./command-fallbacks.js";
import { appendNotice, appendOperatorCommand } from "./command-output.js";
import { renderSessionHtml } from "./export-html/index.js";
import { dateLocal } from "./format-time.js";
import type { SettingsCenterRowId, SettingsSectionId } from "./overlays/settings.js";
import {
	type ContextClearCommandOptions,
	dispatchSlashCommand,
	type InitCommandOptions,
	parseSlashCommand,
	type RunIo,
	type SlashCommandContext,
	type TaskMemorySeedCommandResult,
} from "./slash-commands.js";
import { verifyReceiptFile } from "./view/artifacts.js";
import type { WorkerEntryState } from "./worker-stream.js";

const EXPORT_RENDER_WIDTH = 100;

export interface InteractiveSlashSubmitExpansion {
	text: string;
	images: ImageContent[];
	workingContextPaths: string[];
	pendingSkillRequests: PendingSkillRequest[];
}

type SlashChat = Pick<ChatLoop, "getSessionId" | "isStreaming" | "submit">;
type SlashChatPanel = Pick<ChatPanel, "appendReplayBlock" | "appendUser">;
type SlashResources = Pick<ResourcesContract, "prompts" | "expandPromptTemplate" | "reload">;
type SlashExtensions = Pick<ExtensionsContract, "list">;
type SlashAgents = Pick<AgentsContract, "getSpec" | "listSpecs">;
type SlashShare = Pick<ShareContract, "writeArchive" | "planImport" | "importArchive">;

export interface InteractiveSlashRuntimeDeps {
	io: RunIo;
	bus: SafeEventBus;
	dispatch: DispatchContract;
	providers: ProvidersContract;
	chat: SlashChat;
	chatPanel: SlashChatPanel;
	resources?: SlashResources;
	extensions?: SlashExtensions;
	interop?: SlashCommandContext["interop"];
	agents?: SlashAgents;
	share?: SlashShare;
	userTasks?: UserTasksStore;
	getSettings?: () => Readonly<ClioSettings>;
	writeSettings?: (next: ClioSettings) => void;
	/**
	 * Scoped commit of one settings leaf, the same path /settings edits take.
	 * Slash commands use scope "session": they change the running session, and
	 * making a value permanent stays the Settings overlay's explicit choice.
	 */
	commitSetting?: (id: string, next: ClioSettings, scope: "session" | "global") => void;
	onSelectModel?: (ref: { target: string; model: string }) => void;
	onSetThinkingLevel?: (level: ThinkingLevel) => void;
	onCompact?: (instructions: string | undefined) => Promise<void>;
	onInit?: (options: InitCommandOptions, io?: RunIo) => Promise<void>;
	onContextClear?: (options: ContextClearCommandOptions) => Promise<void>;
	onContextRefresh?: () => Promise<void>;
	stateDir: string;
	shutdown: () => void | Promise<void>;
	requestRender: () => void;
	beforeSemanticSubmit?: () => void;
	settleVisibleFrame?: (reason: string) => Promise<void>;
	refreshFooter: () => void;
	dismissContextBootstrapNotices: () => void;
	recordSubmittedTurn: () => void;
	readStructuredEntries: (sessionId: string) => ReadonlyArray<SessionEntry>;
	/**
	 * Leaf lookup for `/export`, so the export follows the branch the session
	 * is actually on. current.jsonl still holds the abandoned turns after a
	 * `/tree` pin, and an unscoped rehydrate reproduced them (issue #109).
	 */
	session?: Pick<SessionContract, "tree">;
	expandSubmit: (text: string) => Promise<InteractiveSlashSubmitExpansion>;
	openAskUser: AskUserHandler;
	openSkillsHub: () => void;
	openCost: () => void;
	openContextView: () => void;
	openTasks: () => void;
	openDecisions: () => void;
	openMemory: () => void;
	seedTaskMemory?: () => TaskMemorySeedCommandResult;
	openView: (filter?: string) => void;
	openModel: () => void;
	openSettings: (section?: SettingsSectionId, rowId?: SettingsCenterRowId) => void;
	openResume: () => void;
	startNewSession: () => void;
	openTree: () => void;
	openMessagePicker: () => void;
	openHelp: (query?: string) => void;
	openAgents: () => void;
	openPrompts: () => void;
	openExtensions: () => void;
	openInterop?: () => void;
	openContextReset: () => void;
	setEditorText: (text: string) => void;
	/** Worker blocks this session folded, oldest first; `/share` picks a finished one. */
	listWorkerRuns?: () => ReadonlyArray<WorkerEntryState>;
	getCwd?: () => string;
	getConfigDir?: () => string;
	installSkill?: typeof installSkill;
	now?: () => Date;
}

export interface InteractiveSlashRuntime {
	context: SlashCommandContext;
	notice: SlashCommandContext["notice"];
	dispatchCommand(text: string): void;
}

/** Owns slash-command context construction and its asynchronous command state. */
const OUTPUT_VERBOSITIES: ReadonlyArray<ClioSettings["terminal"]["outputVerbosity"]> = [
	"minimal",
	"default",
	"verbose",
];

/** Thinking capability of the active orchestrator target and model, or null when unresolved. */
export function resolveThinkingCapability(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): ResolvedThinkingCapability | null {
	const resolved = resolveModelRuntimeCapabilitiesForProviders(
		providers,
		settings.orchestrator.target,
		settings.orchestrator.model,
		settings.orchestrator.thinkingLevel ?? "off",
	);
	return resolved?.thinking ?? null;
}

/**
 * Thinking levels permitted for the active orchestrator target. This is the
 * same resolved surface used by the runtime payload builders and dashboard.
 * Unknown or unconfigured targets return `["off"]`.
 */
export function resolveAvailableThinkingLevels(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): ReadonlyArray<ThinkingLevel> {
	return resolveThinkingCapability(providers, settings)?.supportedLevels ?? ["off"];
}

export function createInteractiveSlashRuntime(deps: InteractiveSlashRuntimeDeps): InteractiveSlashRuntime {
	let activeContextInit = false;
	const cwd = (): string => deps.getCwd?.() ?? process.cwd();
	const resources = deps.resources;
	const userTasks = deps.userTasks;

	const appendCommandNotice: SlashCommandContext["notice"] = (level, text) => {
		appendNotice(level, text, {
			appendReplayBlock: (renderBlock) => deps.chatPanel.appendReplayBlock(renderBlock),
			requestRender: deps.requestRender,
		});
	};

	/** One expanded operator turn into the chat loop: record it, paint it, submit it. */
	const submitExpanded = (sub: InteractiveSlashSubmitExpansion): void => {
		void (async () => {
			try {
				// Enter while streaming becomes a steer inside chat.submit. The
				// queue panel shows it until the engine injects it, and the
				// injection emits queued_user_turn, which is when the transcript
				// renders it. Appending here too showed the text twice and at
				// the wrong point in the turn's order.
				const willQueue = deps.chat.isStreaming();
				deps.recordSubmittedTurn();
				deps.refreshFooter();
				if (!willQueue) deps.chatPanel.appendUser(sub.text);
				deps.requestRender();
				deps.beforeSemanticSubmit?.();
				await deps.chat.submit(sub.text, {
					...(sub.images.length > 0 ? { images: sub.images } : {}),
					...(sub.workingContextPaths.length > 0 ? { workingContextPaths: sub.workingContextPaths } : {}),
					...(sub.pendingSkillRequests.length > 0 ? { pendingSkillRequests: sub.pendingSkillRequests } : {}),
				});
				await deps.settleVisibleFrame?.("submit-return");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				deps.io.stderr(`[interactive] chat failed: ${msg}\n`);
			} finally {
				deps.requestRender();
			}
		})();
	};
	const context: SlashCommandContext = {
		io: deps.io,
		notice: appendCommandNotice,
		echoOperatorCommand: (text) => {
			appendOperatorCommand(text, {
				appendReplayBlock: (renderBlock) => deps.chatPanel.appendReplayBlock(renderBlock),
				requestRender: deps.requestRender,
			});
		},
		dispatch: deps.dispatch,
		bus: deps.bus,
		...(deps.agents
			? { getAgentRoleFacts: agentRoleFactsResolver((agentId: string) => deps.agents?.getSpec(agentId) ?? null) }
			: {}),
		shutdown: () => {
			void deps.shutdown();
		},
		listPrompts: () => deps.resources?.prompts(cwd()) ?? { items: [], diagnostics: [] },
		...(resources ? { expandPromptTemplate: (text: string) => resources.expandPromptTemplate(text, cwd()) } : {}),
		openSkillsHub: deps.openSkillsHub,
		listExtensions: () => deps.extensions?.list(cwd(), { all: true }) ?? [],
		listAgents: () => deps.agents?.listSpecs().filter((spec) => spec.audience !== "internal") ?? [],
		listDelegationAgents: () => deps.getSettings?.().delegation.agents ?? [],
		exportShareArchive: (outPath) => {
			if (!deps.share) throw new Error("share domain is not loaded");
			const path = resolve(outPath);
			const archive = deps.share.writeArchive(path, { scope: "project" });
			return { fileCount: archive.files.length, path };
		},
		importShareArchive: (archivePath, options) => {
			if (!deps.share) {
				return {
					archive: null,
					actions: [],
					diagnostics: [{ type: "error", message: "share domain is not loaded" }],
				};
			}
			const importOptions = {
				...(options.dryRun ? { dryRun: true } : {}),
				...(options.force ? { force: true } : {}),
			};
			return options.dryRun
				? deps.share.planImport(resolve(archivePath), importOptions)
				: deps.share.importArchive(resolve(archivePath), importOptions);
		},
		openCost: deps.openCost,
		openContextView: deps.openContextView,
		openTasks: deps.openTasks,
		openDecisions: deps.openDecisions,
		...(userTasks
			? {
					userTasks: {
						add: (title: string) => userTasks.add(title),
						hand: (id: string) => userTasks.hand(id, deps.chat.getSessionId() ?? undefined),
						done: (id: string) => userTasks.done(id),
						drop: (id: string) => userTasks.drop(id),
					},
				}
			: {}),
		openMemory: deps.openMemory,
		seedTaskMemory: () => {
			const result = deps.seedTaskMemory?.() ?? { status: "not-found" as const };
			deps.refreshFooter();
			deps.requestRender();
			return result;
		},
		openView: deps.openView,
		setThinkingLevel: (level) => {
			const settings = deps.getSettings?.();
			if (!settings || !deps.onSetThinkingLevel) return { status: "unavailable" };
			const thinking = resolveThinkingCapability(deps.providers, settings);
			// The target's own supported set is the authority, and its labels are
			// what the settings row and footer already show, so `/thinking on` works
			// on an on-off model exactly as picking `on` in settings does.
			const supported = thinking?.supportedLevels ?? (["off"] as ReadonlyArray<ThinkingLevel>);
			const labelFor = (candidate: ThinkingLevel): string =>
				thinkingLevelChoiceLabel(thinking?.mechanism ?? null, candidate);
			const requested = level.trim().toLowerCase();
			const match = supported.find((candidate) => candidate === requested || labelFor(candidate) === requested);
			if (!match) {
				return { status: "unsupported", level, supported: supported.map(labelFor) };
			}
			// Session scope, like /output: onSetThinkingLevel writes the level
			// through to settings.yaml as the new default, which a slash command
			// has no mandate to do.
			if (deps.commitSetting) {
				const next = structuredClone(settings) as ClioSettings;
				next.orchestrator.thinkingLevel = match;
				deps.commitSetting("orchestrator.thinkingLevel", next, "session");
			} else {
				deps.onSetThinkingLevel(match);
			}
			deps.refreshFooter();
			return { status: "applied", level: match, display: labelFor(match) };
		},
		setOutputVerbosity: (verbosity) => {
			if (!deps.getSettings || !(deps.commitSetting || deps.writeSettings)) return { status: "unavailable" };
			const requested = verbosity.trim().toLowerCase();
			const match = OUTPUT_VERBOSITIES.find((candidate) => candidate === requested);
			if (!match) return { status: "unsupported", verbosity, supported: OUTPUT_VERBOSITIES };
			const next = structuredClone(deps.getSettings()) as ClioSettings;
			next.terminal.outputVerbosity = match;
			// Session scope: /output changes this session and leaves settings.yaml
			// alone. Saving it as the default is what Settings → Terminal is for.
			if (deps.commitSetting) deps.commitSetting("terminal.outputVerbosity", next, "session");
			else deps.writeSettings?.(next);
			return { status: "applied", verbosity: match };
		},
		openModel: deps.openModel,
		providers: deps.providers,
		applyModelRef: (ref) => {
			deps.onSelectModel?.({ target: ref.target, model: ref.model });
			if (ref.thinkingLevel) deps.onSetThinkingLevel?.(ref.thinkingLevel);
			deps.requestRender();
		},
		openSettings: deps.openSettings,
		openResume: deps.openResume,
		startNewSession: deps.startNewSession,
		openTree: deps.openTree,
		openMessagePicker: deps.openMessagePicker,
		openHelp: deps.openHelp,
		openAgents: deps.openAgents,
		openPrompts: deps.openPrompts,
		openExtensions: deps.openExtensions,
		...(deps.openInterop ? { openInterop: deps.openInterop } : {}),
		...(deps.interop ? { interop: deps.interop } : {}),
		setEditorText: (text) => {
			deps.setEditorText(text);
			deps.requestRender();
		},
		runCompact: (instructions) => {
			runCompactWithNotice(deps.onCompact, appendCommandNotice, instructions);
		},
		exportTranscript: (pathArg) => {
			const sessionId = deps.chat.getSessionId();
			if (!sessionId) {
				appendCommandNotice("error", "[/export] no active session to export");
				return;
			}
			try {
				const turns = deps.readStructuredEntries(sessionId);
				// Same pure render pipeline as the live panel and /resume replay: a
				// throwaway panel is rehydrated from the ledger, every tool segment is
				// expanded, and the transcript is rendered at a stable width. HTML
				// converts the resulting ANSI presentation to inline styles; Markdown
				// keeps the prior plain-text fenced transcript.
				const exportPanel = createChatPanel({ unboundedToolBodies: true });
				// Scoped to the leaf the session is on, the same way /resume replays
				// (issue #107): with a /tree pin persisted and not yet extended, the
				// file still holds the abandoned branch after the pin, and an unscoped
				// rehydrate exported it as ordinary history (issue #109). No session
				// contract means no pin can exist for this reader, so the file replays whole.
				const leafTurnId = deps.session?.tree(sessionId).leafId ?? null;
				rehydrateChatPanelFromTurns(exportPanel, turns, {
					unboundedToolBodies: true,
					...(leafTurnId ? { activeLeafTurnId: leafTurnId } : {}),
				});
				exportPanel.toggleAllToolsExpanded();
				const ansiLines = exportPanel.render(EXPORT_RENDER_WIDTH);
				// The operator names this file by the day they ran the export, so the
				// date in it is their calendar date. The header below keeps the ISO
				// instant, which is the machine-readable half of the same fact.
				const exportedAt = deps.now?.() ?? new Date();
				const date = dateLocal(exportedAt);
				const requestedPath = pathArg?.trim() ?? "";
				const markdown = requestedPath.toLowerCase().endsWith(".md");
				const target = resolve(
					requestedPath.length > 0 ? requestedPath : join(".clio-coder", "exports", `${sessionId}-${date}.html`),
				);
				mkdirSync(resolve(target, ".."), { recursive: true });
				if (markdown) {
					const lines = ansiLines.map(stripTerminalSequences);
					const header = [`# Clio session ${sessionId}`, "", `Exported ${exportedAt.toISOString()}`, "", "```text"];
					writeFileSync(target, `${[...header, ...lines, "```", ""].join("\n")}`, "utf8");
				} else {
					writeFileSync(target, renderSessionHtml({ sessionId, exportedAt: exportedAt.toISOString(), ansiLines }), "utf8");
				}
				appendCommandNotice("success", `[/export] wrote ${ansiLines.length} lines to ${target}`);
			} catch (err) {
				appendCommandNotice("error", `[/export] ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		runInit: (options) => {
			const onInit = deps.onInit;
			if (!onInit) {
				deps.io.stderr("[/context init] context init not wired; pass onInit to startInteractive\n");
				return;
			}
			if (activeContextInit) {
				deps.io.stderr("[/context init] bootstrap already running\n");
				return;
			}
			activeContextInit = true;
			void Promise.resolve()
				.then(() => onInit(options, deps.io))
				.then(() => {
					deps.dismissContextBootstrapNotices();
					deps.refreshFooter();
				})
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					deps.io.stderr(`[/context init] ${msg}\n`);
				})
				.finally(() => {
					activeContextInit = false;
					deps.requestRender();
				});
		},
		runContextClear: () => {
			if (!deps.onContextClear) {
				deps.io.stderr("[/context reset] context reset not wired; pass onContextClear to startInteractive\n");
				return;
			}
			deps.openContextReset();
		},
		runContextRefresh: () => {
			if (!deps.onContextRefresh) {
				deps.io.stderr("[/context refresh] context refresh not wired; pass onContextRefresh to startInteractive\n");
				return;
			}
			void deps
				.onContextRefresh()
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					deps.io.stderr(`[/context refresh] ${msg}\n`);
				})
				.finally(deps.requestRender);
		},
		verifyReceipt: (runId) => verifyReceiptFile(deps.stateDir, runId),
		...(deps.listWorkerRuns ? { listWorkerRuns: deps.listWorkerRuns } : {}),
		// The user-turn path, minus expansion. A worker's answer is literal text:
		// running it through the prompt, skill, and @file expanders would let a
		// worker's output name a file the operator never mentioned.
		submitOperatorNote: (text) => submitExpanded({ text, images: [], workingContextPaths: [], pendingSkillRequests: [] }),
		submitChat: (text) => {
			void (async () => {
				try {
					const submitted = await deps.expandSubmit(text);
					const uninstalled = submitted.pendingSkillRequests.find((request) => !request.installed);
					if (uninstalled && !uninstalled.marketplaceRef) {
						deps.io.stderr(`Skill "${uninstalled.name}" is not installed and no local marketplace entry is available.\n`);
						return;
					}
					if (uninstalled) {
						void deps
							.openAskUser([
								{
									question: `Skill "${uninstalled.name}" is not installed. Would you like to install it?`,
									options: [
										{
											label: "Install and run",
											description: `Install from ${uninstalled.marketplaceRef}`,
										},
										{ label: "Cancel", description: "Do not install." },
									],
								},
							])
							.then((res) => {
								if (res.cancelled || res.answers[0]?.answer !== "Install and run") {
									deps.io.stderr("Installation cancelled.\n");
									return;
								}
								void (async () => {
									try {
										deps.io.stdout(`Installing skill "${uninstalled.name}"...\n`);
										let configDir: string | undefined;
										try {
											configDir = (deps.getConfigDir ?? clioConfigDir)();
										} catch (configErr) {
											deps.io.stderr(
												`Skill install: config dir unavailable (${configErr instanceof Error ? configErr.message : String(configErr)}); continuing without it.\n`,
											);
										}
										(deps.installSkill ?? installSkill)({
											source: uninstalled.name,
											cwd: cwd(),
											...(configDir ? { configDir } : {}),
										});
										deps.io.stdout(`Successfully installed "${uninstalled.name}"!\n`);
										await deps.resources?.reload();
										const postInstallSubmitted = await deps.expandSubmit(text);
										submitExpanded(postInstallSubmitted);
									} catch (err) {
										deps.io.stderr(
											`Failed to install skill "${uninstalled.name}": ${err instanceof Error ? err.message : String(err)}\n`,
										);
									}
								})();
							});
						return;
					}

					submitExpanded(submitted);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					deps.io.stderr(`[interactive] chat failed: ${msg}\n`);
					deps.requestRender();
				}
			})();
		},
		render: deps.requestRender,
	};

	return {
		context,
		notice: appendCommandNotice,
		dispatchCommand: (text) => dispatchSlashCommand(parseSlashCommand(text), context),
	};
}
