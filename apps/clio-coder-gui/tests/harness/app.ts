import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "typebox";
import type { ClientCredential } from "../../contracts/auth.js";
import type { Operation } from "../../contracts/operations.js";
import type { PermissionTimers } from "../../server/acp/permissions.js";
import { Supervisor } from "../../server/acp/supervisor.js";
import { createApp } from "../../server/app.js";
import { getVersionInfo, runningBuildId } from "../../server/clio/http-shims.js";
import { parse } from "../../server/http/validate.js";
import { ArenaService } from "../../server/services/arena.js";
import { CliRunner } from "../../server/services/cli-runner.js";
import { EventHub } from "../../server/services/event-hub.js";
import { EvidenceService } from "../../server/services/evidence.js";
import { FleetService } from "../../server/services/fleet.js";
import { LibraryService } from "../../server/services/library.js";
import { MachineAttachments } from "../../server/services/machine-attach.js";
import { OperationRegistry } from "../../server/services/operations.js";
import { ReportsService } from "../../server/services/reports.js";
import { ResearchService } from "../../server/services/research.js";
import { SessionService } from "../../server/services/sessions.js";
import { SettingsService, turnCapacitySetting } from "../../server/services/settings.js";
import { SetupService } from "../../server/services/setup.js";
import { SystemService } from "../../server/services/system.js";
import { TargetsService } from "../../server/services/targets-cli.js";
import { TelemetryService } from "../../server/services/telemetry.js";
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
		parkAfterMs?: number;
		origin?: () => string;
		clientDir?: string;
		pwa?: boolean;
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
		undefined,
		options.parkAfterMs,
	);
	await supervisor.reconcile();
	const sessions = new SessionService(supervisor, workspaces);
	const cli = new CliRunner(env);
	// Wired as the server wires it: a written turn limit is re-read from the user layer and applied.
	const settingsService: SettingsService = new SettingsService(reads, workspaces, ops, () =>
		realpath(join(home.path, "state"))
			.then((cwd) => settingsService.controlsAt(cwd))
			.then((controls) => {
				const capacity = turnCapacitySetting(controls);
				if (capacity !== undefined) supervisor.setTurnCapacity(capacity);
			}),
	);
	const setup = new SetupService(reads, env, workspaces);
	// Wired as the server wires it, so the machine switcher reads the scratch home's (empty) node registry.
	const attachments = new MachineAttachments({
		endpoints: async () =>
			reads.call("machines.endpoints", { cwd: await realpath(join(home.path, "state")) }, { deadlineMs: 65_000 }),
		local: () => ({ clio: getVersionInfo().clio, build: runningBuildId }),
		hub,
		env,
	});
	const research = new ResearchService(cli, workspaces, operations, env);
	const app = createApp({
		token: "test-token",
		origin: options.origin ?? (() => "http://127.0.0.1:4317"),
		hub,
		operations,
		toolchain: new ToolchainService(reads, ops, operations, hub),
		attachments,
		traces: new TraceService(reads),
		telemetry: new TelemetryService(reads, (id) => supervisor.knows(id)),
		settings: settingsService,
		setup,
		fleet: new FleetService(reads),
		system: new SystemService(reads, workspaces, ops),
		library: new LibraryService(reads, cli, workspaces, ops),
		reports: new ReportsService(cli, workspaces),
		arena: new ArenaService(cli, workspaces, operations, env),
		research,
		evidence: new EvidenceService(reads, cli, workspaces, operations),
		targets: new TargetsService(cli, workspaces, settingsService, operations, supervisor),
		sessions,
		idle: () =>
			!(operations.activeCount || cli.activeCount || setup.busy || supervisor.busy || supervisor.hasOpenSessions),
		...(options.snapshotHold ? { snapshotHold: options.snapshotHold } : {}),
		diagnostics: true,
		pwa: options.pwa ?? false,
		...(options.clientDir ? { clientDir: options.clientDir } : {}),
	});
	const base = "http://127.0.0.1:4317";
	/** Exchange the launch token as a browser window does; null when the listener refuses the exchange. */
	const exchange = async (label = "Test client", resume?: string): Promise<ClientCredential | null> => {
		const response = await app.request(`${base}/api/auth/clients`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
				"Idempotency-Key": crypto.randomUUID(),
			},
			body: JSON.stringify({ label, ...(resume ? { resume } : {}) }),
		});
		return response.status === 200 ? ((await response.json()) as ClientCredential) : null;
	};
	/** Requests as one client. `credential` resolves lazily so a harness that never calls the API never exchanges. */
	const as = (credential: () => Promise<string>) => {
		const request = async (path: string, init: RequestInit = {}) =>
			app.request(`${base}${path}`, {
				...init,
				headers: { Authorization: `Bearer ${await credential()}`, ...init.headers },
			});
		const post = (path: string, body: unknown = {}, key: string = crypto.randomUUID()) =>
			request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": key },
				body: JSON.stringify(body),
			});
		return { request, post };
	};
	let primary: Promise<ClientCredential | null> | undefined;
	// A listener that refuses the exchange (a wrong origin, say) still answers each request with its refusal.
	const { request, post } = as(async () => {
		primary ??= exchange();
		return (await primary)?.credential ?? "unissued";
	});
	/** A second window: its own client id and credential against the same server. */
	const client = async (label?: string, resume?: string) => {
		const issued = await exchange(label, resume);
		if (!issued) throw new Error("The test server refused the launch token exchange.");
		return { ...issued, ...as(async () => issued.credential) };
	};
	const close = async () => {
		await Promise.all([supervisor.shutdown(), research.close(), cli.close(), setup.close(), attachments.stopAll()]);
		await Promise.all([reads.close(), ops.close()]);
		await home.close();
	};
	// A test's own budgets start once both domain lanes listen. A cold lane spends
	// seconds evaluating root src/** first, and a request that waited out that boot
	// was charged for it against WorkerHost's 30 s queue deadline. Tests of cold
	// lanes construct a WorkerHost themselves.
	try {
		await Promise.all([reads.ready(), ops.ready()]);
	} catch (error) {
		await close();
		throw error;
	}
	return {
		home,
		files,
		workspaces,
		sessions,
		supervisor,
		/** Settles once the turn limit a settings write changed has been applied. */
		reads,
		ops,
		cli,
		hub,
		operations,
		research,
		app,
		request,
		post,
		exchange,
		client,
		close,
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
