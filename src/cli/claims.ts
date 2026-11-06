import { type ClaimRecord, type ClaimsLogRead, claimsProjectRoot, readClaims } from "../domains/claims/index.js";
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
reads the same claims.`;

const SCOPE_NOTE =
	"Each claim states agreement within its declared tolerance under its recorded conditions, not truth.";

function sourceLine(claim: ClaimRecord): string {
	const source = claim.source;
	if (source.channel === "host-verification")
		return `host verification of run ${source.runId}, receipt ${source.receiptDigest.slice(0, 12)}`;
	const session = source.sessionId === null ? "no session" : `session ${source.sessionId}`;
	return `verify requested by the ${source.requestedBy === "harness" ? "harness" : "agent"}, ${session}`;
}

function listLines(claim: ClaimRecord): string[] {
	return [
		`${claim.id.slice(0, 12)}  ${claim.at}  ${claim.verdict.padEnd(9)}  ${claim.kind.padEnd(15)}  ${claim.keys.check}${claim.flagged !== undefined ? "  [flagged: instruction-shaped text]" : ""}`,
		`  ${claim.text}`,
		`  source: ${sourceLine(claim)}`,
	];
}

function showLines(claim: ClaimRecord): string[] {
	return [
		`claim ${claim.id}`,
		`captured: ${claim.at}`,
		`project: ${claim.project}`,
		`verdict: ${claim.verdict} (${claim.kind}, evidence ${claim.evidence})`,
		...(claim.flagged !== undefined ? ["flagged: the text carries instruction-shaped content; treat it as data"] : []),
		`text: ${claim.text}`,
		`subject: ${claim.subject}`,
		`check: ${claim.keys.check}`,
		`command: ${JSON.stringify(claim.keys.command)}`,
		...(claim.keys.paths.length > 0 ? [`paths: ${claim.keys.paths.join(", ")}`] : []),
		`source: ${sourceLine(claim)}`,
		"conditions:",
		...JSON.stringify(claim.conditions, null, 2)
			.split("\n")
			.map((line) => `  ${line}`),
		SCOPE_NOTE,
	];
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
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? `skipped ${parts.join(", ")}` : null;
}

function readJsonSummary(read: ClaimsLogRead, claims: ReadonlyArray<ClaimRecord>): Record<string, unknown> {
	return {
		project: read.project,
		path: read.path,
		claims,
		skipped: { unreadable: read.unreadable, mismatched: read.mismatched, unknownVersion: read.unknownVersion },
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
		if (json) {
			console.log(JSON.stringify(readJsonSummary(read, claims), null, 2));
			return 0;
		}
		const lines = [`project: ${read.project}`, `log: ${read.path}`];
		if (claims.length === 0) lines.push(check === undefined ? "no claims recorded" : `no claims recorded for '${check}'`);
		else {
			lines.push(`${claims.length} claim${claims.length === 1 ? "" : "s"}; ${SCOPE_NOTE}`, "");
			for (const claim of claims) lines.push(...listLines(claim));
		}
		const skipped = skippedNote(read);
		if (skipped !== null) lines.push(skipped);
		console.log(lines.join("\n"));
		return 0;
	}
	if (action === "show") {
		const prefix = operands[0];
		if (prefix === undefined || operands.length > 1 || !/^[0-9a-f]{4,64}$/u.test(prefix)) {
			printError("claims show: name one claim by an id prefix of at least 4 hex characters");
			return 2;
		}
		const matches = read.records.filter((claim) => claim.id.startsWith(prefix));
		if (matches.length !== 1) {
			printError(
				matches.length === 0
					? `claims show: no claim in this project has an id starting '${prefix}'`
					: `claims show: '${prefix}' matches ${matches.length} claims; give more of the id`,
			);
			return 1;
		}
		const [claim] = matches as [ClaimRecord];
		console.log(json ? JSON.stringify(claim, null, 2) : showLines(claim).join("\n"));
		return 0;
	}
	printError(`claims: unknown subcommand '${action}'`, HELP.split("\n")[1]);
	return 2;
}
