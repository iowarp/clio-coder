/**
 * Deferred package-manager update (#436). A package-manager install is
 * replaced in place, and tsup's code splitting loads chunks lazily, so an
 * overwrite while any Clio process of that install runs breaks its next
 * dynamic import. The session therefore never updates itself: on quit it
 * starts one detached wrapper that waits until no process of the install is
 * left, runs the package manager for the exact version, and leaves a result
 * file the next launch reports.
 */

import * as cp from "node:child_process";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import * as os from "node:os";
import { homedir } from "node:os";
import * as path from "node:path";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { processBirthToken } from "../../core/process-identity.js";
import type { Installation } from "./install-method.js";

const PACKAGE_NAME = "@iowarp/clio-coder";
/** Longest a wrapper waits for the install's processes to exit before it gives up for this quit. */
export const DEFERRED_WAIT_MS = 30 * 60_000;
/** Cap on the package-manager run itself. */
export const DEFERRED_RUN_MS = 10 * 60_000;
/** A wrapper lease older than this is dead, whatever host wrote it; the launcher uses the same cap. */
const DEFERRED_LEASE_CAP_MS = 30 * 60_000;
/** A foreign launch registration not touched for this long belongs to a crashed session (it beats every 5 min). */
const ACTIVE_BEAT_CAP_MS = 15 * 60_000;
/** A foreign record dated further ahead than this is stale, never live forever (#436). */
const FOREIGN_SKEW_MS = 5 * 60_000;
/** Newest logs kept per install root. */
const LOG_RETENTION = 5;

export type DeferredManager = "npm" | "volta" | "pnpm" | "bun";

export interface DeferredTarget {
	manager: DeferredManager;
	/** Real package root the manager replaces. */
	root: string;
	/** Directory the manager writes the launcher into. */
	bin: string;
	/**
	 * Directory above the package root that survives the replacement. It holds
	 * `.clio-coder-update.json` (the wrapper's lease the launcher waits on) and
	 * `.clio-coder-active/<pid>` (one file per running Clio of this install).
	 */
	hold: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	/** npm only: fetch the tarball into the cache first, so the retire-to-restore gap is extraction only. */
	prefetch?: string[];
	/** Stable path of the installed package.json after the update; null when the manager offers none (volta). */
	versionFile: string | null;
}

export interface DeferredResult {
	at: number;
	from: string;
	to: string;
	ok: boolean;
	exitCode: number | null;
	detail: string;
	log: string;
	manager: DeferredManager;
	/** The wrapper gave up waiting for running sessions; not a failed update. */
	deferred?: boolean;
	/** The wrapper that wrote it; the launcher ends its wait only on its lease holder's result. */
	pid?: number;
}

function real(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/** Owned by this (non-root) user and accepts a new file, tested without sudo. */
function userWritable(dir: string): boolean {
	const uid = process.getuid?.();
	if (uid === undefined || uid === 0) return false;
	try {
		if (statSync(dir).uid !== uid) return false;
		const probe = join(dir, `.clio-coder-write-${process.pid}`);
		closeSync(openSync(probe, "wx", 0o600));
		unlinkSync(probe);
		return true;
	} catch {
		return false;
	}
}

/** True when `bin/clio-coder` is the launcher of this very package root. */
function launcherOf(bin: string, root: string): boolean {
	const target = real(join(bin, "clio-coder"));
	return target !== null && (target === root || target.startsWith(root + sep));
}

function onPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		// A relative entry would resolve against whatever cwd the wrapper has.
		if (!dir || !isAbsolute(dir)) continue;
		const candidate = real(join(dir, name));
		if (candidate) return candidate;
	}
	return null;
}

/**
 * The manager, directories and exact command that would replace this install
 * with `version`, or null when the session must keep the notice instead:
 * Windows, root, sudo, a prefix this user cannot write, homebrew, winget,
 * native installs and every unknown layout.
 */
export function deferredUpdateTarget(installation: Installation, version: string): DeferredTarget | null {
	if (process.platform === "win32" || process.env.SUDO_USER) return null;
	if (!["npm", "pnpm", "bun"].includes(installation.kind) || installation.installer) return null;
	const root = real(installation.root);
	if (root === null || basename(dirname(root)) !== "@iowarp" || basename(dirname(dirname(root))) !== "node_modules")
		return null;
	const hold = dirname(dirname(root));
	const spec = `${PACKAGE_NAME}@${version}`;
	let target: DeferredTarget | null = null;
	if (installation.kind === "npm" && installation.prefix) {
		const prefix = real(installation.prefix);
		if (prefix === null) return null;
		const voltaEnv = process.env.VOLTA_HOME ? real(process.env.VOLTA_HOME) : null;
		const volta = prefix.split(sep).indexOf(".volta");
		const voltaHome =
			voltaEnv && prefix.startsWith(voltaEnv + sep)
				? voltaEnv
				: volta !== -1
					? prefix
							.split(sep)
							.slice(0, volta + 1)
							.join(sep)
					: null;
		if (voltaHome && prefix.includes(`${sep}tools${sep}image${sep}packages${sep}`)) {
			const home = voltaHome;
			const bin = join(home, "bin");
			if (!existsSync(join(bin, "volta"))) return null;
			target = {
				manager: "volta",
				root,
				bin,
				hold,
				command: join(bin, "volta"),
				args: ["install", spec],
				env: { VOLTA_HOME: home },
				// Volta's image path is per version; success is its exit status alone.
				versionFile: null,
			};
		} else {
			const bin = join(prefix, "bin");
			if (!launcherOf(bin, root)) return null;
			// nvm and fnm prefixes carry their own node and npm; any other prefix
			// uses the npm beside the node running this session. Nothing resolves
			// through PATH, which differs in a detached child.
			const node = existsSync(join(prefix, "bin", "node")) ? join(prefix, "bin", "node") : process.execPath;
			const npmCli = [
				join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
				join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
			].find((candidate) => existsSync(candidate));
			if (!npmCli) return null;
			target = {
				manager: "npm",
				root,
				bin,
				hold,
				command: node,
				args: [
					npmCli,
					"install",
					"-g",
					"--prefix",
					prefix,
					spec,
					"--prefer-offline",
					"--no-fund",
					"--no-audit",
					"--loglevel=error",
				],
				env: {},
				// npm retires the old package before it fetches; with the tarball
				// already cached the gap a launch can hit is extraction only.
				prefetch: [npmCli, "cache", "add", spec, "--loglevel=error"],
				versionFile: join(root, "package.json"),
			};
		}
	} else if (installation.kind === "pnpm") {
		const parts = root.split(sep);
		const global = parts.lastIndexOf("global");
		if (global < 1) return null;
		const globalDir = parts.slice(0, global + 1).join(sep);
		const pnpmHome = process.env.PNPM_HOME ? real(process.env.PNPM_HOME) : null;
		const bin = pnpmHome ?? dirname(globalDir);
		if (!launcherOf(bin, root) && !existsSync(join(bin, "clio-coder"))) return null;
		const pnpm = existsSync(join(bin, "pnpm")) ? real(join(bin, "pnpm")) : onPath("pnpm");
		if (!pnpm) return null;
		// An npm-installed pnpm is a JS file whose shebang finds node on PATH;
		// run it under this session's node instead. A standalone pnpm is a binary.
		const script = /\.(c|m)?js$/u.test(pnpm);
		const layout = parts[global + 1];
		target = {
			manager: "pnpm",
			root,
			bin,
			hold,
			command: script ? process.execPath : pnpm,
			// A plain global add resolves the global dir and bin from PNPM_HOME
			// and the operator's own pnpm config, exactly as the install was made;
			// --global-dir alone would derive <dir>/../bin instead. pnpm refuses
			// unless that bin is on PATH, so the child gets it first.
			args: [...(script ? [pnpm] : []), "add", "-g", spec],
			env: { PNPM_HOME: bin, PATH: `${bin}:${process.env.PATH ?? ""}` },
			// The root is the per-version store copy; the global layout's link is stable.
			versionFile:
				layout && /^\d+$/u.test(layout)
					? join(globalDir, layout, "node_modules", "@iowarp", "clio-coder", "package.json")
					: null,
		};
	} else if (installation.kind === "bun") {
		const marker = `${sep}install${sep}global${sep}`;
		const at = root.indexOf(marker);
		if (at < 1) return null;
		const bunInstall = root.slice(0, at);
		const bin = join(bunInstall, "bin");
		if (!existsSync(join(bin, "bun"))) return null;
		target = {
			manager: "bun",
			root,
			bin,
			hold,
			command: join(bin, "bun"),
			args: ["add", "-g", spec],
			env: { BUN_INSTALL: bunInstall },
			versionFile: join(root, "package.json"),
		};
	}
	if (target === null) return null;
	// npm rewrites the @iowarp scope directory too; one left root-owned by an
	// earlier sudo install would fail the update and back it off for a day.
	return userWritable(target.hold) && userWritable(dirname(target.root)) && userWritable(target.bin) ? target : null;
}

function pruneLogs(dir: string, fingerprint: string): void {
	try {
		const logs = readdirSync(dir)
			.filter((name) => name.startsWith(`${fingerprint}-`) && name.endsWith(".log"))
			.sort();
		for (const name of logs.slice(0, Math.max(0, logs.length - (LOG_RETENTION - 1))))
			rmSync(join(dir, name), { force: true });
	} catch {
		// Retention is housekeeping; a failure never blocks the update.
	}
}

/** Fixed word in every wrapper's argv: its JSON payload names the install root, so without it two wrappers held each other until their deadline. */
export const WRAPPER_SENTINEL = "--clio-coder-deferred-update";

/**
 * Holder judging, one source for the wrapper (pasted into its `node -e`
 * script) and for the TypeScript callers (`installHold`), so the shell
 * `upgrade`, `/upgrade` and the wrapper agree on host id, birth token, caps
 * and skew by construction. Plain JavaScript over the `fs`, `path`, `cp` and
 * `os` bindings its host supplies; it may import nothing (#436).
 *
 * Registration in `<hold>/.clio-coder-active` by bin/clio-coder.cjs is the
 * guard: process.title rewrites argv in the CLI and worker entries, so the
 * ps scan only catches processes started without the launcher and not yet
 * retitled. The restart handoff and workspace panes relaunch through the
 * launcher (core/relaunch-script.ts), because a pane outlives its launching
 * parent and a restart child outlives a killed guardian. A wrapper carries
 * WRAPPER_SENTINEL and is never a holder: a waiting one has staked nothing,
 * and a staked one holds through its lease.
 *
 * Every record carries a host id (machine-id plus host name, else the host
 * name) and, on Linux, the pid's birth token. A record from this host is
 * judged by its pid and token; a foreign record is held until it ages out,
 * because a pid from another machine on a shared home says nothing here.
 *
 * The age caps (lease 30 min from its start, launch registration 15 min from
 * its last 5 min heartbeat) compare another host's timestamps with this
 * host's clock, so clock skew between hosts shortens or stretches them by the
 * skew, and a foreign host suspended past 15 min has its sessions reclaimed
 * here while they sleep; if it wakes after the update, those sessions hit
 * replaced files on their next lazy import. A foreign record dated more than
 * five minutes ahead of this clock is judged stale, so a skewed or planted record
 * cannot hold the install forever. Same-host records never depend on either
 * cap. bin/clio-coder.cjs repeats the lease cap and skew guard, because it
 * must parse on any Node before it can load anything.
 */
const HOLD_SOURCE = String.raw`
function holdOf(p) {
	const marker = path.join(p.hold, ".clio-coder-update.json");
	const active = path.join(p.hold, ".clio-coder-active");
	const hostId = () => { for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) { try { const v = fs.readFileSync(f, "utf8").trim(); if (v) return v + ":" + os.hostname(); } catch {} } return os.hostname(); };
	const HOST = hostId();
	const birth = (pid) => { try { const s = fs.readFileSync("/proc/" + pid + "/stat", "utf8"); return s.slice(s.lastIndexOf(")") + 2).split(" ")[19] || null; } catch { return null; } };
	const alive = (pid) => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
	const running = (r) => alive(r.pid) && (!r.birth || birth(r.pid) === null || birth(r.pid) === r.birth);
	const skip = new Set(p.skip || [process.pid]);
	const psSkip = new Set([...skip, ...(p.psSkip || [])]);
	let staked = false;
	// Judge one record; a stale one is removed. Returns "pid@host" while it holds the install.
	function judge(file, r, ageMs, cap) {
		if (r.host === HOST || (!r.host && r.hostname === os.hostname())) {
			if (running(r)) return r.pid + "@" + (r.hostname || os.hostname());
		} else if (ageMs <= cap && ageMs >= -${FOREIGN_SKEW_MS}) return r.pid + "@" + (r.hostname || r.host || "an unrecorded host");
		try { fs.unlinkSync(file); } catch {}
		return null;
	}
	// The live update lease of another process, as "update pid@host"; an empty
	// or torn one (a stake that died between create and write) holds only
	// until the cap, judged by its file time.
	function lease() {
		let text = null, mtime = 0;
		try { mtime = fs.statSync(marker).mtimeMs; text = fs.readFileSync(marker, "utf8"); } catch { return null; }
		let m = null;
		try { m = JSON.parse(text); } catch {}
		if (!m || !Number.isSafeInteger(m.pid)) {
			if (Date.now() - mtime > ${DEFERRED_LEASE_CAP_MS}) { try { fs.unlinkSync(marker); } catch {} return null; }
			return { holder: "update (unreadable lease)", readable: false };
		}
		if (staked && m.pid === process.pid) return null;
		const h = judge(marker, m, Date.now() - Number(m.startedAt), ${DEFERRED_LEASE_CAP_MS});
		return h ? { holder: "update " + h, readable: true } : null;
	}
	function holders() {
		const found = [];
		const held = lease();
		if (held) found.push(held.holder);
		let names = [];
		try { names = fs.readdirSync(active); } catch {}
		for (const name of names) {
			const pid = Number(name);
			if (!Number.isSafeInteger(pid) || pid <= 0 || skip.has(pid)) continue;
			const file = path.join(active, name);
			let r, mtime = 0;
			try { mtime = fs.statSync(file).mtimeMs; const text = fs.readFileSync(file, "utf8").trim(); r = text.startsWith("{") ? JSON.parse(text) : { hostname: text }; } catch { continue; }
			// Live launches touch their file every few minutes; a foreign one that
			// stopped beating crashed with its host.
			const h = judge(file, Object.assign({ pid }, r), Date.now() - mtime, ${ACTIVE_BEAT_CAP_MS});
			if (h) found.push(h);
		}
		const psEnv = Object.assign({}, process.env); delete psEnv.COLUMNS;
		const ps = cp.spawnSync("ps", ["-Aww", "-o", "pid=", "-o", "args="], { encoding: "utf8", env: psEnv });
		for (const line of (ps.stdout || "").split("\n")) {
			const m = /^\s*(\d+)\s+(.*)$/.exec(line);
			if (m && !psSkip.has(Number(m[1])) && !m[2].includes(${JSON.stringify(WRAPPER_SENTINEL)}) && m[2].includes(p.root + path.sep)) found.push(m[1] + "@" + os.hostname());
		}
		return found;
	}
	// Exclusive: EEXIST means another holder staked first. The record carries
	// what bin/clio-coder.cjs reads (pid, host, birth, manager, startedAt, log).
	function stake(fields) {
		let fd = null;
		try {
			fd = fs.openSync(marker, "wx", 0o600);
			fs.writeSync(fd, JSON.stringify(Object.assign({ pid: process.pid, host: HOST, hostname: os.hostname(), birth: birth(process.pid), startedAt: Date.now() }, fields)) + "\n");
			fs.closeSync(fd);
			staked = true;
			return true;
		} catch (e) {
			if (e.code === "EEXIST") return false;
			// We created it but could not fill it (quota, full disk): never leave
			// an empty lease behind for every later launch to wait on.
			if (fd !== null) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(marker); } catch {} }
			throw e;
		}
	}
	const unstake = () => { if (staked) { try { fs.unlinkSync(marker); } catch {} staked = false; } };
	return { marker, birth, alive, lease, holders, stake, unstake };
}`;

/**
 * The detached wrapper, run as `node -e`. It loads no file from the package it
 * is about to replace and imports no Clio module, so the replacement cannot
 * pull code out from under it. Steps: prefetch (npm); wait for the parent
 * session; exit at once while another holder's lease is live; wait until no
 * registered or visible process of this install remains; stake the launch
 * lease exclusively; check once more; run the manager; record the result.
 *
 * A result names its writer's pid, and the launcher ends its wait only on the
 * result of the lease it waits on: the path is fixed per install root, and a
 * wrapper that yields to a live lease must not read as that run finishing.
 * The yielding wrapper also never replaces a result on disk, so the holder's
 * own record (or an unmerged earlier one) survives it.
 */
const WRAPPER = String.raw`
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
${HOLD_SOURCE}
const p = JSON.parse(process.argv[1]);
const say = (m) => process.stdout.write("[" + new Date().toISOString() + "] " + m + "\n");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hold = holdOf({ hold: p.hold, root: p.root, skip: [process.pid] });
const record = (r) => JSON.stringify(Object.assign({ at: Date.now(), pid: process.pid, from: p.from, to: p.to, log: p.log, manager: p.manager }, r)) + "\n";
const tmp = p.result + "." + process.pid + ".tmp";
const finish = (r) => { fs.writeFileSync(tmp, record(r), { mode: 0o600 }); fs.renameSync(tmp, p.result); hold.unstake(); process.exit(0); };
const yieldTo = (holder) => {
	say("deferred: " + holder + " already holds this install");
	try { fs.writeFileSync(tmp, record({ ok: false, deferred: true, exitCode: null, detail: holder }), { mode: 0o600 }); fs.linkSync(tmp, p.result); } catch {}
	try { fs.unlinkSync(tmp); } catch {}
	process.exit(0);
};
const env = Object.assign({}, process.env, p.env);
say("deferred " + p.manager + " update " + p.from + " -> " + p.to + " for " + p.root);
say("command: " + [p.command].concat(p.args).join(" "));
if (p.prefetch) {
	// Touches only the cache, never the prefix, so it may overlap running sessions.
	const pre = cp.spawnSync(p.command, p.prefetch, { stdio: ["ignore", "inherit", "inherit"], env, timeout: p.runMs, killSignal: "SIGKILL" });
	say("prefetch " + (pre.status === 0 ? "done" : "failed (exit " + pre.status + "); the install fetches instead"));
}
const deadline = Date.now() + p.waitMs;
let last = "";
for (;;) {
	while (hold.alive(p.parent) && (!p.parentBirth || hold.birth(p.parent) === null || hold.birth(p.parent) === p.parentBirth)) { if (Date.now() > deadline) finish({ ok: false, deferred: true, exitCode: null, detail: "the session did not exit" }); sleep(250); }
	const held = hold.holders();
	// Another wrapper or a shell upgrade staked first: it updates this
	// install, so waiting out its run would only replace it a second time.
	// Read after the scan, so a lease staked during it is caught on this pass.
	const lease = hold.lease();
	if (lease?.readable) yieldTo(lease.holder);
	if (held.length === 0) {
		if (hold.stake({ manager: p.manager, log: p.log, result: p.result })) {
			const late = hold.holders();
			if (late.length === 0) break;
			hold.unstake();
			say("a launch raced the lease: " + late.join(","));
			continue;
		}
		// EEXIST: another holder staked between the scan and this stake. Wait
		// a poll like any holder; the next pass yields if its lease is readable.
		held.push(hold.lease()?.holder ?? "another update lease");
	}
	const now = held.join(",");
	if (now !== last) { say("waiting for: " + now); last = now; }
	if (Date.now() > deadline) finish({ ok: false, deferred: true, exitCode: null, detail: now });
	sleep(p.pollMs);
}
// The result path is fixed per install root; anything on it now predates this
// lease, and a launch from an older launcher would read it as this run's end.
try { fs.unlinkSync(p.result); say("removed a previous unmerged result"); } catch {}
say("no clio-coder process of this install remains; running " + p.manager);
const run = cp.spawnSync(p.command, p.args, { stdio: ["ignore", "inherit", "inherit"], env, timeout: p.runMs, killSignal: "SIGKILL" });
let version = "";
if (p.versionFile) { try { version = JSON.parse(fs.readFileSync(p.versionFile, "utf8")).version; } catch {} }
const ok = run.status === 0 && (!p.versionFile || version === p.to);
const detail = ok ? "" : run.error ? String(run.error.message) : run.status !== 0 ? (run.signal ? "killed by " + run.signal : "exit " + run.status) : "installed version is " + (version || "unreadable");
say((ok ? "updated to " : "update failed: ") + (ok ? p.to : detail));
finish({ ok, exitCode: run.status, detail });
`;

export interface InstallHold {
	/** Path of the update lease the launcher waits on. */
	readonly marker: string;
	/** Every lease, registration or visible process holding the install, as "pid@host" ("update pid@host" for a lease); this process excluded. */
	holders(): string[];
	/** Another process's live update lease, or null. */
	lease(): { holder: string; readable: boolean } | null;
	/** Stakes the lease exclusively; false when another holder staked first. */
	stake(fields: { manager: string; log: string }): boolean;
	unstake(): void;
}

type HoldParams = { hold: string; root: string; skip: number[]; psSkip: number[] };
let holdFactory: ((p: HoldParams) => InstallHold) | undefined;

/**
 * The wrapper's own holder judging, for a process of this install, which
 * excludes only its own registration. The ps scan also skips the parent: under
 * CLIO_CODER_NODE the launcher that re-executed this process runs the package's
 * bin by path and never registers, and any parent that is a Clio session
 * registered itself through the launcher.
 */
export function installHold(target: Pick<DeferredTarget, "hold" | "root">): InstallHold {
	holdFactory ??= new Function("fs", "path", "cp", "os", `${HOLD_SOURCE}\nreturn holdOf;`)(fs, path, cp, os) as (
		p: HoldParams,
	) => InstallHold;
	return holdFactory({ hold: target.hold, root: target.root, skip: [process.pid], psSkip: [process.ppid] });
}

/** Opens a new log for one update run beside the earlier ones; at most LOG_RETENTION stay. */
export function createUpdateLog(cacheDir: string, fingerprint: string): string {
	const logDir = join(cacheDir, "update-logs");
	mkdirSync(logDir, { recursive: true, mode: 0o700 });
	pruneLogs(logDir, fingerprint);
	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d+Z$/u, "Z");
	return join(logDir, `${fingerprint}-${stamp}.log`);
}

/**
 * Starts the wrapper from a shutdown hook. Synchronous on purpose: the
 * process exits right after persist hooks, so nothing here may await.
 * Returns the wrapper pid and log, or null when it could not start.
 */
export function spawnDeferredUpdate(
	target: DeferredTarget,
	options: { cacheDir: string; fingerprint: string; resultPath: string; from: string; to: string },
): { pid: number; log: string } | null {
	let fd: number | null = null;
	try {
		const log = createUpdateLog(options.cacheDir, options.fingerprint);
		fd = openSync(log, "a", 0o600);
		writeSync(fd, `[${new Date().toISOString()}] session pid ${process.pid} quit; starting the deferred update\n`);
		const payload = {
			parent: process.pid,
			manager: target.manager,
			root: target.root,
			hold: target.hold,
			command: target.command,
			args: target.args,
			env: target.env,
			prefetch: target.prefetch ?? null,
			versionFile: target.versionFile,
			parentBirth: processBirthToken(),
			from: options.from,
			to: options.to,
			log,
			result: options.resultPath,
			waitMs: DEFERRED_WAIT_MS,
			runMs: DEFERRED_RUN_MS,
			pollMs: 2000,
		};
		const child = spawn(process.execPath, ["-e", WRAPPER, JSON.stringify(payload), WRAPPER_SENTINEL], {
			detached: true,
			stdio: ["ignore", fd, fd],
			cwd: homedir(),
			env: process.env,
		});
		child.unref();
		return typeof child.pid === "number" ? { pid: child.pid, log } : null;
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

export function readDeferredResult(path: string): DeferredResult | null {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as DeferredResult;
		return typeof value?.at === "number" && typeof value.ok === "boolean" && typeof value.to === "string" ? value : null;
	} catch {
		return null;
	}
}
