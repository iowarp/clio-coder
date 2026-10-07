import { hasExternalClaudeAuth } from "../../../core/claude-environment.js";
import type { DelegationAgentConfig } from "../../../core/defaults.js";
import type { AuthOperationOptions } from "../../../engine/types.js";
import type { TargetAuth } from "../types/target-descriptor.js";
import { FileAuthStorageBackend } from "./backend-file.js";
import { AuthStorage } from "./storage.js";

export interface ClaudeLaunchCredential {
	apiKey: string;
	/** Only access credentials cross the external process boundary, never refresh tokens. */
	expiresAt?: number;
	profile: string;
}

/** Custom ACP launch commands never receive a subscription merely because their id matches. */
export function isBuiltinClaudeAcp(agent: DelegationAgentConfig): boolean {
	return (
		agent.id === "claude-code" &&
		(agent.command === "npx" || agent.command === "npx.cmd") &&
		agent.args.length === 2 &&
		agent.args[0] === "-y" &&
		/^@agentclientprotocol\/claude-agent-acp@\d+\.\d+\.\d+$/u.test(agent.args[1] ?? "")
	);
}

/** A selected external profile/backend wins; otherwise Clio's subscription is shared by Clio launches. */
export async function resolveClaudeLaunchCredential(
	auth?: TargetAuth,
	environment: NodeJS.ProcessEnv = process.env,
	options?: AuthOperationOptions,
): Promise<ClaudeLaunchCredential | null> {
	const explicit = auth?.oauthProfile?.trim() || auth?.apiKeyRef?.trim();
	if (!explicit && auth?.apiKeyEnvVar) {
		const apiKey = environment[auth.apiKeyEnvVar]?.trim();
		if (!apiKey) throw new Error(`Claude credential environment variable '${auth.apiKeyEnvVar}' is unavailable.`);
		return { apiKey, profile: `env:${auth.apiKeyEnvVar}` };
	}
	if (!explicit && hasExternalClaudeAuth(environment)) return null;
	const profile = explicit || "anthropic-max";
	const storage = new AuthStorage(new FileAuthStorageBackend());
	const credential = storage.get(profile);
	if (storage.damageReason())
		throw new Error("Clio's credentials could not be read. Repair the credential store before starting Claude.");
	if (!credential) {
		if (explicit) throw new Error(`Claude credential '${profile}' is missing. Log in before starting this run.`);
		return null;
	}
	if (!explicit && credential.type !== "oauth") {
		throw new Error("The Claude subscription contains an API key. Run clio-coder auth login anthropic-max.");
	}
	if (auth?.oauthProfile && credential.type !== "oauth") {
		throw new Error(`Claude OAuth profile '${profile}' contains an API key. Select the intended credential.`);
	}
	const resolved = await storage.resolveApiKey(profile, {
		includeFallback: false,
		...(options?.signal ? { signal: options.signal } : {}),
	});
	if (!resolved.apiKey || !resolved.available) {
		throw new Error(resolved.detail ?? `Claude credential '${profile}' is unavailable.`);
	}
	const current = storage.get(profile);
	return {
		apiKey: resolved.apiKey,
		profile,
		...(current?.type === "oauth" ? { expiresAt: current.expires } : {}),
	};
}
