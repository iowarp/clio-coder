/**
 * Lazy loader for the optional `@github/copilot-sdk` component. Nothing imports it at module scope:
 * boot, `doctor` and every other runtime work on an install that never fetched it, and a missing package
 * surfaces as a typed error naming the install command.
 */
import { pathToFileURL } from "node:url";
import type { CopilotClient } from "@github/copilot-sdk";
import { CopilotSdkUnavailableError, resolveCopilotSdkEntry } from "../../domains/lifecycle/copilot-sdk-install.js";

/** The slice of the SDK surface the adapter calls. */
export interface CopilotSdkModule {
	CopilotClient: typeof CopilotClient;
}

export async function loadCopilotSdk(): Promise<CopilotSdkModule> {
	const entry = resolveCopilotSdkEntry();
	if (!entry) throw new CopilotSdkUnavailableError();
	const sdk: CopilotSdkModule = await import(pathToFileURL(entry).href);
	if (typeof sdk.CopilotClient !== "function") throw new Error(`Copilot SDK at ${entry} does not export CopilotClient.`);
	return sdk;
}
