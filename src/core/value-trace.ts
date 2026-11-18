const OBJECT = Symbol("object");
const ARRAY = Symbol("array");
const END = Symbol("end");

function plain(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return (
		(Array.isArray(value) || proto === Object.prototype || proto === null) &&
		typeof (value as { toJSON?: unknown }).toJSON !== "function"
	);
}

function traceInto(value: unknown, out: unknown[]): boolean {
	if (value === null || typeof value !== "object") {
		out.push(value);
		return true;
	}
	if (!plain(value)) return false;
	if (Array.isArray(value)) {
		out.push(ARRAY, value.length);
		for (const item of value) if (!traceInto(item, out)) return false;
	} else {
		out.push(OBJECT);
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			out.push(key);
			if (!traceInto(record[key], out)) return false;
		}
	}
	out.push(END);
	return true;
}

/**
 * Every key and leaf of a plain value in walk order. Strings are immutable, so comparing a fresh walk against it with
 * `===` finds any in-place edit, a same-length one included, at a cost of the value's node count and not its byte
 * count. Null when the value holds anything but plain data (a Date, a class, a `toJSON`), which is then always re-read.
 */
export function traceValue(value: unknown): unknown[] | null {
	const out: unknown[] = [];
	return traceInto(value, out) ? out : null;
}

// One comparison runs at a time, synchronously; module state keeps the walk free of per-call closures.
let expected: ReadonlyArray<unknown> = [];
let cursor = 0;

function matchesFrom(value: unknown): boolean {
	if (value === null || typeof value !== "object") return expected[cursor++] === value;
	if (!plain(value)) return false;
	if (Array.isArray(value)) {
		if (expected[cursor++] !== ARRAY || expected[cursor++] !== value.length) return false;
		for (const item of value) if (!matchesFrom(item)) return false;
	} else {
		if (expected[cursor++] !== OBJECT) return false;
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) if (expected[cursor++] !== key || !matchesFrom(record[key])) return false;
	}
	return expected[cursor++] === END;
}

/** Whether `value` holds exactly the keys and leaves `trace` recorded, in the same order. */
export function matchesTrace(value: unknown, trace: ReadonlyArray<unknown>): boolean {
	expected = trace;
	cursor = 0;
	try {
		return matchesFrom(value) && cursor === trace.length;
	} finally {
		expected = [];
	}
}
