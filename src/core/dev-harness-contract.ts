import { dynamicToolName, type ToolName } from "./tool-names.js";

export type SelfDevActivationSource = "--dev" | "CLIO_DEV=1" | "CLIO_SELF_DEV=1";

export interface SelfDevMode {
	enabled: true;
	source: SelfDevActivationSource;
	repoRoot: string;
	cwd: string;
	branch: string | null;
	dirtySummary: string;
	engineWritesAllowed: boolean;
}

export type SelfDevPathDecision =
	| { allowed: true; absolutePath: string; relativePath: string; restartRequired: boolean }
	| { allowed: false; absolutePath: string; relativePath: string; reason: string };

export const SelfDevToolNames = {
	ClioIntrospect: dynamicToolName("clio_introspect"),
	ClioRecall: dynamicToolName("clio_recall"),
	ClioRemember: dynamicToolName("clio_remember"),
	ClioMemoryMaintain: dynamicToolName("clio_memory_maintain"),
} as const;

export const SELFDEV_WORKER_TOOL_NAMES: ReadonlyArray<ToolName> = [
	SelfDevToolNames.ClioIntrospect,
	SelfDevToolNames.ClioRecall,
	SelfDevToolNames.ClioRemember,
	SelfDevToolNames.ClioMemoryMaintain,
];

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
