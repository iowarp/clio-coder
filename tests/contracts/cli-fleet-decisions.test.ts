/**
 * `clio-coder fleet decisions --json`, the fixed read a GUI host may run.
 *
 * A gate seals an integrity-covered artifact linking the decider receipt to
 * every subject receipt, and its `detail` is free prose: several branches
 * interpolate a receipt's failure reason, the names of protected artifacts a
 * candidate touched, or an operator approval request id. These assert that the
 * detail is classified rather than quoted, that a tampered artifact is counted
 * rather than dropped, and that an installation with no gate store reads
 * differently from one whose gates aged out.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fleetDecisionsSnapshot } from "../../src/cli/fleet-decisions.js";
import { clioStateDir } from "../../src/core/xdg.js";
import {
	type GateDecisionArtifact,
	type GateDecisionDraft,
	materializePendingGateDecision,
	stagePendingGateDecision,
} from "../../src/domains/dispatch/gate-decisions.js";
import {
	GATE_TOPOLOGY_MAX_DECISIONS,
	GATE_TOPOLOGY_MAX_SUBJECTS,
	gateTopology,
} from "../../src/domains/dispatch/gate-topology.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/** Every decision crosses the staged durable boundary; there is no direct writer. */
function writeGateDecision(draft: GateDecisionDraft): { artifact: GateDecisionArtifact; path: string } {
	return materializePendingGateDecision(stagePendingGateDecision(draft));
}

const DIGEST = "a".repeat(64);
const AT = "2026-08-31T12:00:00.000Z";

function subject(runId: string): { runId: string; digest: string } {
	return { runId, digest: DIGEST };
}

const CORRELATION = {
	agent: false,
	target: true,
	modelFamily: true,
	runtime: true,
	node: true,
	independent: false,
} as const;

describe("fleet decisions projection", () => {
	it("projects a review verdict with its correlation and classified reason", async () => {
		const scratch = await isolateClioEnv();
		try {
			writeGateDecision({
				group: "review-mt20xowx-a270cb",
				topology: "review",
				cycle: 2,
				outcome: "exhausted",
				subjects: [subject("builder-run-01")],
				decider: subject("reviewer-run-01"),
				correlation: { ...CORRELATION },
				detail: "reviewer did not return a valid verifier report",
				createdAt: "2026-08-31T11:00:00.000Z",
			});

			const snapshot = fleetDecisionsSnapshot(() => Date.parse(AT));
			strictEqual(snapshot.available, true);
			strictEqual(snapshot.unverifiable, 0);
			strictEqual(snapshot.decisions.length, 1);
			const decision = snapshot.decisions[0];
			ok(decision !== undefined);
			strictEqual(decision.topology, "review");
			strictEqual(decision.outcome, "exhausted");
			strictEqual(decision.cycle, 2);
			deepStrictEqual(decision.subjects, ["builder-run-01"]);
			strictEqual(decision.decider, "reviewer-run-01");
			// The independence facts are the whole point of sealing a correlation:
			// a verdict from the decider's own model family is not a second opinion.
			strictEqual(decision.correlation?.independent, false);
			strictEqual(decision.correlation?.modelFamily, true);
			strictEqual(decision.reason, "reviewer-report-invalid");
			strictEqual(decision.winner, null);
			// The sealed prose never crosses, and neither do the receipt digests.
			const serialized = JSON.stringify(snapshot);
			strictEqual(serialized.includes("did not return a valid"), false);
			strictEqual(serialized.includes(DIGEST), false);
		} finally {
			scratch.restore();
		}
	});

	it("classifies every detail a gate branch writes, and refuses to quote any of them", async () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			["every candidate builder failed; nothing to judge", "all-candidates-failed"],
			["builder ended outcome=canceled", "builder-run-failed"],
			["reviewer ended outcome=timed_out", "reviewer-run-failed"],
			["reviewer reported 2 failed check(s)", "reviewer-checks-failed"],
			["reviewer did not return a valid verifier report", "reviewer-report-invalid"],
			["judge ended outcome=failed", "judge-run-failed"],
			["judge result must carry typed checks with evidence", "judge-result-invalid"],
			["judge result has unknown fields", "judge-result-invalid"],
			["judge winner must be an integer 1..4", "judge-winner-out-of-range"],
			["judge picked failed or missing candidate 2", "judge-picked-failed-candidate"],
			[
				"judge-selected candidate 2 changes protected artifact(s): .clio-coder/settings.yaml",
				"winner-touches-protected-artifact",
			],
			[
				"operator confirmation req-7 (akougkas) approved clio/compete/g/2 under dispatch plan abc",
				"operator-confirmed-winner",
			],
			["full-auto applied clio/compete/g/2 under dispatch plan abc", "full-auto-applied-winner"],
			["a shape no branch writes", "unclassified"],
		];
		// The reported window is bounded well below the case count, so the cases
		// run in chunks that fit inside it. Every one is asserted, not sampled.
		for (let offset = 0; offset < cases.length; offset += GATE_TOPOLOGY_MAX_DECISIONS) {
			const chunk = cases.slice(offset, offset + GATE_TOPOLOGY_MAX_DECISIONS);
			const scratch = await isolateClioEnv();
			try {
				for (const [index, [detail]] of chunk.entries()) {
					writeGateDecision({
						group: `review-case-${offset + index}`,
						topology: "review",
						cycle: 1,
						outcome: "exhausted",
						subjects: [subject(`builder-${offset + index}`)],
						detail,
						createdAt: new Date(Date.parse("2026-08-31T10:00:00.000Z") + index * 1_000).toISOString(),
					});
				}
				const { decisions } = gateTopology();
				strictEqual(decisions.length, chunk.length);
				const byGroup = new Map(decisions.map((decision) => [decision.group, decision.reason]));
				for (const [index, [detail, expected]] of chunk.entries()) {
					strictEqual(byGroup.get(`review-case-${offset + index}`), expected, `'${detail}' -> ${expected}`);
				}
				// The protected artifact name and the approval request id are exactly
				// why the detail is classified rather than quoted.
				const serialized = JSON.stringify(decisions);
				strictEqual(serialized.includes(".clio-coder/settings.yaml"), false);
				strictEqual(serialized.includes("akougkas"), false);
			} finally {
				scratch.restore();
			}
		}
	});

	it("projects a compete winner without repeating the branch the store derives", async () => {
		const scratch = await isolateClioEnv();
		try {
			writeGateDecision({
				group: "compete-mt20xowx-a270cb",
				topology: "compete",
				cycle: 1,
				outcome: "winner",
				subjects: [subject("candidate-1"), subject("candidate-2")],
				decider: subject("judge-run-01"),
				correlation: { ...CORRELATION, agent: false, modelFamily: false, independent: true },
				winner: {
					index: 2,
					subject: subject("candidate-2"),
					branch: "clio/compete/compete-mt20xowx-a270cb/2",
				},
				createdAt: "2026-08-31T11:30:00.000Z",
			});

			const decision = fleetDecisionsSnapshot(() => Date.parse(AT)).decisions[0];
			ok(decision !== undefined);
			strictEqual(decision.topology, "compete");
			strictEqual(decision.outcome, "winner");
			deepStrictEqual(decision.winner, { index: 2, runId: "candidate-2" });
			strictEqual(decision.correlation?.independent, true);
			deepStrictEqual(decision.subjects, ["candidate-1", "candidate-2"]);
			strictEqual(decision.reason, null);
			// The store already requires the branch to equal a formula over the group
			// and the ordinal, so repeating it would carry nothing the frame lacks.
			strictEqual(JSON.stringify(decision).includes("clio/compete/"), false);
		} finally {
			scratch.restore();
		}
	});

	it("counts an artifact whose integrity no longer holds rather than dropping it", async () => {
		const scratch = await isolateClioEnv();
		try {
			writeGateDecision({
				group: "review-tampered",
				topology: "review",
				cycle: 1,
				outcome: "pass",
				subjects: [subject("builder-run-01")],
				createdAt: "2026-08-31T11:00:00.000Z",
			});
			const directory = join(clioStateDir(), "gate-decisions");
			const name = readdirSync(directory).find((entry) => entry.endsWith(".json"));
			ok(name !== undefined);
			const path = join(directory, name);
			const artifact = JSON.parse(readFileSync(path, "utf8")) as { outcome: string };
			artifact.outcome = "fail";
			writeFileSync(path, JSON.stringify(artifact, null, 2));

			const snapshot = fleetDecisionsSnapshot(() => Date.parse(AT));
			// The store's own read API drops this silently. An operator surface must
			// not: a sealed verdict that no longer authenticates is the fact.
			strictEqual(snapshot.decisions.length, 0);
			strictEqual(snapshot.unverifiable, 1);
			strictEqual(snapshot.available, true);
		} finally {
			scratch.restore();
		}
	});

	it("separates an installation with no gate store from one whose gates aged out", async () => {
		const scratch = await isolateClioEnv();
		try {
			const empty = fleetDecisionsSnapshot(() => Date.parse(AT));
			strictEqual(empty.available, false);
			strictEqual(empty.decisions.length, 0);
			strictEqual(empty.truncated, false);

			for (let index = 0; index < GATE_TOPOLOGY_MAX_DECISIONS + 3; index += 1) {
				writeGateDecision({
					group: `review-window-${index}`,
					topology: "review",
					cycle: 1,
					outcome: "pass",
					subjects: [subject(`builder-${index}`)],
					createdAt: new Date(Date.parse("2026-08-31T09:00:00.000Z") + index * 60_000).toISOString(),
				});
			}
			const full = fleetDecisionsSnapshot(() => Date.parse(AT));
			strictEqual(full.available, true);
			strictEqual(full.decisions.length, GATE_TOPOLOGY_MAX_DECISIONS);
			strictEqual(full.truncated, true);
			// Newest first, so the last written decision heads the window.
			strictEqual(full.decisions[0]?.group, `review-window-${GATE_TOPOLOGY_MAX_DECISIONS + 2}`);
		} finally {
			scratch.restore();
		}
	});

	it("bounds the subjects one decision names", async () => {
		const scratch = await isolateClioEnv();
		try {
			const subjects = Array.from({ length: GATE_TOPOLOGY_MAX_SUBJECTS + 2 }, (_, index) => subject(`candidate-${index}`));
			writeGateDecision({
				group: "compete-wide",
				topology: "compete",
				cycle: 1,
				outcome: "no-winner",
				subjects,
				createdAt: "2026-08-31T11:00:00.000Z",
			});
			const decision = fleetDecisionsSnapshot(() => Date.parse(AT)).decisions[0];
			ok(decision !== undefined);
			strictEqual(decision.subjects.length, GATE_TOPOLOGY_MAX_SUBJECTS);
			strictEqual(decision.subjectsTruncated, true);
		} finally {
			scratch.restore();
		}
	});
});
