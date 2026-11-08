import { resolve } from "node:path";
import {
	ARENA_MAX_CONTENDERS,
	type ArenaContenderSpec,
	type ArenaMatchView,
	ArenaRevealRefused,
	ArenaVoteError,
	arenaMatchView,
	arenaRoot,
	computeStandings,
	isArenaChoice,
	isArenaMatchId,
	listMatches,
	readMatch,
	readVote,
	recordVote,
	runArenaMatch,
	validateArenaRunInput,
} from "../domains/arena/index.js";
import { formatColumns, printError } from "./argv.js";

const HELP = `Usage:
  clio-coder arena run --contender <target>/<model> --contender <target>/<model> [...] [options] <prompt>
  clio-coder arena show <match-id> [--reveal] [--json]
  clio-coder arena vote <match-id> A|B|C|D|tie|both-bad [--note <text>] [--replace] [--json]
  clio-coder arena list [--suite <name>] [--json]
  clio-coder arena standings [--suite <name>] [--json]

Runs one prompt on 2 to ${ARENA_MAX_CONTENDERS} contenders side by side, shows their work under
blind labels, and records which one you preferred. Clio records results and
never judges: no model grades a contender, and standings come from your votes.

run options:
  --contender <target>/<model>  a contender; split at the first "/", repeat 2 to ${ARENA_MAX_CONTENDERS} times
  --cwd <dir>                   project to run in (default: current directory)
  --timeout <seconds>           each contender's run --timeout (default 600)
  --max-cost-usd <N>            each contender's run --max-cost-usd; unpriced routes are not bounded
  --check <verifier-id>         dry-run this verifier in each contender's worktree when it finishes
  --suite <name>                tag the match; list and standings can filter on it
  --seed <n>                    seed for the blind order (default random, stored with the match)
  --read-only                   run contenders read-only even inside a Git repository
  --json                        print the blind match view as JSON

Inside a Git repository every contender works in its own worktree from HEAD,
so uncommitted changes are not part of the baseline; each leaves a diff and the
worktrees are removed afterwards. Outside Git the contenders run read-only.

show hides who each contender is, along with duration, tokens and cost, until
the match has a vote; --reveal before voting is refused. vote records one
choice per match, and --replace changes it; every vote stays in the journal.
standings counts wins, losses, ties and both-bad per target/model, and shows a
Bradley-Terry score once an identity has 5 or more votes.

Matches live under <project>/.clio-coder/arena/<match-id>/.`;

class UsageError extends Error {}

interface Parsed {
	positional: string[];
	values: Map<string, string[]>;
	flags: Set<string>;
}

const VALUE_FLAGS = new Set([
	"--contender",
	"--cwd",
	"--timeout",
	"--max-cost-usd",
	"--check",
	"--suite",
	"--seed",
	"--note",
]);
const BOOLEAN_FLAGS = new Set(["--json", "--reveal", "--replace", "--read-only"]);

function parse(
	args: ReadonlyArray<string>,
	allowedValues: ReadonlyArray<string>,
	allowedFlags: ReadonlyArray<string>,
): Parsed {
	const parsed: Parsed = { positional: [], values: new Map(), flags: new Set() };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") {
			parsed.positional.push(...args.slice(i + 1));
			break;
		}
		if (VALUE_FLAGS.has(arg) && allowedValues.includes(arg)) {
			const value = args[i + 1];
			if (value === undefined) throw new UsageError(`${arg} needs a value`);
			parsed.values.set(arg, [...(parsed.values.get(arg) ?? []), value]);
			i++;
			continue;
		}
		if (BOOLEAN_FLAGS.has(arg) && allowedFlags.includes(arg)) {
			parsed.flags.add(arg);
			continue;
		}
		if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
		parsed.positional.push(arg);
	}
	return parsed;
}

function single(parsed: Parsed, flag: string): string | undefined {
	const values = parsed.values.get(flag);
	if (values !== undefined && values.length > 1) throw new UsageError(`${flag} given more than once`);
	return values?.[0];
}

function contenderSpec(value: string): ArenaContenderSpec {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new UsageError(`--contender takes <target>/<model>, got '${value}'`);
	}
	return { target: value.slice(0, slash), model: value.slice(slash + 1) };
}

function positiveInteger(flag: string, value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${flag} takes a positive whole number`);
	return parsed;
}

function workingDir(parsed: Parsed): string {
	return resolve(single(parsed, "--cwd") ?? process.cwd());
}

function matchIdArg(parsed: Parsed, verb: string): string {
	const id = parsed.positional[0];
	if (id === undefined) throw new UsageError(`arena ${verb} needs a match id`);
	if (!isArenaMatchId(id)) throw new UsageError(`'${id}' is not an arena match id`);
	return id;
}

function indent(text: string, maxLines: number): string {
	const lines = text.split("\n");
	const shown = lines.slice(0, maxLines).map((line) => `    ${line}`);
	if (lines.length > maxLines) shown.push(`    ... ${lines.length - maxLines} more lines (--json has all)`);
	return shown.join("\n");
}

function renderView(view: ArenaMatchView): string {
	const out: string[] = [];
	out.push(`match ${view.id}  ${view.status}  ${view.isolation}${view.suite ? `  suite ${view.suite}` : ""}`);
	out.push(`prompt: ${view.prompt}`);
	if (view.error) out.push(`error: ${view.error}`);
	if (view.vote)
		out.push(`vote: ${view.vote.choice}${view.vote.note ? ` (${view.vote.note})` : ""}  at ${view.vote.votedAt}`);
	else if (view.status === "complete") {
		const labels = view.entries.map((entry) => entry.label).join("|");
		out.push(`blind: vote with clio-coder arena vote ${view.id} ${labels}|tie|both-bad`);
	}
	for (const entry of view.entries) {
		out.push("");
		const stat = entry.diffStat
			? `diff ${entry.diffStat.files} file(s) +${entry.diffStat.insertions} -${entry.diffStat.deletions}`
			: "no diff";
		out.push(
			`── ${entry.label} ── ${entry.status}  exit ${entry.exitCode ?? "?"}${entry.timedOut ? " (timed out)" : ""}  turns ${entry.turns ?? "?"}  tools ${entry.toolCalls ?? "?"} (${entry.toolErrors ?? "?"} errors)  writes ${entry.writes ?? "?"}  blocks ${entry.blocks ?? "?"}  ${stat}`,
		);
		if (entry.reveal) {
			const seconds = entry.reveal.durationMs === null ? "?" : `${(entry.reveal.durationMs / 1000).toFixed(1)}s`;
			out.push(
				`   ${entry.label} = ${entry.reveal.target}/${entry.reveal.model}  ${seconds}  tokens ${entry.reveal.tokens}  cost ${entry.reveal.cost}${entry.reveal.sessionId ? `  session ${entry.reveal.sessionId}` : ""}`,
			);
		}
		if (entry.check) {
			out.push(`   check ${entry.check.id}: exit ${entry.check.exitCode ?? "?"}`);
			out.push(indent(entry.check.tail.split("\n").slice(-3).join("\n"), 3));
		}
		if (entry.error) out.push(`   error: ${entry.error}`);
		out.push("   final:");
		out.push(indent(entry.finalText.length > 0 ? entry.finalText : "(no final text)", 30));
		if (entry.diff !== null && entry.diff.length > 0) {
			out.push("   diff:");
			out.push(indent(entry.diff.trimEnd(), 60));
		}
	}
	return `${out.join("\n")}\n`;
}

function parentEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	return env;
}

async function runCommand(args: string[]): Promise<number> {
	const parsed = parse(
		args,
		["--contender", "--cwd", "--timeout", "--max-cost-usd", "--check", "--suite", "--seed"],
		["--json", "--read-only"],
	);
	const contenders = (parsed.values.get("--contender") ?? []).map(contenderSpec);
	const prompt = parsed.positional.join(" ");
	const timeoutSeconds = positiveInteger("--timeout", single(parsed, "--timeout"), 600);
	const costText = single(parsed, "--max-cost-usd");
	const maxCostUsd = costText === undefined ? null : Number(costText);
	if (maxCostUsd !== null && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) {
		throw new UsageError("--max-cost-usd takes a positive number");
	}
	const seedText = single(parsed, "--seed");
	const seed = seedText === undefined ? undefined : Number(seedText);
	if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
		throw new UsageError("--seed takes a whole number from 0 to 4294967295");
	}
	try {
		validateArenaRunInput({ contenders, prompt, timeoutSeconds });
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	const json = parsed.flags.has("--json");
	const check = single(parsed, "--check");
	const suite = single(parsed, "--suite");
	const entry = process.argv[1];
	if (entry === undefined) throw new Error("cannot locate the clio-coder entry point to start contenders");
	// Each contender leads its own process group, so a signal to this one reaches them only through the abort.
	const controller = new AbortController();
	let stoppedBy: NodeJS.Signals | null = null;
	const onSignal = (signal: NodeJS.Signals): void => {
		stoppedBy ??= signal;
		controller.abort();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	const match = await runArenaMatch({
		cwd: workingDir(parsed),
		prompt,
		contenders,
		timeoutSeconds,
		maxCostUsd,
		...(seed !== undefined ? { seed } : {}),
		...(check !== undefined ? { check } : {}),
		...(suite !== undefined ? { suite } : {}),
		readOnly: parsed.flags.has("--read-only"),
		clio: { file: process.execPath, args: [...process.execArgv, entry] },
		env: parentEnv(),
		signal: controller.signal,
		onStarted: (started) => process.stderr.write(`clio-coder arena: match ${started.id} started\n`),
		onProgress: (line) => process.stderr.write(`clio-coder arena: ${line}\n`),
	}).finally(() => {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	});
	const root = arenaRoot(match.root);
	const view = arenaMatchView(root, match, null);
	process.stdout.write(json ? `${JSON.stringify(view)}\n` : renderView(view));
	if (stoppedBy !== null) return stoppedBy === "SIGINT" ? 130 : 143;
	return match.status === "complete" ? 0 : 1;
}

function showCommand(args: string[]): number {
	const parsed = parse(args, ["--cwd"], ["--json", "--reveal"]);
	const id = matchIdArg(parsed, "show");
	const root = arenaRoot(workingDir(parsed));
	const match = readMatch(root, id);
	if (match === null) {
		printError(`no arena match ${id} under ${root}`);
		return 1;
	}
	try {
		const view = arenaMatchView(root, match, readVote(root, id), { reveal: parsed.flags.has("--reveal") });
		process.stdout.write(parsed.flags.has("--json") ? `${JSON.stringify(view)}\n` : renderView(view));
		return 0;
	} catch (error) {
		if (error instanceof ArenaRevealRefused) {
			printError(error.message);
			return 1;
		}
		throw error;
	}
}

function voteCommand(args: string[]): number {
	const parsed = parse(args, ["--cwd", "--note"], ["--json", "--replace"]);
	const id = matchIdArg(parsed, "vote");
	const choice = parsed.positional[1];
	if (choice === undefined || !isArenaChoice(choice) || parsed.positional.length > 2) {
		throw new UsageError("arena vote takes one choice: A, B, C, D, tie or both-bad");
	}
	const root = arenaRoot(workingDir(parsed));
	try {
		const vote = recordVote(root, id, {
			choice,
			note: single(parsed, "--note") ?? null,
			replace: parsed.flags.has("--replace"),
		});
		if (parsed.flags.has("--json")) process.stdout.write(`${JSON.stringify(vote)}\n`);
		else
			process.stdout.write(
				`recorded ${vote.choice} for match ${id}${vote.replaced ? " (replaced the earlier vote)" : ""}; arena show ${id} reveals who is who\n`,
			);
		return 0;
	} catch (error) {
		if (error instanceof ArenaVoteError) {
			printError(error.message);
			return 1;
		}
		throw error;
	}
}

function listCommand(args: string[]): number {
	const parsed = parse(args, ["--cwd", "--suite"], ["--json"]);
	if (parsed.positional.length > 0) throw new UsageError(`unexpected argument: ${parsed.positional[0]}`);
	const suite = single(parsed, "--suite");
	const entries = listMatches(arenaRoot(workingDir(parsed))).filter(
		({ match }) => suite === undefined || match.suite === suite,
	);
	// Identities appear only for voted matches, so the list never unblinds a pending one.
	const rows = entries.map(({ match, vote }) => ({
		id: match.id,
		createdAt: match.createdAt,
		status: match.status,
		suite: match.suite,
		prompt: match.prompt,
		contenders: match.contenders.length,
		vote: vote?.choice ?? null,
		identities: vote === null ? null : match.contenders.map((c) => `${c.target}/${c.model}`),
	}));
	if (parsed.flags.has("--json")) {
		process.stdout.write(`${JSON.stringify({ matches: rows })}\n`);
		return 0;
	}
	if (rows.length === 0) {
		process.stdout.write("no arena matches yet; start one with clio-coder arena run\n");
		return 0;
	}
	const table = [
		["MATCH", "STATUS", "N", "VOTE", "SUITE", "PROMPT"],
		...rows.map((row) => [
			row.id,
			row.status,
			String(row.contenders),
			row.vote ?? "-",
			row.suite ?? "-",
			row.prompt.length > 60 ? `${row.prompt.slice(0, 57)}...` : row.prompt,
		]),
	];
	process.stdout.write(`${formatColumns(table)}\n`);
	return 0;
}

function standingsCommand(args: string[]): number {
	const parsed = parse(args, ["--cwd", "--suite"], ["--json"]);
	if (parsed.positional.length > 0) throw new UsageError(`unexpected argument: ${parsed.positional[0]}`);
	const standings = computeStandings(listMatches(arenaRoot(workingDir(parsed))), single(parsed, "--suite") ?? null);
	if (parsed.flags.has("--json")) {
		process.stdout.write(`${JSON.stringify(standings)}\n`);
		return 0;
	}
	if (standings.standings.length === 0) {
		process.stdout.write(`no voted matches yet (${standings.matches} recorded)\n`);
		return 0;
	}
	const table = [
		["TARGET/MODEL", "VOTES", "WINS", "LOSSES", "TIES", "BOTH-BAD", "SCORE"],
		...standings.standings.map((s) => [
			s.identity,
			String(s.votes),
			String(s.wins),
			String(s.losses),
			String(s.ties),
			String(s.bad),
			s.score === null ? `n/a (<${standings.minVotesForScore} votes)` : String(s.score),
		]),
	];
	process.stdout.write(
		`${formatColumns(table)}\n${standings.votedMatches} voted of ${standings.matches} matches${standings.suite ? ` in suite ${standings.suite}` : ""}. These are your recorded votes; Clio does not judge.\n`,
	);
	return 0;
}

export async function runArenaCommand(args: string[]): Promise<number> {
	const [verb, ...rest] = args;
	// Help is an option, so a literal "--help" after "--" is prompt text, not a request for help.
	const end = args.indexOf("--");
	const options = end === -1 ? args : args.slice(0, end);
	if (verb === undefined || options.includes("--help") || options.includes("-h")) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	try {
		switch (verb) {
			case "run":
				return await runCommand(rest);
			case "show":
				return showCommand(rest);
			case "vote":
				return voteCommand(rest);
			case "list":
				return listCommand(rest);
			case "standings":
				return standingsCommand(rest);
			default:
				throw new UsageError(`unknown arena command: ${verb}`);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			printError(error.message);
			process.stderr.write(`${HELP}\n`);
			return 2;
		}
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
