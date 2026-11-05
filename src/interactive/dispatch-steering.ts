import {
	type DispatchBoardRow,
	dispatchStatusPresentation,
	isDispatchBoardRowCancellable,
	isDispatchBoardRowSteerable,
} from "./dispatch-board.js";

// A refusal answers one keypress and describes no standing condition, so it is info and expires on its own.
export type DispatchSteeringNoticeLevel = "info" | "error";

export interface DispatchSteeringDeps {
	getSelectedRow: () => DispatchBoardRow | null | undefined;
	notify: (level: DispatchSteeringNoticeLevel, text: string, key: string) => void;
	abortDispatch: (runId: string) => void;
	/** Stop a fleet plan this session runs; the answer says whether a stop was sent and, when not, why. */
	cancelPlan?: (rootId: string) => "stopping" | "already-stopping" | "settled" | "not-owned" | "unknown";
	editor: {
		getText(): string;
		setText(text: string): void;
		markSteerTarget?(run: { runId: string; agentId: string }): void;
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
			deps.notify("info", "no fleet run is selected", "dispatch-board:steer");
			return;
		}
		if (row.runtimeKind === "acp-delegation" || row.runtimeKind === "subprocess") {
			deps.notify(
				"info",
				`${row.agentId} runs on ${row.runtimeId} (${row.runtimeKind}) and cannot accept live steering`,
				`dispatch-board:steer:${row.runId}`,
			);
			return;
		}
		if (!isDispatchBoardRowSteerable(row)) {
			deps.notify(
				"info",
				row.status === "enqueued"
					? `${row.agentId} is queued and can take a message once it starts`
					: `${row.agentId} is ${dispatchStatusPresentation(row.status).label} and cannot take a message now`,
				`dispatch-board:steer:${row.runId}`,
			);
			return;
		}
		const draft = deps.editor.getText();
		deps.closeOverlay();
		// An editor that can hold the address keeps it out of the text and names the worker on its rail.
		if (deps.editor.markSteerTarget) {
			deps.editor.setText(draft);
			deps.editor.markSteerTarget({ runId: row.runId, agentId: row.agentId });
		} else {
			const prefix = `@${row.runId} `;
			deps.editor.setText(draft.length > 0 ? `${prefix}${draft}` : prefix);
		}
		deps.editor.focused = true;
		deps.requestRender();
	};

	const cancelSelectedDispatch = (): void => {
		const row = deps.getSelectedRow();
		if (!row) {
			deps.notify("info", "no fleet run is selected", "dispatch-board:cancel");
			return;
		}
		if (row.plan !== undefined) {
			cancelPlan(row);
			return;
		}
		if (row.status === "cancelling") {
			deps.notify("info", `cancellation is already in progress for ${row.runId}`, `dispatch-board:cancel:${row.runId}`);
			return;
		}
		if (!isDispatchBoardRowCancellable(row)) {
			deps.notify(
				"info",
				`${row.agentId} has already settled (${dispatchStatusPresentation(row.status).label}), so there is nothing to cancel`,
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

	const cancelPlan = (row: DispatchBoardRow): void => {
		const plan = row.plan;
		if (plan === undefined) return;
		const key = `dispatch-board:cancel:${plan.rootId}`;
		const answer = deps.cancelPlan?.(plan.rootId) ?? "not-owned";
		const running = plan.steps.filter((step) => step.state === "running").map((step) => step.stepId);
		switch (answer) {
			case "stopping":
				deps.notify(
					"info",
					`cancelling plan ${plan.name}: ${running.length > 0 ? `stopping ${running.join(", ")}` : "no step starts after this"}`,
					key,
				);
				break;
			case "already-stopping":
				deps.notify("info", `plan ${plan.name} is already stopping`, key);
				break;
			case "settled":
				deps.notify("info", `plan ${plan.name} already finished (${dispatchStatusPresentation(row.status).label})`, key);
				break;
			default:
				// A durable plan with no recorded end may still run in another Clio, or its process is gone; neither is
				// this session's to stop, and saying it settled would be false.
				deps.notify(
					"info",
					plan.state === "unsettled"
						? `plan ${plan.name} has no recorded end and was not started in this session, so this session cannot stop it`
						: `plan ${plan.name} cannot be stopped from this session`,
					key,
				);
		}
		deps.requestRender();
	};

	return { steerSelectedDispatch, cancelSelectedDispatch };
}
