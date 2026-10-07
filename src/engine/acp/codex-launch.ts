import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { DelegationAgentConfig } from "../../core/defaults.js";

/** Keep the standard ACP bridge on the same Codex installation the operator uses. */
export function withInstalledCodex(
	agent: DelegationAgentConfig,
	cwd: string,
	env: Record<string, string> = {},
): Record<string, string> {
	if (
		!["npx", "npx.cmd"].includes(agent.command) ||
		agent.args.length !== 2 ||
		agent.args[0] !== "-y" ||
		!/^@agentclientprotocol\/codex-acp@\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(agent.args[1] ?? "") ||
		Object.hasOwn(env, "CODEX_PATH")
	)
		return env;
	const names =
		process.platform === "win32"
			? ["codex", ...(env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => `codex${ext}`)]
			: ["codex"];
	// npx prepends its dependency binaries to PATH. Resolve before launching it,
	// or CODEX_PATH=codex still finds the bridge's older bundled Codex.
	for (const directory of (env.PATH ?? process.env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		for (const name of names) {
			const candidate = path.resolve(cwd, directory, name);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return { ...env, CODEX_PATH: candidate };
			} catch {
				// A missing or inaccessible CLI leaves the adapter's bundled default.
			}
		}
	}
	return env;
}
