// The three out-of-band channels for facts an operator must not miss: a screen-reader announcement,
// a marker in the tab title, and an optional desktop notification. The store lives outside React
// because the events transport that raises most of these is not a component.

import { useSyncExternalStore } from "react";

export type Urgency = "assertive" | "polite";

interface LiveState {
	/** Interrupting: an approval appeared, a turn failed, the connection dropped. */
	readonly assertive: string;
	/** Polite: an inspection refreshed, a filter narrowed, a save landed. */
	readonly polite: string;
	/** Approval escalation only, so it never overwrites a fresher assertive message. */
	readonly escalation: string;
	readonly approvalPending: boolean;
}

const EMPTY: LiveState = { assertive: "", polite: "", escalation: "", approvalPending: false };
let state: LiveState = EMPTY;
const listeners = new Set<() => void>();

function publish(next: LiveState): void {
	state = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

// Re-announcing the same sentence must still speak, so an identical message is toggled with a
// zero-width space rather than trusting the reader to notice an unchanged value.
function distinct(message: string, previous: string): string {
	return message === previous ? `${message}​` : message;
}

export function announce(message: string, urgency: Urgency = "polite"): void {
	if (urgency === "assertive") publish({ ...state, assertive: distinct(message, state.assertive) });
	else publish({ ...state, polite: distinct(message, state.polite) });
}

/** The declared escalation window, not the observed wait: say what the product promised. */
export function announceEscalation(seconds: number | null): void {
	const message = seconds === null ? "" : `An approval has been waiting for ${seconds} seconds.`;
	publish({ ...state, escalation: distinct(message, state.escalation) });
}

export function setApprovalPending(pending: boolean): void {
	if (state.approvalPending === pending) return;
	publish({ ...state, approvalPending: pending });
}

export function useLiveState(): LiveState {
	return useSyncExternalStore(
		subscribe,
		() => state,
		() => EMPTY,
	);
}

/** Reset for tests and for a hard reconnection. */
export function resetAnnouncer(): void {
	publish(EMPTY);
}

/**
 * The tab title, owned by exactly one writer. Two effects both writing `document.title` fight, so
 * the route label and the approval marker compose here instead.
 */
export function composeTitle(sectionLabel: string | undefined, approvalPending: boolean): string {
	const base = sectionLabel ? `${sectionLabel} · Clio Coder` : "Clio Coder";
	return approvalPending ? `● Approval needed — ${base}` : base;
}

const DESKTOP_NOTIFICATIONS_KEY = "clio-coder-gui-desktop-notifications";

export function desktopNotificationsEnabled(): boolean {
	try {
		return localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY) === "on";
	} catch {
		return false;
	}
}

export function setDesktopNotifications(enabled: boolean): void {
	try {
		localStorage.setItem(DESKTOP_NOTIFICATIONS_KEY, enabled ? "on" : "off");
	} catch {
		/* The preference stays in force for this tab. */
	}
}

const posted = new Set<string>();

/**
 * One notification per permission id, never repeated, and only when permission was already granted:
 * a settings toggle calls `requestPermission`, so the browser prompt is never a surprise. The body
 * carries the title alone, because a path in a notification would leave the project boundary.
 */
export function postApprovalNotification(id: string, title: string): (() => void) | undefined {
	if (posted.has(id)) return undefined;
	if (!desktopNotificationsEnabled()) return undefined;
	try {
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return undefined;
		posted.add(id);
		const notification = new Notification(title);
		return () => notification.close();
	} catch {
		return undefined;
	}
}
