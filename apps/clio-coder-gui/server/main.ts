import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { Supervisor } from "./acp/supervisor.js";
import { createApp } from "./app.js";
import { getVersionInfo, resolveClioDirs, resolvePackageRoot } from "./clio/http-shims.js";
import { backgroundEnvironment, readBackgroundConfig } from "./launcher/background-config.js";
import { listenPorts } from "./launcher/ports.js";
import { showPage } from "./local-server.js";
import { restrictNetwork } from "./network-policy.js";
import { serverOptions } from "./options.js";
import { autoOpenBrowser, openApp, openBrowser } from "./process-policy.js";
import { CliRunner } from "./services/cli-runner.js";
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
import { SetupService } from "./services/setup.js";
import { SystemService } from "./services/system.js";
import { TargetsService } from "./services/targets-cli.js";
import { ToolchainService } from "./services/toolchain.js";
import { TraceService } from "./services/traces.js";
import { WorkspaceService } from "./services/workspaces.js";
import { AppFiles } from "./state/files.js";
import { WorkerHost } from "./worker/host.js";

export { prepareGuiUninstall } from "./launcher/uninstall.js";
export { openBrowser } from "./process-policy.js";

declare const __CLIO_GUI_BUNDLED__: boolean;
const bundled = typeof __CLIO_GUI_BUNDLED__ !== "undefined" && __CLIO_GUI_BUNDLED__;
export async function main(args = process.argv.slice(2)) {
	const appClient = fileURLToPath(new URL(bundled ? "./client/" : "../dist/client/", import.meta.url));
	const clientDir =
		bundled || existsSync(join(appClient, "index.html")) ? appClient : join(resolvePackageRoot(), "dist/gui/client");
	const launch = () => ({
		node: process.execPath,
		...(!bundled ? { loader: fileURLToPath(import.meta.resolve("tsx")) } : {}),
		entry: fileURLToPath(import.meta.url),
		icon: join(clientDir, "icon-192.png"),
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
	const open = values.open === "always" || (values.open === "auto" && autoOpenBrowser());
	const openLink = (href: string) =>
		openApp(href).catch(() => {
			console.error("[clio-coder:gui] Could not open the browser. Open the printed URL manually.");
			return "failed" as const;
		});
	// A person at a terminal gets guidance; a pipe, a script or a test gets only the link on stdout.
	const hint = (line: string) => {
		if (process.stderr.isTTY) console.error(`[clio-coder:gui] ${line}`);
	};
	let backgroundAbsent = false;
	if (values.reuse !== "never") {
		const directory = join(resolveClioDirs().state, "gui/background");
		const background = await import("./launcher/background.js");
		const version = getVersionInfo().clio;
		const reused =
			values.reuse === "required"
				? await background
						.tryStartBackground(directory, resolvePackageRoot())
						.then((url) => (url ? { kind: "open" as const, url, running: null } : { kind: "absent" as const }))
				: await background.preferBackground(
						directory,
						resolvePackageRoot(),
						undefined,
						undefined,
						process.platform,
						version,
					);
		if (reused.kind === "open") {
			const url = new URL(reused.url);
			url.pathname = values.path;
			console.log(`[clio-coder:gui] ${url.href}`);
			if ("restartedFrom" in reused)
				console.error(
					`[clio-coder:gui] Restarted the idle background app from Clio Coder ${reused.restartedFrom} to ${reused.running ?? version}.`,
				);
			if (reused.running && reused.running !== version)
				console.error(
					`[clio-coder:gui] The background app is still running Clio Coder ${reused.running}; this installation is ${version}. Restart it to use this version: clio-coder gui background restart`,
				);
			// A window that was already open is only brought forward, still on its own page. A bare launch
			// leaves it there; one that named a page asks the app to show it in that window.
			if (open && (await openLink(url.href)) === "focused" && values.path !== "/") {
				const token = new URLSearchParams(url.hash.slice(1)).get("token") ?? "";
				if (!(await showPage(Number(url.port), token, values.path).catch(() => false)))
					console.error(
						"[clio-coder:gui] The open window was brought forward but could not be shown that page. Open the printed URL in it.",
					);
			}
			return;
		}
		if (reused.kind === "unavailable")
			console.error(`[clio-coder:gui] ${reused.reason} Starting a private server for this terminal instead.`);
		backgroundAbsent = reused.kind === "absent";
	}
	if (bundled && values.fixture) throw new Error("Fabricated tool fixtures are available in source mode only.");
	const persistent = values.persistent ? await readBackgroundConfig(values.persistent) : undefined;
	if (persistent) Object.assign(process.env, backgroundEnvironment(persistent));
	const port = persistent?.port ?? values.port;
	restrictNetwork();
	if (!existsSync(join(clientDir, "index.html")))
		throw new Error("Client build is missing. Run pnpm --filter @iowarp/clio-coder-gui build before start.");
	const scratch = values.fixture ? await mkdtemp(join(tmpdir(), "clio-coder-gui-fixture-")) : undefined;
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
	const workspaces = new WorkspaceService(files, reads),
		supervisor = new Supervisor(workspaces, files, hub, env, undefined, undefined, (cwd, sessionId) =>
			ops.call("sessions.recover", { cwd, sessionId }),
		);
	try {
		await supervisor.reconcile();
	} catch (error) {
		await supervisor.shutdown();
		await Promise.all([reads.close(), ops.close()]);
		throw error;
	}
	const sessions = new SessionService(supervisor, workspaces, reads);
	const cli = new CliRunner(env);
	const settingsService = new SettingsService(reads, workspaces, ops);
	const setup = new SetupService(reads, env, workspaces);
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
		settings: settingsService,
		setup,
		fleet: new FleetService(reads),
		system: new SystemService(reads, workspaces, ops),
		library: new LibraryService(reads, cli, workspaces, ops),
		reports: new ReportsService(cli, workspaces),
		evidence: new EvidenceService(reads, cli, workspaces, operations),
		targets: new TargetsService(cli, workspaces, settingsService, operations),
		sessions,
		idle: () =>
			!(operations.activeCount || cli.activeCount || setup.busy || supervisor.busy || supervisor.hasOpenSessions),
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
	// The background app prefers its configured port and falls back to the next documented one when another
	// program owns it; launchers probe the same ports in the same order. A private server never falls back,
	// because its caller named the port or asked for any free one.
	const candidates = persistent ? listenPorts(port) : [port];
	const server = createAdaptorServer({ fetch: app.fetch, hostname: "127.0.0.1" });
	// One listener for the whole sequence: a failed attempt leaves its own callback registered.
	server.once("listening", () => {
		const info = server.address() as AddressInfo;
		origin = `http://127.0.0.1:${info.port}`;
		const launchUrl = `${origin}${values.path}#token=${token}`;
		if (scratch) console.log(`[clio-coder:gui] Fabricated tool fixture; isolated state: ${scratch}`);
		console.log(persistent ? `[clio-coder:gui] Background app ready at ${origin}.` : `[clio-coder:gui] ${launchUrl}`);
		void log.write(`Listening at ${origin}; idle exit ${values.idleMs ?? "disabled"}.`).catch(fail);
		if (!persistent) {
			hint(
				values.idleMs === undefined
					? "Clio Coder runs while this terminal stays open. Press Ctrl+C to stop it."
					: "Clio Coder stops after it has been idle. Press Ctrl+C to stop it now.",
			);
			if (backgroundAbsent && process.platform === "linux")
				hint(
					"For a stable address that survives this terminal and installs as an app: clio-coder gui background install --open",
				);
		}
		if (open)
			void openBrowser(launchUrl).catch(() => {
				console.error("[clio-coder:gui] Could not open the browser. Open the printed URL manually.");
				void log.write("Could not open the browser; server remains available.").catch(fail);
			});
	});
	const listen = () => {
		server.listen(candidates[0], "127.0.0.1");
	};
	const idle =
		values.idleMs === undefined
			? undefined
			: new IdleExit(
					values.idleMs,
					() =>
						!!(
							operations.activeCount ||
							cli.activeCount ||
							setup.busy ||
							reads.pendingCount ||
							ops.pendingCount ||
							supervisor.busy
						),
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
		await Promise.all([supervisor.shutdown(), cli.close(), setup.close()]);
		await Promise.all([reads.close(), ops.close()]);
		if (scratch) await rm(scratch, { recursive: true, force: true });
		try {
			await log.write("Stopped; owned work and children settled.");
		} finally {
			await log.close();
		}
	};
	const fail = () => {
		console.error("[clio-coder:gui] Server or lifecycle log failed; shutting down.");
		process.exitCode = 1;
		void close().catch(() => {
			process.exitCode = 1;
		});
	};
	server.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE" && !server.listening && candidates.length > 1) {
			const busy = candidates.shift();
			console.error(`[clio-coder:gui] Port ${busy} is in use; trying ${candidates[0]}.`);
			listen();
			return;
		}
		console.error("[clio-coder:gui]", error.message);
		fail();
	});
	listen();
	const stop = () => {
		void close().catch(fail);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	void main().catch((error: unknown) => {
		console.error(`[clio-coder:gui] ${error instanceof Error ? error.message : "Startup failed."}`);
		process.exitCode = 1;
	});
}
