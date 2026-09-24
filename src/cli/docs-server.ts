import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { BIRTH_TOKEN_SOURCE_AVAILABLE, processAlive, processBirthToken } from "../core/process-identity.js";
import { withStateFileLock } from "../core/state-file-lock.js";
import { resolveClioDirs } from "../core/xdg.js";

/** A page that stays open holds the server through its event stream; this only bounds the gap after the last one closes. */
export const DOCS_IDLE_EXIT_MS = 15 * 60_000;
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;
const LAUNCH_LINK = /\[clio-coder:gui\] http:\/\/127\.0\.0\.1:(\d+)\/\S*#token=([\w-]{32,256})/u;

/** What a later `clio-coder docs` needs to find, verify and stop the server this one started. */
interface DocsServerRecord {
	v: 1;
	pid: number;
	birth: string;
	port: number;
	token: string;
	packageRoot: string;
}

export interface DocsServer {
	origin: string;
	token: string;
	pid: number;
	reused: boolean;
}

const registryPath = () => join(resolveClioDirs().state, "gui", "docs-server.json");

/** The installed background app owns docs when it exists; the docs server never competes with it. */
export function backgroundAppInstalled(): boolean {
	const directory = join(resolveClioDirs().state, "gui", "background");
	return ["server.json", "owner.json"].some((name) => existsSync(join(directory, name)));
}

function readRecord(): DocsServerRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(registryPath(), "utf8")) as Partial<DocsServerRecord>;
		if (
			value.v === 1 &&
			Number.isSafeInteger(value.pid) &&
			(value.pid ?? 0) > 0 &&
			typeof value.birth === "string" &&
			Number.isInteger(value.port) &&
			(value.port ?? 0) >= 1 &&
			(value.port ?? 0) <= 65535 &&
			typeof value.token === "string" &&
			/^[\w-]{32,256}$/u.test(value.token) &&
			typeof value.packageRoot === "string"
		)
			return value as DocsServerRecord;
	} catch {
		// Absent or damaged records mean there is nothing to reuse.
	}
	return undefined;
}

function writeRecord(record: DocsServerRecord): void {
	const path = registryPath();
	mkdirSync(dirname(path), { recursive: true });
	const staging = `${path}.${process.pid}.tmp`;
	writeFileSync(staging, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	renameSync(staging, path);
}

const removeRecord = () => rmSync(registryPath(), { force: true });

/**
 * Whether the recorded pid is still the server this command started. Where the OS exposes process
 * start times (Linux), the birth token proves it even for a server that no longer answers. Elsewhere
 * the token is only `pid-<n>`, which a reused pid satisfies, so ownership needs the server itself to
 * answer with the launch token that only it holds. A server that is alive but silent cannot be
 * proven ours there, and is never signalled.
 */
async function owned(record: DocsServerRecord, birthVerified: boolean): Promise<boolean> {
	if (!processAlive(record.pid)) return false;
	if (birthVerified) return processBirthToken(record.pid) === record.birth;
	return authenticated(record.port, record.token);
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (processAlive(pid)) {
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
	return true;
}

/** A signal that races the process exiting is not a failure: the target is gone either way. */
function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

type Termination = "exited" | "survived" | "not-owned";

/** What happened to the process, observed rather than assumed. Anything not proven to be this server is left running. */
async function terminate(record: DocsServerRecord, birthVerified: boolean): Promise<Termination> {
	if (!(await owned(record, birthVerified))) return "not-owned";
	signal(record.pid, "SIGTERM");
	if (await waitForExit(record.pid, STOP_TIMEOUT_MS)) return "exited";
	// Without verified birth tokens a silent survivor might no longer be ours, so only escalate on proof.
	if (!(await owned(record, birthVerified))) return processAlive(record.pid) ? "not-owned" : "exited";
	signal(record.pid, "SIGKILL");
	return (await waitForExit(record.pid, 2000)) ? "exited" : "survived";
}

export interface DocsServerOptions {
	/** How long the server may sit with no page open before it exits. */
	idleMs?: number;
	/** How long to wait for the server to report its address and answer. */
	startTimeoutMs?: number;
	/** Whether pid reuse is detectable on this platform. Defaults to what the OS provides; tests set it. */
	birthVerified?: boolean;
}

const logPath = () => join(dirname(registryPath()), "docs-server.log");

/** The token is authenticated, so a server that answers it is this one and not another program on the port. */
async function authenticated(port: number, token: string): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/meta`, {
			headers: { Authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(1500),
		});
		return response.status === 200 && ((await response.json()) as { apiVersion?: number }).apiVersion === 1;
	} catch {
		return false;
	}
}

/** Signal the whole group: the server is its own session leader and may have started children of its own. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		// Already gone.
	}
}

async function start(packageRoot: string, options: DocsServerOptions): Promise<DocsServer> {
	const entry = join(packageRoot, "dist/gui/server.js");
	if (!existsSync(entry))
		throw new Error("The graphical application has not been built here. Run `pnpm run build` in this checkout.");
	const idleMs = options.idleMs ?? DOCS_IDLE_EXIT_MS;
	const timeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
	const log = logPath();
	mkdirSync(dirname(log), { recursive: true });
	// A file, not a pipe: the server outlives this command, and a closed pipe would break its later logging.
	const fd = openSync(log, "w", 0o600);
	let child: ChildProcess;
	try {
		child = spawn(process.execPath, [entry, "--idle-exit", String(idleMs), "--no-open"], {
			cwd: packageRoot,
			detached: true,
			env: { ...process.env, CLIO_CODER_PACKAGE_ROOT: packageRoot },
			stdio: ["ignore", fd, fd],
		});
	} finally {
		closeSync(fd);
	}
	let exited = false;
	let spawnError: Error | undefined;
	child.once("exit", () => {
		exited = true;
	});
	child.once("error", (error) => {
		exited = true;
		spawnError = error;
	});
	const output = () => {
		try {
			return readFileSync(log, "utf8");
		} catch {
			return "";
		}
	};
	try {
		const deadline = Date.now() + timeoutMs;
		let link: RegExpExecArray | null = null;
		while (!link && !exited && Date.now() < deadline) {
			await sleep(40);
			link = LAUNCH_LINK.exec(output());
		}
		const [, port, token] = link ?? [];
		if (!port || !token || !child.pid) {
			const reason =
				spawnError?.message ??
				output()
					.trim()
					.split("\n")
					.pop()
					?.replace(/^\[clio-coder:gui\]\s*/u, "");
			throw new Error(`The documentation server did not start${reason ? `: ${reason}` : "."}`);
		}
		let ready = false;
		while (!ready && !exited && Date.now() < deadline) {
			ready = await authenticated(Number(port), token);
			if (!ready) await sleep(100);
		}
		if (!ready) throw new Error("The documentation server started but did not answer its launch token.");
		const birth = processBirthToken(child.pid);
		if (!birth) throw new Error("The documentation server exited while starting.");
		writeRecord({ v: 1, pid: child.pid, birth, port: Number(port), token, packageRoot });
		child.unref();
		return { origin: `http://127.0.0.1:${port}`, token, pid: child.pid, reused: false };
	} catch (error) {
		// No record was published for a server that is not fully up, so nothing else can find it to stop it.
		if (!exited) killGroup(child, "SIGKILL");
		removeRecord();
		throw error;
	}
}

/** Reuse the running docs server for this installation, or replace whatever the registry left behind. */
export function ensureDocsServer(packageRoot: string, options: DocsServerOptions = {}): Promise<DocsServer> {
	return withStateFileLock(
		registryPath(),
		async () => {
			const record = readRecord();
			if (record) {
				const birthVerified = options.birthVerified ?? BIRTH_TOKEN_SOURCE_AVAILABLE;
				if (
					record.packageRoot === packageRoot &&
					(await owned(record, birthVerified)) &&
					(await authenticated(record.port, record.token))
				)
					return { origin: `http://127.0.0.1:${record.port}`, token: record.token, pid: record.pid, reused: true };
				if ((await terminate(record, birthVerified)) === "survived")
					throw new Error(
						`The previous documentation server (pid ${record.pid}) did not stop. Run clio-coder docs --stop again.`,
					);
				removeRecord();
			}
			return start(packageRoot, options);
		},
		{ timeoutMs: (options.startTimeoutMs ?? START_TIMEOUT_MS) + STOP_TIMEOUT_MS + 5000 },
	);
}

export interface StopResult {
	stopped: boolean;
	pid?: number;
	/** A process holds the recorded pid but could not be shown to be the documentation server, so it was left alone. */
	unverified?: boolean;
	/** The server was signalled, including SIGKILL, and is still running. Its record is kept so `--stop` can be retried. */
	survived?: boolean;
}

/** Stop the docs server this command started, if one is still running. */
export function stopDocsServer(
	options: Pick<DocsServerOptions, "birthVerified"> & { preserveUnverifiedRecord?: boolean } = {},
): Promise<StopResult> {
	return withStateFileLock(registryPath(), async () => {
		const record = readRecord();
		if (!record) return { stopped: false };
		const outcome = await terminate(record, options.birthVerified ?? BIRTH_TOKEN_SOURCE_AVAILABLE);
		if (outcome === "survived") return { stopped: false, pid: record.pid, survived: true };
		if (outcome === "not-owned" && processAlive(record.pid) && options.preserveUnverifiedRecord)
			return { stopped: false, pid: record.pid, unverified: true };
		removeRecord();
		if (outcome === "exited") return { stopped: true, pid: record.pid };
		return processAlive(record.pid) ? { stopped: false, pid: record.pid, unverified: true } : { stopped: false };
	});
}

/** Called only after destructive lifecycle confirmation, before clearing any roots. */
export async function stopDocsBeforeRemoval(): Promise<void> {
	if (!existsSync(registryPath())) return;
	const result = await stopDocsServer({ preserveUnverifiedRecord: true });
	if (result.survived || result.unverified)
		throw new Error(
			"The documentation server could not be stopped safely. Clio state was preserved; close it and retry.",
		);
}

/**
 * Opens a page through the application's own opener, which accepts only its loopback URL and
 * refuses platforms it cannot open safely. A build without the export has no opener, and the
 * printed link is the fallback.
 */
export async function openInBrowser(url: string, packageRoot: string): Promise<boolean> {
	const entry = join(packageRoot, "dist/gui/server.js");
	if (!existsSync(entry)) return false;
	try {
		const server = (await import(pathToFileURL(entry).href)) as { openBrowser?: (url: string) => Promise<void> };
		if (!server.openBrowser) return false;
		await server.openBrowser(url);
		return true;
	} catch {
		return false;
	}
}
