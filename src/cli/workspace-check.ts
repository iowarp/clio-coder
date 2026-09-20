import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { canSelect, promptSelect } from "./select.js";

export type WorkspaceConcern = "home" | "system" | null;

/** Inputs are canonical paths so a symlink cannot hide a broad workspace. */
export function workspaceConcern(cwd: string, home: string): WorkspaceConcern {
	if (cwd === home || ["/home", "/Users"].includes(path.dirname(cwd)) || cwd === "/root") return "home";
	const under = (root: string) => cwd === root || cwd.startsWith(`${root}${path.sep}`);
	if ([path.parse(cwd).root, "/home", "/Users", "/tmp", "/var/tmp", "/opt", "/srv", "/mnt", "/media"].includes(cwd))
		return "system";
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

/** Runs before project configuration, hooks, or the interactive shell load. */
export async function confirmStartupWorkspace(cwd = process.cwd()): Promise<boolean> {
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
		"Open a project folder instead if you did not intend this scope.",
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
		choices: [
			{ value: false, label: "No, exit" },
			{ value: true, label: "Yes, open this folder" },
		],
		initialIndex: 0,
		backLabel: "cancel",
		clearOnExit: true,
	});
	return result.kind === "selected" && result.value;
}
