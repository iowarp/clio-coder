import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSafeToolEnv } from "../../core/safe-exec.js";
import { type MainSandboxPolicy, planMainSandboxSpawn } from "../../core/sandbox/main-session.js";
import type { BrowserComponent } from "../../domains/lifecycle/browser-component.js";
import type { BrowserReply, BrowserRequest } from "./protocol.js";

/**
 * The host side of the browser tool's session worker: one driver process per session, started on the first call
 * inside the main-session sandbox the call was admitted with (or bare where admission ran it uncontained, as bash),
 * talked to over its stdio pipes. It ends with the session, on `close`, after an idle timeout, or when a later call
 * arrives under a different sandbox policy. Teardown signals the whole process group and kills it after a grace.
 */

const IDLE_MS = 15 * 60_000;
const KILL_GRACE_MS = 2_000;
const START_TIMEOUT_MS = 30_000;
/** After a cancel the driver replies with its action log; a driver that does not answer this fast is not waited for. */
const CANCEL_REPLY_MS = 3_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const require = createRequire(import.meta.url);

/** The driver's argv: the built entry beside this chunk, or the TypeScript source through tsx in source runs. */
function browserDriverArgv(): string[] {
	if (!import.meta.url.endsWith(".ts"))
		return [process.execPath, fileURLToPath(new URL("./browser/driver.js", import.meta.url))];
	const tsx = pathToFileURL(require.resolve("tsx/esm")).href;
	return [process.execPath, "--import", tsx, fileURLToPath(new URL("./driver.ts", import.meta.url))];
}

type Outgoing = BrowserRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

interface Pending {
	resolve: (reply: BrowserReply) => void;
	reject: (error: Error) => void;
}

export interface BrowserCallOptions {
	signal?: AbortSignal;
	/** Host-side ceiling; a run past it is cancelled so the pages survive. */
	timeoutMs: number;
}

class BrowserWorker {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private stderrTail = "";
	private exited = false;
	private idleTimer: NodeJS.Timeout | undefined;
	/** Process groups of the servers `serve` started, signalled at teardown when no PID namespace ends them. */
	private readonly serverGroups = new Set<number>();

	private constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		readonly key: string,
		readonly scratchDir: string,
		readonly hermetic: boolean,
		private readonly contained: boolean,
		private readonly onGone: () => void,
	) {
		createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4_000);
		});
		child.once("exit", (code, signal) => {
			this.exited = true;
			clearTimeout(this.idleTimer);
			const reason = `the browser session ended (${signal ?? `exit ${code}`})${this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-1_200)}` : ""}`;
			for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
			this.pending.clear();
			this.killServerGroups();
			rmSync(path.join(this.scratchDir, "profile"), { recursive: true, force: true });
			this.onGone();
		});
		child.once("error", (error) => {
			this.stderrTail += `\n${error.message}`;
		});
	}

	static async start(
		component: BrowserComponent,
		sandbox: MainSandboxPolicy | undefined,
		workspace: string,
		scratchDir: string,
		grantedHosts: ReadonlyArray<string>,
		hermetic: boolean,
		key: string,
		onGone: () => void,
	): Promise<BrowserWorker> {
		mkdirSync(scratchDir, { recursive: true });
		const argv = browserDriverArgv();
		let file = argv[0] as string;
		let args = argv.slice(1);
		let afterExit: (() => void) | undefined;
		if (sandbox !== undefined) {
			const plan = planMainSandboxSpawn(sandbox, { argv }, workspace);
			if (plan.kind === "refused") throw new Error(plan.message);
			file = plan.file;
			args = plan.args;
			afterExit = plan.afterExit;
		}
		const child = spawn(file, args, {
			cwd: workspace,
			env: buildSafeToolEnv({ TMPDIR: scratchDir }),
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (afterExit) child.once("exit", afterExit);
		const worker = new BrowserWorker(child, key, scratchDir, hermetic, sandbox !== undefined, onGone);
		await worker.request(
			{
				op: "init",
				playwrightEntry: component.playwrightEntry,
				browsersPath: component.browsersPath,
				...(component.channel ? { channel: component.channel } : {}),
				scratchDir,
				workspace,
				viewport: DEFAULT_VIEWPORT,
				grantedHosts: hermetic ? [] : [...grantedHosts],
				hermetic,
			},
			{ timeoutMs: START_TIMEOUT_MS },
		);
		return worker;
	}

	get alive(): boolean {
		return !this.exited;
	}

	private receive(line: string): void {
		let reply: BrowserReply;
		try {
			reply = JSON.parse(line) as BrowserReply;
		} catch {
			this.stderrTail = `${this.stderrTail}\n(stray stdout) ${line.slice(0, 200)}`.slice(-4_000);
			return;
		}
		const waiter = this.pending.get(reply.id);
		if (!waiter) return;
		this.pending.delete(reply.id);
		if (!this.contained)
			for (const server of reply.servers ?? []) {
				if (server.pid === undefined) continue;
				if (server.state === "starting" || server.state === "ready") this.serverGroups.add(server.pid);
				else this.serverGroups.delete(server.pid);
			}
		waiter.resolve(reply);
	}

	/**
	 * Uncontained, a server's process group outlives a driver that was killed before it could stop it. Contained, the
	 * sandbox's PID namespace ends every server with the driver, and these ids would name other processes on the host.
	 */
	private killServerGroups(): void {
		if (process.platform === "win32") return;
		for (const pid of this.serverGroups) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		this.serverGroups.clear();
	}

	private write(message: BrowserRequest): void {
		this.child.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	/** One call. An abort or the host ceiling cancels it in the driver, which answers with what ran; pages stay. */
	request(message: Outgoing, options: BrowserCallOptions): Promise<BrowserReply> {
		if (this.exited) return Promise.reject(new Error("the browser session has ended"));
		clearTimeout(this.idleTimer);
		const id = this.nextId++;
		return new Promise<BrowserReply>((resolve, reject) => {
			let cancelTimer: NodeJS.Timeout | undefined;
			let cancelled: "cancelled" | "timeout" | undefined;
			const settle = (): void => {
				clearTimeout(ceiling);
				clearTimeout(cancelTimer);
				options.signal?.removeEventListener("abort", onAbort);
				this.armIdle();
			};
			const cancel = (why: "cancelled" | "timeout"): void => {
				if (cancelled) return;
				cancelled = why;
				this.write({ op: "cancel", id: this.nextId++, target: id });
				cancelTimer = setTimeout(() => {
					if (!this.pending.delete(id)) return;
					settle();
					resolve({
						id,
						ok: false,
						error:
							why === "cancelled"
								? "cancelled: the call was stopped; the pages are kept"
								: `timed out after ${options.timeoutMs} ms; the call was stopped and the pages are kept`,
						...(why === "cancelled" ? { cancelled: true } : { timedOut: true }),
					});
				}, CANCEL_REPLY_MS);
			};
			const onAbort = (): void => cancel("cancelled");
			const ceiling = setTimeout(() => cancel("timeout"), options.timeoutMs);
			this.pending.set(id, {
				resolve: (reply) => {
					settle();
					resolve(reply);
				},
				reject: (error) => {
					settle();
					reject(error);
				},
			});
			if (options.signal?.aborted) onAbort();
			else options.signal?.addEventListener("abort", onAbort, { once: true });
			this.write({ ...message, id } as BrowserRequest);
		});
	}

	private armIdle(): void {
		clearTimeout(this.idleTimer);
		if (this.exited) return;
		this.idleTimer = setTimeout(() => void this.close(), IDLE_MS);
		this.idleTimer.unref();
	}

	private signalGroup(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (pid === undefined) return;
		try {
			if (process.platform === "win32") this.child.kill(signal);
			else process.kill(-pid, signal);
		} catch {
			// Already gone.
		}
	}

	async close(): Promise<void> {
		if (this.exited) return;
		const gone = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.stdin?.end();
		const grace = new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS).unref());
		await Promise.race([gone, grace]);
		if (!this.exited) {
			this.signalGroup("SIGTERM");
			await Promise.race([gone, new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS).unref())]);
		}
		if (!this.exited) this.signalGroup("SIGKILL");
	}
}

/** What a session's worker is keyed on: a call admitted under another sandbox policy gets a fresh worker. */
function workerKey(sandbox: MainSandboxPolicy | undefined, workspace: string, hermetic: boolean): string {
	return JSON.stringify({
		workspace,
		writable: sandbox?.writableRoots ?? null,
		network: sandbox?.network ?? null,
		readOnly: sandbox?.readOnly ?? null,
		contained: sandbox !== undefined,
		hermetic,
	});
}

export interface BrowserSessionCall {
	sessionId: string;
	component: BrowserComponent;
	sandbox: MainSandboxPolicy | undefined;
	workspace: string;
	grantedHosts: ReadonlyArray<string>;
	/** Loopback only; contained, the driver also loses the network namespace (`network: false`). */
	hermetic: boolean;
}

/** Every live browser session of this process, by Clio session id. */
export class BrowserSessions {
	private readonly workers = new Map<string, BrowserWorker>();
	private readonly starting = new Map<string, Promise<BrowserWorker>>();

	/** The running worker for this call's session, started (or restarted under a new sandbox policy) when needed. */
	async worker(call: BrowserSessionCall): Promise<{ worker: BrowserWorker; restarted: boolean; fresh: boolean }> {
		// One conversation owns the browser: a call from another session ends the others' workers with their grants.
		for (const [sessionId, other] of [...this.workers]) {
			if (sessionId === call.sessionId) continue;
			this.workers.delete(sessionId);
			await other.close();
		}
		const sandbox = call.hermetic && call.sandbox !== undefined ? { ...call.sandbox, network: false } : call.sandbox;
		const key = workerKey(sandbox, call.workspace, call.hermetic);
		const existing = this.workers.get(call.sessionId);
		let restarted = false;
		if (existing?.alive && existing.key === key) return { worker: existing, restarted, fresh: false };
		if (existing) {
			restarted = existing.alive;
			await existing.close();
			this.workers.delete(call.sessionId);
		}
		let pending = this.starting.get(call.sessionId);
		if (!pending) {
			const scratchDir = path.join(tmpdir(), `clio-coder-browser-${call.sessionId.replace(/[^\w.-]+/gu, "-")}`);
			pending = BrowserWorker.start(
				call.component,
				sandbox,
				call.workspace,
				scratchDir,
				call.grantedHosts,
				call.hermetic,
				key,
				() => {
					if (this.workers.get(call.sessionId)?.key === key) this.workers.delete(call.sessionId);
				},
			).finally(() => this.starting.delete(call.sessionId));
			this.starting.set(call.sessionId, pending);
		}
		const worker = await pending;
		this.workers.set(call.sessionId, worker);
		return { worker, restarted, fresh: true };
	}

	has(sessionId: string): boolean {
		return this.workers.get(sessionId)?.alive === true;
	}

	async close(sessionId: string): Promise<void> {
		const worker = this.workers.get(sessionId);
		this.workers.delete(sessionId);
		await worker?.close();
	}

	async closeAll(): Promise<void> {
		const all = [...this.workers.values()];
		this.workers.clear();
		await Promise.all(all.map((worker) => worker.close()));
	}
}
