import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePackageRoot } from "../core/package-root.js";
import { printError } from "./argv.js";

const HELP = `Clio Coder web application

Usage:
  clio-coder web [--open] [--port <0-65535>]
  clio-coder web background install [--open] [--port <1-65535>]
  clio-coder web background status|start|open|stop|uninstall
  clio-coder web launcher install|status|uninstall

The foreground server prints a private launch link. --open opens your default
browser. Press Ctrl+C to stop. --no-open explicitly disables browser opening.
Optional --idle-exit <milliseconds> stops an idle foreground server.
Use --path </app/path> to open a particular page. --reuse-background uses this
installation's background app when configured, or starts a foreground server.

On Linux with a systemd user session, background install keeps the app available
at login. Open its launch link once, then install it from your browser. Background
stop stops it now; background uninstall also removes its login and desktop entries.
Other platforms can run the foreground web app. Your CLI, terminal interface,
headless runs, and web app use the same Clio runtime and configuration.
`;

export async function runWebCommand(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	try {
		const root = resolvePackageRoot();
		process.env.CLIO_CODER_PACKAGE_ROOT = root;
		// A URL keeps this a separate entry; bundling it into the command chunk
		// would change import.meta.url and the worker/client paths beside it.
		const server = await import(pathToFileURL(join(root, "dist/web/server.js")).href);
		await server.main(args);
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : "Could not start the web application.");
		return 1;
	}
}

/** Separate packaged entry; inspection never starts a listener or opens a browser. */
export async function prepareWebUninstall(options: { stateDir: string; desktopPrefix: string }): Promise<{
	items: Array<{ label: string; path: string }>;
	remove(): Promise<void>;
}> {
	// Most CLI-only installs have no web lifecycle files. Keep that path lazy,
	// including checkouts whose optional web bundle has not been built yet.
	const paths = [
		join(options.stateDir, "web/background"),
		join(options.desktopPrefix, "applications/io.iowarp.ClioCoder.desktop"),
		join(options.desktopPrefix, "applications/io.iowarp.ClioCoder.desktop.owner.json"),
	];
	const present = paths.some((path) => {
		try {
			lstatSync(path);
			return true;
		} catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
			throw error;
		}
	});
	if (!present)
		return {
			items: [],
			remove: async () => {
				if ((await prepareWebUninstall(options)).items.length)
					throw new Error("A web installation appeared during confirmation; run uninstall again.");
			},
		};
	const packageRoot = resolvePackageRoot();
	const server = await import(pathToFileURL(join(packageRoot, "dist/web/server.js")).href);
	return server.prepareWebUninstall({ ...options, packageRoot });
}
