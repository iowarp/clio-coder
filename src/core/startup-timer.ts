/**
 * Micro-profiler for boot phases. Target budget is ≤800ms to first frame per spec §17.
 *
 * Marks double as boot-trace phase markers: each `mark()` forwards to
 * `traceBoot`, so `CLIO_CODER_TRACE_BOOT=1` streams the same phases live to stderr
 * (with elapsed-from-process-start) while the in-memory report stays relative
 * to construction for the `CLIO_CODER_TIMING=1` summary.
 */

import { traceBoot } from "./boot-trace.js";

type Mark = { name: string; at: number };

export class StartupTimer {
	private readonly start = performance.now();
	private readonly marks: Mark[] = [];

	constructor() {
		traceBoot("boot start");
	}

	mark(name: string): void {
		this.marks.push({ name, at: performance.now() - this.start });
		traceBoot(name);
	}

	snapshot(): { totalMs: number; marks: ReadonlyArray<Mark> } {
		return { totalMs: performance.now() - this.start, marks: [...this.marks] };
	}

	report(): string {
		const snap = this.snapshot();
		const lines = [`Clio Coder boot total ${snap.totalMs.toFixed(1)}ms`];
		for (const m of snap.marks) lines.push(`  ${m.at.toFixed(1)}ms  ${m.name}`);
		return lines.join("\n");
	}
}
