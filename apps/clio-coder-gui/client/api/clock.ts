export function serverClock(now: () => number = Date.now) {
	let adopted = false,
		offset = 0;
	return {
		adopt(header: string | null) {
			const value = header ? Date.parse(header) : Number.NaN;
			if (!adopted && Number.isFinite(value)) {
				offset = value - now();
				adopted = true;
			}
		},
		now: () => now() + offset,
	};
}
export const clock = serverClock();
export function formatCost(
	value: number | null | undefined,
	accounting?: { cost_estimated?: number | null; cost_unknown?: number | null },
) {
	if (value == null || !Number.isFinite(value)) return "not recorded";
	const amount = `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
	if (!accounting) return amount;
	if (accounting.cost_estimated == null && accounting.cost_unknown == null) return `${amount} (pricing unknown)`;
	if (accounting.cost_unknown && value === 0) return "Cost not measured";
	return `${accounting.cost_estimated ? "about " : ""}${amount}${accounting.cost_unknown ? " subtotal, some calls unpriced" : ""}`;
}
export const formatTokens = (value: number | null | undefined, missingTokenCalls?: number | null) =>
	`${value == null ? "not recorded" : value.toLocaleString("en-US")}${missingTokenCalls ? ` +? (${missingTokenCalls} call${missingTokenCalls === 1 ? "" : "s"} missing usage)` : ""}`;
const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
const time = new Intl.DateTimeFormat("en-GB", {
	hourCycle: "h23",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
});
export function formatTime(value: string | null | undefined) {
	const instant = value ? new Date(value) : new Date(Number.NaN);
	return Number.isFinite(instant.valueOf()) ? `${date.format(instant)} ${time.format(instant)}` : "not recorded";
}
const minute = new Intl.DateTimeFormat("en-GB", { hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
/** The clock alone for an instant today, and the day with it for any other; seconds are for the title. */
export function formatClock(value: string | null | undefined, now: Date = new Date()) {
	const instant = value ? new Date(value) : new Date(Number.NaN);
	if (!Number.isFinite(instant.valueOf())) return "not recorded";
	return date.format(instant) === date.format(now)
		? minute.format(instant)
		: `${date.format(instant)} ${minute.format(instant)}`;
}
/**
 * A window boundary is a day, not an instant; the clock digits in it are noise. A value that is
 * already a day is returned as it was sent: `new Date("2026-08-21")` is UTC midnight, and rendering
 * that in a local zone behind UTC moves the window a day into the past.
 */
export function formatDay(value: string | null | undefined) {
	if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const instant = value ? new Date(value) : new Date(Number.NaN);
	return Number.isFinite(instant.valueOf()) ? date.format(instant) : "not recorded";
}
export function formatDuration(value: number) {
	const ms = Math.max(0, value || 0);
	if (ms < 999.5) return `${Math.round(ms)}ms`;
	// Round once at the unit shown, then split, so 599.6 s carries to 10m 0s rather than 9m 60s.
	const tenths = Math.round(ms / 100);
	if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
