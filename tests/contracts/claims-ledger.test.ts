import { strict as assert, match } from "node:assert";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { runCommandVector } from "../../src/core/safe-exec.js";
import { withStateFileLock } from "../../src/core/state-file-lock.js";
import { RunResultObjectSchema } from "../../src/core/telemetry/schemas.js";
import { claimLogRecordId } from "../../src/domains/claims/edges.js";
import { hypothesisSubject } from "../../src/domains/claims/hypotheses.js";
import {
	appendClaims,
	bindHostVerificationHypotheses,
	claimFromVerifyResult,
	claimRecordId,
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
	snapshotAcceptedWorkerSlates,
} from "../../src/domains/claims/index.js";
import { runHostVerification } from "../../src/domains/dispatch/host-verification.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import type { DeclaredReproduce } from "../../src/tools/verify/reproduce.js";
import { runProjectCheck } from "../../src/tools/verify/scripts.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
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

	it("reads a repeated claim, edge or regression line once", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			const claim = (passed: boolean, at: string) => {
				const details = {
					...numericDetails(passed, passed ? "passed" : "failed"),
					checkout: { commit: "c".repeat(40), trackedTreeClean: true },
				};
				const built = claimFromVerifyResult({ details, project, at, source });
				assert.ok(built);
				return built;
			};
			const agreed = claim(true, "2026-11-06T00:00:01.000Z");
			const disagreed = claim(false, "2026-11-06T00:00:02.000Z");
			await appendClaims([agreed]);
			const edges = await appendClaims([disagreed]);
			assert.equal(edges.length, 1);
			const log = claimsLogPath(project);
			const regressionBody = {
				v: agreed.v,
				type: "regression",
				at: "2026-11-06T00:00:03.000Z",
				project,
				edge: edges[0]?.id,
				from: agreed.id,
				backing: [],
				memory: [],
			};
			appendFileSync(log, `${JSON.stringify({ ...regressionBody, id: claimLogRecordId(regressionBody) })}\n`);
			// Every line appended a second time, as a retried append whose first write did land leaves it.
			appendFileSync(log, readFileSync(log, "utf8"));
			const read = readClaims(project);
			assert.deepEqual(
				read.records.map((record) => record.id),
				[agreed.id, disagreed.id],
			);
			assert.equal(read.edges.length, 1);
			assert.equal(read.regressions.length, 1);
			assert.equal(read.duplicates, 4);
			assert.equal(read.mismatched, 0);
			assert.equal(claimStatuses(read.records, read.edges).get(agreed.id), "contested");
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

	it("credits a check run only to the revisions its persisted start lists", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			const capture = createHypothesisCaptureRegistration({ cwd: () => repo });
			const write = async (statement: string) => {
				writeFileSync(join(repo, "h.json"), slateText([{ id: "H1", check: "stats", statement }]));
				await capture.evaluateAsync?.({ hook: "after_tool", toolName: "write", toolArgs: { path: "h.json" } });
			};
			await write("H1 holds");
			const call = verifyCall(createClaimCaptureRegistration({ cwd: () => repo })).start();
			await call.started;
			await write("H1 holds, revised while the check ran");
			await call.finish({
				...numericDetails(true, "passed"),
				checkout: { commit: "c".repeat(40), trackedTreeClean: true },
			});
			const before = readClaims(project);
			const [start] = before.checkStarts;
			const [bound, revised] = before.hypotheses;
			const [test] = before.hypothesisTests;
			assert.ok(start && bound && revised && test);
			assert.deepEqual(start.hypotheses, [bound.id]);
			assert.equal(test.hypothesis, bound.id);
			// The revision appended while the check ran is credited with its judgement neither by a test naming it nor by
			// a second start of the same run listing it, however correctly each is rehashed.
			const rehash = (body: Record<string, unknown>) => {
				const { id: _id, ...rest } = body;
				return `${JSON.stringify({ ...rest, id: claimLogRecordId(rest) })}\n`;
			};
			appendFileSync(
				claimsLogPath(project),
				rehash({ ...test, hypothesis: revised.id, at: "2099-01-01T00:00:00.000Z" }) +
					rehash({ ...start, hypotheses: [revised.id], at: "2099-01-01T00:00:01.000Z" }) +
					rehash({ ...test, hypothesis: revised.id, at: "2099-01-01T00:00:02.000Z" }),
			);
			const after = readClaims(project);
			assert.equal(after.unlinked, 3);
			assert.deepEqual(
				after.checkStarts.map((record) => record.id),
				[start.id],
			);
			assert.deepEqual(
				after.hypothesisTests.map((record) => record.id),
				[test.id],
			);
			const statuses = hypothesisStatuses(after.hypotheses, after.hypothesisTests);
			assert.equal(statuses.get(bound.id)?.status, "supported");
			assert.equal(statuses.get(revised.id)?.status, "proposed");
		} finally {
			env.restore();
		}
	});

	it("takes a check run's identity at start even when no hypothesis names its check yet", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			const log = claimsLogPath(project);
			const rehash = (body: Record<string, unknown>) => {
				const { id: _id, ...rest } = body;
				return `${JSON.stringify({ ...rest, id: claimLogRecordId(rest) })}\n`;
			};
			const call = verifyCall(createClaimCaptureRegistration({ cwd: () => repo })).start();
			await call.started;
			// While the genuine call runs, a hypothesis naming its check lands, and a start of that running call listing
			// it is forged; once the genuine judgement is on disk a test citing it is forged too.
			writeFileSync(join(repo, "h.json"), slateText([{ id: "H1", check: "stats" }]));
			await createHypothesisCaptureRegistration({ cwd: () => repo }).evaluateAsync?.({
				hook: "after_tool",
				toolName: "write",
				toolArgs: { path: "h.json" },
			});
			const [hypothesis] = readClaims(project).hypotheses;
			assert.ok(hypothesis);
			const run = { channel: "verify", sessionId: "s1", toolCallId: "c1" };
			appendFileSync(
				log,
				rehash({
					v: hypothesis.v,
					type: "check-start",
					at: "2099-01-01T00:00:00.000Z",
					project,
					check: "stats",
					run,
					hypotheses: [hypothesis.id],
				}),
			);
			await call.finish({
				...numericDetails(true, "passed"),
				checkout: { commit: "c".repeat(40), trackedTreeClean: true },
			});
			const [claim] = readClaims(project).records;
			assert.ok(claim);
			appendFileSync(
				log,
				rehash({
					v: hypothesis.v,
					type: "hypothesis-test",
					at: "2099-01-01T00:00:01.000Z",
					project,
					hypothesis: hypothesis.id,
					check: "stats",
					outcome: "supported",
					claim: claim.id,
					execution: "succeeded",
					source: claim.source,
				}),
			);
			const read = readClaims(project);
			assert.deepEqual(
				read.checkStarts.map((start) => [start.run, start.hypotheses]),
				[[run, []]],
			);
			assert.deepEqual(read.hypothesisTests, []);
			assert.equal(read.unlinked, 2);
			assert.equal(hypothesisStatuses(read.hypotheses, read.hypothesisTests).get(hypothesis.id)?.status, "proposed");
		} finally {
			env.restore();
		}
	});

	it("records a slate's digest from its bytes as read, even when they are not valid UTF-8", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			// A lone 0xff inside a JSON string decodes to U+FFFD and still parses, so the decoded text hashes differently.
			const [head = "", tail = ""] = slateText([{ id: "H1", check: "stats", statement: "H1 holds MARK" }]).split("MARK");
			const bytes = Buffer.concat([Buffer.from(head), Buffer.from([0xff]), Buffer.from(tail)]);
			const digest = createHash("sha256").update(bytes).digest("hex");
			writeFileSync(join(repo, "h.json"), bytes);
			writeFileSync(join(repo, "w.json"), bytes);
			await createHypothesisCaptureRegistration({ cwd: () => repo }).evaluateAsync?.({
				hook: "after_tool",
				toolName: "write",
				toolArgs: { path: "h.json" },
			});
			await recordAcceptedWorkerSlates({
				runId: "run1",
				receiptDigest: "e".repeat(64),
				projectCwd: repo,
				slates: snapshotAcceptedWorkerSlates({ projectCwd: repo, paths: [join(repo, "w.json")] }),
			});
			const read = readClaims(project);
			assert.deepEqual(
				read.hypotheses.map((record) => [record.source.channel, record.source.slateSha256]),
				[
					["slate", digest],
					["worker-slate", digest],
				],
			);
		} finally {
			env.restore();
		}
	});

	it("refuses a slate capture whose file changed before it held the log's lock", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			const slate = join(repo, "h.json");
			const capture = createHypothesisCaptureRegistration({ cwd: () => repo });
			const wrote = { hook: "after_tool", toolName: "write", toolArgs: { path: "h.json" } } as const;
			const older = slateText([{ id: "H1", check: "stats", statement: "H1 holds, first" }]);
			const newer = slateText([{ id: "H1", check: "stats", statement: "H1 holds, second" }]);
			writeFileSync(slate, older);
			await capture.evaluateAsync?.(wrote);
			writeFileSync(slate, newer);
			await capture.evaluateAsync?.(wrote);
			// A capture of the older bytes that waited on the log's lock while the newer bytes landed again records
			// nothing, so the chain never revises back to a slate the file no longer holds.
			let late: Promise<unknown> | undefined;
			await withStateFileLock(claimsLogPath(project), () => {
				writeFileSync(slate, older);
				late = capture.evaluateAsync?.(wrote);
				writeFileSync(slate, newer);
			});
			await late;
			const read = readClaims(project);
			assert.deepEqual(
				read.hypotheses.map((record) => record.statement),
				["H1 holds, first", "H1 holds, second"],
			);
			assert.equal(read.hypotheses.at(-1)?.source.slateSha256, createHash("sha256").update(newer).digest("hex"));
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
			const workerSlate = slateText([
				{ id: "H2", check: "stats" },
				{ id: "H3", check: "stats", status: "supported" },
			]);
			writeFileSync(join(repo, "w.json"), workerSlate);
			writeFileSync(join(repo, "notes.json"), JSON.stringify({ not: "a slate" }));
			const outside = join(env.dir, "outside.json");
			writeFileSync(outside, slateText([{ id: "H9", check: "stats" }]));
			const accept = () =>
				snapshotAcceptedWorkerSlates({
					projectCwd: repo,
					paths: [join(repo, "w.json"), "w.json", join(repo, "notes.json"), outside],
				});
			// Bytes that replace an accepted slate after the host accepted the run are not the run's: nothing is recorded
			// and the drift is named.
			const replaced = accept();
			assert.equal(replaced.length, 1);
			writeFileSync(join(repo, "w.json"), slateText([{ id: "H4", check: "stats" }]));
			assert.deepEqual(
				await recordAcceptedWorkerSlates({
					runId: "run0",
					receiptDigest: "c".repeat(64),
					projectCwd: repo,
					slates: replaced,
				}),
				{ recorded: 0, drifted: [realpathSync(join(repo, "w.json"))] },
			);
			assert.equal(readClaims(project).hypotheses.length, 0);
			writeFileSync(join(repo, "w.json"), workerSlate);
			const recorded = await recordAcceptedWorkerSlates({
				runId: "run1",
				receiptDigest: "d".repeat(64),
				projectCwd: repo,
				slates: accept(),
			});
			assert.deepEqual(recorded, { recorded: 1, drifted: [] });
			const [h2] = readClaims(project).hypotheses;
			assert.equal(h2?.hypothesis, "H2");
			assert.equal(h2?.source.channel, "worker-slate");
			const statusOfH2 = () => {
				const read = readClaims(project);
				return hypothesisStatuses(read.hypotheses, read.hypothesisTests).get(h2?.id ?? "")?.status;
			};
			const report = numericDetails(false, "failed").report as { kind: string; passed: boolean };
			const check = { check: "stats", argv: ["python3", "stats.py"], memo: false, exitCode: 1 };
			// A check that could not be started judged nothing and tests nothing.
			await recordHostVerificationClaims({
				runId: "run2",
				receiptDigest: "e".repeat(64),
				checks: [{ ...check, notRun: "spawn-failed" }],
				projectCwd: repo,
				hypotheses: await bindHostVerificationHypotheses(repo, "run2", ["stats"]),
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
			const bound = await bindHostVerificationHypotheses(repo, "run4", ["stats", "unnamed"]);
			// A check no hypothesis names is started too, bound to nothing.
			assert.deepEqual(
				[...bound],
				[
					["stats", [h2?.id]],
					["unnamed", []],
				],
			);
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

	it("decides a hypothesis only on a grounded claim from a valid source of the test's own channel", async () => {
		const env = await isolateClioEnv("clio-claims-");
		try {
			const repo = join(env.dir, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const project = claimsProjectRoot(repo);
			writeFileSync(join(repo, "h.json"), slateText([{ id: "H1", check: "stats" }]));
			await createHypothesisCaptureRegistration({ cwd: () => repo }).evaluateAsync?.({
				hook: "after_tool",
				toolName: "write",
				toolArgs: { path: "h.json" },
			});
			const [hypothesis] = readClaims(project).hypotheses;
			assert.ok(hypothesis);
			// Both runs the forgeries name started bound to the hypothesis, so only the claim can refuse them.
			await createClaimCaptureRegistration({ cwd: () => repo }).evaluateAsync?.({
				hook: "before_tool",
				toolName: "verify",
				sessionId: "s1",
				toolCallId: "t1",
				toolArgs: { check: "stats" },
			});
			await bindHostVerificationHypotheses(repo, "s1", ["stats"]);
			assert.equal(readClaims(project).checkStarts.length, 2);
			const genuine = claimFromVerifyResult({
				details: { ...numericDetails(true, "passed"), checkout: { commit: "c".repeat(40), trackedTreeClean: true } },
				project,
				at: "2099-01-01T00:00:00.000Z",
				source,
			});
			assert.ok(genuine);
			// Each forgery rehashes correctly and follows the hypothesis, cites its own check and agrees, so only the
			// claim's evidence or source can refuse it: a proposed claim, a claim from an invented channel cited by a verify
			// test with the same identity fields, and a genuine verify claim cited by a test that says a host run made it.
			const forge = (claim: Record<string, unknown>, testSource: Record<string, unknown>, at: string) => {
				const { id: _claimId, ...claimRest }: Record<string, unknown> = { ...claim, at };
				const forgedClaim = { ...claimRest, id: claimRecordId(claimRest as never) };
				const testRest = {
					v: 1,
					type: "hypothesis-test",
					at,
					project,
					hypothesis: hypothesis.id,
					check: "stats",
					outcome: "supported",
					claim: forgedClaim.id,
					execution: "succeeded",
					source: testSource,
				};
				return `${JSON.stringify(forgedClaim)}\n${JSON.stringify({ ...testRest, id: claimLogRecordId(testRest) })}\n`;
			};
			const invented = { channel: "notebook", sessionId: "s1", toolCallId: "t1", requestedBy: "model" };
			const host = { channel: "host-verification", runId: "s1", receiptDigest: "t1", sessionId: "s1", toolCallId: "t1" };
			appendFileSync(
				claimsLogPath(project),
				forge({ ...genuine, evidence: "proposed" }, source, "2099-01-01T00:00:01.000Z") +
					forge({ ...genuine, source: invented }, source, "2099-01-01T00:00:02.000Z") +
					forge(genuine as unknown as Record<string, unknown>, host, "2099-01-01T00:00:03.000Z"),
			);
			const read = readClaims(project);
			// Only the last forgery's claim, the genuine one, is read as a claim; no test is admitted.
			assert.equal(read.records.length, 1);
			assert.equal(read.mismatched, 2);
			assert.equal(read.unlinked, 3);
			assert.equal(read.hypothesisTests.length, 0);
			assert.equal(hypothesisStatuses(read.hypotheses, read.hypothesisTests).get(hypothesis.id)?.status, "proposed");
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
			const hypotheses = await bindHostVerificationHypotheses(repo, "run1", ["repro"]);
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
			assert.ok(check && verification);
			// The persisted run-result object the receipt digest seals keeps the fact, and the object store accepts it.
			const envelope = fixtureEnvelope("run1");
			const sealed = finishRunResult({ ...fixtureReceiptDraft(envelope), hostVerification: verification }, envelope, {
				terminal: { terminalReason: "completed" },
				processExitCode: 0,
				frameType: null,
				usage: undefined,
			}).settlement.result;
			assert.equal(sealed.hostVerification?.checks[0]?.notRun, "spawn-failed");
			assert.ok(Value.Check(RunResultObjectSchema, sealed));
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

	it("counts a reproduce check whose second run could not start as tested, on both channels", async () => {
		const env = await isolateClioEnv("clio-claims-");
		const previousCwd = process.cwd();
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
			// The first run launches, prints its payload and removes its own executable, so the second cannot start.
			const once = join(env.dir, "bin", "once");
			const arm = () => {
				mkdirSync(join(env.dir, "bin"), { recursive: true });
				writeFileSync(once, `#!/bin/sh\nrm -f -- "$0"\necho '{"x": 1}'\n`, { mode: 0o755 });
			};
			const spec: DeclaredReproduce = {
				inputs: [],
				environment: "copy",
				compare: { mode: "twice" },
				tolerance: { absolute: 0 },
			};
			const statusOfH1 = () => {
				const read = readClaims(project);
				return hypothesisStatuses(read.hypotheses, read.hypothesisTests).get(read.hypotheses[0]?.id ?? "")?.status;
			};

			arm();
			const hypotheses = await bindHostVerificationHypotheses(repo, "run1", ["repro"]);
			const verification = await runHostVerification({
				runId: "run1",
				workerSuccessful: true,
				stateDir: join(env.dir, "host-state"),
				request: {
					resolvedVerification: [
						{
							check: "repro",
							argv: [once],
							cwd: repo,
							timeoutMs: 10_000,
							kind: "reproduce",
							reproduce: { declaredCwd: ".", spec },
						},
					],
				},
			});
			const [check] = verification?.checks ?? [];
			assert.ok(check);
			match(check.outputTail, /run 2 could not start/);
			assert.equal(check.notRun, undefined);
			await recordHostVerificationClaims({
				runId: "run1",
				receiptDigest: "d".repeat(64),
				checks: [check],
				projectCwd: repo,
				hypotheses,
			});
			assert.equal(statusOfH1(), "tested");

			// The main thread's verify reads the same outcome as a failed run, not an unavailable runner.
			arm();
			process.chdir(repo);
			const call = verifyCall(createClaimCaptureRegistration({ cwd: () => repo })).start("repro");
			await call.started;
			const result = await runProjectCheck({
				id: "repro",
				description: "reproduce twice",
				command: [once],
				cwd: ".",
				timeoutMs: 10_000,
				tags: [],
				source: { kind: "project-catalog", path: ".clio-coder/verifiers.json" },
				kind: "reproduce",
				reproduce: spec,
			});
			match(result.kind === "error" ? result.message : "", /run 2 could not start/);
			assert.equal((result.details?.judgement as { execution?: string } | undefined)?.execution, "failed");
			await call.finish(result.details ?? {});
			const tests = readClaims(project).hypothesisTests;
			assert.deepEqual(
				tests.map((test) => [test.source.channel, test.outcome, test.execution]),
				[
					["host-verification", "tested", "failed"],
					["verify", "tested", "failed"],
				],
			);
		} finally {
			process.chdir(previousCwd);
			env.restore();
		}
	});
});
