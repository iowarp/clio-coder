/**
 * Micro-profiler for boot phases. Target budget is ≤800ms to first frame per spec §17.
 */

type Mark = { name: string; at: number };

export class StartupTimer {
	private readonly start = performance.now();
	private readonly marks: Mark[] = [];

	mark(name: string): void {
		this.marks.push({ name, at: performance.now() - this.start });
	}

	snapshot(): { totalMs: number; marks: ReadonlyArray<Mark> } {
		return { totalMs: performance.now() - this.start, marks: [...this.marks] };
	}

	report(): string {
		const snap = this.snapshot();
		const lines = [`clio boot total ${snap.totalMs.toFixed(1)}ms`];
		for (const m of snap.marks) lines.push(`  ${m.at.toFixed(1)}ms  ${m.name}`);
		return lines.join("\n");
	}
}
