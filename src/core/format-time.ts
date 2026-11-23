/**
 * The one place a stored UTC instant becomes an operator-local string.
 *
 * Everything durable is written and compared as `toISOString()`. Conversion to
 * the operator's zone happens here, at the render boundary, and nowhere else.
 * Machine surfaces bypass this module entirely: filenames, ids, log lines, and
 * receipt fields keep raw `toISOString()` so another program can parse them.
 *
 * `Intl.DateTimeFormat` resolves its zone at construction and never re-reads it,
 * so a formatter built at module load would ignore a later `process.env.TZ`
 * mutation. Tests do mutate it (tests/contracts/memory-overlay.test.ts:102). The
 * formatters therefore live at module scope, built on first use, and are rebuilt
 * only when the env var no longer matches the zone they were built for. The steady
 * state is one string comparison per call, not one `Intl` construction per call.
 *
 * It also holds the one formatter family for quantities a surface prints (elapsed
 * time, wait clocks, countdowns, configured limits, counts and context fill), so
 * the pane process, which cannot import `src/interactive`, prints them the same way.
 */

import { asciiOnly } from "./terminal-preferences.js";

/** Anything a caller already holds: an ISO string, epoch millis, or a Date. */
export type Instant = Date | number | string;

/** What every export returns when the instant is absent or unparseable. */
const MISSING = "—";

const CLOCK_OPTIONS: Intl.DateTimeFormatOptions = {
	hourCycle: "h23",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
};
const DATE_OPTIONS: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
const DAY_OPTIONS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/** A turn receipt's hour and minute in the operator's time locale: `18:42`, or `6:42 PM` where the locale says so. */
const WALL_CLOCK_OPTIONS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
/** Without a usable locale (unset, `C`, `POSIX`) the wall clock keeps the 24-hour form those locales use. */
const WALL_CLOCK_FALLBACK: Intl.DateTimeFormatOptions = { hourCycle: "h23", hour: "2-digit", minute: "2-digit" };

/**
 * The POSIX time locale as a BCP 47 tag: `LC_ALL`, then `LC_TIME`, then `LANG`,
 * the order a C program's `strftime` reads them. ICU's own default follows
 * `LC_MESSAGES` instead, which is not the setting for how a clock reads.
 */
function timeLocale(): string | undefined {
	const raw = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG;
	const tag = raw?.split(/[.@]/u)[0]?.replace(/_/gu, "-");
	if (!tag || tag === "C" || tag === "POSIX") return undefined;
	try {
		return Intl.DateTimeFormat.supportedLocalesOf(tag)[0];
	} catch {
		return undefined;
	}
}

function buildWallClock(zone: Intl.DateTimeFormatOptions | undefined): Intl.DateTimeFormat {
	const locale = timeLocale();
	return locale === undefined
		? new Intl.DateTimeFormat("en-GB", { ...WALL_CLOCK_FALLBACK, ...zone })
		: new Intl.DateTimeFormat(locale, { ...WALL_CLOCK_OPTIONS, ...zone });
}

const localeEnv = (): string => `${process.env.LC_ALL}|${process.env.LC_TIME}|${process.env.LANG}`;

interface ZoneFormatters {
	zone: string | undefined;
	locale: string;
	clock: Intl.DateTimeFormat;
	date: Intl.DateTimeFormat;
	day: Intl.DateTimeFormat;
	wallClock: Intl.DateTimeFormat;
}

/** Built on first use: this module loads with the first frame, which formats no instant. */
let built: ZoneFormatters | null = null;

function zoneFormatters(): ZoneFormatters {
	const zoneName = process.env.TZ;
	const locale = localeEnv();
	if (built !== null && built.zone === zoneName && built.locale === locale) return built;
	// The zone is passed explicitly, not left for Intl to pick up from
	// process.env.TZ implicitly, because it doesn't reliably do so: under a
	// shared test process that constructs many formatters across many zones,
	// a rebuilt formatter was observed to resolve to America/Chicago while
	// process.env.TZ read Asia/Kolkata at the exact moment of construction
	// and of the .format() call right after (issue #84, tests/contracts
	// instrumentation traced it to Intl's own zone resolution, not a stale
	// env var). An explicit timeZone option bypasses whatever cached default
	// resolution goes stale there, so this is correct regardless of whether
	// that turns out to be a V8/ICU bug that ever gets fixed. Do not "simplify"
	// this back to relying on process.env.TZ implicitly.
	const zone = zoneName === undefined ? undefined : { timeZone: zoneName };
	built = {
		zone: zoneName,
		locale,
		clock: new Intl.DateTimeFormat("en-GB", { ...CLOCK_OPTIONS, ...zone }),
		date: new Intl.DateTimeFormat("en-CA", { ...DATE_OPTIONS, ...zone }),
		day: new Intl.DateTimeFormat("en-US", { ...DAY_OPTIONS, ...zone }),
		wallClock: buildWallClock(zone),
	};
	return built;
}

function toEpochMs(instant: Instant): number | null {
	const ms =
		typeof instant === "number" ? instant : typeof instant === "string" ? Date.parse(instant) : instant.getTime();
	return Number.isFinite(ms) ? ms : null;
}

/** Operator-local `HH:MM:SS`. */
export function clockLocal(instant: Instant): string {
	const ms = toEpochMs(instant);
	if (ms === null) return MISSING;
	return zoneFormatters().clock.format(ms);
}

/** Operator-local `YYYY-MM-DD`. */
export function dateLocal(instant: Instant): string {
	const ms = toEpochMs(instant);
	if (ms === null) return MISSING;
	return zoneFormatters().date.format(ms);
}

/**
 * Operator-local instant: `HH:MM:SS` when it falls on today's local date,
 * `YYYY-MM-DD HH:MM:SS` otherwise. The one presentation for an exact time on
 * an operator surface, so a row never sits in UTC beside a row in local time.
 */
export function stampLocal(instant: Instant, now: number = Date.now()): string {
	const ms = toEpochMs(instant);
	if (ms === null) return MISSING;
	const date = dateLocal(ms);
	return date === dateLocal(now) ? clockLocal(ms) : `${date} ${clockLocal(ms)}`;
}

/**
 * Operator-local wall clock to the minute in the operator's time locale
 * (`18:42` or `6:42 PM`) when the instant falls on today's local date,
 * `Nov 16 18:42` on another day of this year, and `Nov 16 2025 18:42` in
 * another year. A turn receipt reads it at a glance.
 */
export function wallClockLocal(instant: Instant, now: number = Date.now()): string {
	const ms = toEpochMs(instant);
	if (ms === null) return MISSING;
	const date = dateLocal(ms);
	const today = dateLocal(now);
	const clock = zoneFormatters().wallClock.format(ms);
	if (date === today) return clock;
	const year = date.slice(0, 4) === today.slice(0, 4) ? "" : ` ${date.slice(0, 4)}`;
	return `${zoneFormatters().day.format(ms)}${year} ${clock}`;
}

/**
 * Coarse age ("3m ago", "yesterday"), falling back to `dateLocal` past 30 days.
 * The week branch resolves the divergence between the two existing copies:
 * session-selector had it, welcome-dashboard did not, so the same artifact read
 * "1w ago" in one surface and "10d ago" in the other.
 */
export function relative(instant: Instant, now: number = Date.now()): string {
	const ms = toEpochMs(instant);
	if (ms === null) return MISSING;
	const sec = Math.floor((now - ms) / 1000);
	if (sec < 5) return "just now";
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day === 1) return "yesterday";
	if (day < 7) return `${day}d ago`;
	if (day < 30) return `${Math.floor(day / 7)}w ago`;
	return dateLocal(ms);
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * Elapsed time, live or settled: `83ms`, `4.4s`, `13s`, `1m07s`, `2h05m`, `100h+`. Each form rounds before it is
 * chosen, so a value never prints as `60s` or `10.0s`: 9.95 s is `10s`, 59.5 s is `1m00s`, 3599.5 s is `1h00m`.
 * The widest value is 6 cells (`12h05m`), the run row's time slot.
 */
export function formatElapsed(value: number): string {
	const ms = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
	if (ms < SECOND_MS) return `${ms}ms`;
	const tenths = Math.round(ms / 100);
	if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
	const seconds = Math.round(ms / SECOND_MS);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${pad2(seconds % 60)}s`;
	const minutes = Math.round(ms / MINUTE_MS);
	const hours = Math.floor(minutes / 60);
	return hours >= 100 ? "100h+" : `${hours}h${pad2(minutes % 60)}m`;
}

/** A running wait in whole seconds, then as elapsed: tenths on a live clock read as jitter (`6s`, `18s`, `1m07s`). */
export function formatWaitClock(elapsedMs: number): string {
	const seconds = Math.floor(Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / SECOND_MS);
	return seconds < 10 ? `${seconds}s` : formatElapsed(seconds * SECOND_MS);
}

/** Time left to a deadline, always `M:SS` (`3:32`, `0:09`), so the clock keeps one shape as it crosses a minute. */
export function formatCountdown(ms: number): string {
	const seconds = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / SECOND_MS));
	return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
}

/** A configured limit in its largest whole unit: `45s`, `10m`, `30m`, `2h`; `90s` stays `90s`. */
export function formatLimit(ms: number): string {
	const value = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
	if (value === 0) return "0s";
	if (value % HOUR_MS === 0) return `${value / HOUR_MS}h`;
	if (value % MINUTE_MS === 0) return `${value / MINUTE_MS}m`;
	if (value % SECOND_MS === 0) return `${value / SECOND_MS}s`;
	return formatElapsed(value);
}

const COUNT_UNITS: ReadonlyArray<{ size: number; suffix: string }> = [
	{ size: 1e3, suffix: "k" },
	{ size: 1e6, suffix: "M" },
	{ size: 1e9, suffix: "G" },
];

/**
 * A count on a shared row in lower-case SI, one decimal under 100 of a unit: `881`, `2.4k`, `15.2k`, `272k`, `1.2M`.
 * Rounding comes first, so 999.6 is `1.0k` and 99,960 is `100k`, never `1000` or `100.0k`.
 */
export function formatCount(n: number): string {
	if (!Number.isFinite(n)) return MISSING;
	const sign = n < 0 ? "-" : "";
	const whole = Math.round(Math.abs(n));
	if (whole < 1000) return `${sign}${whole}`;
	for (const [index, unit] of COUNT_UNITS.entries()) {
		const scaled = whole / unit.size;
		const tenths = Math.round(scaled * 10);
		if (tenths < 1000) return `${sign}${(tenths / 10).toFixed(1)}${unit.suffix}`;
		const rounded = Math.round(scaled);
		if (rounded < 1000 || index === COUNT_UNITS.length - 1) return `${sign}${rounded}${unit.suffix}`;
	}
	return `${sign}${whole}`;
}

/** Where a context figure came from: a provider's count, CLIO Coder's estimate, or a restored session's last count. */
export type FillSource = "measured" | "estimated" | "saved";

/**
 * Context fill as `used/window percent` with its source's qualifier: `16.8k/272k 6%`, `≈16.8k/272k 6%`,
 * `saved 16.8k/272k 6%`. Before anything is measured it is the window alone (`272k`).
 */
export function formatFill(
	used: number | null | undefined,
	window: number | null | undefined,
	source: FillSource,
): string {
	const hasWindow = typeof window === "number" && Number.isFinite(window) && window > 0;
	if (typeof used !== "number" || !Number.isFinite(used)) return hasWindow ? formatCount(window) : MISSING;
	const lead = source === "estimated" ? (asciiOnly() ? "~" : "≈") : source === "saved" ? "saved " : "";
	if (!hasWindow) return `${lead}${formatCount(used)}`;
	const percent = Math.round((Math.max(0, used) / window) * 100);
	return `${lead}${formatCount(used)}/${formatCount(window)} ${percent}%`;
}

/** The operator's IANA zone: `TZ` when set, else the zone Intl resolves for this process. */
function operatorTimeZone(): string {
	const configured = process.env.TZ;
	if (configured !== undefined && configured.length > 0) return configured;
	return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

/** `UTC-06:00` for the zone at this instant, so a daylight-saving change shows. */
function utcOffset(ms: number, zone: string): string {
	try {
		const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
			.formatToParts(ms)
			.find((part) => part.type === "timeZoneName")?.value;
		if (name === undefined || name === "GMT") return "UTC+00:00";
		return name.replace(/^GMT/u, "UTC");
	} catch {
		// An unknown zone name renders no offset rather than throwing into a prompt.
		return "";
	}
}

/**
 * The operator's calendar facts at an instant: local date, weekday, `HH:MM`,
 * zone and offset. Models otherwise date ids and records from their training
 * prior, and one named an archive for the day after the operator's today
 * (WTF-P 0.8.3 A4).
 */
export function operatorCalendar(instant: Instant = Date.now()): {
	date: string;
	weekday: string;
	time: string;
	zone: string;
} {
	const ms = toEpochMs(instant) ?? Date.now();
	const formatters = zoneFormatters();
	const zoneName = operatorTimeZone();
	const offset = utcOffset(ms, zoneName);
	let weekday = "";
	try {
		weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: zoneName }).format(ms);
	} catch {
		// Same as the offset: an unknown zone drops the weekday, never the date.
	}
	return {
		date: formatters.date.format(ms),
		weekday,
		time: formatters.clock.format(ms).slice(0, 5),
		zone: offset.length > 0 ? `${zoneName} (${offset})` : zoneName,
	};
}
