import { strict as assert, match } from "node:assert";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCommandVector } from "../../src/core/safe-exec.js";
import { claimLogRecordId } from "../../src/domains/claims/edges.js";
import { hypothesisSubject } from "../../src/domains/claims/hypotheses.js";
import {
	appendClaims,
	bindHostVerificationHypotheses,
	claimFromVerifyResult,
	claimStatuses,
	claimsLogPath,
	claimsProjectRoot,
	contradictionConditions,
	createClaimCaptureRegistration,
	createClaimsDeliveryRegistrations,
	createHypothesisCaptureRegistration,
	deriveClaimEdges,
	hypothesisStatuses,
	overturnedAgreements,
	readClaims,
	recordAcceptedWorkerSlates,
	recordHostVerificationClaims,
} from "../../src/domains/claims/index.js";
import { runHostVerification } from "../../src/domains/dispatch/host-verification.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const source = { channel: "verify", sessionId: "s1", toolCallId: "t1", requestedBy: "model" } as const;

function slateText(
	hypotheses: ReadonlyArray<{ id: string; check: string; statement?: string; status?: string }>,
): string {
	return JSON.stringify({
		schema: "clio-coder.hypothesis-slate.v1",
		question: { text: "q" },
		hypotheses: hypotheses.map((entry) => ({
			id: entry.id,
			status: entry.status ?? "proposed",
			statement: entry.statement ?? `${entry.id} holds`,
			prediction: "matches the reference",
			experiment: { successCriterion: { kind: "numeric-compare", verifyId: entry.check } },
		})),
	});
}

/** A main-thread verify call as the tool registry runs it: before_tool when the check starts, after_tool with its result. */
function verifyCall(registration: ReturnType<typeof createClaimCaptureRegistration>) {
	let calls = 0;
	const start = (check = "stats") => {
		const toolCallId = `c${++calls}`;
		const started = registration.evaluateAsync?.({
			hook: "before_tool",
			toolName: "verify",
			sessionId: "s1",
			toolCallId,
			toolArgs: { check },
		});
		return {
			started,
			finish: (details: Record<string, unknown>) =>
				registration.evaluateAsync?.({
					hook: "after_tool",
					toolName: "verify",
					sessionId: "s1",
					toolCallId,
					toolResultDetails: details,
				}),
		};
	};
	return {
		start,
		run: async (details: Record<string, unknown>) => {
			const call = start();
			await call.started;
			await call.finish(details);
		},
	};
}

function numericDetails(passed: boolean, validation: string, execution = "succeeded"): Record<string, unknown> {
	return {
		check: "stats",
		declaredCommand: ["python3", "stats.py"],
		judgement: { execution, validation },
		report: {
			kind: "numeric-compare",
			passed,
			tolerance: { relative: 1e-9 },
			combine: "all",
			nonFinite: "fail",
			rule: "relative<=1e-9 must hold",
			keys: [{ key: "std", passed, failed: passed ? [] : ["relative"], held: [], violated: [], detail: "" }],
			failedKeys: passed ? [] : ["std"],
			summary: "",
			reference: { source: "ref", path: "ref/stats.json", sha256: "a".repeat(64), bytes: 10 },
			actual: { sha256: "b".repeat(64), bytes: 10 },
		},
	};
}

describe("claims ledger (#406)", () => {
	it("records a failed judgement as disagreement and a check that never judged as nothing", () => {
		const at = "2026-11-06T00:00:00.000Z";
		const failed = claimFromVerifyResult({ details: numericDetails(false, "failed"), project: "/p", at, source });
		assert.equal(failed?.verdict, "disagrees");
		assert.equal(
			claimFromVerifyResult({ details: numericDetails(false, "not-run", "failed"), project: "/p", at, source }),
			null,
		);
		// A judgement word that contradicts the report is not trusted into a claim.
		assert.equal(claimFromVerifyResult({ details: numericDetails(false, "passed"), project: "/p", at, source }), null);
	});

	it("derives contradicts under equal pinned conditions and supersedes under a new commit", () => {
		const claim = (passed: boolean, commit: string, clean: boolean, at: string) => {
			const details = {
				...numericDetails(passed, passed ? "passed" : "failed"),
				checkout: { commit, trackedTreeClean: clean },
			};
			const built = claimFromVerifyResult({ details, project: "/p", at, source });
			assert.ok(built);
			return built;
		};
		const agreed = claim(true, "c".repeat(40), true, "2026-11-06T00:00:01.000Z");
		// An uncommitted edit at the same HEAD changes what ran, not the pinned conditions.
		const disagreed = claim(false, "c".repeat(40), false, "2026-11-06T00:00:02.000Z");
		const afterCommit = claim(true, "d".repeat(40), true, "2026-11-06T00:00:03.000Z");
		const first = deriveClaimEdges({ claims: [agreed], edges: [] }, [disagreed]);
		assert.deepEqual(
			first.map((edge) => [edge.kind, edge.from, edge.to]),
			[["contradicts", disagreed.id, agreed.id]],
		);
		// The edge names the tree difference rather than calling the conditions the same.
		match(
			contradictionConditions(disagreed, agreed),
			/with uncommitted changes to tracked files where claim \w+ ran on a clean tree$/u,
		);
		const [contradiction] = first;
		assert.ok(contradiction);
		assert.deepEqual(
			overturnedAgreements(contradiction, [agreed, disagreed], first).map((item) => item.id),
			[agreed.id],
		);
		assert.deepEqual(claimStatuses([agreed, disagreed], first).get(agreed.id), "contested");
		const second = deriveClaimEdges({ claims: [agreed, disagreed], edges: first }, [afterCommit]);
		assert.deepEqual(
			second.map((edge) => [edge.kind, edge.to]),
			[
				["supersedes", agreed.id],
				["supersedes", disagreed.id],
			],
		);
		const statuses = claimStatuses([agreed, disagreed, afterCommit], [...first, ...second]);
		assert.deepEqual(
			[agreed, disagreed, afterCommit].map((item) => statuses.get(item.id)),
			["superseded", "superseded", "standing"],
		);
	});

	it("keys the log by the repository root and drops a line edited after capture", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			mkdirSync(join(repo, "notebooks"), { recursive: true });
			const project = claimsProjectRoot(join(repo, "notebooks"));
			assert.equal(project, realpathSync(repo));
			const claim = claimFromVerifyResult({
				details: numericDetails(true, "passed"),
				project,
				at: "2026-11-06T00:00:00.000Z",
				source,
			});
			assert.ok(claim);
			await appendClaims([claim]);
			appendFileSync(claimsLogPath(project), `${JSON.stringify({ ...claim, verdict: "disagrees" })}\n`);
			const read = readClaims(claimsProjectRoot(repo));
			assert.deepEqual(
				read.records.map((record) => [record.id, record.verdict]),
				[[claim.id, "agrees"]],
			);
			assert.equal(read.mismatched, 1);
		} finally {
			env.restore();
		}
	});

	it("offers a contested check once per session, and nothing to a task that does not touch it", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			const claim = (passed: boolean, clean: boolean, at: string) => {
				const details = {
					...numericDetails(passed, passed ? "passed" : "failed"),
					checkout: { commit: "c".repeat(40), trackedTreeClean: clean },
				};
				const built = claimFromVerifyResult({ details, project, at, source });
				assert.ok(built);
				return built;
			};
			await appendClaims([claim(true, true, "2026-11-06T00:00:01.000Z"), claim(false, false, "2026-11-06T00:00:02.000Z")]);
			const [delivery] = createClaimsDeliveryRegistrations({ cwd: () => repo });
			assert.ok(delivery);
			const turn = (text: string) => delivery.evaluate({ hook: "turn_start", sessionId: "s1", text });
			assert.equal(turn("summarize the README").length, 0);
			const first = turn("why does the stats check fail?");
			assert.equal(first.length, 1);
			match(first[0]?.kind === "inject_reminder" ? first[0].message : "", /^\[Claims\] Check 'stats'.*Contested/u);
			// The same state is not offered again in the session.
			assert.equal(turn("rerun stats please").length, 0);
		} finally {
			env.restore();
		}
	});

	it("moves a slate hypothesis from proposed only on its named check: tested, supported, refuted", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			mkdirSync(join(repo, "research"), { recursive: true });
			writeFileSync(join(repo, "research", "h.json"), slateText([{ id: "H1", check: "stats" }]));
			const capture = createHypothesisCaptureRegistration({ cwd: () => repo });
			const wrote = { hook: "after_tool", toolName: "write", toolArgs: { path: "research/h.json" } } as const;
			await capture.evaluateAsync?.(wrote);
			// The same slate written again records nothing new.
			await capture.evaluateAsync?.(wrote);
			const status = () => {
				const read = readClaims(project);
				assert.equal(read.hypotheses.length, 1);
				const [hypothesis] = read.hypotheses;
				return hypothesisStatuses(read.hypotheses, read.hypothesisTests).get(hypothesis?.id ?? "")?.status;
			};
			assert.equal(status(), "proposed");
			const ran = verifyCall(createClaimCaptureRegistration({ cwd: () => repo })).run;
			await ran(numericDetails(false, "not-run", "timed-out"));
			assert.equal(status(), "tested");
			await ran({ ...numericDetails(true, "passed"), checkout: { commit: "c".repeat(40), trackedTreeClean: true } });
			assert.equal(status(), "supported");
			await ran({ ...numericDetails(false, "failed"), checkout: { commit: "c".repeat(40), trackedTreeClean: false } });
			assert.equal(status(), "refuted");
			// A test record that says supported without a claim behind it is not this ledger's and is not read.
			const [test] = readClaims(project).hypothesisTests;
			assert.ok(test);
			const { claim: _claim, ...unbacked } = { ...test, outcome: "supported" as const };
			appendFileSync(claimsLogPath(project), `${JSON.stringify(unbacked)}\n`);
			assert.equal(readClaims(project).hypothesisTests.length, 3);
			assert.equal(status(), "refuted");
			// A forged test with a correct id does not follow from the log either: it cites the disagreeing claim as
			// support, or a claim the log never held, so neither is admitted and the reader counts both.
			const disagreeing = readClaims(project).records.find((claim) => claim.verdict === "disagrees");
			assert.ok(disagreeing);
			const rehash = (body: Record<string, unknown>) => {
				const { id: _id, ...rest } = body;
				return JSON.stringify({ ...rest, id: claimLogRecordId(rest) });
			};
			const forged = { ...test, outcome: "supported", claim: disagreeing.id, at: "2099-01-01T00:00:00.000Z" };
			const invented = { ...forged, claim: "f".repeat(64), at: "2099-01-01T00:00:01.000Z" };
			appendFileSync(claimsLogPath(project), `${rehash(forged)}\n${rehash(invented)}\n`);
			const after = readClaims(project);
			assert.equal(after.mismatched, 0);
			assert.equal(after.unlinked, 2);
			assert.equal(after.hypothesisTests.length, 3);
			assert.equal(status(), "refuted");
		} finally {
			env.restore();
		}
	});

	it("binds a check's hypotheses when it starts, and rejects replayed or forked revisions", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			const capture = createHypothesisCaptureRegistration({ cwd: () => repo });
			const write = async (text: string) => {
				writeFileSync(join(repo, "h.json"), text);
				await capture.evaluateAsync?.({ hook: "after_tool", toolName: "write", toolArgs: { path: "h.json" } });
			};
			const verify = verifyCall(createClaimCaptureRegistration({ cwd: () => repo }));
			const statusOf = (entry: string) => {
				const read = readClaims(project);
				const current = read.hypotheses.filter((record) => record.hypothesis === entry).at(-1);
				return hypothesisStatuses(read.hypotheses, read.hypothesisTests).get(current?.id ?? "")?.status;
			};
			// A check already running when the hypothesis is proposed is not its test.
			const early = verify.start();
			await early.started;
			await write(slateText([{ id: "H1", check: "stats" }]));
			await early.finish({
				...numericDetails(true, "passed"),
				checkout: { commit: "c".repeat(40), trackedTreeClean: true },
			});
			assert.equal(statusOf("H1"), "proposed");
			// Nor is a check that started before the hypothesis was revised: the binding names the old revision.
			const stale = verify.start();
			await stale.started;
			await write(slateText([{ id: "H1", check: "stats", statement: "H1 holds, revised" }]));
			await stale.finish({
				...numericDetails(true, "passed"),
				checkout: { commit: "c".repeat(40), trackedTreeClean: true },
			});
			assert.equal(statusOf("H1"), "proposed");
			const [first, revised] = readClaims(project).hypotheses;
			assert.ok(first && revised);
			assert.equal(revised.revises, first.id);
			// A replay of the first revision and a second revision of it both fail admission.
			const log = claimsLogPath(project);
			appendFileSync(log, `${JSON.stringify(first)}\n`);
			const forkBody = { ...first, statement: "H1 forked", revises: first.id, at: "2099-01-01T00:00:00.000Z" };
			const { id: _forkId, ...forkRest } = { ...forkBody, subject: hypothesisSubject(forkBody) };
			appendFileSync(log, `${JSON.stringify({ ...forkRest, id: claimLogRecordId(forkRest) })}\n`);
			const read = readClaims(project);
			assert.deepEqual(
				read.hypotheses.map((record) => record.id),
				[first.id, revised.id],
			);
			assert.equal(read.unlinked, 2);
			assert.equal(read.mismatched, 0);
		} finally {
			env.restore();
		}
	});

	it("tests hypotheses on host checks bound at start, skips checks that never started, and reads accepted worker slates", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			// The worker's slate claims H2 is already supported; the host reads it as proposed, and an entry it marked
			// supported is not taken at its word.
			writeFileSync(
				join(repo, "w.json"),
				slateText([
					{ id: "H2", check: "stats" },
					{ id: "H3", check: "stats", status: "supported" },
				]),
			);
			const outside = join(env.dir, "outside.json");
			writeFileSync(outside, slateText([{ id: "H9", check: "stats" }]));
			const recorded = await recordAcceptedWorkerSlates({
				runId: "run1",
				receiptDigest: "d".repeat(64),
				projectCwd: repo,
				paths: [join(repo, "w.json"), "w.json", outside],
			});
			assert.equal(recorded, 1);
			const [h2] = readClaims(project).hypotheses;
			assert.equal(h2?.hypothesis, "H2");
			assert.equal(h2?.source.channel, "worker-slate");
			const statusOfH2 = () => {
				const read = readClaims(project);
				return hypothesisStatuses(read.hypotheses, read.hypothesisTests).get(h2?.id ?? "")?.status;
			};
			const bound = new Map([["stats", [h2?.id ?? ""]]]);
			const report = numericDetails(false, "failed").report as { kind: string; passed: boolean };
			const check = { check: "stats", argv: ["python3", "stats.py"], memo: false, exitCode: 1 };
			// A check that could not be started judged nothing and tests nothing.
			await recordHostVerificationClaims({
				runId: "run2",
				receiptDigest: "e".repeat(64),
				checks: [{ ...check, notRun: "spawn-failed" }],
				projectCwd: repo,
				hypotheses: bound,
			});
			assert.equal(statusOfH2(), "proposed");
			// Unbound, a judged check tests nothing either.
			await recordHostVerificationClaims({
				runId: "run3",
				receiptDigest: "f".repeat(64),
				checks: [{ ...check, report }],
				projectCwd: repo,
			});
			assert.equal(statusOfH2(), "proposed");
			await recordHostVerificationClaims({
				runId: "run4",
				receiptDigest: "a".repeat(64),
				checks: [{ ...check, report }],
				projectCwd: repo,
				hypotheses: bound,
			});
			assert.equal(statusOfH2(), "refuted");
		} finally {
			env.restore();
		}
	});

	it("never counts a reproduce check whose executable did not launch as a test", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			writeFileSync(join(repo, "h.json"), slateText([{ id: "H1", check: "repro" }]));
			await createHypothesisCaptureRegistration({ cwd: () => repo }).evaluateAsync?.({
				hook: "after_tool",
				toolName: "write",
				toolArgs: { path: "h.json" },
			});
			const missing = "clio-no-such-executable-406";
			// The runner resolves rather than throws on ENOENT; the launched fact is what says nothing ran.
			const spawned = await runCommandVector(missing, [], { cwd: repo, workspaceRoot: repo });
			assert.equal(spawned.launched, false);
			const hypotheses = bindHostVerificationHypotheses(repo, ["repro"]);
			assert.equal(hypotheses.get("repro")?.length, 1);
			const verification = await runHostVerification({
				runId: "run1",
				workerSuccessful: true,
				stateDir: join(env.dir, "host-state"),
				request: {
					resolvedVerification: [
						{
							check: "repro",
							argv: [missing, "metrics.json"],
							cwd: repo,
							timeoutMs: 10_000,
							kind: "reproduce",
							reproduce: {
								declaredCwd: ".",
								spec: { inputs: [], environment: "copy", compare: { mode: "twice" }, tolerance: { absolute: 0 } },
							},
						},
					],
				},
			});
			const [check] = verification?.checks ?? [];
			assert.equal(check?.notRun, "spawn-failed");
			assert.ok(check);
			await recordHostVerificationClaims({
				runId: "run1",
				receiptDigest: "d".repeat(64),
				checks: [check],
				projectCwd: repo,
				hypotheses,
			});
			const read = readClaims(project);
			assert.equal(read.hypothesisTests.length, 0);
			assert.equal(
				hypothesisStatuses(read.hypotheses, read.hypothesisTests).get(read.hypotheses[0]?.id ?? "")?.status,
				"proposed",
			);
		} finally {
			env.restore();
		}
	});
});
