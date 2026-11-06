import { createHash } from "node:crypto";
import { canonicalClaimJson } from "./capture.js";
import {
	CLAIM_RECORD_VERSION,
	type ClaimEdgeRecordV1,
	type ClaimRecord,
	type ClaimRegressionRecordV1,
	type ClaimStatus,
} from "./types.js";

/**
 * Deterministic edges between claims of one check (#406). No text is compared: two claims relate only through the
 * check id and the conditions Clio recorded when it ran the check.
 */

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The digest of the conditions a verdict was pinned under, or null when nothing pins it. Two claims with the same key
 * judged the same check, declaration, reference, inputs and commit, so opposite verdicts contradict each other.
 *
 * The judged output (`actual`, run payloads) is not a condition: it is what changed when a verdict flips. A
 * numeric-compare check runs in the working tree, so an uncommitted edit at the same HEAD keeps the key, and a check
 * that agreed and now disagrees there is a regression. A reproduce check runs the committed tree, so its key adds the
 * pinned inputs, seed, environment and the platform facts that decide the computation; the kernel release and Clio's
 * version are left out because they change without changing what ran. A claim with no recorded commit has no pinned
 * conditions, so it can be replaced but never contradicted.
 */
export function claimConditionsKey(claim: ClaimRecord): string | null {
	const conditions = claim.conditions;
	if (conditions.commit === null) return null;
	const pins =
		conditions.kind === "numeric-compare"
			? {
					argv: conditions.argv,
					tolerance: conditions.tolerance,
					combine: conditions.combine,
					nonFinite: conditions.nonFinite,
					reference: conditions.reference?.sha256 ?? null,
					commit: conditions.commit,
				}
			: {
					argv: conditions.argv,
					cwd: conditions.cwd,
					environment: conditions.environment,
					compare: conditions.compare,
					tolerance: conditions.tolerance,
					reference: conditions.reference?.sha256 ?? null,
					inputs: conditions.inputs.map((input) => `${input.path}\0${input.sha256}`).sort(),
					seed: conditions.seed,
					commit: conditions.commit,
					platform: {
						os: conditions.platform.os,
						arch: conditions.platform.arch,
						nodeVersion: conditions.platform.nodeVersion,
						interpreter: conditions.platform.interpreter ?? null,
						pythonVersion: conditions.platform.pythonVersion ?? null,
					},
				};
	return sha256(canonicalClaimJson({ kind: claim.kind, check: claim.keys.check, pins }));
}

export function claimLogRecordId(record: object): string {
	const { id: _id, ...rest } = record as { id?: string };
	return sha256(canonicalClaimJson(rest));
}

function edge(kind: ClaimEdgeRecordV1["kind"], from: ClaimRecord, to: ClaimRecord): ClaimEdgeRecordV1 {
	const body: Omit<ClaimEdgeRecordV1, "id"> = {
		v: CLAIM_RECORD_VERSION,
		type: "edge",
		at: from.at,
		project: from.project,
		kind,
		from: from.id,
		to: to.id,
		check: from.keys.check,
	};
	return { ...body, id: claimLogRecordId(body) };
}

/**
 * The edges each incoming claim adds against the log, in order; an incoming claim also counts as history for the
 * ones after it.
 *
 * - `contradicts` the latest earlier claim under the same conditions when its verdict differs. Only a flip adds one,
 *   so a run of agreeing claims followed by a disagreeing one adds one edge, not one per agreement.
 * - `supersedes` every earlier claim of the same check and kind under other conditions that nothing superseded yet.
 *   Each claim is superseded at most once, so these edges never outnumber claims.
 */
export function deriveClaimEdges(
	history: { claims: ReadonlyArray<ClaimRecord>; edges: ReadonlyArray<ClaimEdgeRecordV1> },
	incoming: ReadonlyArray<ClaimRecord>,
): ClaimEdgeRecordV1[] {
	const claims = [...history.claims];
	const known = new Set(claims.map((claim) => claim.id));
	const superseded = new Set(history.edges.filter((item) => item.kind === "supersedes").map((item) => item.to));
	const added: ClaimEdgeRecordV1[] = [];
	for (const claim of incoming) {
		if (known.has(claim.id)) continue;
		const key = claimConditionsKey(claim);
		const sameCheck = claims.filter((earlier) => earlier.kind === claim.kind && earlier.keys.check === claim.keys.check);
		const sameConditions = key === null ? [] : sameCheck.filter((earlier) => claimConditionsKey(earlier) === key);
		const latest = sameConditions.at(-1);
		if (latest !== undefined && latest.verdict !== claim.verdict) added.push(edge("contradicts", claim, latest));
		for (const earlier of sameCheck) {
			if (superseded.has(earlier.id) || (key !== null && claimConditionsKey(earlier) === key)) continue;
			added.push(edge("supersedes", claim, earlier));
			superseded.add(earlier.id);
		}
		claims.push(claim);
		known.add(claim.id);
	}
	return added;
}

/** Status of every claim from the log's edges. */
export function claimStatuses(
	claims: ReadonlyArray<ClaimRecord>,
	edges: ReadonlyArray<ClaimEdgeRecordV1>,
): Map<string, ClaimStatus> {
	const superseded = new Set(edges.filter((item) => item.kind === "supersedes").map((item) => item.to));
	const contested = new Set(edges.filter((item) => item.kind === "contradicts").flatMap((item) => [item.from, item.to]));
	return new Map(
		claims.map((claim) => [
			claim.id,
			superseded.has(claim.id) ? "superseded" : contested.has(claim.id) ? "contested" : "standing",
		]),
	);
}

/**
 * The agreeing claims a `contradicts` edge overturns, when the later claim disagrees: every earlier agreeing claim
 * under the same conditions that nothing superseded. Empty when the later claim agrees, since a disagreement turning
 * into agreement withdraws nothing a memory relied on.
 */
export function overturnedAgreements(
	contradiction: ClaimEdgeRecordV1,
	claims: ReadonlyArray<ClaimRecord>,
	edges: ReadonlyArray<ClaimEdgeRecordV1>,
): ClaimRecord[] {
	const byId = new Map(claims.map((claim) => [claim.id, claim]));
	const later = byId.get(contradiction.from);
	const earlier = byId.get(contradiction.to);
	if (contradiction.kind !== "contradicts" || later === undefined || earlier === undefined) return [];
	if (later.verdict !== "disagrees" || earlier.verdict !== "agrees") return [];
	const key = claimConditionsKey(later);
	const superseded = new Set(edges.filter((item) => item.kind === "supersedes").map((item) => item.to));
	const laterIndex = claims.indexOf(later);
	return claims
		.slice(0, laterIndex < 0 ? claims.length : laterIndex)
		.filter(
			(claim) =>
				claim.verdict === "agrees" &&
				claim.kind === later.kind &&
				claim.keys.check === later.keys.check &&
				!superseded.has(claim.id) &&
				claimConditionsKey(claim) === key,
		);
}

/**
 * The evidence refs a memory record cites when it rests on a claim: `claim:<id>`, and for a host-verified claim the
 * run id whose sealed verification produced it, which is what a record proposed from that run's evidence cites.
 */
export function claimBackingRefs(claim: ClaimRecord): string[] {
	return [`claim:${claim.id}`, ...(claim.source.channel === "host-verification" ? [claim.source.runId] : [])];
}

/** The regression text a backed memory record carries; it cites both claims in full. */
export function claimRegressionNote(later: ClaimRecord, backing: ClaimRecord): string {
	const commit =
		later.conditions.commit === null ? "no recorded commit" : `commit ${later.conditions.commit.slice(0, 12)}`;
	return `claim ${later.id} disagrees, under the same conditions (${commit}), with claim ${backing.id} of check '${later.keys.check}' that agreed within the declared tolerance (${later.at})`;
}

export function regressionRecord(input: {
	edge: ClaimEdgeRecordV1;
	backing: ReadonlyArray<ClaimRecord>;
	memory: ReadonlyArray<string>;
	at: string;
}): ClaimRegressionRecordV1 {
	const body: Omit<ClaimRegressionRecordV1, "id"> = {
		v: CLAIM_RECORD_VERSION,
		type: "regression",
		at: input.at,
		project: input.edge.project,
		edge: input.edge.id,
		from: input.edge.from,
		backing: input.backing.map((claim) => claim.id),
		memory: [...input.memory],
	};
	return { ...body, id: claimLogRecordId(body) };
}
