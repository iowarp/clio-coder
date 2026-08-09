import { exec } from "node:child_process";
import { BusChannels, type PermissionRequestedPayload } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import { ToolNames } from "../core/tool-names.js";
import { loadMemoryRecordsSync, type MemoryRecord } from "../domains/memory/index.js";
import {
	getRuntimeRegistry,
	resolveProviderReference,
	type ThinkingLevel,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import { installSkill } from "../domains/resources/skills/marketplace.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { resolveSessionCwd } from "../domains/session/cwd-fallback.js";
import type { SessionContract } from "../domains/session/index.js";
import type { OAuthSelectPrompt } from "../engine/oauth.js";
import type { OverlayHandle } from "../engine/tui.js";
import { type AskUserHandler, cancelledAskUserResult } from "../tools/ask-user.js";
import type { PermissionRequiredMeta } from "../tools/registry.js";
import { approvalParkedNotice, autonomyDeniedNotice, workerEscalationNotice } from "./bus-notices.js";
import { buildReplayAgentMessagesFromTurns, rehydrateChatPanelFromTurns } from "./chat-renderer.js";
import { emitCommandNotice } from "./command-fallbacks.js";
import { appendNotice } from "./command-output.js";
import { openContextOverlay } from "./context-overlay.js";
import { openCostOverlay } from "./cost-overlay.js";
import { isDispatchBoardRowCancellable, isDispatchBoardRowSteerable } from "./dispatch-board.js";
import { openFleetOverlay } from "./fleet-overlay.js";
import { openMemoryOverlay } from "./memory-overlay.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import { openAgentsOverlay } from "./overlays/agents.js";
import { openAskUserOverlay } from "./overlays/ask-user.js";
import { openAuthDialog } from "./overlays/auth-dialog.js";
import { contextResetOptions, openContextResetOverlay } from "./overlays/context-reset.js";
import { openCwdFallbackOverlay } from "./overlays/cwd-fallback.js";
import { openExtensionsOverlay } from "./overlays/extensions.js";
import { openHelpOverlay } from "./overlays/help-reference.js";
import { openMessagePickerOverlay } from "./overlays/message-picker.js";
import { openModelOverlay } from "./overlays/model-selector.js";
import { openPromptsOverlay } from "./overlays/prompts.js";
import { extractScopeFromSettings, openScopedOverlay } from "./overlays/scoped-models.js";
import { openSessionOverlay } from "./overlays/session-selector.js";
import { openSettingsOverlay } from "./overlays/settings.js";
import { openSkillsHub } from "./overlays/skills-hub.js";
import {
	openThinkingOverlay,
	readThinkingLevel,
	resolveAvailableThinkingLevels,
	resolveThinkingCapability,
	resolveThinkingLabeler,
} from "./overlays/thinking-selector.js";
import { openTreeOverlay } from "./overlays/tree-selector.js";
import {
	type ApprovalRequestView,
	askAxis,
	createPermissionOverlayBody,
	describeCallTarget,
	PERMISSION_OVERLAY_WIDTH,
	permissionOverlayTitle,
} from "./permission-overlay.js";
import { openProvidersOverlay } from "./providers-overlay.js";
import { openTasksOverlay } from "./tasks-overlay.js";
import { createDefaultArtifactProviders } from "./view/artifacts.js";
import { openViewOverlay } from "./view/view-overlay.js";

export * from "./overlay-key-routing.js";

import type { OverlayState } from "./overlay-key-routing.js";

// Runtime lifecycle construction lives beside the pure modal key router so the
// application composition root no longer owns the mutable overlay state.
export type OverlayLifecycleApplicationDeps = Pick<
	import("./interactive-application.js").InteractiveDeps,
	| "agents"
	| "bus"
	| "cacheDir"
	| "chat"
	| "commitSetting"
	| "dataDir"
	| "dispatch"
	| "getFleetNodes"
	| "getSessionId"
	| "getSettings"
	| "getTaskBoard"
	| "getTaskMemoryStatus"
	| "observability"
	| "onContextClear"
	| "onForkSession"
	| "onResumeSession"
	| "onSelectModel"
	| "onSetScope"
	| "onSetThinkingLevel"
	| "providers"
	| "readSessionEntries"
	| "registerAskUserHandler"
	| "resources"
	| "session"
	| "stateDir"
	| "toolRegistry"
	| "writeSettings"
>;

export interface OverlayLifecycleRuntimeDeps {
	app: OverlayLifecycleApplicationDeps;
	tui: import("../engine/tui.js").TUI;
	footer: import("./footer/dashboard.js").FooterDashboardPanel;
	interactiveTickers: import("./interactive-tickers.js").InteractiveTickers;
	busNoticeSink: Parameters<typeof import("./command-output.js").appendNotice>[2];
	chatRenderer: { applyEvent(event: import("./chat-loop.js").ToolApprovalStateEvent): void };
	notify: (level: import("./providers-overlay.js").TargetsHubNoticeLevel, text: string, key?: string) => void;
	terminal: Pick<import("../engine/tui.js").ProcessTerminal, "columns">;
	dispatchBoard: ReturnType<typeof import("./dispatch-board.js").createDispatchBoardView>;
	getObservabilitySnapshot: () => import("../domains/observability/index.js").ObservabilitySnapshot;
	chatPanel: import("./chat-panel.js").ChatPanel;
	io: import("./slash-commands.js").RunIo;
	readStructuredEntries: (sessionId: string) => import("../domains/session/index.js").SessionEntry[];
	announceTaskMemorySeedOffer: () => void;
	keybindings: ReturnType<typeof import("./keybinding-manager.js").createKeybindingManager>;
	editor: Pick<import("./clio-editor.js").ClioEditor, "getText" | "setText">;
	getSlashContext: () => import("./slash-commands.js").SlashCommandContext;
	showOverlayFrame?: typeof showClioOverlayFrame;
}

export interface OverlayLifecycleController {
	getState(): OverlayState;
	closeOverlay(): void;
	finishAuthOverlay(dismiss: boolean): void;
	openAskUserOverlayState: import("../tools/ask-user.js").AskUserHandler;
	closeAskUserSession(): void;
	isAskUserWaiting(): boolean;
	resetAskUserCancellation(): void;
	refreshSettingsOverlay(): void;
	openProvidersOverlayState(): void;
	openCostOverlayState(): void;
	openContextViewOverlayState(): void;
	openContextResetOverlayState(): void;
	toggleFooterDashboardState(): void;
	openTasksOverlayState(): void;
	openMemoryOverlayState(): void;
	openFleetOverlayState(): void;
	openViewOverlayState(initialFilter?: string): void;
	openThinkingOverlayState(): void;
	openModelOverlayState(): void;
	openScopedModelsOverlayState(): void;
	openSettingsOverlayState(): void;
	openResumeOverlayState(): void;
	openTreeOverlayState(): void;
	openMessagePickerOverlayState(): void;
	openHelpOverlayState(query?: string): void;
	openAgentsOverlayState(): void;
	openSkillsHubState(): void;
	openPromptsOverlayState(): void;
	openExtensionsOverlayState(): void;
	toggleDispatchBoardOverlay(): void;
	confirmPermission(): void;
	cancelAskUser(): void;
	dispose(): void;
}

function shouldAnnouncePermissionRequest(seenRequestIds: Set<string>, requestId: string, maxSize = 2048): boolean {
	if (seenRequestIds.has(requestId)) return false;
	seenRequestIds.add(requestId);
	if (seenRequestIds.size > maxSize) {
		const oldest = seenRequestIds.values().next().value;
		if (oldest !== undefined) seenRequestIds.delete(oldest);
	}
	return true;
}

function isLiveWorkerEscalationRequest(payload: PermissionRequestedPayload): boolean {
	if (typeof payload.requestId !== "string" || payload.escalation !== true) return false;
	const origin = typeof payload.origin === "string" ? payload.origin : undefined;
	const legacyWorkerEvent = origin === undefined && typeof payload.requestedBy === "string";
	if (!(origin?.startsWith("worker:") || legacyWorkerEvent)) return false;
	const runId = typeof payload.requestedBy === "string" ? payload.requestedBy : origin?.slice("worker:".length);
	return typeof runId === "string" && runId.length > 0;
}

function handleCwdFallbackCancel(
	preResumeSessionId: string | null,
	deps: { session: SessionContract; openResumeOverlay: () => void; onWarning: (msg: string) => void },
): void {
	const currentId = deps.session.current()?.id ?? null;
	if (preResumeSessionId && preResumeSessionId !== currentId) {
		try {
			deps.session.switchBranch(preResumeSessionId);
		} catch (err) {
			deps.onWarning(
				`[cwd-fallback] could not restore prior session: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		return;
	}
	deps.openResumeOverlay();
}

export function createOverlayLifecycle(deps: OverlayLifecycleRuntimeDeps): OverlayLifecycleController {
	const {
		tui,
		footer,
		interactiveTickers,
		busNoticeSink,
		chatRenderer,
		notify,
		terminal,
		dispatchBoard,
		chatPanel,
		io,
		readStructuredEntries,
		announceTaskMemorySeedOffer,
		keybindings,
		editor,
		showOverlayFrame = showClioOverlayFrame,
	} = deps;
	let settingsOverlayRefresh: (() => void) | null = null;
	let overlayState: OverlayState = "closed";
	let overlayHandle: OverlayHandle | null = null;
	let authDialogDismiss: (() => void) | null = null;
	let authReturnOverlayHandle: OverlayHandle | null = null;
	let authCloseResolve: (() => void) | null = null;
	let pendingPermission: { call: ClassifierCall; decision: SafetyDecision; meta?: PermissionRequiredMeta } | null = null;
	// A parked worker escalation currently shown in the permission overlay. When
	// set, the overlay's confirm/deny routes to resolveWorkerPermission over the
	// dispatch contract instead of the local tool registry. Additional
	// escalations that arrive while the overlay is busy wait in the queue.
	let pendingWorkerEscalation: { runId: string; requestId: string; agentId: string } | null = null;
	const workerEscalationQueue: Array<{
		runId: string;
		requestId: string;
		agentId: string;
		tool: string;
		actionClass: string;
		axis: ApprovalRequestView["axis"];
		reason: string;
	}> = [];
	const announcedPermissionRequestIds = new Set<string>();
	let permissionConfirmJustFired = false;
	let pendingAskUserCancel: (() => void) | null = null;
	let askUserSession: ReturnType<typeof openAskUserOverlay> | null = null;
	let askUserCancelledForTurn = false;
	let unregisterAskUserHandler: (() => void) | null = null;

	const finishAuthOverlay = (dismiss: boolean): void => {
		if (overlayState !== "auth") return;
		if (dismiss) authDialogDismiss?.();
		authDialogDismiss = null;
		const authHandle = overlayHandle;
		const returnHandle = authReturnOverlayHandle;
		authReturnOverlayHandle = null;
		overlayHandle = returnHandle;
		overlayState = returnHandle ? "providers" : "closed";
		authHandle?.hide();
		const resolveAuthClose = authCloseResolve;
		authCloseResolve = null;
		resolveAuthClose?.();
		footer.refresh();
		interactiveTickers.renderContextIsland();
		interactiveTickers.renderTaskIsland();
		tui.requestRender();
	};

	const closeOverlay = (): void => {
		if (overlayState === "closed") return;
		if (overlayState === "ask-user" && pendingAskUserCancel) {
			pendingAskUserCancel();
			return;
		}
		if (overlayState === "auth") {
			finishAuthOverlay(true);
			return;
		}
		const leaving = overlayState;
		overlayState = "closed";
		interactiveTickers.stopDispatchBoardTicker();
		overlayHandle?.hide();
		overlayHandle = null;
		if (leaving === "permission-confirm") {
			const permission = pendingPermission;
			const confirmed = permissionConfirmJustFired;
			const workerEscalation = pendingWorkerEscalation;
			pendingPermission = null;
			pendingWorkerEscalation = null;
			permissionConfirmJustFired = false;
			if (workerEscalation) {
				// The worker owns the resolution: send the decision down its stdin.
				// It emits clio_permission_resolved, which dispatch republishes on
				// the bus, so no PermissionResolved is emitted here.
				try {
					deps.app.dispatch.resolveWorkerPermission?.(
						workerEscalation.runId,
						workerEscalation.requestId,
						confirmed ? "approve" : "deny",
					);
				} catch (err) {
					appendNotice(
						"warn",
						`Could not deliver permission decision to run ${workerEscalation.runId}: ${err instanceof Error ? err.message : String(err)}`,
						busNoticeSink,
					);
				}
			} else if (confirmed && permission) {
				deps.app.bus.emit(BusChannels.PermissionResolved, {
					status: "granted",
					...(permission.meta ? { requestId: permission.meta.requestId } : {}),
					origin: "main",
					decidedBy: "operator",
					tool: permission.call.tool,
					actionClass: permission.decision.classification.actionClass,
					requestedBy: "tool",
					at: Date.now(),
				});
				// The grant covers exactly this parked call: flip its segment back to
				// the running style before the body executes so the approval gap
				// never renders as lingering "awaiting approval" on live work.
				if (permission.meta?.toolCallId !== undefined) {
					chatRenderer.applyEvent({
						type: "tool_approval_state",
						toolCallId: permission.meta.toolCallId,
						state: "resumed",
					});
				}
				void deps.app.toolRegistry?.resumeParkedCalls({
					actionClass: permission.decision.classification.actionClass,
					...(permission.meta ? { requestId: permission.meta.requestId } : {}),
					requestedBy: "tool:one_shot",
				});
			} else {
				const cancellationReason =
					"User cancelled this tool call from the permission confirmation prompt. Do not retry the same target via another tool. Wait for new instruction.";
				deps.app.bus.emit(BusChannels.PermissionResolved, {
					status: "denied",
					...(permission?.meta ? { requestId: permission.meta.requestId } : {}),
					origin: "main",
					decidedBy: "operator",
					...(permission ? { tool: permission.call.tool } : {}),
					...(permission ? { actionClass: permission.decision.classification.actionClass } : {}),
					reason: "operator cancelled",
					requestedBy: "tool",
					at: Date.now(),
				});
				if (permission?.meta) deps.app.toolRegistry?.cancelParkedCall(permission.meta.requestId, cancellationReason);
				else deps.app.toolRegistry?.cancelParkedCalls(cancellationReason);
			}
		}
		// A worker escalation that arrived while the overlay was busy waits its turn.
		maybeOpenWorkerEscalation();
		if (overlayState === "closed" && deps.app.toolRegistry?.hasParkedCalls()) {
			deps.app.toolRegistry.renotifyHead();
		}
		interactiveTickers.renderContextIsland();
		interactiveTickers.renderTaskIsland();
		tui.requestRender();
	};

	const maybeOpenExternalUrl = (url: string): void => {
		const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
		exec(`${opener} "${url.replace(/"/g, '\\"')}"`, () => {
			// Best effort only.
		});
	};

	const resolveConnectionReference = (target: string) => {
		const settings = deps.app.getSettings?.();
		if (!settings) return null;
		return resolveProviderReference(
			target,
			settings,
			(runtimeId) => deps.app.providers.getRuntime(runtimeId) ?? getRuntimeRegistry().get(runtimeId),
		);
	};

	const openConnectFlowState = async (reference: string): Promise<void> => {
		if (overlayState !== "closed" && overlayState !== "providers") return;
		const returnHandle = overlayState === "providers" ? overlayHandle : null;
		const resolved = resolveConnectionReference(reference);
		if (!resolved?.target) {
			notify("warning", `connect: unknown target ${reference}. Add it with clio targets add.`, `connect:${reference}`);
			return;
		}
		const target = resolved.target;
		const runtime = resolved.runtime;
		const authTarget = resolved.authTarget;
		const targetId = target.id;
		const runtimeId = runtime.id;
		await new Promise<void>((resolveAuthFlow) => {
			const dialog = openAuthDialog(tui, `Connect ${targetId}`, () => closeOverlay());
			authReturnOverlayHandle = returnHandle;
			authCloseResolve = resolveAuthFlow;
			overlayState = "auth";
			overlayHandle = dialog.handle;

			const probeTarget = async (): Promise<void> => {
				dialog.controller.setLines([`Target: ${targetId}`, `Runtime: ${runtimeId}`, "Checking target..."]);
				const status = await deps.app.providers.probeTarget(targetId);
				if (!status) {
					dialog.controller.setLines([`Target: ${targetId}`, "Target check failed: target is not configured."]);
					notify("error", `connect: ${targetId} is not configured`, `connect:${targetId}`);
					return;
				}
				const health = status.health.status;
				const detail =
					status.reason ||
					status.health.lastError ||
					(status.health.latencyMs !== null ? `${status.health.latencyMs}ms` : "no details");
				dialog.controller.setLines([
					`Target: ${targetId}`,
					`Runtime: ${runtimeId}`,
					status.available ? `Target ready (${health})` : `Target check failed (${health})`,
					detail,
				]);
				notify(
					status.available ? "info" : "warning",
					status.available ? `connected ${targetId} (${health})` : `connect ${targetId} failed (${health})`,
					`connect:${targetId}`,
				);
				footer.refresh();
				tui.requestRender();
			};

			const selectOAuthOption = async (
				prompt: OAuthSelectPrompt,
				prefix: ReadonlyArray<string>,
			): Promise<string | undefined> => {
				const defaultId = prompt.options[0]?.id;
				if (!defaultId) return undefined;
				const ids = new Set(prompt.options.map((option) => option.id));
				const baseLines = [
					...prefix,
					prompt.message,
					...prompt.options.map((option, index) => {
						const marker = option.id === defaultId ? "*" : " ";
						return `${marker} ${String(index + 1).padStart(2)}. ${option.label} (${option.id})`;
					}),
				];
				let errorLine: string | null = null;
				for (;;) {
					dialog.controller.setLines(errorLine ? [...baseLines, errorLine] : baseLines);
					const answer = (await dialog.controller.prompt(`Selection (number or id, q to cancel) [${defaultId}]`)).trim();
					if (answer.length === 0) return defaultId;
					if (answer === "q" || answer === "quit" || answer === "cancel") return undefined;
					const numeric = Number(answer);
					if (Number.isInteger(numeric) && numeric >= 1 && numeric <= prompt.options.length) {
						return prompt.options[numeric - 1]?.id;
					}
					if (ids.has(answer)) return answer;
					errorLine = `Unknown selection: ${answer}`;
				}
			};

			const requiresManagedAuth = targetRequiresAuth(target, runtime);
			const authStatus = deps.app.providers.auth.statusForTarget(target, runtime);
			if (!requiresManagedAuth || authStatus.available) {
				void (async () => {
					try {
						await probeTarget();
					} catch (error) {
						dialog.controller.setLines([
							`Target: ${targetId}`,
							`Target check failed: ${error instanceof Error ? error.message : String(error)}`,
						]);
						tui.requestRender();
					} finally {
						finishAuthOverlay(false);
					}
				})();
				tui.requestRender();
				return;
			}
			if (resolved.runtime.auth === "api-key") {
				authDialogDismiss = dialog.controller.dismiss;
				dialog.controller.setLines([
					`Target: ${targetId}`,
					`Runtime: ${runtime.id}`,
					"API key required before Clio can connect to this target.",
				]);
				void (async () => {
					try {
						const apiKey = (await dialog.controller.prompt("API key")).trim();
						if (apiKey.length === 0) throw new Error("empty API key");
						deps.app.providers.auth.setApiKey(authTarget.providerId, apiKey);
						authDialogDismiss = null;
						await probeTarget();
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (message !== "dismissed" && message !== "cancelled") {
							notify("error", `connect ${targetId}: ${message}`, `connect:${targetId}`);
						}
					} finally {
						authDialogDismiss = null;
						finishAuthOverlay(false);
					}
				})();
				tui.requestRender();
				return;
			}
			authDialogDismiss = dialog.controller.dismiss;
			dialog.controller.setLines([`Target: ${targetId}`, `Runtime: ${runtime.id}`, "Starting authorization flow..."]);
			void (async () => {
				let manualCodeTimer: NodeJS.Timeout | null = null;
				try {
					await deps.app.providers.auth.login(authTarget.providerId, {
						onAuth: ({ url, instructions }) => {
							dialog.controller.setLines(
								[
									`Open: ${url}`,
									instructions ?? "Complete sign-in in your browser.",
									"Waiting for the browser callback. A manual code prompt will appear if needed.",
								].filter(Boolean),
							);
							maybeOpenExternalUrl(url);
						},
						onDeviceCode: ({ verificationUri, userCode }) => {
							dialog.controller.setLines([
								`Open: ${verificationUri}`,
								`Enter code: ${userCode}`,
								"Waiting for authentication...",
							]);
							maybeOpenExternalUrl(verificationUri);
						},
						onPrompt: async (prompt) => (await dialog.controller.prompt(prompt.message)).trim(),
						onSelect: (prompt) => selectOAuthOption(prompt, [`Target: ${targetId}`, `Runtime: ${runtime.id}`]),
						onManualCodeInput: async () =>
							await new Promise<string>((resolve, reject) => {
								manualCodeTimer = setTimeout(() => {
									manualCodeTimer = null;
									dialog.controller
										.prompt("Verification code")
										.then((value) => resolve(value.trim()))
										.catch(reject);
								}, 10_000);
								manualCodeTimer.unref?.();
							}),
						onProgress: (message) => {
							dialog.controller.appendLine(message);
						},
					});
					authDialogDismiss = null;
					await probeTarget();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message !== "dismissed" && message !== "cancelled") {
						notify("error", `connect ${targetId}: ${message}`, `connect:${targetId}`);
					}
				} finally {
					if (manualCodeTimer) {
						clearTimeout(manualCodeTimer);
					}
					authDialogDismiss = null;
					finishAuthOverlay(false);
				}
			})();
			tui.requestRender();
		});
	};

	const currentAutonomy = (): string => deps.app.getSettings?.().autonomy ?? "auto-edit";

	const axisViewFromId = (axisId: string | undefined, fallbackLevel: string): ApprovalRequestView["axis"] | null => {
		if (axisId?.startsWith("net:")) {
			const ruleId = axisId.slice("net:".length);
			return { kind: "net", ruleId: ruleId.length > 0 ? ruleId : "unknown" };
		}
		if (axisId?.startsWith("autonomy:")) {
			const level = axisId.slice("autonomy:".length);
			return { kind: "autonomy", level: level.length > 0 ? level : fallbackLevel };
		}
		return null;
	};

	const mainApprovalRequestView = (
		call: ClassifierCall,
		decision: SafetyDecision,
		meta: PermissionRequiredMeta | undefined,
		autonomy: string,
	): ApprovalRequestView => {
		const axisFromMeta = axisViewFromId(meta?.axis, autonomy);
		const axisFromDecision = askAxis(decision);
		const axis =
			axisFromMeta ??
			(axisFromDecision.kind === "net"
				? { kind: "net" as const, ruleId: axisFromDecision.ruleId }
				: { kind: "autonomy" as const, level: autonomy });
		const queueDepth = deps.app.toolRegistry?.parkedCount();
		const target = describeCallTarget(call.args);
		return {
			requestId: meta?.requestId ?? "permission-pending",
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			axis,
			origin: { kind: "main" },
			reason:
				decision.kind === "ask" ? decision.rejection.short : `${call.tool} requests ${decision.classification.actionClass}`,
			...(call.tool === ToolNames.Dispatch && decision.kind === "ask"
				? { artifact: { kind: "dispatch-plan" as const, text: decision.rejection.detail } }
				: {}),
			...(target.length > 0 ? { target } : {}),
			...(queueDepth !== undefined && queueDepth > 1 ? { queueDepth } : {}),
		};
	};

	const openPermissionOverlay = (
		call: ClassifierCall,
		decision: SafetyDecision,
		meta?: PermissionRequiredMeta,
	): void => {
		if (overlayState !== "closed") return;
		pendingPermission = { call, decision, ...(meta ? { meta } : {}) };
		permissionConfirmJustFired = false;
		overlayState = "permission-confirm";
		overlayHandle = showOverlayFrame(
			tui,
			createPermissionOverlayBody(mainApprovalRequestView(call, decision, meta, currentAutonomy())),
			{
				anchor: "center",
				width: PERMISSION_OVERLAY_WIDTH,
				title: permissionOverlayTitle(),
				footerHint: buildHint("commit", [{ key: "Enter", verb: "allow once" }]),
			},
		);
		tui.requestRender();
	};

	const unsubscribePermissionRequired =
		deps.app.toolRegistry?.onPermissionRequired((call, decision, meta) => {
			// Re-notifies reopen overlays, but the transcript names each request
			// once so tail wakeups do not print duplicate approval notices.
			if (shouldAnnouncePermissionRequest(announcedPermissionRequestIds, meta.requestId)) {
				const parkedNotice = approvalParkedNotice(call.tool, decision, currentAutonomy());
				appendNotice(parkedNotice.level, parkedNotice.text, busNoticeSink);
			}
			// Restyle the parked call's transcript segment: pi already emitted its
			// tool_execution_start, so without this the segment counts as running
			// while the body sits at the gate. Idempotent under renotifyHead.
			if (meta.toolCallId !== undefined) {
				chatRenderer.applyEvent({ type: "tool_approval_state", toolCallId: meta.toolCallId, state: "awaiting-approval" });
			}
			openPermissionOverlay(call, decision, meta);
		}) ?? (() => {});

	const openWorkerPermissionOverlay = (entry: {
		runId: string;
		requestId: string;
		agentId: string;
		tool: string;
		actionClass: string;
		axis: ApprovalRequestView["axis"];
		reason: string;
		target?: string;
	}): void => {
		if (overlayState !== "closed") return;
		pendingWorkerEscalation = { runId: entry.runId, requestId: entry.requestId, agentId: entry.agentId };
		pendingPermission = null;
		permissionConfirmJustFired = false;
		overlayState = "permission-confirm";
		overlayHandle = showOverlayFrame(
			tui,
			createPermissionOverlayBody({
				requestId: entry.requestId,
				tool: entry.tool,
				actionClass: entry.actionClass,
				axis: entry.axis,
				origin: { kind: "worker", agentId: entry.agentId, runId: entry.runId },
				reason: entry.reason,
				...(entry.target !== undefined && entry.target.length > 0 ? { target: entry.target } : {}),
			}),
			{
				anchor: "center",
				width: PERMISSION_OVERLAY_WIDTH,
				title: permissionOverlayTitle(),
				footerHint: buildHint("commit", [{ key: "Enter", verb: "allow once" }]),
			},
		);
		tui.requestRender();
	};

	const maybeOpenWorkerEscalation = (): void => {
		if (overlayState !== "closed") return;
		const next = workerEscalationQueue.shift();
		if (next) openWorkerPermissionOverlay(next);
	};

	// Worker permission escalations arrive as PermissionRequested bus events
	// carrying a run id in requestedBy. Main-agent asks (no requestId) are driven
	// by the tool registry above and are ignored here. Headless sessions have no
	// subscriber, so the worker's timeout fallback governs there.
	const unsubscribeWorkerEscalation = deps.app.bus.on(BusChannels.PermissionRequested, (payload) => {
		if (!isLiveWorkerEscalationRequest(payload)) return;
		const requestId = payload.requestId;
		if (typeof requestId !== "string") return;
		const origin = typeof payload.origin === "string" ? payload.origin : undefined;
		const legacyWorkerEvent = origin === undefined && typeof payload.requestedBy === "string";
		if (!(origin?.startsWith("worker:") || legacyWorkerEvent)) return;
		const runId = typeof payload.requestedBy === "string" ? payload.requestedBy : origin?.slice("worker:".length);
		if (!runId) return;
		const entry = {
			runId,
			requestId,
			agentId: typeof payload.agentId === "string" ? payload.agentId : "worker",
			tool: typeof payload.tool === "string" ? payload.tool : "unknown",
			actionClass: typeof payload.actionClass === "string" ? payload.actionClass : "unknown",
			axis:
				axisViewFromId(typeof payload.axis === "string" ? payload.axis : undefined, currentAutonomy()) ??
				(typeof payload.ruleId === "string"
					? { kind: "net" as const, ruleId: payload.ruleId }
					: { kind: "autonomy" as const, level: currentAutonomy() }),
			reason:
				payload.rejection?.short ??
				(typeof payload.summary === "string" ? payload.summary : `${payload.tool ?? "worker"} requires approval`),
			// The preview crossed the worker's stdout, an untrusted seam, so it is
			// re-sanitized here before it can style the overlay that approves it.
			...(typeof payload.target === "string" && payload.target.length > 0
				? { target: sanitizeCallTargetText(payload.target).slice(0, 200) }
				: {}),
		};
		const notice = workerEscalationNotice(payload);
		if (notice !== null) appendNotice(notice.level, notice.text, busNoticeSink);
		workerEscalationQueue.push(entry);
		maybeOpenWorkerEscalation();
	});

	// Autonomy auto-denials (read-only) never park, so without this notice the
	// only trace is the rejection in the transcript, which reads like a model
	// error rather than the dial doing its job.
	const unsubscribeAutonomyDenied =
		deps.app.toolRegistry?.onAutonomyDenied((_call, decision, level) => {
			const notice = autonomyDeniedNotice(decision, level);
			appendNotice(notice.level, notice.text, busNoticeSink);
			tui.requestRender();
		}) ?? (() => {});

	const closeAskUserSession = (): void => {
		pendingAskUserCancel = null;
		const session = askUserSession;
		askUserSession = null;
		if (session) {
			session.close();
			if (overlayHandle === session) overlayHandle = null;
		} else if (overlayState === "ask-user") {
			overlayHandle?.hide();
			overlayHandle = null;
		}
		if (overlayState === "ask-user") overlayState = "closed";
		interactiveTickers.renderContextIsland();
		interactiveTickers.renderTaskIsland();
		tui.requestRender();
	};

	const ensureAskUserSession = (): ReturnType<typeof openAskUserOverlay> | null => {
		if (overlayState !== "closed" && overlayState !== "ask-user") return null;
		if (askUserSession) return askUserSession;
		overlayState = "ask-user";
		askUserSession = openAskUserOverlay(tui, {
			onCancel: () => {
				pendingAskUserCancel?.();
			},
		});
		overlayHandle = askUserSession;
		tui.requestRender();
		return askUserSession;
	};

	const cancelAskUserSession = (): void => {
		askUserCancelledForTurn = true;
		const session = askUserSession;
		session?.cancel();
		closeAskUserSession();
	};

	const openAskUserOverlayState: AskUserHandler = async (questions, invokeOptions) => {
		const toolBacked = Boolean(invokeOptions?.turnId || invokeOptions?.toolCallId);
		if (toolBacked && askUserCancelledForTurn) return cancelledAskUserResult();
		const session = ensureAskUserSession();
		if (!session) return cancelledAskUserResult();
		pendingAskUserCancel = cancelAskUserSession;
		const result = await session.ask(questions);
		if (result.cancelled === true || !toolBacked) {
			if (result.cancelled === true) askUserCancelledForTurn = true;
			closeAskUserSession();
		} else {
			interactiveTickers.renderContextIsland();
			interactiveTickers.renderTaskIsland();
			tui.requestRender();
		}
		return result;
	};
	unregisterAskUserHandler = deps.app.registerAskUserHandler?.(openAskUserOverlayState) ?? null;

	const openProvidersOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "providers";
		overlayHandle = openProvidersOverlay(tui, deps.app.providers, {
			bus: deps.app.bus,
			...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
			...(deps.app.writeSettings
				? {
						writeSettings: (next) => {
							deps.app.writeSettings?.(next);
							footer.refresh();
						},
					}
				: {}),
			connectTarget: (targetId) => openConnectFlowState(targetId),
			notice: notify,
		});
		tui.requestRender();
	};

	const openCostOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "cost";
		overlayHandle = openCostOverlay(tui, deps.app.observability, {
			sessionId: deps.app.getSessionId?.() ?? null,
		});
		tui.requestRender();
	};

	const openContextViewOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "context-view";
		overlayHandle = openContextOverlay(tui, () => deps.app.chat.contextLedger(), {
			bus: deps.app.bus,
			chat: deps.app.chat,
		});
		tui.requestRender();
	};

	const openContextResetOverlayState = (): void => {
		if (overlayState !== "closed" || !deps.app.onContextClear) return;
		overlayState = "context-reset";
		overlayHandle = openContextResetOverlay(tui, {
			onReset: (choice) => {
				closeOverlay();
				const onContextClear = deps.app.onContextClear;
				if (!onContextClear) return;
				void Promise.resolve()
					.then(() => onContextClear(contextResetOptions(choice)))
					.catch((err) => {
						const msg = err instanceof Error ? err.message : String(err);
						io.stderr(`[/context reset] ${msg}\n`);
					})
					.finally(() => {
						footer.refresh();
						tui.requestRender();
					});
			},
			onCancel: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const toggleFooterDashboardState = (): void => {
		if (overlayState !== "closed") return;
		footer.toggleExpanded();
		interactiveTickers.renderTaskIsland();
		tui.requestRender();
	};

	const openTasksOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "tasks";
		overlayHandle = openTasksOverlay(tui, () => deps.app.getTaskBoard?.() ?? null, {
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openMemoryOverlayState = (): void => {
		if (overlayState !== "closed" || !deps.app.getTaskMemoryStatus) return;
		let records: MemoryRecord[] = [];
		try {
			records = loadMemoryRecordsSync(deps.app.dataDir);
		} catch (error) {
			notify(
				"warning",
				`memory: durable lessons unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"memory:durable-read",
			);
		}
		overlayState = "memory";
		overlayHandle = openMemoryOverlay(tui, deps.app.getTaskMemoryStatus, () => records, {
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openFleetOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "fleet";
		overlayHandle = openFleetOverlay(tui, deps.app.dispatch, {
			bus: deps.app.bus,
			providers: deps.app.providers,
			getObservability: () => deps.getObservabilitySnapshot(),
			...(deps.app.agents ? { agents: deps.app.agents } : {}),
			...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
			...(deps.app.getFleetNodes ? { getFleetNodes: deps.app.getFleetNodes } : {}),
			...(deps.app.writeSettings
				? {
						writeSettings: (next) => {
							deps.app.writeSettings?.(next);
							footer.refresh();
						},
					}
				: {}),
			notice: notify,
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openViewOverlayState = (initialFilter?: string): void => {
		if (overlayState !== "closed") return;
		overlayState = "view";
		const sessionMeta = deps.app.session?.current() ?? null;
		overlayHandle = openViewOverlay(tui, {
			providers: createDefaultArtifactProviders({
				stateDir: deps.app.stateDir,
				dataDir: deps.app.dataDir,
				dispatch: deps.app.dispatch,
				sessionMeta,
				readSessionEntries: deps.app.readSessionEntries,
			}),
			...(initialFilter ? { initialFilter } : {}),
			notice: (level, text, key) => notify(level, text, key),
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openThinkingOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "thinking";
		const settings = deps.app.getSettings?.();
		const current = settings
			? (resolveThinkingCapability(deps.app.providers, settings)?.effectiveLevel ?? readThinkingLevel(settings))
			: "off";
		const available = settings
			? resolveAvailableThinkingLevels(deps.app.providers, settings)
			: (["off"] as ThinkingLevel[]);
		const thinkingOverlayDeps: Parameters<typeof openThinkingOverlay>[1] = {
			current,
			available,
			onSelect: (next) => {
				deps.app.onSetThinkingLevel?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
			...(settings ? { labelFor: resolveThinkingLabeler(deps.app.providers, settings) } : {}),
		};
		overlayHandle = openThinkingOverlay(tui, thinkingOverlayDeps);
		tui.requestRender();
	};

	const openModelOverlayState = (): void => {
		if (overlayState !== "closed") return;
		const settings = deps.app.getSettings?.();
		if (!settings) return;
		overlayState = "model";
		overlayHandle = openModelOverlay(tui, {
			settings,
			...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
			providers: deps.app.providers,
			bus: deps.app.bus,
			onSelect: (ref) => {
				deps.app.onSelectModel?.(ref);
				footer.refresh();
			},
			onToggleFavorite: (ref, favorite) => {
				if (!deps.app.getSettings || !deps.app.writeSettings) return;
				const next = structuredClone(deps.app.getSettings()) as ClioSettings;
				const value = `${ref.target}/${ref.model}`;
				const current = new Set(next.modelSelector?.favorites ?? []);
				if (favorite) current.add(value);
				else current.delete(value);
				next.modelSelector = {
					...(next.modelSelector ?? { recentLimit: 12, favorites: [] }),
					favorites: [...current],
				};
				deps.app.writeSettings(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openScopedModelsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		const settings = deps.app.getSettings?.();
		if (!settings) return;
		overlayState = "scoped-models";
		overlayHandle = openScopedOverlay(tui, {
			providers: deps.app.providers,
			currentScope: extractScopeFromSettings(settings),
			onCommit: (next) => {
				deps.app.onSetScope?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openSettingsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.getSettings || !deps.app.writeSettings) return;
		overlayState = "settings";
		const getSettings = deps.app.getSettings;
		const writeSettingsOut = deps.app.writeSettings;
		const commitSettingOut = deps.app.commitSetting;
		const handle = openSettingsOverlay(tui, {
			getSettings,
			providers: deps.app.providers,
			writeSettings: (next) => {
				writeSettingsOut(next);
				footer.refresh();
			},
			...(commitSettingOut
				? {
						commitSetting: (id, next, scope) => {
							commitSettingOut(id, next, scope);
							footer.refresh();
						},
					}
				: {}),
			notice: notify,
			onClose: () => {
				settingsOverlayRefresh = null;
				closeOverlay();
			},
		});
		overlayHandle = handle;
		settingsOverlayRefresh = handle.refreshRows;
		void (async () => {
			try {
				await deps.app.providers.probeAllLive();
				if (overlayState === "settings") settingsOverlayRefresh?.();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				notify("warning", `settings model refresh failed: ${msg}`, "settings:model-refresh");
			}
		})();
		tui.requestRender();
	};

	const openResumeOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.session) {
			emitCommandNotice(deps.getSlashContext().notice, "error", "resume", "session contract unavailable");
			return;
		}
		const sessionContract = deps.app.session;
		const preResumeSessionId = sessionContract.current()?.id ?? null;
		overlayState = "resume";
		overlayHandle = openSessionOverlay(tui, {
			session: sessionContract,
			onResume: (sessionId) => {
				deps.app.onResumeSession?.(sessionId);
				// Replay the resumed session's on-disk turns into the chat
				// panel so the user sees their prior transcript, and reset
				// chat-loop's lastTurnId + agent.state.messages so the next
				// submit parents onto the resumed leaf rather than inheriting
				// whatever state the previous session left behind. Row 51
				// regression fix.
				try {
					const turns = readStructuredEntries(sessionId);
					chatPanel.reset();
					rehydrateChatPanelFromTurns(chatPanel, turns);
					const replayMessages = buildReplayAgentMessagesFromTurns(turns);
					const leafTurnId = sessionContract.tree(sessionId).leafId;
					deps.app.chat.resetForSession(leafTurnId, replayMessages);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/resume] transcript replay failed: ${msg}\n`);
				}
				if (sessionContract.current()?.id === sessionId && sessionId !== preResumeSessionId) {
					announceTaskMemorySeedOffer();
				}
				footer.refresh();
				tui.requestRender();
			},
			onClose: () => {
				closeOverlay();
				// Post-close cwd check: if /resume landed on a session whose
				// recorded cwd is no longer valid, pop the cwd-fallback
				// overlay so the user can either continue in the terminal's
				// cwd or cancel back to the prior session. Queued as a
				// microtask so the resume overlay state machine fully
				// settles before the next overlay opens.
				queueMicrotask(() => {
					const current = sessionContract.current();
					if (!current) return;
					if (current.id === preResumeSessionId) return;
					const probe = resolveSessionCwd(current);
					if (probe.ok) return;
					openCwdFallbackOverlayState({
						sessionCwd: typeof current.cwd === "string" ? current.cwd : "",
						reason: probe.reason,
						preResumeSessionId,
					});
				});
			},
		});
		tui.requestRender();
	};

	const openTreeOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.session) {
			notify("error", "tree unavailable: session contract is not wired", "tree:unavailable");
			return;
		}
		const sessionContract = deps.app.session;
		overlayState = "tree";
		overlayHandle = openTreeOverlay(tui, {
			session: sessionContract,
			onSwitchTurn: (turnId) => {
				try {
					sessionContract.switchTurn(turnId);
					const sessionId = sessionContract.current()?.id ?? null;
					if (!sessionId) throw new Error("no current session after turn switch");
					const turns = readStructuredEntries(sessionId);
					chatPanel.reset();
					rehydrateChatPanelFromTurns(chatPanel, turns, { uptoTurnId: turnId });
					const replayMessages = buildReplayAgentMessagesFromTurns(turns, { uptoTurnId: turnId });
					deps.app.chat.resetForSession(turnId, replayMessages);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					notify("error", `tree switch failed: ${msg}`, "tree:switch-failed");
				}
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openMessagePickerOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.session) {
			emitCommandNotice(deps.getSlashContext().notice, "error", "fork", "session contract unavailable");
			return;
		}
		const sessionContract = deps.app.session;
		// No-op notice when there is no current session so the user can tell
		// the overlay is intentionally inert rather than broken.
		if (sessionContract.current() === null) {
			emitCommandNotice(
				deps.getSlashContext().notice,
				"warn",
				"fork",
				"no current session to fork from; start one with /new or /resume first",
			);
			return;
		}
		overlayState = "message-picker";
		overlayHandle = openMessagePickerOverlay(tui, {
			session: sessionContract,
			onFork: (parentTurnId) => {
				try {
					if (deps.app.onForkSession) {
						deps.app.onForkSession(parentTurnId);
					} else {
						sessionContract.fork(parentTurnId);
					}
					chatPanel.reset();
					const forkedSessionId = sessionContract.current()?.id ?? null;
					if (forkedSessionId) {
						try {
							const forkedTurns = readStructuredEntries(forkedSessionId);
							rehydrateChatPanelFromTurns(chatPanel, forkedTurns);
							const replayMessages = buildReplayAgentMessagesFromTurns(forkedTurns);
							const leafTurnId = sessionContract.tree(forkedSessionId).leafId ?? parentTurnId;
							deps.app.chat.resetForSession(leafTurnId, replayMessages);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							io.stderr(`[/fork] transcript replay failed: ${msg}\n`);
							deps.app.chat.resetForSession(null);
						}
					}
					if (!forkedSessionId) deps.app.chat.resetForSession(null);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/fork] fork failed: ${msg}\n`);
				}
				footer.refresh();
				tui.requestRender();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	/**
	 * Pop the cwd-fallback overlay after /resume landed on a session whose
	 * recorded cwd no longer exists on disk (see src/domains/session/
	 * cwd-fallback.ts for the reasons). Continue silently accepts the
	 * broken-cwd session. Downstream file ops will surface real errors.
	 * Cancel restores the prior session when one existed, or re-opens the
	 * /resume picker so the user can select a different session.
	 */
	const openCwdFallbackOverlayState = (args: {
		sessionCwd: string;
		reason: "no-cwd" | "missing" | "not-a-directory";
		preResumeSessionId: string | null;
	}): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.session) return;
		const sessionContract = deps.app.session;
		overlayState = "cwd-fallback";
		overlayHandle = openCwdFallbackOverlay(tui, {
			sessionCwd: args.sessionCwd,
			currentCwd: process.cwd(),
			reason: args.reason,
			onContinue: () => {
				// Accept the broken-cwd session. First fs access will surface a
				// real error; no extra bookkeeping here. The user chose this
				// explicitly, so leave meta.cwd untouched.
				footer.refresh();
			},
			onCancel: () => {
				handleCwdFallbackCancel(args.preResumeSessionId, {
					session: sessionContract,
					// queueMicrotask defers past the current overlay's close so the
					// resume overlay opens cleanly on a quiesced overlay stack.
					openResumeOverlay: () => queueMicrotask(() => openResumeOverlayState()),
					onWarning: (msg) => io.stderr(msg),
				});
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openHelpOverlayState = (query?: string): void => {
		if (overlayState !== "closed") return;
		overlayState = "help";
		overlayHandle = openHelpOverlay(tui, keybindings, () => closeOverlay(), query);
		tui.requestRender();
	};

	const openAgentsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "agents";
		overlayHandle = openAgentsOverlay(tui, deps.getSlashContext(), () => closeOverlay());
		tui.requestRender();
	};

	const openSkillsHubState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "skills-hub";
		overlayHandle = openSkillsHub(tui, {
			listSkills: () => deps.app.resources?.skills(process.cwd()) ?? { items: [], diagnostics: [] },
			cacheDir: deps.app.cacheDir,
			setEditorText: (text) => {
				editor.setText(text);
				tui.requestRender();
			},
			notice: (level, text) => deps.getSlashContext().notice(level, text),
			installSkill: async (name) => {
				const result = installSkill({ source: name, scope: "project" });
				return { name: result.name, path: result.path, warnings: result.warnings };
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openPromptsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "prompts";
		overlayHandle = openPromptsOverlay(tui, deps.getSlashContext(), () => closeOverlay());
		tui.requestRender();
	};

	const openExtensionsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "extensions";
		overlayHandle = openExtensionsOverlay(tui, deps.getSlashContext(), () => closeOverlay());
		tui.requestRender();
	};

	const toggleDispatchBoardOverlay = (): void => {
		if (overlayState === "dispatch-board") {
			closeOverlay();
			return;
		}
		if (overlayState !== "closed") return;
		overlayState = "dispatch-board";
		dispatchBoard.resetSelection();
		// Size to the terminal at open: near-full width on narrow screens, capped
		// at 96 columns so ultrawide terminals keep readable cards. pi clamps the
		// overlay if the terminal shrinks and the live board re-renders to fit.
		overlayHandle = showOverlayFrame(tui, dispatchBoard, {
			title: "Fleet Runs",
			footerHint: () => {
				const row = dispatchBoard.selectedRow();
				const entries = [{ key: "↑↓", verb: "select" }];
				if (row && isDispatchBoardRowSteerable(row)) {
					entries.push({ key: "s", verb: "steer" });
				}
				if (row && isDispatchBoardRowCancellable(row)) {
					entries.push({ key: "x", verb: "cancel" });
				}
				return buildHint("browse", entries);
			},
			anchor: "center",
			width: Math.max(44, Math.min(96, terminal.columns - 4)),
		});
		interactiveTickers.startDispatchBoardTicker();
		tui.requestRender();
	};

	return {
		getState: () => overlayState,
		closeOverlay,
		finishAuthOverlay,
		openAskUserOverlayState,
		closeAskUserSession,
		isAskUserWaiting: () => askUserSession?.isWaiting() ?? false,
		resetAskUserCancellation: () => {
			askUserCancelledForTurn = false;
		},
		refreshSettingsOverlay: () => settingsOverlayRefresh?.(),
		openProvidersOverlayState,
		openCostOverlayState,
		openContextViewOverlayState,
		openContextResetOverlayState,
		toggleFooterDashboardState,
		openTasksOverlayState,
		openMemoryOverlayState,
		openFleetOverlayState,
		openViewOverlayState,
		openThinkingOverlayState,
		openModelOverlayState,
		openScopedModelsOverlayState,
		openSettingsOverlayState,
		openResumeOverlayState,
		openTreeOverlayState,
		openMessagePickerOverlayState,
		openHelpOverlayState,
		openAgentsOverlayState,
		openSkillsHubState,
		openPromptsOverlayState,
		openExtensionsOverlayState,
		toggleDispatchBoardOverlay,
		confirmPermission: () => {
			permissionConfirmJustFired = true;
			closeOverlay();
			footer.refresh();
			tui.requestRender();
		},
		cancelAskUser: () => pendingAskUserCancel?.(),
		dispose: () => {
			unsubscribePermissionRequired();
			unsubscribeWorkerEscalation();
			unsubscribeAutonomyDenied();
			unregisterAskUserHandler?.();
			unregisterAskUserHandler = null;
			pendingAskUserCancel?.();
		},
	};
}
