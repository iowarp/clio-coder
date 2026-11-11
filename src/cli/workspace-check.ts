import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { canSelect, promptSelect } from "./select.js";

export type WorkspaceConcern = "home" | "system" | null;

/** Inputs are canonical paths so a symlink cannot hide a broad workspace. */
export function workspaceConcern(cwd: string, home: string): WorkspaceConcern {
	if (cwd === home || ["/home", "/Users"].includes(path.dirname(cwd)) || cwd === "/root") return "home";
	// macOS keeps /etc, /tmp and /var in /private behind links from the root, so
	// their canonical paths start there. Judge them by the names the lists use.
	const named = /^\/private\/(?:etc|tmp|var)(?:\/|$)/u.test(cwd) ? cwd.slice("/private".length) : cwd;
	const under = (root: string) => named === root || named.startsWith(`${root}${path.sep}`);
	const shared = ["/home", "/Users", "/private", "/tmp", "/var/tmp", "/opt", "/srv", "/mnt", "/media"];
	if (named === path.parse(named).root || shared.includes(named)) return "system";
	if (["/var/tmp", "/var/folders", "/usr/local/src"].some(under)) return null;
	return [
		"/etc",
		"/usr",
		"/bin",
		"/sbin",
		"/lib",
		"/lib64",
		"/boot",
		"/dev",
		"/proc",
		"/sys",
		"/run",
		"/var",
		"/System",
		"/Library",
	].some(under)
		? "system"
		: null;
}

/**
 * Runs before project configuration, hooks, or the interactive shell load. Right after a first-run setup the
 * user typed `clio-coder` where they were, usually home, so the question leads to a project instead of an exit.
 */
export async function confirmStartupWorkspace(
	cwd = process.cwd(),
	options: { afterSetup?: boolean } = {},
): Promise<boolean> {
	const canonical = realpathSync(cwd);
	const concern = workspaceConcern(canonical, realpathSync(homedir()));
	if (concern === null) return true;
	const heading = [
		"",
		"Open this workspace?",
		"",
		`  ${sanitizeCallTargetText(canonical)}`,
		"",
		concern === "home"
			? "This is your home folder. It includes personal files and application settings."
			: "This is a system or shared folder. Changes here can affect more than one project.",
		"Clio can read files and, depending on permissions, edit files and run commands.",
		options.afterSetup
			? "Clio works in a project folder: cd into one and run clio-coder there."
			: "Open a project folder instead if you did not intend this scope.",
		"",
	];
	if (!canSelect()) {
		process.stderr.write(
			`${heading.join("\n")}\nStart from a project folder or use a terminal to confirm this workspace.\n`,
		);
		return false;
	}
	const result = await promptSelect({
		heading,
		choices: options.afterSetup
			? [
					{ value: false, label: "Exit, then cd into a project and run clio-coder" },
					{ value: true, label: "Open this folder anyway" },
				]
			: [
					{ value: false, label: "No, exit" },
					{ value: true, label: "Yes, open this folder" },
				],
		initialIndex: 0,
		backLabel: "cancel",
		clearOnExit: true,
	});
	return result.kind === "selected" && result.value;
}
