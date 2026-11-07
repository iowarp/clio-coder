import type { CostReportV1 } from "../../contracts/wire.js";
import { quantityParts } from "../telemetry/quantity-model.js";

export function rankedMetricGroups(report: CostReportV1 | undefined, search: string) {
	const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return (report?.groups ?? [])
		.filter((row) => terms.every((term) => row.key.toLocaleLowerCase().includes(term)))
		.sort(
			(a, b) =>
				(quantityParts(b.tokens).amount ?? -1) - (quantityParts(a.tokens).amount ?? -1) || a.key.localeCompare(b.key),
		);
}

/** Nulls split the line: an unrecorded attempt must not become a zero or a bridge between measurements. */
export function sparkline(values: readonly (number | null)[]) {
	const known = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
	const ceiling = Math.max(0, ...known);
	const segments: Array<Array<{ x: number; y: number }>> = [];
	let segment: Array<{ x: number; y: number }> = [];
	for (const [index, value] of values.entries()) {
		if (value === null || !Number.isFinite(value) || value < 0) {
			if (segment.length) segments.push(segment);
			segment = [];
			continue;
		}
		segment.push({
			x: values.length > 1 ? 2 + (index * 156) / (values.length - 1) : 80,
			y: ceiling > 0 ? 26 - (value * 22) / ceiling : 15,
		});
	}
	if (segment.length) segments.push(segment);
	return segments;
}
