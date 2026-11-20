import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalCheckout, checkoutHead } from "../core/project-root.js";
import {
	CLAIMS_LOG_MAX_CLAIMS,
	type ClaimDisputeRecord,
	type ClaimImportRecord,
	type ClaimRecord,
	type ClaimSealBinding,
	type ClaimStatus,
	type ClaimsLogRead,
	claimCheckLabel,
	claimSealReader,
	claimStatuses,
	claimsEvicted,
	claimsProjectRoot,
	compactClaimsLog,
	contradictionConditions,
	type HypothesisRecord,
	type HypothesisState,
	type HypothesisStatus,
	hypothesisStatuses,
	memoryCitedClaimIds,
	readClaims,
	supersedeConditions,
} from "../domains/claims/index.js";
import { exportClaims, importClaims, importOriginLabel } from "../domains/claims/transfer.js";
import { printError } from "./argv.js";
import { writeCliFailure } from "./kit/json-out.js";

/** One diagnostic and a pointer to help, never the whole page (C3); `--json` adds the failure document. */
function usageError(path: ReadonlyArray<string>, message: string, json: boolean, code = 2): number {
	const flag = message.startsWith("unknown flag");
	writeCliFailure({ path: ["claims", ...path], slug: flag ? "unknown_flag" : "usage", message, json });
	return code;
}

function unexpected(operand: string): string {
	return operand.startsWith("-") ? `unknown flag: ${operand}` : `unexpected argument '${operand}'`;
}

const HELP = `Usage:
  clio-coder claims [list] [--check <id>] [--json]
  clio-coder claims show <id-prefix> [--json]
  clio-coder claims export [--check <id>] [--out <file>]
  clio-coder claims import <file> [--json]
  clio-coder claims compact [--prune-superseded-before <iso-date>] [--dry-run] [--json]

Lists the claims recorded for the project at the current directory, oldest
first. A claim is what one judged reproduce or numeric-compare check
concluded: whether the judged results agreed within the tolerance the check
declared, under the conditions recorded with it (commit, inputs, seed,
platform). It does not establish that a result is scientifically right.

Claims are captured from verify results on the main thread and from host
verification of worker runs. The log is append-only and lives in CLIO Coder's
state directory, keyed by the repository root, so every subdirectory of a
repository reads the same claims. A linked worktree folds into its main
checkout: a lane and the checkout it merges into share one log, a lane's claims
supersede only claims from the same worktree, and opposite verdicts at equal
pinned conditions contradict wherever they ran. A checkout whose .git pointer
claims a worktree the main repository does not record records nothing.

Each claim's seal line (--json: seal) says how it stands against the sealed
run it cites. A host verification claim is verified when that run's seal
verifies and its sealed result holds the check with the claim's verdict and
digests; one that cites a run with no verifying seal, another settlement or no
such check reads as unverified and cannot back memory. A verify claim from the
main thread cites no run, so it is not bound to a sealed check.

Edges are derived when a claim is recorded, from the check id and recorded
conditions only. A claim that reaches the opposite verdict with the same
pinned conditions (commit, command, reference, inputs, tolerance, and for
reproduce the seed, environment and platform) contradicts the latest earlier
one. When a failure overturns a pass, the pass reads as retired and the failure
as contested; any other contradiction leaves both contested. A numeric-compare check's working tree is
not pinned: an uncommitted edit at the same commit still contradicts, and the
edge says how the trees differed. A claim whose pinned conditions changed (a
new commit, new input digests) supersedes the earlier ones. A claim recorded
at a commit other than the current HEAD is listed as stale (--json: stale):
it says what held at that commit, not on this tree. Each run of a
sweep check (verify(check="<id>/<run>")) is its own subject: sibling runs never
supersede each other, a rerun of one run does, and the listing names it as
<id>/<run>. --check takes the check id or one <id>/<run>.
When a disagreement overturns an agreement, every memory record citing the
agreeing claim gets a regression and leaves the prompt until approved again;
the claim lists which records changed, or that none did.

A dispute is a worker disagreement kept past its dispatch: an agent-ledger
review that did not pass, with the entry it targeted. Both sides are
model-authored and inferred; no verdict is merged, and a dispute never backs
memory.

export writes this project's own grounded claims as JSON (stdout, or --out),
with an origin naming the repository's root commit and origin remote, never a
local path. import records another project's export here as inferred leads:
each keeps its origin and is shown as not verified here, never forms an edge
with this project's claims and never backs memory. Importing an export into
the project it came from is refused.

compact rewrites the log without check starts that bound no hypothesis,
repeated lines and damaged lines (kept aside in <log>.quarantine.jsonl). With
--prune-superseded-before it also drops superseded claims captured before that
date that no regression, hypothesis test or memory record cites. The previous
log stays as <log>.prev.jsonl until the next compaction.

Hypotheses from a hypothesis-workflow slate (schema
clio-coder.hypothesis-slate.v1) are recorded as proposed when the main session
writes or edits the slate. Their text is the model's and is never evidence.
When the check a hypothesis's success criterion names (its verifyId) runs, the
hypothesis is tested; a judged claim from that run supports it when the claim
agrees and refutes it when the claim disagrees. The latest judged run decides.
A changed slate entry is recorded again and revises the earlier record.
--check also selects the hypotheses whose criterion names the check; show
takes a hypothesis id prefix as well.`;

const SCOPE_NOTE =
	"Each claim states agreement within its declared tolerance under its recorded conditions, not truth.";
const HYPOTHESIS_SCOPE_NOTE =
	"A hypothesis is proposed text; supported or refuted means its named check's latest claim agreed or disagreed, not that it is true.";

function sourceLine(claim: ClaimRecord): string {
	const source = claim.source;
	if (source.channel === "host-verification")
		return `host verification of run ${source.runId}, receipt ${source.receiptDigest.slice(0, 12)}`;
	const session = source.sessionId === null ? "no session" : `session ${source.sessionId}`;
	return `verify requested by the ${source.requestedBy === "harness" ? "harness" : "agent"}, ${session}`;
}

interface LogView {
	/** HEAD of the checkout the command runs in, or null outside a repository. */
	head: string | null;
	statuses: Map<string, ClaimStatus>;
	hypotheses: Map<string, HypothesisState>;
	read: ClaimsLogRead;
	/** How each claim stands against the sealed run it cites (D3-4). */
	seal: (claim: ClaimRecord) => ClaimSealBinding;
	/** Claims the count cap moved out of the log (MEM-3), or null when none was. */
	evicted: { claims: number; path: string } | null;
}

function sealLine(claim: ClaimRecord, view: LogView): string {
	const binding = view.seal(claim);
	if (binding.state === "verified") return `verified against the sealed result of run ${binding.runId}`;
	return binding.state === "unverified"
		? `unverified: ${binding.reason}; do not treat it as grounded`
		: `not bound to a sealed check: ${binding.reason}`;
}

function short(id: string): string {
	return id.slice(0, 12);
}

/**
 * Why a claim no longer describes the current checkout, or null: it was recorded at a commit HEAD has moved past. A
 * claim states what held under its recorded conditions; at another commit it is history, not a verdict on this tree.
 */
function staleBecause(claim: ClaimRecord, view: LogView): string | null {
	const commit = claim.conditions.commit;
	if (commit === null || view.head === null || commit === view.head) return null;
	return `recorded at commit ${short(commit)}; HEAD is now ${short(view.head)}, so rerun the check to judge this tree`;
}

/** Each edge and memory outcome touching a claim, from that claim's side. */
function relationLines(claim: ClaimRecord, view: LogView): string[] {
	const lines: string[] = [];
	const byId = new Map(view.read.records.map((record) => [record.id, record]));
	for (const edge of view.read.edges) {
		if (edge.from !== claim.id && edge.to !== claim.id) continue;
		const later = byId.get(edge.from);
		const earlier = byId.get(edge.to);
		const why =
			later === undefined || earlier === undefined
				? "the other claim is not in this log"
				: edge.kind === "contradicts"
					? `opposite verdict ${contradictionConditions(later, earlier)}`
					: supersedeConditions(later, earlier);
		const verb =
			edge.kind === "contradicts"
				? edge.from === claim.id
					? `contradicts ${short(edge.to)}`
					: `contradicted by ${short(edge.from)}`
				: edge.from === claim.id
					? `supersedes ${short(edge.to)}`
					: `superseded by ${short(edge.from)}`;
		lines.push(`${verb}: ${why}`);
	}
	const hypotheses = new Map(view.read.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
	for (const test of view.read.hypothesisTests) {
		if (test.claim !== claim.id) continue;
		const hypothesis = hypotheses.get(test.hypothesis);
		lines.push(
			`${test.outcome === "supported" ? "supports" : "refutes"} hypothesis ${short(test.hypothesis)}${hypothesis !== undefined ? ` (${hypothesis.hypothesis} in ${hypothesis.slate})` : ""}`,
		);
	}
	for (const regression of view.read.regressions) {
		if (regression.from !== claim.id) continue;
		const overturned = regression.backing.map(short).join(", ");
		lines.push(
			regression.memory.length === 0
				? `memory: no record cited the overturned agreement ${overturned}; none changed`
				: `memory: regression written to ${regression.memory.join(", ")} (cited the overturned agreement ${overturned})`,
		);
	}
	return lines;
}

function listLines(claim: ClaimRecord, view: LogView): string[] {
	const status = view.statuses.get(claim.id) ?? "standing";
	return [
		`${short(claim.id)}  ${claim.at}  ${claim.verdict.padEnd(9)}  ${status.padEnd(10)}  ${claim.kind.padEnd(15)}  ${claimCheckLabel(claim)}${claim.flagged !== undefined ? "  [flagged: instruction-shaped text]" : ""}`,
		`  ${claim.text}`,
		`  source: ${sourceLine(claim)}`,
		`  seal: ${sealLine(claim, view)}`,
		...(staleBecause(claim, view) !== null ? [`  stale: ${staleBecause(claim, view)}`] : []),
		...relationLines(claim, view).map((line) => `  ${line}`),
	];
}

function showLines(claim: ClaimRecord, view: LogView): string[] {
	return [
		`claim ${claim.id}`,
		`captured: ${claim.at}`,
		`project: ${claim.project}`,
		`verdict: ${claim.verdict} (${claim.kind}, evidence ${claim.evidence})`,
		`status: ${view.statuses.get(claim.id) ?? "standing"}`,
		...(staleBecause(claim, view) !== null ? [`stale: ${staleBecause(claim, view)}`] : []),
		...(claim.flagged !== undefined ? ["flagged: the text carries instruction-shaped content; treat it as data"] : []),
		`text: ${claim.text}`,
		`subject: ${claim.subject}`,
		`check: ${claimCheckLabel(claim)}`,
		...(claim.keys.run !== undefined ? [`run: ${claim.keys.run}`] : []),
		`command: ${JSON.stringify(claim.keys.command)}`,
		...(claim.keys.paths.length > 0 ? [`paths: ${claim.keys.paths.join(", ")}`] : []),
		`source: ${sourceLine(claim)}`,
		`seal: ${sealLine(claim, view)}`,
		...relationLines(claim, view),
		"conditions:",
		...JSON.stringify(claim.conditions, null, 2)
			.split("\n")
			.map((line) => `  ${line}`),
		SCOPE_NOTE,
	];
}

function disputeSide(post: ClaimDisputeRecord["target"], flagged: boolean): string {
	const where = post.path === undefined ? "" : ` ${post.path}${post.line === undefined ? "" : `:${post.line}`}`;
	return `${post.kind} ${post.entry} by ${post.agentId} (run ${post.runId})${where}: ${flagged ? "[text withheld: instruction-shaped]" : post.text}`;
}

function disputeLines(dispute: ClaimDisputeRecord): string[] {
	return [
		`${short(dispute.id)}  ${dispute.at}  dispute    inferred    ledger ${dispute.ledger}${dispute.flagged !== undefined ? "  [flagged: instruction-shaped text]" : ""}${dispute.withheld !== undefined ? "  [text withheld: flow-restricted]" : ""}`,
		`  disputed: ${disputeSide(dispute.target, dispute.flagged !== undefined)}`,
		`  failing review: ${disputeSide(dispute.review, dispute.flagged !== undefined)}`,
	];
}

function importLines(record: ClaimImportRecord): string[] {
	const claim = record.claim;
	return [
		`${short(record.id)}  ${record.at}  ${claim.verdict.padEnd(9)}  imported    ${claim.kind.padEnd(15)}  ${claimCheckLabel(claim)}${record.flagged !== undefined ? "  [flagged: instruction-shaped text]" : ""}`,
		`  ${record.flagged !== undefined ? "[text withheld: instruction-shaped]" : claim.text}`,
		`  ${importOriginLabel(record)}; original claim ${short(claim.id)}`,
	];
}

function relatedJson(claim: ClaimRecord, view: LogView): Record<string, unknown> {
	return {
		...claim,
		status: view.statuses.get(claim.id) ?? "standing",
		stale: staleBecause(claim, view) !== null,
		seal: view.seal(claim),
		edges: view.read.edges.filter((edge) => edge.from === claim.id || edge.to === claim.id),
		regressions: view.read.regressions.filter((regression) => regression.from === claim.id),
		hypothesisTests: view.read.hypothesisTests.filter((test) => test.claim === claim.id),
	};
}

function hypothesisState(hypothesis: HypothesisRecord, view: LogView): HypothesisState {
	return view.hypotheses.get(hypothesis.id) ?? { status: "proposed", tests: [] };
}

function testLines(hypothesis: HypothesisRecord, view: LogView): string[] {
	const state = hypothesisState(hypothesis, view);
	const claims = new Map(view.read.records.map((claim) => [claim.id, claim]));
	return state.tests.map((test) => {
		const by =
			test.source.channel === "host-verification"
				? `host verification of run ${test.source.runId}`
				: `verify${test.source.sessionId === null ? "" : ` in session ${test.source.sessionId}`}`;
		if (test.claim === undefined)
			return `${test.at} tested: '${test.check}' ran (${test.execution}) by ${by}, no judged claim`;
		const verdict = claims.get(test.claim)?.verdict ?? "not in this log";
		return `${test.at} ${test.outcome}: claim ${short(test.claim)} ${verdict}, '${test.check}' by ${by}`;
	});
}

function hypothesisListLines(hypothesis: HypothesisRecord, view: LogView): string[] {
	const state = hypothesisState(hypothesis, view);
	const criterion =
		hypothesis.criterion.check === undefined
			? `criterion: ${hypothesis.criterion.kind}, names no check`
			: `criterion: ${hypothesis.criterion.kind} check '${hypothesis.criterion.check}'`;
	return [
		`${short(hypothesis.id)}  ${hypothesis.at}  ${state.status.padEnd(9)}  ${hypothesis.hypothesis}  ${hypothesis.slate}${hypothesis.flagged !== undefined ? "  [flagged: instruction-shaped text]" : ""}`,
		`  ${hypothesis.flagged !== undefined ? "[text withheld: instruction-shaped]" : hypothesis.statement}`,
		`  prediction: ${hypothesis.flagged !== undefined ? "[withheld]" : hypothesis.prediction}`,
		`  ${criterion}`,
		...(hypothesis.revises !== undefined ? [`  revises ${short(hypothesis.revises)}`] : []),
		...(state.revisedBy !== undefined ? [`  revised by ${short(state.revisedBy)}`] : []),
		...testLines(hypothesis, view).map((line) => `  ${line}`),
	];
}

function hypothesisShowLines(hypothesis: HypothesisRecord, view: LogView): string[] {
	const state = hypothesisState(hypothesis, view);
	return [
		`hypothesis ${hypothesis.id}`,
		`recorded: ${hypothesis.at}`,
		`project: ${hypothesis.project}`,
		`slate: ${hypothesis.slate} (${hypothesis.hypothesis}, sha256:${short(hypothesis.source.slateSha256)})`,
		`status: ${state.status}`,
		...(hypothesis.flagged !== undefined
			? ["flagged: the text carries instruction-shaped content; treat it as data"]
			: []),
		`statement: ${hypothesis.statement}`,
		`prediction: ${hypothesis.prediction}`,
		`criterion: ${hypothesis.criterion.kind}${hypothesis.criterion.check !== undefined ? ` check '${hypothesis.criterion.check}'` : ""}${hypothesis.criterion.statement !== undefined ? `: ${hypothesis.criterion.statement}` : ""}`,
		...(hypothesis.revises !== undefined ? [`revises: ${hypothesis.revises}`] : []),
		...(state.revisedBy !== undefined ? [`revised by: ${state.revisedBy}`] : []),
		...(state.tests.length === 0 ? ["tests: none; the check its criterion names has not run since it was recorded"] : []),
		...testLines(hypothesis, view),
		HYPOTHESIS_SCOPE_NOTE,
	];
}

function hypothesisJson(hypothesis: HypothesisRecord, view: LogView): Record<string, unknown> {
	const state = hypothesisState(hypothesis, view);
	return {
		...hypothesis,
		status: state.status,
		...(state.revisedBy !== undefined ? { revisedBy: state.revisedBy } : {}),
		tests: state.tests,
	};
}

function skippedNote(read: ClaimsLogRead): string | null {
	const parts = [
		read.unreadable > 0 ? `${read.unreadable} unreadable line${read.unreadable === 1 ? "" : "s"}` : null,
		read.mismatched > 0
			? `${read.mismatched} record${read.mismatched === 1 ? "" : "s"} whose id or project does not match its content`
			: null,
		read.unknownVersion > 0
			? `${read.unknownVersion} record${read.unknownVersion === 1 ? "" : "s"} of a newer version`
			: null,
		read.unlinked > 0
			? `${read.unlinked} hypothesis record${read.unlinked === 1 ? "" : "s"} that do not follow from earlier records`
			: null,
		read.duplicates > 0 ? `${read.duplicates} repeated line${read.duplicates === 1 ? "" : "s"}` : null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? `skipped ${parts.join(", ")}` : null;
}

function readJsonSummary(
	view: LogView,
	claims: ReadonlyArray<ClaimRecord>,
	hypotheses: ReadonlyArray<HypothesisRecord>,
): Record<string, unknown> {
	const read = view.read;
	return {
		project: read.project,
		path: read.path,
		claims: claims.map((claim) => relatedJson(claim, view)),
		hypotheses: hypotheses.map((hypothesis) => hypothesisJson(hypothesis, view)),
		disputes: read.disputes.map((dispute) => ({ ...dispute, status: "contested" })),
		imports: read.imports.map((record) => ({ ...record, status: "inferred", label: importOriginLabel(record) })),
		...(read.legacy.length > 0 ? { legacy: read.legacy } : {}),
		...(view.evicted !== null ? { evicted: view.evicted } : {}),
		skipped: {
			unreadable: read.unreadable,
			mismatched: read.mismatched,
			unknownVersion: read.unknownVersion,
			unlinked: read.unlinked,
			duplicates: read.duplicates,
		},
	};
}

/** `--name value` from operands, removing both; undefined when absent. Null when the flag has no value. */
function takeOption(operands: string[], name: string): string | null | undefined {
	const index = operands.indexOf(name);
	if (index < 0) return undefined;
	const value = operands[index + 1];
	operands.splice(index, value === undefined ? 1 : 2);
	return value ?? null;
}

async function runExport(operands: string[], json: boolean): Promise<number> {
	const check = takeOption(operands, "--check");
	const out = takeOption(operands, "--out");
	if (check === null || out === null || operands.length > 0)
		return usageError(
			["export"],
			operands[0] !== undefined
				? unexpected(operands[0])
				: "usage: clio-coder claims export [--check <id>] [--out <file>]",
			json,
		);
	const bundle = exportClaims(claimsProjectRoot(process.cwd()), check !== undefined ? { check } : {});
	const text = `${JSON.stringify(bundle, null, 2)}\n`;
	if (out === undefined) process.stdout.write(text);
	else {
		writeFileSync(resolve(out), text, { mode: 0o600 });
		console.log(`exported ${bundle.claims.length} claim${bundle.claims.length === 1 ? "" : "s"} to ${resolve(out)}`);
	}
	return 0;
}

async function runImport(operands: string[], json: boolean): Promise<number> {
	const [file] = operands;
	// v1 read a flag here as a file name and failed with exit 1; the exit stays, the message names the flag.
	if (file?.startsWith("-") === true) return usageError(["import"], unexpected(file), json, 1);
	if (file === undefined || operands.length > 1) return usageError(["import"], "name one export file", json);
	const checkout = canonicalCheckout(process.cwd());
	if (!checkout.trusted) {
		printError(
			"claims import: this checkout's .git pointer names a worktree its repository does not record; nothing was imported",
		);
		return 1;
	}
	let bundle: unknown;
	try {
		bundle = JSON.parse(readFileSync(resolve(file), "utf8"));
	} catch (error) {
		printError(`claims import: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	try {
		const result = await importClaims(checkout.project, bundle);
		if (json) console.log(JSON.stringify(result, null, 2));
		else
			console.log(
				`imported ${result.imported} claim${result.imported === 1 ? "" : "s"} as inferred (${result.repeated} already here, ${result.rejected} rejected as not intact, ${result.flagged} flagged); imported claims are leads from another project and ground nothing here`,
			);
		return 0;
	} catch (error) {
		printError(`claims import: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

async function runCompact(operands: string[], json: boolean): Promise<number> {
	const dryRun = operands.includes("--dry-run");
	const rest = operands.filter((operand) => operand !== "--dry-run");
	const before = takeOption(rest, "--prune-superseded-before");
	if (before === null || rest.length > 0 || (before !== undefined && Number.isNaN(Date.parse(before))))
		return usageError(
			["compact"],
			rest[0] !== undefined
				? unexpected(rest[0])
				: "usage: clio-coder claims compact [--prune-superseded-before <iso-date>] [--dry-run]",
			json,
		);
	let cited: Set<string> | undefined;
	// A claim a memory record cites stays, whatever its age: pruning it would orphan the record's evidence.
	if (before !== undefined) cited = await memoryCitedClaimIds();
	const result = await compactClaimsLog(claimsProjectRoot(process.cwd()), {
		dryRun,
		...(before !== undefined ? { pruneSupersededBefore: new Date(before) } : {}),
		...(cited !== undefined ? { cited } : {}),
	});
	if (json) console.log(JSON.stringify(result, null, 2));
	else
		console.log(
			`${dryRun ? "would compact" : "compacted"} ${result.path}: ${result.linesBefore} -> ${result.linesAfter} lines, ${result.bytesBefore} -> ${result.bytesAfter} bytes (${result.droppedStarts} unbound check starts, ${result.duplicates} repeats, ${result.quarantined} quarantined, ${result.prunedClaims} superseded claims and ${result.prunedEdges} edges pruned)`,
		);
	return 0;
}

export async function runClaimsCommand(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return 0;
	}
	const json = args.includes("--json");
	const rest = args.filter((arg) => arg !== "--json");
	const [action = "list", ...operands] = rest[0]?.startsWith("--") === true ? ["list", ...rest] : rest;
	if (action === "export") return runExport(operands, json);
	if (action === "import") return runImport(operands, json);
	if (action === "compact") return runCompact(operands, json);
	let read: ClaimsLogRead;
	try {
		read = readClaims(claimsProjectRoot(process.cwd()));
	} catch (error) {
		printError(`claims: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const view: LogView = {
		head: checkoutHead(canonicalCheckout(process.cwd()).checkout),
		read,
		statuses: claimStatuses(read.records, read.edges),
		hypotheses: hypothesisStatuses(read.hypotheses, read.hypothesisTests),
		seal: claimSealReader(),
		evicted: claimsEvicted(read.project),
	};
	if (action === "list") {
		let check: string | undefined;
		for (let index = 0; index < operands.length; index++) {
			const operand = operands[index];
			if (operand === "--check" && operands[index + 1] !== undefined) {
				check = operands[index + 1];
				index += 1;
				continue;
			}
			return usageError(["list"], operand === "--check" ? "--check requires a value" : unexpected(operand ?? ""), json);
		}
		const claims =
			check === undefined
				? read.records
				: read.records.filter((claim) => claim.keys.check === check || claimCheckLabel(claim) === check);
		const hypotheses =
			check === undefined ? read.hypotheses : read.hypotheses.filter((hypothesis) => hypothesis.criterion.check === check);
		if (json) {
			console.log(JSON.stringify(readJsonSummary(view, claims, hypotheses), null, 2));
			return 0;
		}
		const lines = [`project: ${read.project}`, `log: ${read.path}`];
		if (claims.length === 0) lines.push(check === undefined ? "no claims recorded" : `no claims recorded for '${check}'`);
		else {
			const count = (status: ClaimStatus): number =>
				claims.filter((claim) => view.statuses.get(claim.id) === status).length;
			lines.push(
				`${claims.length} claim${claims.length === 1 ? "" : "s"} (${count("contested")} contested, ${count("retired")} retired, ${count("superseded")} superseded); ${SCOPE_NOTE}`,
				"",
			);
			for (const claim of claims) lines.push(...listLines(claim, view));
		}
		if (hypotheses.length > 0) {
			const count = (status: HypothesisStatus): number =>
				hypotheses.filter((hypothesis) => hypothesisState(hypothesis, view).status === status).length;
			lines.push(
				"",
				`${hypotheses.length} hypothes${hypotheses.length === 1 ? "is" : "es"} (${count("proposed")} proposed, ${count("tested")} tested, ${count("supported")} supported, ${count("refuted")} refuted); ${HYPOTHESIS_SCOPE_NOTE}`,
				"",
			);
			for (const hypothesis of hypotheses) lines.push(...hypothesisListLines(hypothesis, view));
		}
		const disputes =
			check === undefined ? read.disputes : read.disputes.filter((dispute) => dispute.target.path === check);
		if (disputes.length > 0) {
			lines.push(
				"",
				`${disputes.length} dispute${disputes.length === 1 ? "" : "s"} (worker disagreements kept past their dispatch; inferred, no merged verdict)`,
				"",
			);
			for (const dispute of disputes) lines.push(...disputeLines(dispute));
		}
		const imports =
			check === undefined ? read.imports : read.imports.filter((record) => record.claim.keys.check === check);
		if (imports.length > 0) {
			lines.push(
				"",
				`${imports.length} imported claim${imports.length === 1 ? "" : "s"} (inferred leads from another project; they ground nothing here)`,
				"",
			);
			for (const record of imports) lines.push(...importLines(record));
		}
		if (read.legacy.length > 0)
			lines.push(
				"",
				`also read: ${read.legacy.join(", ")} (linked worktree logs from before worktrees folded into this project)`,
			);
		if (view.evicted !== null)
			lines.push(
				`${view.evicted.claims} superseded claim${view.evicted.claims === 1 ? "" : "s"} evicted past the log's cap of ${CLAIMS_LOG_MAX_CLAIMS}, kept in ${view.evicted.path}`,
			);
		const skipped = skippedNote(read);
		if (skipped !== null) lines.push(skipped);
		console.log(lines.join("\n"));
		return 0;
	}
	if (action === "show") {
		const prefix = operands[0];
		const flag = operands.find((operand) => operand.startsWith("-"));
		if (flag !== undefined) return usageError(["show"], unexpected(flag), json);
		if (prefix === undefined || operands.length > 1 || !/^[0-9a-f]{4,64}$/u.test(prefix))
			return usageError(["show"], "name one claim or hypothesis by an id prefix of at least 4 hex characters", json);
		const matches = read.records.filter((claim) => claim.id.startsWith(prefix));
		const hypothesisMatches = read.hypotheses.filter((hypothesis) => hypothesis.id.startsWith(prefix));
		if (matches.length + hypothesisMatches.length !== 1) {
			printError(
				matches.length + hypothesisMatches.length === 0
					? `claims show: no claim or hypothesis in this project has an id starting '${prefix}'`
					: `claims show: '${prefix}' matches ${matches.length + hypothesisMatches.length} records; give more of the id`,
			);
			return 1;
		}
		const [hypothesis] = hypothesisMatches;
		if (hypothesis !== undefined) {
			console.log(
				json ? JSON.stringify(hypothesisJson(hypothesis, view), null, 2) : hypothesisShowLines(hypothesis, view).join("\n"),
			);
			return 0;
		}
		const [claim] = matches as [ClaimRecord];
		console.log(json ? JSON.stringify(relatedJson(claim, view), null, 2) : showLines(claim, view).join("\n"));
		return 0;
	}
	writeCliFailure({ path: ["claims"], slug: "unknown_command", message: `unknown subcommand '${action}'`, json });
	return 2;
}
