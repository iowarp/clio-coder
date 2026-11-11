import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { InMemoryAuthStorageBackend } from "../../src/domains/providers/auth/backend-memory.js";
import { AuthStorage, type RuntimeAuthMetadata, resolveAuthTarget } from "../../src/domains/providers/auth/storage.js";
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

// The desktop app's service cannot see the shell, so setup may store a copy of a target's key variable. Every
// target of a runtime shares the runtime's slot (and `auth login` writes it), so the copy must not land there.
test("a key stored for the desktop app is its variable's own, for two targets on one runtime", async () => {
	const runtime: RuntimeAuthMetadata = { id: "openai-compat", tier: "cloud", auth: "api-key" };
	const target = (id: string, envVar?: string) =>
		resolveAuthTarget(
			{
				id,
				runtime: "openai-compat",
				url: `https://${id}.example`,
				...(envVar ? { auth: { apiKeyEnvVar: envVar } } : {}),
			} as unknown as TargetDescriptor,
			runtime,
		);
	const saved = { A_KEY: process.env.A_KEY, B_KEY: process.env.B_KEY };
	const auth = new AuthStorage(new InMemoryAuthStorageBackend());
	try {
		auth.setApiKey("openai-compat", "sk-login");
		auth.storeEnvKeyCopy(target("a", "A_KEY"), "sk-a");
		auth.storeEnvKeyCopy(target("b", "B_KEY"), "sk-b");
		delete process.env.A_KEY;
		delete process.env.B_KEY;

		strictEqual((await auth.resolveForTarget(target("a", "A_KEY"))).apiKey, "sk-a");
		strictEqual((await auth.resolveForTarget(target("b", "B_KEY"))).apiKey, "sk-b");
		strictEqual((await auth.resolveForTarget(target("c"))).apiKey, "sk-login", "the auth login key is kept");
		strictEqual(auth.statusForTarget(target("a", "A_KEY")).detail, "A_KEY is not set; using its stored copy");

		process.env.A_KEY = "sk-a-rotated";
		strictEqual((await auth.resolveForTarget(target("a", "A_KEY"))).apiKey, "sk-a-rotated", "the variable comes first");
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
