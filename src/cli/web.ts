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
