// The notification channel: four tones, dismissal, and a success and information path the old
// problem-only toast had no way to express. The store is a module singleton rather than React state
// because the events transport that raises most notices is not a component.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiProblem } from "../api/client.js";
import { useLiveState } from "../interaction/announcer.js";
import type { Notice, NoticeTone } from "./notification-model.js";
import { DEFAULT_TTL, problemTone } from "./notification-model.js";
import "../interaction/interaction.css";

export type { Notice, NoticeTone } from "./notification-model.js";

let notices: Notice[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let paused = false;

function publish(): void {
	for (const listener of listeners) listener();
}

function arm(notice: Notice): void {
	if (notice.ttl === null || paused) return;
	const existing = timers.get(notice.id);
	if (existing) clearTimeout(existing);
	timers.set(
		notice.id,
		setTimeout(() => dismiss(notice.id), notice.ttl),
	);
}

export function notify(input: Omit<Notice, "id" | "at" | "ttl"> & { id?: string; ttl?: number | null }): string {
	const id = input.id ?? crypto.randomUUID();
	const ttl = input.ttl === undefined ? DEFAULT_TTL[input.tone] : input.ttl;
	const notice: Notice = { ...input, id, ttl, at: Date.now() };
	// The same id replaces in place, which is how a retried request does not stack.
	notices = [...notices.filter((existing) => existing.id !== id), notice].slice(-5);
	const existing = timers.get(id);
	if (existing) clearTimeout(existing);
	timers.delete(id);
	arm(notice);
	publish();
	return id;
}

export function dismiss(id: string): void {
	const timer = timers.get(id);
	if (timer) clearTimeout(timer);
	timers.delete(id);
	notices = notices.filter((notice) => notice.id !== id);
	publish();
}

export function dismissAll(): void {
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	notices = [];
	publish();
}

/**
 * A toast that vanishes while it is being read, or while its dismiss button holds focus, is a
 * keyboard trap in reverse. Hovering or focusing the region stops every countdown.
 */
function setPaused(next: boolean): void {
	if (paused === next) return;
	paused = next;
	if (paused) {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	} else for (const notice of notices) arm(notice);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

const snapshot = () => notices;
const EMPTY: Notice[] = [];

export function useNotices(): readonly Notice[] {
	return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

/** Every thrown value becomes a notice. An unrecognised error is still shown, never swallowed. */
export function reportProblem(error: unknown): void {
	// A refused token fails every request the same way. The shell replaces the page with one
	// reconnect panel, so a toast per query would only bury it.
	if (error instanceof ApiProblem && error.problem.status === 401) return;
	if (error instanceof ApiProblem) {
		notify({
			id: error.problem.instance,
			tone: problemTone(error.problem.code),
			title: error.problem.title,
			detail: error.problem.detail,
			code: error.problem.code,
			reference: error.problem.instance,
		});
		return;
	}
	notify({
		tone: "error",
		title: "The request did not complete",
		detail: error instanceof Error ? error.message : String(error),
	});
}

const GLYPHS: Readonly<Record<NoticeTone, string>> = { error: "!", warning: "!", info: "i", success: "✓" };
const TONE_WORDS: Readonly<Record<NoticeTone, string>> = {
	error: "Error",
	warning: "Warning",
	info: "Information",
	success: "Done",
};

export function NoticeToasts() {
	const values = useNotices();
	const region = useRef<HTMLElement>(null);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		setHovered(values.length > 0 && (region.current?.matches(":hover") ?? false));
		setFocused(values.length > 0 && (region.current?.contains(document.activeElement) ?? false));
	}, [values]);
	useEffect(() => {
		setPaused(hovered || focused);
		return () => setPaused(false);
	}, [hovered, focused]);
	const urgent = [...values].reverse().find((notice) => notice.tone === "error" || notice.tone === "warning");
	const calm = [...values].reverse().find((notice) => notice.tone === "info" || notice.tone === "success");
	return (
		<>
			{/* The toasts themselves are not a live region: a toast that is its own `role="alert"`
			    re-announces on every re-render and cannot express a polite tone. */}
			<div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{calm ? `${TONE_WORDS[calm.tone]}. ${calm.title}${calm.detail ? `. ${calm.detail}` : ""}` : ""}
			</div>
			<div className="sr-only" role="alert" aria-atomic="true">
				{urgent ? `${TONE_WORDS[urgent.tone]}. ${urgent.title}${urgent.detail ? `. ${urgent.detail}` : ""}` : ""}
			</div>
			<section
				ref={region}
				className="notice-region"
				aria-label="Notifications"
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
				onFocusCapture={() => setFocused(true)}
				onBlurCapture={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
				}}
			>
				{values.length > 1 && (
					<div className="notice-region__controls">
						<span>{values.length} notifications</span>
						<button type="button" onClick={dismissAll}>
							Dismiss all
						</button>
					</div>
				)}
				{values.length > 0 && (
					<div className="notice-region__list">
						{values.map((notice) => (
							<article className={`notice notice--${notice.tone}`} key={notice.id}>
								<div className="notice__heading">
									<span className="notice__glyph" aria-hidden="true">
										{GLYPHS[notice.tone]}
									</span>
									<strong>{notice.title}</strong>
									<button type="button" aria-label={`Dismiss ${notice.title}`} onClick={() => dismiss(notice.id)}>
										×
									</button>
								</div>
								{notice.detail ? <p>{notice.detail}</p> : null}
								{notice.code ? <code>{notice.code}</code> : null}
								{notice.reference ? <small>Reference: {notice.reference}</small> : null}
							</article>
						))}
					</div>
				)}
			</section>
		</>
	);
}

/**
 * The three announcement regions. They are present from first paint and only their text changes,
 * because a live region inserted at the same moment as its text is frequently never spoken.
 */
export function LiveRegions() {
	const live = useLiveState();
	return (
		<>
			<div className="sr-only" aria-live="assertive" aria-atomic="true">
				{live.assertive}
			</div>
			<div className="sr-only" aria-live="polite" aria-atomic="true">
				{live.polite}
			</div>
			<div className="sr-only" aria-live="assertive" aria-atomic="true">
				{live.escalation}
			</div>
		</>
	);
}
