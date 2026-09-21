import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ADVISORY_RESET_BAND,
	type AdvisoryMemory,
	DEFAULT_REDUCE_THRESHOLD,
	evaluatePressure,
	INITIAL_ADVISORY_MEMORY,
	type PressureFacts,
	type ResolvedPressurePolicy,
	resolvePressurePolicy,
} from "../../src/domains/context/budget/pressure.js";

const WINDOWS = [32_000, 64_000, 128_000, 1_000_000] as const;

function policyOrThrow(input?: Parameters<typeof resolvePressurePolicy>[0]): ResolvedPressurePolicy {
	const resolved = resolvePressurePolicy(input);
	if (!resolved.ok) throw new Error(`expected a valid policy, got ${resolved.reason}`);
	return resolved.policy;
}

const DEFAULT_POLICY = policyOrThrow();

/** Facts at a given fraction of the window, with no reserve or overhead. */
function factsAtRatio(ratio: number, window: number, overrides: Partial<PressureFacts> = {}): PressureFacts {
	return {
		revision: { sessionId: "s1", branchAnchorTurnId: "t9", revisionId: "r1" },
		inputTokens: Math.round(ratio * window),
		inputSource: "estimated",
		effectiveContextWindow: window,
		outputReserveTokens: 0,
		pendingRequestOverheadTokens: 0,
		reduction: "available",
		...overrides,
	};
}

function near(actual: number, expected: number, tolerance = 1e-9): boolean {
	return Math.abs(actual - expected) < tolerance;
}

describe("pressure policy resolution", () => {
	it("derives the candidate advisory levels from the default reduce threshold", () => {
		strictEqual(DEFAULT_POLICY.reduce, DEFAULT_REDUCE_THRESHOLD);
		ok(near(DEFAULT_POLICY.notice, 0.65), `notice was ${DEFAULT_POLICY.notice}`);
		ok(near(DEFAULT_POLICY.prepare, 0.72), `prepare was ${DEFAULT_POLICY.prepare}`);
		strictEqual(DEFAULT_POLICY.derived, true);
		ok(DEFAULT_POLICY.target < DEFAULT_POLICY.notice);
	});

	it("scales advisories below a configured lower reduce threshold instead of exceeding it", () => {
		const policy = policyOrThrow({ reduceThreshold: 0.5, workingSetTarget: 0.35 });
		ok(policy.notice < policy.prepare && policy.prepare < policy.reduce, "advisories must stay strictly ordered");
		ok(policy.prepare < 0.5, "a configured 0.5 reduce point cannot sit below its own prepare level");
		ok(near(policy.notice, 0.40625), `notice was ${policy.notice}`);
		ok(near(policy.prepare, 0.45), `prepare was ${policy.prepare}`);
	});

	it("accepts explicitly configured, strictly ordered advisories", () => {
		const policy = policyOrThrow({ noticeThreshold: 0.5, prepareThreshold: 0.6 });
		strictEqual(policy.notice, 0.5);
		strictEqual(policy.prepare, 0.6);
		strictEqual(policy.derived, false);
	});

	it("rejects invalid policies rather than silently repairing them", () => {
		const cases: Array<[Parameters<typeof resolvePressurePolicy>[0], string]> = [
			[{ reduceThreshold: 0 }, "reduce-threshold-out-of-range"],
			[{ reduceThreshold: 1.5 }, "reduce-threshold-out-of-range"],
			[{ reduceThreshold: Number.NaN }, "reduce-threshold-out-of-range"],
			[{ workingSetTarget: 0.9 }, "target-out-of-range"],
			[{ workingSetTarget: 0 }, "target-out-of-range"],
			[{ noticeThreshold: 0.5 }, "advisory-thresholds-incomplete"],
			[{ noticeThreshold: 0.7, prepareThreshold: 0.6 }, "advisory-thresholds-out-of-order"],
			[{ noticeThreshold: 0.6, prepareThreshold: 0.85 }, "advisory-thresholds-out-of-order"],
		];
		for (const [input, reason] of cases) {
			const resolved = resolvePressurePolicy(input);
			strictEqual(resolved.ok, false, `expected rejection for ${JSON.stringify(input)}`);
			if (!resolved.ok) strictEqual(resolved.reason, reason);
		}
	});
});

describe("phases across window sizes", () => {
	it("depends on the ratio, not the absolute window", () => {
		for (const window of WINDOWS) {
			strictEqual(evaluatePressure(factsAtRatio(0.5, window), DEFAULT_POLICY).phase, "normal", `window ${window}`);
			strictEqual(evaluatePressure(factsAtRatio(0.66, window), DEFAULT_POLICY).phase, "notice", `window ${window}`);
			strictEqual(evaluatePressure(factsAtRatio(0.74, window), DEFAULT_POLICY).phase, "prepare", `window ${window}`);
			strictEqual(evaluatePressure(factsAtRatio(0.85, window), DEFAULT_POLICY).phase, "reduce", `window ${window}`);
		}
	});

	it("prices the caller's pending overhead into the same pressure figure", () => {
		const withoutOverhead = evaluatePressure(factsAtRatio(0.6, 32_000), DEFAULT_POLICY);
		const withOverhead = evaluatePressure(
			factsAtRatio(0.6, 32_000, { pendingRequestOverheadTokens: 3_000 }),
			DEFAULT_POLICY,
		);
		strictEqual(withoutOverhead.phase, "normal");
		strictEqual(withOverhead.completeInputTokens, 22_200);
		strictEqual(withOverhead.phase, "notice");
	});
});

describe("request admission against the real output reserve", () => {
	it("recovers on overflow even when every percentage threshold is below notice", () => {
		const facts = factsAtRatio(0.625, 32_000, { outputReserveTokens: 16_000 });
		const decision = evaluatePressure(facts, DEFAULT_POLICY);
		ok(decision.pressure !== null && decision.pressure < DEFAULT_POLICY.notice, "pressure must be below notice");
		strictEqual(decision.phase, "recover");
		strictEqual(decision.admission.result, "unsafe");
		strictEqual(decision.admission.reason, "exceeds-window");
		strictEqual(decision.admission.requiredTokens, 36_000);
		strictEqual(decision.headroomTokens, -4_000);
		strictEqual(decision.advisory.emit, false);
	});

	it("admits the same input when the reserve fits", () => {
		const decision = evaluatePressure(factsAtRatio(0.625, 32_000, { outputReserveTokens: 4_000 }), DEFAULT_POLICY);
		strictEqual(decision.phase, "normal");
		strictEqual(decision.admission.result, "admit");
		strictEqual(decision.headroomTokens, 8_000);
	});

	it("asks for reduction first at the reduce threshold while the request would still fit", () => {
		const decision = evaluatePressure(factsAtRatio(0.85, 64_000, { outputReserveTokens: 2_000 }), DEFAULT_POLICY);
		strictEqual(decision.phase, "reduce");
		strictEqual(decision.admission.result, "reduce-first");
		strictEqual(decision.admission.reason, "pressure-at-reduce-threshold");
		ok(decision.headroomTokens !== null && decision.headroomTokens > 0);
	});

	it("reports a measured reading without upgrading an estimate to a provider-exact claim", () => {
		const estimated = evaluatePressure(factsAtRatio(0.5, 32_000), DEFAULT_POLICY);
		strictEqual(estimated.measured, true);
		strictEqual(estimated.inputSource, "estimated");
		const trusted = evaluatePressure(factsAtRatio(0.5, 32_000, { inputSource: "trusted" }), DEFAULT_POLICY);
		strictEqual(trusted.inputSource, "trusted");
		strictEqual(trusted.pressure, estimated.pressure, "the source label does not change the arithmetic");
	});
});

describe("unknown and malformed measurements", () => {
	const unknownWindows: Array<number | null> = [null, Number.NaN, 0, -1, Number.POSITIVE_INFINITY];
	it("never reports an unresolved window as safe", () => {
		for (const window of unknownWindows) {
			const decision = evaluatePressure(factsAtRatio(0.5, 32_000, { effectiveContextWindow: window }), DEFAULT_POLICY);
			strictEqual(decision.measured, false, `window ${String(window)}`);
			strictEqual(decision.pressure, null);
			strictEqual(decision.headroomTokens, null);
			strictEqual(decision.admission.result, "unknown");
			strictEqual(decision.admission.reason, "window-unknown");
		}
	});

	it("never reports unmeasured input as zero", () => {
		for (const input of [null, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
			const decision = evaluatePressure(factsAtRatio(0.5, 32_000, { inputTokens: input }), DEFAULT_POLICY);
			strictEqual(decision.measured, false, `input ${String(input)}`);
			strictEqual(decision.admission.result, "unknown");
			strictEqual(decision.admission.reason, "input-unknown");
			strictEqual(decision.completeInputTokens, null);
		}
	});

	it("treats a malformed reserve or overhead as unknown rather than free", () => {
		const badReserve = evaluatePressure(factsAtRatio(0.5, 32_000, { outputReserveTokens: Number.NaN }), DEFAULT_POLICY);
		strictEqual(badReserve.admission.result, "unknown");
		const badOverhead = evaluatePressure(
			factsAtRatio(0.5, 32_000, { pendingRequestOverheadTokens: -10 }),
			DEFAULT_POLICY,
		);
		strictEqual(badOverhead.admission.result, "unknown");
	});

	it("leaves a prior announcement standing when the turn proves nothing", () => {
		const armed = evaluatePressure(factsAtRatio(0.66, 32_000), DEFAULT_POLICY);
		strictEqual(armed.memory.announcedPhase, "notice");
		const unmeasured = evaluatePressure(
			factsAtRatio(0.66, 32_000, { effectiveContextWindow: null }),
			DEFAULT_POLICY,
			armed.memory,
		);
		strictEqual(unmeasured.memory.announcedPhase, "notice");
		strictEqual(unmeasured.advisory.suppressedBy, "measurement-unknown");
	});
});

describe("advisory hysteresis", () => {
	it("announces a crossing once and stays quiet while it holds", () => {
		const first = evaluatePressure(factsAtRatio(0.66, 64_000), DEFAULT_POLICY);
		strictEqual(first.advisory.emit, true);
		strictEqual(first.advisory.phase, "notice");

		const second = evaluatePressure(factsAtRatio(0.67, 64_000), DEFAULT_POLICY, first.memory);
		strictEqual(second.phase, "notice");
		strictEqual(second.advisory.emit, false);
		strictEqual(second.advisory.suppressedBy, "already-announced");
	});

	it("announces an escalation but not a descent", () => {
		const notice = evaluatePressure(factsAtRatio(0.66, 64_000), DEFAULT_POLICY);
		const prepare = evaluatePressure(factsAtRatio(0.74, 64_000), DEFAULT_POLICY, notice.memory);
		strictEqual(prepare.advisory.emit, true);
		strictEqual(prepare.advisory.phase, "prepare");

		const backToNotice = evaluatePressure(factsAtRatio(0.66, 64_000), DEFAULT_POLICY, prepare.memory);
		strictEqual(backToNotice.phase, "notice");
		strictEqual(backToNotice.advisory.emit, false);
	});

	it("re-arms only after pressure falls below the reset band", () => {
		const notice = evaluatePressure(factsAtRatio(0.66, 64_000), DEFAULT_POLICY);
		const justBelowNotice = evaluatePressure(factsAtRatio(0.64, 64_000), DEFAULT_POLICY, notice.memory);
		ok(
			justBelowNotice.pressure !== null && justBelowNotice.pressure > DEFAULT_POLICY.notice * (1 - ADVISORY_RESET_BAND),
			"0.64 must sit inside the reset band",
		);
		strictEqual(justBelowNotice.memory.announcedPhase, "notice", "inside the band the announcement stands");

		const wellBelow = evaluatePressure(factsAtRatio(0.4, 64_000), DEFAULT_POLICY, justBelowNotice.memory);
		strictEqual(wellBelow.memory.announcedPhase, "normal");
		const reannounced = evaluatePressure(factsAtRatio(0.66, 64_000), DEFAULT_POLICY, wellBelow.memory);
		strictEqual(reannounced.advisory.emit, true);
	});

	it("re-arms when the window or the policy changes under the same session", () => {
		const notice = evaluatePressure(factsAtRatio(0.66, 64_000), DEFAULT_POLICY);
		const newWindow = evaluatePressure(factsAtRatio(0.66, 128_000), DEFAULT_POLICY, notice.memory);
		strictEqual(newWindow.advisory.emit, true, "a different effective window is a different budget");

		const otherPolicy = policyOrThrow({ reduceThreshold: 0.7, workingSetTarget: 0.5 });
		const newPolicy = evaluatePressure(factsAtRatio(0.66, 64_000), DEFAULT_POLICY, notice.memory);
		strictEqual(newPolicy.advisory.emit, false, "same policy, same window: still quiet");
		const rearmed = evaluatePressure(factsAtRatio(0.6, 64_000), otherPolicy, notice.memory);
		strictEqual(rearmed.phase, "notice", "0.6 crosses the scaled notice level of a 0.7 policy");
		strictEqual(rearmed.advisory.emit, true);
	});
});

describe("no-useful-cut suppression", () => {
	const highPressure = (revisionId: string, reduction: PressureFacts["reduction"]): PressureFacts =>
		factsAtRatio(0.9, 32_000, {
			reduction,
			revision: { sessionId: "s1", branchAnchorTurnId: "t9", revisionId },
		});

	it("stops asking for a cut that the same revision already refused", () => {
		const refused = evaluatePressure(highPressure("r1", "no-useful-cut"), DEFAULT_POLICY);
		strictEqual(refused.phase, "reduce");
		strictEqual(refused.admission.result, "admit", "a safe request is not blocked by an impossible cut");
		ok(refused.memory.noCutKey !== null, "the refusal is remembered against the exact request identity");

		const again = evaluatePressure(highPressure("r1", "unknown"), DEFAULT_POLICY, refused.memory);
		strictEqual(again.admission.result, "admit");
		strictEqual(again.advisory.suppressedBy, "no-useful-cut-unchanged-revision");
	});

	it("lifts suppression once the revision changes materially", () => {
		const refused = evaluatePressure(highPressure("r1", "no-useful-cut"), DEFAULT_POLICY);
		const nextRevision = evaluatePressure(highPressure("r2", "available"), DEFAULT_POLICY, refused.memory);
		strictEqual(nextRevision.admission.result, "reduce-first");
		strictEqual(nextRevision.memory.noCutKey, null);
	});

	it("reports an unsafe overflow with no material as its own reason", () => {
		const facts = factsAtRatio(0.9, 32_000, { outputReserveTokens: 8_000, reduction: "no-useful-cut" });
		const decision = evaluatePressure(facts, DEFAULT_POLICY);
		strictEqual(decision.phase, "recover");
		strictEqual(decision.admission.result, "unsafe");
		strictEqual(decision.admission.reason, "exceeds-window-no-material");
	});
});

describe("material identity versus ordinary revision growth", () => {
	const atNotice = (overrides: Partial<PressureFacts> = {}): PressureFacts =>
		factsAtRatio(0.7, 100_000, { outputReserveTokens: 1_000, ...overrides });

	it("stays quiet while ordinary appended content changes the revision", () => {
		const first = evaluatePressure(atNotice(), DEFAULT_POLICY);
		strictEqual(first.advisory.emit, true);
		const grown = evaluatePressure(
			atNotice({ revision: { sessionId: "s1", branchAnchorTurnId: "t9", revisionId: "r2" } }),
			DEFAULT_POLICY,
			first.memory,
		);
		strictEqual(grown.phase, "notice");
		strictEqual(grown.advisory.emit, false, "a tool result appended mid-turn is not a new advisory epoch");
		strictEqual(grown.advisory.suppressedBy, "already-announced");
	});

	it("re-arms when the material context identity changes", () => {
		const first = evaluatePressure(atNotice({ contextIdentity: { modelId: "model-a" } }), DEFAULT_POLICY);
		strictEqual(first.advisory.emit, true);
		for (const identity of [
			{ modelId: "model-b" },
			{ modelId: "model-a", targetId: "other-target" },
			{ modelId: "model-a", promptFingerprint: "prompt-2" },
			{ modelId: "model-a", toolSignature: "tools-2" },
			{ modelId: "model-a", epoch: 7 },
		]) {
			const changed = evaluatePressure(atNotice({ contextIdentity: identity }), DEFAULT_POLICY, first.memory);
			strictEqual(changed.advisory.emit, true, `expected re-arm for ${JSON.stringify(identity)}`);
		}
	});

	it("re-arms on a session or branch change", () => {
		const first = evaluatePressure(atNotice(), DEFAULT_POLICY);
		const otherSession = evaluatePressure(
			atNotice({ revision: { sessionId: "s2", branchAnchorTurnId: "t9", revisionId: "r1" } }),
			DEFAULT_POLICY,
			first.memory,
		);
		strictEqual(otherSession.advisory.emit, true);
		const otherBranch = evaluatePressure(
			atNotice({ revision: { sessionId: "s1", branchAnchorTurnId: "t42", revisionId: "r1" } }),
			DEFAULT_POLICY,
			first.memory,
		);
		strictEqual(otherBranch.advisory.emit, true);
	});

	it("does not let identity components collide through concatenation", () => {
		const left = evaluatePressure(
			atNotice({ revision: { sessionId: "a|b", branchAnchorTurnId: "c", revisionId: "r1" } }),
			DEFAULT_POLICY,
		);
		strictEqual(left.advisory.emit, true);
		const right = evaluatePressure(
			atNotice({ revision: { sessionId: "a", branchAnchorTurnId: "b|c", revisionId: "r1" } }),
			DEFAULT_POLICY,
			left.memory,
		);
		strictEqual(right.advisory.emit, true, "two different sessions must not share one advisory identity");
	});

	it("keeps an unknown reading from consuming the re-arm of an identity change", () => {
		const armed = evaluatePressure(atNotice({ contextIdentity: { modelId: "model-a" } }), DEFAULT_POLICY);
		const unknown = evaluatePressure(
			atNotice({ contextIdentity: { modelId: "model-b" }, effectiveContextWindow: null }),
			DEFAULT_POLICY,
			armed.memory,
		);
		deepStrictEqual(unknown.memory, armed.memory, "an unmeasured turn must not advance advisory identity");
		const known = evaluatePressure(atNotice({ contextIdentity: { modelId: "model-b" } }), DEFAULT_POLICY, unknown.memory);
		strictEqual(known.advisory.emit, true, "the first known reading after the change still announces");
	});
});

describe("no-useful-cut is scoped to the complete request identity", () => {
	const refusedAt = (overrides: Partial<PressureFacts> = {}): PressureFacts =>
		factsAtRatio(0.9, 32_000, { reduction: "no-useful-cut", ...overrides });
	const availableAt = (overrides: Partial<PressureFacts> = {}): PressureFacts =>
		factsAtRatio(0.9, 32_000, { reduction: "available", ...overrides });

	it("does not carry a refusal into another session at the same revision id", () => {
		const refused = evaluatePressure(refusedAt(), DEFAULT_POLICY);
		const otherSession = evaluatePressure(
			availableAt({ revision: { sessionId: "s2", branchAnchorTurnId: "t9", revisionId: "r1" } }),
			DEFAULT_POLICY,
			refused.memory,
		);
		strictEqual(otherSession.admission.result, "reduce-first");
		strictEqual(otherSession.advisory.suppressedBy, "not-crossed");
		strictEqual(otherSession.memory.noCutKey, null, "stale no-cut state must not follow the session switch");
	});

	it("does not carry a refusal across a branch, window, or context identity change", () => {
		const refused = evaluatePressure(refusedAt({ contextIdentity: { modelId: "model-a" } }), DEFAULT_POLICY);
		const cases: Array<[string, PressureFacts]> = [
			["branch", availableAt({ revision: { sessionId: "s1", branchAnchorTurnId: "t42", revisionId: "r1" } })],
			["window", availableAt({ effectiveContextWindow: 64_000, inputTokens: 57_600 })],
			["model", availableAt({ contextIdentity: { modelId: "model-b" } })],
		];
		for (const [label, facts] of cases) {
			const decision = evaluatePressure(facts, DEFAULT_POLICY, refused.memory);
			strictEqual(decision.admission.result, "reduce-first", `${label} change must clear the refusal`);
			strictEqual(decision.memory.noCutKey, null, `${label} change must not retain a stale no-cut key`);
		}
	});

	it("does not carry a refusal across an eviction-target change at the same thresholds", () => {
		const refused = evaluatePressure(refusedAt(), DEFAULT_POLICY);
		const otherTarget = policyOrThrow({ workingSetTarget: 0.45 });
		strictEqual(otherTarget.reduce, DEFAULT_POLICY.reduce, "thresholds are unchanged; only the target moved");
		const decision = evaluatePressure(availableAt(), otherTarget, refused.memory);
		strictEqual(decision.admission.result, "reduce-first", "a different eviction target can yield different cuts");
	});

	it("still suppresses a repeat of the identical request", () => {
		const refused = evaluatePressure(refusedAt(), DEFAULT_POLICY);
		const repeat = evaluatePressure(availableAt({ reduction: "unknown" }), DEFAULT_POLICY, refused.memory);
		strictEqual(repeat.admission.result, "admit");
		strictEqual(repeat.advisory.suppressedBy, "no-useful-cut-unchanged-revision");
		strictEqual(repeat.memory.noCutKey, refused.memory.noCutKey);
	});
});

describe("jumps and purity", () => {
	it("lets a single oversized observation skip every advisory phase", () => {
		const calm = evaluatePressure(factsAtRatio(0.3, 128_000), DEFAULT_POLICY);
		strictEqual(calm.phase, "normal");
		const jump = evaluatePressure(
			factsAtRatio(0.95, 128_000, { outputReserveTokens: 20_000 }),
			DEFAULT_POLICY,
			calm.memory,
		);
		strictEqual(jump.phase, "recover");
		strictEqual(jump.admission.result, "unsafe");
		strictEqual(jump.memory.announcedPhase, "normal", "no advisory was ever announced on the way up");
	});

	it("returns frozen values and does not mutate its inputs", () => {
		const facts = factsAtRatio(0.74, 64_000);
		const snapshotOfFacts = structuredClone(facts);
		const memory: AdvisoryMemory = { ...INITIAL_ADVISORY_MEMORY };
		const first = evaluatePressure(facts, DEFAULT_POLICY, memory);
		const second = evaluatePressure(facts, DEFAULT_POLICY, memory);
		deepStrictEqual(facts, snapshotOfFacts);
		deepStrictEqual(memory, { ...INITIAL_ADVISORY_MEMORY });
		deepStrictEqual(first, second);
		ok(Object.isFrozen(first) && Object.isFrozen(first.memory) && Object.isFrozen(first.admission));
	});
});
