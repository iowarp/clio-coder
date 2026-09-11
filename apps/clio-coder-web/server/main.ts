import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Supervisor } from "./acp/supervisor.js";
import { createApp } from "./app.js";
import { resolveClioDirs, resolvePackageRoot } from "./clio/http-shims.js";
import { backgroundEnvironment, readBackgroundConfig } from "./launcher/background-config.js";
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

export { prepareWebUninstall } from "./launcher/uninstall.js";

declare const __CLIO_WEB_BUNDLED__: boolean;
const bundled = typeof __CLIO_WEB_BUNDLED__ !== "undefined" && __CLIO_WEB_BUNDLED__;
export async function main(args = process.argv.slice(2)) {
	const launch = () => ({
		node: process.execPath,
		...(!bundled ? { loader: fileURLToPath(import.meta.resolve("tsx")) } : {}),
		entry: fileURLToPath(import.meta.url),
		icon: fileURLToPath(new URL(bundled ? "./client/icon-192.png" : "../dist/client/icon-192.png", import.meta.url)),
	});
	if (args[0] === "background") {
		const { background } = await import("./launcher/background.js");
		await background(args.slice(1), launch());
		return;
	}
	if (args[0] === "launcher") {
		const { launcher } = await import("./launcher/install.js");
		await launcher(args.slice(1), launch());
		return;
	}
	const values = serverOptions(args);
	if (values.reuseBackground) {
		const { tryStartBackground } = await import("./launcher/background.js");
		const existing = await tryStartBackground(join(resolveClioDirs().state, "web/background"), resolvePackageRoot());
		if (existing) {
			const url = new URL(existing);
			url.pathname = values.path;
			console.log(`[clio-coder:web] ${url.href}`);
			if (values.open)
				await openBrowser(url.href).catch(() => {
					console.error("[clio-coder:web] Could not open the browser. Open the printed URL manually.");
				});
			return;
		}
	}
	if (bundled && values.fixture) throw new Error("Fabricated tool fixtures are available in source mode only.");
	const persistent = values.persistent ? await readBackgroundConfig(values.persistent) : undefined;
	if (persistent) Object.assign(process.env, backgroundEnvironment(persistent));
	const port = persistent?.port ?? values.port;
	restrictNetwork();
	const clientDir = fileURLToPath(new URL(bundled ? "./client/" : "../dist/client/", import.meta.url));
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
	const compiledDirectory = bundled ? new URL("./", import.meta.url) : undefined;
	const reads = new WorkerHost("reads", settings, env, compiledDirectory),
		ops = new WorkerHost("ops", settings, env, compiledDirectory);
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
	const token = persistent?.token ?? values.token ?? randomBytes(32).toString("base64url");
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
		pwa: !!persistent,
		...(process.env.NODE_ENV === "test"
			? {
					runtime: async () => ({
						server: { entry: import.meta.url, packageRoot: resolvePackageRoot(), execArgv: process.execArgv },
						reads: await reads.call("runtime.info", {}),
						ops: await ops.call("runtime.info", {}),
					}),
				}
			: {}),
	});
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
		origin = `http://127.0.0.1:${info.port}`;
		const launchUrl = `${origin}${values.path}#token=${token}`;
		if (scratch) console.log(`[clio-coder:web] Fabricated tool fixture; isolated state: ${scratch}`);
		console.log(persistent ? `[clio-coder:web] Background app ready at ${origin}.` : `[clio-coder:web] ${launchUrl}`);
		void log.write(`Listening at ${origin}; idle exit ${values.idleMs ?? "disabled"}.`).catch(fail);
		if (values.open)
			void openBrowser(launchUrl).catch(() => {
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
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	void main().catch((error: unknown) => {
		console.error(`[clio-coder:web] ${error instanceof Error ? error.message : "Startup failed."}`);
		process.exitCode = 1;
	});
}
