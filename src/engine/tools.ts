/**
 * Phase 1 stub. Tool registration helpers that bridge pi-agent-core's tool API into the
 * shape Clio's registry will use. The full registry with mode gating and action-class
 * wiring lands in Phase 2 (safety) and Phase 5 (tools).
 */

export interface EngineToolHandle {
	name: string;
	description: string;
}

export function defineEngineTool(handle: EngineToolHandle): EngineToolHandle {
	return handle;
}
