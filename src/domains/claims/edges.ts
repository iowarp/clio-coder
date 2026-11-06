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
 * The conditions a verdict was pinned under, by the name an operator reads, or null when nothing pins it.
 *
 * The rule for edges follows from what is pinned. Claims of one check with equal pins and opposite verdicts contradict
 * each other; claims whose pins differ in any field (commit, command, reference, inputs, tolerance, and for reproduce
 * the seed, environment and platform) are a supersede. Two things are deliberately not pinned:
 * - The judged output (`actual`, run payloads): it is what changed when a verdict flips.
 * - A numeric-compare check's working-tree state. It runs in the working tree, so an uncommitted edit at the same
 *   commit is what a regression looks like: a check that agreed on a clean tree and disagrees with uncommitted changes
 *   is a contradiction, and every sentence about it names that difference (`contradictionConditions`).
 * A reproduce check runs the committed tree or a copy of its pinned inputs, so the working tree never reaches it. The
 * kernel release and Clio's version are left out of its platform because they change without changing what ran. A
 * claim with no recorded commit has no pinned conditions, so it can be replaced but never contradicted.
 */
function pinnedConditions(claim: ClaimRecord): Record<string, unknown> | null {
	const conditions = claim.conditions;
	if (conditions.commit === null) return null;
	if (conditions.kind === "numeric-compare")
		return {
			commit: conditions.commit,
			command: conditions.argv,
			reference: conditions.reference?.sha256 ?? null,
			tolerance: { bounds: conditions.tolerance, combine: conditions.combine, nonFinite: conditions.nonFinite },
		};
	return {
		commit: conditions.commit,
		command: { argv: conditions.argv, cwd: conditions.cwd },
		reference: conditions.reference?.sha256 ?? null,
		inputs: conditions.inputs.map((input) => `${input.path}\0${input.sha256}`).sort(),
		tolerance: conditions.tolerance,
		comparison: conditions.compare,
		seed: conditions.seed,
		environment: conditions.environment,
		platform: {
			os: conditions.platform.os,
			arch: conditions.platform.arch,
			nodeVersion: conditions.platform.nodeVersion,
			interpreter: conditions.platform.interpreter ?? null,
			pythonVersion: conditions.platform.pythonVersion ?? null,
		},
	};
}

/** The digest of a claim's pinned conditions; equal keys mean opposite verdicts contradict. Null when unpinned. */
export function claimConditionsKey(claim: ClaimRecord): string | null {
	const pins = pinnedConditions(claim);
	return pins === null ? null : sha256(canonicalClaimJson({ kind: claim.kind, check: claim.keys.check, pins }));
}

function short(value: string): string {
	return value.slice(0, 12);
}

/** A numeric-compare claim's working-tree state as its channel recorded it. */
function treeState(claim: ClaimRecord): string | null {
	const conditions = claim.conditions;
	if (conditions.kind !== "numeric-compare") return null;
	if (conditions.treeFingerprint !== undefined) return `working tree ${short(conditions.treeFingerprint)}`;
	if (conditions.trackedTreeClean === true) return "a clean tree";
	if (conditions.trackedTreeClean === false) return "uncommitted changes to tracked files";
	return "an unrecorded working-tree state";
}

/**
 * What two claims under the same pinned conditions shared, and the one difference the pins leave open: the working
 * tree of a numeric-compare check. Never says "the same conditions" when the trees differed.
 */
export function contradictionConditions(later: ClaimRecord, earlier: ClaimRecord): string {
	const pins = pinnedConditions(later);
	const commit = later.conditions.commit === null ? "no recorded commit" : `commit ${short(later.conditions.commit)}`;
	const shared = Object.keys(pins ?? {}).filter((name) => name !== "commit");
	const head = `at the same ${commit} with the same ${shared.join(", ").replace(/, ([^,]*)$/u, " and $1")}`;
	const laterTree = treeState(later);
	const earlierTree = treeState(earlier);
	if (laterTree === null || earlierTree === null) return head;
	if (laterTree === earlierTree) {
		if (laterTree === "uncommitted changes to tracked files")
			return `${head}; both ran with uncommitted changes to tracked files, which may differ`;
		if (laterTree === "an unrecorded working-tree state") return `${head}; neither recorded its working-tree state`;
		return `${head}, both on ${laterTree}`;
	}
	const preposition = (state: string) => (state.startsWith("uncommitted") ? "with" : "on");
	return `${head}; claim ${short(later.id)} ran ${preposition(laterTree)} ${laterTree} where claim ${short(earlier.id)} ran ${preposition(earlierTree)} ${earlierTree}`;
}

/** Which pinned conditions changed between two claims of one check, from their typed fields. */
export function supersedeConditions(later: ClaimRecord, earlier: ClaimRecord): string {
	const laterPins = pinnedConditions(later);
	const earlierPins = pinnedConditions(earlier);
	if (earlierPins === null) return `claim ${short(earlier.id)} recorded no commit, so it pinned no conditions`;
	if (laterPins === null) return `claim ${short(later.id)} recorded no commit, so it pinned no conditions`;
	const changed = Object.keys(laterPins)
		.filter((name) => canonicalClaimJson(laterPins[name]) !== canonicalClaimJson(earlierPins[name]))
		.map((name) => {
			const from = earlierPins[name];
			const to = laterPins[name];
			return typeof from === "string" && typeof to === "string" ? `${name} ${short(from)} -> ${short(to)}` : name;
		});
	return `changed ${changed.join(", ")}`;
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
 * - `contradicts` the latest earlier claim with equal pinned conditions (`pinnedConditions`) when its verdict differs. Only a flip adds one,
 *   so a run of agreeing claims followed by a disagreeing one adds one edge, not one per agreement.
 * - `supersedes` every earlier claim of the same check and kind whose pinned conditions differ, unless already superseded.
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
 * with equal pinned conditions that nothing superseded. Empty when the later claim agrees, since a disagreement turning
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

/** The regression text a backed memory record carries; it cites both claims in full and says what matched. */
export function claimRegressionNote(later: ClaimRecord, backing: ClaimRecord): string {
	return `check '${later.keys.check}': claim ${later.id} disagrees with claim ${backing.id}, which agreed within the declared tolerance, ${contradictionConditions(later, backing)} (${later.at})`;
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
