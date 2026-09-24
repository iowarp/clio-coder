/** Clio's supported managed CLI connectors. Each peer owns its wire parser and permissions. */
import { startAntigravityWorkerRun } from "../antigravity/subprocess-runtime.js";
import { startClaudeCodeWorkerRun } from "../claude/subprocess-runtime.js";
import { startCodexCliWorkerRun } from "../codex/subprocess-runtime.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput } from "../worker-runtime.js";
import { startJsonlCliRun } from "./jsonl-runner.js";
import { OPENCODE_CLI_CONNECTOR } from "./opencode.js";
import { PI_CLI_CONNECTOR } from "./pi.js";

export interface ExternalCliConnector {
	runtimeId: string;
	start(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle;
}

const CONNECTORS: ReadonlyArray<ExternalCliConnector> = [
	{ runtimeId: "claude-code", start: startClaudeCodeWorkerRun },
	{ runtimeId: "codex-cli", start: startCodexCliWorkerRun },
	{ runtimeId: "opencode-cli", start: (input, emit) => startJsonlCliRun(OPENCODE_CLI_CONNECTOR, input, emit) },
	{ runtimeId: "pi-cli", start: (input, emit) => startJsonlCliRun(PI_CLI_CONNECTOR, input, emit) },
	{ runtimeId: "antigravity-code", start: startAntigravityWorkerRun },
];

const BY_RUNTIME = new Map(CONNECTORS.map((connector) => [connector.runtimeId, connector]));

export function externalCliConnector(runtimeId: string): ExternalCliConnector | null {
	return BY_RUNTIME.get(runtimeId) ?? null;
}

export function startExternalCliWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	const connector = externalCliConnector(input.runtime.id);
	if (!connector) throw new Error(`no managed CLI connector for runtime '${input.runtime.id}'`);
	return connector.start(input, emit);
}
