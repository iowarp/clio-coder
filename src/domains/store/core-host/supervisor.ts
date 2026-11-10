import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { buildSafeToolEnv } from "../../../core/safe-exec.js";
import { StoreRefusal } from "../types.js";
import {
	CORE_HOST_BULK_OPS,
	CoreHostFrameDecoder,
	type CoreHostHello,
	type CoreHostOp,
	type CoreHostOps,
	encodeCoreHostFrame,
	parseCoreHostInbound,
} from "./protocol.js";

export const CORE_HOST_STDERR_BYTES = 64 * 1024;
const QUOTED_STDERR_BYTES = 4 * 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// clio-core's routine log lines (`<file>:<line> INFO <tid> <func> ...`) bury the warning, error, and host lines.
const CORE_ROUTINE_LOG = /^\S+:\d+ (?:INFO|DEBUG) \d+ /;

/** The end of a host's stderr as a refusal quotes it: no escape codes, no routine runtime logging, whole lines. */
function quotableStderr(stderr: string): string {
	const lines = stderr
		.replace(ANSI_ESCAPE, "")
		.split("\n")
		.filter((line) => !CORE_ROUTINE_LOG.test(line.trim()));
	let quoted = lines.join("\n").trim();
	if (quoted.length > QUOTED_STDERR_BYTES) {
		quoted = quoted.slice(-QUOTED_STDERR_BYTES);
		quoted = quoted.slice(quoted.indexOf("\n") + 1);
	}
	return quoted;
}

export interface CoreHostTiming {
	helloMs: number;
	/** Deadline for a call; the floor of a bulk call's size-scaled deadline. */
	callMs: number;
	/** A bulk call without a progress frame for this long is a dead host. */
	progressMs: number;
	pingIntervalMs: number;
	pingTimeoutMs: number;
	closeGraceMs: number;
	/** After a restart, no further restart for this long. */
	restartBackoffMs: number;
	/** Slowest acceptable bulk rate, used to scale a bulk call's deadline with its size. */
	bulkBytesPerSecond: number;
}

export const CORE_HOST_DEFAULT_TIMING: CoreHostTiming = {
	helloMs: 30_000,
	callMs: 30_000,
	progressMs: 10_000,
	pingIntervalMs: 3_000,
	pingTimeoutMs: 10_000,
	closeGraceMs: 2_000,
	restartBackoffMs: 60_000,
	bulkBytesPerSecond: 4 * 1024 * 1024,
};

export interface CoreHostLaunch {
	command: string;
	args?: ReadonlyArray<string>;
	/** Laid over `PATH`, `HOME` and `USER`; the clio-core environment contract the store backend passes. Nothing else is inherited. */
	env?: Record<string, string>;
	cwd?: string;
	timing?: Partial<CoreHostTiming>;
}

export interface CoreHostCallOptions {
	signal?: AbortSignal;
	/** Object size for a bulk op, when known; scales its deadline. */
	bytes?: number;
}

export type CoreHostState = "ready" | "quarantined" | "closed";

export interface CoreHost {
	readonly state: CoreHostState;
	readonly hello: CoreHostHello | null;
	/** Rejects only with `StoreRefusal`; a dead or stuck host is `unavailable` carrying its stderr tail. */
	call<Op extends CoreHostOp>(
		op: Op,
		args: CoreHostOps[Op]["args"],
		options?: CoreHostCallOptions,
	): Promise<CoreHostOps[Op]["result"]>;
	stderrTail(): string;
	close(): Promise<void>;
}

interface Pending {
	op: CoreHostOp;
	resolve: (value: unknown) => void;
	reject: (error: StoreRefusal) => void;
	deadline: ReturnType<typeof setTimeout> | null;
	watchdog: ReturnType<typeof setTimeout> | null;
	cleanup: () => void;
}

function minimalEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "USER"] as const) {
		const value = process.env[key];
		if (value !== undefined) base[key] = value;
	}
	return buildSafeToolEnv(extra, process.env, base);
}

/** One child's lifetime. Once dead it stays dead; the supervisor replaces it. */
class HostProcess {
	readonly child: ChildProcessWithoutNullStreams;
	hello: CoreHostHello | null = null;
	dead = false;
	readonly ready: Promise<CoreHostHello>;
	#timing: CoreHostTiming;
	#decoder = new CoreHostFrameDecoder();
	#pending = new Map<number, Pending>();
	#cancelled = new Set<number>();
	#nextId = 1;
	#stderr: Buffer = Buffer.alloc(0);
	#helloTimer: ReturnType<typeof setTimeout> | null;
	#pingTimer: ReturnType<typeof setInterval> | null = null;
	#pingOutstanding = false;
	#exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	#closed: Promise<void>;
	#resolveHello!: (hello: CoreHostHello) => void;
	#rejectHello!: (error: StoreRefusal) => void;

	constructor(launch: CoreHostLaunch, timing: CoreHostTiming) {
		this.#timing = timing;
		this.ready = new Promise<CoreHostHello>((resolve, reject) => {
			this.#resolveHello = resolve;
			this.#rejectHello = reject;
		});
		// The caller may never await `ready` once a call has failed; an unobserved rejection must not end the parent.
		this.ready.catch(() => {});
		// stdout is a private pipe: the parent's own stdout may be a worker's NDJSON lane and never sees a frame.
		this.child = spawn(launch.command, [...(launch.args ?? [])], {
			...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
			env: minimalEnv(launch.env),
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.#closed = new Promise((resolve) => this.child.once("close", () => resolve()));
		// An idle host never keeps the parent alive; outstanding calls hold the loop through their timers.
		this.child.unref();
		for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr])
			(stream as unknown as { unref?: () => void }).unref?.();
		this.#helloTimer = setTimeout(() => this.fail(`sent no hello within ${timing.helloMs} ms`), timing.helloMs);
		this.child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
		this.child.stderr.on("data", (chunk: Buffer) => {
			const joined = Buffer.concat([this.#stderr, chunk]);
			this.#stderr =
				joined.byteLength > CORE_HOST_STDERR_BYTES ? joined.subarray(joined.byteLength - CORE_HOST_STDERR_BYTES) : joined;
		});
		// A dead pipe surfaces through the exit or close events; these handlers keep it from throwing in the parent.
		this.child.stdin.on("error", () => {});
		this.child.stdout.on("error", () => {});
		this.child.stderr.on("error", () => {});
		this.child.once("error", (error) => this.fail(`could not run: ${error.message}`));
		this.child.once("exit", (code, signal) => {
			this.#exit = { code, signal };
			this.killGroup();
			// stderr is complete at close; a descendant that escaped the group must not hold the refusal back.
			const fallback = setTimeout(() => this.fail(this.#exitText()), 1000);
			void this.#closed.then(() => {
				clearTimeout(fallback);
				this.fail(this.#exitText());
			});
		});
	}

	#exitText(): string {
		const exit = this.#exit;
		if (exit === null) return "exited";
		return exit.signal !== null ? `exited on signal ${exit.signal}` : `exited with code ${exit.code}`;
	}

	stderrTail(): string {
		return this.#stderr.toString("utf8");
	}

	#refusal(why: string): StoreRefusal {
		const tail = quotableStderr(this.#stderr.toString("utf8"));
		const quoted = tail === "" ? " It wrote nothing to stderr." : ` Its stderr ended with:\n${tail}`;
		return new StoreRefusal("unavailable", `The clio-core host ${why}.${quoted}`);
	}

	/** Quarantine: every outstanding call rejects as `unavailable` and the process group is killed. */
	fail(why: string): void {
		if (this.dead) return;
		this.dead = true;
		if (this.#helloTimer !== null) clearTimeout(this.#helloTimer);
		this.#stopPing();
		const refusal = this.#refusal(why);
		this.#rejectHello(refusal);
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) {
			entry.cleanup();
			entry.reject(refusal);
		}
		this.killGroup();
	}

	killGroup(): void {
		const pid = this.child.pid;
		if (pid !== undefined && process.platform !== "win32") {
			try {
				process.kill(-pid, "SIGKILL");
				return;
			} catch {
				// The group is already gone or was never formed; fall back to the direct child.
			}
		}
		try {
			this.child.kill("SIGKILL");
		} catch {
			// The child has already exited.
		}
	}

	#receive(chunk: Buffer): void {
		if (this.dead) return;
		let frames: unknown[];
		try {
			frames = this.#decoder.push(chunk);
		} catch (error) {
			this.fail(`sent a malformed frame (${error instanceof Error ? error.message : String(error)})`);
			return;
		}
		for (const frame of frames) {
			if (this.dead) return;
			try {
				this.#handle(frame);
			} catch (error) {
				this.fail(`sent a malformed frame (${error instanceof Error ? error.message : String(error)})`);
				return;
			}
		}
	}

	#handle(frame: unknown): void {
		const inbound = parseCoreHostInbound(frame);
		if (inbound.kind === "hello-error") {
			if (this.hello !== null) throw new Error("a failure hello after hello");
			this.fail(`could not attach: ${inbound.error}`);
			return;
		}
		if (inbound.kind === "hello") {
			if (this.hello !== null) throw new Error("a second hello");
			this.hello = inbound.hello;
			if (this.#helloTimer !== null) clearTimeout(this.#helloTimer);
			this.#helloTimer = null;
			this.#resolveHello(inbound.hello);
			return;
		}
		if (this.hello === null) throw new Error("a frame before hello");
		const entry = this.#pending.get(inbound.id);
		if (entry === undefined) {
			if (this.#cancelled.has(inbound.id)) {
				if (inbound.kind !== "progress") this.#cancelled.delete(inbound.id);
				return;
			}
			throw new Error(`a frame for unknown call ${inbound.id}`);
		}
		if (inbound.kind === "progress") {
			if (entry.watchdog !== null) entry.watchdog.refresh();
			return;
		}
		this.#settle(inbound.id, entry);
		if (inbound.kind === "result") entry.resolve(inbound.result);
		else entry.reject(new StoreRefusal(inbound.reason, inbound.message));
	}

	#settle(id: number, entry: Pending): void {
		this.#pending.delete(id);
		entry.cleanup();
		if (![...this.#pending.values()].some((other) => other.op !== "ping")) this.#stopPing();
	}

	#write(value: unknown): void {
		if (!this.child.stdin.writable) return;
		this.child.stdin.write(encodeCoreHostFrame(value));
	}

	call(op: CoreHostOp, args: Record<string, unknown>, options: CoreHostCallOptions = {}): Promise<unknown> {
		if (this.dead) return Promise.reject(this.#refusal(this.#exit === null ? "is quarantined" : this.#exitText()));
		const signal = options.signal;
		if (signal?.aborted) return Promise.reject(new StoreRefusal("io", `The ${op} call was aborted.`));
		const id = this.#nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timing = this.#timing;
			const bulk = CORE_HOST_BULK_OPS.has(op);
			let deadlineMs: number | null = op === "ping" ? timing.pingTimeoutMs : timing.callMs;
			if (bulk)
				deadlineMs =
					options.bytes === undefined ? null : timing.callMs + Math.ceil((options.bytes / timing.bulkBytesPerSecond) * 1000);
			const onAbort = (): void => {
				const entry = this.#pending.get(id);
				if (entry === undefined) return;
				this.#cancelled.add(id);
				this.#settle(id, entry);
				reject(new StoreRefusal("io", `The ${op} call was aborted.`));
			};
			const entry: Pending = {
				op,
				resolve,
				reject,
				deadline:
					deadlineMs === null
						? null
						: setTimeout(() => this.fail(`missed the ${deadlineMs} ms deadline for ${op}`), deadlineMs),
				watchdog: bulk
					? setTimeout(() => this.fail(`sent no progress on ${op} for ${timing.progressMs} ms`), timing.progressMs)
					: null,
				cleanup: () => {
					if (entry.deadline !== null) clearTimeout(entry.deadline);
					if (entry.watchdog !== null) clearTimeout(entry.watchdog);
					signal?.removeEventListener("abort", onAbort);
				},
			};
			this.#pending.set(id, entry);
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				this.#write({ id, op, args });
			} catch (error) {
				this.#settle(id, entry);
				reject(new StoreRefusal("io", error instanceof Error ? error.message : String(error)));
				return;
			}
			if (op !== "ping") this.#startPing();
		});
	}

	#startPing(): void {
		if (this.#pingTimer !== null) return;
		this.#pingTimer = setInterval(() => {
			if (this.#pingOutstanding || this.dead) return;
			this.#pingOutstanding = true;
			this.call("ping", {}).then(
				() => {
					this.#pingOutstanding = false;
				},
				() => {
					this.#pingOutstanding = false;
				},
			);
		}, this.#timing.pingIntervalMs);
	}

	#stopPing(): void {
		if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
		this.#pingTimer = null;
	}

	async shutdown(graceMs: number): Promise<void> {
		if (this.#exit === null && !this.dead) {
			try {
				this.#write({ id: 0, op: "shutdown", args: {} });
				this.child.stdin.end();
			} catch {
				// A host that cannot take the request is killed below.
			}
		}
		// The grace timer stays referenced: the child and its pipes are not, and the loop must not drain mid-close.
		let grace: ReturnType<typeof setTimeout> | undefined;
		const timer = new Promise<"timeout">((resolve) => {
			grace = setTimeout(() => resolve("timeout"), graceMs);
		});
		const outcome = await Promise.race([this.#closed.then(() => "closed" as const), timer]);
		clearTimeout(grace);
		this.fail("was closed");
		if (outcome === "timeout") this.killGroup();
	}
}

class CoreHostSupervisor implements CoreHost {
	#launch: CoreHostLaunch;
	#timing: CoreHostTiming;
	#proc: HostProcess;
	#starting: Promise<HostProcess> | null = null;
	#lastRestartAt: number | null = null;
	#closed = false;
	#onExit = (): void => this.#proc.killGroup();

	constructor(launch: CoreHostLaunch, proc: HostProcess, timing: CoreHostTiming) {
		this.#launch = launch;
		this.#proc = proc;
		this.#timing = timing;
		process.once("exit", this.#onExit);
	}

	get state(): CoreHostState {
		if (this.#closed) return "closed";
		return this.#proc.dead ? "quarantined" : "ready";
	}

	get hello(): CoreHostHello | null {
		return this.#proc.dead ? null : this.#proc.hello;
	}

	stderrTail(): string {
		return this.#proc.stderrTail();
	}

	async #live(): Promise<HostProcess> {
		if (!this.#proc.dead) return this.#proc;
		if (this.#starting !== null) return this.#starting;
		const now = performance.now();
		if (this.#lastRestartAt !== null && now - this.#lastRestartAt < this.#timing.restartBackoffMs) {
			const wait = Math.ceil((this.#timing.restartBackoffMs - (now - this.#lastRestartAt)) / 1000);
			throw new StoreRefusal(
				"unavailable",
				`The clio-core host is quarantined and was already restarted; the next restart is allowed in ${wait} s. ` +
					`Last stderr:\n${quotableStderr(this.#proc.stderrTail())}`,
			);
		}
		this.#lastRestartAt = now;
		const proc = new HostProcess(this.#launch, this.#timing);
		this.#proc = proc;
		this.#starting = proc.ready.then(() => proc);
		try {
			return await this.#starting;
		} finally {
			this.#starting = null;
		}
	}

	async call<Op extends CoreHostOp>(
		op: Op,
		args: CoreHostOps[Op]["args"],
		options?: CoreHostCallOptions,
	): Promise<CoreHostOps[Op]["result"]> {
		if (this.#closed) throw new StoreRefusal("unavailable", "The clio-core host has been closed.");
		const proc = await this.#live();
		return (await proc.call(op, args as Record<string, unknown>, options)) as CoreHostOps[Op]["result"];
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		process.removeListener("exit", this.#onExit);
		await this.#proc.shutdown(this.#timing.closeGraceMs);
	}
}

/**
 * Starts the core host and waits for its hello. The host is a child of the
 * calling process with a minimal environment and private pipes. It never
 * starts, stops or signals `clio_run`; it only attaches to it.
 */
export async function startCoreHost(launch: CoreHostLaunch): Promise<CoreHost> {
	const timing = { ...CORE_HOST_DEFAULT_TIMING, ...launch.timing };
	const proc = new HostProcess(launch, timing);
	await proc.ready;
	return new CoreHostSupervisor(launch, proc, timing);
}
