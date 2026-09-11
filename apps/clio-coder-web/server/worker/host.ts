import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { startDomainWorker } from "../process-policy.js";
import { AppProblem } from "../services/problem.js";
import type { Call, Method, Methods, Reply, WorkerKind, WorkerSettings } from "./protocol.js";

type Pending = {
	call: Call;
	timer: NodeJS.Timeout;
	expired: boolean;
	resolve: (result: Methods[Method]["result"]) => void;
	reject: (error: unknown) => void;
	progress?: (message: string) => void;
};
export class WorkerHost {
	private worker: Worker | undefined;
	private pending = new Map<string, Pending>();
	private active: string | undefined;
	private closed = false;
	constructor(
		private kind: WorkerKind,
		private settings: WorkerSettings = {},
		private env: NodeJS.ProcessEnv = process.env,
		private compiledDirectory?: URL,
	) {
		this.start();
	}
	get threadId() {
		return this.worker?.threadId;
	}
	get pendingCount() {
		return this.pending.size;
	}
	call<M extends Method>(
		method: M,
		params: Methods[M]["params"],
		options: { deadlineMs?: number; progress?: (message: string) => void } = {},
	): Promise<Methods[M]["result"]> {
		if (this.closed || this.pending.size >= 64)
			return Promise.reject(new AppProblem("unavailable", "Domain worker queue is full or closed. Retry shortly."));
		if (!this.worker) this.start();
		const id = randomUUID();
		const defaultDeadline =
			this.kind === "reads" ? (this.settings.fixture ? (this.settings.readDeadlineMs ?? 10_000) : 10_000) : 900_000;
		const deadlineMs = Date.now() + (options.deadlineMs ?? defaultDeadline);
		return new Promise<Methods[M]["result"]>((resolve, reject) => {
			const timer = setTimeout(
				() => {
					const pending = this.pending.get(id);
					if (!pending) return;
					pending.expired = true;
					reject(
						new AppProblem("unavailable", "Domain call exceeded its deadline; synchronous work may still be completing."),
					);
					if (this.active !== id) this.pending.delete(id);
				},
				Math.max(1, deadlineMs - Date.now()),
			);
			this.pending.set(id, {
				call: { id, method, params, deadlineMs } as Call,
				timer,
				expired: false,
				resolve: (result) => resolve(result as Methods[M]["result"]),
				reject,
				...(options.progress ? { progress: options.progress } : {}),
			});
			this.dispatch();
		});
	}
	private start() {
		const worker = startDomainWorker(this.kind, this.settings, this.env, this.compiledDirectory);
		this.worker = worker;
		worker.on("message", (reply: Reply) => {
			const pending = this.pending.get(reply.id);
			if (!pending) return;
			if ("progress" in reply) {
				if (!pending.expired) pending.progress?.(reply.progress);
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(reply.id);
			this.active = undefined;
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
			if (this.worker !== worker) return;
			this.worker = undefined;
			this.active = undefined;
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new AppProblem("unavailable", "Domain worker exited; retry to start a fresh worker."));
			}
			this.pending.clear();
		};
		worker.on("error", (error) => {
			console.error(`[clio-coder:web] ${this.kind} worker`, error);
			fail();
		});
		worker.on("exit", fail);
	}
	private dispatch() {
		if (this.active || !this.worker) return;
		const next = this.pending.values().next().value as Pending | undefined;
		if (next) {
			this.active = next.call.id;
			this.worker.postMessage(next.call);
		}
	}
	async close() {
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new AppProblem("unavailable", "Server is stopping."));
		}
		this.pending.clear();
		await this.worker?.terminate();
		this.worker = undefined;
	}
}
