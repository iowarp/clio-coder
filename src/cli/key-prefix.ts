import { getRuntimeRegistry } from "../domains/providers/registry.js";

/**
 * Key prefixes that belong to exactly one provider in setup's list. A prefix two providers share (`sk-` is both an
 * older OpenAI key and a DeepSeek key) is left out, so such a key gets the provider list instead of a guess.
 */
const KEY_PREFIXES: ReadonlyArray<readonly [prefix: string, runtimeId: string]> = [
	["sk-ant-", "anthropic"],
	["sk-proj-", "openai"],
	["sk-svcacct-", "openai"],
	["sk-or-", "openrouter"],
	["gsk_", "groq"],
	["AIza", "google"],
];

/** The provider a pasted API key belongs to, when its prefix says so unambiguously. */
export function inferKeyProvider(key: string): string | undefined {
	const trimmed = key.trim();
	const registry = getRuntimeRegistry();
	return KEY_PREFIXES.find(([prefix, runtimeId]) => trimmed.startsWith(prefix) && registry.get(runtimeId) !== null)?.[1];
}
