export function wallTimeMetric(metrics: Readonly<Record<string, unknown>>): number {
	const value = metrics["latency.wallMs"];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
