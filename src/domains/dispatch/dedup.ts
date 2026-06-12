/**
 * Dispatch duplicate guard, packaged as a middleware hook registration.
 *
 * Replaces the registry's former inline dispatchDuplicateBlock /
 * rememberSuccessfulDispatch pair. Within one user turn, a dispatch whose
 * normalized fingerprint already completed successfully is blocked so the
 * model reuses the existing receipt instead of re-running the fleet step.
 * Orchestrator-only: workers never register the dispatch tool.
 */

import { ToolNames } from "../../core/tool-names.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";

export const DISPATCH_DEDUP_REGISTRATION_ID = "guard.dispatch-dedup";

/** Bounded turn-id memory, matching the loop guard's policy. */
const DISPATCH_GUARD_TURN_LIMIT = 32;
const DISPATCH_DEFAULT_AGENT_ID = "coder";

export function createDispatchDedupRegistration(): MiddlewareHookRegistration {
	const successfulDispatchesByTurn = new Map<string, Set<string>>();

	const remember = (turnId: string, fingerprint: string): void => {
		let seen = successfulDispatchesByTurn.get(turnId);
		if (!seen) {
			seen = new Set<string>();
			successfulDispatchesByTurn.set(turnId, seen);
			while (successfulDispatchesByTurn.size > DISPATCH_GUARD_TURN_LIMIT) {
				const oldest = successfulDispatchesByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				successfulDispatchesByTurn.delete(oldest);
			}
		}
		seen.add(fingerprint);
	};

	return {
		id: DISPATCH_DEDUP_REGISTRATION_ID,
		description: "blocks re-running a dispatch that already completed successfully in this user turn",
		hooks: ["before_tool", "after_tool"],
		toolNames: [ToolNames.Dispatch],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			if (input.turnId === undefined) return [];
			const fingerprint = dispatchFingerprint(input.toolArgs);
			if (fingerprint === null) return [];
			if (input.hook === "before_tool") {
				const seen = successfulDispatchesByTurn.get(input.turnId);
				if (!seen?.has(fingerprint)) return [];
				const summary = formatDispatchDuplicateSummary(input.toolArgs);
				return [
					{
						kind: "block_tool",
						reason:
							`dispatch duplicate blocked: ${summary} already completed successfully in this user turn. ` +
							`Use the existing dispatch receipt/output to answer instead of repeating the same fleet dispatch.`,
						severity: "hard-block",
					},
				];
			}
			if (input.metadata?.resultKind !== "ok") return [];
			if (input.toolResultDetails?.exitCode !== 0) return [];
			remember(input.turnId, fingerprint);
			return [];
		},
	};
}

function dispatchFingerprint(args: MiddlewareHookInput["toolArgs"]): string | null {
	const record = asRecord(args);
	if (record === null) return null;
	const task = stringValue(record.task);
	if (task === null) return null;
	const normalized = {
		agentId:
			stringValue(record.agent_id) ??
			stringValue(record.agentId) ??
			stringValue(record.agent) ??
			DISPATCH_DEFAULT_AGENT_ID,
		task,
		target: stringValue(record.target) ?? "",
		model: stringValue(record.model) ?? "",
		profile:
			stringValue(record.agent_profile) ?? stringValue(record.worker_profile) ?? stringValue(record.workerProfile) ?? "",
		runtime:
			stringValue(record.agent_runtime) ?? stringValue(record.worker_runtime) ?? stringValue(record.workerRuntime) ?? "",
		toolProfile: stringValue(record.tool_profile) ?? stringValue(record.toolProfile) ?? "",
		thinkingLevel: stringValue(record.thinking_level) ?? stringValue(record.thinkingLevel) ?? "",
		cwd: stringValue(record.cwd) ?? "",
		memorySection: stringValue(record.memory_section) ?? stringValue(record.memorySection) ?? "",
		requiredCapabilities: stringArrayValue(record.required_capabilities ?? record.requiredCapabilities).sort(),
	};
	return stableJson(normalized);
}

function formatDispatchDuplicateSummary(args: MiddlewareHookInput["toolArgs"]): string {
	const record = asRecord(args);
	if (record === null) return "that dispatch";
	const agentId =
		stringValue(record.agent_id) ?? stringValue(record.agentId) ?? stringValue(record.agent) ?? DISPATCH_DEFAULT_AGENT_ID;
	const task = stringValue(record.task) ?? "";
	const taskSummary = task.length > 80 ? `${task.slice(0, 77)}...` : task;
	return `agent=${agentId} task=${JSON.stringify(taskSummary)}`;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringArrayValue(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
