export type DevHarnessSnapshot =
	| { kind: "idle" }
	| { kind: "hot-ready"; message: string; until: number }
	| { kind: "hot-failed"; message: string; until: number }
	| { kind: "restart-required"; files: string[] }
	| { kind: "worker-pending"; count: number };

export interface DevHarnessHotSucceededSummary {
	path: string;
	elapsedMs: number;
	at: number;
}

export interface DevHarnessHotFailedSummary {
	path: string;
	error: string;
	at: number;
}

export interface DevHarnessIntrospection {
	last_restart_required_paths: string[];
	last_hot_succeeded: DevHarnessHotSucceededSummary | null;
	last_hot_failed: DevHarnessHotFailedSummary | null;
	queue_depth: number;
}
