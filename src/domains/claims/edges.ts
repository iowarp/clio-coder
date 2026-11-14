import { createHash } from "node:crypto";
import { posix } from "node:path";
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

/**
 * What edge derivation reads of a claim: identity, verdict, line of work, the keys that name its check and run, and
 * the digest of its pinned conditions. The append path keeps these, not whole claims, in the log's index, so deriving
 * an append's edges never re-reads or re-hashes the log.
 */
export interface ClaimEdgeSubject {
	id: string;
	kind: ClaimRecord["kind"];
	verdict: ClaimRecord["verdict"];
	worktree?: string;
	keys: { check: string; command: string[]; run?: string };
	/** `claimConditionsKey`, computed once. */
	pins: string | null;
}

export function claimEdgeSubject(claim: ClaimRecord): ClaimEdgeSubject {
	return {
		id: claim.id,
		kind: claim.kind,
		verdict: claim.verdict,
		...(claim.worktree !== undefined ? { worktree: claim.worktree } : {}),
		keys: {
			check: claim.keys.check,
			command: [...claim.keys.command],
			...(claim.keys.run !== undefined ? { run: claim.keys.run } : {}),
		},
		pins: claimConditionsKey(claim),
	};
}

type Keyed = { keys: { check: string; command: ReadonlyArray<string>; run?: string } };

/** Where a sweep check's runs sit, both as its argv names them and as the repository-relative runs directory. */
export interface SweepRunLayout {
	argumentDir: string;
	runsDir: string;
}

const RUN_NAME = /^[A-Za-z0-9._-]+$/u;

/**
 * Each sweep check's run layout, learned from claims that recorded their run: verify appends the run directory,
 * relative to the check's cwd, as the last argument. Null when the claims disagree or the argument has no directory
 * part, because then a run cannot be told from any other argument.
 */
function sweepRunLayouts(claims: ReadonlyArray<Keyed>): Map<string, SweepRunLayout | null> {
	const layouts = new Map<string, SweepRunLayout | null>();
	for (const claim of claims) foldSweepRunLayout(layouts, claim);
	return layouts;
}

/** Fold one claim into the layouts, as `sweepRunLayouts` does for each claim in log order. */
export function foldSweepRunLayout(layouts: Map<string, SweepRunLayout | null>, claim: Keyed): void {
	{
		const run = claim.keys.run;
		const last = claim.keys.command.at(-1);
		const known = layouts.get(claim.keys.check);
		if (run === undefined || last === undefined || known === null) return;
		const argument = posix.normalize(last);
		const layout = { argumentDir: posix.dirname(argument), runsDir: posix.dirname(run) };
		const usable = layout.argumentDir !== "." && posix.basename(argument) === posix.basename(run);
		const agrees = known === undefined || (known.argumentDir === layout.argumentDir && known.runsDir === layout.runsDir);
		layouts.set(claim.keys.check, usable && agrees ? layout : null);
	}
}

/**
 * The run a claim judged. A claim recorded before runs were keyed has none, but its argv still names the run: take it
 * when the command names exactly one directory under the check's runs directory. Used for edges only; the stored claim
 * and its id are unchanged. Any other run-less claim stays keyed by its check alone.
 */
function claimRun(claim: Keyed, layouts: ReadonlyMap<string, SweepRunLayout | null>): string | undefined {
	if (claim.keys.run !== undefined) return claim.keys.run;
	const layout = layouts.get(claim.keys.check);
	if (!layout) return undefined;
	const named = new Set<string>();
	for (const value of claim.keys.command) {
		const argument = posix.normalize(value);
		const name = posix.basename(argument);
		if (posix.dirname(argument) === layout.argumentDir && RUN_NAME.test(name) && name !== "." && name !== "..")
			named.add(name);
	}
	const [only] = named;
	return named.size === 1 && only !== undefined ? posix.join(layout.runsDir, only) : undefined;
}

/**
 * What edges treat as one check: the check id, and for a sweep check the run it judged. Sibling runs of one sweep are
 * separate subjects, so they never supersede or contradict each other; a rerun of the same run still does (Q7).
 */
function edgeIdentity(claim: Keyed, layouts: ReadonlyMap<string, SweepRunLayout | null>): string {
	const run = claimRun(claim, layouts);
	return run === undefined ? claim.keys.check : `${claim.keys.check}\0${run}`;
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

function edge(kind: ClaimEdgeRecordV1["kind"], from: ClaimRecord, to: { id: string }): ClaimEdgeRecordV1 {
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
 * - `contradicts` the latest earlier claim with equal pinned conditions (`pinnedConditions`) when its verdict differs.
 *   Only a flip adds one, so a run of agreeing claims followed by a disagreeing one adds one edge, not one per
 *   agreement. Not scoped to a line of work: equal pins mean the same command judged the same commit.
 * - `supersedes` every earlier claim of the same check, run, kind and line of work (`worktree`) whose pinned
 *   conditions differ, unless already superseded. Each claim is superseded at most once, so these edges never
 *   outnumber claims.
 */
export function deriveClaimEdges(
	history: { claims: ReadonlyArray<ClaimRecord>; edges: ReadonlyArray<ClaimEdgeRecordV1> },
	incoming: ReadonlyArray<ClaimRecord>,
): ClaimEdgeRecordV1[] {
	const subjects = history.claims.map(claimEdgeSubject);
	const state: ClaimEdgeState = {
		subjects,
		superseded: new Set(history.edges.filter((item) => item.kind === "supersedes").map((item) => item.to)),
		layouts: sweepRunLayouts(subjects),
		known: new Set(subjects.map((subject) => subject.id)),
	};
	return deriveClaimEdgesFrom(state, incoming);
}

/** The state edge derivation runs against: the log's claims as subjects, the superseded set and the run layouts. */
export interface ClaimEdgeState {
	subjects: ClaimEdgeSubject[];
	superseded: Set<string>;
	layouts: Map<string, SweepRunLayout | null>;
	/** Claim ids already in the log, so a repeated append derives nothing. */
	known: Set<string>;
}

/**
 * `deriveClaimEdges` over a prepared state, which it advances: each incoming claim joins the subjects, its supersede
 * targets join the superseded set, and the layouts fold it in. The index-backed append calls this directly.
 */
export function deriveClaimEdgesFrom(state: ClaimEdgeState, incoming: ReadonlyArray<ClaimRecord>): ClaimEdgeRecordV1[] {
	for (const claim of incoming) foldSweepRunLayout(state.layouts, claim);
	const layouts = state.layouts;
	const added: ClaimEdgeRecordV1[] = [];
	for (const claim of incoming) {
		if (state.known.has(claim.id)) continue;
		const subject = claimEdgeSubject(claim);
		const key = subject.pins;
		const identity = edgeIdentity(claim, layouts);
		const sameCheck = state.subjects.filter(
			(earlier) => earlier.kind === claim.kind && edgeIdentity(earlier, layouts) === identity,
		);
		const latest = key === null ? undefined : sameCheck.filter((earlier) => earlier.pins === key).at(-1);
		if (latest !== undefined && latest.verdict !== claim.verdict) added.push(edge("contradicts", claim, latest));
		for (const earlier of sameCheck) {
			if (state.superseded.has(earlier.id) || (key !== null && earlier.pins === key)) continue;
			// Supersession stays within one line of work: a lane at its own commit does not replace the main checkout's
			// verdict at another, nor the reverse (#406). Equal pins still contradict across worktrees, above.
			if ((earlier.worktree ?? null) !== (claim.worktree ?? null)) continue;
			added.push(edge("supersedes", claim, earlier));
			state.superseded.add(earlier.id);
		}
		state.subjects.push(subject);
		state.known.add(claim.id);
	}
	return added;
}

/**
 * Status of every claim from the log's edges. A pass a later grounded failure overturned under equal pinned conditions
 * is `retired`: it no longer stands, and the failure that retired it is `contested` until a later claim settles the
 * pair. A failure is never retired by a later pass, because a contradiction may withdraw a pass but never restore one.
 */
export function claimStatuses(
	claims: ReadonlyArray<ClaimRecord>,
	edges: ReadonlyArray<ClaimEdgeRecordV1>,
): Map<string, ClaimStatus> {
	const superseded = new Set(edges.filter((item) => item.kind === "supersedes").map((item) => item.to));
	const contradictions = edges.filter((item) => item.kind === "contradicts");
	const contested = new Set(contradictions.flatMap((item) => [item.from, item.to]));
	const byId = new Map(claims.map((claim) => [claim.id, claim]));
	const retired = new Set<string>();
	for (const item of contradictions) {
		if (byId.get(item.from)?.verdict !== "disagrees" || byId.get(item.to)?.verdict !== "agrees") continue;
		for (const claim of overturnedAgreements(item, claims, edges)) retired.add(claim.id);
	}
	return new Map(
		claims.map((claim) => [
			claim.id,
			superseded.has(claim.id)
				? "superseded"
				: retired.has(claim.id)
					? "retired"
					: contested.has(claim.id)
						? "contested"
						: "standing",
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
	const layouts = sweepRunLayouts(claims);
	return claims
		.slice(0, laterIndex < 0 ? claims.length : laterIndex)
		.filter(
			(claim) =>
				claim.verdict === "agrees" &&
				claim.kind === later.kind &&
				edgeIdentity(claim, layouts) === edgeIdentity(later, layouts) &&
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
