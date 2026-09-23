// A render counter for `scripts/perf-workload.ts`, which proves the composer and settled turns are
// not rendered by streamed deltas. The workload defines `__clioRenderCounts` before the app loads;
// without it every call is one property read and nothing is recorded.

const counts = (globalThis as { __clioRenderCounts?: Record<string, number> }).__clioRenderCounts;

export function countRender(name: string): void {
	if (counts) counts[name] = (counts[name] ?? 0) + 1;
}
