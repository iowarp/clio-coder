import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";

/**
 * One-time consent per GitHub account before Clio sends model calls through the account's Copilot seat.
 * The record names the account and the time; it holds no token. Like the interop decisions, it lives in
 * Clio's state directory and is written under the state lock.
 */
export interface CopilotAccount {
	/** GitHub login the official Copilot runtime reports as signed in. */
	login: string;
	/** GitHub host, `https://github.com` unless the account is on GHE. */
	host: string;
}

interface ConsentRecord {
	login: string;
	host: string;
	acceptedAt: string;
}

interface ConsentFile {
	version: 1;
	accounts: ConsentRecord[];
}

export const COPILOT_CONSENT_COMMAND = "clio-coder auth login copilot-sdk";

function copilotConsentPath(): string {
	return path.join(clioStateDir(), "copilot-sdk-consent.json");
}

function accountKey(account: CopilotAccount): string {
	return `${account.host.replace(/\/+$/u, "").toLowerCase()}\u0000${account.login.toLowerCase()}`;
}

function readConsentFile(): ConsentFile {
	const file = copilotConsentPath();
	if (!existsSync(file)) return { version: 1, accounts: [] };
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { accounts?: unknown };
		const accounts = Array.isArray(raw.accounts)
			? raw.accounts.filter(
					(entry): entry is ConsentRecord =>
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as ConsentRecord).login === "string" &&
						typeof (entry as ConsentRecord).host === "string" &&
						typeof (entry as ConsentRecord).acceptedAt === "string",
				)
			: [];
		return { version: 1, accounts };
	} catch {
		// A damaged file grants nothing: every account is asked again, which is the safe direction.
		return { version: 1, accounts: [] };
	}
}

export function hasCopilotConsent(account: CopilotAccount): boolean {
	const key = accountKey(account);
	return readConsentFile().accounts.some((entry) => accountKey(entry) === key);
}

export function recordCopilotConsent(account: CopilotAccount, now = new Date()): void {
	withStateFileLockSync(copilotConsentPath(), () => {
		const current = readConsentFile();
		const key = accountKey(account);
		const accounts = current.accounts.filter((entry) => accountKey(entry) !== key);
		accounts.push({ login: account.login, host: account.host, acceptedAt: now.toISOString() });
		safeResourceWrite(copilotConsentPath(), `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, {
			encoding: "utf8",
		});
	});
}

/** The disclosure the consent prompt shows, naming the account it binds. */
export function copilotConsentText(account: CopilotAccount): string {
	const host = account.host.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
	return [
		`Clio will send model calls through GitHub Copilot as ${account.login} on ${host}.`,
		"Each request bills that account's Copilot seat, or its organization's pool, in premium requests and AI credits.",
		"Your enterprise or organization's Copilot policies, model availability and data retention apply to everything sent.",
		"Clio stores no Copilot token; the official Copilot runtime uses the login from `copilot login`.",
	].join("\n");
}

export function copilotConsentMissingMessage(account: CopilotAccount): string {
	const host = account.host.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
	return `GitHub Copilot use by Clio has not been consented to for ${account.login} on ${host}. Run \`${COPILOT_CONSENT_COMMAND}\` in a terminal to review what it bills and consent once for this account.`;
}
