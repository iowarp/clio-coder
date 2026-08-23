/**
 * A server that shares one KV budget across request slots serves each request
 * a quotient of it. llama.cpp splits `--ctx-size` evenly across `--parallel`
 * slots unless `--kv-unified`, so a router started with `--ctx-size 786432
 * --parallel 4 --no-kv-unified` admits 196,608 tokens per request. The total
 * and the slot count are kept beside the quotient so the operator surfaces can
 * say where the number came from.
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
