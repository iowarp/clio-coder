import {
	type ClaimRecord,
	type ClaimStatus,
	type ClaimsLogRead,
	claimStatuses,
	claimsProjectRoot,
	contradictionConditions,
	type HypothesisRecord,
	type HypothesisState,
	type HypothesisStatus,
	hypothesisStatuses,
	readClaims,
	supersedeConditions,
} from "../domains/claims/index.js";
import { printError } from "./argv.js";

const HELP = `Usage:
  clio-coder claims [list] [--check <id>] [--json]
  clio-coder claims show <id-prefix> [--json]

Lists the claims recorded for the project at the current directory, oldest
first. A claim is what one judged reproduce or numeric-compare check
concluded: whether the judged results agreed within the tolerance the check
declared, under the conditions recorded with it (commit, inputs, seed,
platform). It does not establish that a result is scientifically right.

Claims are captured from verify results on the main thread and from host
verification of worker runs. The log is append-only and lives in Clio's state
directory, keyed by the repository root, so every subdirectory of a repository
reads the same claims.

Edges are derived when a claim is recorded, from the check id and recorded
conditions only. A claim that reaches the opposite verdict with the same
pinned conditions (commit, command, reference, inputs, tolerance, and for
reproduce the seed, environment and platform) contradicts the latest earlier
one, and both read as contested. A numeric-compare check's working tree is
not pinned: an uncommitted edit at the same commit still contradicts, and the
edge says how the trees differed. A claim whose pinned conditions changed (a
new commit, new input digests) supersedes the earlier ones.
When a disagreement overturns an agreement, every memory record citing the
agreeing claim gets a regression and leaves the prompt until approved again;
the claim lists which records changed, or that none did.

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
	statuses: Map<string, ClaimStatus>;
	hypotheses: Map<string, HypothesisState>;
	read: ClaimsLogRead;
}

function short(id: string): string {
	return id.slice(0, 12);
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
		`${short(claim.id)}  ${claim.at}  ${claim.verdict.padEnd(9)}  ${status.padEnd(10)}  ${claim.kind.padEnd(15)}  ${claim.keys.check}${claim.flagged !== undefined ? "  [flagged: instruction-shaped text]" : ""}`,
		`  ${claim.text}`,
		`  source: ${sourceLine(claim)}`,
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
		...(claim.flagged !== undefined ? ["flagged: the text carries instruction-shaped content; treat it as data"] : []),
		`text: ${claim.text}`,
		`subject: ${claim.subject}`,
		`check: ${claim.keys.check}`,
		`command: ${JSON.stringify(claim.keys.command)}`,
		...(claim.keys.paths.length > 0 ? [`paths: ${claim.keys.paths.join(", ")}`] : []),
		`source: ${sourceLine(claim)}`,
		...relationLines(claim, view),
		"conditions:",
		...JSON.stringify(claim.conditions, null, 2)
			.split("\n")
			.map((line) => `  ${line}`),
		SCOPE_NOTE,
	];
}

function relatedJson(claim: ClaimRecord, view: LogView): Record<string, unknown> {
	return {
		...claim,
		status: view.statuses.get(claim.id) ?? "standing",
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
		skipped: {
			unreadable: read.unreadable,
			mismatched: read.mismatched,
			unknownVersion: read.unknownVersion,
			unlinked: read.unlinked,
		},
	};
}

export function runClaimsCommand(args: string[]): number {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return 0;
	}
	const json = args.includes("--json");
	const rest = args.filter((arg) => arg !== "--json");
	const [action = "list", ...operands] = rest[0]?.startsWith("--") === true ? ["list", ...rest] : rest;
	let read: ClaimsLogRead;
	try {
		read = readClaims(claimsProjectRoot(process.cwd()));
	} catch (error) {
		printError(`claims: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const view: LogView = {
		read,
		statuses: claimStatuses(read.records, read.edges),
		hypotheses: hypothesisStatuses(read.hypotheses, read.hypothesisTests),
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
			printError(`claims list: unexpected argument '${operand}'`, HELP.split("\n")[1]);
			return 2;
		}
		const claims = check === undefined ? read.records : read.records.filter((claim) => claim.keys.check === check);
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
				`${claims.length} claim${claims.length === 1 ? "" : "s"} (${count("contested")} contested, ${count("superseded")} superseded); ${SCOPE_NOTE}`,
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
		const skipped = skippedNote(read);
		if (skipped !== null) lines.push(skipped);
		console.log(lines.join("\n"));
		return 0;
	}
	if (action === "show") {
		const prefix = operands[0];
		if (prefix === undefined || operands.length > 1 || !/^[0-9a-f]{4,64}$/u.test(prefix)) {
			printError("claims show: name one claim or hypothesis by an id prefix of at least 4 hex characters");
			return 2;
		}
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
	printError(`claims: unknown subcommand '${action}'`, HELP.split("\n")[1]);
	return 2;
}
