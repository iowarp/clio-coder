import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The script a relaunched Clio runs. bin/clio-coder.cjs rewrites argv[1] to
 * dist/cli/index.js before it imports dist, so a workspace pane or /restart
 * child started from argv[1] skipped the launcher's registration, and a
 * deferred package-manager update could replace the install under it once
 * the registered parent left (#436). Relaunch through the package's launcher.
 */
export function relaunchScript(script: string): string {
	const cli = path.dirname(script);
	const dist = path.dirname(cli);
	if (path.basename(script) !== "index.js" || path.basename(cli) !== "cli" || path.basename(dist) !== "dist")
		return script;
	const root = path.dirname(dist);
	// A native install's bootstrap runs dist under its managed Node; keep that.
	const versions = path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(root)))));
	if (path.basename(versions) === "versions" && existsSync(path.join(path.dirname(versions), "install.json")))
		return script;
	const launcher = path.join(root, "bin", "clio-coder.cjs");
	return existsSync(launcher) ? launcher : script;
}
