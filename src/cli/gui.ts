import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePackageRoot } from "../core/package-root.js";
import { printError } from "./argv.js";

const HELP = `Clio Coder graphical application

Usage:
  clio-coder gui [--path </app/path>] [--open | --no-open] [--foreground]
  clio-coder gui background install [--open] [--port <1-65535>]
  clio-coder gui background status|start|open|restart [--if-idle]|stop|uninstall
  clio-coder gui launcher install|status|uninstall

clio-coder gui opens Clio Coder in your browser. When this installation's
background app is installed, it reopens that app at its stable address and
returns your terminal. Otherwise it starts a private server for this terminal,
prints its launch link and opens it; press Ctrl+C to stop it.

A browser opens by itself only from an interactive terminal on a desktop.
--open always opens one, --no-open never does. --foreground always starts a
private server, and so does any of --port, --idle-exit <milliseconds>, --token
or --log-file. --path opens a particular page. --reuse-background fails instead
of starting a private server when the background app cannot be used.

On Linux with a systemd user session, background install keeps the app at a
stable address from login, so the browser can install it as an app. That
address is 127.0.0.1:4343, or 127.0.0.1:7373 while another program holds 4343;
--port pins a different one. Background restart loads a newly installed
version; --if-idle leaves it alone when work or a conversation is open. Stop
stops it until the next login or the next clio-coder gui, and uninstall also
removes its login, desktop and Windows entries.
Under WSL, background install also adds a Clio Coder Start Menu shortcut and a
sign-in entry on Windows. The shortcut wakes WSL, starts the app and opens it
in a Chrome or Edge app window; the sign-in entry only wakes WSL and starts it.
macOS and native Windows run the private server only; Windows prints the link
instead of opening it. Your CLI, terminal interface, headless runs, and
graphical app use the same Clio Coder runtime, configuration and sessions, and
the graphical app lists every project the terminal interface has worked in.
`;

export async function runGuiCommand(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	try {
		const root = resolvePackageRoot();
		process.env.CLIO_CODER_PACKAGE_ROOT = root;
		const entry = join(root, "dist/gui/server.js");
		if (!existsSync(entry)) {
			printError("The graphical application has not been built here. Run `pnpm run build` in this checkout.");
			return 2;
		}
		// A URL keeps this a separate entry; bundling it into the command chunk
		// would change import.meta.url and the worker/client paths beside it.
		const server = await import(pathToFileURL(entry).href);
		await server.main(args);
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : "Could not start the graphical application.");
		return 1;
	}
}

/** Separate packaged entry; inspection never starts a listener or opens a browser. */
export interface GuiUninstallPlan {
	items: Array<{ label: string; path: string }>;
	/**
	 * Graphical-application files this build can see and cannot remove, because it
	 * carries no application bundle to verify their ownership or stop their service.
	 * Uninstall reports them and leaves them, together with the state they depend on.
	 */
	unmanaged: Array<{ label: string; path: string }>;
	remove(): Promise<void>;
}

/** The command that removes what `unmanaged` lists, from a build that includes the application. */
export const GUI_UNINSTALL_ADVICE = {
	lead: "To remove them, run from a build that includes the graphical application:",
	command: "clio-coder gui background uninstall && clio-coder gui launcher uninstall",
} as const;

export async function prepareGuiUninstall(options: {
	stateDir: string;
	desktopPrefix: string;
	packageRoot?: string;
	backgroundOnly?: boolean;
}): Promise<GuiUninstallPlan> {
	// Most CLI-only installs have no web lifecycle files. Keep that path lazy,
	// including checkouts whose optional web bundle has not been built yet.
	const paths = [
		{ label: "Graphical background service", path: join(options.stateDir, "gui/background") },
		{ label: "Desktop launcher", path: join(options.desktopPrefix, "applications/io.iowarp.ClioCoder.desktop") },
		{
			label: "Desktop launcher ownership record",
			path: join(options.desktopPrefix, "applications/io.iowarp.ClioCoder.desktop.owner.json"),
		},
	];
	const present = paths.filter(({ path }, index) => {
		if (options.backgroundOnly && index !== 0) return false;
		try {
			lstatSync(path);
			return true;
		} catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
			throw error;
		}
	});
	if (!present.length)
		return {
			items: [],
			unmanaged: [],
			remove: async () => {
				const current = await prepareGuiUninstall(options);
				if (current.items.length || current.unmanaged.length)
					throw new Error("A web installation appeared during confirmation; run uninstall again.");
			},
		};
	const packageRoot = options.packageRoot ?? resolvePackageRoot();
	const entry = join(packageRoot, "dist/gui/server.js");
	// A terminal-only build has no bundle. Deleting these files blind could strand a running systemd
	// unit or remove a launcher another installation owns, so they are reported and left alone.
	if (!existsSync(entry)) return { items: [], unmanaged: present, remove: async () => {} };
	const server = await import(pathToFileURL(entry).href);
	const plan = await server.prepareGuiUninstall({ ...options, packageRoot });
	return { ...plan, unmanaged: [] };
}
