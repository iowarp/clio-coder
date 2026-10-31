import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { materializePendingGateDecision, stagePendingGateDecision } from "../../src/domains/dispatch/gate-decisions.js";
import type { RunResultDraft } from "../../src/domains/dispatch/types.js";
import { evidenceDetailSnapshot } from "../../src/domains/evidence/detail.js";
import { inspectRunEvidence, TRUST_STATUS_AXES } from "../../src/domains/evidence/index.js";
import { EVIDENCE_INVENTORY_MAX_ARTIFACTS } from "../../src/domains/evidence/inventory.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { telemetryJournalPath, telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";
import { EVIDENCE_TOOL_MAX_BYTES, evidenceTool } from "../../src/tools/evidence.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { writeSettledRun } from "../harness/settled-run.js";

type EvidenceOutput = Awaited<ReturnType<typeof inspectRunEvidence>> & {
	artifacts: { runId: string; totals: unknown }[];
	runs: { runId: string }[];
	truncated: boolean;
	nextCursor: string | null;
	gateDecisions: unknown[];
	taskBoard: {
		total: number;
		completed: number;
		active: number;
		pending: number;
		blocked: number;
		cancelled: number;
		open: number;
	} | null;
	worktree?: {
		branch?: string;
		changedPaths?: string[];
		apply?: "merge" | "preserve";
		applied?: boolean;
		snapshot?: "working-tree" | "unavailable";
		reason?: string;
		status?: "withheld";
	};
};

/** The fixture run's own session: evidence reads are scoped to the session and project asking. */
const FIXTURE_SESSION = "session-1";

function evidence(args: Record<string, unknown>, sessionId: string = FIXTURE_SESSION): Promise<ToolResult> {
	return evidenceTool.run(args, { sessionId });
}

function output(result: ToolResult): EvidenceOutput {
	strictEqual(result.kind, "ok");
	return JSON.parse(result.output);
}

/** Settle a run afresh: a sealed run scope built from the draft, replacing any the run had. */
async function settle(draft: RunResultDraft): Promise<void> {
	await rm(telemetryRunDirectory(clioStateDir(), draft.runId), { recursive: true, force: true });
	await writeSettledRun(clioStateDir(), draft);
}

/** Change one byte of a run's settled record so its seal no longer verifies. */
async function tamper(runId: string): Promise<void> {
	const path = telemetryJournalPath(telemetryRunDirectory(clioStateDir(), runId));
	const text = await readFile(path, "utf8");
	ok(text.includes('"agentId":"coder"'));
	await writeFile(path, text.replace('"agentId":"coder"', '"agentId":"codex"'));
}

async function fixture(tampered = false, task?: string, extra: Partial<RunResultDraft> = {}) {
	const envelope = { ...fixtureEnvelope("fixture"), ...(task === undefined ? {} : { task }) };
	await writeFile(join(clioStateDir(), "runs.json"), JSON.stringify([envelope]));
	await settle({
		...fixtureReceiptDraft(envelope),
		validationGrounding: { claimed: 12, grounded: 1, ungrounded: ["typecheck"], basis: "no-command-executed" },
		...extra,
	});
	if (tampered) await tamper(envelope.id);
	return envelope;
}

/** Settle `count` runs of the fixture session, a second apart, and one run of another project's session. */
async function manyRuns(count: number): Promise<string[]> {
	const envelopes = Array.from({ length: count }, (_, index) => ({
		...fixtureEnvelope(`copy-${String(index).padStart(2, "0")}`),
		endedAt: new Date(2000000000000 + index * 1000).toISOString(),
	}));
	const foreign = {
		...fixtureEnvelope("foreign"),
		sessionId: "other-session",
		cwd: join(clioStateDir(), "other-project"),
	};
	await writeFile(join(clioStateDir(), "runs.json"), JSON.stringify([...envelopes, foreign]));
	for (const envelope of [...envelopes, foreign]) await settle(fixtureReceiptDraft(envelope));
	return envelopes.map((envelope) => envelope.id);
}

describe("evidence tool", () => {
	let env: Awaited<ReturnType<typeof isolateClioEnv>>;
	beforeEach(async () => {
		env = await isolateClioEnv("evidence-tool-");
	});
	afterEach(() => env.restore());

	it("lists an empty inventory, then pages visible runs newest first without revealing foreign ones", async () => {
		deepStrictEqual(output(await evidence({ mode: "list" })).artifacts, []);
		const ids = await manyRuns(EVIDENCE_INVENTORY_MAX_ARTIFACTS + 2);
		const first = output(await evidence({ mode: "list", cursor: undefined }));
		strictEqual(first.artifacts.length, EVIDENCE_INVENTORY_MAX_ARTIFACTS);
		strictEqual(first.truncated, true);
		strictEqual(first.artifacts[0]?.runId, ids.at(-1));
		strictEqual(first.nextCursor, first.artifacts.at(-1)?.runId);
		const second = output(await evidence({ mode: "list", cursor: first.nextCursor }));
		strictEqual(second.artifacts.length, 2);
		strictEqual(second.truncated, false);
		strictEqual(second.nextCursor, null);
		const listed = [...first.artifacts, ...second.artifacts].map((item) => item.runId);
		strictEqual(new Set(listed).size, ids.length);
		ok(listed.every((id) => id !== "foreign"));
		strictEqual((await evidence({ mode: "list", cursor: "foreign" })).kind, "error");
	});

	it("inspects the fixture as its sealed evidence and the CLI trust projection", async () => {
		await fixture();
		const inspected = output(await evidence({ mode: "inspect", runId: "fixture" }));
		const run = await inspectRunEvidence(clioStateDir(), "fixture");
		deepStrictEqual(inspected, JSON.parse(JSON.stringify(run)));
		strictEqual(inspected.ungroundedClaims, 11);
		ok(inspected.assessedAt !== null);
		deepStrictEqual(inspected.verdicts, []);
		const detail = await evidenceDetailSnapshot("fixture");
		strictEqual(detail.assessed, true);
		strictEqual(detail.integrity, "verified");
		deepStrictEqual(Object.keys(detail.axes), [...TRUST_STATUS_AXES]);
		ok(inspected.findings.some((finding) => finding.tag === "proxy-validation"));
	});

	it("reports agent-managed delegation from a verified run", async () => {
		await fixture(false, undefined, {
			delegation: { toolGovernance: "agent-managed" } as NonNullable<RunResultDraft["delegation"]>,
		});
		ok(output(await evidence({ mode: "inspect", runId: "fixture" })).findings.some((f) => f.tag === "external-bypass"));
	});

	it("never takes a review verdict from gate artifact files", async () => {
		const pending = stagePendingGateDecision(
			{
				group: "evidence-tool",
				topology: "review",
				cycle: 1,
				outcome: "pass",
				subjects: [{ runId: "fixture", digest: "a".repeat(64) }],
				createdAt: "2026-09-05T00:00:00.000Z",
			},
			{
				stateDir: clioStateDir(),
				telemetry: { sessionId: null, runId: "fixture", agent: { role: "coordinator", id: "fixture" } },
			},
		);
		const valid = await materializePendingGateDecision(pending);
		// A copy whose outcome was edited no longer verifies and is not read.
		const forged = join(dirname(valid.path), "forged.json");
		await copyFile(valid.path, forged);
		const text = await readFile(forged, "utf8");
		ok(/"outcome":\s*"pass"/u.test(text));
		await writeFile(forged, text.replace(/"outcome":(\s*)"pass"/u, '"outcome":$1"fail"'));
		await fixture();
		// Settling afresh removed the journal that held gate.decided; the artifacts left behind are dispatch state, so
		// neither the authentic one nor the forged copy yields a verdict (#434).
		const read = output(await evidence({ mode: "inspect", runId: "fixture" }));
		strictEqual(read.verdicts.length, 0);
		strictEqual(read.trust.independentReview.state, "absent");
	});

	it("reads without writing and classifies as a read", async () => {
		await fixture();
		const before = await readFile(telemetryJournalPath(telemetryRunDirectory(clioStateDir(), "fixture")), "utf8");
		const first = output(await evidence({ mode: "inspect", runId: "fixture" }));
		deepStrictEqual(output(await evidence({ mode: "inspect", runId: "fixture" })).findings, first.findings);
		strictEqual(await readFile(telemetryJournalPath(telemetryRunDirectory(clioStateDir(), "fixture")), "utf8"), before);
		strictEqual(classify({ tool: "evidence", args: { mode: "inspect", runId: "fixture" } }).actionClass, "read");
	});

	it("exposes worktree fields only while the run seal still verifies", async () => {
		const worktree = {
			path: "/workspace/.clio-coder/worktrees/worktree-fixture",
			branch: "clio-coder/task/worktree-fixture",
			diffHash: "a".repeat(40),
			changedPaths: ["release-worktree-probe.txt"],
			apply: "preserve" as const,
			applied: false,
			snapshot: "working-tree" as const,
		};
		const envelope = { ...fixtureEnvelope("worktree-fixture"), cwd: worktree.path };
		await writeFile(join(clioStateDir(), "runs.json"), JSON.stringify([envelope]));
		await settle({ ...fixtureReceiptDraft(envelope), worktree });
		const inspect = { mode: "inspect", runId: envelope.id };
		deepStrictEqual(output(await evidence(inspect)).worktree, {
			branch: worktree.branch,
			changedPaths: worktree.changedPaths,
			changedPathsOmitted: 0,
			apply: "preserve",
			applied: false,
			snapshot: "working-tree",
		});
		const failedApply = {
			path: worktree.path,
			branch: worktree.branch,
			diffHash: worktree.diffHash,
			changedPaths: worktree.changedPaths,
			apply: "merge" as const,
			applied: false,
			reason: "worktree_merge_conflict",
		};
		await settle({ ...fixtureReceiptDraft(envelope), worktree: failedApply });
		strictEqual(output(await evidence(inspect)).worktree?.reason, "worktree_merge_conflict");
		const { reason: _reason, ...merged } = failedApply;
		await settle({ ...fixtureReceiptDraft(envelope), worktree: { ...merged, applied: true } });
		strictEqual(output(await evidence(inspect)).worktree?.applied, true);
		await tamper(envelope.id);
		deepStrictEqual(output(await evidence(inspect)).worktree, { status: "withheld", reason: "run-seal" });
	});

	it("does not infer worktree placement from a failed seal on a regular run", async () => {
		await fixture(true);
		strictEqual(output(await evidence({ mode: "inspect", runId: "fixture" })).worktree, undefined);
	});

	it("returns a bounded summary only to the owning session", async () => {
		const secret = `ghp_${"A".repeat(24)}`;
		await fixture(false, `Check token ${secret}`);
		const sessionDir = join(clioStateDir(), "sessions", "fixture-cwd", FIXTURE_SESSION);
		await mkdir(sessionDir, { recursive: true });
		await writeFile(
			join(sessionDir, "current.jsonl"),
			`${[
				{
					type: "session",
					version: 5,
					id: FIXTURE_SESSION,
					timestamp: "2026-09-05T00:00:00.000Z",
					cwd: "/workspace",
				},
				{
					kind: "taskLedger",
					turnId: "task-1",
					parentTurnId: null,
					timestamp: "2026-09-05T00:00:01.000Z",
					goals: [{ id: "board", title: "Private board", status: "active" }],
					subgoals: [
						{ id: "t1", title: `Secret task ${secret}`, status: "completed" },
						{ id: "t2", title: "Next task", status: "pending" },
					],
					activeRunIds: [],
					requiredValidationEvidence: [
						{
							id: "t1.evidence",
							description: `Completion note ${secret}`,
							status: "passed",
							observedAt: "2026-09-05T00:00:02.000Z",
						},
					],
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		const request = { mode: "session", sessionId: FIXTURE_SESSION };
		const foreign = await evidence(request, "session-2");
		strictEqual(foreign.kind, "error");
		deepStrictEqual(foreign.details, { code: "evidence_foreign", artifactAbsent: false });

		const absent = await evidence({ mode: "session", sessionId: "missing-session" }, "missing-session");
		strictEqual(absent.kind, "error");
		deepStrictEqual(absent.details, { code: "artifact_absent", artifactAbsent: true });

		const own = await evidence(request);
		strictEqual(own.kind, "ok");
		if (own.kind !== "ok") return;
		const summary = JSON.parse(own.output);
		strictEqual(summary.version, 1);
		strictEqual(summary.sessionId, FIXTURE_SESSION);
		deepStrictEqual(
			summary.runs.map((run: { runId: string }) => run.runId),
			["fixture"],
		);
		deepStrictEqual(summary.taskBoard, {
			total: 2,
			completed: 1,
			active: 0,
			pending: 1,
			blocked: 0,
			cancelled: 0,
			open: 1,
		});
		ok(!own.output.includes(secret));
		ok(!("task" in summary.runs[0]));
		ok(!("cwd" in summary.runs[0]));
		ok(Buffer.byteLength(own.output, "utf8") <= EVIDENCE_TOOL_MAX_BYTES);
	});

	it("reports an unsettled run as absent and an invalid id as an error", async () => {
		const unsettled = fixtureEnvelope("unsettled");
		await writeFile(join(clioStateDir(), "runs.json"), JSON.stringify([unsettled]));
		const absent = await evidence({ mode: "inspect", runId: "unsettled" });
		strictEqual(absent.kind, "error");
		deepStrictEqual(absent.details, { code: "artifact_absent", artifactAbsent: true });
		const missing = await evidence({ mode: "inspect", runId: "missing" });
		strictEqual(missing.kind, "error");
		const invalid = await evidence({ mode: "inspect", runId: "../escape" });
		strictEqual(invalid.kind, "error");
		strictEqual(invalid.details?.artifactAbsent, false);
	});

	it("bounds UTF-8 output while keeping the truncation envelope valid JSON", async () => {
		// Unresolved decision refs carry their ref into finding prose, which makes the run's evidence large.
		const refs = Array.from({ length: 40 }, (_, index) => `${index}${'大"\n'.repeat(130)}`);
		const envelope = { ...fixtureEnvelope("fixture"), decisionRefs: refs };
		await writeFile(join(clioStateDir(), "runs.json"), JSON.stringify([envelope]));
		await settle({ ...fixtureReceiptDraft(envelope), decisionRefs: refs });
		const result = await evidence({ mode: "inspect", runId: "fixture" });
		strictEqual(output(result).truncated, true);
		if (result.kind !== "ok") return;
		ok(Buffer.byteLength(result.output, "utf8") <= EVIDENCE_TOOL_MAX_BYTES);
		deepStrictEqual(result.details, { truncated: true });
		ok(!result.output.includes("\uFFFD"));
	});

	it("withholds a tampered run's facts and ungrounded counts", async () => {
		await fixture(true);
		const inspected = output(await evidence({ mode: "inspect", runId: "fixture" }));
		strictEqual(inspected.ungroundedClaims, 0);
		strictEqual(inspected.totals, null);
		strictEqual(inspected.assessedAt, null);
		strictEqual((await evidenceDetailSnapshot("fixture")).verdict, "compromised");
		ok(inspected.findings.some((finding) => finding.tag === "run-seal"));
	});

	it("keeps another session's run from another project out of list and inspect", async () => {
		await fixture();
		// The fixture ran in /workspace under session-1; this caller is neither.
		deepStrictEqual(output(await evidence({ mode: "list" }, "session-2")).artifacts, []);
		const refused = await evidence({ mode: "inspect", runId: "fixture" }, "session-2");
		strictEqual(refused.kind, "error");
		deepStrictEqual(refused.details, { code: "evidence_foreign", artifactAbsent: false });
	});
});
