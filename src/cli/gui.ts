import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePackageRoot } from "../core/package-root.js";
import { printError } from "./argv.js";

const HELP = `Clio Coder graphical application

Usage:
  clio-coder gui [--open] [--port <0-65535>]
  clio-coder gui background install [--open] [--port <1-65535>]
  clio-coder gui background status|start|open|stop|uninstall
  clio-coder gui launcher install|status|uninstall

The foreground server prints a private launch link. --open opens your default
browser. Press Ctrl+C to stop. --no-open explicitly disables browser opening.
Optional --idle-exit <milliseconds> stops an idle foreground server.
Use --path </app/path> to open a particular page. --reuse-background uses this
installation's background app when configured, or starts a foreground server.

On Linux with a systemd user session, background install keeps the app available
at login. Open its launch link once, then install it from your browser. Background
stop stops it now; background uninstall also removes its login and desktop entries.
Other platforms can run the foreground app. Your CLI, terminal interface,
headless runs, and graphical app use the same Clio runtime and configuration.

A build that does not include the graphical application says so and exits 2.
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
			printError("The Clio Coder graphical application is not included in this build.");
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
	const present = paths.filter(({ path }) => {
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
				if ((await prepareGuiUninstall(options)).items.length)
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
