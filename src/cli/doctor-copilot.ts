import { readSettings } from "../core/config.js";
import { copilotKeychainOnlyDetail } from "../core/copilot-keychain.js";
import { resolveCopilotSdkEntry } from "../domains/lifecycle/copilot-sdk-install.js";
import { type DoctorFinding, targetIsActive } from "../domains/lifecycle/doctor.js";
import type { CopilotSignInCheck } from "../domains/providers/copilot-setup.js";

const NAME = "copilot sign-in";

function signedInVia(authType: string | undefined): string {
	if (authType === "gh-cli") return "the GitHub CLI login (`gh auth login`)";
	if (authType === "user") return "a `copilot login` the runtime reads from disk";
	return authType ? `the runtime's ${authType} login` : "a login the runtime reads without the keychain";
}

/** `active`: chat, memory or the fleet routes to a copilot-sdk target, so a missing login is an error, not a warning. */
export function copilotSignInFinding(check: CopilotSignInCheck, active = true): DoctorFinding {
	switch (check.kind) {
		case "signed-in":
			return {
				ok: true,
				name: NAME,
				detail: `signed in as ${check.login} through ${signedInVia(check.authType)}; every surface, headless runs and fleet workers included, can use it`,
			};
		case "keychain-only":
			return { ok: true, level: "warn", name: NAME, detail: copilotKeychainOnlyDetail(check.login) };
		case "not-signed-in":
			return {
				ok: !active,
				...(active ? {} : { level: "warn" as const }),
				name: NAME,
				detail: `not signed in: run \`copilot login\` or \`gh auth login\`, then \`clio-coder doctor\` again; Clio never signs in to Copilot itself${
					check.keychainChecked
						? ""
						: ". The system keychain was not checked because no operator is present to answer its prompt; run `clio-coder doctor` in a terminal to check it"
				}`,
			};
		case "unavailable":
			return { ok: true, level: "warn", name: NAME, detail: `the Copilot runtime could not be asked: ${check.error}` };
	}
}

export interface CopilotSignInReport {
	check: CopilotSignInCheck;
	finding: DoctorFinding;
}

/**
 * The sign-in check and its row when a copilot-sdk target is configured and the SDK component is installed: which
 * login the runtime sees with the keychain closed (as headless runs and workers start it), and, from a terminal,
 * whether a `copilot login` lives only in the keychain. Doctor runs it before the connection sweep, so a Copilot
 * connection row can agree with it. Each check starts a short-lived runtime; no token is read.
 */
export async function copilotSignInReport(): Promise<CopilotSignInReport | null> {
	let targets: string[];
	let active: boolean;
	try {
		const settings = readSettings();
		targets = settings.targets.filter((target) => target.runtime === "copilot-sdk").map((target) => target.id);
		active = targets.some((id) => targetIsActive(settings, id));
	} catch {
		// An unreadable settings file has its own doctor row.
		return null;
	}
	if (targets.length === 0 || !resolveCopilotSdkEntry()) return null;
	const { checkCopilotSignIn } = await import("../domains/providers/copilot-setup.js");
	const check = await checkCopilotSignIn(process.stdin.isTTY === true);
	return { check, finding: copilotSignInFinding(check, active) };
}
