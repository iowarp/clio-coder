import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";

const planModule = "../../scripts/release/plan.mjs";
const receiptModule = "../../scripts/release/receipt.mjs";
const nextModule = "../../scripts/release/next.mjs";
const candidateModule = "../../scripts/release-candidate.mjs";
const commit = "a".repeat(40);

type Facts = Record<string, unknown>;
function facts(overrides: Facts = {}): Facts {
	return {
		mode: "release",
		foreignRuns: [],
		tree: { clean: true, branch: "v071", versionsAgree: true, mainAncestor: true, readiness: [] },
		local: { node22: true, node24: true },
		pushed: true,
		ci: {
			state: "success",
			artifacts: true,
			jobs: ["prepare", "ci (22)", "ci (24)"].map((name, id) => ({ id, name, conclusion: "success" })),
		},
		releaseRun: null,
		npm: { served: false, integrityMatches: null },
		published: false,
		tagsBehind: [],
		postPending: [],
		...overrides,
	};
}
const releaseRun = (state: string, preflight: Facts, release?: Facts) => ({
	state,
	jobs: [{ id: 1, name: "preflight", ...preflight }, ...(release ? [{ id: 2, name: "release", ...release }] : [])],
});

describe("release decisions", () => {
	it("refuses the shared /tmp and socket-breaking TMPDIR lengths", async () => {
		const { tmpdirProblem } = await import(planModule);
		ok(tmpdirProblem("/tmp"));
		ok(tmpdirProblem("/tmp/clio"));
		ok(tmpdirProblem(`/home/${"x".repeat(40)}`));
		strictEqual(tmpdirProblem("/home/u/.cache/cr"), null);
	});

	it("lets only release tooling differ between the candidate and the finishing head", async () => {
		const { toolingOnly } = await import(planModule);
		ok(toolingOnly(["scripts/release-publish.mjs", ".github/workflows/release.yml", "scripts/release/plan.mjs"]));
		ok(!toolingOnly(["scripts/release-publish.mjs", "src/cli.ts"]));
		ok(!toolingOnly([".github/workflows/ci.yml"]));
		ok(!toolingOnly([]));
	});

	it("accepts the version branch of a two-digit patch or minor", async () => {
		const { isVersionBranch, nextStep, versionBranch } = await import(planModule);
		strictEqual(versionBranch("0.7.10"), "v0710");
		ok(isVersionBranch("v071") && isVersionBranch("v0710") && isVersionBranch(versionBranch("0.10.0")));
		ok(!isVersionBranch("v07") && !isVersionBranch("main") && !isVersionBranch("v071-x"));
		const tree = { clean: true, branch: "v0710", versionsAgree: true, mainAncestor: true, readiness: [] };
		strictEqual(nextStep(facts({ pushed: false, ci: null, local: { wanted: false }, tree }), {}).step, "push");
	});

	it("pins a stale draft to the candidate before publishing it", async () => {
		const { draftAction } = await import(planModule);
		strictEqual(draftAction({ release: null, tagCommit: null }, commit).action, "create");
		strictEqual(
			draftAction({ release: { draft: true, target_commitish: "main" }, tagCommit: null }, commit).action,
			"retarget",
		);
		strictEqual(
			draftAction({ release: { draft: true, target_commitish: commit }, tagCommit: null }, commit).action,
			"publish",
		);
		strictEqual(draftAction({ release: { draft: false }, tagCommit: commit }, commit).action, "verify");
		strictEqual(draftAction({ release: null, tagCommit: "b".repeat(40) }, commit).action, "stop");
	});

	it("lets CI qualify, runs local Node majors only with --local, and skips them for a green CI run", async () => {
		const { nextStep } = await import(planModule);
		const fresh = { pushed: false, ci: null };
		strictEqual(nextStep(facts({ ...fresh, local: { wanted: false } }), {}).step, "push");
		deepStrictEqual(nextStep(facts({ ...fresh, local: { wanted: true, node22: false, node24: true } }), {}), {
			step: "qualify",
			missing: ["22"],
		});
		strictEqual(nextStep(facts({ pushed: false, local: { wanted: true } }), {}).step, "push");
	});

	it("offers npm publish only after the release preflight passed and the job awaits approval", async () => {
		const { nextStep } = await import(planModule);
		strictEqual(nextStep(facts(), {}).step, "dispatch-release");
		strictEqual(
			nextStep(facts({ releaseRun: releaseRun("in_progress", { status: "in_progress" }) }), {}).step,
			"watch-release",
		);
		const failed = nextStep(
			facts({ releaseRun: releaseRun("failure", { status: "completed", conclusion: "failure" }) }),
			{},
		);
		strictEqual(failed.step, "stop");
		const waiting = releaseRun("waiting", { status: "completed", conclusion: "success" }, { status: "waiting" });
		strictEqual(nextStep(facts({ releaseRun: waiting }), {}).step, "publish-npm");
		// Approved before the publish: the release job runs and waits for npm, so publish is still offered.
		const approvedEarly = releaseRun(
			"in_progress",
			{ status: "completed", conclusion: "success" },
			{ status: "in_progress" },
		);
		strictEqual(nextStep(facts({ releaseRun: approvedEarly }), {}).step, "publish-npm");
		const preflightOnly = releaseRun("in_progress", { status: "completed", conclusion: "success" });
		strictEqual(nextStep(facts({ releaseRun: preflightOnly }), {}).step, "watch-release");
		// Once npm accepted the bytes the publish is never offered again, even while npm serves nothing.
		strictEqual(nextStep(facts({ releaseRun: waiting }), { npm: { accepted: true } }).step, "approve-release");
		const timedOut = releaseRun("failure", { status: "completed", conclusion: "success" }, { status: "completed" });
		strictEqual(nextStep(facts({ releaseRun: timedOut }), { npm: { accepted: true } }).step, "wait-npm");
	});

	it("finishes a published candidate after the version branch moved past it", async () => {
		const { nextStep } = await import(planModule);
		const failed = releaseRun("failure", { status: "completed", conclusion: "success" }, { status: "completed" });
		const served = { served: true, integrityMatches: true };
		const head = "d".repeat(40);
		const foreign = { head, descends: true, toolingOnly: false };
		const after = { npm: { accepted: true } };
		// The moved branch never sends the release back to push or into endless reruns.
		const step = nextStep(facts({ pushed: false, npm: served, releaseRun: failed, moved: foreign }), after);
		strictEqual(step.step, "finish-published");
		strictEqual(step.head, head);
		strictEqual(nextStep(facts({ npm: served, releaseRun: failed, moved: foreign }), after).step, "finish-published");
		// Tooling-only commits may finish it from the new head.
		const tooling = { ...foreign, toolingOnly: true };
		strictEqual(nextStep(facts({ pushed: false, npm: served, moved: tooling }), after).step, "dispatch-release");
		// Before npm accepted, a moved branch is a new candidate, as before.
		strictEqual(nextStep(facts({ pushed: false, ci: null, local: { wanted: false }, moved: foreign }), {}).step, "push");
	});

	it("cancels the old candidate's open release run before starting over", async () => {
		const { startOverCancels } = await import(planModule);
		const receipt = { releaseRun: { id: 7 }, ciRun: { id: 6 } };
		deepStrictEqual(
			startOverCancels(receipt, () => "waiting").map(({ id, argv }) => [id, argv.slice(0, 3)]),
			[[7, ["run", "cancel", "7"]]],
		);
		deepStrictEqual(
			startOverCancels(receipt, () => "completed"),
			[],
		);
		deepStrictEqual(
			startOverCancels({ releaseRun: null }, () => "waiting"),
			[],
		);
	});

	it("publishes only the ci.yml run's artifact, never the local candidate", async () => {
		const { ciCandidateDirectory, publishArgs } = await import(planModule);
		const ciRun = { id: 42 };
		const state = "/state";
		const options = { state, ciRun, channel: "latest" };
		const tarball = join(ciCandidateDirectory(state, ciRun), "iowarp-clio-coder-0.7.1.tgz");
		deepStrictEqual(publishArgs({ run: "42", tarball }, options), [
			"publish",
			tarball,
			"--access",
			"public",
			"--tag",
			"latest",
		]);
		const local = join(state, "c-aaaaaaaaaaaa", "iowarp-clio-coder-0.7.1.tgz");
		throws(() => publishArgs({ run: null, tarball: local }, options), /ci\.yml run 42/u);
		throws(() => publishArgs({ run: "42", tarball: local }, options), /only the CI artifact/u);
		throws(() => publishArgs({ run: "41", tarball }, options), /ci\.yml run 42/u);
	});

	it("stops on different published bytes and forwards tags after verification", async () => {
		const { nextStep } = await import(planModule);
		strictEqual(nextStep(facts({ npm: { served: true, integrityMatches: false } }), {}).step, "stop");
		deepStrictEqual(nextStep(facts({ published: true, tagsBehind: ["beta"] }), {}), {
			step: "forward-tags",
			tags: ["beta"],
		});
	});

	it("treats an un-drafted release with unfinished closeout as a failed run to rerun", async () => {
		const { nextStep, publicProven } = await import(planModule);
		const fix = "b".repeat(40);
		const done = {
			runSucceeded: false,
			release: { draft: false },
			tagCommit: commit,
			commit,
			latest: true,
			mainHead: fix,
			finishingHeads: [commit, fix],
			branchHead: null,
		};
		ok(publicProven(done));
		ok(publicProven({ ...done, release: { draft: true }, runSucceeded: true }));
		ok(!publicProven({ ...done, mainHead: "c".repeat(40) }), "main not promoted");
		ok(!publicProven({ ...done, branchHead: commit }), "version branch not deleted");
		ok(!publicProven({ ...done, release: { draft: true } }));
		ok(!publicProven({ ...done, tagCommit: fix }));
		ok(publicProven({ ...done, latest: false, mainHead: "c".repeat(40), branchHead: commit }), "prerelease");
		const failed = releaseRun("failure", { status: "completed", conclusion: "success" }, { status: "completed" });
		const served = { served: true, integrityMatches: true };
		strictEqual(nextStep(facts({ npm: served, releaseRun: failed, published: false }), {}).step, "rerun-release");
	});

	it("stops after one post-release pass when an item failed", async () => {
		const { postFailures } = await import(planModule);
		deepStrictEqual(
			postFailures({
				main: { status: "done", note: "fast-forwarded" },
				issues: { status: "failed", note: "gh: rate limited" },
				branch: { status: "skipped", note: "declined" },
			}),
			["issues: gh: rate limited"],
		);
		deepStrictEqual(postFailures(undefined), []);
	});

	it("scans issues from the previous release, not from the new tag", async () => {
		const { previousTag } = await import(planModule);
		const repo = mkdtempSync(join(tmpdir(), "clio-release-tags-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
		try {
			git("init", "-q");
			for (const message of ["0.7.0", "fix", "0.7.1"]) git("commit", "-q", "--allow-empty", "-m", message);
			git("tag", "v0.7.0", "HEAD~2");
			git("tag", "v0.7.1", "HEAD");
			strictEqual(previousTag(git, "v0.7.1", git("rev-parse", "HEAD")), "v0.7.0");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("rehearses without public writes and always tears down", async () => {
		const { nextStep } = await import(planModule);
		strictEqual(nextStep(facts({ mode: "rehearse" }), {}).step, "check-release");
		const stubbed = { checked: true, drafted: true, stubbed: true };
		strictEqual(nextStep(facts({ mode: "rehearse" }), { rehearsal: stubbed }).step, "teardown");
		const finished = facts({ mode: "rehearse", pushed: false, ci: null });
		strictEqual(nextStep(finished, { rehearsal: { ...stubbed, tornDown: true } }).step, "done");
		// A failed or interrupted rehearsal was torn down too; it resumes on a new branch, never reports done.
		const failed = { checked: { run: 7 }, tornDown: true, branch: null };
		strictEqual(nextStep(finished, { rehearsal: failed }).step, "push");
		strictEqual(nextStep(facts({ mode: "rehearse" }), { rehearsal: failed }).step, "draft-rehearsal");
		strictEqual(nextStep(finished, { rehearsal: { tornDown: true } }).step, "push");
		const throwaway = { clean: true, branch: "rehearse-071", versionsAgree: true, mainAncestor: true, readiness: [] };
		strictEqual(nextStep({ ...finished, tree: throwaway }, {}).step, "push");
		strictEqual(nextStep(facts({ pushed: false, tree: throwaway }), {}).step, "stop");
	});

	it("reports an environment approval as waiting", async () => {
		const { runState } = await import(planModule);
		strictEqual(runState({ status: "in_progress" }, [{ status: "waiting" }]), "waiting");
		strictEqual(runState({ status: "completed", conclusion: "cancelled" }), "cancelled");
		strictEqual(runState(undefined), "absent");
	});
});

describe("release ownership", () => {
	it("admits one operator, takes over from a dead holder, and lets spawned steps inherit", async () => {
		const { acquireLock, LockHeld } = await import(receiptModule);
		const state = mkdtempSync(join(tmpdir(), "clio-release-lock-"));
		try {
			const first = acquireLock(state, "release", { pid: 101, host: "h", isAlive: () => true });
			throws(() => acquireLock(state, "release", { pid: 102, host: "h", isAlive: () => true }), LockHeld);
			const child = acquireLock(state, "qualify", {
				pid: 103,
				host: "h",
				isAlive: () => true,
				inherit: true,
				env: { CLIO_RELEASE_LOCK_PID: "101" },
			});
			child.release();
			ok(existsSync(join(state, "lock")));
			const next = acquireLock(state, "release", { pid: 104, host: "h", isAlive: () => false });
			strictEqual(next.takeover.pid, 101);
			first.release();
			ok(existsSync(join(state, "lock")));
			next.release();
			ok(!existsSync(join(state, "lock")));
			writeFileSync(join(state, "lock"), JSON.stringify({ host: "other", pid: 1 }));
			throws(() => acquireLock(state, "release", { pid: 105, host: "h", isAlive: () => false }), LockHeld);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("lets only one of two operators take over a dead holder's lock", async () => {
		const { acquireLock, LockHeld } = await import(receiptModule);
		const state = mkdtempSync(join(tmpdir(), "clio-release-lock-"));
		const lock = join(state, "lock");
		try {
			writeFileSync(lock, JSON.stringify({ host: "h", pid: 101, startedAt: "t0" }));
			// While this operator decides pid 101 is dead, another one completes its takeover.
			const isAlive = (pid: number) => {
				if (pid !== 101) return true;
				writeFileSync(lock, JSON.stringify({ host: "h", pid: 200, startedAt: "t1" }));
				return false;
			};
			throws(() => acquireLock(state, "release", { pid: 300, host: "h", isAlive }), LockHeld);
			strictEqual(JSON.parse(readFileSync(lock, "utf8")).pid, 200);
			// A takeover already in progress is never second-guessed.
			writeFileSync(lock, JSON.stringify({ host: "h", pid: 101, startedAt: "t0" }));
			writeFileSync(join(state, "lock.takeover"), JSON.stringify({ host: "h", pid: 400 }));
			throws(() => acquireLock(state, "release", { pid: 301, host: "h", isAlive: () => false }), LockHeld);
			strictEqual(JSON.parse(readFileSync(lock, "utf8")).pid, 101);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
});

describe("release workflows", () => {
	it("tests the candidate on Node 24 as well as Node 22", () => {
		const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
		const steps: Array<{ run?: string; with?: Record<string, string> }> = workflow.jobs["runtime-compatibility"].steps;
		ok(
			steps.some((step) => step.run?.includes("release-candidate.mjs test") && step.run.includes("test-results-24.json")),
		);
		ok(steps.some((step) => step.with?.name === `results24-\${{ inputs.sha }}`));
		ok(workflow.jobs.prepare.steps.some((step: { run?: string }) => step.run?.includes("rehearse/*")));
	});

	it("boots macOS with platforms and Windows only when asked", () => {
		const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
		const matrix: string = workflow.jobs.platform.strategy.matrix.os;
		const inputs = workflow.on.workflow_dispatch.inputs;
		strictEqual(inputs.windows.default, true, "the old release flow keeps both boots");
		const choose = (windows: boolean) =>
			JSON.parse(matrix.match(windows ? /'(\[[^']*windows[^']*\])'/u : /\|\| '(\[[^']*\])'/u)?.[1] ?? "[]");
		deepStrictEqual(choose(true), ["windows-latest", "macos-latest"]);
		deepStrictEqual(choose(false), ["macos-latest"]);
	});

	it("lets a descendant finish, waits for npm, and never publishes from a check run", () => {
		const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
		ok(!JSON.stringify(workflow.jobs.preflight.steps).includes('test \\"$CANDIDATE_SHA\\" = \\"$GITHUB_SHA\\"'));
		ok(workflow.jobs.release["timeout-minutes"] >= 40);
		strictEqual(workflow.jobs.release.if, `\${{ inputs.mode != 'check' }}`);
		ok(workflow.on.workflow_dispatch.inputs.mode.options.includes("check"));
	});
});

describe("release walk over recorded reads", () => {
	const repo = "repos/iowarp/clio-coder";
	const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const name = "@iowarp/clio-coder";
	const version = "0.7.1";

	/** A CI candidate artifact of run 77 that verifyCandidate accepts. */
	async function ciArtifact(scratch: string) {
		const { installers, sha256 } = await import(candidateModule);
		const directory = join(scratch, `artifacts/77-candidate-${head}`);
		mkdirSync(join(directory, "package"), { recursive: true });
		mkdirSync(join(directory, "site"));
		writeFileSync(join(directory, "package/package.json"), JSON.stringify({ name, version }));
		const tarball = `iowarp-clio-coder-${version}.tgz`;
		execFileSync("tar", ["-czf", join(directory, tarball), "-C", directory, "package"]);
		writeFileSync(
			join(directory, "site/version.json"),
			JSON.stringify({ publishedVersion: version, docsCommit: head, revision: head }),
		);
		execFileSync("tar", ["-czf", join(directory, "website.tgz"), "-C", join(directory, "site"), "."]);
		rmSync(join(directory, "package"), { recursive: true });
		rmSync(join(directory, "site"), { recursive: true });
		const others = [...installers, "release-notes.md", "metafile-esm.json"];
		for (const file of others) writeFileSync(join(directory, file), file);
		const files = Object.fromEntries(
			[tarball, "website.tgz", ...others].map((file) => [file, sha256(readFileSync(join(directory, file)))]),
		);
		writeFileSync(
			join(directory, "candidate.json"),
			JSON.stringify({ schema: 2, name, version, commit: head, run: 77, files }),
		);
		return `sha512-${createHash("sha512")
			.update(readFileSync(join(directory, tarball)))
			.digest("base64")}`;
	}

	type Run = { id: number; status: string; conclusion?: string | null; jobs: Facts[] };
	const job = (jobName: string, status: string, conclusion: string | null = null) => ({
		id: jobName.length,
		name: jobName,
		status,
		conclusion,
	});
	const passed = (...names: string[]) => names.map((jobName) => job(jobName, "completed", "success"));

	/** The reads one readFacts pass makes, keyed the way useRecording stores them. */
	function book(world: {
		heads: Record<string, string>;
		ci?: Run[];
		release?: Run[];
		npm?: Facts | null;
		published?: boolean;
		distTags?: Facts;
	}) {
		const reads: Facts = { post: [] };
		const runs = (workflow: string, list: Run[] = []) => {
			reads[`api ${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&head_sha=${head}&per_page=20`] = {
				workflow_runs: list.map(({ jobs: _jobs, ...record }) => ({ ...record, head_sha: head, run_attempt: 1 })),
			};
			for (const { jobs, ...record } of list) {
				reads[`api ${repo}/actions/runs/${record.id}`] = { ...record, head_sha: head, run_attempt: 1 };
				reads[`api ${repo}/actions/runs/${record.id}/jobs?filter=latest&per_page=100`] = { jobs };
				reads[`api ${repo}/actions/runs/${record.id}/artifacts?per_page=100`] = {
					artifacts: ["candidate", "results", "results24"].map((prefix) => ({
						name: `${prefix}-${head}`,
						expired: false,
					})),
				};
			}
		};
		runs("ci.yml", world.ci);
		runs("release.yml", world.release);
		for (const branch of ["v071", "main", "rehearse/0.7.1-ab-cd"])
			reads[`ls-remote refs/heads/${branch}`] = world.heads[branch]
				? `${world.heads[branch]}\trefs/heads/${branch}\n`
				: "";
		reads[`npm ${name}@${version}`] = world.npm ?? null;
		reads[`api ${repo}/releases/tags/v${version}`] = world.published
			? { draft: false, tag_name: `v${version}` }
			: { $error: "HTTP 404" };
		reads[`ls-remote refs/tags/v${version} refs/tags/v${version}^{}`] = world.published
			? `${head}\trefs/tags/v${version}\n`
			: "";
		reads[`dist-tags ${name}`] = world.distTags ?? { latest: version };
		return reads;
	}

	it("walks every rehearse and release position and reuses the rehearsal's one ci.yml run", async () => {
		const next = await import(nextModule);
		const { nextStep } = await import(planModule);
		const scratch = mkdtempSync(join(tmpdir(), "clio-release-walk-"));
		try {
			const integrity = await ciArtifact(scratch);
			const file = join(scratch, "reads.json");
			const context = {
				state: join(scratch, "state"),
				candidate: join(scratch, "state/c-none"),
				channel: "latest",
				name,
				tag: `v${version}`,
				post: null,
			};
			const receipt: Facts = { version, commit: head, branch: "v071", nonce: "ab", events: [], ciRun: null };
			const at = async (mode: string, world: Parameters<typeof book>[0]) => {
				writeFileSync(file, JSON.stringify(book(world)));
				next.useRecording(file);
				return nextStep(await next.readFacts(mode, receipt, context), receipt).step;
			};
			const scratchBranch = { "rehearse/0.7.1-ab-cd": head };
			const ci = (status: string, jobs: Facts[], conclusion: string | null = null): Run => ({
				id: 77,
				status,
				conclusion,
				jobs,
			});
			const green = ci("completed", passed("prepare", "ci (22)", "ci (24)", "boot (macos-latest)"), "success");

			receipt.rehearsal = { branch: "rehearse/0.7.1-ab-cd", tornDown: false, runs: [] };
			strictEqual(await at("rehearse", { heads: scratchBranch }), "dispatch-ci");
			receipt.ciRun = { id: 77, attempt: 1 };
			(receipt.rehearsal as Facts).runs = [77];
			strictEqual(
				await at("rehearse", { heads: scratchBranch, ci: [ci("queued", [job("prepare", "queued")])] }),
				"watch-ci",
			);
			const foreign = ci("in_progress", [job("prepare", "in_progress")]);
			strictEqual(await at("rehearse", { heads: scratchBranch, ci: [{ ...foreign, id: 99 }, ci("queued", [])] }), "stop");
			strictEqual(await at("rehearse", { heads: scratchBranch, ci: [green] }), "check-release");
			Object.assign(receipt.rehearsal as Facts, { checked: { run: 78 } });
			strictEqual(await at("rehearse", { heads: scratchBranch, ci: [green] }), "draft-rehearsal");
			Object.assign(receipt.rehearsal as Facts, { drafted: true });
			strictEqual(await at("rehearse", { heads: scratchBranch, ci: [green] }), "publish-stub");
			Object.assign(receipt.rehearsal as Facts, { stubbed: true });
			strictEqual(await at("rehearse", { heads: scratchBranch, ci: [green] }), "teardown");
			Object.assign(receipt.rehearsal as Facts, { branch: null, tornDown: true });
			strictEqual(await at("rehearse", { heads: {}, ci: [green] }), "done");

			// The release pushes the version branch and reuses run 77; it never dispatches ci.yml again.
			const pushed = { v071: head };
			strictEqual(await at("release", { heads: pushed, ci: [green] }), "dispatch-release");
			receipt.ciRun = null;
			strictEqual(await at("release", { heads: pushed, ci: [green] }), "dispatch-release");
			deepStrictEqual(receipt.ciRun, { id: 77, attempt: 1 });

			receipt.releaseRun = { id: 88, attempt: 1 };
			const release = (status: string, jobs: Facts[], conclusion: string | null = null) => [
				{ id: 88, status, conclusion, jobs },
			];
			const awaiting = release("waiting", [...passed("preflight"), job("release", "waiting")]);
			strictEqual(
				await at("release", {
					heads: pushed,
					ci: [green],
					release: release("in_progress", [job("preflight", "in_progress")]),
				}),
				"watch-release",
			);
			strictEqual(await at("release", { heads: pushed, ci: [green], release: awaiting }), "publish-npm");
			receipt.npm = { accepted: true };
			strictEqual(await at("release", { heads: pushed, ci: [green], release: awaiting }), "approve-release");
			const npm = { name, version, dist: { integrity } };
			strictEqual(
				await at("release", {
					heads: pushed,
					ci: [green],
					release: awaiting,
					npm: { ...npm, dist: { integrity: "sha512-x" } },
				}),
				"stop",
			);
			const finished = release("completed", passed("preflight", "release"), "success");
			const out = { heads: { main: head }, ci: [green], release: finished, npm, published: true };
			strictEqual(await at("release", { ...out, distTags: { latest: version, beta: "0.7.1-beta.2" } }), "forward-tags");
			strictEqual(await at("release", out), "done");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
