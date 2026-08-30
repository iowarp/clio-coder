import { randomBytes } from "node:crypto";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/index.js";
import { agentRoleFactsResolver, executeFleetRun, requestExecutionRole } from "../domains/dispatch/index.js";
import {
	canonicalMemoryRepositoryIdentity,
	loadMemoryRecordsSync,
	type MemoryRecord,
	proposeMemoryPromotion,
} from "../domains/memory/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import { foregroundStreamUsage } from "../domains/providers/index.js";
import type { ContextLedger } from "../domains/session/context-ledger.js";
import type { SessionMeta } from "../domains/session/index.js";
import { foldSessionArtifacts } from "../domains/session/session-artifacts.js";
import { foldSessionTaskHistory } from "../domains/session/task-board.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { UserTasksStore } from "../domains/user-tasks/store.js";
import type { TUI } from "../engine/tui.js";
import { type OpenContextOverlayOptions, openContextOverlay } from "./context-overlay.js";
import { openCostOverlay } from "./cost-overlay.js";
import {
	type createDispatchBoardView,
	isDispatchBoardRowCancellable,
	isDispatchBoardRowSteerable,
} from "./dispatch-board.js";
import { compileFleetRunPreview, type FleetRunPreview, type FleetRunPreviewInput } from "./fleet-run-preview.js";
import { openMemoryOverlay } from "./memory-overlay.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import {
	type ContextResetMutationChoice,
	contextResetOptions,
	openContextResetOverlay,
} from "./overlays/context-reset.js";
import { formatDecisionCorrectionTurn, openDecisionsOverlay } from "./overlays/decisions.js";
import { openFleetRunApprovalOverlay } from "./overlays/fleet-run-approval.js";
import { openSideQuestionOverlay } from "./overlays/side-question.js";
import { type ContextClearCommandOptions, formatUserTaskHandoff } from "./slash-commands.js";
import { openTasksOverlay } from "./tasks-overlay.js";
import { type ArtifactProviderDeps, createDefaultArtifactProviders } from "./view/artifacts.js";
import { openViewOverlay } from "./view/view-overlay.js";

export interface OverlayGeneralOpenersDeps {
	tui: TUI;
	transitions: OverlayTransitions;
	observability: ObservabilityContract;
	getSessionId?: () => string | null;
	getContextLedger: () => ContextLedger;
	contextChat: NonNullable<OpenContextOverlayOptions["chat"]>;
	bus: SafeEventBus;
	onContextClear?: (options: ContextClearCommandOptions) => Promise<void> | void;
	stderr: (text: string) => void;
	refreshFooter: () => void;
	toggleFooter: () => void;
	renderTaskIsland: () => void;
	requestRender: () => void;
	getTaskBoard?: Parameters<typeof openTasksOverlay>[1];
	userTasks?: UserTasksStore;
	getDecisionBoard?: Parameters<typeof openDecisionsOverlay>[1];
	supersedeDecision?: (interviewId: string, key: string, correction?: string) => unknown;
	submitChat: (text: string) => void;
	getTaskMemoryStatus?: Parameters<typeof openMemoryOverlay>[1];
	dataDir: string;
	notify: (level: "info" | "success" | "warning" | "error", text: string, key?: string) => void;
	dispatch: DispatchContract;
	stateDir: string;
	getSessionMeta: () => SessionMeta | null;
	readSessionEntries?: ArtifactProviderDeps["readSessionEntries"];
	/** Live settings, so `/context` can state the configured working-set policy. */
	getSettings?: () => Readonly<ClioSettings>;
	terminal: { columns: number };
	dispatchBoard: ReturnType<typeof createDispatchBoardView>;
	startDispatchBoardTicker: () => void;
	closeOverlay: () => void;
	showOverlayFrame?: typeof showClioOverlayFrame;
	openCostOverlay?: typeof openCostOverlay;
	openContextOverlay?: typeof openContextOverlay;
	openContextResetOverlay?: typeof openContextResetOverlay;
	openTasksOverlay?: typeof openTasksOverlay;
	openDecisionsOverlay?: typeof openDecisionsOverlay;
	openMemoryOverlay?: typeof openMemoryOverlay;
	openViewOverlay?: typeof openViewOverlay;
	openSideQuestionOverlay?: typeof openSideQuestionOverlay;
	openFleetRunApprovalOverlay?: typeof openFleetRunApprovalOverlay;
	/** Recipe registry `/fleet run` resolves every step's agent against. */
	agents?: AgentsContract;
	/** Session budget state the run would be admitted under; absent leaves it unknown. */
	getBudgetPreflight?: () => { ceilingUsd: number; currentUsd: number; verdict: "under" | "at" | "over" };
	/**
	 * True while a turn is streaming. `/fleet run` is refused then, never
	 * queued: an approved plan describes the workspace as it stands, and a turn
	 * still in flight is about to change it.
	 */
	isTurnInFlight?: () => boolean;
	/** Record which wave and step a dispatched run belongs to, for the board's phase column. */
	setFleetRunPhase?: (runId: string, phase: { wave: number; stepId: string }) => void;
	/** The shared fleet-run path; overridable so a test can observe one call. */
	runFleet?: typeof executeFleetRun;
	/** Contract and command-registry loader; overridable so a test projects a fixture. */
	loadFleetSources?: FleetRunPreviewInput["load"];
	/**
	 * Run one `/btw` round. Absent on a host with no chat loop, in which case
	 * `/btw` reports that instead of opening an empty overlay.
	 */
	askSideQuestion?: (
		question: string,
		options: { signal: AbortSignal; onDelta: (partialText: string) => void },
	) => Promise<
		| { status: "answered"; text: string }
		| { status: "aborted"; text: string }
		| { status: "refused"; reason: string }
		| { status: "failed"; reason: string }
	>;
}

export interface OverlayGeneralOpeners {
	openCost(): void;
	openContextView(): void;
	openContextReset(): void;
	toggleFooter(): void;
	openTasks(): void;
	openDecisions(): void;
	openMemory(): void;
	openView(initialFilter?: string): void;
	toggleDispatchBoard(): void;
	openSideQuestion(question: string): void;
	/** `/fleet run <name> [--var k=v ...]`: preview the plan, then dispatch on approval. */
	startFleetRun(name: string, vars: Readonly<Record<string, string>>): void;
}

export function createOverlayGeneralOpeners(deps: OverlayGeneralOpenersDeps): OverlayGeneralOpeners {
	const openCostOverlayFactory = deps.openCostOverlay ?? openCostOverlay;
	const openContextOverlayFactory = deps.openContextOverlay ?? openContextOverlay;
	const openContextResetOverlayFactory = deps.openContextResetOverlay ?? openContextResetOverlay;
	const openTasksOverlayFactory = deps.openTasksOverlay ?? openTasksOverlay;
	const openDecisionsOverlayFactory = deps.openDecisionsOverlay ?? openDecisionsOverlay;
	const openMemoryOverlayFactory = deps.openMemoryOverlay ?? openMemoryOverlay;
	const openViewOverlayFactory = deps.openViewOverlay ?? openViewOverlay;
	const showOverlayFrameFactory = deps.showOverlayFrame ?? showClioOverlayFrame;
	const openSideQuestionOverlayFactory = deps.openSideQuestionOverlay ?? openSideQuestionOverlay;

	const openCost = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "cost";
		deps.transitions.handle = openCostOverlayFactory(deps.tui, deps.observability, {
			sessionId: deps.getSessionId?.() ?? null,
			...(deps.readSessionEntries
				? {
						getSessionEntries: () => deps.readSessionEntries?.() ?? [],
					}
				: {}),
		});
		deps.requestRender();
	};

	const openContextView = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "context-view";
		deps.transitions.handle = openContextOverlayFactory(deps.tui, deps.getContextLedger, {
			bus: deps.bus,
			chat: deps.contextChat,
			getWorkingSet: () => {
				const readSessionEntries = deps.readSessionEntries;
				if (!readSessionEntries) return null;
				return foldWorkingSet(readSessionEntries(), deps.getSessionMeta()?.pinnedLeafTurnId ?? undefined);
			},
			getWorkingSetConfig: () => {
				const workingSet = deps.getSettings?.().context.workingSet;
				return workingSet ? { enabled: workingSet.enabled, policy: workingSet.policy } : null;
			},
		});
		deps.requestRender();
	};

	const openContextReset = (): void => {
		if (deps.transitions.state !== "closed" || !deps.onContextClear) return;
		deps.transitions.state = "context-reset";
		deps.transitions.handle = openContextResetOverlayFactory(deps.tui, {
			onReset: resetContext,
			onCancel: deps.closeOverlay,
		});
		deps.requestRender();
	};

	const resetContext = (choice: ContextResetMutationChoice): void => {
		deps.closeOverlay();
		const onContextClear = deps.onContextClear;
		if (!onContextClear) return;
		void Promise.resolve()
			.then(() => onContextClear(contextResetOptions(choice)))
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				deps.stderr(`[/context reset] ${msg}\n`);
			})
			.finally(() => {
				deps.refreshFooter();
				deps.requestRender();
			});
	};

	const toggleFooter = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.toggleFooter();
		deps.renderTaskIsland();
		deps.requestRender();
	};

	const openTasks = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "tasks";
		deps.transitions.handle = openTasksOverlayFactory(deps.tui, () => deps.getTaskBoard?.() ?? null, {
			onClose: deps.closeOverlay,
			getSessionSnapshot: () => {
				const meta = deps.getSessionMeta();
				const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], meta?.pinnedLeafTurnId ?? undefined);
				const workspace = meta?.cwd ?? process.cwd();
				return {
					history: foldSessionTaskHistory(entries),
					artifacts: foldSessionArtifacts(entries, { workspace }),
				};
			},
			...(deps.userTasks
				? {
						getUserTasks: () => deps.userTasks?.snapshot() ?? [],
						onAddUserTask: (title: string) => void deps.userTasks?.add(title),
						onHandUserTask: (id: string) => {
							const task = deps.userTasks?.hand(id, deps.getSessionId?.() ?? undefined);
							if (!task) throw new Error("operator task inbox is unavailable");
							deps.submitChat(formatUserTaskHandoff(task));
						},
						onDoneUserTask: (id: string) => void deps.userTasks?.done(id),
						onDropUserTask: (id: string) => void deps.userTasks?.drop(id),
					}
				: {}),
			onOpenArtifact: (path: string) => openView(`workspace:${path}`),
			requestRender: deps.requestRender,
			workspace: deps.getSessionMeta()?.cwd ?? process.cwd(),
		});
		deps.requestRender();
	};

	const openDecisions = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "decisions";
		deps.transitions.handle = openDecisionsOverlayFactory(deps.tui, () => deps.getDecisionBoard?.() ?? [], {
			onSupersede: (selection) => {
				if (!deps.supersedeDecision) throw new Error("decision board is unavailable in this session");
				deps.supersedeDecision(selection.interviewId, selection.key);
			},
			onCorrection: (selection, correction) => {
				if (!deps.supersedeDecision) throw new Error("decision board is unavailable in this session");
				deps.supersedeDecision(selection.interviewId, selection.key, correction);
				deps.closeOverlay();
				deps.submitChat(formatDecisionCorrectionTurn(selection, correction));
			},
			onClose: deps.closeOverlay,
		});
		deps.requestRender();
	};

	const openMemory = (): void => {
		if (deps.transitions.state !== "closed" || !deps.getTaskMemoryStatus) return;
		let records: MemoryRecord[] = [];
		try {
			records = loadMemoryRecordsSync(deps.dataDir);
		} catch (error) {
			deps.notify(
				"warning",
				`memory: durable lessons unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"memory:durable-read",
			);
		}
		deps.transitions.state = "memory";
		deps.transitions.handle = openMemoryOverlayFactory(deps.tui, deps.getTaskMemoryStatus, () => records, {
			onClose: deps.closeOverlay,
			onPromote: async (entry, scope) => {
				const meta = deps.getSessionMeta();
				if (!meta) throw new Error("memory promotion requires an active session");
				const selection =
					scope === "global"
						? ({ scope: "global", acknowledgeGlobal: true } as const)
						: (() => {
								const repository = canonicalMemoryRepositoryIdentity(meta.cwd);
								if (repository === null) {
									throw new Error("repo promotion requires a canonical active repository identity");
								}
								return { scope: "repo", repository } as const;
							})();
				const result = await proposeMemoryPromotion(
					deps.dataDir,
					{
						kind: "task-bank-entry",
						sessionId: meta.id,
						evidenceRefs: [`session-${meta.id}`],
						entry,
					},
					selection,
				);
				records = loadMemoryRecordsSync(deps.dataDir);
				return result;
			},
		});
		deps.requestRender();
	};

	const openView = (initialFilter?: string): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "view";
		deps.transitions.handle = openViewOverlayFactory(deps.tui, {
			providers: createDefaultArtifactProviders({
				stateDir: deps.stateDir,
				dataDir: deps.dataDir,
				dispatch: deps.dispatch,
				sessionMeta: deps.getSessionMeta(),
				readSessionEntries: deps.readSessionEntries,
			}),
			...(initialFilter ? { initialFilter } : {}),
			notice: deps.notify,
			onClose: deps.closeOverlay,
		});
		deps.requestRender();
	};

	const toggleDispatchBoard = (): void => {
		if (deps.transitions.state === "dispatch-board") {
			deps.closeOverlay();
			return;
		}
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "dispatch-board";
		deps.dispatchBoard.resetSelection();
		deps.transitions.handle = showOverlayFrameFactory(deps.tui, deps.dispatchBoard, {
			title: "Fleet Runs",
			footerHint: dispatchBoardHint,
			anchor: "center",
			width: Math.max(44, Math.min(96, deps.terminal.columns - 4)),
		});
		deps.startDispatchBoardTicker();
		deps.requestRender();
	};

	const dispatchBoardHint = (): string => {
		const row = deps.dispatchBoard.selectedRow();
		const entries = [{ key: "↑↓", verb: "select" }];
		if (row) entries.push({ key: "Enter", verb: deps.dispatchBoard.detailExpanded() ? "hide detail" : "detail" });
		if (row && isDispatchBoardRowSteerable(row)) entries.push({ key: "s", verb: "steer" });
		if (row && isDispatchBoardRowCancellable(row)) entries.push({ key: "x", verb: "cancel" });
		return buildHint(entries);
	};

	/**
	 * `/btw <question>`: one model round beside the session, rendered in an
	 * overlay and nowhere else. Esc aborts a round that is still streaming and
	 * closes one that has settled; both paths run through the same abort
	 * controller, so a cancelled round never keeps a stream alive behind a closed
	 * overlay.
	 */
	const openSideQuestion = (question: string): void => {
		if (deps.transitions.state !== "closed") return;
		const ask = deps.askSideQuestion;
		if (!ask) {
			deps.notify("error", "/btw is not wired in this session", "btw:unavailable");
			return;
		}
		const controller = new AbortController();
		deps.transitions.state = "side-question";
		const session = openSideQuestionOverlayFactory(deps.tui, {
			question,
			columns: deps.terminal.columns,
			onClose: () => controller.abort(),
		});
		deps.transitions.handle = session;
		deps.requestRender();
		void ask(question, { signal: controller.signal, onDelta: (partialText) => session.setAnswer(partialText) })
			.then((outcome) => {
				if (outcome.status === "answered") {
					session.settle({ kind: "answered", text: outcome.text });
					return;
				}
				if (outcome.status === "aborted") {
					session.settle({ kind: "aborted", text: outcome.text });
					return;
				}
				session.settle({ kind: "error", reason: outcome.reason });
			})
			.catch((error: unknown) => {
				session.settle({ kind: "error", reason: error instanceof Error ? error.message : String(error) });
			});
	};

	/**
	 * `/fleet run <name>`: compile the plan, show it, and dispatch only what the
	 * operator accepted.
	 *
	 * Nothing is dispatched and nothing is written before the accept key. A
	 * contract that fails preflight opens the same overlay with its diagnostics
	 * and no accept action, so the only exit from a broken plan is to leave it.
	 */
	const startFleetRun = (name: string, vars: Readonly<Record<string, string>>): void => {
		if (deps.transitions.state !== "closed") return;
		// Refused, never queued: an approved plan describes the workspace as it
		// stands, and a turn still in flight is about to change it.
		if (deps.isTurnInFlight?.() === true) {
			deps.notify("warning", "a turn is in flight; /fleet run is refused rather than queued", "fleet-run:in-flight");
			return;
		}
		const agents = deps.agents;
		if (!agents) {
			deps.notify("error", "/fleet run needs the agents domain, which is not wired in this session", "fleet-run:agents");
			return;
		}
		const workspaceRoot = deps.getSessionMeta()?.cwd ?? process.cwd();
		const roleFacts = agentRoleFactsResolver((id) => agents.getSpec(id));
		const budget = deps.getBudgetPreflight?.();
		const result = compileFleetRunPreview({
			workspaceRoot,
			name,
			vars,
			getAgentSpec: (agentId) => agents.getSpec(agentId),
			roleFacts,
			...(budget ? { budget } : {}),
			...(deps.loadFleetSources ? { load: deps.loadFleetSources } : {}),
			resolveRoute: (step) => {
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: requestExecutionRole({ agentId: step.agentId, resolveFacts: roleFacts }),
					task: step.task,
					...(step.scope === "readonly" ? { autonomy: "read-only" as const } : {}),
					...(step.target !== undefined ? { target: step.target } : {}),
					...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
				};
				const resolution = deps.dispatch.preview?.(request);
				if (!resolution) return null;
				const foregroundHeld =
					resolution.endpoint === undefined ? 0 : (foregroundStreamUsage()[resolution.endpoint.key] ?? 0);
				return {
					targetId: resolution.targetId,
					wireModelId: resolution.wireModelId,
					nodeId: resolution.node.id,
					...(resolution.endpoint !== undefined
						? {
								endpoint: {
									...resolution.endpoint,
									...(foregroundHeld > 0 ? { foregroundHeld } : {}),
								},
							}
						: {}),
				};
			},
		});

		deps.transitions.state = "fleet-run-approval";
		deps.transitions.handle = (deps.openFleetRunApprovalOverlay ?? openFleetRunApprovalOverlay)(deps.tui, {
			subject: result.ok ? { ok: true, preview: result.preview } : { ok: false, name, diagnostics: result.diagnostics },
			columns: deps.terminal.columns,
			onAccept: () => {
				deps.closeOverlay();
				if (result.ok) dispatchFleetRun(result.preview, agents);
			},
			onCancel: () => {
				deps.closeOverlay();
				deps.notify("info", `fleet ${name}: cancelled; nothing was dispatched`, "fleet-run:cancelled");
			},
		});
		deps.requestRender();
	};

	const dispatchFleetRun = (preview: FleetRunPreview, agents: AgentsContract): void => {
		const fleetRootId = `fleet-${randomBytes(6).toString("hex")}`;
		const run = deps.runFleet ?? executeFleetRun;
		deps.notify(
			"info",
			`fleet ${preview.name}: root=${fleetRootId} plan=${preview.planHash.slice(0, 12)} steps=${preview.plan.steps.length}`,
			"fleet-run:started",
		);
		void run({
			plan: preview.plan,
			contractName: preview.name,
			commands: preview.commands,
			workspaceRoot: deps.getSessionMeta()?.cwd ?? process.cwd(),
			fleetRootId,
			dispatch: deps.dispatch,
			agents: { getSpec: (agentId) => agents.getSpec(agentId) },
			attributionEnabled: deps.getSettings?.().attribution.gitCommits ?? true,
			vars: preview.vars,
			onStepDispatched: (event) => {
				deps.setFleetRunPhase?.(event.assignmentId, { wave: event.waveIndex, stepId: event.stepId });
			},
			onNotice: (text) => deps.stderr(`[fleet ${preview.name}] ${text}\n`),
		})
			.then((outcome) => {
				deps.notify(
					outcome.cleanRun ? "success" : "warning",
					`fleet ${preview.name}: ${outcome.succeededStepCount}/${outcome.requiredStepCount} steps succeeded, cost $${outcome.totalCostUsd.toFixed(4)}`,
					"fleet-run:settled",
				);
			})
			.catch((error: unknown) => {
				deps.notify(
					"error",
					`fleet ${preview.name}: ${error instanceof Error ? error.message : String(error)}`,
					"fleet-run:failed",
				);
			});
	};

	return {
		openCost,
		openContextView,
		openContextReset,
		toggleFooter,
		openTasks,
		openDecisions,
		openMemory,
		openView,
		toggleDispatchBoard,
		openSideQuestion,
		startFleetRun,
	};
}
