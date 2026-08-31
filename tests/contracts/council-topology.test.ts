/**
 * Council topology reconstructed from the ordinary run ledger.
 *
 * A council writes no record of its own. Every one of its runs is a dispatch
 * ledger row, and the only thing marking it as a council is the provenance the
 * scheduler stamps on each row. These assert that the grouping over those rows
 * recovers the shape an operator needs (who was seated, where each voice ran,
 * how many rounds it took, whether a synthesis was reached) and that it recovers
 * none of what was said.
 *
 * The fixtures are typed `RunEnvelope` values, so a harness change to the
 * envelope shape fails these at compile time rather than letting a projection
 * drift away from the ledger it reads.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { FLEET_INSPECT_MAX_COUNCILS, fleetInspectSnapshot } from "../../src/cli/fleet-inspect.js";
import {
	COUNCIL_TOPOLOGY_MAX_COUNCILS,
	COUNCIL_TOPOLOGY_MAX_MEMBERS,
	councilTopologies,
} from "../../src/domains/dispatch/council-topology.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunEnvelope } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

interface RowInput {
	id: string;
	group: string;
	label: string;
	round: number;
	agentId?: string;
	targetId?: string;
	startedAt: string;
	endedAt?: string | null;
	status?: RunEnvelope["status"];
	outcome?: RunEnvelope["outcome"];
	origin?: RunEnvelope["requestOrigin"];
	approval?: "operator" | "full-auto";
	task?: string;
}

/** One council run as the scheduler files it. */
function councilRow(input: RowInput): RunEnvelope {
	const endedAt = input.endedAt === undefined ? `${input.startedAt.slice(0, -5)}9.000Z` : input.endedAt;
	return {
		id: input.id,
		agentId: input.agentId ?? "researcher",
		executionRole: input.label === "synthesis" ? "judge" : "researcher",
		requestOrigin: input.origin ?? "user",
		task: input.task ?? "Should the ledger own the topology?",
		targetId: input.targetId ?? "blade-gateway",
		wireModelId: "qwen3-coder",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt: input.startedAt,
		endedAt,
		status: input.status ?? "completed",
		outcome: input.outcome ?? "succeeded",
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: null,
		cwd: "/tmp/council",
		tokenCount: 0,
		costUsd: 0,
		gate: {
			role: input.label === "synthesis" ? "synthesis" : "member",
			group: input.group,
			cycle: input.round,
		},
		council: { group: input.group, label: input.label, round: input.round },
		...(input.approval === undefined
			? {}
			: {
					plan: {
						hash: "plan-hash",
						topology: "council" as const,
						taskCount: 1,
						approval: input.approval,
						source: null,
					},
				}),
	};
}

/** The zero-cost record the ledger seals a council's own report under. */
function sealedReport(group: string, kind: "none" | "vote" | "judge", round: number, startedAt: string): RunEnvelope {
	return councilRow({
		id: `${group}-sealed`,
		group,
		label: "synthesis",
		round,
		agentId: "council-synthesis",
		startedAt,
		task: `Council ${kind} synthesis`,
	});
}

/** An ordinary dispatch that is not part of any council. */
function plainRow(id: string, startedAt: string): RunEnvelope {
	const row = councilRow({ id, group: "unused", label: "solo", round: 1, startedAt });
	const { council, gate, ...rest } = row;
	return rest;
}

/** Newest start first, which is the order the ledger lists rows in. */
function newestFirst(rows: RunEnvelope[]): RunEnvelope[] {
	return [...rows].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

describe("council topology projection", () => {
	it("recovers a two-round judge council from its ledger rows", () => {
		const rows = newestFirst([
			councilRow({ id: "m-sk-1", group: "council-a", label: "skeptic", round: 1, startedAt: "2026-08-31T10:00:01.000Z" }),
			councilRow({
				id: "m-ar-1",
				group: "council-a",
				label: "architect",
				round: 1,
				startedAt: "2026-08-31T10:00:02.000Z",
			}),
			councilRow({ id: "m-sk-2", group: "council-a", label: "skeptic", round: 2, startedAt: "2026-08-31T10:00:03.000Z" }),
			councilRow({
				id: "m-ar-2",
				group: "council-a",
				label: "architect",
				round: 2,
				startedAt: "2026-08-31T10:00:04.000Z",
			}),
			councilRow({
				id: "judge-a",
				group: "council-a",
				label: "synthesis",
				round: 2,
				agentId: "verifier",
				startedAt: "2026-08-31T10:00:05.000Z",
			}),
			sealedReport("council-a", "judge", 2, "2026-08-31T10:00:06.000Z"),
		]);

		const { councils, truncated } = councilTopologies(rows);
		strictEqual(truncated, false);
		strictEqual(councils.length, 1);
		const council = councils[0];
		ok(council !== undefined);
		strictEqual(council.group, "council-a");
		strictEqual(council.startedAt, "2026-08-31T10:00:01.000Z");
		strictEqual(council.running, false);
		strictEqual(council.roundsPlanned, 2);
		strictEqual(council.roundsObserved, 2);
		strictEqual(council.origin, "user");
		strictEqual(council.membersRejected, 0);
		strictEqual(council.membersTruncated, false);
		deepStrictEqual(
			council.members.map((member) => member.label),
			["architect", "skeptic"],
		);
		// A member's turns read oldest round first, because that is the order the
		// council actually spoke in.
		deepStrictEqual(
			council.members[1]?.turns.map((turn) => [turn.round, turn.runId]),
			[
				[1, "m-sk-1"],
				[2, "m-sk-2"],
			],
		);
		strictEqual(council.members[0]?.executionRole, "researcher");
		strictEqual(council.synthesis.kind, "judge");
		strictEqual(council.synthesis.sealedRunId, "council-a-sealed");
		strictEqual(council.synthesis.judge?.runId, "judge-a");
		strictEqual(council.synthesis.judge?.agentId, "verifier");
	});

	it("keeps the sealed report and the judge dispatch apart", () => {
		// Both rows carry the same council label and the same gate role. Only the
		// agent id separates the council's own zero-cost record from the run that
		// actually consumed a model, and conflating them doubles the judge.
		const rows = newestFirst([
			councilRow({ id: "m-1", group: "council-b", label: "one", round: 1, startedAt: "2026-08-31T11:00:01.000Z" }),
			councilRow({ id: "m-2", group: "council-b", label: "two", round: 1, startedAt: "2026-08-31T11:00:02.000Z" }),
			councilRow({
				id: "judge-b",
				group: "council-b",
				label: "synthesis",
				round: 1,
				agentId: "verifier",
				startedAt: "2026-08-31T11:00:03.000Z",
			}),
			sealedReport("council-b", "judge", 1, "2026-08-31T11:00:04.000Z"),
		]);

		const council = councilTopologies(rows).councils[0];
		ok(council !== undefined);
		deepStrictEqual(
			council.members.map((member) => member.label),
			["one", "two"],
		);
		strictEqual(council.synthesis.judge?.runId, "judge-b");
		strictEqual(council.synthesis.sealedRunId, "council-b-sealed");
	});

	it("reports a vote council with no judge dispatch", () => {
		const rows = newestFirst([
			councilRow({ id: "v-1", group: "council-c", label: "one", round: 1, startedAt: "2026-08-31T12:00:01.000Z" }),
			councilRow({ id: "v-2", group: "council-c", label: "two", round: 1, startedAt: "2026-08-31T12:00:02.000Z" }),
			sealedReport("council-c", "vote", 1, "2026-08-31T12:00:03.000Z"),
		]);

		const council = councilTopologies(rows).councils[0];
		ok(council !== undefined);
		strictEqual(council.synthesis.kind, "vote");
		strictEqual(council.synthesis.judge, null);
		strictEqual(council.roundsPlanned, 1);
	});

	it("reports no synthesis kind for a council that never sealed one", () => {
		const rows = newestFirst([
			councilRow({
				id: "a-1",
				group: "council-d",
				label: "one",
				round: 1,
				startedAt: "2026-08-31T13:00:01.000Z",
				endedAt: null,
				status: "running",
				outcome: null,
			}),
			councilRow({ id: "a-2", group: "council-d", label: "two", round: 1, startedAt: "2026-08-31T13:00:02.000Z" }),
		]);

		const council = councilTopologies(rows).councils[0];
		ok(council !== undefined);
		strictEqual(council.synthesis.kind, null);
		strictEqual(council.synthesis.sealedRunId, null);
		strictEqual(council.roundsPlanned, null);
		strictEqual(council.roundsObserved, 1);
		// One row still running makes the whole council unfinished; an end stamp
		// folded from the finished rows would claim it settled.
		strictEqual(council.running, true);
		strictEqual(council.endedAt, null);
	});

	it("refuses to repeat a member label outside the shape both entry paths enforce", () => {
		const rows = newestFirst([
			councilRow({ id: "s-1", group: "council-e", label: "good", round: 1, startedAt: "2026-08-31T14:00:01.000Z" }),
			councilRow({
				id: "s-2",
				group: "council-e",
				label: "/home/akougkas/.config/clio-coder/settings.yaml",
				round: 1,
				startedAt: "2026-08-31T14:00:02.000Z",
			}),
		]);

		const council = councilTopologies(rows).councils[0];
		ok(council !== undefined);
		deepStrictEqual(
			council.members.map((member) => member.label),
			["good"],
		);
		// Dropping it silently would leave the roster looking complete. The count
		// is what says a row was seen and not named.
		strictEqual(council.membersRejected, 1);
	});

	it("names at most the harness's own roster ceiling and says when it stopped", () => {
		const labels = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
		strictEqual(labels.length > COUNCIL_TOPOLOGY_MAX_MEMBERS, true);
		const rows = newestFirst(
			labels.map((label, index) =>
				councilRow({
					id: `w-${label}`,
					group: "council-f",
					label,
					round: 1,
					startedAt: `2026-08-31T15:00:0${index}.000Z`,
				}),
			),
		);

		const council = councilTopologies(rows).councils[0];
		ok(council !== undefined);
		strictEqual(council.members.length, COUNCIL_TOPOLOGY_MAX_MEMBERS);
		strictEqual(council.membersTruncated, true);
		strictEqual(council.membersRejected, 0);
	});

	it("orders councils newest first and bounds how many it reports", () => {
		const groups = ["g1", "g2", "g3", "g4", "g5"];
		strictEqual(groups.length > COUNCIL_TOPOLOGY_MAX_COUNCILS, true);
		const rows = newestFirst(
			groups.flatMap((group, index) => [
				councilRow({
					id: `${group}-a`,
					group,
					label: "one",
					round: 1,
					startedAt: `2026-08-31T1${index}:00:01.000Z`,
				}),
				councilRow({
					id: `${group}-b`,
					group,
					label: "two",
					round: 1,
					startedAt: `2026-08-31T1${index}:00:02.000Z`,
				}),
			]),
		);

		const { councils, truncated } = councilTopologies(rows);
		strictEqual(truncated, true);
		deepStrictEqual(
			councils.map((council) => council.group),
			["g5", "g4", "g3", "g2"],
		);
	});

	it("ignores ordinary dispatch rows and records the plan approval when one exists", () => {
		const rows = newestFirst([
			plainRow("plain-1", "2026-08-31T16:00:00.000Z"),
			plainRow("plain-2", "2026-08-31T16:00:05.000Z"),
			councilRow({
				id: "p-1",
				group: "council-g",
				label: "one",
				round: 1,
				startedAt: "2026-08-31T16:00:01.000Z",
				approval: "operator",
				origin: "agent",
			}),
			councilRow({
				id: "p-2",
				group: "council-g",
				label: "two",
				round: 1,
				startedAt: "2026-08-31T16:00:02.000Z",
				approval: "operator",
				origin: "agent",
			}),
		]);

		const { councils } = councilTopologies(rows);
		strictEqual(councils.length, 1);
		strictEqual(councils[0]?.approval, "operator");
		strictEqual(councils[0]?.origin, "agent");
	});
});

describe("fleet inspect council window", () => {
	it("selects councils from a window wider than the run window", async () => {
		const scratch = await isolateClioEnv();
		try {
			const ledger = openLedger({ maxRuns: 64 });
			// Every council row is older than the newest ordinary runs, so a council
			// selected from the eight-row run window would be invisible here.
			for (const label of ["one", "two"]) {
				const run = ledger.create({
					agentId: "researcher",
					executionRole: "researcher",
					requestOrigin: "user",
					task: "council task",
					targetId: "blade-gateway",
					wireModelId: "qwen3-coder",
					runtimeId: "openai",
					runtimeKind: "http",
					sessionId: null,
					cwd: "/tmp/council",
				});
				ledger.update(run.id, {
					status: "completed",
					outcome: "succeeded",
					endedAt: "2026-08-31T17:00:10.000Z",
					exitCode: 0,
					gate: { role: "member", group: "council-live", cycle: 1 },
					council: { group: "council-live", label, round: 1 },
				});
			}
			for (let index = 0; index < FLEET_INSPECT_MAX_COUNCILS + 8; index += 1) {
				const run = ledger.create({
					agentId: "coder",
					executionRole: "builder",
					task: `plain ${index}`,
					targetId: "blade-gateway",
					wireModelId: "qwen3-coder",
					runtimeId: "openai",
					runtimeKind: "http",
					sessionId: null,
					cwd: "/tmp/council",
				});
				ledger.update(run.id, { status: "completed", outcome: "succeeded", endedAt: null, exitCode: 0 });
			}
			await ledger.persist();

			const snapshot = fleetInspectSnapshot(() => Date.parse("2026-08-31T18:00:00.000Z"));
			strictEqual(snapshot.councils.length, 1);
			const council = snapshot.councils[0];
			ok(council !== undefined);
			strictEqual(council.group, "council-live");
			deepStrictEqual(
				council.members.map((member) => member.label),
				["one", "two"],
			);
			// The run window is eight rows and every one of them is a plain dispatch,
			// so the council reached the snapshot only through the wider scan.
			ok(snapshot.runs.every((run) => run.agentId === "coder"));
			// Nothing in a council row carries the task text the operator typed.
			const serialized = JSON.stringify(snapshot.councils);
			strictEqual(serialized.includes("council task"), false);
		} finally {
			scratch.restore();
		}
	});
});
