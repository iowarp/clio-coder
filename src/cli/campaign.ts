import { resolve } from "node:path";
import { readLayeredSettings } from "../core/settings-layers.js";
import { clioConfigDir } from "../core/xdg.js";
import {
	type CampaignEntryResult,
	CampaignInputError,
	type CampaignProbe,
	type CampaignResult,
	loadRoster,
	runCampaign,
	validateCampaignInput,
} from "../domains/campaign/index.js";
import { operatorComponentsDir } from "../domains/lifecycle/components.js";
import { formatColumns, printError } from "./argv.js";
import { containedYoloRefusal } from "./contained-yolo-gate.js";
import { loadScriptedAnswers } from "./run-answers.js";
import { installStopSignals } from "./stop-signals.js";

const HELP = `Usage:
  clio-coder campaign run --fixture <dir> --roster <roster.yaml> --answers <answers.yaml> --prompt <text> --out <dir>
                          [--timeout <seconds>] [--probe <extension>:<command>] [--autonomy default|yolo] [--json]

Runs one seeded project across a roster of models and reports, per entry: how
the run ended, the extension gates it reached, extension refusals, loop-guard
blocks, input tokens fresh and cached, output tokens and wall time.

The roster file is a mapping with one key, roster: a list of entries, each with
target, model, an optional thinking level and an optional label (default
<target>/<model>[@<thinking>]); labels must be unique. The answers file is a
\`clio-coder run --answers\` file and is validated before anything starts.

Entries run one at a time. Each gets a fresh copy of the fixture and its own
empty Clio data, state and cache under --out, so entries share no sessions or
memory. Each uses your config directory as it is (targets, credentials,
installed extensions), as your own \`clio-coder run\` would: nothing secret is
copied under --out, and a login an entry refreshes is saved to your credential
store. Each also reads the runtime components you installed with
\`clio-coder tools install\` (copilot-sdk, claude-sdk) from your data directory,
and never installs or writes one there. Each runs headless
\`clio-coder run --answers\` in its fixture copy.

Metrics come from what the run persisted: its session ledger (extension
interviews and the checkpoint ids they asked, extension tool refusals), its
journal (extension block_tool hooks, loop-guard blocks) and the token
attribution of \`telemetry tokens\` (provider-measured totals). --probe runs
\`clio-coder extensions run <extension> <command> --json\` in the copy after the
run and records its result as the desk's final status.

Status per entry: completed (exit 0), unscripted (exit 5: a question the
answers file does not script), timed-out (--timeout), failed (any other exit),
canceled, or error (the entry could not be set up or launched). A failing entry
is reported and the campaign continues.

options:
  --fixture <dir>          the project every entry starts from; copied, never written
  --roster <file>          the roster YAML
  --answers <file>         the run --answers file every entry uses
  --prompt <text>          the task every entry is given
  --out <dir>              absent or empty directory for the copies, homes, logs and <NN-label>/entry.json
  --timeout <seconds>      each entry's run --timeout (default: none)
  --probe <ext>:<command>  extension command recorded as the desk's final status
  --autonomy default|yolo  every entry's autonomy (default: default); yolo is contained
  --json                   print the whole campaign as JSON

Exit codes: 0 when every entry was run (whatever each one's status), 1 when the
campaign itself failed, 2 on a usage error, and the signal's code when stopped.`;

class UsageError extends Error {}

const VALUE_FLAGS = new Set([
	"--fixture",
	"--roster",
	"--answers",
	"--prompt",
	"--out",
	"--timeout",
	"--probe",
	"--autonomy",
]);

interface Parsed {
	values: Map<string, string>;
	json: boolean;
}

function parse(args: ReadonlyArray<string>): Parsed {
	const parsed: Parsed = { values: new Map(), json: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (VALUE_FLAGS.has(arg)) {
			const value = args[i + 1];
			if (value === undefined) throw new UsageError(`${arg} needs a value`);
			if (parsed.values.has(arg)) throw new UsageError(`${arg} given more than once`);
			parsed.values.set(arg, value);
			i++;
			continue;
		}
		throw new UsageError(arg.startsWith("-") ? `unknown option: ${arg}` : `unexpected argument: ${arg}`);
	}
	return parsed;
}

function required(parsed: Parsed, flag: string): string {
	const value = parsed.values.get(flag);
	if (value === undefined || value.trim().length === 0) throw new UsageError(`campaign run needs ${flag}`);
	return value;
}

function probeOf(value: string | undefined): CampaignProbe | null {
	if (value === undefined) return null;
	const colon = value.indexOf(":");
	if (colon <= 0 || colon === value.length - 1)
		throw new UsageError(`--probe takes <extension>:<command>, got '${value}'`);
	return { extension: value.slice(0, colon), command: value.slice(colon + 1) };
}

function timeoutOf(value: string | undefined): number | null {
	if (value === undefined) return null;
	const seconds = Number(value);
	if (!Number.isInteger(seconds) || seconds <= 0)
		throw new UsageError("--timeout takes a positive whole number of seconds");
	return seconds;
}

function parentEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	return env;
}

const count = (value: number | null | undefined): string =>
	value === null || value === undefined ? "-" : String(value);

function deskCell(entry: CampaignEntryResult): string {
	if (entry.desk === null) return "-";
	const line = entry.desk.error !== null ? `probe error: ${entry.desk.error}` : (entry.desk.text ?? "");
	const first = line.split("\n")[0] ?? "";
	return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

function renderCampaign(result: CampaignResult): string {
	const rows = [
		["ENTRY", "STATUS", "EXIT", "GATES", "REFUSALS h/t", "LOOP", "INPUT", "FRESH", "CACHED", "OUTPUT", "WALL", "DESK"],
		...result.entries.map((entry) => {
			const { metrics } = entry;
			return [
				entry.label,
				entry.status,
				count(entry.exitCode),
				String(metrics.gates.reached.length),
				`${metrics.refusals.hookBlocks}/${metrics.refusals.toolRefusals}`,
				String(metrics.loopGuardBlocks),
				count(metrics.tokens?.input),
				count(metrics.tokens?.fresh),
				count(metrics.tokens?.cached),
				count(metrics.tokens?.output),
				entry.wallMs === null ? "-" : `${(entry.wallMs / 1000).toFixed(1)}s`,
				deskCell(entry),
			];
		}),
	];
	const notes = result.entries.flatMap((entry) => {
		const lines: string[] = [];
		if (entry.metrics.gates.reached.length > 0)
			lines.push(`${entry.label}: gates ${entry.metrics.gates.reached.join(", ")}`);
		if (entry.error !== null) lines.push(`${entry.label}: ${entry.error.split("\n").join(" / ")}`);
		return lines;
	});
	return `${formatColumns(rows)}${notes.length > 0 ? `\n${notes.join("\n")}\n` : ""}\nentries and logs under ${result.out}\n`;
}

async function runCommand(args: ReadonlyArray<string>): Promise<number> {
	const parsed = parse(args);
	const fixture = resolve(required(parsed, "--fixture"));
	const out = resolve(required(parsed, "--out"));
	const prompt = required(parsed, "--prompt");
	const rosterFile = resolve(required(parsed, "--roster"));
	const answersFile = resolve(required(parsed, "--answers"));
	const timeoutSeconds = timeoutOf(parsed.values.get("--timeout"));
	const probe = probeOf(parsed.values.get("--probe"));
	const autonomy = parsed.values.get("--autonomy") ?? "default";
	if (autonomy !== "default" && autonomy !== "yolo") throw new UsageError("--autonomy takes default or yolo");
	const roster = loadRoster(rosterFile);
	if ("error" in roster) throw new UsageError(roster.error);
	const answers = loadScriptedAnswers(answersFile);
	if ("error" in answers) throw new UsageError(answers.error);
	try {
		validateCampaignInput({ fixture, out, prompt });
	} catch (error) {
		if (error instanceof CampaignInputError) throw new UsageError(error.message);
		throw error;
	}
	if (autonomy === "yolo") {
		const refusal = containedYoloRefusal("campaign");
		if (refusal !== null) throw new UsageError(refusal);
	}
	const entry = process.argv[1];
	if (entry === undefined) throw new Error("cannot locate the clio-coder entry point to start entries");
	const { settings } = readLayeredSettings(fixture);
	// Each entry leads its own process group, so a signal to this one reaches it only through the abort.
	const controller = new AbortController();
	const stops = installStopSignals(controller);
	const result = await runCampaign({
		fixture,
		roster: roster.entries,
		answers: answersFile,
		prompt,
		out,
		timeoutSeconds,
		autonomy,
		probe,
		operatorConfig: clioConfigDir(),
		operatorComponents: operatorComponentsDir(),
		clio: { file: process.execPath, args: [...process.execArgv, entry] },
		env: parentEnv(),
		envPolicy: { targets: settings.targets, passEnv: settings.safety.sandboxPassEnv },
		signal: controller.signal,
		onProgress: (line) => process.stderr.write(`clio-coder campaign: ${line}\n`),
	}).finally(() => stops.dispose());
	process.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : renderCampaign(result));
	if (stops.received() !== null) return stops.exitCode();
	return 0;
}

export async function runCampaignCommand(args: string[]): Promise<number> {
	const [verb, ...rest] = args;
	if (verb === undefined || args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	try {
		if (verb !== "run") throw new UsageError(`unknown campaign command: ${verb}`);
		return await runCommand(rest);
	} catch (error) {
		if (error instanceof UsageError) {
			printError(`campaign: ${error.message}`, "see clio-coder campaign --help");
			return 2;
		}
		printError(`campaign: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
