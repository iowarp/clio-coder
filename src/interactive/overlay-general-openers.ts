import { randomBytes, randomUUID } from "node:crypto";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import type { DispatchContract, FleetRunPreview, FleetRunPreviewInput } from "../domains/dispatch/index.js";
import {
	agentRoleFactsResolver,
	compileFleetRunPreview,
	executeFleetRun,
	fleetRouteResolver,
} from "../domains/dispatch/index.js";
import type { MemoryRecord } from "../domains/memory/index.js";
import { loadMemoryRecordsSync, proposeTaskBankPromotion } from "../domains/memory/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import { renderCostAggregate } from "../domains/observability/index.js";
import type { ContextLedger } from "../domains/session/context-ledger.js";
import type { SessionMeta } from "../domains/session/index.js";
import { foldSessionArtifacts } from "../domains/session/session-artifacts.js";
import { foldSessionTaskHistory } from "../domains/session/task-board.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { GitChanges } from "../domains/session/workspace/git-probe.js";
import { probeGitChangesAsync } from "../domains/session/workspace/git-probe.js";
import type { OutcomeRecord } from "../domains/system-one/index.js";
import { draftTakenOutcome } from "../domains/system-one/outcomes.js";
import { formatUserTaskHandoff } from "../domains/user-tasks/handoff.js";
import type { UserTasksStore } from "../domains/user-tasks/store.js";
import type { TUI } from "../engine/tui.js";
import type { DraftOutcome } from "./chat-loop.js";
import type { OpenContextOverlayOptions } from "./context-overlay.js";
import { openContextOverlay } from "./context-overlay.js";
import type { createDispatchBoardView } from "./dispatch-board.js";
import { isDispatchBoardRowCancellable, isDispatchBoardRowSteerable } from "./dispatch-board.js";
import type { DraftVerdict } from "./drafts.js";
import { draftsToJudge } from "./drafts.js";
import { openMemoryOverlay } from "./memory-overlay.js";
import type { HintEntry } from "./overlay-frame.js";
import { buildResponsiveHint, showClioOverlayFrame } from "./overlay-frame.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import type { ContextResetMutationChoice } from "./overlays/context-reset.js";
import { contextResetOptions, openContextResetOverlay } from "./overlays/context-reset.js";
import { formatDecisionCorrectionTurn, openDecisionsOverlay } from "./overlays/decisions.js";
import { openDraftOverlay, type TakenDraft } from "./overlays/draft.js";
import { openFleetRunApprovalOverlay } from "./overlays/fleet-run-approval.js";
import { openQueueNavigatorOverlay } from "./overlays/queue-navigator.js";
import { openSideQuestionOverlay } from "./overlays/side-question.js";
import type { ContextClearCommandOptions } from "./slash-commands.js";
import { openTasksOverlay } from "./tasks-overlay.js";
import { openUsageOverlay } from "./usage-overlay.js";
import type { ArtifactProviderDeps } from "./view/artifacts.js";
import { createDefaultArtifactProviders } from "./view/artifacts.js";
import { openViewOverlay } from "./view/view-overlay.js";

export interface OverlayGeneralOpenersDeps {
	readTranscript?: ArtifactProviderDeps["readTranscript"];
	tui: TUI;
	transitions: OverlayTransitions;
	observability: ObservabilityContract;
	getQuotaSnapshots?: () => ReadonlyArray<import("../domains/quota/types.js").UsageSnapshot>;
	getDispatchRows?: () => ReadonlyArray<import("./dispatch-board.js").DispatchBoardRow>;
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
	/** Every session of this workspace, for the usage activity graph. */
	listSessions?: () => ReadonlyArray<SessionMeta>;
	readSessionEntries?: ArtifactProviderDeps["readSessionEntries"];
	/** Live settings, so `/context` can state the configured working-set policy. */
	getSettings?: () => Readonly<ClioSettings>;
	terminal: { columns: number };
	dispatchBoard: ReturnType<typeof createDispatchBoardView>;
	startDispatchBoardTicker: () => void;
	closeOverlay: () => void;
	showOverlayFrame?: typeof showClioOverlayFrame;
	openUsageOverlay?: typeof openUsageOverlay;
	openContextOverlay?: typeof openContextOverlay;
	openContextResetOverlay?: typeof openContextResetOverlay;
	openTasksOverlay?: typeof openTasksOverlay;
	openDecisionsOverlay?: typeof openDecisionsOverlay;
	openMemoryOverlay?: typeof openMemoryOverlay;
	openViewOverlay?: typeof openViewOverlay;
	openSideQuestionOverlay?: typeof openSideQuestionOverlay;
	openFleetRunApprovalOverlay?: typeof openFleetRunApprovalOverlay;
	openQueueNavigatorOverlay?: typeof openQueueNavigatorOverlay;
	/**
	 * The steering queue the navigator works on, and the editor-side actions
	 * only the application can perform. Absent, the navigator is unavailable.
	 */
	queueNavigator?: {
		chat: Pick<
			import("./chat-loop.js").ChatLoop,
			"queueEntries" | "removeQueuedEntry" | "moveQueuedEntry" | "setQueuedEntryKind"
		>;
		toEditor(entry: import("./chat-loop.js").QueuedChatMessage): void;
		sendNow(entry: import("./chat-loop.js").QueuedChatMessage): void;
		restoreAll(): void;
		restoreAllLabel(): string;
		matchesRestoreAll(data: string): boolean;
	};
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
	/** Run the `/draft` candidate rounds. Absent on a host with no chat loop. */
	draftCandidates?: (
		request: string,
		count: number,
		options: { signal: AbortSignal; onCandidate: (index: number, partialText: string) => void },
	) => Promise<DraftOutcome>;
	/**
	 * Judge settled drafts with the `drafts` decision site. Resolves to the
	 * verdict, or to the sentence explaining why there is none.
	 */
	judgeDrafts?: (
		request: string,
		candidates: ReadonlyArray<string>,
		signal: AbortSignal,
		/** The judging call's ref, minted by the opener so a draft taken mid-judgment can still be keyed to it. */
		ref: string,
	) => Promise<{ verdict: DraftVerdict } | { reason: string }>;
	openDraftOverlay?: typeof openDraftOverlay;
	/** The composer `/draft` puts a taken draft into. Absent, the overlay offers no use key. */
	composer?: { getText(): string; setText(text: string): void };
	/** Records what followed a System One decision; the taken draft joins the judging call by its ref. */
	recordOutcome?: (outcome: {
		ref: string;
		source: OutcomeRecord["source"];
		facts: Readonly<Record<string, unknown>>;
	}) => void;
}

export interface OverlayGeneralOpeners {
	openUsage(): void;
	openContextView(): void;
	openContextReset(): void;
	toggleFooter(): void;
	openTasks(): void;
	openDecisions(): void;
	openMemory(): void;
	openView(initialFilter?: string): void;
	toggleDispatchBoard(): void;
	/** The steering queue as a list the operator can reorder, relabel, edit, remove or send now. */
	openQueueNavigator(): void;
	openSideQuestion(question: string): void;
	/** `/draft [N] <request>`: N candidates in parallel, judged by a decision model. */
	openDraft(request: string, count: number): void;
	/** `/fleet run <name> [--var k=v ...]`: preview the plan, then dispatch on approval. */
	startFleetRun(name: string, vars: Readonly<Record<string, string>>): void;
}

export function createOverlayGeneralOpeners(deps: OverlayGeneralOpenersDeps): OverlayGeneralOpeners {
	const openUsageOverlayFactory = deps.openUsageOverlay ?? openUsageOverlay;
	const openContextOverlayFactory = deps.openContextOverlay ?? openContextOverlay;
	const openContextResetOverlayFactory = deps.openContextResetOverlay ?? openContextResetOverlay;
	const openTasksOverlayFactory = deps.openTasksOverlay ?? openTasksOverlay;
	const openDecisionsOverlayFactory = deps.openDecisionsOverlay ?? openDecisionsOverlay;
	const openMemoryOverlayFactory = deps.openMemoryOverlay ?? openMemoryOverlay;
	const openViewOverlayFactory = deps.openViewOverlay ?? openViewOverlay;
	const showOverlayFrameFactory = deps.showOverlayFrame ?? showClioOverlayFrame;
	const openSideQuestionOverlayFactory = deps.openSideQuestionOverlay ?? openSideQuestionOverlay;

	const openUsage = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "usage";
		// The changes probe is a subprocess; the card opens at once and the row
		// fills in when it lands.
		let changes: GitChanges | null = null;
		const workspace = deps.getSessionMeta()?.cwd ?? process.cwd();
		void probeGitChangesAsync(workspace).then((result) => {
			changes = result;
			deps.requestRender();
		});
		deps.transitions.handle = openUsageOverlayFactory(deps.tui, deps.observability, {
			sessionId: deps.getSessionId?.() ?? null,
			...(deps.listSessions ? { listSessions: deps.listSessions } : {}),
			getChanges: () => changes,
			sessionStartedAt: deps.getSessionMeta()?.createdAt ?? null,
			...(deps.getQuotaSnapshots ? { getQuotaSnapshots: deps.getQuotaSnapshots } : {}),
			...(deps.getDispatchRows ? { getDispatchRows: deps.getDispatchRows } : {}),
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
				return workingSet ?? null;
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
				const result = await proposeTaskBankPromotion(deps.dataDir, { id: meta.id, cwd: meta.cwd }, entry, scope);
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
				readTranscript: deps.readTranscript,
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
			markerId: "dispatch-board",
			title: "Fleet Runs",
			footerHint: dispatchBoardHint,
			anchor: "center",
			width: Math.max(44, Math.min(96, deps.terminal.columns - 4)),
		});
		deps.startDispatchBoardTicker();
		deps.requestRender();
	};

	const dispatchBoardHint = (innerWidth: number): string => {
		const row = deps.dispatchBoard.selectedRow();
		const entries: HintEntry[] = [];
		if (row) {
			entries.push({ key: "↑↓", verb: "select" });
		}
		if (row && row.council === undefined) {
			entries.push({
				key: "Enter",
				verb: deps.dispatchBoard.detailExpanded() ? "hide detail" : "detail",
				critical: false,
			});
		}
		if (row && isDispatchBoardRowSteerable(row)) entries.push({ key: "s", verb: "steer", critical: true });
		if (row && isDispatchBoardRowCancellable(row)) entries.push({ key: "x", verb: "cancel", critical: true });
		return buildResponsiveHint(entries)(innerWidth);
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
	 * `/draft [N] <request>`: N candidate rounds in parallel, then one judgment.
	 *
	 * The judge runs only once every candidate has settled, because a `choice`
	 * over half-denoised text is a judgment about noise. A failed candidate is
	 * left out of the judgment rather than failing it, and fewer than two
	 * drafted candidates leaves nothing to choose between.
	 */
	const openDraft = (request: string, count: number): void => {
		if (deps.transitions.state !== "closed") return;
		const run = deps.draftCandidates;
		if (!run) {
			deps.notify("error", "/draft is not wired in this session", "draft:unavailable");
			return;
		}
		const composer = deps.composer;
		const controller = new AbortController();
		// Set while the judge runs, so a take before the verdict still has the call to join.
		let judgingRef: string | null = null;
		deps.transitions.state = "draft";
		const session = (deps.openDraftOverlay ?? openDraftOverlay)(deps.tui, {
			request,
			count,
			columns: deps.terminal.columns,
			rows: process.stdout.rows ?? 40,
			onEscape: () => deps.closeOverlay(),
			...(composer
				? {
						onUse: (taken: TakenDraft) => {
							// Appended, never replaced: the composer has no confirm-before-replace
							// path, and a typed message must survive taking a draft.
							const held = composer.getText().trimEnd();
							composer.setText(held.length > 0 ? `${held}\n\n${taken.text}` : taken.text);
							// A take while the judge still runs aborts it, and the preference is
							// worth keeping without a pick to compare it with.
							const ref = taken.verdict?.ref ?? judgingRef;
							if (ref !== null && ref !== undefined) {
								deps.recordOutcome?.(draftTakenOutcome({ ref, taken: taken.label, judgedPick: taken.verdict?.picked ?? null }));
							}
							deps.closeOverlay();
						},
					}
				: {}),
			onClose: () => controller.abort(),
		});
		deps.transitions.handle = session;
		deps.requestRender();
		void (async () => {
			const outcome = await run(request, count, {
				signal: controller.signal,
				onCandidate: (index, partialText) => session.setCandidate(index, { kind: "streaming", text: partialText }),
			});
			if (outcome.status === "refused") {
				session.refuse(outcome.reason);
				return;
			}
			outcome.candidates.forEach((candidate, index) => {
				session.setCandidate(
					index,
					candidate.status === "drafted"
						? { kind: "drafted", text: candidate.text }
						: { kind: "failed", reason: candidate.reason },
				);
			});
			if (outcome.aborted) return;
			const drafted = draftsToJudge(outcome.candidates);
			if ("reason" in drafted) {
				session.setJudge({ kind: "unjudged", reason: drafted.reason });
				return;
			}
			if (!deps.judgeDrafts) {
				session.setJudge({ kind: "unjudged", reason: "not judged: no decision model is wired in this session" });
				return;
			}
			session.setJudge({ kind: "judging" });
			const ref = `draft_${randomUUID()}`;
			judgingRef = ref;
			let judged: Awaited<ReturnType<NonNullable<typeof deps.judgeDrafts>>>;
			try {
				judged = await deps.judgeDrafts(request, drafted.texts, controller.signal, ref);
			} finally {
				judgingRef = null;
			}
			session.setJudge(
				"verdict" in judged ? { kind: "judged", verdict: judged.verdict } : { kind: "unjudged", reason: judged.reason },
			);
		})().catch((error: unknown) => {
			session.refuse(error instanceof Error ? error.message : String(error));
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
			resolveRoute: fleetRouteResolver(deps.dispatch.preview, roleFacts),
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
			...(deps.getDecisionBoard ? { getDecisionBoard: deps.getDecisionBoard } : {}),
			attributionEnabled: deps.getSettings?.().integrations.git.commitAttribution ?? true,
			vars: preview.vars,
			onStepDispatched: (event) => {
				deps.setFleetRunPhase?.(event.assignmentId, { wave: event.waveIndex, stepId: event.stepId });
			},
			onNotice: (text) => deps.stderr(`[fleet ${preview.name}] ${text}\n`),
		})
			.then((outcome) => {
				deps.notify(
					outcome.cleanRun ? "success" : "warning",
					// `totalCost` rather than the bare `totalCostUsd` sum: a run whose
					// receipts were all unpriced reads as not measured instead of as a
					// measured $0.0000 nobody put a number on.
					`fleet ${preview.name}: ${outcome.succeededStepCount}/${outcome.requiredStepCount} steps succeeded, cost ${renderCostAggregate(outcome.totalCost)}`,
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

	const openQueueNavigatorFactory = deps.openQueueNavigatorOverlay ?? openQueueNavigatorOverlay;
	const openQueueNavigator = (): void => {
		if (deps.transitions.state !== "closed") return;
		const queue = deps.queueNavigator;
		if (!queue) {
			deps.notify("info", "the steering queue navigator is unavailable in this session", "queue:unavailable");
			return;
		}
		if (queue.chat.queueEntries().length === 0) {
			deps.notify("info", "nothing is queued; Enter during a run queues a message", "queue:empty");
			return;
		}
		deps.transitions.state = "queue-navigator";
		deps.transitions.handle = openQueueNavigatorFactory(deps.tui, {
			entries: () => queue.chat.queueEntries(),
			remove: (id) => void queue.chat.removeQueuedEntry(id),
			move: (id, delta) => queue.chat.moveQueuedEntry(id, delta),
			toggleKind: (entry) => void queue.chat.setQueuedEntryKind(entry.id, entry.kind === "steer" ? "follow-up" : "steer"),
			toEditor: (entry) => queue.toEditor(entry),
			sendNow: (entry) => queue.sendNow(entry),
			restoreAll: () => queue.restoreAll(),
			restoreAllLabel: () => queue.restoreAllLabel(),
			matchesRestoreAll: (data) => queue.matchesRestoreAll(data),
			onClose: deps.closeOverlay,
			requestRender: deps.requestRender,
		});
		deps.requestRender();
	};

	return {
		openUsage,
		openContextView,
		openContextReset,
		toggleFooter,
		openTasks,
		openDecisions,
		openMemory,
		openView,
		toggleDispatchBoard,
		openQueueNavigator,
		openSideQuestion,
		openDraft,
		startFleetRun,
	};
}
