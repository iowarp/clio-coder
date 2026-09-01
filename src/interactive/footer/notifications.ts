/**
 * NotificationCenter: a dedicated harness→user surface anchored in the footer
 * region. Harness messages (CLIO-CODER.md hints, keybinding notices, connect/probe
 * results) used to be dumped as plain stderr text into the transcript, where
 * they polluted scrollback and looked unintentional. They route here instead.
 *
 * The center holds typed entries and never touches the chat transcript; the
 * footer composes its pure render helpers into the bottom-anchored live region,
 * so notices stay out of VT scrollback by construction.
 *
 * Rendering is split from state so the formatters stay pure and unit-testable:
 * callers build a snapshot via {@link NotificationCenter.list}, then format it
 * with {@link formatNotificationBadge} / {@link formatNotificationPanel}. All
 * color lives in `theme/**`; every emitted line is width-clamped.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { fitFooterText } from "../footer-panel.js";
import { type ClioTheme, type ClioToken, clioTheme, GLYPH, rule } from "../theme/index.js";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface NotificationInput {
	level: NotificationLevel;
	text: string;
	/** Stable identity. Re-adding the same key replaces the existing entry. */
	key?: string;
	/** Override the level default. Use 0 to pin (never auto-expire). */
	ttlMs?: number;
}

export interface Notification {
	id: string;
	level: NotificationLevel;
	text: string;
	key: string | null;
	addedAt: number;
	/** Absolute expiry timestamp, or null when the entry is pinned. */
	expiresAt: number | null;
}

export interface NotificationCenter {
	add(input: NotificationInput): string;
	dismiss(idOrKey: string): boolean;
	dismissAll(): void;
	list(now?: number): ReadonlyArray<Notification>;
	count(now?: number): number;
	hasBlocking(now?: number): boolean;
}

/** Info and success notices fade on their own; warnings and errors persist until dismissed. */
export const DEFAULT_INFO_TTL_MS = 12_000;

const SEVERITY: Record<NotificationLevel, number> = { error: 4, warning: 3, success: 2, info: 1 };

function notificationGlyph(level: NotificationLevel): string {
	if (level === "error") return GLYPH.error;
	if (level === "warning") return GLYPH.warn;
	if (level === "success") return GLYPH.ok;
	return GLYPH.info;
}

function notificationToken(level: NotificationLevel): ClioToken {
	if (level === "error") return "error";
	if (level === "warning") return "warning";
	if (level === "success") return "success";
	return "info";
}

/**
 * Classify a legacy notice string into a level. Boot hints arrive as plain
 * strings (`contextDomain.startupHints()` + the keybinding diagnostics); this
 * keeps state drift and keybinding problems sticky while letting purely
 * advisory hints fade.
 */
export function classifyNoticeLevel(text: string): NotificationLevel {
	if (/malformed|\bfailed\b|\berror\b/i.test(text)) return "error";
	if (/keybinding|may not fire|invalid|differs|changed|no fingerprint|stale/i.test(text)) return "warning";
	return "info";
}

/**
 * Desktop notification: a content-free nudge to a terminal that is not on
 * screen right now.
 *
 * The payload is deliberately not a message. The title is fixed and the body
 * comes from a closed vocabulary, so a notification that lands on a shared
 * screen, a phone mirroring notifications, or a corporate notification log
 * cannot leak a prompt, a path, a model answer, or a worker's task text. What
 * it carries is that something needs the operator, and nothing more.
 */
export const DESKTOP_NOTIFY_TITLE = "clio-coder";

/** Maximum body length in bytes after sanitization. */
export const DESKTOP_NOTIFY_BODY_MAX_BYTES = 128;

/**
 * The three events that earn a notification. `batch` carries the batch's short
 * id because an operator running several fan-outs needs to know which one came
 * back; the id is a generated identifier, never operator or model text.
 */
export type DesktopNotifyEvent =
	| { kind: "turn-finished" }
	| { kind: "batch-settled"; shortId: string }
	| { kind: "approval-needed" };

/**
 * Terminals whose OSC 777 support is absent or unreliable and which understand
 * OSC 9 instead. Matched case-insensitively against TERM_PROGRAM and, for
 * Windows Terminal, against the presence of WT_SESSION.
 */
const OSC9_TERM_PROGRAMS: ReadonlyArray<string> = [
	"iterm.app",
	"iterm2",
	"windowsterminal",
	"windows terminal",
	"conemu",
];

const BEL = "\u0007";

/**
 * Strip C0/C1 controls and the `;` an OSC payload uses as its own separator.
 *
 * The classification is by code point rather than by a character-class regex:
 * a literal control range inside a pattern is exactly the thing the payload
 * must not carry, and spelling one out is how it gets copied in by accident.
 */
function sanitizeNotifyText(text: string): string {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
		out += isControl || char === ";" ? " " : char;
	}
	return out.replace(/\s+/gu, " ").trim();
}

/** Clamp to the byte bound without splitting a multi-byte character. */
function boundNotifyBytes(text: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(text).length <= maxBytes) return text;
	let out = "";
	let used = 0;
	for (const char of text) {
		const size = encoder.encode(char).length;
		if (used + size > maxBytes) break;
		out += char;
		used += size;
	}
	return out;
}

/** The closed-vocabulary body for one event. */
export function desktopNotifyBody(event: DesktopNotifyEvent): string {
	if (event.kind === "turn-finished") return "turn finished";
	if (event.kind === "approval-needed") return "approval needed";
	const shortId = boundNotifyBytes(sanitizeNotifyText(event.shortId), 32);
	return shortId.length > 0 ? `batch ${shortId} settled` : "batch settled";
}

/** True when the environment names a terminal that answers OSC 9 rather than OSC 777. */
export function prefersOsc9(env: Readonly<Record<string, string | undefined>>): boolean {
	if (typeof env.WT_SESSION === "string" && env.WT_SESSION.length > 0) return true;
	const program = (env.TERM_PROGRAM ?? "").trim().toLowerCase();
	if (program.length === 0) return false;
	return OSC9_TERM_PROGRAMS.some((candidate) => program === candidate || program.includes(candidate));
}

/**
 * Build the one escape sequence for an event. OSC 777 is the default and
 * carries both the fixed title and the body; OSC 9 carries only the body and is
 * chosen for the terminals that implement it instead. Exactly one sequence is
 * returned, so a single event can never produce two notifications.
 */
export function buildDesktopNotifySequence(
	event: DesktopNotifyEvent,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const body = boundNotifyBytes(sanitizeNotifyText(desktopNotifyBody(event)), DESKTOP_NOTIFY_BODY_MAX_BYTES);
	if (prefersOsc9(env)) return `\u001b]9;${body}${BEL}`;
	return `\u001b]777;notify;${DESKTOP_NOTIFY_TITLE};${body}${BEL}`;
}

export interface DesktopNotifierDeps {
	/**
	 * Protocol write on the terminal owner. It happens outside a render
	 * transaction, so the trace records it with `frameId: null` and it never
	 * lands inside a frame.
	 */
	write: (data: string) => void;
	/** Live `terminal.notify`, re-read per event so a hot config reload takes effect. */
	enabled: () => boolean;
	/**
	 * True only on the interactive TTY path. Headless, ACP, and non-TTY runs
	 * pass false (or wire no notifier at all) and never emit a sequence.
	 */
	interactiveTty: () => boolean;
	env?: Readonly<Record<string, string | undefined>>;
}

export interface DesktopNotifier {
	notify(event: DesktopNotifyEvent): void;
}

/**
 * Emit content-free desktop notifications for the three operator-waiting
 * events. Every call re-checks the setting and the surface, so turning
 * `terminal.notify` off mid-session silences the next event.
 */
export function createDesktopNotifier(deps: DesktopNotifierDeps): DesktopNotifier {
	const env = deps.env ?? process.env;
	return {
		notify(event) {
			if (!deps.interactiveTty()) return;
			if (!deps.enabled()) return;
			try {
				deps.write(buildDesktopNotifySequence(event, env));
			} catch {
				// A terminal that refuses the write is not a reason to interrupt the
				// turn that produced the event.
			}
		},
	};
}

/** Minimal projection of a detached batch, matching `DetachedBatchNudgeView`. */
export interface DesktopNotifyBatchView {
	id: string;
	total: number;
	terminal: number;
}

export interface InteractiveDesktopNotificationsDeps extends DesktopNotifierDeps {
	/**
	 * Live detached-batch progress. Read on every dispatch terminal event so a
	 * batch whose last run just finished is announced exactly once.
	 */
	getOpenBatches?: () => ReadonlyArray<DesktopNotifyBatchView>;
}

export interface InteractiveDesktopNotifications {
	/** A model turn reached its end. */
	turnEnded(): void;
	/** A dispatch run reached a terminal state; announces any batch that settled with it. */
	dispatchSettled(): void;
	/** A worker permission or an ask_user request parked waiting for the operator. */
	approvalParked(): void;
}

/** Batch ids stay short in the payload: enough to tell two fan-outs apart. */
const BATCH_SHORT_ID_CHARS = 8;

/**
 * The three notification events, wired to the surfaces that produce them.
 *
 * Batch settlement has no event of its own on the bus, so it is derived: every
 * dispatch terminal event recomputes open-batch progress and any batch that
 * crossed from running to fully terminal since the last look is announced. The
 * announced set is remembered, so a batch that stays collectible for another
 * ten minutes does not re-notify on every later run.
 */
export function createInteractiveDesktopNotifications(
	deps: InteractiveDesktopNotificationsDeps,
): InteractiveDesktopNotifications {
	const notifier = createDesktopNotifier(deps);
	const announcedBatches = new Set<string>();
	return {
		turnEnded(): void {
			notifier.notify({ kind: "turn-finished" });
		},
		dispatchSettled(): void {
			const getOpenBatches = deps.getOpenBatches;
			if (!getOpenBatches) return;
			let views: ReadonlyArray<DesktopNotifyBatchView>;
			try {
				views = getOpenBatches();
			} catch {
				return;
			}
			const open = new Set<string>();
			for (const view of views) {
				open.add(view.id);
				if (view.total <= 0 || view.terminal < view.total) continue;
				if (announcedBatches.has(view.id)) continue;
				announcedBatches.add(view.id);
				notifier.notify({ kind: "batch-settled", shortId: view.id.slice(0, BATCH_SHORT_ID_CHARS) });
			}
			// A collected batch leaves the open list; forget it so its id can be
			// announced again if the store ever reuses it.
			for (const id of [...announcedBatches]) {
				if (!open.has(id)) announcedBatches.delete(id);
			}
		},
		approvalParked(): void {
			notifier.notify({ kind: "approval-needed" });
		},
	};
}

function resolveExpiry(level: NotificationLevel, addedAt: number, ttlMs: number | undefined): number | null {
	if (ttlMs !== undefined) return ttlMs <= 0 ? null : addedAt + ttlMs;
	return level === "info" || level === "success" ? addedAt + DEFAULT_INFO_TTL_MS : null;
}

function isLive(entry: Notification, now: number): boolean {
	return entry.expiresAt === null || entry.expiresAt > now;
}

function bySeverityThenRecency(a: Notification, b: Notification): number {
	return SEVERITY[b.level] - SEVERITY[a.level] || b.addedAt - a.addedAt;
}

export interface NotificationCenterOptions {
	now?: () => number;
	/** Invoked after any state change (add/dismiss/expiry) so the footer can redraw. */
	onChange?: () => void;
}

export function createNotificationCenter(options: NotificationCenterOptions = {}): NotificationCenter {
	const now = options.now ?? (() => Date.now());
	const onChange = options.onChange ?? (() => {});
	const entries: Notification[] = [];
	let counter = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const clearTimer = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const scheduleExpiry = (): void => {
		clearTimer();
		if (typeof setTimeout !== "function") return;
		const current = now();
		let next: number | null = null;
		for (const entry of entries) {
			if (entry.expiresAt === null) continue;
			if (next === null || entry.expiresAt < next) next = entry.expiresAt;
		}
		if (next === null) return;
		const delay = Math.max(0, next - current);
		timer = setTimeout(() => {
			timer = null;
			prune();
			onChange();
			scheduleExpiry();
		}, delay);
		timer.unref?.();
	};

	const prune = (): void => {
		const current = now();
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry && !isLive(entry, current)) entries.splice(i, 1);
		}
	};

	return {
		add(input) {
			const addedAt = now();
			counter += 1;
			const id = `notice-${counter}`;
			const expiresAt = resolveExpiry(input.level, addedAt, input.ttlMs);
			const entry: Notification = {
				id,
				level: input.level,
				text: input.text,
				key: input.key ?? null,
				addedAt,
				expiresAt,
			};
			if (entry.key !== null) {
				const existing = entries.findIndex((candidate) => candidate.key === entry.key);
				if (existing >= 0) entries.splice(existing, 1);
			}
			entries.push(entry);
			scheduleExpiry();
			onChange();
			return id;
		},
		dismiss(idOrKey) {
			const before = entries.length;
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				const entry = entries[i];
				if (entry && (entry.id === idOrKey || entry.key === idOrKey)) entries.splice(i, 1);
			}
			const removed = entries.length < before;
			if (removed) {
				scheduleExpiry();
				onChange();
			}
			return removed;
		},
		dismissAll() {
			if (entries.length === 0) return;
			entries.length = 0;
			clearTimer();
			onChange();
		},
		list(at) {
			const current = at ?? now();
			return entries.filter((entry) => isLive(entry, current)).sort(bySeverityThenRecency);
		},
		count(at) {
			const current = at ?? now();
			return entries.reduce((sum, entry) => sum + (isLive(entry, current) ? 1 : 0), 0);
		},
		hasBlocking(at) {
			const current = at ?? now();
			return entries.some((entry) => isLive(entry, current) && entry.level !== "info");
		},
	};
}

function highestSeverity(entries: ReadonlyArray<Notification>): NotificationLevel {
	let level: NotificationLevel = "info";
	for (const entry of entries) {
		if (SEVERITY[entry.level] > SEVERITY[level]) level = entry.level;
	}
	return level;
}

/**
 * Compact one-line badge for the always-on footer. Returns null when there is
 * nothing to show. Shows the most-severe glyph, a count, the leading message,
 * and the dismiss affordance, balanced to the available width.
 */
export function formatNotificationBadge(
	entries: ReadonlyArray<Notification>,
	width: number,
	options: { dismissKeyLabel?: string; theme?: ClioTheme } = {},
): string | null {
	if (entries.length === 0) return null;
	const theme = options.theme ?? clioTheme();
	const level = highestSeverity(entries);
	const token = notificationToken(level);
	const glyph = notificationGlyph(level);
	const count = entries.length;
	const noun = count === 1 ? "notice" : "notices";
	const lead = entries[0]?.text ?? "";
	const dismiss = options.dismissKeyLabel ?? "Alt+X";
	const compactHead = theme.fg(token, `${glyph} ${count}`);
	const head = theme.fg(token, `${glyph} ${count} ${noun}`);
	const separator = ` ${theme.fg("dim", "·")} `;
	const hint = theme.fg("dim", `[${dismiss}] dismiss`);
	const safeWidth = Math.max(1, Math.floor(width));
	const minimum = `${compactHead}${separator}${hint}`;
	const compactHint = `${compactHead}${separator}${theme.fg("dim", `[${dismiss}]`)}`;
	const fallback = [minimum, compactHint, compactHead, theme.fg(token, glyph)].find(
		(candidate) => visibleWidth(candidate) <= safeWidth,
	);
	const messageWidth = safeWidth - visibleWidth(head) - visibleWidth(separator) * 2 - visibleWidth(hint);
	// A one-column message can show only an ellipsis, which says less than the
	// compact head/action fallback. The explicit ladder also keeps narrow
	// footers from hard-clipping the dismiss key in the middle of a word.
	if (messageWidth < 2) return fallback ?? theme.fg(token, glyph);
	let body: string;
	if (visibleWidth(lead) <= messageWidth) {
		body = theme.fg("muted", lead);
	} else {
		const clipped = truncateToWidth(lead, messageWidth - 1, "", false);
		if (visibleWidth(clipped) === 0) return fallback ?? theme.fg(token, glyph);
		body = `${theme.fg("muted", clipped)}${theme.fg("muted", "…")}`;
	}
	return `${head}${separator}${body}${separator}${hint}`;
}

/**
 * Expanded notices panel for the dashboard. The entry count is capped so a
 * noisy boot cannot take over the dashboard, but every included notice wraps
 * in full: this is the detail surface that the compact badge points toward.
 */
export function formatNotificationPanel(
	entries: ReadonlyArray<Notification>,
	width: number,
	options: { maxRows?: number; dismissKeyLabel?: string; theme?: ClioTheme } = {},
): string[] {
	if (entries.length === 0) return [];
	const theme = options.theme ?? clioTheme();
	const maxRows = Math.max(1, options.maxRows ?? 4);
	const dismiss = options.dismissKeyLabel ?? "Alt+X";
	const lines: string[] = [rule(theme, width, { left: "notices" })];
	for (const entry of entries.slice(0, maxRows)) {
		const glyph = theme.fg(notificationToken(entry.level), notificationGlyph(entry.level));
		const prefix = `${glyph} `;
		const prefixWidth = visibleWidth(prefix);
		const wrapped = wrapTextWithAnsi(theme.fg("muted", entry.text), Math.max(1, width - prefixWidth));
		lines.push(
			...wrapped.map((line, index) =>
				fitFooterText(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`, width),
			),
		);
	}
	const overflow = entries.length - maxRows;
	const hint = overflow > 0 ? `+${overflow} more · ${dismiss} dismiss` : `${dismiss} dismiss`;
	lines.push(fitFooterText(theme.fg("dim", hint), width));
	return lines;
}
