import type { ClientIdentity } from "../../contracts/auth.js";
import type { SessionControl } from "../../contracts/control.js";

/** A window viewing another's session asks again this often, so a holder that went away frees it. */
export const VIEWER_RECHECK_MS = 15_000;

export type ControlState =
	| { kind: "unknown" }
	| { kind: "free" }
	| { kind: "yours" }
	| { kind: "viewing"; controller: ClientIdentity };

export function controlState(control: SessionControl | undefined): ControlState {
	if (!control) return { kind: "unknown" };
	if (!control.controller) return { kind: "free" };
	if (control.controller.clientId === control.you.clientId) return { kind: "yours" };
	return { kind: "viewing", controller: control.controller };
}

/** What a viewing window says above the conversation. */
export function viewerBanner(controller: ClientIdentity) {
	return {
		title: `${controller.label} controls this task.`,
		detail:
			"You can follow it here. Take control from the message box to send messages, answer approvals or change it from this window.",
	};
}

/** The record a `session.control` event leaves for a window that already read the session's control. */
export function applyControl(
	control: SessionControl | undefined,
	controller: ClientIdentity | null,
): SessionControl | undefined {
	return control ? { ...control, controller } : control;
}

/**
 * The notice for the window that just lost control to a take-over, or null for every other window.
 * `you` is this window's id where the session lives: a node knows a proxied window by its own id.
 */
export function lostControlNotice(
	payload: { controller: ClientIdentity | null; previous: ClientIdentity | null },
	you: string | null,
) {
	const { controller, previous } = payload;
	if (!you || !controller || previous?.clientId !== you || controller.clientId === you) return null;
	return {
		title: `${controller.label} took control of a task`,
		detail: "This window can still follow it. Take control again from the task to act on it here.",
	};
}
