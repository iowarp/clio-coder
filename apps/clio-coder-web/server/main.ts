import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Supervisor } from "./acp/supervisor.js";
import { createApp } from "./app.js";
import { resolveClioDirs } from "./clio/http-shims.js";
import { restrictNetwork } from "./network-policy.js";
import { serverOptions } from "./options.js";
import { openBrowser } from "./process-policy.js";
import { CliRunner } from "./services/cli-runner.js";
import { DocsService } from "./services/docs.js";
import { EventHub } from "./services/event-hub.js";
import { EvidenceService } from "./services/evidence.js";
import { FleetService } from "./services/fleet.js";
import { IdleExit } from "./services/idle-exit.js";
import { LibraryService } from "./services/library.js";
import { lifecycleLog } from "./services/log.js";
import { OperationRegistry } from "./services/operations.js";
import { ReportsService } from "./services/reports.js";
import { SessionService } from "./services/sessions.js";
import { SettingsService } from "./services/settings.js";
import { SystemService } from "./services/system.js";
import { TargetsService } from "./services/targets-cli.js";
import { ToolchainService } from "./services/toolchain.js";
import { TraceService } from "./services/traces.js";
import { WorkspaceService } from "./services/workspaces.js";
import { AppFiles } from "./state/files.js";
import { WorkerHost } from "./worker/host.js";

export async function main(args = process.argv.slice(2)) {
	if (args[0] === "launcher") {
		const { launcher } = await import("./launcher/install.js");
		await launcher(args.slice(1));
		return;
	}
	const values = serverOptions(args),
		{ port } = values;
	restrictNetwork();
	const clientDir = fileURLToPath(new URL("../dist/client/", import.meta.url));
	if (!existsSync(join(clientDir, "index.html")))
		throw new Error("Client build is missing. Run pnpm --filter @iowarp/clio-coder-web build before start.");
	const scratch = values.fixture ? await mkdtemp(join(tmpdir(), "clio-coder-web-fixture-")) : undefined;
	const env = scratch
		? {
				...process.env,
				PATH: "",
				CLIO_CODER_HOME: scratch,
				...Object.fromEntries(
					["CONFIG", "DATA", "STATE", "CACHE"].map((role) => [`CLIO_CODER_${role}_DIR`, join(scratch, role.toLowerCase())]),
				),
			}
		: process.env;
	const settings = { fixture: values.fixture, installDelayMs: 900 };
	const reads = new WorkerHost("reads", settings, env),
		ops = new WorkerHost("ops", settings, env);
	const hub = new EventHub(),
		operations = new OperationRegistry(hub);
	const files = new AppFiles(scratch ? join(scratch, "state") : resolveClioDirs().state);
	const workspaces = new WorkspaceService(files),
		supervisor = new Supervisor(workspaces, files, hub, env);
	try {
		await supervisor.reconcile();
	} catch (error) {
		await supervisor.shutdown();
		await Promise.all([reads.close(), ops.close()]);
		throw error;
	}
	const sessions = new SessionService(supervisor, workspaces, reads);
	const cli = new CliRunner(env);
	const settingsService = new SettingsService(reads, workspaces);
	const token = values.token ?? randomBytes(32).toString("base64url");
	let log: Awaited<ReturnType<typeof lifecycleLog>>;
	try {
		log = await lifecycleLog(values.logFile);
	} catch (error) {
		await Promise.all([supervisor.shutdown(), cli.close(), reads.close(), ops.close()]);
		if (scratch) await rm(scratch, { recursive: true, force: true });
		throw error;
	}
	let origin = `http://127.0.0.1:${port}`;
	const app = createApp({
		token,
		origin: () => origin,
		hub,
		operations,
		toolchain: new ToolchainService(reads, ops, operations, hub),
		traces: new TraceService(reads),
		docs: new DocsService(reads),
		settings: settingsService,
		fleet: new FleetService(reads),
		system: new SystemService(reads, workspaces),
		library: new LibraryService(reads, cli, workspaces),
		reports: new ReportsService(reads, cli, workspaces),
		evidence: new EvidenceService(reads, cli, workspaces, operations),
		targets: new TargetsService(cli, workspaces, settingsService, operations),
		sessions,
		clientDir,
	});
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
		origin = `http://127.0.0.1:${info.port}`;
		if (scratch) console.log(`[clio-coder:web] Fabricated tool fixture; isolated state: ${scratch}`);
		console.log(`[clio-coder:web] ${origin}/#token=${token}`);
		void log.write(`Listening at ${origin}; idle exit ${values.idleMs ?? "disabled"}.`).catch(fail);
		if (values.open)
			void openBrowser(`${origin}/#token=${token}`).catch(() => {
				console.error("[clio-coder:web] Could not open the browser. Open the printed URL manually.");
				void log.write("Could not open the browser; server remains available.").catch(fail);
			});
	});
	const idle =
		values.idleMs === undefined
			? undefined
			: new IdleExit(
					values.idleMs,
					() => !!(operations.activeCount || cli.activeCount || reads.pendingCount || ops.pendingCount || supervisor.busy),
					() => {
						void close().catch(fail);
					},
				);
	server.prependListener("request", (_request, response) => {
		const release = idle?.hold();
		if (release) response.once("close", release);
	});
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		idle?.stop();
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		server.close();
		if ("closeAllConnections" in server) server.closeAllConnections();
		await Promise.all([supervisor.shutdown(), cli.close()]);
		await Promise.all([reads.close(), ops.close()]);
		if (scratch) await rm(scratch, { recursive: true, force: true });
		try {
			await log.write("Stopped; owned work and children settled.");
		} finally {
			await log.close();
		}
	};
	const fail = () => {
		console.error("[clio-coder:web] Server or lifecycle log failed; shutting down.");
		process.exitCode = 1;
		void close().catch(() => {
			process.exitCode = 1;
		});
	};
	server.on("error", (error) => {
		console.error("[clio-coder:web]", error.message);
		fail();
	});
	const stop = () => {
		void close().catch(fail);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}
void main().catch((error: unknown) => {
	console.error(`[clio-coder:web] ${error instanceof Error ? error.message : "Startup failed."}`);
	process.exitCode = 1;
});
