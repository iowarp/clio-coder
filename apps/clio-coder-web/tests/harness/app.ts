import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "typebox";
import type { Operation } from "../../contracts/operations.js";
import type { PermissionTimers } from "../../server/acp/permissions.js";
import { Supervisor } from "../../server/acp/supervisor.js";
import { createApp } from "../../server/app.js";
import { parse } from "../../server/http/validate.js";
import { EventHub } from "../../server/services/event-hub.js";
import { OperationRegistry } from "../../server/services/operations.js";
import { SessionService } from "../../server/services/sessions.js";
import { ToolchainService } from "../../server/services/toolchain.js";
import { TraceService } from "../../server/services/traces.js";
import { WorkspaceService } from "../../server/services/workspaces.js";
import { AppFiles } from "../../server/state/files.js";
import { WorkerHost } from "../../server/worker/host.js";
import type { WorkerSettings } from "../../server/worker/protocol.js";
import { scratchHome } from "./scratch-home.js";

export async function harness(
	settings: WorkerSettings = {},
	options: {
		scenario?: string;
		snapshotHold?: () => Promise<void>;
		permissionTimers?: PermissionTimers;
		origin?: () => string;
		clientDir?: string;
	} = {},
) {
	const home = await scratchHome();
	const reads = new WorkerHost("reads", { fixture: true, ...settings }, home.env),
		ops = new WorkerHost("ops", { fixture: true, ...settings }, home.env);
	const hub = new EventHub(),
		operations = new OperationRegistry(hub);
	const files = new AppFiles(join(home.path, "state")),
		workspaces = new WorkspaceService(files);
	const supervisor = new Supervisor(
		workspaces,
		files,
		hub,
		{
			...home.env,
			CLIO_CODER_WEB_CLI: fileURLToPath(new URL("../fixtures/acp-fixture-child.mjs", import.meta.url)),
			CLIO_CODER_WEB_FIXTURE_SCENARIO: options.scenario ?? "text",
			CLIO_CODER_WEB_FIXTURE_LOG: join(home.path, "acp.jsonl"),
		},
		4,
		options.permissionTimers,
	);
	await supervisor.reconcile();
	const sessions = new SessionService(supervisor, workspaces, reads);
	const app = createApp({
		token: "test-token",
		origin: options.origin ?? (() => "http://127.0.0.1:4317"),
		hub,
		operations,
		toolchain: new ToolchainService(reads, ops, operations, hub),
		traces: new TraceService(reads),
		sessions,
		...(options.snapshotHold ? { snapshotHold: options.snapshotHold } : {}),
		diagnostics: true,
		...(options.clientDir ? { clientDir: options.clientDir } : {}),
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
		files,
		workspaces,
		sessions,
		supervisor,
		reads,
		ops,
		hub,
		operations,
		app,
		request,
		post,
		close: async () => {
			await supervisor.shutdown();
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
