import { inlineShellScript, type ShellToken, scanShellLikeDeep } from "./protected-artifacts.js";

/**
 * Clio's own settings, credentials and trust are the operator's. A model that
 * shells out to the settings CLI (`clio-coder configure --id ...`) saves
 * settings.yaml with no card and no diff; the sandbox refuses the write, and a
 * rerun with `unsandboxed: true` reached the safety judge, which allowed it
 * because the operator had asked for the setup. The model proposes a change
 * through configure_clio instead, and the operator runs the credential commands.
 */
export const SETTINGS_AUTHORITY_RULE_ID = "settings-authority";

export const SETTINGS_AUTHORITY_REASON =
	"Clio's settings, credentials and trust change only through the operator: propose a settings change with configure_clio, which shows the operator the exact diff, and ask the operator to run credential commands such as `clio-coder auth login` themselves";

const LAUNCHER_PATH =
	/(?:^|\/)(?:@iowarp\/)?clio-coder[^/]*\/(?:.*\/)?(?:dist\/cli\/index\.js|src\/cli\/index\.ts|bin\/clio-coder\.cjs)$/u;
const PACKAGE_SPEC = /^@iowarp\/clio-coder(?:@\S*)?$/u;
const HELP = new Set(["--help", "-h"]);
const REDIRECT = /^(?:\d*[<>]{1,2}[&|]?|&>>?|<<<?-?)$/u;

function isLauncher(token: ShellToken): boolean {
	const word = token.value.replace(/^['"]|['"]$/gu, "");
	const base = word.slice(word.lastIndexOf("/") + 1);
	if (base === "clio-coder" || base === "clio-coder.cjs") return true;
	if (PACKAGE_SPEC.test(word) || LAUNCHER_PATH.test(word)) return true;
	// `$(which clio-coder) configure` runs the launcher the substitution names.
	return (token.substitutions ?? []).some((script) => /\bclio-coder\b/u.test(script));
}

function positional(args: ReadonlyArray<string>): string[] {
	return args.filter((arg) => !arg.startsWith("-"));
}

/** True when the words after the launcher change settings, credentials, trust or Clio's own state. */
function mutatesSettings(args: ReadonlyArray<string>): boolean {
	if (args.some((arg) => arg === "--api-key" || arg.startsWith("--api-key="))) return true;
	if (args.some((arg) => HELP.has(arg))) return false;
	const words = positional(args);
	const [command, sub, third] = words;
	switch (command) {
		case "configure": {
			// Bare `configure` is the setup wizard; only the listing forms read.
			const rest = args.slice(args.indexOf(command) + 1);
			return rest.length === 0 || !rest.every((arg) => ["--json", "--list", "--all"].includes(arg));
		}
		case "targets":
			if (sub === "profile") return third !== undefined && third !== "list" && third !== "bindings";
			return sub !== undefined && ["add", "use", "convert", "remove", "rename"].includes(sub);
		case "auth":
			return sub === "login" || sub === "logout";
		case "config":
			return sub === "trust";
		case "mcp":
			return sub === "trust" || sub === "untrust";
		case "systemone":
			return sub === "use" || sub === "off";
		case "semantic":
			return sub === "configure";
		case "telemetry":
			return sub === "consent" && !(args.includes("--list") && !args.includes("--revoke"));
		case "reset":
		case "uninstall":
			return !args.includes("--dry-run");
		default:
			return false;
	}
}

/**
 * True when a shell command runs Clio's own CLI in a form that changes its
 * settings, credentials or trust. Read forms (`configure --json`, `targets`,
 * `auth status`, `config inspect`, any `--help`) stay allowed. The launcher is
 * found by name, package spec or source path, behind env assignments, wrappers,
 * substitutions and `sh -c` scripts, so autotools `./configure` never matches.
 */
export function invokesSettingsMutation(command: string): boolean {
	const scripts = [command];
	const inline = inlineShellScript(command);
	if (inline !== null && inline !== command) scripts.push(inline);
	for (const script of scripts) {
		let segment: ShellToken[] = [];
		const check = (): boolean => {
			const index = segment.findIndex(isLauncher);
			const hit =
				index >= 0 && mutatesSettings(segment.slice(index + 1).map((token) => token.value.replace(/^['"]|['"]$/gu, "")));
			segment = [];
			return hit;
		};
		let redirectTarget = false;
		for (const token of scanShellLikeDeep(script)) {
			if (token.operator && REDIRECT.test(token.value)) {
				// `2>&1` and `>out.json` belong to the command: drop the fd number and the target word.
				if (/^\d+$/u.test(segment.at(-1)?.value ?? "")) segment.pop();
				redirectTarget = true;
				continue;
			}
			if (token.operator) {
				redirectTarget = false;
				if (check()) return true;
				continue;
			}
			if (redirectTarget) {
				redirectTarget = false;
				continue;
			}
			segment.push(token);
		}
		if (check()) return true;
	}
	return false;
}
