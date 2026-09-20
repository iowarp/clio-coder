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
export function formatCost(value: number | null | undefined) {
	if (value == null || !Number.isFinite(value)) return "not recorded";
	return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}
export const formatTokens = (value: number | null | undefined) =>
	value == null ? "not recorded" : value.toLocaleString("en-US");
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
export function formatDuration(value: number) {
	const ms = Math.max(0, value || 0);
	return ms < 1000
		? `${Math.round(ms)}ms`
		: ms < 60000
			? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
			: `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
