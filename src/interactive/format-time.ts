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

let builtForZone = process.env.TZ;
let clockFormatter = new Intl.DateTimeFormat("en-GB", CLOCK_OPTIONS);
let dateFormatter = new Intl.DateTimeFormat("en-CA", DATE_OPTIONS);

function syncZone(): void {
	if (process.env.TZ === builtForZone) return;
	builtForZone = process.env.TZ;
	clockFormatter = new Intl.DateTimeFormat("en-GB", CLOCK_OPTIONS);
	dateFormatter = new Intl.DateTimeFormat("en-CA", DATE_OPTIONS);
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
