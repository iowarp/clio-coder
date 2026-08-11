import { type DispatchBoardRow, isDispatchBoardRowCancellable, isDispatchBoardRowSteerable } from "./dispatch-board.js";

export type DispatchSteeringNoticeLevel = "info" | "warning" | "error";

export interface DispatchSteeringDeps {
	getSelectedRow: () => DispatchBoardRow | null | undefined;
	notify: (level: DispatchSteeringNoticeLevel, text: string, key: string) => void;
	abortDispatch: (runId: string) => void;
	editor: {
		getText(): string;
		setText(text: string): void;
		focused: boolean;
	};
	closeOverlay: () => void;
	requestRender: () => void;
}

export interface DispatchSteering {
	steerSelectedDispatch(): void;
	cancelSelectedDispatch(): void;
}

export function createDispatchSteering(deps: DispatchSteeringDeps): DispatchSteering {
	const steerSelectedDispatch = (): void => {
		const row = deps.getSelectedRow();
		if (!row) {
			deps.notify("warning", "no fleet run is selected", "dispatch-board:steer");
			return;
		}
		if (row.runtimeKind === "acp-delegation" || row.runtimeKind === "subprocess") {
			deps.notify(
				"warning",
				`run ${row.runId} uses ${row.runtimeId} (${row.runtimeKind}) and cannot accept live steering`,
				`dispatch-board:steer:${row.runId}`,
			);
			return;
		}
		if (!isDispatchBoardRowSteerable(row)) {
			deps.notify(
				"warning",
				`run ${row.runId} is ${row.status} and cannot accept steering`,
				`dispatch-board:steer:${row.runId}`,
			);
			return;
		}
		const prefix = `@${row.runId} `;
		const draft = deps.editor.getText();
		deps.closeOverlay();
		deps.editor.setText(draft.length > 0 ? `${prefix}${draft}` : prefix);
		deps.editor.focused = true;
		deps.requestRender();
	};

	const cancelSelectedDispatch = (): void => {
		const row = deps.getSelectedRow();
		if (!row) {
			deps.notify("warning", "no fleet run is selected", "dispatch-board:cancel");
			return;
		}
		if (row.status === "cancelling") {
			deps.notify("info", `cancellation is already in progress for ${row.runId}`, `dispatch-board:cancel:${row.runId}`);
			return;
		}
		if (!isDispatchBoardRowCancellable(row)) {
			deps.notify(
				"warning",
				`run ${row.runId} is ${row.status} and cannot be cancelled`,
				`dispatch-board:cancel:${row.runId}`,
			);
			return;
		}
		try {
			deps.abortDispatch(row.runId);
			deps.notify(
				"info",
				`cancellation requested for ${row.agentId} (${row.runId})`,
				`dispatch-board:cancel:${row.runId}`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.notify("error", `could not cancel ${row.runId}: ${msg}`, `dispatch-board:cancel:${row.runId}`);
		}
	};

	return { steerSelectedDispatch, cancelSelectedDispatch };
}
