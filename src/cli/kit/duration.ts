/**
 * Duration values for CLI flags (CLI convention C11): `<n>[ms|s|m|h]`. A bare
 * number keeps the unit that flag used before the convention, which each
 * caller states, so no existing script changes meaning in 0.8.x.
 *
 * Leaf of the CLI kit: imports nothing.
 */
export type DurationUnit = "ms" | "s" | "m" | "h";

const UNIT_MS: Readonly<Record<DurationUnit, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

const UNIT_NAME: Readonly<Record<DurationUnit, string>> = {
	ms: "milliseconds",
	s: "seconds",
	m: "minutes",
	h: "hours",
};

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u;

export interface DurationOptions {
	/** The unit of a bare number on this flag. */
	readonly bareUnit: DurationUnit;
	/** Accept a zero duration; refused by default because most flags mean "wait at least this long". */
	readonly allowZero?: boolean;
}

export type DurationResult =
	| { readonly ok: true; readonly ms: number }
	| { readonly ok: false; readonly message: string };

/** Parse `30s`, `5m`, `1500ms`, `1.5h`, or a bare number in the flag's own unit, to whole milliseconds. */
export function parseDuration(text: string, options: DurationOptions): DurationResult {
	const match = DURATION.exec(text);
	const amount = match?.[1];
	if (match === null || amount === undefined) {
		return {
			ok: false,
			message: `expected a duration such as 30s, 5m or 1500ms, got ${JSON.stringify(text)}; a bare number is in ${UNIT_NAME[options.bareUnit]}`,
		};
	}
	const unit = (match[2] as DurationUnit | undefined) ?? options.bareUnit;
	const ms = Math.round(Number(amount) * UNIT_MS[unit]);
	if (!Number.isSafeInteger(ms)) return { ok: false, message: `duration ${JSON.stringify(text)} is too large` };
	if (ms === 0 && options.allowZero !== true) return { ok: false, message: "duration must be greater than zero" };
	return { ok: true, ms };
}
