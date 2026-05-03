import { basename } from "node:path";

export type HarnessSnapshot =
	| { kind: "idle" }
	| { kind: "hot-ready"; message: string; until: number }
	| { kind: "hot-failed"; message: string; until: number }
	| { kind: "restart-required"; files: string[] }
	| { kind: "worker-pending"; count: number };

export interface HarnessHotSucceededSummary {
	path: string;
	elapsedMs: number;
	at: number;
}

export interface HarnessHotFailedSummary {
	path: string;
	error: string;
	at: number;
}

export interface HarnessIntrospection {
	last_restart_required_paths: string[];
	last_hot_succeeded: HarnessHotSucceededSummary | null;
	last_hot_failed: HarnessHotFailedSummary | null;
	queue_depth: number;
}

const HOT_READY_TTL_MS = 3000;
const HOT_FAILED_TTL_MS = 3000;

export interface HarnessStateDeps {
	now: () => number;
}

/**
 * Footer-indicator state machine. Transient events (hot success/failure)
 * auto-expire; persistent events (restart-required, worker-pending) stay
 * until superseded. Restart-required is the highest-priority state.
 */
export class HarnessState {
	private readonly now: () => number;
	private transient: { kind: "hot-ready" | "hot-failed"; message: string; until: number } | null = null;
	private readonly restartFiles: string[] = [];
	private readonly workerFiles: Set<string> = new Set();
	private lastHotSucceeded: HarnessHotSucceededSummary | null = null;
	private lastHotFailed: HarnessHotFailedSummary | null = null;

	constructor(deps: HarnessStateDeps) {
		this.now = deps.now;
	}

	snapshot(): HarnessSnapshot {
		if (this.restartFiles.length > 0) {
			return { kind: "restart-required", files: [...this.restartFiles] };
		}
		if (this.transient && this.now() < this.transient.until) {
			return { ...this.transient };
		}
		if (this.transient && this.now() >= this.transient.until) {
			this.transient = null;
		}
		if (this.workerFiles.size > 0) {
			return { kind: "worker-pending", count: this.workerFiles.size };
		}
		return { kind: "idle" };
	}

	introspection(): HarnessIntrospection {
		return {
			last_restart_required_paths: [...this.restartFiles],
			last_hot_succeeded: this.lastHotSucceeded ? { ...this.lastHotSucceeded } : null,
			last_hot_failed: this.lastHotFailed ? { ...this.lastHotFailed } : null,
			queue_depth: this.workerFiles.size,
		};
	}

	hotSucceeded(path: string, elapsedMs: number): void {
		this.lastHotSucceeded = { path, elapsedMs, at: this.now() };
		this.transient = {
			kind: "hot-ready",
			message: `${basename(path)} (${elapsedMs}ms)`,
			until: this.now() + HOT_READY_TTL_MS,
		};
	}

	hotFailed(path: string, error: string): void {
		this.lastHotFailed = { path, error, at: this.now() };
		this.transient = {
			kind: "hot-failed",
			message: `${basename(path)}: ${error}`,
			until: this.now() + HOT_FAILED_TTL_MS,
		};
	}

	restartRequired(path: string, _reason: string): void {
		if (!this.restartFiles.includes(path)) {
			this.restartFiles.push(path);
		}
	}

	workerChanged(path: string): void {
		this.workerFiles.add(path);
	}

	clearRestartRequired(): void {
		this.restartFiles.length = 0;
	}
}
