import type { AgentMessage } from "../engine/types.js";

/**
 * A run's evidence is a log, not a slice of the projected `agent.state.messages`. A compaction rebuild, a cut or a
 * recovery edit rewrites that array inside a submit, so a position taken at the submit's start no longer marks where
 * the submit's own messages begin. The log holds every message event a submit's runs emitted, in order, each entry
 * stamped with the attempt that emitted it. An attempt is one engine run, from `agent_start` to `agent_end`.
 */
interface RunEvidenceEntry {
	readonly attemptId: number;
	/** Held by reference, so a settled message rewritten in place later (a stall reclassification) reads as rewritten. */
	readonly message: AgentMessage;
}

/** One submit's evidence, stable across its recovery prompts and readable after a newer submit began. */
export interface SubmitEvidence {
	/** The submit slice: every attempt's messages, each once, in the order they settled. */
	messages(): AgentMessage[];
}

export class RunEvidenceLog {
	#attemptId = 0;
	#entries: RunEvidenceEntry[] = [];

	/** Opens a submit and its first attempt; the handle keeps reading this submit's entries only. */
	beginSubmit(): SubmitEvidence {
		const entries: RunEvidenceEntry[] = [];
		this.#entries = entries;
		this.#attemptId = 1;
		return { messages: () => entries.map((entry) => entry.message) };
	}

	/** Opens the next attempt. An attempt that recorded nothing stays open, so a run that never started adds none. */
	beginAttempt(): void {
		if (this.#entries.some((entry) => entry.attemptId === this.#attemptId)) this.#attemptId += 1;
	}

	record(message: AgentMessage): void {
		this.#entries.push({ attemptId: this.#attemptId, message });
	}

	/** The attempt slice: the current attempt's messages only. */
	attempt(): AgentMessage[] {
		return this.#entries.filter((entry) => entry.attemptId === this.#attemptId).map((entry) => entry.message);
	}
}
