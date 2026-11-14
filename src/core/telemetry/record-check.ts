import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

/**
 * Compiling a schema costs about as much as this many interpreted checks of a journal record, so a writer that
 * checks a handful of records never pays for a compile it would not earn back.
 */
const COMPILE_AFTER = 32;

interface CheckState {
	seen: number;
	compiled: ((value: unknown) => boolean) | null;
}

const states = new WeakMap<TSchema, CheckState>();

/**
 * `Value.Check` for schemas a journal reader applies to every line. Interpreted, the checks were 1.2 s of main-thread
 * time in a session's first seconds on a home with 69 run scopes, because every fold walks the envelope and payload
 * schema once per record. A schema that keeps being checked is compiled once and then gives the same verdicts about
 * fifteen times faster.
 */
export function checkRecordSchema<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
	let state = states.get(schema);
	if (state === undefined) {
		state = { seen: 0, compiled: null };
		states.set(schema, state);
	}
	if (state.compiled !== null) return state.compiled(value);
	state.seen += 1;
	if (state.seen === COMPILE_AFTER) {
		try {
			const validator = Compile(schema);
			state.compiled = (candidate) => validator.Check(candidate);
			return state.compiled(value);
		} catch {
			// A schema the compiler cannot take keeps the interpreted check, which accepts every schema.
		}
	}
	return Value.Check(schema, value);
}
