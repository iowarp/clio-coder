/**
 * The browser sign-in half of `clio-coder configure`.
 *
 * This stays on readline rather than the arrow-key prompts: an OAuth flow ends
 * with a code the user pastes, and there is no list to choose from. It lives in
 * its own file so the first-run wizard can start a login without importing the
 * rest of configure.ts.
 */

import type { createInterface } from "node:readline/promises";
import { canOpenBrowser, openBrowser } from "../core/open-browser.js";
import { proxyEnvSummary } from "../core/proxy-env.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import type { RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { ConfigureWizardHost } from "./configure-host.js";
import { createDelayedManualCodeInput } from "./oauth-manual-input.js";
import {
	chooseOAuthMethod,
	describeOAuthError,
	NO_LOCAL_BROWSER_LINE,
	oauthUrlLines,
	promptOAuthSelection,
} from "./oauth-select.js";
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
	// A fresh attempt starts clean: the last attempt's `Sign-in stopped` stood over the new method list and wait.
	host?.clearMessages();
	if (runtime.authNotice) report(`note: ${runtime.authNotice}\n`);
	const browser = canOpenBrowser();
	const open = (url: string): boolean => {
		if (!browser) return false;
		if (host?.openUrl) {
			host.openUrl(url);
			return true;
		}
		return openBrowser(url);
	};
	const manualCodeInput = createDelayedManualCodeInput(
		rl,
		"Paste verification code if browser callback does not complete automatically: ",
	);
	try {
		await auth.login(runtime.oauthProviderId ?? runtime.id, {
			...(signal ? { signal } : {}),
			onAuth: ({ url, instructions }) => {
				report(`\n${oauthUrlLines(url, instructions, open(url)).join("\n")}\n`);
				if (host) {
					host.waiting?.("Waiting for your browser sign-in…");
					offerStop();
				} else if (browser) report("Waiting for the browser callback. A manual code prompt will appear if needed.\n");
			},
			onDeviceCode: ({ verificationUri, userCode }) => {
				open(verificationUri);
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
				const method = chooseOAuthMethod(prompt, browser ? "browser" : "device");
				if (method !== undefined) {
					if (method !== "browser") report(`${NO_LOCAL_BROWSER_LINE}\n`);
					return method;
				}
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
		else if (host) host.report(describeOAuthError(error, proxyEnvSummary()));
		else printError(describeOAuthError(error, proxyEnvSummary()));
		return false;
	} finally {
		manualCodeInput.cancel();
		host?.stoppableWait?.(null);
		host?.waiting?.(null);
		host?.dismissPrompt();
	}
}
