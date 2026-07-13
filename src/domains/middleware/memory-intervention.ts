import { createHash } from "node:crypto";
import { TASK_MEMORY_DEFAULT_PROCEDURAL_CAP, type TaskMemoryBank } from "../memory/task-bank.js";
import { hashToolCall } from "../safety/loop-detector.js";
import { ceilChars } from "../session/context-accounting.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

export const MEMORY_INTERVENTION_REGISTRATION_ID = "observer.memory-intervention";
export const MEMORY_INTERVENTION_DEFAULT_WINDOW_STEPS = 8;
export const MEMORY_INTERVENTION_DEFAULT_MAX_TOKENS = 400;

const RESULT_DIGEST_MAX_CHARS = 240;
const CALL_DESCRIPTION_MAX_CHARS = 180;
const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

type ToolOutcome = "ok" | "error";

interface PendingToolStep {
	toolName: string;
	fingerprint: string;
	callDescription: string;
}

interface TrajectoryStep extends PendingToolStep {
	step: number;
	outcome: ToolOutcome;
	resultDigest: string;
}

interface FailedAttempt {
	entryId: string;
	attempts: number;
	firstStep: number;
	callDescription: string;
	errorDigest: string;
}

export interface MemoryInterventionDeps {
	bank: TaskMemoryBank;
	enabled?: boolean;
	windowSteps?: number;
	maxTokens?: number;
}

/**
 * Rules-only proactive-memory policy. It observes bounded tool history and
 * emits only cited, advisory reminders through the existing visible channel.
 */
export function createMemoryInterventionRegistration(deps: MemoryInterventionDeps): MiddlewareHookRegistration {
	const enabled = deps.enabled ?? true;
	const windowSteps = positiveInteger(deps.windowSteps, MEMORY_INTERVENTION_DEFAULT_WINDOW_STEPS);
	const maxTokens = positiveInteger(deps.maxTokens, MEMORY_INTERVENTION_DEFAULT_MAX_TOKENS);
	const pending = new Map<string, PendingToolStep>();
	const trajectory: TrajectoryStep[] = [];
	const failures = new Map<string, FailedAttempt>();
	let toolStep = 0;
	let lastTurnEndStep = 0;
	let reactivateAfterCompaction = false;
	let lastInjectedFingerprint: string | null = null;

	return {
		id: MEMORY_INTERVENTION_REGISTRATION_ID,
		description: "maintain bounded task execution memory and selectively remind after repeated failures or compaction",
		hooks: ["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			if (!enabled) return NO_EFFECTS;
			try {
				switch (input.hook) {
					case "before_tool":
						observeBeforeTool(input);
						return NO_EFFECTS;
					case "after_tool":
						observeAfterTool(input);
						return NO_EFFECTS;
					case "turn_end":
						return decideRepeatedFailure();
					case "on_compaction":
						reactivateAfterCompaction = true;
						return NO_EFFECTS;
					case "turn_start":
						return reactivateKnowledge();
				}
			} catch {
				return NO_EFFECTS;
			}
		},
	};

	function observeBeforeTool(input: MiddlewareHookInput): void {
		const prepared = prepareToolStep(input);
		if (prepared === null) return;
		setBounded(pending, pendingKey(input, prepared.fingerprint), prepared, windowSteps);
	}

	function observeAfterTool(input: MiddlewareHookInput): void {
		const fallback = prepareToolStep(input);
		if (fallback === null) return;
		const key = pendingKey(input, fallback.fingerprint);
		const prepared = pending.get(key) ?? fallback;
		pending.delete(key);
		const outcome = input.metadata?.resultKind === "error" ? "error" : "ok";
		toolStep += 1;
		const step: TrajectoryStep = {
			...prepared,
			step: toolStep,
			outcome,
			resultDigest: resultDigest(input, outcome),
		};
		trajectory.push(step);
		if (trajectory.length > windowSteps) trajectory.splice(0, trajectory.length - windowSteps);
		if (outcome === "error") rememberFailure(step);
	}

	function rememberFailure(step: TrajectoryStep): void {
		const previous = failures.get(step.fingerprint);
		const attempts = (previous?.attempts ?? 0) + 1;
		const firstStep = previous?.firstStep ?? step.step;
		const content = proceduralContent(step.callDescription, attempts, firstStep, step.resultDigest);
		let entryId: string;
		if (previous === undefined) {
			entryId = deps.bank.saveProcedural(content).id;
		} else {
			try {
				entryId = deps.bank.saveProcedural(content, { id: previous.entryId }).id;
			} catch {
				entryId = deps.bank.saveProcedural(content).id;
			}
		}
		setBounded(
			failures,
			step.fingerprint,
			{
				entryId,
				attempts,
				firstStep,
				callDescription: step.callDescription,
				errorDigest: step.resultDigest,
			},
			TASK_MEMORY_DEFAULT_PROCEDURAL_CAP,
		);
	}

	function decideRepeatedFailure(): ReadonlyArray<MiddlewareEffect> {
		try {
			for (let index = trajectory.length - 1; index >= 0; index -= 1) {
				const step = trajectory[index];
				if (
					step === undefined ||
					step.outcome !== "error" ||
					step.step <= lastTurnEndStep ||
					step.fingerprint === lastInjectedFingerprint
				) {
					continue;
				}
				const occurrences = trajectory.filter(
					(candidate) => candidate.outcome === "error" && candidate.fingerprint === step.fingerprint,
				).length;
				const failure = failures.get(step.fingerprint);
				if (occurrences < 2 || failure === undefined) continue;
				const message = boundedReminder(
					`Memory: [${failure.entryId}] you already tried ${failure.callDescription} at step ${failure.firstStep} and it failed with ${failure.errorDigest}.`,
					maxTokens,
				);
				if (message.length === 0) return NO_EFFECTS;
				lastInjectedFingerprint = step.fingerprint;
				deps.bank.recordInjection([failure.entryId]);
				return [{ kind: "inject_reminder", message, severity: "advisory" }];
			}
			return NO_EFFECTS;
		} finally {
			lastTurnEndStep = toolStep;
		}
	}

	function reactivateKnowledge(): ReadonlyArray<MiddlewareEffect> {
		if (!reactivateAfterCompaction) return NO_EFFECTS;
		reactivateAfterCompaction = false;
		const prefix = "Memory: execution state restored after compaction:\n";
		const prefixTokens = ceilChars(prefix.length);
		const rendered = deps.bank.render(Math.max(0, maxTokens - prefixTokens), ["knowledge"]);
		if (rendered.length === 0) return NO_EFFECTS;
		const message = boundedReminder(`${prefix}${rendered}`, maxTokens);
		if (message.length === 0) return NO_EFFECTS;
		const citedIds = [...message.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]).filter((id) => id !== undefined);
		deps.bank.recordInjection(citedIds);
		return [{ kind: "inject_reminder", message, severity: "advisory" }];
	}
}

function prepareToolStep(input: MiddlewareHookInput): PendingToolStep | null {
	const toolName = input.toolName?.trim();
	if (!toolName) return null;
	const canonical = hashToolCall(toolName, input.toolArgs ?? {});
	return {
		toolName,
		fingerprint: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
		callDescription: shortText(canonical, CALL_DESCRIPTION_MAX_CHARS),
	};
}

function pendingKey(input: MiddlewareHookInput, fingerprint: string): string {
	return input.toolCallId ?? `anonymous:${fingerprint}`;
}

function resultDigest(input: MiddlewareHookInput, outcome: ToolOutcome): string {
	if (outcome === "error") {
		const metadataMessage = input.metadata?.errorMessage;
		if (typeof metadataMessage === "string" && metadataMessage.trim().length > 0) {
			return shortText(metadataMessage, RESULT_DIGEST_MAX_CHARS);
		}
		for (const key of ["error", "message"] as const) {
			const value = input.toolResultDetails?.[key];
			if (typeof value === "string" && value.trim().length > 0) return shortText(value, RESULT_DIGEST_MAX_CHARS);
		}
		return "an unknown tool error";
	}
	const resultFingerprint = input.metadata?.resultFingerprint;
	return typeof resultFingerprint === "string" ? `ok result ${resultFingerprint.slice(0, 16)}` : "ok";
}

function proceduralContent(call: string, attempts: number, firstStep: number, error: string): string {
	return `${call} failed ${attempts} time${attempts === 1 ? "" : "s"}; first observed at step ${firstStep}: ${error}.`;
}

function boundedReminder(message: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (maxChars <= 0) return "";
	const normalized = message.replace(/[^\S\n]+/gu, " ").trim();
	return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars).trimEnd();
}

function shortText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
	if (!map.has(key) && map.size >= capacity) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}
