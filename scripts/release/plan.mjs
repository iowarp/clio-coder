/**
 * Pure release decisions. Every function here takes facts already read from git, npm and
 * GitHub and returns a decision, so the order of irreversible steps is testable without
 * touching any service.
 */
import { resolve } from "node:path";

/** GitHub refuses a release body longer than this many characters. */
export const RELEASE_BODY_LIMIT = 125_000;

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

/** A version branch: `v` and three or more digits (`v071`, and `v0710` for 0.7.10). */
export const isVersionBranch = (branch) => /^v\d{3,}$/u.test(String(branch));
