#!/usr/bin/env node
/**
 * turn-report: read-only forensics over Clio session ledgers.
 *
 * Prints one row per user turn: timestamp, truncated user text, gap from the
 * user message to the first assistant entry, per-API-call usage
 * (input/cacheRead/cacheWrite/output), tool-call count, and a derived
 * cache verdict:
 *
 *   hot      cacheRead > 0  and input < 2000   (prefix reused, prefill ~user text)
 *   partial  cacheRead > 0  and input >= 2000  (prefix reused up to a divergence point)
 *   cold     cacheRead == 0 and input >= 2000  (full re-prefill)
 *   small    cacheRead == 0 and input < 2000   (too small to judge)
 *
 * When entries carry persisted `timing` / `promptCache` payload fields, they
 * are reported as additional columns (ttft/api ms, backend verdict, expected
 * cold reasons).
 *
 * Usage:
 *   node scripts/turn-report.mjs                  # latest session for this cwd
 *   node scripts/turn-report.mjs --session <id>   # specific session
 *   node scripts/turn-report.mjs --all            # all sessions, slow turns only (gap > 20s)
 *   node scripts/turn-report.mjs --all --min-gap 5
 *   node scripts/turn-report.mjs --cwd /path/to/repo
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * Resolve the Clio data dir through `clio paths --json` (the built dist in
 * this checkout), the single source of truth for directory resolution. The
 * embedded fallback exists only for a broken or missing dist and must mirror
 * src/core/xdg.ts.
 */
function dataDir() {
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
	const override = env("CLIO_DATA_DIR") ?? (env("CLIO_HOME") ? join(env("CLIO_HOME"), "data") : null);
	if (override) return override;
	const h = homedir();
	const p = platform();
	if (p === "win32") return join(process.env.APPDATA ?? join(h, "AppData", "Roaming"), "clio");
	if (p === "darwin") return join(h, "Library", "Application Support", "clio");
	return join(process.env.XDG_DATA_HOME ?? join(h, ".local", "share"), "clio");
}

function cwdHash(cwd) {
	return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

function parseArgs(argv) {
	const args = { session: null, all: false, cwd: process.cwd(), minGap: 20 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--session") args.session = argv[++i];
		else if (a === "--latest") args.session = null;
		else if (a === "--all") args.all = true;
		else if (a === "--cwd") args.cwd = argv[++i];
		else if (a === "--min-gap") args.minGap = Number(argv[++i]);
		else if (a === "--help" || a === "-h") {
			console.log("usage: turn-report.mjs [--session <id> | --latest | --all] [--cwd <path>] [--min-gap <s>]");
			process.exit(0);
		} else {
			console.error(`unknown argument: ${a}`);
			process.exit(2);
		}
	}
	return args;
}

function readJsonl(path) {
	if (!existsSync(path)) return [];
	const out = [];
	const lines = readFileSync(path, "utf8").split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// torn tail or corrupt line: skip, forensics must not throw
		}
	}
	return out;
}

function listSessions(sessionsRoot) {
	if (!existsSync(sessionsRoot)) return [];
	return readdirSync(sessionsRoot)
		.map((id) => {
			const dir = join(sessionsRoot, id);
			const ledger = join(dir, "current.jsonl");
			if (!existsSync(ledger)) return null;
			let sortKey = statSync(ledger).mtimeMs;
			try {
				const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
				const t = Date.parse(meta.endedAt ?? meta.createdAt ?? "");
				if (Number.isFinite(t)) sortKey = Math.max(sortKey, t);
			} catch {
				// no meta or unreadable: mtime is enough
			}
			return { id, dir, sortKey };
		})
		.filter(Boolean)
		.sort((a, b) => a.sortKey - b.sortKey);
}

function verdictFor(input, cacheRead) {
	const inTok = input ?? 0;
	const cr = cacheRead ?? 0;
	if (cr > 0) return inTok >= 2000 ? "partial" : "hot";
	return inTok >= 2000 ? "cold" : "small";
}

function buildTurns(entries) {
	const turns = [];
	let turn = null;
	for (const e of entries) {
		if (e?.type === "session") continue;
		if (e?.kind === "message" && e?.role === "user") {
			turn = {
				timestamp: e.timestamp ?? null,
				text: typeof e.payload?.text === "string" ? e.payload.text : "",
				firstAssistantAt: null,
				calls: [],
				toolCalls: 0,
				expectedColdReasons: [],
			};
			turns.push(turn);
			continue;
		}
		if (!turn) continue;
		if (e?.kind === "message" && e?.role === "assistant") {
			if (!turn.firstAssistantAt) turn.firstAssistantAt = e.timestamp ?? null;
			const usage = e.payload?.usage;
			const timing = e.payload?.timing;
			const promptCache = e.payload?.promptCache;
			if (promptCache?.expectedColdReasons?.length) {
				turn.expectedColdReasons.push(...promptCache.expectedColdReasons);
			}
			if (usage) {
				turn.calls.push({
					input: usage.input ?? 0,
					cacheRead: usage.cacheRead ?? 0,
					cacheWrite: usage.cacheWrite ?? 0,
					output: usage.output ?? 0,
					ttftMs: timing?.ttftMs ?? null,
					apiMs: timing?.apiMs ?? null,
					backendVerdict: promptCache?.backendVerdict ?? null,
				});
			}
			const content = Array.isArray(e.payload?.content) ? e.payload.content : [];
			turn.toolCalls += content.filter((c) => c?.type === "toolCall").length;
		}
	}
	return turns;
}

function gapSeconds(turn) {
	if (!turn.timestamp || !turn.firstAssistantAt) return null;
	const gap = (Date.parse(turn.firstAssistantAt) - Date.parse(turn.timestamp)) / 1000;
	return Number.isFinite(gap) ? gap : null;
}

function fmtGap(gap) {
	return gap === null ? "    -" : `${gap.toFixed(1).padStart(5)}s`;
}

function truncate(text, n) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

function fmtCall(c) {
	let s = `in=${c.input} cr=${c.cacheRead} cw=${c.cacheWrite} out=${c.output}`;
	if (c.ttftMs !== null) s += ` ttft=${c.ttftMs}ms`;
	if (c.apiMs !== null) s += ` api=${c.apiMs}ms`;
	if (c.backendVerdict) s += ` backend=${c.backendVerdict}`;
	return s;
}

function printTurn(turn, { compact = false } = {}) {
	const first = turn.calls[0];
	const verdict = first ? verdictFor(first.input, first.cacheRead) : "-";
	const time = turn.timestamp ? new Date(turn.timestamp).toISOString().slice(11, 19) : "--:--:--";
	const header = [
		time,
		verdict.padEnd(7),
		fmtGap(gapSeconds(turn)),
		`calls=${String(turn.calls.length).padStart(2)}`,
		`tools=${String(turn.toolCalls).padStart(2)}`,
		JSON.stringify(truncate(turn.text, 56)),
	].join("  ");
	console.log(header);
	if (turn.expectedColdReasons.length) {
		console.log(`          expected-cold: ${[...new Set(turn.expectedColdReasons)].join(", ")}`);
	}
	if (compact) {
		if (first) console.log(`          first call: ${fmtCall(first)}`);
		return;
	}
	turn.calls.forEach((c, i) => {
		console.log(`          call ${String(i + 1).padStart(2)}: ${fmtCall(c)}  [${verdictFor(c.input, c.cacheRead)}]`);
	});
}

function printSnapshotSummary(dir) {
	const snaps = readJsonl(join(dir, "context-snapshots.jsonl"));
	const last = snaps.at(-1);
	if (!last?.categories) return;
	const c = last.categories;
	const parts = ["system", "tools", "agents", "skills", "memory", "project", "messages"]
		.filter((k) => (c[k] ?? 0) > 0)
		.map((k) => `${k}=${c[k]}`);
	console.log(
		`  shell (last snapshot): ${parts.join(" ")}${last.toolSignature ? ` toolSig=${String(last.toolSignature).slice(0, 8)}` : ""}`,
	);
}

function reportSession(session, { slowOnly = false, minGap = 20 } = {}) {
	const entries = readJsonl(join(session.dir, "current.jsonl"));
	const turns = buildTurns(entries);
	const shown = slowOnly ? turns.filter((t) => (gapSeconds(t) ?? 0) > minGap) : turns;
	if (slowOnly && shown.length === 0) return false;
	console.log(`\nsession ${session.id}`);
	printSnapshotSummary(session.dir);
	if (turns.length === 0) {
		console.log("  (no user turns)");
		return true;
	}
	for (const turn of shown) printTurn(turn, { compact: slowOnly });
	return true;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const sessionsRoot = join(dataDir(), "sessions", cwdHash(args.cwd));
	const sessions = listSessions(sessionsRoot);
	if (sessions.length === 0) {
		console.error(`no sessions found under ${sessionsRoot}`);
		process.exit(1);
	}
	if (args.all) {
		console.log(`scanning ${sessions.length} sessions for turns with gap > ${args.minGap}s`);
		let any = false;
		for (const s of sessions) any = reportSession(s, { slowOnly: true, minGap: args.minGap }) || any;
		if (!any) console.log("no slow turns found");
		return;
	}
	const session = args.session ? sessions.find((s) => s.id === args.session) : sessions.at(-1);
	if (!session) {
		console.error(`session ${args.session} not found under ${sessionsRoot}`);
		process.exit(1);
	}
	reportSession(session);
}

main();
