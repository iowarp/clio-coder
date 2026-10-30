import type { Quantity } from "../../src/core/telemetry/dto.js";
import { parseFactRef } from "../../src/core/telemetry/dto.js";

/**
 * The #434 §13.1 lie detectors over read-model quantities, shared by the root parity tests and the GUI route tests.
 * Each detector returns the violations it found as `ref: display` lines, so a caller asserts an empty list and a
 * failure names every offending number at once. The explain half of L5 needs a source, so the caller compares
 * `explain(ref)` with each quantity itself.
 */

/** Every `{ fact, display, ref }` quantity inside a DTO, in document order. */
export function quantitiesOf(value: unknown, out: Quantity[] = []): Quantity[] {
	if (Array.isArray(value)) for (const item of value) quantitiesOf(item, out);
	else if (value && typeof value === "object") {
		if ("fact" in value && "display" in value && "ref" in value) out.push(value as Quantity);
		else for (const item of Object.values(value)) quantitiesOf(item, out);
	}
	return out;
}

const ZERO = /^(?:~?\$?0(?:\.0+)?|\$0\.00 local)$/;
const ABSENT = new Set(["n/a", "not captured (standard mode)"]);

/** L5, reference half: every quantity names a parsable reference. */
export function unparsableRefs(quantities: readonly Quantity[]): string[] {
	return quantities.filter((quantity) => !parseFactRef(quantity.ref)).map((quantity) => `${quantity.ref}: unparsable`);
}

/** L1 and L3: unknown is never zero, and a partial sum reads as a lower bound or an unknown, never as a total. */
export function unknownRenderedAsTotal(quantities: readonly Quantity[]): string[] {
	const lies: string[] = [];
	for (const { fact, display, ref } of quantities) {
		if ("kind" in fact) {
			if (fact.kind === "unknown" && (ZERO.test(display) || !/unknown|not measured/.test(display)))
				lies.push(`${ref}: ${display}`);
			continue;
		}
		if (fact.unknownCount === 0) continue;
		const known = fact.coverage.measured + fact.coverage.estimated > 0;
		if (ZERO.test(display) || !(known ? /≥|\+\?/.test(display) : /unknown|not measured/.test(display)))
			lies.push(`${ref}: ${display}`);
	}
	return lies;
}

/** L5, display half: an estimate, or a sum with estimated parts, carries the `~` mark. */
export function unmarkedEstimates(quantities: readonly Quantity[]): string[] {
	return quantities
		.filter(({ fact, display }) =>
			("kind" in fact ? fact.kind === "estimated" : fact.coverage.estimated > 0) ? !display.includes("~") : false,
		)
		.map(({ ref, display }) => `${ref}: ${display}`);
}

/** L9: an absent fact, or a sum whose only contributions are absent, renders as not applicable. */
export function absentRenderedOtherwise(quantities: readonly Quantity[]): string[] {
	return quantities
		.filter(({ fact, display }) => {
			const absent =
				"kind" in fact
					? fact.kind === "absent"
					: fact.absentCount > 0 && fact.coverage.measured + fact.coverage.estimated + fact.unknownCount === 0;
			return absent && !ABSENT.has(display);
		})
		.map(({ ref, display }) => `${ref}: ${display}`);
}

/** Every detector that needs no explain source, over one list of quantities. */
export function telemetryLies(quantities: readonly Quantity[]): string[] {
	return [
		...unparsableRefs(quantities),
		...unknownRenderedAsTotal(quantities),
		...unmarkedEstimates(quantities),
		...absentRenderedOtherwise(quantities),
	];
}
