import { allowCopilotKeychain } from "../../core/copilot-keychain.js";
import {
	type CopilotAccount,
	copilotSdkAccount,
	copilotSdkRestartIdle,
	copilotSdkSignInProbe,
	listCopilotSdkModels,
} from "../../engine/ai.js";
import { ensureCopilotSdk, resolveCopilotSdkEntry } from "../lifecycle/copilot-sdk-install.js";
import { COPILOT_SDK_DEFAULT_MODEL } from "./runtimes/copilot/copilot-sdk.js";

export interface CopilotSetupIo {
	/** Absent when nobody can answer (headless, non-TTY); the SDK install is then named, never assumed. */
	confirm?: (question: string) => Promise<boolean>;
	/**
	 * Runs the official sign-in when the runtime has no login, for a surface with an operator at a terminal.
	 * Resolves whether a sign-in ran; Clio never signs in to Copilot itself.
	 */
	signIn?: () => Promise<boolean>;
	print(text: string): void;
}

export type CopilotSetupResult = { ok: true; account: CopilotAccount } | { ok: false; message: string };

/** `github.com` for the public host, the bare host name for a GHE server. */
function copilotHostLabel(host: string): string {
	return host.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
}

/** The neutral line setup shows once the account is known; signing in is the authorization, so nothing is asked. */
function copilotAccountNotice(account: CopilotAccount): string {
	return `Uses your GitHub Copilot subscription as ${account.login} on ${copilotHostLabel(account.host)}; your organization's Copilot policies apply.`;
}

/**
 * Everything a copilot-sdk target needs before its first model call: the SDK component (offered once) and a
 * `copilot login` session. Like the ChatGPT and Claude subscriptions, the signed-in account is the
 * authorization. Configure, onboarding and `auth login copilot-sdk` run it.
 */
export async function prepareCopilotSdk(io: CopilotSetupIo): Promise<CopilotSetupResult> {
	// Someone who can answer the setup questions can answer a keychain prompt too.
	if (io.confirm) allowCopilotKeychain();
	try {
		await ensureCopilotSdk(io.confirm ? { confirm: io.confirm } : {});
		let account: CopilotAccount;
		try {
			account = await copilotSdkAccount();
		} catch (error) {
			if ((error as { code?: unknown } | null)?.code !== "COPILOT_LOGIN_REQUIRED" || !io.signIn || !(await io.signIn()))
				throw error;
			// The running runtime read the login state when it started; a fresh one sees the new login.
			await copilotSdkRestartIdle();
			account = await copilotSdkAccount();
		}
		io.print(copilotAccountNotice(account));
		return { ok: true, account };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

export interface DetectedCopilotLogin {
	account: CopilotAccount;
	model: string;
}

/**
 * A `copilot login` session, for detected-route onboarding. It runs only when the SDK component is already
 * installed (detection never offers a download) and gives up after `timeoutMs`; nothing is billed.
 */
export async function detectCopilotLogin(timeoutMs: number): Promise<DetectedCopilotLogin | null> {
	if (!resolveCopilotSdkEntry()) return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	const probe = (async (): Promise<DetectedCopilotLogin | null> => {
		try {
			const account = await copilotSdkAccount();
			const models = await listCopilotSdkModels();
			const model = (models.find((row) => row.id === COPILOT_SDK_DEFAULT_MODEL) ?? models[0])?.id;
			if (!model) return null;
			return { account, model };
		} catch {
			// No login, no runtime or no enabled model: there is no Copilot route to offer.
			return null;
		}
	})();
	try {
		return await Promise.race([probe, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

export type CopilotSignInCheck =
	| { kind: "signed-in"; login: string; host?: string; authType?: string }
	| { kind: "keychain-only"; login: string; host?: string }
	| { kind: "not-signed-in"; keychainChecked: boolean }
	| { kind: "unavailable"; error: string };

/**
 * Which login the runtime sees with the keychain closed, the way headless runs and workers start it. When it
 * sees none and an operator can answer a keychain prompt, a second runtime asks with the keychain open, so a
 * `copilot login` only the keychain holds is named instead of reported as no login. Never reads a token.
 */
export async function checkCopilotSignIn(operatorPresent: boolean): Promise<CopilotSignInCheck> {
	try {
		const closed = await copilotSdkSignInProbe(false);
		if (closed.signedIn && closed.login)
			return {
				kind: "signed-in",
				login: closed.login,
				...(closed.host ? { host: closed.host } : {}),
				...(closed.authType ? { authType: closed.authType } : {}),
			};
		if (!operatorPresent) return { kind: "not-signed-in", keychainChecked: false };
		const open = await copilotSdkSignInProbe(true);
		if (open.signedIn && open.login)
			return { kind: "keychain-only", login: open.login, ...(open.host ? { host: open.host } : {}) };
		return { kind: "not-signed-in", keychainChecked: true };
	} catch (error) {
		return { kind: "unavailable", error: error instanceof Error ? error.message : String(error) };
	}
}

export interface CopilotAuthState {
	present: boolean;
	detail: string;
}

/**
 * What `auth status` reports for Copilot: the account and host the runtime is signed in as, or why there is
 * none and the command that fixes it. Starts a runtime only when the SDK component is installed.
 */
export async function copilotAuthState(operatorPresent: boolean): Promise<CopilotAuthState> {
	if (!resolveCopilotSdkEntry())
		return { present: false, detail: "SDK component not installed; run `clio-coder auth login copilot-sdk`" };
	const check = await checkCopilotSignIn(operatorPresent);
	const on = (host: string | undefined) => copilotHostLabel(host ?? "https://github.com");
	switch (check.kind) {
		case "signed-in":
			return {
				present: true,
				detail: `signed in as ${check.login} on ${on(check.host)}${check.authType === "gh-cli" ? " (GitHub CLI login)" : ""}`,
			};
		case "keychain-only":
			return {
				present: true,
				detail: `signed in as ${check.login} on ${on(check.host)} in the system keychain only; headless runs and workers cannot see it (see \`clio-coder doctor\`)`,
			};
		case "not-signed-in":
			return { present: false, detail: "not signed in; run `copilot login` (or `gh auth login`)" };
		case "unavailable":
			return { present: false, detail: `unavailable: ${check.error}` };
	}
}
