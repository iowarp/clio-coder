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
 * formatters therefore live at module scope, built once, and are rebuilt only
 * when the env var no longer matches the zone they were built for. The steady
 * state is one string comparison per call, not one `Intl` construction per call.
 */

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

let builtForZone = process.env.TZ;
let builtForLocale = localeEnv();
let clockFormatter = new Intl.DateTimeFormat("en-GB", CLOCK_OPTIONS);
let dateFormatter = new Intl.DateTimeFormat("en-CA", DATE_OPTIONS);
let dayFormatter = new Intl.DateTimeFormat("en-US", DAY_OPTIONS);
let wallClockFormatter = buildWallClock(undefined);

function syncZone(): void {
	if (process.env.TZ === builtForZone && localeEnv() === builtForLocale) return;
	builtForZone = process.env.TZ;
	builtForLocale = localeEnv();
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
	const zone = builtForZone === undefined ? undefined : { timeZone: builtForZone };
	clockFormatter = new Intl.DateTimeFormat("en-GB", { ...CLOCK_OPTIONS, ...zone });
	dateFormatter = new Intl.DateTimeFormat("en-CA", { ...DATE_OPTIONS, ...zone });
	dayFormatter = new Intl.DateTimeFormat("en-US", { ...DAY_OPTIONS, ...zone });
	wallClockFormatter = buildWallClock(zone);
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
	syncZone();
	return clockFormatter.format(ms);
}

/** Operator-local `YYYY-MM-DD`. */
export function dateLocal(instant: Instant): string {
	const ms = toEpochMs(instant);
	if (ms === null) return MISSING;
	syncZone();
	return dateFormatter.format(ms);
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
	const clock = wallClockFormatter.format(ms);
	if (date === today) return clock;
	const year = date.slice(0, 4) === today.slice(0, 4) ? "" : ` ${date.slice(0, 4)}`;
	return `${dayFormatter.format(ms)}${year} ${clock}`;
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
	syncZone();
	const zoneName = operatorTimeZone();
	const offset = utcOffset(ms, zoneName);
	let weekday = "";
	try {
		weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: zoneName }).format(ms);
	} catch {
		// Same as the offset: an unknown zone drops the weekday, never the date.
	}
	return {
		date: dateFormatter.format(ms),
		weekday,
		time: clockFormatter.format(ms).slice(0, 5),
		zone: offset.length > 0 ? `${zoneName} (${offset})` : zoneName,
	};
}
