import { spawnSync } from "node:child_process";
import { findExecutableOnPath } from "../domains/toolchain/resolve.js";
import { askYesNo } from "./ask.js";

/**
 * With no Copilot login, offer to run the official sign-in in this terminal: `copilot login` when the GitHub
 * Copilot CLI is on PATH, else `gh auth login`. The sign-in is GitHub's own; Clio only starts it.
 */
type SignInPrompts = Parameters<typeof askYesNo>[0] & { pause?: () => unknown; resume?: () => unknown };

export async function offerCopilotSignIn(rl: SignInPrompts): Promise<boolean> {
	const copilot = findExecutableOnPath("copilot");
	const gh = copilot ? null : findExecutableOnPath("gh");
	const command = copilot ? { file: copilot, args: ["login"] } : gh ? { file: gh, args: ["auth", "login"] } : null;
	if (!command) {
		process.stdout.write(
			"GitHub Copilot is not signed in, and neither the GitHub Copilot CLI (`copilot`) nor the GitHub CLI (`gh`) is on PATH. Install one, sign in with it, then run this again.\n",
		);
		return false;
	}
	const shown = copilot ? "copilot login" : "gh auth login";
	if (!(await askYesNo(rl, `GitHub Copilot is not signed in. Run \`${shown}\` now?`, true))) return false;
	// The sign-in owns the terminal until it exits; a readline that holds stdin lets go of it meanwhile.
	rl.pause?.();
	try {
		const run = spawnSync(command.file, command.args, { stdio: "inherit" });
		return run.status === 0;
	} finally {
		rl.resume?.();
	}
}
