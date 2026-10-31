import type { Quantity } from "../../src/core/telemetry/dto.js";
import { parseFactRef } from "../../src/core/telemetry/dto.js";
import { Disposition, FailureCause, RoundKind, RunTerminalReason, StopReason } from "../../src/core/telemetry/enums.js";
import type { FactSum } from "../../src/core/telemetry/fact.js";
import { CallSettledSchema, KIND_REGISTRY } from "../../src/core/telemetry/schemas.js";

/**
 * The #434 §13.1 lie detectors over read-model DTOs, shared by the root parity tests and the GUI route tests.
 * Each detector returns the violations it found as `ref: display` or `path: …` lines, so a caller asserts an empty
 * list and a failure names every offending value at once. L1, L3, L5 and L9 read quantities; L4, L6, L7, L8 and L10
 * read the DTO's structure. The explain half of L5 needs a source, so the caller compares `explain(ref)` with each
 * quantity itself.
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

type Node = Record<string, unknown>;
type Fact = { kind: string; value?: unknown; source?: string };

/** Every object inside a DTO with its JSON path, in document order. */
function objectsOf(value: unknown, path = "$", out: Array<[string, Node]> = []): Array<[string, Node]> {
	if (Array.isArray(value)) for (const [index, item] of value.entries()) objectsOf(item, `${path}[${index}]`, out);
	else if (value && typeof value === "object") {
		out.push([path, value as Node]);
		for (const [key, item] of Object.entries(value)) objectsOf(item, `${path}.${key}`, out);
	}
	return out;
}

const isQuantity = (value: unknown): value is Quantity =>
	!!value && typeof value === "object" && "fact" in value && "display" in value && "ref" in value;
const single = (quantity: Quantity): Fact | null => ("kind" in quantity.fact ? (quantity.fact as Fact) : null);
/** Whether a quantity shows a number: wholly known, or with `partly` a lower bound with a known part. */
const shows = (quantity: Quantity, partly: boolean): boolean => {
	const fact = quantity.fact as Fact | FactSum;
	if ("kind" in fact) return fact.kind === "measured" || fact.kind === "estimated";
	return (partly || fact.unknownCount === 0) && fact.coverage.measured + fact.coverage.estimated > 0;
};

/**
 * L4: a cache verdict is a label for a number. A call's cache verdict shows the uncached prefill it was judged on;
 * a timeline call's shows the call's tokens, which may stay a lower bound when only the output went unreported.
 */
export function verdictsWithoutTokens(dto: unknown): string[] {
	const lies: string[] = [];
	for (const [path, node] of objectsOf(dto)) {
		const verdict = node.verdict ?? node.cacheVerdict;
		if (typeof verdict !== "string" || verdict === "unknown") continue;
		const cache = "verdict" in node;
		const number = cache ? node.uncachedPrefill : node.tokens;
		if (!isQuantity(number) || !shows(number, !cache)) lies.push(`${path}: ${verdict} without its tokens`);
	}
	return lies;
}

/** L6: a fact nothing measured never reads as false, no or off. */
export function unmeasuredRenderedAsFalse(dto: unknown): string[] {
	const lies: string[] = [];
	for (const [path, node] of objectsOf(dto)) {
		if (!("fact" in node) || !("display" in node) || typeof node.display !== "string") continue;
		const fact = node.fact as Fact;
		if (
			"kind" in fact &&
			fact.kind !== "measured" &&
			fact.kind !== "estimated" &&
			/^(?:false|no|off)$/i.test(node.display)
		)
			lies.push(`${path}: ${fact.kind} reads ${node.display}`);
	}
	return lies;
}

/**
 * L7: every amount is priced by the shared policy (call-facts.ts): a provider's own cost, declared target rates or a
 * free route measure it, the catalog estimates it, and anything else is unknown and priced by nothing. A fold's
 * coverage then matches its pricing counts; only the read's own unknown contributions add to `none`.
 */
export function costsOffPolicy(dto: unknown): string[] {
	const lies: string[] = [];
	for (const [path, node] of objectsOf(dto)) {
		const { usd, pricedBy } = node;
		if (!isQuantity(usd) || pricedBy === undefined) continue;
		const fact = single(usd);
		if (fact && typeof pricedBy === "string") {
			const policy =
				fact.kind === "measured"
					? fact.source === "provider"
						? ["provider"]
						: fact.value === 0
							? ["target-rates", "free"]
							: ["target-rates"]
					: fact.kind === "estimated"
						? ["catalog"]
						: ["none"];
			if (!policy.includes(pricedBy)) lies.push(`${path}: ${fact.kind} usd priced by ${pricedBy}`);
		} else if (!fact && pricedBy && typeof pricedBy === "object") {
			const sum = usd.fact as FactSum;
			const counts = pricedBy as Record<string, number>;
			const measured = (counts.provider ?? 0) + (counts["target-rates"] ?? 0) + (counts.free ?? 0);
			if (
				sum.coverage.measured !== measured ||
				sum.coverage.estimated !== (counts.catalog ?? 0) ||
				sum.unknownCount < (counts.none ?? 0)
			)
				lies.push(`${path}: usd coverage ${JSON.stringify(sum.coverage)} against pricing ${JSON.stringify(counts)}`);
		}
	}
	return lies;
}

const HASH = /^(?:obj_|sha256:)?[0-9a-f]{40,}$/;
const R7_LABELS = new Set(["commitment", "resolvable"]);

/** L8: a hash in a DTO is an object reference that names its function, canonicalization, subject and R7 label. */
export function unlabelledHashes(dto: unknown): string[] {
	const lies: string[] = [];
	for (const [path, node] of objectsOf(dto))
		for (const [key, value] of Object.entries(node)) {
			if (typeof value !== "string" || !HASH.test(value)) continue;
			const labelled = R7_LABELS.has(node.label as string) && !!node.function && !!node.canonicalization && !!node.subject;
			if (!labelled) lies.push(`${path}.${key}: ${value.slice(0, 16)}… has no R7 label`);
		}
	return lies;
}

const COLD_REASONS = CallSettledSchema.properties.cache.properties.expectedColdReasons.items.enum as string[];
const CHANNEL_FAILURES = (KIND_REGISTRY["worker.channel"].schema as { properties: { failure: { enum: string[] } } })
	.properties.failure.enum;
const VERDICTS = CallSettledSchema.properties.cache.properties.verdict.enum as string[];
/** The classifiers a DTO carries, each with the closed vocabulary its value comes from. */
const CLASSIFIERS: Record<string, ReadonlySet<string>> = {
	cause: new Set([...FailureCause.enum, ...COLD_REASONS, "unattributed"]),
	failure: new Set([...FailureCause.enum, ...CHANNEL_FAILURES]),
	expectedColdReasons: new Set(COLD_REASONS),
	disposition: new Set([...Disposition.enum, "incomplete"]),
	verdict: new Set(VERDICTS),
	cacheVerdict: new Set(VERDICTS),
	roundKind: new Set(RoundKind.enum),
	terminalReason: new Set(RunTerminalReason.enum),
	stopReason: new Set(StopReason.enum),
};

/** L10: a classifier holds a value of its closed vocabulary, never free text; free text belongs in `detail`. */
export function freeTextClassifiers(dto: unknown): string[] {
	const lies: string[] = [];
	for (const [path, node] of objectsOf(dto))
		for (const [key, allowed] of Object.entries(CLASSIFIERS)) {
			const value = node[key];
			for (const item of Array.isArray(value) ? value : [value])
				if (typeof item === "string" && !allowed.has(item)) lies.push(`${path}.${key}: ${item}`);
		}
	return lies;
}

/** Every detector over one DTO: the quantity detectors and those that read the DTO's structure. */
export function dtoLies(dto: unknown): string[] {
	return [
		...telemetryLies(quantitiesOf(dto)),
		...verdictsWithoutTokens(dto),
		...unmeasuredRenderedAsFalse(dto),
		...costsOffPolicy(dto),
		...unlabelledHashes(dto),
		...freeTextClassifiers(dto),
	];
}
