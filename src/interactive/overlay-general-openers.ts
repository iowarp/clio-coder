import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentsContract } from "../domains/agents/index.js";
import type { DispatchContract } from "../domains/dispatch/index.js";
import { loadMemoryRecordsSync, type MemoryRecord } from "../domains/memory/index.js";
import type { ObservabilityContract, ObservabilitySnapshot } from "../domains/observability/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import type { FleetNodeSnapshot } from "../domains/scheduling/cluster.js";
import type { ContextLedger } from "../domains/session/context-ledger.js";
import type { SessionMeta } from "../domains/session/index.js";
import type { TUI } from "../engine/tui.js";
import { type OpenContextOverlayOptions, openContextOverlay } from "./context-overlay.js";
import { openCostOverlay } from "./cost-overlay.js";
import {
	type createDispatchBoardView,
	isDispatchBoardRowCancellable,
	isDispatchBoardRowSteerable,
} from "./dispatch-board.js";
import { type OpenFleetOverlayOptions, openFleetOverlay } from "./fleet-overlay.js";
import { openMemoryOverlay } from "./memory-overlay.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import {
	type ContextResetMutationChoice,
	contextResetOptions,
	openContextResetOverlay,
} from "./overlays/context-reset.js";
import type { ContextClearCommandOptions } from "./slash-commands.js";
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
	getTaskMemoryStatus?: Parameters<typeof openMemoryOverlay>[1];
	dataDir: string;
	notify: (level: "info" | "success" | "warning" | "error", text: string, key?: string) => void;
	dispatch: DispatchContract;
	providers: ProvidersContract;
	getObservabilitySnapshot: () => ObservabilitySnapshot;
	agents?: AgentsContract;
	getSettings?: () => Readonly<ClioSettings> | undefined;
	getFleetNodes?: () => ReadonlyArray<FleetNodeSnapshot>;
	writeSettings?: (next: ClioSettings) => void;
	stateDir: string;
	getSessionMeta: () => SessionMeta | null;
	readSessionEntries?: ArtifactProviderDeps["readSessionEntries"];
	terminal: { columns: number };
	dispatchBoard: ReturnType<typeof createDispatchBoardView>;
	startDispatchBoardTicker: () => void;
	closeOverlay: () => void;
	showOverlayFrame?: typeof showClioOverlayFrame;
	openCostOverlay?: typeof openCostOverlay;
	openContextOverlay?: typeof openContextOverlay;
	openContextResetOverlay?: typeof openContextResetOverlay;
	openTasksOverlay?: typeof openTasksOverlay;
	openMemoryOverlay?: typeof openMemoryOverlay;
	openFleetOverlay?: typeof openFleetOverlay;
	openViewOverlay?: typeof openViewOverlay;
}

export interface OverlayGeneralOpeners {
	openCost(): void;
	openContextView(): void;
	openContextReset(): void;
	toggleFooter(): void;
	openTasks(): void;
	openMemory(): void;
	openFleet(): void;
	openView(initialFilter?: string): void;
	toggleDispatchBoard(): void;
}

export function createOverlayGeneralOpeners(deps: OverlayGeneralOpenersDeps): OverlayGeneralOpeners {
	const openCostOverlayFactory = deps.openCostOverlay ?? openCostOverlay;
	const openContextOverlayFactory = deps.openContextOverlay ?? openContextOverlay;
	const openContextResetOverlayFactory = deps.openContextResetOverlay ?? openContextResetOverlay;
	const openTasksOverlayFactory = deps.openTasksOverlay ?? openTasksOverlay;
	const openMemoryOverlayFactory = deps.openMemoryOverlay ?? openMemoryOverlay;
	const openFleetOverlayFactory = deps.openFleetOverlay ?? openFleetOverlay;
	const openViewOverlayFactory = deps.openViewOverlay ?? openViewOverlay;
	const showOverlayFrameFactory = deps.showOverlayFrame ?? showClioOverlayFrame;

	const openCost = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "cost";
		deps.transitions.handle = openCostOverlayFactory(deps.tui, deps.observability, {
			sessionId: deps.getSessionId?.() ?? null,
		});
		deps.requestRender();
	};

	const openContextView = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "context-view";
		deps.transitions.handle = openContextOverlayFactory(deps.tui, deps.getContextLedger, {
			bus: deps.bus,
			chat: deps.contextChat,
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
		});
		deps.requestRender();
	};

	const openFleet = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "fleet";
		const options: OpenFleetOverlayOptions = {
			bus: deps.bus,
			providers: deps.providers,
			getObservability: deps.getObservabilitySnapshot,
			...(deps.agents ? { agents: deps.agents } : {}),
			...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
			...(deps.getFleetNodes ? { getFleetNodes: deps.getFleetNodes } : {}),
			...(deps.writeSettings
				? {
						writeSettings: (next) => {
							deps.writeSettings?.(next);
							deps.refreshFooter();
						},
					}
				: {}),
			notice: deps.notify,
			onClose: deps.closeOverlay,
		};
		deps.transitions.handle = openFleetOverlayFactory(deps.tui, deps.dispatch, options);
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
		if (row && isDispatchBoardRowSteerable(row)) entries.push({ key: "s", verb: "steer" });
		if (row && isDispatchBoardRowCancellable(row)) entries.push({ key: "x", verb: "cancel" });
		return buildHint("browse", entries);
	};

	return {
		openCost,
		openContextView,
		openContextReset,
		toggleFooter,
		openTasks,
		openMemory,
		openFleet,
		openView,
		toggleDispatchBoard,
	};
}
