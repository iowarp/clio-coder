/**
 * The browser sign-in half of `clio-coder configure`.
 *
 * This stays on readline rather than the arrow-key prompts: an OAuth flow ends
 * with a code the user pastes, and there is no list to choose from. It lives in
 * its own file so the first-run wizard can start a login without importing the
 * rest of configure.ts.
 */

import type { createInterface } from "node:readline/promises";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import type { RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { ConfigureWizardHost } from "./configure-host.js";
import { createDelayedManualCodeInput } from "./oauth-manual-input.js";
import { promptOAuthSelection } from "./oauth-select.js";
import { credentialWriteFailed, printError, printOk } from "./shared.js";

export async function loginOAuthRuntime(
	rl: Pick<ReturnType<typeof createInterface>, "question"> | null,
	runtime: RuntimeDescriptor,
	host?: ConfigureWizardHost,
	/** Set when the operator stopped the wait from the host, so the caller can ask again rather than move on. */
	outcome?: { stopped: boolean },
): Promise<boolean> {
	const auth = openAuthStorage();
	const stop = new AbortController();
	const signal = host ? AbortSignal.any([host.signal, stop.signal]) : undefined;
	const offerStop = (): void =>
		host?.stoppableWait?.(() => {
			if (outcome) outcome.stopped = true;
			stop.abort();
		});
	const report = (line: string): void => {
		if (host) host.report(line);
		else process.stdout.write(line);
	};
	if (host)
		rl = {
			question: async (message: string) => {
				const result = await host.text({ heading: message, mask: true });
				if (result.kind !== "value") throw new Error("Sign-in cancelled");
				return result.value;
			},
		};
	if (!rl) throw new Error("Sign-in requires a prompt host");
	if (runtime.authNotice) report(`note: ${runtime.authNotice}\n`);
	const manualCodeInput = createDelayedManualCodeInput(
		rl,
		"Paste verification code if browser callback does not complete automatically: ",
	);
	try {
		await auth.login(runtime.oauthProviderId ?? runtime.id, {
			...(signal ? { signal } : {}),
			onAuth: ({ url, instructions }) => {
				host?.openUrl?.(url);
				report(`\nOpen: ${url}\n`);
				if (instructions) report(`${instructions}\n`);
				if (host) {
					host.waiting?.("Waiting for your browser sign-in…");
					offerStop();
				} else report("Waiting for the browser callback. A manual code prompt will appear if needed.\n");
			},
			onDeviceCode: ({ verificationUri, userCode }) => {
				host?.openUrl?.(verificationUri);
				report(`\nOpen: ${verificationUri}\n`);
				report(`Enter code: ${userCode}\n`);
				host?.waiting?.("Waiting for that code in your browser…");
				offerStop();
			},
			onPrompt: async (prompt) => {
				const answer = await rl.question(`${prompt.message}${prompt.allowEmpty ? " " : ": "}`);
				return prompt.allowEmpty ? answer : answer.trim();
			},
			onSelect: async (prompt) => {
				if (!host) return promptOAuthSelection(rl, prompt);
				const result = await host.select({
					heading: prompt.message,
					choices: prompt.options.map((option) => ({ value: option.id, label: option.label })),
				});
				// Esc on the method list goes back to the sign-in question, not on to the next step.
				if (result.kind === "back" && outcome) outcome.stopped = true;
				return result.kind === "selected" ? result.value : undefined;
			},
			onManualCodeInput: manualCodeInput.onManualCodeInput,
			onProgress: (message) => {
				if (host) host.report(message);
				else process.stderr.write(`${message}\n`);
			},
		});
		if (
			host ? auth.damageReason() !== null : credentialWriteFailed(auth, `credential for ${runtime.id} was not stored`)
		) {
			if (host) host.report(`Credential not stored: ${auth.damageReason()}`);
			return false;
		}
		if (host) host.report(`Authenticated ${runtime.id}`);
		else printOk(`authenticated ${runtime.id}`);
		return true;
	} catch (error) {
		if (host && outcome?.stopped) host.report("Sign-in stopped; nothing was stored.");
		else if (host) host.report(error instanceof Error ? error.message : String(error));
		else printError(error instanceof Error ? error.message : String(error));
		return false;
	} finally {
		manualCodeInput.cancel();
		host?.stoppableWait?.(null);
		host?.waiting?.(null);
		host?.dismissPrompt();
	}
}
