import { setTimeout } from "node:timers/promises";
import type { Static, TSchema } from "typebox";
import type { Operation } from "../../contracts/operations.js";
import { createApp } from "../../server/app.js";
import { parse } from "../../server/http/validate.js";
import { EventHub } from "../../server/services/event-hub.js";
import { OperationRegistry } from "../../server/services/operations.js";
import { ToolchainService } from "../../server/services/toolchain.js";
import { TraceService } from "../../server/services/traces.js";
import { WorkerHost } from "../../server/worker/host.js";
import type { WorkerSettings } from "../../server/worker/protocol.js";
import { scratchHome } from "./scratch-home.js";

export async function harness(settings: WorkerSettings = {}) {
	const home = await scratchHome();
	const reads = new WorkerHost("reads", { fixture: true, ...settings }, home.env),
		ops = new WorkerHost("ops", { fixture: true, ...settings }, home.env);
	const hub = new EventHub(),
		operations = new OperationRegistry(hub);
	const app = createApp({
		token: "test-token",
		origin: () => "http://127.0.0.1:4317",
		hub,
		operations,
		toolchain: new ToolchainService(reads, ops, operations, hub),
		traces: new TraceService(reads),
		diagnostics: true,
	});
	const request = (path: string, init: RequestInit = {}) =>
		app.request(`http://127.0.0.1:4317${path}`, {
			...init,
			headers: { Authorization: "Bearer test-token", ...init.headers },
		});
	const post = (path: string, body: unknown = {}, key: string = crypto.randomUUID()) =>
		request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": key },
			body: JSON.stringify(body),
		});
	return {
		home,
		reads,
		ops,
		hub,
		operations,
		app,
		request,
		post,
		close: async () => {
			await Promise.all([reads.close(), ops.close()]);
			await home.close();
		},
	};
}
export async function json<S extends TSchema>(response: Response, schema: S): Promise<Static<S>> {
	return parse(schema, await response.json());
}
export async function terminal(operations: OperationRegistry, id: string): Promise<Operation> {
	for (let i = 0; i < 200; i++) {
		const record = operations.get(id);
		if (record.status !== "queued" && record.status !== "running") return record;
		await setTimeout(20);
	}
	throw new Error("Operation did not finish within four seconds.");
}
