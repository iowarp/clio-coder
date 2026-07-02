#!/usr/bin/env node
/**
 * live-turns: drive the real interactive TUI through tmux for a multi-turn
 * session, waiting for each turn to settle by polling the session ledger.
 * Companion to turn-report.mjs; together they form the live measurement
 * harness for prompt/cache work.
 *
 * Usage:
 *   node benchmarks/live/live-turns.mjs --prompts-file <path> [--session-name <tmux>]
 *   node benchmarks/live/live-turns.mjs --baseline      # built-in 6-turn baseline
 *
 * --cwd points at the TARGET repo the agent operates on (defaults to the
 * current directory). --clio-entry points at the built CLI entry to execute
 * (defaults to this checkout's dist/cli/index.js), so the harness can drive
 * the installed clio against an arbitrary clone without that clone owning a
 * dist build of its own.
 *
 * Prompts file: one prompt per line, blank lines and # comments skipped.
 * Prints the Clio session id on success so it can be fed to turn-report.mjs.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { clioStateDir } from "../lib/clio-paths.mjs";

const BASELINE_PROMPTS = [
	"hi",
	"working on you, the clio coder harness",
	"you misunderstood me",
	"where does the prompt compiler live in this repo and what calls it?",
	"read the three central dispatch modules and summarize the admission invariants",
	"thanks, that makes sense",
];

const OVERLAY_COMMANDS = ["/targets", "/model", "/settings", "/agents", "/skill", "/help"];

// Repo root is two levels up from benchmarks/live/.
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const DEFAULT_CLIO_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");

function parseArgs(argv) {
	const args = {
		promptsFile: null,
		baseline: false,
		sessionName: "clio-live-turns",
		turnTimeoutS: 600,
		cwd: process.cwd(),
		clioEntry: DEFAULT_CLIO_ENTRY,
		captureDir: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--prompts-file") args.promptsFile = argv[++i];
		else if (a === "--baseline") args.baseline = true;
		else if (a === "--session-name") args.sessionName = argv[++i];
		else if (a === "--turn-timeout") args.turnTimeoutS = Number(argv[++i]);
		else if (a === "--cwd") args.cwd = argv[++i];
		else if (a === "--clio-entry") args.clioEntry = argv[++i];
		else if (a === "--capture-dir") args.captureDir = argv[++i];
		else if (a === "--help" || a === "-h") {
			console.log(
				"usage: live-turns.mjs (--baseline | --prompts-file <path>) [--session-name <tmux>] [--turn-timeout <s>] [--cwd <path>] [--clio-entry <path>] [--capture-dir <path>]",
			);
			process.exit(0);
		} else {
			console.error(`unknown argument: ${a}`);
			process.exit(2);
		}
	}
	return args;
}

function tmux(args, opts = {}) {
	return execFileSync("tmux", args, { encoding: "utf8", ...opts });
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

let snapshotSeq = 0;

function snapshotPane(sessionName, captureDir, label) {
	if (!captureDir) return;
	mkdirSync(captureDir, { recursive: true });
	snapshotSeq += 1;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const safeLabel = label.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "");
	const file = join(captureDir, `${String(snapshotSeq).padStart(3, "0")}-${stamp}-${safeLabel}.txt`);
	try {
		const pane = tmux(["capture-pane", "-p", "-t", sessionName]);
		writeFileSync(file, pane);
	} catch {
		// pane not available; skip this snapshot
	}
}

function readLedgerEntries(ledgerPath) {
	if (!existsSync(ledgerPath)) return [];
	const out = [];
	for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// torn tail: ignore
		}
	}
	return out;
}

const TERMINAL_STOP = new Set(["stop", "length", "error", "aborted"]);

// artifact(kind="plan"|"review"|"report") sets ToolResult.terminate=true so
// pi-agent-core skips the follow-up LLM call; that call would otherwise have
// produced the assistant message carrying the terminal stopReason this
// function looks for. A turn that ends on a terminal artifact write never
// gets that message, so it is recognized here as settled once its
// tool_result is the last entry for the turn (see FINDINGS.md F2).
// artifact(kind="skill") is not terminal and must not settle the turn.
const TERMINAL_ARTIFACT_KINDS = new Set(["plan", "review", "report"]);

function isTerminalToolCall(payload) {
	if (payload?.name !== "artifact") return false;
	const kind = payload?.args?.kind;
	return typeof kind === "string" && TERMINAL_ARTIFACT_KINDS.has(kind);
}

function isSyntheticUserMessage(entry) {
	return entry?.kind === "message" && entry?.role === "user" && entry?.payload?.synthetic === true;
}

function turnState(entries, turnIndex) {
	let users = 0;
	let sawNthUser = false;
	let settled = null;
	let lastToolCallWasTerminal = false;
	let sawTerminalToolResult = false;
	for (const e of entries) {
		if (e?.kind === "message" && e?.role === "user" && !isSyntheticUserMessage(e)) {
			users += 1;
			if (users === turnIndex) sawNthUser = true;
			continue;
		}
		if (!sawNthUser || users !== turnIndex) continue;
		if (e?.kind === "message" && e?.role === "tool_call" && typeof e?.payload?.name === "string") {
			lastToolCallWasTerminal = isTerminalToolCall(e.payload);
			continue;
		}
		if (e?.kind === "message" && e?.role === "tool_result") {
			sawTerminalToolResult = lastToolCallWasTerminal;
			continue;
		}
		if (e?.kind === "message" && e?.role === "assistant") {
			sawTerminalToolResult = false;
			if (TERMINAL_STOP.has(e?.payload?.stopReason)) settled = e.payload.stopReason;
		}
	}
	if (!settled && sawTerminalToolResult) settled = "stop";
	return { users, settled };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	let prompts;
	if (args.baseline) {
		prompts = BASELINE_PROMPTS;
	} else if (args.promptsFile) {
		prompts = readFileSync(args.promptsFile, "utf8")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#"));
	} else {
		console.error("need --baseline or --prompts-file");
		process.exit(2);
	}
	if (prompts.length === 0) {
		console.error("no prompts to send");
		process.exit(2);
	}

	const cwd = resolve(args.cwd);
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const sessionsRoot = join(clioStateDir(), "sessions", hash);
	const before = new Set(existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []);
	const cliEntry = resolve(args.clioEntry);
	if (!existsSync(cliEntry)) {
		console.error(`built CLI not found at ${cliEntry}; run npm run build first`);
		process.exit(1);
	}

	try {
		tmux(["kill-session", "-t", args.sessionName], { stdio: "ignore" });
	} catch {
		// no stale session: fine
	}
	console.log(`starting TUI in tmux session ${args.sessionName} (cwd ${cwd})`);
	tmux(["new-session", "-d", "-s", args.sessionName, "-x", "220", "-y", "50", "-c", cwd, "node", cliEntry]);

	// The TUI creates the session directory lazily on the first submit, so
	// boot readiness is detected from the pane (idle footer), and the session
	// directory is discovered after turn 1 is sent.
	const bootDeadline = Date.now() + 60_000;
	let booted = false;
	while (Date.now() < bootDeadline) {
		await sleep(1000);
		try {
			if (tmux(["capture-pane", "-p", "-t", args.sessionName]).includes("idle")) {
				booted = true;
				break;
			}
		} catch {
			// pane not ready yet
		}
	}
	if (!booted) {
		console.error("TUI did not reach idle state within 60s");
		try {
			console.error(tmux(["capture-pane", "-p", "-t", args.sessionName]));
		} catch {
			// pane already gone
		}
		tmux(["kill-session", "-t", args.sessionName]);
		process.exit(1);
	}
	await sleep(2000);
	snapshotPane(args.sessionName, args.captureDir, "boot-idle");

	let sessionDir = null;
	let sessionId = null;
	let ledger = null;
	let failed = false;
	for (let i = 0; i < prompts.length; i++) {
		const n = i + 1;
		const prompt = prompts[i];
		console.log(`turn ${n}/${prompts.length}: ${JSON.stringify(prompt)}`);
		tmux(["send-keys", "-t", args.sessionName, "-l", "--", prompt]);
		await sleep(300);
		tmux(["send-keys", "-t", args.sessionName, "Enter"]);
		await sleep(3000);
		snapshotPane(args.sessionName, args.captureDir, `turn-${n}-mid-stream`);
		if (!sessionDir) {
			const sessionDeadline = Date.now() + 30_000;
			while (Date.now() < sessionDeadline) {
				const now = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
				const fresh = now.filter((id) => !before.has(id));
				if (fresh.length >= 1) {
					if (fresh.length > 1) {
						console.error(`multiple new sessions appeared (${fresh.join(", ")}); aborting`);
						tmux(["kill-session", "-t", args.sessionName]);
						process.exit(1);
					}
					sessionId = fresh[0];
					sessionDir = join(sessionsRoot, sessionId);
					ledger = join(sessionDir, "current.jsonl");
					console.log(`session ${sessionId}`);
					break;
				}
				await sleep(500);
			}
			if (!sessionDir) {
				console.error("no session directory appeared after the first submit");
				tmux(["kill-session", "-t", args.sessionName]);
				process.exit(1);
			}
		}
		const deadline = Date.now() + args.turnTimeoutS * 1000;
		let state = { users: 0, settled: null };
		while (Date.now() < deadline) {
			await sleep(1000);
			state = turnState(readLedgerEntries(ledger), n);
			if (state.users >= n && state.settled) break;
		}
		if (state.users < n) {
			console.error(`turn ${n}: user message never reached the ledger (TUI input failed?)`);
			failed = true;
			break;
		}
		if (!state.settled) {
			console.error(`turn ${n}: did not settle within ${args.turnTimeoutS}s`);
			failed = true;
			break;
		}
		console.log(`turn ${n}: settled (${state.settled})`);
		snapshotPane(args.sessionName, args.captureDir, `turn-${n}-settled-${state.settled}`);
		if (state.settled === "error" || state.settled === "aborted") {
			console.error(`turn ${n}: terminal state ${state.settled}; stopping`);
			failed = true;
			break;
		}
		await sleep(1500); // let post-turn writes (usage, snapshots) flush
	}

	if (!failed) {
		for (const overlay of OVERLAY_COMMANDS) {
			console.log(`overlay: ${overlay}`);
			tmux(["send-keys", "-t", args.sessionName, "-l", "--", overlay]);
			await sleep(300);
			tmux(["send-keys", "-t", args.sessionName, "Enter"]);
			await sleep(800);
			snapshotPane(args.sessionName, args.captureDir, `overlay-${overlay.slice(1)}`);
			tmux(["send-keys", "-t", args.sessionName, "Escape"]);
			await sleep(300);
		}
	}

	snapshotPane(args.sessionName, args.captureDir, "pre-exit");
	try {
		tmux(["send-keys", "-t", args.sessionName, "-l", "--", "/exit"]);
		await sleep(300);
		tmux(["send-keys", "-t", args.sessionName, "Enter"]);
		await sleep(3000);
	} catch {
		// pane may already be gone
	}
	try {
		tmux(["kill-session", "-t", args.sessionName], { stdio: "ignore" });
	} catch {
		// already exited
	}
	console.log(`done. session id: ${sessionId}`);
	console.log(`inspect with: node benchmarks/live/turn-report.mjs --session ${sessionId}`);
	process.exit(failed ? 1 : 0);
}

main();
