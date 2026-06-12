/**
 * Observer registrations for the after_tool hook.
 *
 * Replace the registry's former side-channel callbacks (`onSkillActivation`,
 * `onFileMutation` in RegistryDeps): the composition root creates these with
 * the sinks it owns (session ledger, codewiki) and registers them on the
 * middleware contract. Observers emit no effects; their sinks are best-effort
 * and a sink failure never changes tool execution.
 */

import { type SkillActivation, skillActivationFromToolDetails } from "../core/skill-activation.js";
import { ToolNames } from "../core/tool-names.js";
import type { MiddlewareEffect, MiddlewareHookRegistration } from "../domains/middleware/index.js";
import { toolMutationPaths } from "../domains/safety/protected-artifacts.js";

export const SKILL_ACTIVATION_OBSERVER_ID = "observer.skill-activation";
export const FILE_MUTATION_OBSERVER_ID = "observer.file-mutation";

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

/** Records successful read_skill activations into the caller's ledger. */
export function createSkillActivationObserver(sink: (activation: SkillActivation) => void): MiddlewareHookRegistration {
	return {
		id: SKILL_ACTIVATION_OBSERVER_ID,
		description: "records successful skill activations for the session ledger",
		hooks: ["after_tool"],
		toolNames: [ToolNames.ReadSkill],
		evaluate(input) {
			if (input.metadata?.resultKind !== "ok") return NO_EFFECTS;
			const activation = skillActivationFromToolDetails(input.toolResultDetails, input.turnId);
			if (!activation) return NO_EFFECTS;
			try {
				sink(activation);
			} catch {
				// Activation writes are audit metadata; the tool already succeeded.
			}
			return NO_EFFECTS;
		},
	};
}

export interface FileMutationEvent {
	paths: ReadonlyArray<string>;
	toolName: string;
}

/**
 * Defers file-mutation sinks off the after_tool hot path and coalesces rapid
 * events into one best-effort batch. A process exit before the pending flush
 * can drop the incremental refresh; session stop owns a full rebuild.
 */
export function coalescePathSink(sink: (paths: string[]) => void): (event: FileMutationEvent) => void {
	const pending = new Set<string>();
	let flushScheduled = false;

	const scheduleFlush = (): void => {
		if (flushScheduled) return;
		flushScheduled = true;
		setImmediate(() => {
			flushScheduled = false;
			if (pending.size === 0) return;
			const paths = [...pending];
			pending.clear();
			try {
				sink(paths);
			} catch {
				// Incremental indexing is best-effort and must not change tool execution.
			}
			if (pending.size > 0) scheduleFlush();
		});
	};

	return (event) => {
		if (event.paths.length === 0) return;
		for (const path of event.paths) pending.add(path);
		scheduleFlush();
	};
}

/** Notifies the caller after a successful file-mutating tool, for incremental indexing. */
export function createFileMutationObserver(sink: (event: FileMutationEvent) => void): MiddlewareHookRegistration {
	return {
		id: FILE_MUTATION_OBSERVER_ID,
		description: "reports successful file mutations for incremental codewiki refresh",
		hooks: ["after_tool"],
		evaluate(input) {
			if (input.metadata?.resultKind !== "ok") return NO_EFFECTS;
			const toolName = input.toolName ?? "";
			const paths = toolMutationPaths(toolName, input.toolArgs !== undefined ? { ...input.toolArgs } : undefined);
			if (paths.length === 0) return NO_EFFECTS;
			try {
				sink({ paths, toolName });
			} catch {
				// Incremental indexing is best-effort and must not change tool execution.
			}
			return NO_EFFECTS;
		},
	};
}
