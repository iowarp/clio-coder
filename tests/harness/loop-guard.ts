import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createLoopState, hashToolCall, observe } from "../../src/domains/safety/loop-detector.js";
import { type CreateLoopGuardRegistrationOptions, createLoopGuardRegistration } from "../../src/engine/loop-guard.js";

type LoopGuardSafety = CreateLoopGuardRegistrationOptions["safety"];

/** The safety contract's loop observer over a fresh in-memory loop state, the only part the guard reads. */
export function loopSafety(): LoopGuardSafety {
	let loopState = createLoopState();
	return {
		observeLoop(key: string, now: number) {
			const [next, verdict] = observe(loopState, key, now);
			loopState = next;
			return verdict;
		},
	} as unknown as LoopGuardSafety;
}

/** How a settled call ended: its bash run time, its result text, and whether it failed with `error`. */
export interface GuardResult {
	elapsedMs?: number;
	output?: string;
	failed?: boolean;
	error?: string;
}

/** One tool call in a scenario. Consecutive calls sharing `batch` are one parallel model response. */
export interface GuardCall {
	tool: string;
	args: Record<string, unknown>;
	traits?: { readOnly: boolean; idempotent: boolean };
	batch?: string;
	result?: GuardResult;
}

/**
 * Drives a loop guard over `calls` in turn `turn-1`. A batch runs every
 * before_tool first, as a parallel response does, then settles each admitted
 * call. A batch's calls carry its size, as chat-loop's invoke options do.
 * Returns each call's admission and every block reason in order.
 */
export function runGuardScenario(
	options: Omit<CreateLoopGuardRegistrationOptions, "safety">,
	calls: ReadonlyArray<GuardCall>,
): { admitted: boolean[]; reasons: string[] } {
	const guard = createLoopGuardRegistration({ safety: loopSafety(), ...options });
	const admitted: boolean[] = [];
	const reasons: string[] = [];
	const traitsOf = (call: GuardCall) =>
		call.traits === undefined ? {} : { toolReadOnly: call.traits.readOnly, toolIdempotent: call.traits.idempotent };
	const base = (call: GuardCall) => ({
		turnId: "turn-1",
		toolName: call.tool,
		toolArgs: call.args,
		...(call.batch === undefined ? {} : { correlationId: call.batch }),
	});
	const settle = (call: GuardCall): void => {
		const result = call.result ?? { output: "manifest rev 1" };
		const failed = result.failed === true || result.error !== undefined;
		guard.evaluate({
			...base(call),
			hook: "after_tool",
			metadata: {
				...traitsOf(call),
				resultKind: failed ? "error" : "ok",
				...(result.output === undefined ? {} : { outcomeFingerprint: result.output }),
				...(result.output === undefined || failed ? {} : { resultFingerprint: result.output }),
				...(result.error === undefined ? {} : { errorMessage: result.error }),
			},
			...(result.elapsedMs === undefined ? {} : { toolResultDetails: { elapsedMs: result.elapsedMs } }),
		} as MiddlewareHookInput);
	};
	for (let start = 0; start < calls.length; ) {
		const batch = calls[start]?.batch;
		let end = start + 1;
		while (batch !== undefined && end < calls.length && calls[end]?.batch === batch) end++;
		const round = calls.slice(start, end);
		const verdicts = round.map((call) => {
			const block = guard
				.evaluate({
					...base(call),
					hook: "before_tool",
					metadata: {
						...traitsOf(call),
						callFingerprint: hashToolCall(call.tool, call.args),
						...(batch === undefined ? {} : { batchSize: round.length }),
					},
				} as MiddlewareHookInput)
				.find((effect) => effect.kind === "block_tool");
			if (block?.kind === "block_tool") reasons.push(block.reason);
			return block === undefined;
		});
		round.forEach((call, index) => {
			if (verdicts[index]) settle(call);
		});
		admitted.push(...verdicts);
		start = end;
	}
	return { admitted, reasons };
}
