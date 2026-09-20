import { createHash, randomUUID } from "node:crypto";
import type { Operation, OperationResult, Progress } from "../../contracts/operations.js";
import type { EventHub } from "./event-hub.js";
import { AppProblem, problemOf } from "./problem.js";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export function fingerprint(value: unknown) {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
const live = (operation: Operation) => operation.status === "queued" || operation.status === "running";
export class OperationRegistry {
	private records = new Map<string, Operation>();
	private keys = new Map<string, { fingerprint: string; id: string }>();
	private omitted = new Map<string, number>();
	private finished: string[] = [];
	private retainedBytes = 0;
	private terminalSizes = new Map<string, number>();
	private cancellations = new Map<string, AbortController>();
	get activeCount() {
		return [...this.records.values()].filter(live).length;
	}
	constructor(private hub: EventHub) {}
	get(id: string): Operation {
		const record = this.records.get(id);
		if (!record)
			throw new AppProblem("not_found", "Operation is no longer retained, or was lost when the server restarted.");
		return structuredClone(record);
	}
	create(input: {
		kind: string;
		scope: string;
		key: string;
		fingerprint: string;
		cancellable?: boolean;
		run: (progress: (message: string) => void, signal: AbortSignal) => Promise<OperationResult>;
	}): string {
		const key = JSON.stringify([input.kind, input.scope, input.key]);
		const existing = this.keys.get(key);
		if (existing) {
			if (existing.fingerprint !== input.fingerprint)
				throw new AppProblem("conflict", "Idempotency-Key was already used with different input.");
			return existing.id;
		}
		const id = randomUUID();
		this.keys.set(key, { fingerprint: input.fingerprint, id });
		this.records.set(id, {
			id,
			kind: input.kind,
			revision: 1,
			cancellable: input.cancellable ?? false,
			status: "queued",
			startedAt: new Date().toISOString(),
			progress: [],
		});
		this.cancellations.set(id, new AbortController());
		queueMicrotask(() => {
			void this.run(id, input.run);
		});
		return id;
	}
	cancel(id: string): Operation {
		const record = this.get(id);
		if (!record.cancellable) throw new AppProblem("unsupported", "This operation cannot be interrupted safely.");
		if (record.status === "cancelled") return record;
		if (!live(record)) throw new AppProblem("conflict", "Operation already finished.");
		this.cancellations.get(id)?.abort();
		return this.get(id);
	}
	private progress(id: string, message: string) {
		const record = this.records.get(id);
		if (!record || !live(record)) return;
		const progress: Progress = {
			at: new Date().toISOString(),
			message: Buffer.from(message).subarray(0, 8192).toString("utf8"),
		};
		let omitted = this.omitted.get(id) ?? 0;
		const lines = omitted ? record.progress.slice(1) : [...record.progress];
		lines.push(progress);
		const marker = () => ({ at: record.startedAt, message: `${omitted} earlier lines omitted` });
		while (lines.length + (omitted ? 1 : 0) > 256 || Buffer.byteLength(JSON.stringify([marker(), ...lines])) > 65536) {
			lines.shift();
			omitted++;
		}
		this.omitted.set(id, omitted);
		this.records.set(id, { ...record, revision: record.revision + 1, progress: omitted ? [marker(), ...lines] : lines });
		this.hub.publish({ type: "operation.progress", payload: { resource: id, revision: record.revision + 1, progress } });
	}
	private async run(
		id: string,
		run: (progress: (message: string) => void, signal: AbortSignal) => Promise<OperationResult>,
	) {
		const initial = this.get(id);
		const controller = this.cancellations.get(id);
		if (!controller) throw new Error("Missing operation controller");
		this.records.set(id, { ...initial, status: "running" });
		let terminal: Operation;
		try {
			const result = await run((message) => this.progress(id, message), controller.signal);
			if (controller.signal.aborted) throw new Error("cancelled");
			const record = this.get(id);
			terminal = {
				...record,
				revision: record.revision + 1,
				status: "succeeded",
				finishedAt: new Date().toISOString(),
				result,
			};
		} catch (error) {
			const record = this.get(id);
			terminal = controller.signal.aborted
				? { ...record, revision: record.revision + 1, status: "cancelled", finishedAt: new Date().toISOString() }
				: {
						...record,
						revision: record.revision + 1,
						status: "failed",
						finishedAt: new Date().toISOString(),
						problem: problemOf(error),
					};
		}
		this.cancellations.delete(id);
		this.records.set(id, terminal);
		const bytes = Buffer.byteLength(JSON.stringify(terminal));
		this.hub.publish({
			type: "operation.finished",
			// Large follow-up inventories stay available through REST without overflowing
			// the SSE subscriber's 512 KiB queue. Clients refetch when the snapshot is absent.
			payload: {
				resource: id,
				revision: terminal.revision,
				kind: terminal.kind,
				...(bytes <= 256 * 1024 ? { operation: structuredClone(terminal) } : {}),
			},
		});
		this.finished.push(id);
		this.terminalSizes.set(id, bytes);
		this.retainedBytes += bytes;
		while (this.finished.length > 256 || this.retainedBytes > 16 * 1024 * 1024) {
			const oldest = this.finished.shift();
			if (oldest) {
				this.retainedBytes -= this.terminalSizes.get(oldest) ?? 0;
				this.terminalSizes.delete(oldest);
				this.records.delete(oldest);
				this.omitted.delete(oldest);
			}
		}
	}
}
