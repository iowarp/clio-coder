/**
 * Pure Git commit-message attribution.
 *
 * Callers supply sealed facts, never model prose. This module only translates
 * those facts into role trailers and has no filesystem, process, Git, or
 * settings dependencies, so every controlled commit seam shares one policy.
 */

export const CLIO_COMMIT_IDENTITY = "Clio Coder <clio-coder@iowarp.ai>";

export const CLIO_COMMIT_TRAILERS = {
	assisted: `Assisted-by: ${CLIO_COMMIT_IDENTITY}`,
	tested: `Tested-by: ${CLIO_COMMIT_IDENTITY}`,
	reviewed: `Reviewed-by: ${CLIO_COMMIT_IDENTITY}`,
	coAuthored: `Co-authored-by: ${CLIO_COMMIT_IDENTITY}`,
} as const;

export const CLIO_DECISION_TRAILER_KEY = "Clio-Decision";

/** Most `Clio-Decision:` trailers one commit carries; matches the receipt cap. */
export const CLIO_DECISION_TRAILER_CAP = 32;

/**
 * A decision ref is `<interviewId>/<key>`: an `ask_user` interview id or an
 * `agent:<uuid>` decision-set id, then a kebab-case key. Only refs of this
 * shape become trailers, so a malformed value can never inject a second
 * trailer line or a stray control character into a commit message.
 */
export const DECISION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface CommitReceiptEvidence {
	version: 20;
	algorithm: "sha256";
	digest: string;
	/** The receipt was checked against its run-ledger envelope. */
	integrityValid: boolean;
	/** The receipt describes work or a verdict directly relevant to this commit. */
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
	/** Optional sealed receipt for a directly relevant fact above. */
	receipt?: CommitReceiptEvidence;
	/**
	 * Decision refs (`<interviewId>/<key>`) the committed work was done under,
	 * read from the session decision board or a sealed receipt's
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

function isClioTrailer(key: string): boolean {
	return (
		KNOWN_CLIO_TRAILERS.has(key) ||
		key.startsWith("clio-evidence:receipt-v20/sha256:") ||
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

function receiptTrailer(receipt: CommitReceiptEvidence | undefined): string | null {
	if (
		receipt?.version !== 20 ||
		receipt.algorithm !== "sha256" ||
		receipt.integrityValid !== true ||
		receipt.directlyRelevant !== true ||
		!SHA256.test(receipt.digest)
	) {
		return null;
	}
	return `Clio-Evidence: receipt-v20/sha256:${receipt.digest}`;
}

/**
 * Append only evidence-justified Clio trailers.
 *
 * Disabled attribution is the one byte-preserving path. When enabled, CRLF and
 * lone CR are normalized to LF, the message ends with one newline, existing
 * subject/body and human trailers remain in order, repeated Clio trailers are
 * removed case-insensitively, and processing the result again is idempotent.
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
	const receipt = receiptTrailer(evidence.receipt);
	if (receipt !== null) desired.push(receipt);
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
