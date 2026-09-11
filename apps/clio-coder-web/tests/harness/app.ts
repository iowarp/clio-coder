import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "typebox";
import type { Operation } from "../../contracts/operations.js";
import type { PermissionTimers } from "../../server/acp/permissions.js";
import { Supervisor } from "../../server/acp/supervisor.js";
import { createApp } from "../../server/app.js";
import { parse } from "../../server/http/validate.js";
import { CliRunner } from "../../server/services/cli-runner.js";
import { DocsService } from "../../server/services/docs.js";
import { EventHub } from "../../server/services/event-hub.js";
import { EvidenceService } from "../../server/services/evidence.js";
import { FleetService } from "../../server/services/fleet.js";
import { LibraryService } from "../../server/services/library.js";
import { OperationRegistry } from "../../server/services/operations.js";
import { ReportsService } from "../../server/services/reports.js";
import { SessionService } from "../../server/services/sessions.js";
import { SettingsService } from "../../server/services/settings.js";
import { TargetsService } from "../../server/services/targets-cli.js";
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
		env?: NodeJS.ProcessEnv;
		snapshotHold?: () => Promise<void>;
		permissionTimers?: PermissionTimers;
		origin?: () => string;
		clientDir?: string;
	} = {},
) {
	const home = await scratchHome();
	const env = { ...home.env, ...options.env };
	const reads = new WorkerHost("reads", { fixture: true, ...settings }, env),
		ops = new WorkerHost("ops", { fixture: true, ...settings }, env);
	const hub = new EventHub(),
		operations = new OperationRegistry(hub);
	const files = new AppFiles(join(home.path, "state")),
		workspaces = new WorkspaceService(files);
	const supervisor = new Supervisor(
		workspaces,
		files,
		hub,
		{
			...env,
			CLIO_CODER_WEB_CLI: fileURLToPath(new URL("../fixtures/acp-fixture-child.mjs", import.meta.url)),
			CLIO_CODER_WEB_FIXTURE_SCENARIO: options.scenario ?? "text",
			CLIO_CODER_WEB_FIXTURE_LOG: join(home.path, "acp.jsonl"),
		},
		4,
		options.permissionTimers,
	);
	await supervisor.reconcile();
	const sessions = new SessionService(supervisor, workspaces, reads);
	const cli = new CliRunner(env);
	const settingsService = new SettingsService(reads, workspaces);
	const app = createApp({
		token: "test-token",
		origin: options.origin ?? (() => "http://127.0.0.1:4317"),
		hub,
		operations,
		toolchain: new ToolchainService(reads, ops, operations, hub),
		traces: new TraceService(reads),
		docs: new DocsService(reads),
		settings: settingsService,
		fleet: new FleetService(reads),
		library: new LibraryService(reads, cli, workspaces),
		reports: new ReportsService(reads, cli, workspaces),
		evidence: new EvidenceService(reads, cli, workspaces, operations),
		targets: new TargetsService(cli, workspaces, settingsService, operations),
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
		cli,
		hub,
		operations,
		app,
		request,
		post,
		close: async () => {
			await Promise.all([supervisor.shutdown(), cli.close()]);
			await Promise.all([reads.close(), ops.close()]);
			await home.close();
		},
	};
}
export async function json<S extends TSchema>(response: Response, schema: S): Promise<Static<S>> {
	return parse(schema, await response.json());
}
export async function terminal(operations: OperationRegistry, id: string, timeoutMs = 4000): Promise<Operation> {
	for (let i = 0; i < Math.ceil(timeoutMs / 20); i++) {
		const record = operations.get(id);
		if (record.status !== "queued" && record.status !== "running") return record;
		await setTimeout(20);
	}
	throw new Error(`Operation did not finish within ${timeoutMs} ms.`);
}
