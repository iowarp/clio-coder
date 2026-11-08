/**
 * Pure Git commit-message attribution.
 *
 * Callers supply sealed facts, never model prose. This module only translates
 * those facts into role trailers and has no filesystem, process, Git, or
 * settings dependencies, so every controlled commit seam shares one policy.
 */

/**
 * Slug of the IOWarp-owned GitHub App `Clio-Coder-Agent`, whose bot account
 * is Clio's commit identity. `clio-coder` is an unrelated user's login.
 */
const CLIO_GITHUB_APP_SLUG = "clio-coder-agent";

/**
 * Account id of the App's bot user, read with
 * `gh api users/<slug>%5Bbot%5D --jq .id`; it is not the App id. GitHub links a
 * trailer to an account only by email, and a bot account answers to
 * `<id>+<slug>[bot]@users.noreply.github.com`. Changing it changes the managed
 * hook script, so bump `MANAGED_HOOK_VERSION`
 * (`src/core/git-commit-attribution.ts`) in the same commit.
 */
const CLIO_GITHUB_BOT_USER_ID: number | null = 353922063;

const IOWARP_COMMIT_EMAIL = "clio-coder@iowarp.ai";

function githubBotNoreplyEmail(userId: number | null, slug: string): string | null {
	if (userId === null || !Number.isSafeInteger(userId) || userId <= 0) return null;
	return `${userId}+${slug}[bot]@users.noreply.github.com`;
}

/** The one email every Clio commit trailer names. */
const CLIO_COMMIT_EMAIL = githubBotNoreplyEmail(CLIO_GITHUB_BOT_USER_ID, CLIO_GITHUB_APP_SLUG) ?? IOWARP_COMMIT_EMAIL;

export const CLIO_COMMIT_IDENTITY = `Clio Coder <${CLIO_COMMIT_EMAIL}>`;

function roleTrailers(identity: string) {
	return {
		assisted: `Assisted-by: ${identity}`,
		tested: `Tested-by: ${identity}`,
		reviewed: `Reviewed-by: ${identity}`,
		coAuthored: `Co-authored-by: ${identity}`,
	} as const;
}

export const CLIO_COMMIT_TRAILERS = roleTrailers(CLIO_COMMIT_IDENTITY);

export const CLIO_DECISION_TRAILER_KEY = "Clio-Decision";

/** Most `Clio-Decision:` trailers one commit carries; matches the run's decision-ref cap. */
export const CLIO_DECISION_TRAILER_CAP = 32;

/**
 * A decision ref is `<interviewId>/<key>`: an `ask_user` interview id or an
 * `agent:<uuid>` decision-set id, then the decision key. Operator keys are
 * snake_case and agent keys are kebab-case, the same shape `isDecisionRecord`
 * admits. Only refs of this shape become trailers, so a malformed value can
 * never inject a second trailer line or a stray control character into a
 * commit message.
 */
export const DECISION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}\/[a-z0-9]+(?:[_-][a-z0-9]+)*$/u;

/** A finished run's identity, the digest of its run.settled, for a commit the run directly accounts for (#434). */
export interface CommitRunEvidence {
	version: 1;
	algorithm: "sha256";
	digest: string;
	/** The run was held by its producer or read back under a seal that verified. */
	integrityValid: boolean;
	/** The run did work or gave a verdict directly relevant to this commit. */
	directlyRelevant: boolean;
}

/** Trusted facts about the work recorded by one commit. */
export interface CommitAttributionEvidence {
	/** Clio materially created or edited work recorded by this commit. */
	materiallyAssisted?: boolean;
	/** A real validation command completed successfully against the committed work. */
	validationSucceeded?: boolean;
	/** An independent verifier or reviewer produced a passing result. */
	independentReviewPassed?: boolean;
	/** Clio materially authored part of the committed change. */
	materiallyAuthored?: boolean;
	/** Optional settled run for a directly relevant fact above. */
	run?: CommitRunEvidence;
	/**
	 * Decision refs (`<interviewId>/<key>`) the committed work was done under,
	 * read from the session decision board or a dispatched run's
	 * `decisionRefs`. Each becomes one `Clio-Decision:` trailer.
	 */
	decisions?: ReadonlyArray<string>;
}

const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]+(.+)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function normalizedTrailer(line: string): string | null {
	const match = TRAILER_LINE.exec(line);
	if (match === null) return null;
	return `${match[1]?.toLowerCase()}:${match[2]
		?.trim()
		.replace(/[ \t]+/gu, " ")
		.toLowerCase()}`;
}

const KNOWN_CLIO_TRAILERS = new Set(
	Object.values(CLIO_COMMIT_TRAILERS)
		.map((line) => normalizedTrailer(line))
		.filter((line): line is string => line !== null),
);

/**
 * A role trailer naming clio-coder@iowarp.ai, keyed by its normalized form,
 * mapped to the same role under the bot identity. Empty while no bot id is set.
 */
const IOWARP_ROLE_TRAILER_UPGRADES: ReadonlyMap<string, string> = (() => {
	const legacy = roleTrailers(`Clio Coder <${IOWARP_COMMIT_EMAIL}>`);
	const upgrades = new Map<string, string>();
	for (const role of Object.keys(legacy) as Array<keyof typeof legacy>) {
		const key = normalizedTrailer(legacy[role]);
		if (key !== null && !KNOWN_CLIO_TRAILERS.has(key)) upgrades.set(key, CLIO_COMMIT_TRAILERS[role]);
	}
	return upgrades;
})();

function isClioTrailer(key: string): boolean {
	return (
		KNOWN_CLIO_TRAILERS.has(key) ||
		// Earlier seals stay recognized so an amended message never keeps a stale managed trailer (#434).
		/^clio-evidence:run-v\d+\/sha256:/u.test(key) ||
		key.startsWith(`${CLIO_DECISION_TRAILER_KEY.toLowerCase()}:`)
	);
}

/** Well-formed decision refs from the evidence, deduplicated, sorted, and capped. */
export function decisionTrailerRefs(decisions: ReadonlyArray<string> | undefined): string[] {
	if (decisions === undefined) return [];
	const refs = new Set<string>();
	for (const ref of decisions) {
		if (typeof ref === "string" && DECISION_REF_PATTERN.test(ref)) refs.add(ref);
	}
	return [...refs].sort().slice(0, CLIO_DECISION_TRAILER_CAP);
}

function decisionTrailer(ref: string): string {
	return `${CLIO_DECISION_TRAILER_KEY}: ${ref}`;
}

/**
 * Return the first line of a conventional trailing trailer paragraph.
 * Human continuation lines are recognized as part of the block but never
 * interpreted or rewritten; Clio's own trailers are always one line.
 */
function trailerBlockStart(lines: ReadonlyArray<string>): number | null {
	if (lines.length < 2) return null;
	const separator = lines.lastIndexOf("");
	const first = separator + 1;
	// A trailer paragraph is separated from subject/body by a blank line. This
	// keeps a subject such as "Fix: parser" a subject rather than metadata.
	if (separator < 0 || first >= lines.length) return null;
	let sawTrailer = false;
	for (const line of lines.slice(first)) {
		if (TRAILER_LINE.test(line)) {
			sawTrailer = true;
			continue;
		}
		if (sawTrailer && /^[ \t]+/u.test(line)) continue;
		return null;
	}
	return sawTrailer ? first : null;
}

function runTrailer(run: CommitRunEvidence | undefined): string | null {
	if (
		run?.version !== 1 ||
		run.algorithm !== "sha256" ||
		run.integrityValid !== true ||
		run.directlyRelevant !== true ||
		!SHA256.test(run.digest)
	) {
		return null;
	}
	return `Clio-Evidence: run-v${run.version}/sha256:${run.digest}`;
}

/**
 * Append only evidence-justified Clio trailers.
 *
 * Disabled attribution is the one byte-preserving path. When enabled, CRLF and
 * lone CR are normalized to LF, the message ends with one newline, existing
 * subject/body and human trailers remain in order, a role trailer naming the
 * clio-coder@iowarp.ai address is rewritten to the bot identity, repeated Clio
 * trailers are removed case-insensitively, and processing the result again is
 * idempotent.
 */
export function attributeCommitMessage(
	originalMessage: string,
	evidence: Readonly<CommitAttributionEvidence>,
	enabled = true,
): string {
	if (!enabled) return originalMessage;

	const normalized = originalMessage.replace(/\r\n?/gu, "\n");
	const lines = normalized.replace(/\n+$/u, "").split("\n");
	const blockStart = trailerBlockStart(lines);
	// Once the bot identity is set, a clio-coder@iowarp.ai role trailer is the
	// same Clio claim: rewrite it so the commit names one Clio account.
	if (blockStart !== null) {
		for (let index = blockStart; index < lines.length; index += 1) {
			const upgraded = IOWARP_ROLE_TRAILER_UPGRADES.get(normalizedTrailer(lines[index] ?? "") ?? "");
			if (upgraded !== undefined) lines[index] = upgraded;
		}
	}
	const seenClio = new Set<string>();
	const retained = lines.filter((line, index) => {
		if (blockStart === null || index < blockStart) return true;
		const key = normalizedTrailer(line);
		if (key === null || !isClioTrailer(key)) return true;
		if (seenClio.has(key)) return false;
		seenClio.add(key);
		return true;
	});

	const desired: string[] = [];
	// Material authorship necessarily means material assistance too. Keeping the
	// two facts separate lets Co-authored-by remain a platform compatibility
	// marker rather than a substitute for the semantic role trailer.
	if (evidence.materiallyAssisted === true || evidence.materiallyAuthored === true) {
		desired.push(CLIO_COMMIT_TRAILERS.assisted);
	}
	if (evidence.validationSucceeded === true) desired.push(CLIO_COMMIT_TRAILERS.tested);
	if (evidence.independentReviewPassed === true) desired.push(CLIO_COMMIT_TRAILERS.reviewed);
	if (evidence.materiallyAuthored === true) desired.push(CLIO_COMMIT_TRAILERS.coAuthored);
	const runEvidence = runTrailer(evidence.run);
	if (runEvidence !== null) desired.push(runEvidence);
	for (const ref of decisionTrailerRefs(evidence.decisions)) desired.push(decisionTrailer(ref));

	const existing = new Set(
		(blockStart === null ? [] : retained.slice(blockStart))
			.map((line) => normalizedTrailer(line))
			.filter((line): line is string => line !== null),
	);
	const additions = desired.filter((line) => !existing.has(normalizedTrailer(line) ?? ""));
	if (additions.length === 0) return `${retained.join("\n")}\n`;

	if (blockStart === null) {
		while (retained.at(-1) === "") retained.pop();
		retained.push("", ...additions);
	} else {
		retained.push(...additions);
	}
	return `${retained.join("\n")}\n`;
}
