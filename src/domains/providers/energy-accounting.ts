interface ElectricityTariff {
	readonly currency: string;
	readonly perKwh: number;
}

interface DeclaredPower {
	readonly activeWatts: number;
	readonly idleWatts: number;
	readonly tariff?: ElectricityTariff;
}

interface BusyInterval {
	readonly startMs: number;
	readonly endMs: number;
}

interface PowerTimeEstimate {
	readonly basis: "declared-power-time";
	readonly value: number | null;
	readonly reason: string | null;
}

interface CallEnergyEstimate extends PowerTimeEstimate {
	readonly cost: PowerTimeEstimate & { readonly currency: string | null };
}

export interface LocalEnergyEstimate extends CallEnergyEstimate {
	/** One allocation per input interval, in input order. Null when the input cannot be allocated. */
	readonly perCall: ReadonlyArray<CallEnergyEstimate> | null;
}

const WATT_MS_PER_KWH = 3_600_000_000;

function nonnegative(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function estimate(value: number | null, reason: string | null): PowerTimeEstimate {
	return { value, basis: "declared-power-time", reason };
}

function decimalParts(value: number): { coefficient: bigint; exponent: number } {
	const [mantissa = "0", exponent = "0"] = value.toString().split("e");
	const point = mantissa.indexOf(".");
	return {
		coefficient: BigInt(mantissa.replace(".", "")),
		exponent: Number(exponent) - (point === -1 ? 0 : mantissa.length - point - 1),
	};
}

function costOf(energy: PowerTimeEstimate, tariff: ElectricityTariff | undefined): CallEnergyEstimate["cost"] {
	const currency = tariff !== undefined && /^[A-Z]{3}$/u.test(tariff.currency) ? tariff.currency : null;
	if (energy.value === null) return { ...energy, currency };
	if (tariff === undefined) return { ...estimate(null, "No electricity tariff declared."), currency };
	if (currency === null || !nonnegative(tariff.perKwh))
		return { ...estimate(null, "Electricity tariff requires a currency code and a finite, nonnegative rate."), currency };

	// Multiply the decimal coefficients before converting the cost back to a number.
	const kwh = decimalParts(energy.value);
	const rate = decimalParts(tariff.perKwh);
	const value = Number(`${kwh.coefficient * rate.coefficient}e${kwh.exponent + rate.exponent}`);
	const inRange = Number.isFinite(value) && (value > 0 || energy.value === 0 || tariff.perKwh === 0);
	return {
		...(inRange ? estimate(value, null) : estimate(null, "Electricity cost is outside numeric range.")),
		currency,
	};
}

function energyFor(watts: number, elapsedMs: number): PowerTimeEstimate {
	const wattMs = watts * elapsedMs;
	const value = Number.isFinite(wattMs) ? wattMs / WATT_MS_PER_KWH : watts * (elapsedMs / WATT_MS_PER_KWH);
	return Number.isFinite(value) && (value > 0 || watts === 0 || elapsedMs === 0)
		? estimate(value, null)
		: estimate(null, "Energy estimate is outside numeric range.");
}

/** Estimate incremental kWh for one owned endpoint. Shared spans are split equally among calls busy during that span. */
export function estimateLocalEnergy(
	power: DeclaredPower | null | undefined,
	intervals: ReadonlyArray<BusyInterval>,
): LocalEnergyEstimate | null {
	if (power == null) return null;
	const { activeWatts, idleWatts, tariff } = power;
	const withCost = (energy: PowerTimeEstimate): CallEnergyEstimate => ({ ...energy, cost: costOf(energy, tariff) });
	const unknown = (reason: string): LocalEnergyEstimate => ({ ...withCost(estimate(null, reason)), perCall: null });
	if (!nonnegative(activeWatts) || !nonnegative(idleWatts) || activeWatts < idleWatts)
		return unknown("Declared watts must be finite and nonnegative, with active watts at least idle watts.");

	const calls: Array<{ shareMs: number }> = [];
	const events: Array<{ atMs: number; call: { shareMs: number }; starts: boolean }> = [];
	for (const [index, { startMs, endMs }] of intervals.entries()) {
		if (!nonnegative(startMs) || !nonnegative(endMs) || endMs < startMs)
			return unknown(`Busy interval ${index + 1} requires finite, nonnegative timestamps in start-to-end order.`);
		const call = { shareMs: 0 };
		calls.push(call);
		if (endMs > startMs) events.push({ atMs: startMs, call, starts: true }, { atMs: endMs, call, starts: false });
	}

	let busyMs = 0;
	let previousMs = 0;
	let sharedMs = 0;
	let concurrent = 0;
	for (const { atMs, call, starts } of events.sort((a, b) => a.atMs - b.atMs)) {
		const elapsedMs = atMs - previousMs;
		if (concurrent > 0) {
			busyMs += elapsedMs;
			sharedMs += elapsedMs / concurrent;
		} else sharedMs = 0;
		previousMs = atMs;
		// Integrate each active call's share once per boundary, then recover its allocation by subtraction.
		call.shareMs = starts ? sharedMs : sharedMs - call.shareMs;
		concurrent += starts ? 1 : -1;
	}

	const watts = activeWatts - idleWatts;
	return {
		...withCost(energyFor(watts, busyMs)),
		perCall: calls.map(({ shareMs }) => withCost(energyFor(watts, shareMs))),
	};
}
