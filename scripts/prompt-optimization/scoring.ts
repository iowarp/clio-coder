/**
 * Deterministic hard-gate scoring.
 *
 * `scorePromptAbTrial` is a pure function of a scenario and one observation.
 * No clock, no filesystem, no network, no model. That is what lets the offline
 * tests be real tests of the scoring rules rather than tests of a mock, and it
 * is what lets a blind reviewer re-score a trial months later and get the same
 * answer.
 *
 * Unresolved reads fail closed, matching `evaluateGate` in the eval domain: an
 * invariant whose input the observation does not carry is a hard failure, not a
 * pass. A metric that was never collected must never let a gate through
 * silently, because that is indistinguishable from the metric being collected
 * and being fine.
 */
import type {
	PromptAbAssertionOp,
	PromptAbCallOrigin,
	PromptAbHardGate,
	PromptAbInvariant,
	PromptAbInvariantOutcome,
	PromptAbMetricValue,
	PromptAbScenario,
	PromptAbToolCallObservation,
	PromptAbTrialObservation,
} from "./contract.js";

export interface PromptAbScore {
	outcomes: readonly PromptAbInvariantOutcome[];
	hardGate: PromptAbHardGate;
}

export function scorePromptAbTrial(scenario: PromptAbScenario, observation: PromptAbTrialObservation): PromptAbScore {
	const outcomes = scenario.invariants.map((invariant) => scoreInvariant(invariant, observation));
	const hardFailures = outcomes.filter((outcome) => outcome.severity === "hard" && !outcome.pass);
	return {
		outcomes,
		hardGate: {
			pass: hardFailures.length === 0,
			failed: hardFailures.filter((outcome) => !outcome.unresolved).map((outcome) => outcome.id),
			unresolved: hardFailures.filter((outcome) => outcome.unresolved).map((outcome) => outcome.id),
		},
	};
}

function scoreInvariant(invariant: PromptAbInvariant, observation: PromptAbTrialObservation): PromptAbInvariantOutcome {
	const reading = read(invariant, observation);
	return {
		id: invariant.id,
		severity: invariant.severity,
		expectation: invariant.expectation,
		pass: reading.unresolved ? false : reading.pass,
		unresolved: reading.unresolved,
		actual: reading.actual,
		detail: reading.detail,
	};
}

interface Reading {
	pass: boolean;
	unresolved: boolean;
	actual: PromptAbMetricValue | null;
	detail: string;
}

function resolved(pass: boolean, actual: PromptAbMetricValue, detail: string): Reading {
	return { pass, unresolved: false, actual, detail };
}

function unresolved(detail: string): Reading {
	return { pass: false, unresolved: true, actual: null, detail };
}

function read(invariant: PromptAbInvariant, observation: PromptAbTrialObservation): Reading {
	const spec = invariant.spec;
	switch (spec.kind) {
		case "exit-code":
			return compare(observation.exitCode, spec.op, spec.value, "exit code");

		case "metric": {
			const value = observation.metrics[spec.metric];
			if (value === undefined) return unresolved(`metric ${spec.metric} was not collected`);
			return compare(value, spec.op, spec.value, spec.metric);
		}

		case "tool-calls": {
			const count = countCalls(observation.toolCalls, spec.origin, (call) => matchesTool(call.tool, spec.tool));
			return compare(count, spec.op, spec.value, `${spec.origin} calls to ${spec.tool}`);
		}

		case "tool-call-budget": {
			const count = countCalls(observation.toolCalls, spec.origin, (call) =>
				spec.tools.some((tool) => matchesTool(call.tool, tool)),
			);
			return compare(count, spec.op, spec.value, `${spec.origin} calls to ${spec.tools.join("|")}`);
		}

		case "tool-blocked": {
			const count = countCalls(
				observation.toolCalls,
				spec.origin,
				(call) => call.outcome === "blocked" && matchesTool(call.tool, spec.tool),
			);
			return compare(count, spec.op, spec.value, `${spec.origin} blocked calls to ${spec.tool}`);
		}

		case "tool-order": {
			const firstAfter = observation.toolCalls.findIndex((call) => matchesTool(call.tool, spec.after));
			if (firstAfter < 0) {
				// The ordered pair never arose. The scenario's other gates decide
				// whether that is acceptable; ordering itself is satisfied.
				return resolved(true, 0, `no ${spec.after} call was made, so ordering is vacuous`);
			}
			const precedes = observation.toolCalls
				.slice(0, firstAfter)
				.some((call) => spec.before.some((tool) => matchesTool(call.tool, tool)));
			return resolved(
				precedes,
				firstAfter,
				precedes
					? `${spec.after} at index ${firstAfter} followed ${spec.before.join("|")}`
					: `${spec.after} at index ${firstAfter} preceded every ${spec.before.join("|")} call`,
			);
		}

		case "tool-path-scope": {
			const offending = observation.toolCalls.filter(
				(call) =>
					originMatches(call, spec.origin) &&
					spec.tools.some((tool) => matchesTool(call.tool, tool)) &&
					call.path !== null &&
					spec.forbidden.some((root) => pathWithin(call.path as string, root)),
			);
			return resolved(
				offending.length === 0,
				offending.length,
				offending.length === 0
					? "no call touched a forbidden path"
					: `forbidden paths touched: ${[...new Set(offending.map((call) => call.path))].join(", ")}`,
			);
		}

		case "repeated-rejected-call": {
			const seenRejected = new Set<string>();
			let repeats = 0;
			for (const call of observation.toolCalls) {
				if (seenRejected.has(call.shapeKey)) repeats += 1;
				if (call.outcome !== "ok") seenRejected.add(call.shapeKey);
			}
			return compare(repeats, spec.op, spec.value, "repeats of a rejected call shape");
		}

		case "workspace-mutations":
			return compare(observation.workspaceMutations.length, spec.op, spec.value, "workspace mutations");

		case "mutation-paths-within": {
			const outside = observation.workspaceMutations.filter(
				(path) => !spec.allowed.some((root) => pathWithin(path, root)),
			);
			return resolved(
				outside.length === 0,
				outside.length,
				outside.length === 0 ? "every mutation was in scope" : `mutations outside scope: ${outside.join(", ")}`,
			);
		}

		case "foreign-state":
			return compare(observation.foreignStatePaths.length, spec.op, spec.value, "forbidden state paths");

		case "answer-matches": {
			const pattern = new RegExp(spec.pattern, "u");
			const matched = pattern.test(observation.answerText);
			return resolved(matched, matched, `answer ${matched ? "matched" : "did not match"} /${spec.pattern}/`);
		}

		case "answer-omits": {
			const pattern = new RegExp(spec.pattern, "u");
			const matched = pattern.test(observation.answerText);
			return resolved(!matched, matched, `answer ${matched ? "contained" : "omitted"} /${spec.pattern}/`);
		}

		case "invented-capabilities":
			return compare(
				observation.inventedCapabilities.length,
				spec.op,
				spec.value,
				`invented capabilities (${observation.inventedCapabilities.join(", ") || "none"})`,
			);

		case "skills-loaded": {
			const loaded = [...observation.skills.loaded].sort();
			const expected = [...spec.expected].sort();
			const equal = loaded.length === expected.length && loaded.every((name, index) => name === expected[index]);
			return resolved(equal, loaded.length, `loaded [${loaded.join(", ")}], expected [${expected.join(", ")}]`);
		}

		case "skills-match-recipe-bound": {
			const bound = observation.skills.recipeBound;
			if (bound === null) return unresolved("the dispatched recipe's bound skills could not be read from the arm");
			const loaded = [...observation.skills.loaded].sort();
			const expected = [...bound].sort();
			const equal = loaded.length === expected.length && loaded.every((name, index) => name === expected[index]);
			return resolved(equal, loaded.length, `loaded [${loaded.join(", ")}], recipe binds [${expected.join(", ")}]`);
		}

		case "skills-suggested":
			return compare(observation.skills.suggested.length, spec.op, spec.value, "skills suggested");

		case "marketplace-offers":
			return compare(observation.skills.marketplaceOffers, spec.op, spec.value, "marketplace offers");

		case "skill-install-attempts":
			return compare(observation.skills.installAttempts, spec.op, spec.value, "skill install attempts");

		case "receipt": {
			if (observation.receipt === null) return unresolved("the run sealed no receipt to read");
			const value = observation.receipt[spec.field];
			return compare(value, spec.op, spec.value, `receipt.${spec.field}`);
		}
	}
}

/** `"*"` matches any tool; otherwise the match is exact. */
function matchesTool(tool: string, pattern: string): boolean {
	return pattern === "*" || tool === pattern;
}

function originMatches(call: PromptAbToolCallObservation, origin: PromptAbCallOrigin): boolean {
	return origin === "any" || call.origin === origin;
}

function countCalls(
	calls: readonly PromptAbToolCallObservation[],
	origin: PromptAbCallOrigin,
	predicate: (call: PromptAbToolCallObservation) => boolean,
): number {
	return calls.filter((call) => originMatches(call, origin) && predicate(call)).length;
}

function pathWithin(path: string, root: string): boolean {
	if (root === "." || root === "") return true;
	return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function compare(
	actual: PromptAbMetricValue,
	op: PromptAbAssertionOp,
	expected: PromptAbMetricValue,
	label: string,
): Reading {
	const detail = `${label}: ${JSON.stringify(actual)} ${op} ${JSON.stringify(expected)}`;
	if (op === "eq") return resolved(actual === expected, actual, detail);
	if (op === "neq") return resolved(actual !== expected, actual, detail);
	if (typeof actual !== "number" || typeof expected !== "number") {
		return unresolved(`${label}: ${op} needs two numbers, got ${typeof actual} and ${typeof expected}`);
	}
	const pass =
		op === "lt"
			? actual < expected
			: op === "lte"
				? actual <= expected
				: op === "gt"
					? actual > expected
					: actual >= expected;
	return resolved(pass, actual, detail);
}
