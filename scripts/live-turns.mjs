#!/usr/bin/env node
/**
 * live-turns: drive the real interactive TUI through tmux for a multi-turn
 * session, waiting for each turn to settle by polling the session ledger.
 * Companion to turn-report.mjs; together they form the live measurement
 * harness for prompt/cache work.
 *
 * Usage:
 *   node scripts/live-turns.mjs --prompts-file <path> [--session-name <tmux>]
 *   node scripts/live-turns.mjs --baseline      # built-in 6-turn baseline
 *
 * Prompts file: one prompt per line, blank lines and # comments skipped.
 * Prints the Clio session id on success so it can be fed to turn-report.mjs.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const BASELINE_PROMPTS = [
	"hi",
	"working on you, the clio coder harness",
	"you misunderstood me",
	"where does the prompt compiler live in this repo and what calls it?",
	"read the three central dispatch modules and summarize the admission invariants",
	"thanks, that makes sense",
];

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * Resolve the Clio state dir through `clio paths --json` (the built dist in
 * this checkout), the single source of truth for directory resolution. The
 * embedded fallback exists only for a broken or missing dist and must mirror
 * src/core/xdg.ts.
 */
function stateDir() {
	const cliEntry = join(REPO_ROOT, "dist", "cli", "index.js");
	if (existsSync(cliEntry)) {
		try {
			const raw = execFileSync(process.execPath, [cliEntry, "paths", "--json"], {
				encoding: "utf8",
				timeout: 15_000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			const dirs = JSON.parse(raw);
			if (typeof dirs.data === "string" && dirs.data.length > 0) return dirs.data;
		} catch {
			// Broken dist; fall through to the embedded resolution.
		}
	}
	const env = (k) => {
		const v = process.env[k]?.trim();
		return v && v.length > 0 ? v : null;
	};
	const override = env("CLIO_STATE_DIR") ?? (env("CLIO_HOME") ? join(env("CLIO_HOME"), "state") : null);
	if (override) return override;
	const h = homedir();
	const p = platform();
	if (p === "win32") return join(process.env.LOCALAPPDATA ?? join(h, "AppData", "Local"), "clio", "state");
	if (p === "darwin") return join(h, "Library", "Application Support", "clio", "state");
	return join(process.env.XDG_STATE_HOME ?? join(h, ".local", "state"), "clio");
}

function parseArgs(argv) {
	const args = {
		promptsFile: null,
		baseline: false,
		sessionName: "clio-live-turns",
		turnTimeoutS: 600,
		cwd: process.cwd(),
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--prompts-file") args.promptsFile = argv[++i];
		else if (a === "--baseline") args.baseline = true;
		else if (a === "--session-name") args.sessionName = argv[++i];
		else if (a === "--turn-timeout") args.turnTimeoutS = Number(argv[++i]);
		else if (a === "--cwd") args.cwd = argv[++i];
		else if (a === "--help" || a === "-h") {
			console.log(
				"usage: live-turns.mjs (--baseline | --prompts-file <path>) [--session-name <tmux>] [--turn-timeout <s>] [--cwd <path>]",
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

function turnState(entries, turnIndex) {
	let users = 0;
	let sawNthUser = false;
	let settled = null;
	for (const e of entries) {
		if (e?.kind === "message" && e?.role === "user") {
			users += 1;
			if (users === turnIndex) sawNthUser = true;
			continue;
		}
		if (!sawNthUser || users !== turnIndex) continue;
		if (e?.kind === "message" && e?.role === "assistant" && TERMINAL_STOP.has(e?.payload?.stopReason)) {
			settled = e.payload.stopReason;
		}
	}
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
	const sessionsRoot = join(stateDir(), "sessions", hash);
	const before = new Set(existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []);
	const cliEntry = join(cwd, "dist", "cli", "index.js");
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
		if (state.settled === "error" || state.settled === "aborted") {
			console.error(`turn ${n}: terminal state ${state.settled}; stopping`);
			failed = true;
			break;
		}
		await sleep(1500); // let post-turn writes (usage, snapshots) flush
	}

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
	console.log(`inspect with: node scripts/turn-report.mjs --session ${sessionId}`);
	process.exit(failed ? 1 : 0);
}

main();
