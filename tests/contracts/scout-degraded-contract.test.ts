/**
 * The degraded Scout acceptance (E19 item 3). One of two identical live scout
 * runs died after two bounded repair rounds on the `{claim, path, line}` shape
 * at 51k tokens and returned nothing usable: the evidence was fine, the
 * envelope was not, and failing the run threw the evidence away with it.
 *
 * These cases pin the whole bargain. A result carrying usable claims conforms
 * so the claims reach the parent; it never earns a `pass` quality label,
 * because a shape this validator had to repair is not correctness evidence;
 * and it never reaches the control plane, because a subtask a coordinator acts
 * on is not something to salvage from a malformed object.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseScoutResult,
	RESULT_CONTRACT_REPAIR_LIMIT,
	resultContractRepairMessage,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";

const FILE = "one\ntwo\nthree\nfour\nfive\nsix";
const filesystem = { readFile: (p: string): string | null => (p === "/repo/src/a.ts" ? FILE : null) };

function validate(output: string, observedReadRanges?: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>) {
	return validateResultContract({
		contract: { kind: "scout-report" },
		output,
		cwd: "/repo",
		networkAllowed: false,
		filesystem,
		...(observedReadRanges !== undefined ? { observedReadRanges } : {}),
	});
}

describe("contracts/scout degraded result acceptance", () => {
	it("keeps a claim that arrived without a citation instead of losing the run", () => {
		// The exact shape a small model reaches for when it cannot hold the full
		// contract: the observation is right there, the envelope is not.
		const result = validate(JSON.stringify({ findings: [{ claim: "the boundary is declared in write-boundary" }] }));
		strictEqual(result.conformance, "pass");
		strictEqual(result.quality, "unmeasured");
		deepStrictEqual(result.scout?.ungroundedClaims, ["the boundary is declared in write-boundary"]);
		deepStrictEqual(result.scout?.findings, []);
		ok(result.reason?.includes("degraded reconnaissance result"), result.reason);
		ok(result.reason?.includes("leads, not validation evidence"), result.reason);
	});

	it("keeps grounded and ungrounded claims apart in the same degraded result", () => {
		const result = validate(
			JSON.stringify({
				findings: [
					{ claim: "grounded observation", path: "src/a.ts", line: 2 },
					{ claim: "no citation for this one" },
					{ claim: "line number is a guess", path: "src/a.ts", line: "three" },
				],
				needsSplit: false,
				proposedSubtasks: [],
				summary: "an unknown field is what broke the strict parse",
			}),
		);
		strictEqual(result.conformance, "pass");
		strictEqual(result.quality, "unmeasured");
		deepStrictEqual(result.scout?.findings, [{ claim: "grounded observation", path: "src/a.ts", line: 2 }]);
		deepStrictEqual(result.scout?.citations, [{ path: "src/a.ts", line: 2 }]);
		deepStrictEqual(result.scout?.ungroundedClaims, ["no citation for this one", "line number is a guess"]);
	});

	it("demotes a citation that does not ground rather than failing a degraded result", () => {
		// The run read lines 1..3. On a strict result line 5 is fabrication and
		// fails everything; here the claim survives as a lead.
		const observed = new Map([["/repo/src/a.ts", [[1, 3] as const]]]);
		const result = validate(
			JSON.stringify({
				findings: [
					{ claim: "read live", path: "src/a.ts", line: 2 },
					{ claim: "line was approximated", path: "src/a.ts", line: 5 },
					{ claim: "file was never opened", path: "src/b.ts", line: 1 },
				],
				needsSplit: "no",
			}),
			observed,
		);
		strictEqual(result.conformance, "pass");
		strictEqual(result.quality, "unmeasured");
		deepStrictEqual(result.scout?.findings, [{ claim: "read live", path: "src/a.ts", line: 2 }]);
		deepStrictEqual(result.scout?.ungroundedClaims, ["line was approximated", "file was never opened"]);
	});

	it("leaves the strict path exactly as it was", () => {
		const strict = JSON.stringify({
			findings: [{ claim: "the boundary is declared here", path: "src/a.ts", line: 2 }],
			needsSplit: false,
			proposedSubtasks: [],
		});
		const observed = new Map([["/repo/src/a.ts", [[1, 3] as const]]]);
		const passed = validate(strict, observed);
		strictEqual(passed.conformance, "pass");
		strictEqual(passed.quality, "pass");
		strictEqual(passed.scout?.degradedReason, undefined);
		strictEqual(passed.scout?.ungroundedClaims, undefined);

		// A conforming result with a fabricated citation still fails outright.
		// Degradation must not become a way to launder an invented `path:line`
		// into a run that claims a grounded reconnaissance pass.
		const fabricated = validate(
			JSON.stringify({
				findings: [{ claim: "the boundary is declared here", path: "src/a.ts", line: 5 }],
				needsSplit: false,
				proposedSubtasks: [],
			}),
			observed,
		);
		strictEqual(fabricated.conformance, "fail");
		ok(fabricated.reason?.includes("not grounded in a live read"), fabricated.reason);
	});

	it("still fails a result with nothing to salvage", () => {
		for (const output of [
			"SPLIT RECOMMENDATION: prose about what I found",
			JSON.stringify({ findings: [], needsSplit: false, proposedSubtasks: [] }),
			JSON.stringify({ findings: [{ path: "src/a.ts", line: 1 }] }),
			JSON.stringify({ findings: [{ claim: "   " }] }),
			JSON.stringify({ findings: "I looked at src/a.ts" }),
			JSON.stringify({ notes: ["src/a.ts is the boundary"] }),
		]) {
			const result = validate(output);
			strictEqual(result.conformance, "fail", output);
			strictEqual(result.scout, undefined, output);
		}
	});

	it("never salvages a subtask, because a coordinator acts on one", () => {
		// A split recommendation is control-plane data. The findings survive; the
		// malformed subtasks are dropped and needsSplit is forced false, so no
		// half-parsed assignment can reach a dispatch.
		const result = validate(
			JSON.stringify({
				findings: [{ claim: "two independent roots", path: "src/a.ts", line: 1 }],
				needsSplit: true,
				proposedSubtasks: [{ id: "inspect", task: "Inspect the boundary", requestedAuthority: "workspace-edit" }],
			}),
		);
		strictEqual(result.conformance, "pass");
		strictEqual(result.quality, "unmeasured");
		strictEqual(result.scout?.needsSplit, false);
		deepStrictEqual(result.scout?.proposedSubtasks, []);
	});

	it("keeps degraded reconnaissance out of the from_scout continuation", () => {
		// parseScoutResult is what dispatch-scout.ts uses to admit a run as a
		// continuation source. Conformant is not the same as strict, and only
		// strict may turn into new dispatches.
		strictEqual(parseScoutResult(JSON.stringify({ findings: [{ claim: "a lead" }] })), null);
		const strict = parseScoutResult(
			JSON.stringify({
				findings: [{ claim: "the boundary is declared here", path: "src/a.ts", line: 2 }],
				needsSplit: false,
				proposedSubtasks: [],
			}),
		);
		strictEqual(strict?.findings.length, 1);
		strictEqual(strict?.degradedReason, undefined);
	});

	it("teaches the fallback in the repair directive it will actually accept", () => {
		// The run that died had been told the strict shape twice. A third
		// restatement of a shape it already missed is not feedback.
		const message = resultContractRepairMessage({
			contract: { kind: "scout-report" },
			reason: "Scout result has unknown fields",
			attempt: RESULT_CONTRACT_REPAIR_LIMIT,
			anchors: ["src/a.ts:2"],
		});
		ok(message.includes('{"findings":[{"claim":"what you observed"}]}'), message);
		ok(message.includes("ungrounded lead"), message);
		// The strict shape stays first: the fallback is a floor, not the target.
		ok(message.indexOf('"path":"src/file.ts"') < message.indexOf('{"findings":[{"claim":"what you observed"}]}'));
	});

	it("keeps the repair budget where it is", () => {
		// The fix is a wider door, not more attempts at the same one. Two rounds
		// at 51k tokens was already the expensive failure.
		strictEqual(RESULT_CONTRACT_REPAIR_LIMIT, 2);
	});
});
