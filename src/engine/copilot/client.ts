/**
 * One Copilot runtime per process, started through the official SDK with the signed-in user only.
 *
 * Clio passes no token and reads no token store: `useLoggedInUser` makes the runtime use the login that
 * the official `copilot login` wrote under `COPILOT_HOME` (default `~/.copilot`). GitHub token variables
 * are removed from the runtime's environment so an ambient `GH_TOKEN` cannot stand in for that login.
 * The SDK identifies itself to GitHub with its own client identity plus `clientName`; Clio sets no
 * request headers of its own.
 */
import type { CopilotClient, ModelInfo } from "@github/copilot-sdk";
import type { CopilotAccount } from "../../domains/providers/copilot-consent.js";
import { loadCopilotSdk } from "./sdk-module.js";

export const COPILOT_CLIENT_NAME = "clio-coder";

export const COPILOT_LOGIN_MESSAGE =
	"GitHub Copilot is not signed in. Sign in with the official GitHub Copilot CLI (`copilot login`), then retry. Clio never signs in to Copilot itself.";

/** Environment variables that would authenticate the runtime as someone other than the `copilot login` user. */
const TOKEN_ENV_VARS = [
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
] as const;

export class CopilotLoginRequiredError extends Error {
	readonly code = "COPILOT_LOGIN_REQUIRED";
	constructor(detail?: string) {
		super(detail ? `${COPILOT_LOGIN_MESSAGE} (${detail})` : COPILOT_LOGIN_MESSAGE);
		this.name = "CopilotLoginRequiredError";
	}
}

function runtimeEnvironment(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of TOKEN_ENV_VARS) delete env[name];
	return env;
}

let shared: { client: CopilotClient; started: Promise<void> } | null = null;
let exitHookInstalled = false;

/** The process's runtime client, started on first use; concurrent callers share one start. */
export async function copilotClient(): Promise<CopilotClient> {
	if (!shared) {
		const sdk = await loadCopilotSdk();
		if (!shared) {
			const client = new sdk.CopilotClient({
				useLoggedInUser: true,
				// "empty" keeps the runtime's own memory, skills, session store and config discovery off: Clio
				// supplies the prompt and every tool, and keeps the transcript.
				mode: "empty",
				env: runtimeEnvironment(),
				logLevel: "error",
			});
			const started = client.start();
			shared = { client, started };
			started.catch(() => {
				if (shared?.client === client) shared = null;
			});
			if (!exitHookInstalled) {
				exitHookInstalled = true;
				// The runtime is a child on a stdio pipe and exits when the pipe closes; stopping it here also
				// disconnects every session so none outlives this process.
				process.once("beforeExit", () => {
					void stopCopilotClient();
				});
			}
		}
	}
	const current = shared;
	if (!current) throw new Error("Copilot runtime failed to start");
	await current.started;
	return current.client;
}

/** Stop the runtime and drop the client; the next call starts a fresh one. */
async function stopCopilotClient(): Promise<void> {
	const current = shared;
	shared = null;
	if (!current) return;
	try {
		await current.started;
		await current.client.stop();
	} catch {
		// A runtime that never started or already exited has nothing left to stop.
	}
}

/** The GitHub account the runtime is signed in as, or a login-required error naming `copilot login`. */
export async function copilotAccount(): Promise<CopilotAccount> {
	const client = await copilotClient();
	const status = await client.getAuthStatus();
	if (!status.isAuthenticated || !status.login) throw new CopilotLoginRequiredError(status.statusMessage);
	return { login: status.login, host: status.host ?? "https://github.com" };
}

export interface CopilotModelRow {
	id: string;
	label: string;
	contextWindow: number | undefined;
	maxOutputTokens: number | undefined;
	vision: boolean;
	reasoning: boolean;
	/** Premium-request multiplier the runtime reports for the model. */
	multiplier: number | undefined;
}

/**
 * Models the signed-in account may use, from the runtime's own listing. A model whose policy is disabled
 * or still unconfigured is left out: enabling one is the account owner's decision in GitHub, never Clio's.
 */
export async function listCopilotModels(): Promise<CopilotModelRow[]> {
	await copilotAccount();
	const client = await copilotClient();
	const models: ModelInfo[] = await client.listModels();
	const rows = models
		.filter((model) => model.policy === undefined || model.policy.state === "enabled")
		.map(
			(model): CopilotModelRow => ({
				id: model.id,
				label: model.name || model.id,
				contextWindow: model.capabilities?.limits?.max_context_window_tokens,
				maxOutputTokens: model.capabilities?.limits?.max_output_tokens,
				vision: model.capabilities?.supports?.vision === true,
				reasoning: model.capabilities?.supports?.reasoningEffort === true,
				multiplier: model.billing?.multiplier,
			}),
		);
	return rows;
}
