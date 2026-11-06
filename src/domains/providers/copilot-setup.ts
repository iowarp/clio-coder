import { copilotSdkAccount, listCopilotSdkModels } from "../../engine/ai.js";
import { ensureCopilotSdk, resolveCopilotSdkEntry } from "../lifecycle/copilot-sdk-install.js";
import {
	type CopilotAccount,
	copilotConsentMissingMessage,
	copilotConsentText,
	hasCopilotConsent,
	recordCopilotConsent,
} from "./copilot-consent.js";

export interface CopilotSetupIo {
	/** Absent when nobody can answer (headless, non-TTY); the setup then refuses instead of assuming. */
	confirm?: (question: string) => Promise<boolean>;
	print(text: string): void;
}

export type CopilotSetupResult = { ok: true; account: CopilotAccount } | { ok: false; message: string };

/**
 * Everything a copilot-sdk target needs before its first model call: the SDK component (offered once), a
 * `copilot login` session, and this account's one-time consent. Configure, onboarding and
 * `auth login copilot-sdk` run it; the stream itself refuses when consent is missing.
 */
export async function prepareCopilotSdk(io: CopilotSetupIo): Promise<CopilotSetupResult> {
	try {
		await ensureCopilotSdk(io.confirm ? { confirm: io.confirm } : {});
		const account = await copilotSdkAccount();
		if (hasCopilotConsent(account)) return { ok: true, account };
		if (!io.confirm) return { ok: false, message: copilotConsentMissingMessage(account) };
		io.print(copilotConsentText(account));
		if (!(await io.confirm(`Allow Clio to use GitHub Copilot as ${account.login}?`))) {
			return { ok: false, message: "GitHub Copilot consent was declined; the copilot-sdk target stays unusable." };
		}
		recordCopilotConsent(account);
		return { ok: true, account };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

export interface DetectedCopilotLogin {
	account: CopilotAccount;
	model: string;
	consented: boolean;
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
			const model = models[0]?.id;
			if (!model) return null;
			return { account, model, consented: hasCopilotConsent(account) };
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
