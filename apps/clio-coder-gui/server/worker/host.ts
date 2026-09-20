import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import type { Worker } from "node:worker_threads";
import { startDomainWorker } from "../process-policy.js";
import { AppProblem } from "../services/problem.js";
import type { Call, Method, Methods, Reply, WorkerKind, WorkerSettings } from "./protocol.js";

/**
 * Reads adapters are synchronous and import root `src/**`, so a thread that is
 * inside one cannot serve anything else. One thread therefore made every read a
 * head-of-line queue: a 25-second interop walk blocked docs, traces and settings,
 * and a page that fans out six reads paid for them one after another. Lanes are
 * spawned on demand up to this bound, so the usual single-request path still owns
 * exactly one thread and only real concurrency pays for a second.
 */
const READ_LANES = Math.max(2, Math.min(4, availableParallelism() - 1));

/**
 * How long a call may sit in the queue before the server admits it will not get
 * to the work. Deliberately independent of the call's own deadline: the deadline
 * is a promise about the work, and charging a caller for the time another call
 * held the lane is what made a queued read return 503 on a budget that expired
 * before its adapter ever ran.
 */
const QUEUE_WAIT_MS = 30_000;

type Lane = { worker: Worker; active: string | undefined };
type Pending = {
	call: Call;
	budgetMs: number;
	timer: NodeJS.Timeout;
	lane: Lane | undefined;
	expired: boolean;
	resolve: (result: Methods[Method]["result"]) => void;
	reject: (error: unknown) => void;
	progress?: (message: string) => void;
};
export class WorkerHost {
	private lanes: Lane[] = [];
	private pending = new Map<string, Pending>();
	private closed = false;
	private readonly limit: number;
	constructor(
		private kind: WorkerKind,
		private settings: WorkerSettings = {},
		private env: NodeJS.ProcessEnv = process.env,
		private compiledDirectory?: URL,
	) {
		// Mutations stay strictly serial: one ops lane is the ordering guarantee.
		this.limit = kind === "reads" ? Math.max(1, settings.readLanes ?? READ_LANES) : 1;
		this.spawn();
	}
	get threadId() {
		return this.lanes[0]?.worker.threadId;
	}
	get pendingCount() {
		return this.pending.size;
	}
	get laneCount() {
		return this.lanes.length;
	}
	call<M extends Method>(
		method: M,
		params: Methods[M]["params"],
		options: { deadlineMs?: number; progress?: (message: string) => void } = {},
	): Promise<Methods[M]["result"]> {
		if (this.closed || this.pending.size >= 64)
			return Promise.reject(new AppProblem("unavailable", "Domain worker queue is full or closed. Retry shortly."));
		const id = randomUUID();
		const defaultBudget =
			this.kind === "reads" ? (this.settings.fixture ? (this.settings.readDeadlineMs ?? 10_000) : 10_000) : 900_000;
		const budgetMs = options.deadlineMs ?? defaultBudget;
		return new Promise<Methods[M]["result"]>((resolve, reject) => {
			this.pending.set(id, {
				call: { id, method, params, deadlineMs: Date.now() + budgetMs } as Call,
				budgetMs,
				// Queued calls are armed too, so a wedged lane cannot hold a request open
				// forever; dispatch re-arms with the full budget once the work starts.
				timer: this.arm(id, Math.max(budgetMs, QUEUE_WAIT_MS)),
				lane: undefined,
				expired: false,
				resolve: (result) => resolve(result as Methods[M]["result"]),
				reject,
				...(options.progress ? { progress: options.progress } : {}),
			});
			this.dispatch();
		});
	}
	private arm(id: string, ms: number) {
		return setTimeout(
			() => {
				const pending = this.pending.get(id);
				if (!pending) return;
				pending.expired = true;
				pending.reject(
					new AppProblem(
						"unavailable",
						pending.lane
							? "Domain call exceeded its deadline; synchronous work may still be completing."
							: "Domain call waited longer than its deadline for a free worker.",
					),
				);
				// A call that never reached a lane occupies no thread, so its queue slot
				// returns immediately; one that did must wait for the thread to come back.
				if (!pending.lane) this.pending.delete(id);
			},
			Math.max(1, ms),
		);
	}
	private spawn(): Lane {
		const worker = startDomainWorker(this.kind, this.settings, this.env, this.compiledDirectory);
		const lane: Lane = { worker, active: undefined };
		this.lanes.push(lane);
		worker.on("online", () => this.dispatch());
		worker.on("message", (reply: Reply) => {
			const pending = this.pending.get(reply.id);
			if (!pending) return;
			if ("progress" in reply) {
				if (!pending.expired) pending.progress?.(reply.progress);
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(reply.id);
			lane.active = undefined;
			if (!pending.expired) {
				if (reply.ok) pending.resolve(reply.result);
				else
					pending.reject(
						new AppProblem(reply.problem.code, reply.problem.detail, reply.problem.status, reply.problem.instance),
					);
			}
			this.dispatch();
		});
		const fail = () => {
			const index = this.lanes.indexOf(lane);
			if (index < 0) return;
			this.lanes.splice(index, 1);
			// Only the call this lane was executing is lost; still-queued calls keep
			// their place and are re-dispatched onto a fresh lane below.
			const pending = lane.active ? this.pending.get(lane.active) : undefined;
			lane.active = undefined;
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(pending.call.id);
				if (!pending.expired)
					pending.reject(new AppProblem("unavailable", "Domain worker exited; retry to start a fresh worker."));
			}
			this.dispatch();
		};
		worker.on("error", (error) => {
			console.error(`[clio-coder:gui] ${this.kind} worker`, error);
			fail();
		});
		worker.on("exit", fail);
		return lane;
	}
	private lane(): Lane | undefined {
		const idle = this.lanes.find((candidate) => !candidate.active);
		if (idle) return idle;
		// A new lane is warmed in the background rather than handed the waiting call:
		// a thread takes hundreds of milliseconds to boot, and a lane that frees
		// first should win. Both paths call dispatch again.
		if (this.lanes.length < this.limit) this.spawn();
		return undefined;
	}
	private dispatch() {
		if (this.closed) return;
		for (const pending of this.pending.values()) {
			if (pending.lane) continue;
			const lane = this.lane();
			if (!lane) return;
			lane.active = pending.call.id;
			pending.lane = lane;
			// The deadline an operator is promised is on the work, not on the wait, so
			// it is re-based here rather than at enqueue.
			clearTimeout(pending.timer);
			pending.call.deadlineMs = Date.now() + pending.budgetMs;
			pending.timer = this.arm(pending.call.id, pending.budgetMs);
			lane.worker.postMessage(pending.call);
		}
	}
	async close() {
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new AppProblem("unavailable", "Server is stopping."));
		}
		this.pending.clear();
		const lanes = this.lanes;
		this.lanes = [];
		await Promise.all(lanes.map((lane) => lane.worker.terminate()));
	}
}
