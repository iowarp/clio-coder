/**
 * Pure release decisions. Every function here takes facts already read from git, npm and
 * GitHub and returns a decision, so the order of irreversible steps is testable without
 * touching any service.
 */
import { dirname, join, resolve } from "node:path";

/** The 107-character socket limit leaves room for at most this much TMPDIR. */
export const MAX_TMPDIR_LENGTH = 40;

/** Qualification and packing must never fill the shared 4 GB /tmp (item 11 of the 0.7.0 release). */
export function tmpdirProblem(directory) {
	const path = resolve(directory);
	if (path === "/tmp" || path.startsWith("/tmp/"))
		return `TMPDIR resolves to ${path}, the shared system /tmp. Export a short private directory first, such as TMPDIR=$HOME/.cache/cr.`;
	if (path.length > MAX_TMPDIR_LENGTH)
		return `TMPDIR ${path} is ${path.length} characters; sockets under it fail past 107. Use one of at most ${MAX_TMPDIR_LENGTH}.`;
	return null;
}

/**
 * Paths whose change cannot alter the qualified package bytes. A release may finish from a
 * version-branch head that only adds commits touching these, after npm already serves the
 * candidate (item 3): the tag, tarball and website still come from the candidate.
 */
const TOOLING = [
	/^scripts\/release[^/]*\.mjs$/u,
	/^scripts\/release\/[^/]+\.mjs$/u,
	/^\.github\/workflows\/release\.yml$/u,
	/^tests\/contracts\/release-[^/]+\.test\.ts$/u,
];
export const toolingOnly = (paths) =>
	paths.length > 0 && paths.every((path) => TOOLING.some((rule) => rule.test(path)));

/** The latest attempt of each named job. */
export function latestJob(jobs, name) {
	return [...jobs].filter((job) => job.name === name).sort((a, b) => b.id - a.id)[0] ?? null;
}

/**
 * One explicit state per run (item 10): queued, pending (requested or pending), waiting
 * (an environment approval), in_progress, or a completed outcome.
 */
export function runState(run, jobs = []) {
	if (!run) return "absent";
	if (run.status === "completed")
		return run.conclusion === "success" ? "success" : run.conclusion === "cancelled" ? "cancelled" : "failure";
	if (run.status === "waiting" || jobs.some((job) => job.status === "waiting")) return "waiting";
	if (run.status === "queued") return "queued";
	if (run.status === "requested" || run.status === "pending") return "pending";
	return "in_progress";
}

export const QUALIFICATION_JOBS = ["prepare", "ci (22)", "ci (24)"];

/** A rerun reuses the run ID; only a higher attempt number shows that the rerun started. */
export const rerunStarted = (before, run) => Number(run?.run_attempt ?? 0) > Number(before);

/**
 * Draft handling (item 5). A draft keeps the target it was created with, and publishing it
 * creates the immutable tag there, so the target is pinned before any publish.
 */
export function draftAction({ release, tagCommit }, commit) {
	if (tagCommit !== null && tagCommit !== commit)
		return { action: "stop", reason: "the tag already points to another commit" };
	if (release && !release.draft)
		return tagCommit === commit
			? { action: "verify" }
			: { action: "stop", reason: "a published release has no tag at the candidate" };
	if (!release) return { action: "create" };
	if (release.target_commitish !== commit) return { action: "retarget" };
	return { action: "publish" };
}

/** The version branch a version releases from: `0.7.1` and `0.7.1-rc.0` -> `v071`. */
export function versionBranch(version) {
	const [major, minor, patch] = version.split("-")[0].split(".");
	return `v${major}${minor}${patch}`;
}

/** Where release:next keeps the ci.yml run's `candidate-<sha>` artifact. */
export const ciCandidateDirectory = (state, ciRun) => join(state, `ci-${ciRun.id}`);

/**
 * The npm publish argv, only for the CI run's own artifact. release.yml verifies npm against that
 * artifact, and every build has a fresh buildId, so publishing a local pack would burn the version.
 */
export function publishArgs(candidate, { state, ciRun, channel }) {
	const directory = ciCandidateDirectory(state, ciRun);
	if (String(candidate.run) !== String(ciRun.id))
		throw new Error(`The candidate was not produced by ci.yml run ${ciRun.id}; publish only its artifact.`);
	if (resolve(dirname(candidate.tarball)) !== resolve(directory))
		throw new Error(`Publish only the CI artifact in ${directory}, not ${candidate.tarball}.`);
	return ["publish", candidate.tarball, "--access", "public", "--tag", channel];
}

/**
 * The release counts as published only when its run succeeded or real state shows every finishing
 * step. publish() un-drafts before main, website and branch cleanup, so a public release alone is
 * not enough: a later failure must still offer the rerun.
 */
export function publicProven({
	runSucceeded,
	release,
	tagCommit,
	commit,
	latest,
	mainHead,
	finishingHeads,
	branchHead,
}) {
	if (runSucceeded) return true;
	if (!release || release.draft || tagCommit !== commit) return false;
	if (!latest) return true;
	return finishingHeads.includes(mainHead) && branchHead === null;
}

/**
 * Post-release items that failed in the last pass, as `id: note` lines. A failed item stays
 * pending, so the command stops after one pass instead of retrying it forever.
 */
export const postFailures = (results) =>
	Object.entries(results ?? {})
		.filter(([, result]) => result?.status === "failed")
		.map(([id, result]) => `${id}: ${result.note}`);

/**
 * The release before this one, for the post-release issue scan. Described from the candidate's
 * parent with the new tag excluded: after a fetch, origin/main already carries the new tag.
 */
export const previousTag = (git, tag, commit) =>
	git("describe", "--tags", "--abbrev=0", "--match", "v*", "--exclude", tag, `${commit}^`);

/** npm refuses a second publish of an existing version with this message; same bytes mean accepted. */
export const alreadyPublished = (stderr) =>
	/cannot publish over the previously published versions/u.test(String(stderr));

/**
 * The next step from real state. Facts:
 *   mode: "release" | "rehearse"
 *   tree: { clean, branch, versionsAgree, mainAncestor, readiness: string[] }
 *   local: { wanted, node22, node24 }   --local asked for local runs; both Node majors passed for this commit
 *   pushed: boolean                     target branch head on origin is the candidate
 *   ci: { state, jobs, artifacts } | null
 *   releaseRun: { state, jobs } | null  release.yml run for this candidate
 *   npm: { served, integrityMatches }
 *   published: boolean                  verifyPublic passed
 *   tagsBehind: string[]
 *   postPending: string[]
 *   foreignRuns: number[]               in-flight runs on this commit that the receipt does not own
 * Receipt: { npm: { accepted } | null, rehearsal: { checked, drafted, stubbed, tornDown } | null }
 */
export function nextStep(facts, receipt) {
	const stop = (reason) => ({ step: "stop", reason });
	// A rehearsal ends with its branch deleted, so a finished one is read from the receipt alone. A
	// failed or interrupted one was torn down too, but resumes on a new scratch branch.
	const rehearsal = receipt.rehearsal;
	if (facts.mode === "rehearse" && rehearsal?.checked && rehearsal.drafted && rehearsal.stubbed && rehearsal.tornDown)
		return { step: "done" };
	if (facts.foreignRuns.length)
		return stop(
			`run ${facts.foreignRuns.join(", ")} on this commit belongs to another operator; let it finish or cancel it there`,
		);
	if (facts.mode === "release" && facts.npm.served && facts.npm.integrityMatches === false)
		return stop("npm already holds different bytes for this version; published versions are immutable");
	if (facts.mode === "release" && facts.published) {
		if (facts.tagsBehind.length) return { step: "forward-tags", tags: facts.tagsBehind };
		if (facts.postPending.length) return { step: "post", items: facts.postPending };
		return { step: "done" };
	}
	if (!facts.pushed) {
		const tree = facts.tree;
		if (!tree.clean) return stop("commit the candidate first; the tree must be clean");
		// A rehearsal pushes only a scratch branch, so it may start from any local branch.
		if (facts.mode !== "rehearse" && !/^v\d{3}$/u.test(tree.branch))
			return stop("start from the version branch, such as v071");
		if (!tree.versionsAgree) return stop("package.json, the GUI manifest and the ACP registry versions must agree");
		if (!tree.mainAncestor) return stop("origin/main is not an ancestor of the candidate");
		if (tree.readiness.length) return stop(`release readiness failed:\n${tree.readiness.join("\n")}`);
		// CI is the qualifier; local Node 22 and 24 runs are opt-in (--local) and skipped for a green CI run.
		if (facts.local.wanted && facts.ci?.state !== "success" && (!facts.local.node24 || !facts.local.node22))
			return { step: "qualify", missing: ["22", "24"].filter((major) => !facts.local[`node${major}`]) };
		return { step: "push" };
	}
	const ci = facts.ci;
	if (!ci || ci.state === "absent") return { step: "dispatch-ci" };
	if (["queued", "pending", "waiting", "in_progress"].includes(ci.state)) return { step: "watch-ci" };
	if (ci.state !== "success") return { step: "rerun-ci" };
	const failedGate = QUALIFICATION_JOBS.find((name) => latestJob(ci.jobs, name)?.conclusion !== "success");
	if (failedGate) return stop(`qualification gate did not pass: ${failedGate}`);
	if (!ci.artifacts)
		return stop("qualification artifacts expired; qualify a new candidate commit, never rebuild this one");
	if (facts.mode === "rehearse") {
		if (!receipt.rehearsal?.checked) return { step: "check-release" };
		if (!receipt.rehearsal?.drafted) return { step: "draft-rehearsal" };
		if (!receipt.rehearsal?.stubbed) return { step: "publish-stub" };
		return { step: "teardown" };
	}
	const accepted = facts.npm.served || receipt.npm?.accepted === true;
	const run = facts.releaseRun;
	const preflight = run ? latestJob(run.jobs, "preflight") : null;
	const release = run ? latestJob(run.jobs, "release") : null;
	if (!accepted) {
		// The finishing path is proven against real state before the irreversible publish (item 3).
		if (!run || run.state === "absent") return { step: "dispatch-release" };
		if (preflight?.status !== "completed") return { step: "watch-release" };
		if (preflight.conclusion !== "success")
			return stop(
				"the release preflight failed before npm publish; nothing irreversible happened, so fix it in a new candidate",
			);
		// An owner may approve before publishing; the approved job then waits for npm, so the
		// publish is still offered while the release job is anywhere short of completed.
		if (["waiting", "queued", "pending", "in_progress"].includes(release?.status)) return { step: "publish-npm" };
		if (["queued", "pending", "in_progress"].includes(run.state)) return { step: "watch-release" };
		return { step: "rerun-release" };
	}
	// The release job waits for npm itself, so the owner may approve while npm propagates.
	if (run?.state === "waiting") return { step: "approve-release" };
	if (["queued", "pending", "in_progress"].includes(run?.state)) return { step: "watch-release" };
	if (!facts.npm.served) return { step: "wait-npm" };
	if (!run || run.state === "absent") return { step: "dispatch-release" };
	if (run.state !== "success") return { step: "rerun-release" };
	return stop("the release run passed but the public state does not verify; inspect it before any retry");
}
