/**
 * Drive the real TUI in a pseudo-terminal against a configured target.
 *
 * This is the scripted way to exercise `clio-coder` the way a person does:
 * the built entry is started under node-pty at a chosen size, each `--send`
 * is typed followed by Enter, and the driver waits for the right thing before
 * the next one. A prompt waits until the session ledger shows the assistant
 * turn settled (the last message is an assistant message with no tool call);
 * a slash command waits a fixed settle time for its output. At the end the
 * driver types `/quit`, and writes the stripped transcript, the raw bytes, the
 * session ledger, and a JSON report.
 *
 *   npm run live:tui -- --target <id> --workspace <dir> --send "<text>" [--send ...] [options]
 *
 * The PTY itself is tests/harness/pty.ts; this file is one consumer of it.
 * Agents that want an interactive pane instead should read SKILL.md.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openPty, type PtySession, ptySupported, stripAnsi } from "../../tests/harness/pty.js";
import {
	CLI_ENTRY,
	type LiveHome,
	LiveUsageError,
	parseLiveArgs,
	prepareLiveHome,
	rejectUnknown,
	requireBuild,
	runDriver,
	takeFlag,
	takeSwitch,
} from "./live-target.js";

const USAGE = `usage: npm run live:tui -- --target <id> --workspace <dir> (--send <text>)... [options]

Drives dist/cli/index.js in a real pseudo-terminal against a configured target.
Each --send is typed in order, followed by Enter. Text starting with "/" is a
slash command (waits --settle-ms); anything else is a prompt (waits until the
session ledger shows the assistant turn settled).

  --target <id>            configured target id (required)
  --model <wireId>         override the target's defaultModel
  --thinking <level>       off|minimal|low|medium|high|xhigh|max (default off)
  --workspace <dir>        repository to work in; copied into the scratch tree
  --in-place               run in --workspace itself instead of a copy
  --send <text>            input to type, repeatable, in order
  --cols <n> --rows <n>    terminal size (default 140x44)
  --out <dir>              where to write transcript.txt, raw.txt, ledger.jsonl, report.json
                           (default <scratch>/out)
  --turn-timeout-ms <ms>   how long one prompt may take to settle (default 900000)
  --settle-ms <ms>         wait after a slash command (default 3000)
  --keep                   retain the scratch tree on success
`;

/** The footer's context gauge: the first thing on screen that only appears once the app takes keys. */
const READY = /ctx /u;

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function findLedger(stateDir: string): string | null {
	const found: string[] = [];
	const visit = (dir: string): void => {
		let children: import("node:fs").Dirent[] = [];
		try {
			children = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const child of children) {
			const path = join(dir, child.name);
			if (child.isDirectory()) visit(path);
			else if (child.name === "current.jsonl") found.push(path);
		}
	};
	visit(join(stateDir, "sessions"));
	return found[0] ?? null;
}

function ledgerEntries(stateDir: string): Json[] {
	const ledger = findLedger(stateDir);
	if (!ledger) return [];
	return readFileSync(ledger, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.flatMap((line) => {
			try {
				const value: unknown = JSON.parse(line);
				return isJson(value) ? [value] : [];
			} catch {
				return [];
			}
		});
}

function messages(entries: Json[]): Json[] {
	return entries.filter((entry) => entry.kind === "message");
}

function userCount(entries: Json[]): number {
	return messages(entries).filter((entry) => entry.role === "user").length;
}

function turnSettled(entries: Json[]): boolean {
	const last = messages(entries).at(-1);
	if (last?.role !== "assistant") return false;
	const payload = isJson(last.payload) ? last.payload : undefined;
	const content = Array.isArray(payload?.content) ? payload.content : [];
	return !content.some((block) => isJson(block) && block.type === "toolCall");
}

interface Turn {
	sent: string;
	kind: "prompt" | "command";
	settled: boolean;
	ms: number;
	output: string;
}

async function drive(
	home: LiveHome,
	session: PtySession,
	sends: string[],
	turnTimeoutMs: number,
	settleMs: number,
): Promise<Turn[]> {
	const turns: Turn[] = [];
	for (const text of sends) {
		const mark = session.output.length;
		const startedAt = Date.now();
		const kind = text.startsWith("/") ? "command" : "prompt";
		let settled = false;
		if (kind === "command") {
			session.write(`${text}\r`);
			await sleep(settleMs);
			settled = true;
		} else {
			const before = userCount(ledgerEntries(home.stateDir));
			session.write(`${text}\r`);
			while (Date.now() - startedAt < turnTimeoutMs) {
				await sleep(1500);
				const entries = ledgerEntries(home.stateDir);
				if (userCount(entries) > before && turnSettled(entries)) {
					// The ledger settles before the last frame is painted.
					await sleep(2500);
					settled = true;
					break;
				}
			}
		}
		const turn: Turn = {
			sent: text,
			kind,
			settled,
			ms: Date.now() - startedAt,
			output: stripAnsi(session.output.slice(mark)),
		};
		turns.push(turn);
		process.stderr.write(`${kind} ${JSON.stringify(text)} settled=${settled} ${turn.ms}ms\n`);
		if (!settled) break;
	}
	return turns;
}

await runDriver(USAGE, async () => {
	if (!ptySupported) throw new LiveUsageError("node-pty has no Windows support in this harness");
	requireBuild();
	const args = parseLiveArgs(process.argv.slice(2));
	const workspaceArg = takeFlag(args.rest, "--workspace");
	if (!workspaceArg) throw new LiveUsageError("--workspace <dir> is required");
	const inPlace = takeSwitch(args.rest, "--in-place");
	const cols = Number.parseInt(takeFlag(args.rest, "--cols") ?? "140", 10);
	const rows = Number.parseInt(takeFlag(args.rest, "--rows") ?? "44", 10);
	const turnTimeoutMs = Number.parseInt(takeFlag(args.rest, "--turn-timeout-ms") ?? "900000", 10);
	const settleMs = Number.parseInt(takeFlag(args.rest, "--settle-ms") ?? "3000", 10);
	const outArg = takeFlag(args.rest, "--out");
	const sends: string[] = [];
	for (let text = takeFlag(args.rest, "--send"); text !== null; text = takeFlag(args.rest, "--send")) sends.push(text);
	rejectUnknown(args.rest);
	if (sends.length === 0) throw new LiveUsageError("at least one --send is required");
	for (const [name, value] of [
		["--cols", cols],
		["--rows", rows],
		["--turn-timeout-ms", turnTimeoutMs],
		["--settle-ms", settleMs],
	] as const) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new LiveUsageError(`${name} must be a positive integer`);
	}

	const home = prepareLiveHome(args, { prefix: "clio-live-tui-", autonomy: "full-auto" });
	const workspace = inPlace ? resolve(workspaceArg) : join(home.dir, "workspace");
	if (!inPlace) cpSync(resolve(workspaceArg), workspace, { recursive: true });
	const out = outArg ? resolve(outArg) : join(home.dir, "out");
	mkdirSync(out, { recursive: true });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...home.env })) if (value !== undefined) env[key] = value;

	process.stderr.write(
		`live tui: target=${home.target.id} model=${home.model} thinking=${home.thinking} ${cols}x${rows} workspace=${workspace}\n`,
	);
	let passed = false;
	let session: PtySession | null = null;
	try {
		session = await openPty(process.execPath, [CLI_ENTRY], { cols, rows, cwd: workspace, env });
		await session.waitForOutput((output) => READY.test(stripAnsi(output)), 90_000);
		await sleep(1500);
		const turns = await drive(home, session, sends, turnTimeoutMs, settleMs);
		// A slash command may have left an overlay open; Escape closes it so
		// /quit reaches the editor rather than the overlay.
		session.write("\u001b");
		await sleep(500);
		session.write("/quit\r");
		const exit = await session.waitForExit(15_000).catch(() => session?.killAndWaitForExit(5_000));

		const entries = ledgerEntries(home.stateDir);
		const ledger = findLedger(home.stateDir);
		if (ledger) writeFileSync(join(out, "ledger.jsonl"), readFileSync(ledger));
		writeFileSync(join(out, "raw.txt"), session.output, "utf8");
		writeFileSync(join(out, "transcript.txt"), stripAnsi(session.output), "utf8");
		const count = (predicate: (entry: Json) => boolean): number => entries.filter(predicate).length;
		const report = {
			target: home.target.id,
			model: home.model,
			thinking: home.thinking,
			workspace,
			cols,
			rows,
			exit: exit ?? null,
			turns: turns.map(({ output: _output, ...turn }) => turn),
			ledger: {
				path: ledger,
				entries: entries.length,
				userMessages: userCount(entries),
				assistantMessages: count((entry) => entry.kind === "message" && entry.role === "assistant"),
				toolResults: count((entry) => entry.kind === "message" && entry.role === "tool_result"),
				contextEviction: count((entry) => entry.kind === "contextEviction"),
				contextRecall: count((entry) => entry.kind === "contextRecall"),
				compactionSummary: count((entry) => entry.kind === "compactionSummary"),
			},
			out,
		};
		writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		passed = turns.length === sends.length && turns.every((turn) => turn.settled) && exit?.exitCode === 0;
	} finally {
		if (session && !session.exited) await session.killAndWaitForExit(5_000);
		home.cleanup(passed);
	}
	return passed;
});
