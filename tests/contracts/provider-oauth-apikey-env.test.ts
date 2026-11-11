import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { type RuntimeAuthMetadata, resolveAuthTarget } from "../../src/domains/providers/auth/storage.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";

// A target's own key variable outranks a stored login, so on an OAuth target it would hand an API key to a
// runtime that refuses anything but OAuth and leave the target unusable. The OAuth login must take effect.
test("an OAuth target that also names apiKeyEnvVar resolves through its OAuth login", () => {
	const runtime: RuntimeAuthMetadata = { id: "openai-codex", tier: "cloud", auth: "oauth" };
	const target = {
		id: "codex",
		runtime: "openai-codex",
		auth: { apiKeyEnvVar: "CODEX_KEY" },
	} as unknown as TargetDescriptor;
	const authTarget = resolveAuthTarget(target, runtime);
	strictEqual(authTarget.targetEnvVar, undefined);
	strictEqual(authTarget.explicitEnvVar, undefined);
	strictEqual(authTarget.providerId, "openai-codex");
});

test("an api-key target keeps its apiKeyEnvVar", () => {
	const runtime: RuntimeAuthMetadata = { id: "openai", tier: "cloud", auth: "api-key" };
	const target = { id: "o", runtime: "openai", auth: { apiKeyEnvVar: "MY_KEY" } } as unknown as TargetDescriptor;
	const authTarget = resolveAuthTarget(target, runtime);
	strictEqual(authTarget.targetEnvVar, "MY_KEY");
	strictEqual(authTarget.explicitEnvVar, "MY_KEY");
});
