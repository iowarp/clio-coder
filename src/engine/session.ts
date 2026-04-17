/**
 * Phase 1 stub. The full Clio session JSONL format lands in Phase 3. This module exposes
 * a minimal shape so Phase 1 CLI commands can compile and the orchestrator can reserve
 * the session-id slot in its context object.
 */

import { randomUUID } from "node:crypto";

export interface ClioSessionMeta {
	id: string;
	cwd: string;
	createdAt: string;
	model: string | null;
	provider: string | null;
	compiledPromptHash: string | null;
}

export function newSessionMeta(cwd: string): ClioSessionMeta {
	return {
		id: randomUUID(),
		cwd,
		createdAt: new Date().toISOString(),
		model: null,
		provider: null,
		compiledPromptHash: null,
	};
}
