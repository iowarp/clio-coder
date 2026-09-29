/**
 * llama.cpp with separate KV slots splits `--ctx-size` evenly across
 * `--parallel` slots unless `--kv-unified`. A router started with `--ctx-size 786432
 * --parallel 4 --no-kv-unified` admits 196,608 tokens per request. The total
 * and the slot count are kept beside the quotient so the operator surfaces can
 * say where the number came from. LM Studio's unified cache reports a single
 * per-request `context_length`, so its `parallel` value is never divided here.
 */
export interface ContextWindowSlots {
	totalContextSize: number;
	slots: number;
}

/** `196,608 (786,432 / 4 slots)`: the per-request window with its derivation. */
export function formatContextWindowSlots(contextWindow: number, slots: ContextWindowSlots): string {
	const format = (n: number): string => Math.round(n).toLocaleString("en-US");
	return `${format(contextWindow)} (${format(slots.totalContextSize)} / ${slots.slots} slots)`;
}
