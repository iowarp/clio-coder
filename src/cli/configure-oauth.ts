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
import { createDelayedManualCodeInput } from "./oauth-manual-input.js";
import { promptOAuthSelection } from "./oauth-select.js";
import { credentialWriteFailed, printError, printOk } from "./shared.js";

export async function loginOAuthRuntime(
	rl: ReturnType<typeof createInterface>,
	runtime: RuntimeDescriptor,
): Promise<boolean> {
	const auth = openAuthStorage();
	if (runtime.authNotice) process.stdout.write(`note: ${runtime.authNotice}\n`);
	const manualCodeInput = createDelayedManualCodeInput(
		rl,
		"Paste verification code if browser callback does not complete automatically: ",
	);
	try {
		await auth.login(runtime.oauthProviderId ?? runtime.id, {
			onAuth: ({ url, instructions }) => {
				process.stdout.write(`\nOpen: ${url}\n`);
				if (instructions) process.stdout.write(`${instructions}\n`);
				process.stdout.write("Waiting for the browser callback. A manual code prompt will appear if needed.\n");
			},
			onDeviceCode: ({ verificationUri, userCode }) => {
				process.stdout.write(`\nOpen: ${verificationUri}\n`);
				process.stdout.write(`Enter code: ${userCode}\n`);
			},
			onPrompt: async (prompt) => {
				const answer = await rl.question(`${prompt.message}${prompt.allowEmpty ? " " : ": "}`);
				return prompt.allowEmpty ? answer : answer.trim();
			},
			onSelect: (prompt) => promptOAuthSelection(rl, prompt),
			onManualCodeInput: manualCodeInput.onManualCodeInput,
			onProgress: (message) => {
				process.stderr.write(`${message}\n`);
			},
		});
		if (credentialWriteFailed(auth, `credential for ${runtime.id} was not stored`)) return false;
		printOk(`authenticated ${runtime.id}`);
		return true;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return false;
	} finally {
		manualCodeInput.cancel();
	}
}
