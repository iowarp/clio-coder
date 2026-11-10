import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { inferKeyProvider } from "../../src/cli/key-prefix.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";

test("a key prefix names its provider only when no other provider shares it", () => {
	registerBuiltinRuntimes(getRuntimeRegistry());
	for (const [key, provider] of [
		["sk-ant-api03-abc", "anthropic"],
		["sk-proj-abc", "openai"],
		["sk-svcacct-abc", "openai"],
		["sk-or-v1-abc", "openrouter"],
		["gsk_abc", "groq"],
		["AIzaSyabc", "google"],
		["  sk-ant-padded  ", "anthropic"],
	] as const) {
		strictEqual(inferKeyProvider(key), provider, key);
	}
	// `sk-` alone is an older OpenAI key and a DeepSeek key.
	strictEqual(inferKeyProvider("sk-0123456789abcdef"), undefined);
	strictEqual(inferKeyProvider("not-a-known-key"), undefined);
});
