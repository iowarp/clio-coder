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
import { type ProvidersContract, type ThinkingLevel, thinkingLevelChoiceLabel } from "../domains/providers/index.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import { installSkill } from "../domains/resources/skills/marketplace.js";
import type { SessionEntry } from "../domains/session/index.js";
import type { ShareContract } from "../domains/share/index.js";
import type { ImageContent } from "../engine/types.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import type { ChatLoop } from "./chat-loop.js";
import { type ChatPanel, createChatPanel } from "./chat-panel.js";
import { rehydrateChatPanelFromTurns } from "./chat-renderer.js";
import { runCompactWithNotice } from "./command-fallbacks.js";
import { appendNotice } from "./command-output.js";
import { resolveThinkingCapability } from "./overlays/thinking-selector.js";
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

const EXPORT_RENDER_WIDTH = 100;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC control character is the ANSI escape introducer this pattern exists to strip
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

function stripAnsiForExport(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

export interface InteractiveSlashSubmitExpansion {
	text: string;
	images: ImageContent[];
	workingContextPaths: string[];
	pendingSkillRequests: PendingSkillRequest[];
}

type SlashChat = Pick<ChatLoop, "getSessionId" | "submit">;
type SlashChatPanel = Pick<ChatPanel, "appendReplayBlock" | "appendUser">;
type SlashResources = Pick<ResourcesContract, "prompts" | "reload">;
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
	agents?: SlashAgents;
	share?: SlashShare;
	getSettings?: () => Readonly<ClioSettings>;
	writeSettings?: (next: ClioSettings) => void;
	onSelectModel?: (ref: { target: string; model: string }) => void;
	onSetThinkingLevel?: (level: ThinkingLevel) => void;
	onCompact?: (instructions: string | undefined) => Promise<void>;
	onInit?: (options: InitCommandOptions, io?: RunIo) => Promise<void>;
	onContextClear?: (options: ContextClearCommandOptions) => Promise<void>;
	onContextRefresh?: () => Promise<void>;
	stateDir: string;
	shutdown: () => void | Promise<void>;
	requestRender: () => void;
	refreshFooter: () => void;
	dismissContextBootstrapNotices: () => void;
	recordSubmittedTurn: () => void;
	readStructuredEntries: (sessionId: string) => ReadonlyArray<SessionEntry>;
	expandSubmit: (text: string) => Promise<InteractiveSlashSubmitExpansion>;
	openAskUser: AskUserHandler;
	openSkillsHub: () => void;
	openProviders: () => void;
	openCost: () => void;
	openContextView: () => void;
	openFleet: () => void;
	openTasks: () => void;
	openMemory: () => void;
	seedTaskMemory?: () => TaskMemorySeedCommandResult;
	openView: (filter?: string) => void;
	openThinking: () => void;
	openModel: () => void;
	openScopedModels: () => void;
	openSettings: () => void;
	openResume: () => void;
	startNewSession: () => void;
	openTree: () => void;
	openMessagePicker: () => void;
	openHelp: (query?: string) => void;
	openAgents: () => void;
	openPrompts: () => void;
	openExtensions: () => void;
	openContextReset: () => void;
	setEditorText: (text: string) => void;
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
export function createInteractiveSlashRuntime(deps: InteractiveSlashRuntimeDeps): InteractiveSlashRuntime {
	let activeContextInit = false;
	const cwd = (): string => deps.getCwd?.() ?? process.cwd();

	const appendCommandNotice: SlashCommandContext["notice"] = (level, text) => {
		appendNotice(level, text, {
			appendReplayBlock: (renderBlock) => deps.chatPanel.appendReplayBlock(renderBlock),
			requestRender: deps.requestRender,
		});
	};

	const context: SlashCommandContext = {
		io: deps.io,
		notice: appendCommandNotice,
		dispatch: deps.dispatch,
		bus: deps.bus,
		...(deps.agents
			? { getAgentRoleFacts: agentRoleFactsResolver((agentId: string) => deps.agents?.getSpec(agentId) ?? null) }
			: {}),
		shutdown: () => {
			void deps.shutdown();
		},
		listPrompts: () => deps.resources?.prompts(cwd()) ?? { items: [], diagnostics: [] },
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
		openProviders: deps.openProviders,
		openCost: deps.openCost,
		openContextView: deps.openContextView,
		openFleet: deps.openFleet,
		openTasks: deps.openTasks,
		openMemory: deps.openMemory,
		seedTaskMemory: () => {
			const result = deps.seedTaskMemory?.() ?? { status: "not-found" as const };
			deps.refreshFooter();
			deps.requestRender();
			return result;
		},
		openView: deps.openView,
		openThinking: deps.openThinking,
		setThinkingLevel: (level) => {
			const settings = deps.getSettings?.();
			if (!settings || !deps.onSetThinkingLevel) return { status: "unavailable" };
			const thinking = resolveThinkingCapability(deps.providers, settings);
			// The target's own supported set is the authority, and its labels are
			// what the selector and footer already show, so `/thinking on` works on
			// an on-off model exactly as picking `on` from the list does.
			const supported = thinking?.supportedLevels ?? (["off"] as ReadonlyArray<ThinkingLevel>);
			const labelFor = (candidate: ThinkingLevel): string =>
				thinkingLevelChoiceLabel(thinking?.mechanism ?? null, candidate);
			const requested = level.trim().toLowerCase();
			const match = supported.find((candidate) => candidate === requested || labelFor(candidate) === requested);
			if (!match) {
				return { status: "unsupported", level, supported: supported.map(labelFor) };
			}
			deps.onSetThinkingLevel(match);
			deps.refreshFooter();
			return { status: "applied", level: match, display: labelFor(match) };
		},
		setOutputVerbosity: (verbosity) => {
			if (!verbosity || !deps.getSettings || !deps.writeSettings) {
				appendCommandNotice("info", "usage: /output minimal|default|verbose");
				return;
			}
			const next = structuredClone(deps.getSettings()) as ClioSettings;
			if (verbosity !== "minimal" && verbosity !== "default" && verbosity !== "verbose") {
				appendCommandNotice("error", "usage: /output minimal|default|verbose");
				return;
			}
			next.terminal.outputVerbosity = verbosity;
			deps.writeSettings(next);
			appendCommandNotice("success", `output detail: ${verbosity}`);
			deps.requestRender();
		},
		openModel: deps.openModel,
		providers: deps.providers,
		applyModelRef: (ref) => {
			deps.onSelectModel?.({ target: ref.target, model: ref.model });
			if (ref.thinkingLevel) deps.onSetThinkingLevel?.(ref.thinkingLevel);
			deps.requestRender();
		},
		openScopedModels: deps.openScopedModels,
		openSettings: deps.openSettings,
		openResume: deps.openResume,
		startNewSession: deps.startNewSession,
		openTree: deps.openTree,
		openMessagePicker: deps.openMessagePicker,
		openHelp: deps.openHelp,
		openAgents: deps.openAgents,
		openPrompts: deps.openPrompts,
		openExtensions: deps.openExtensions,
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
				// Same pure render pipeline as the live panel and /resume replay:
				// a throwaway panel rehydrated from the ledger, every tool segment
				// expanded, rendered at a fixed width, ANSI stripped. Unlike the
				// live view, export renders full tool bodies (no middle-elision or
				// char truncation) so the transcript reproduces the complete output.
				const exportPanel = createChatPanel({ unboundedToolBodies: true });
				rehydrateChatPanelFromTurns(exportPanel, turns, { unboundedToolBodies: true });
				exportPanel.toggleAllToolsExpanded();
				const lines = exportPanel.render(EXPORT_RENDER_WIDTH).map(stripAnsiForExport);
				const date = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
				const target = resolve(
					pathArg && pathArg.trim().length > 0 ? pathArg.trim() : join(".clio", "exports", `${sessionId}-${date}.md`),
				);
				mkdirSync(resolve(target, ".."), { recursive: true });
				const header = [
					`# Clio session ${sessionId}`,
					"",
					`Exported ${(deps.now?.() ?? new Date()).toISOString()}`,
					"",
					"```text",
				];
				writeFileSync(target, `${[...header, ...lines, "```", ""].join("\n")}`, "utf8");
				appendCommandNotice("success", `[/export] wrote ${lines.length} lines to ${target}`);
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
		submitChat: (text) => {
			const runSubmit = (sub: InteractiveSlashSubmitExpansion) => {
				void (async () => {
					try {
						deps.recordSubmittedTurn();
						deps.refreshFooter();
						deps.chatPanel.appendUser(sub.text);
						deps.requestRender();
						await deps.chat.submit(sub.text, {
							...(sub.images.length > 0 ? { images: sub.images } : {}),
							...(sub.workingContextPaths.length > 0 ? { workingContextPaths: sub.workingContextPaths } : {}),
							...(sub.pendingSkillRequests.length > 0 ? { pendingSkillRequests: sub.pendingSkillRequests } : {}),
						});
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						deps.io.stderr(`[interactive] chat failed: ${msg}\n`);
					} finally {
						deps.requestRender();
					}
				})();
			};

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
										runSubmit(postInstallSubmitted);
									} catch (err) {
										deps.io.stderr(
											`Failed to install skill "${uninstalled.name}": ${err instanceof Error ? err.message : String(err)}\n`,
										);
									}
								})();
							});
						return;
					}

					runSubmit(submitted);
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
