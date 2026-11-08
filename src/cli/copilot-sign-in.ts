import { spawnSync } from "node:child_process";
import { findExecutableOnPath } from "../domains/toolchain/resolve.js";

interface SignInPrompt {
	confirm(question: string): Promise<boolean>;
	/** Called on each side of the sign-in, so a prompt holding stdin lets the sign-in have the terminal. */
	pause?(): unknown;
	resume?(): unknown;
	print(text: string): void;
}

/**
 * With no Copilot login, offer to run the official sign-in in this terminal: `copilot login` when the GitHub
 * Copilot CLI is on PATH, else `gh auth login`. The sign-in is GitHub's own; Clio only starts it.
 */
export async function offerCopilotSignIn(prompt: SignInPrompt): Promise<boolean> {
	const copilot = findExecutableOnPath("copilot");
	const gh = copilot ? null : findExecutableOnPath("gh");
	const command = copilot ? { file: copilot, args: ["login"] } : gh ? { file: gh, args: ["auth", "login"] } : null;
	if (!command) {
		prompt.print(
			"GitHub Copilot is not signed in, and neither the GitHub Copilot CLI (`copilot`) nor the GitHub CLI (`gh`) is on PATH. Install one, sign in with it, then run this again.",
		);
		return false;
	}
	const shown = copilot ? "copilot login" : "gh auth login";
	if (!(await prompt.confirm(`GitHub Copilot is not signed in. Run \`${shown}\` now?`))) return false;
	prompt.pause?.();
	try {
		const run = spawnSync(command.file, command.args, { stdio: "inherit" });
		return run.status === 0;
	} finally {
		prompt.resume?.();
	}
}
