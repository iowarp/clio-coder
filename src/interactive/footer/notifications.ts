/**
 * NotificationCenter: a dedicated harness→user surface anchored in the footer
 * region. Harness messages (CLIO.md hints, keybinding notices, connect/probe
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

import { fitFooterText } from "../footer-panel.js";
import { type ClioTheme, type ClioToken, clioTheme, GLYPH, rule } from "../theme/index.js";

export type NotificationLevel = "info" | "warning" | "error";

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

/** Info notices fade on their own; warnings and errors persist until dismissed. */
export const DEFAULT_INFO_TTL_MS = 12_000;

const SEVERITY: Record<NotificationLevel, number> = { error: 3, warning: 2, info: 1 };

export function notificationGlyph(level: NotificationLevel): string {
	if (level === "error") return GLYPH.error;
	if (level === "warning") return GLYPH.warn;
	return GLYPH.info;
}

export function notificationToken(level: NotificationLevel): ClioToken {
	if (level === "error") return "error";
	if (level === "warning") return "warning";
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

function resolveExpiry(level: NotificationLevel, addedAt: number, ttlMs: number | undefined): number | null {
	if (ttlMs !== undefined) return ttlMs <= 0 ? null : addedAt + ttlMs;
	return level === "info" ? addedAt + DEFAULT_INFO_TTL_MS : null;
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
	const head = theme.fg(token, `${glyph} ${count} ${noun}`);
	const body = theme.fg("muted", lead);
	const hint = theme.fg("dim", `${dismiss} dismiss`);
	return fitFooterText(`${head} ${theme.fg("dim", "·")} ${body} ${theme.fg("dim", "·")} ${hint}`, width);
}

/**
 * Expanded notices panel for the dashboard. Header rule + one styled line per
 * entry, capped so a noisy boot cannot push the dashboard off-screen.
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
		lines.push(fitFooterText(`${glyph} ${theme.fg("muted", entry.text)}`, width));
	}
	const overflow = entries.length - maxRows;
	const hint = overflow > 0 ? `+${overflow} more · ${dismiss} dismiss` : `${dismiss} dismiss`;
	lines.push(fitFooterText(theme.fg("dim", hint), width));
	return lines;
}
