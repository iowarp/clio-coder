import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";

/**
 * Dated public API retail list prices per exact provider model id (`models/economy-rates.json`), quoted one request
 * at a time: what the request would cost at the publisher's list price. It is a reference, never a route price:
 * `resolveEffectivePricing`, cost caps and `targets[].pricing` stay per target and never read it.
 */

type PromptBucket = "fresh" | "read" | "write";

interface TariffRates {
	input: number;
	output: number;
	cacheRead: number | null;
	/** USD per MTok by published retention class (`5m`, `1h`, `30m`, `12h`); null when the publisher has no write charge. */
	cacheWrite: Readonly<Record<string, number>> | null;
}

export interface TariffRow {
	id: string;
	publisher: string;
	model: string;
	kind: "standard" | "promo";
	scenario?: string;
	source: string;
	/** Inclusive UTC day. `verified` when the publisher states no start, so the row covers only what was read. */
	effectiveFrom: string;
	effectiveFromBasis: "published" | "verified";
	/** Exclusive UTC day; null while open. */
	effectiveTo: string | null;
	verifiedAt: string;
	rates: TariffRates;
	tiering: {
		source: string;
		basis: string;
		/** The buckets the publisher's tier predicate counts as the prompt size. */
		counts: readonly PromptBucket[];
		tiers: ReadonlyArray<{ above: number; rates: TariffRates }>;
	};
	notApplicable?: Readonly<Record<string, { source: string; basis: string }>>;
	notes?: readonly string[];
}

export interface TariffTokens {
	/** Uncached input, excluding cache writes. */
	fresh: number;
	read: number;
	/** Cache writes by retention class; `unknown` when the provider did not say which. */
	write: Readonly<Record<string, number>>;
	output: number;
}

export type ReferenceQuote =
	| {
			kind: "quoted";
			usd: number;
			rowId: string;
			source: string;
			verifiedAt: string;
			tier: string;
			/**
			 * `effective`: the row is in force on the day. `announced-list`: a promotion is in force and this is the
			 * standard list row the publisher announced to follow it, starting `effectiveFrom`.
			 */
			basis: "effective" | "announced-list";
			effectiveFrom: string;
	  }
	| { kind: "unknown"; reason: string };

interface LoadedCatalog {
	rows: TariffRow[];
	errors: string[];
}

const MICRO = 1_000_000n;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const BUCKETS: ReadonlySet<string> = new Set(["fresh", "read", "write"]);
const RATE_KEYS = ["input", "output", "cacheRead"] as const;
const STALE_AFTER_DAYS = 30;

let shipped: LoadedCatalog | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDay(value: unknown): value is string {
	if (typeof value !== "string" || !DAY.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		// Not a URL at all; the caller reports it as a missing source.
		return false;
	}
}

/** USD per MTok as an exact integer count of micro-dollars per MTok; null when not a decimal with at most 6 places. */
function rateMicros(rate: number): bigint | null {
	if (!Number.isFinite(rate) || rate < 0) return null;
	const text = String(rate);
	if (!/^\d+(\.\d{1,6})?$/u.test(text)) return null;
	const [whole = "0", fraction = ""] = text.split(".");
	return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
}

function checkRate(where: string, value: unknown, errors: string[]): void {
	if (typeof value !== "number" || rateMicros(value) === null) {
		errors.push(`${where}: expected a non-negative USD per MTok decimal with at most 6 places, got ${String(value)}`);
		return;
	}
	// A per-token or per-1K figure lands outside this band; list prices per MTok sit inside it.
	if (value !== 0 && (value < 0.001 || value > 1000))
		errors.push(`${where}: ${value} is outside the USD per MTok range (0.001 to 1000); check the unit`);
}

function checkRates(where: string, value: unknown, errors: string[]): TariffRates | null {
	if (!isRecord(value)) {
		errors.push(`${where}: missing rates`);
		return null;
	}
	for (const key of RATE_KEYS) {
		if (key === "cacheRead" && value[key] === null) continue;
		checkRate(`${where}.${key}`, value[key], errors);
	}
	const writes = value.cacheWrite;
	if (writes !== null) {
		if (!isRecord(writes) || Object.keys(writes).length === 0)
			errors.push(`${where}.cacheWrite: expected retention rates or null`);
		else
			for (const [retention, rate] of Object.entries(writes)) {
				if (retention === "unknown") errors.push(`${where}.cacheWrite: "unknown" is not a retention class`);
				checkRate(`${where}.cacheWrite.${retention}`, rate, errors);
			}
	}
	return value as unknown as TariffRates;
}

function sameWriteClasses(a: TariffRates, b: TariffRates): boolean {
	const left = Object.keys(a.cacheWrite ?? {}).sort();
	const right = Object.keys(b.cacheWrite ?? {}).sort();
	return (a.cacheRead === null) === (b.cacheRead === null) && left.join() === right.join();
}

function checkRow(raw: unknown, index: number, errors: string[]): TariffRow | null {
	if (!isRecord(raw)) {
		errors.push(`rows[${index}]: expected an object`);
		return null;
	}
	const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `rows[${index}]`;
	const before = errors.length;
	for (const key of ["id", "publisher", "model"] as const)
		if (typeof raw[key] !== "string" || raw[key].length === 0) errors.push(`${id}: missing ${key}`);
	if (raw.kind !== "standard" && raw.kind !== "promo") errors.push(`${id}: kind must be standard or promo`);
	if (raw.kind === "promo" && (typeof raw.scenario !== "string" || !/^[a-z0-9][a-z0-9.-]*$/u.test(raw.scenario)))
		errors.push(`${id}: a promo row names its scenario`);
	if (raw.kind === "promo" && raw.effectiveTo === null) errors.push(`${id}: a promo row has an end date`);
	if (raw.kind === "standard" && raw.scenario !== undefined) errors.push(`${id}: a standard row names no scenario`);
	if (!isHttpsUrl(raw.source)) errors.push(`${id}: missing public https source`);
	if (!isDay(raw.effectiveFrom)) errors.push(`${id}: effectiveFrom must be a YYYY-MM-DD day`);
	if (raw.effectiveFromBasis !== "published" && raw.effectiveFromBasis !== "verified")
		errors.push(`${id}: effectiveFromBasis must be published or verified`);
	if (raw.effectiveTo !== null && !isDay(raw.effectiveTo)) errors.push(`${id}: effectiveTo must be a day or null`);
	if (isDay(raw.effectiveFrom) && isDay(raw.effectiveTo) && raw.effectiveTo <= raw.effectiveFrom)
		errors.push(`${id}: effectiveTo ${raw.effectiveTo} is not after effectiveFrom ${raw.effectiveFrom}`);
	if (!isDay(raw.verifiedAt)) errors.push(`${id}: verifiedAt must be a YYYY-MM-DD day`);
	const rates = checkRates(`${id}.rates`, raw.rates, errors);
	const notApplicable = isRecord(raw.notApplicable) ? raw.notApplicable : {};
	for (const [field, note] of Object.entries(notApplicable))
		if (!isRecord(note) || !isHttpsUrl(note.source) || typeof note.basis !== "string" || note.basis.length === 0)
			errors.push(`${id}.notApplicable.${field}: needs a source and a basis`);
	if (rates) {
		for (const field of ["cacheRead", "cacheWrite"] as const)
			if (rates[field] === null && !(field in notApplicable))
				errors.push(`${id}.rates.${field}: null needs a sourced notApplicable entry`);
	}
	const tiering = raw.tiering;
	if (!isRecord(tiering)) errors.push(`${id}: missing tiering`);
	else {
		if (!isHttpsUrl(tiering.source)) errors.push(`${id}.tiering: missing public https source`);
		if (typeof tiering.basis !== "string" || tiering.basis.length === 0) errors.push(`${id}.tiering: missing basis`);
		const counts = tiering.counts;
		if (
			!Array.isArray(counts) ||
			counts.length === 0 ||
			counts.some((bucket) => !BUCKETS.has(bucket)) ||
			new Set(counts).size !== counts.length
		)
			errors.push(`${id}.tiering.counts: expected distinct fresh, read or write buckets`);
		if (!Array.isArray(tiering.tiers)) errors.push(`${id}.tiering.tiers: expected a list`);
		else {
			let previous = 0;
			tiering.tiers.forEach((tier: unknown, at: number) => {
				const where = `${id}.tiering.tiers[${at}]`;
				if (!isRecord(tier)) {
					errors.push(`${where}: expected an object`);
					return;
				}
				if (!Number.isSafeInteger(tier.above) || (tier.above as number) <= previous)
					errors.push(`${where}.above: thresholds are positive integers in ascending order`);
				else previous = tier.above as number;
				const tierRates = checkRates(`${where}.rates`, tier.rates, errors);
				if (rates && tierRates && !sameWriteClasses(rates, tierRates))
					errors.push(`${where}.rates: cache rate classes differ from the base rates`);
			});
		}
	}
	return errors.length === before ? (raw as unknown as TariffRow) : null;
}

/** Overlapping rows make a quote ambiguous; a gap between a model's standard rows is a missing row. */
function checkIntervals(rows: readonly TariffRow[], errors: string[]): void {
	const groups = new Map<string, TariffRow[]>();
	for (const row of rows) {
		const key = row.kind === "standard" ? `${row.model} standard` : `${row.model} scenario ${row.scenario}`;
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	for (const [key, group] of groups) {
		group.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
		for (let i = 1; i < group.length; i++) {
			const prev = group[i - 1] as TariffRow;
			const next = group[i] as TariffRow;
			if (prev.effectiveTo === null || prev.effectiveTo > next.effectiveFrom)
				errors.push(`${key}: ${prev.id} overlaps ${next.id}`);
			else if (prev.effectiveTo < next.effectiveFrom && key.endsWith(" standard"))
				errors.push(`${key}: missing row from ${prev.effectiveTo} to ${next.effectiveFrom}`);
		}
	}
	const publisherByModel = new Map<string, string>();
	for (const row of rows) {
		const seen = publisherByModel.get(row.model);
		if (seen !== undefined && seen !== row.publisher)
			errors.push(`${row.model}: priced by both ${seen} and ${row.publisher}; model ids must name one publisher`);
		publisherByModel.set(row.model, row.publisher);
	}
}

function parseCatalog(raw: unknown): LoadedCatalog {
	const errors: string[] = [];
	if (!isRecord(raw)) return { rows: [], errors: ["catalog: expected an object"] };
	if (raw.version !== 1) errors.push(`catalog: unsupported version ${String(raw.version)}`);
	if (raw.currency !== "USD") errors.push(`catalog: currency must be USD, got ${String(raw.currency)}`);
	if (raw.perTokens !== 1_000_000)
		errors.push(`catalog: rates must be per 1000000 tokens, got ${String(raw.perTokens)}`);
	if (!Array.isArray(raw.rows) || raw.rows.length === 0) return { rows: [], errors: [...errors, "catalog: no rows"] };
	const rows: TariffRow[] = [];
	const ids = new Set<string>();
	raw.rows.forEach((entry: unknown, index: number) => {
		const row = checkRow(entry, index, errors);
		if (!row) return;
		if (ids.has(row.id)) errors.push(`${row.id}: duplicate row id`);
		ids.add(row.id);
		rows.push(row);
	});
	checkIntervals(rows, errors);
	return { rows, errors };
}

function loadShipped(): LoadedCatalog {
	if (shipped) return shipped;
	const path = join(resolvePackageRoot(), "models", "economy-rates.json");
	try {
		shipped = parseCatalog(JSON.parse(readFileSync(path, "utf8")));
	} catch (err) {
		shipped = { rows: [], errors: [`${path}: ${err instanceof Error ? err.message : String(err)}`] };
	}
	return shipped;
}

function utcDay(date: string | Date): string | null {
	if (typeof date === "string" && isDay(date)) return date;
	const parsed = typeof date === "string" ? new Date(date) : date;
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function effectiveOn(row: TariffRow, day: string): boolean {
	return row.effectiveFrom <= day && (row.effectiveTo === null || day < row.effectiveTo);
}

function interval(row: TariffRow): string {
	return `[${row.effectiveFrom}, ${row.effectiveTo ?? "open"})`;
}

/** An exact count of 1e-12 USD (token x micro-dollars per MTok) as the nearest double, with no cent rounding. */
function usdFromPicos(picos: bigint): number {
	const whole = picos / 1_000_000_000_000n;
	const fraction = (picos % 1_000_000_000_000n).toString().padStart(12, "0");
	return Number(`${whole}.${fraction}`);
}

function writeRate(row: TariffRow, rates: TariffRates, retention: string): bigint | string {
	if (rates.cacheWrite === null)
		return `${row.id} publishes no cache-write rate: ${row.notApplicable?.cacheWrite?.basis ?? "not applicable"}`;
	if (retention === "unknown") {
		const distinct = [...new Set(Object.values(rates.cacheWrite))];
		if (distinct.length === 1) return rateMicros(distinct[0] as number) as bigint;
		const listed = Object.entries(rates.cacheWrite)
			.map(([name, rate]) => `${name} $${rate}`)
			.join(", ");
		return `cache-write retention unknown and ${row.id} write rates differ (${listed})`;
	}
	const rate = rates.cacheWrite[retention];
	return rate === undefined
		? `${row.id} publishes no ${retention} cache-write rate (${Object.keys(rates.cacheWrite).join(", ")})`
		: (rateMicros(rate) as bigint);
}

/**
 * Prices one request at the dated public list price of `model` (exact provider id; no family or alias substitution).
 * Writes are priced in place of fresh input, so `fresh` excludes them. The standard row applies unless the caller
 * names a promotional scenario (catalog.ts prices at list, not a launch discount, so a cap never under-counts).
 * While a promotion runs ahead of its first list price, the list row that starts where the promotion ends is the
 * standard price, quoted with basis `announced-list`.
 */
export function quoteReferenceTariff(
	model: string,
	date: string | Date,
	tokens: TariffTokens,
	options: { scenario?: string } = {},
): ReferenceQuote {
	const unknown = (reason: string): ReferenceQuote => ({ kind: "unknown", reason });
	const catalog = loadShipped();
	if (catalog.errors.length > 0) return unknown(`reference tariff is invalid: ${catalog.errors[0]}`);
	const day = utcDay(date);
	if (day === null) return unknown(`invalid date ${String(date)}`);
	const counts: Array<[string, number]> = [
		["fresh", tokens.fresh],
		["read", tokens.read],
		["output", tokens.output],
		...Object.entries(tokens.write).map(([retention, count]): [string, number] => [`write ${retention}`, count]),
	];
	for (const [name, count] of counts)
		if (!Number.isSafeInteger(count) || count < 0) return unknown(`${name} token count ${count} is not a count`);

	const forModel = catalog.rows.filter((row) => row.model === model);
	if (forModel.length === 0) return unknown(`no reference tariff row for model ${model}`);
	const scenario = options.scenario;
	const pool = forModel.filter((row) => (scenario === undefined ? row.kind === "standard" : row.scenario === scenario));
	if (scenario !== undefined && pool.length === 0) return unknown(`scenario ${scenario} has no row for ${model}`);
	let effective = pool.filter((row) => effectiveOn(row, day));
	let basis: "effective" | "announced-list" = "effective";
	if (effective.length === 0 && scenario === undefined) {
		const promoEnds = new Set(
			forModel.filter((row) => row.kind === "promo" && effectiveOn(row, day)).map((row) => row.effectiveTo),
		);
		effective = pool.filter((row) => promoEnds.has(row.effectiveFrom));
		basis = "announced-list";
	}
	if (effective.length === 0) {
		if (scenario !== undefined)
			return unknown(`scenario ${scenario} is not effective for ${model} on ${day}: ${pool.map(interval).join(", ")}`);
		const promos = forModel.filter((row) => row.kind === "promo" && effectiveOn(row, day));
		const hint =
			promos.length > 0
				? `; promo scenario ${promos.map((row) => row.scenario).join(", ")} is effective that day with no announced list price after it`
				: "";
		const rows = pool.length > 0 ? ` (rows: ${pool.map(interval).join(", ")})` : "";
		return unknown(`no standard list price for ${model} effective on ${day}${rows}${hint}`);
	}
	if (effective.length > 1) return unknown(`ambiguous: ${effective.map((row) => row.id).join(", ")} all apply`);
	const row = effective[0] as TariffRow;

	const written = Object.values(tokens.write).reduce((sum, count) => sum + count, 0);
	const bucketSize: Record<PromptBucket, number> = { fresh: tokens.fresh, read: tokens.read, write: written };
	const prompt = row.tiering.counts.reduce((sum, bucket) => sum + bucketSize[bucket], 0);
	let rates = row.rates;
	let tier = "base";
	for (const candidate of row.tiering.tiers)
		if (prompt > candidate.above) {
			rates = candidate.rates;
			tier = `prompt>${candidate.above}`;
		}

	let picos =
		BigInt(tokens.fresh) * (rateMicros(rates.input) as bigint) +
		BigInt(tokens.output) * (rateMicros(rates.output) as bigint);
	if (tokens.read > 0) {
		if (rates.cacheRead === null) return unknown(`${row.id} publishes no cache-read rate`);
		picos += BigInt(tokens.read) * (rateMicros(rates.cacheRead) as bigint);
	}
	for (const [retention, count] of Object.entries(tokens.write)) {
		if (count === 0) continue;
		const rate = writeRate(row, rates, retention);
		if (typeof rate === "string") return unknown(rate);
		picos += BigInt(count) * rate;
	}
	return {
		kind: "quoted",
		usd: usdFromPicos(picos),
		rowId: row.id,
		source: row.source,
		verifiedAt: row.verifiedAt,
		tier,
		basis,
		effectiveFrom: row.effectiveFrom,
	};
}

/**
 * Validates the shipped catalog (shape, units, thresholds, overlaps, gaps) and, as of `asOf`, flags models with no
 * row yet (future-only), expired promotions and rows verified more than 30 days ago.
 */
export function auditReferenceTariff(asOf: string): {
	rows: readonly TariffRow[];
	errors: string[];
	warnings: string[];
} {
	const loaded = loadShipped();
	const rows = loaded.rows;
	const errors = [...loaded.errors];
	const warnings: string[] = [];
	if (!isDay(asOf)) return { rows, errors: [...errors, `asOf ${asOf} is not a YYYY-MM-DD day`], warnings };
	for (const model of new Set(rows.map((row) => row.model))) {
		const standard = rows.filter((row) => row.model === model && row.kind === "standard");
		if (standard.length === 0) errors.push(`${model}: missing a standard list price row`);
		else if (!standard.some((row) => effectiveOn(row, asOf))) {
			const later = standard.filter((row) => row.effectiveFrom > asOf);
			if (later.length > 0)
				warnings.push(`${model}: future-only on ${asOf}; standard list price starts ${later[0]?.effectiveFrom}`);
			else errors.push(`${model}: missing; every standard row ended before ${asOf}`);
		}
	}
	const staleBefore = new Date(Date.parse(`${asOf}T00:00:00Z`) - STALE_AFTER_DAYS * 86_400_000).toISOString();
	for (const row of rows) {
		if (row.kind === "promo" && row.effectiveTo !== null && row.effectiveTo <= asOf)
			warnings.push(`${row.id}: promotion ended ${row.effectiveTo}`);
		if (row.verifiedAt < staleBefore.slice(0, 10))
			warnings.push(`${row.id}: last verified ${row.verifiedAt}, over ${STALE_AFTER_DAYS} days before ${asOf}`);
		if (row.verifiedAt > asOf) warnings.push(`${row.id}: verified ${row.verifiedAt}, after ${asOf}`);
	}
	return { rows, errors, warnings };
}
