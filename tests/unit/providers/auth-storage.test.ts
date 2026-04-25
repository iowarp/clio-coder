import { strictEqual } from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";

import { type AuthStorageData, createMemoryAuthStorage } from "../../../src/domains/providers/auth/index.js";
import {
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
	registerEngineOAuthProvider,
	unregisterEngineOAuthProvider,
} from "../../../src/engine/oauth.js";

const TEST_PROVIDER_ID = "clio-test-oauth";
const ORIGINAL_DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

const TEST_PROVIDER: OAuthProviderInterface = {
	id: TEST_PROVIDER_ID,
	name: "Clio Test OAuth",
	async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return {
			access: "login-access",
			refresh: "login-refresh",
			expires: Date.now() + 60_000,
		};
	},
	async refreshToken(_credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return {
			access: "refreshed-access",
			refresh: "refreshed-refresh",
			expires: Date.now() + 60_000,
		};
	},
	getApiKey(credentials: OAuthCredentials): string {
		return `Bearer ${credentials.access}`;
	},
};

afterEach(() => {
	try {
		unregisterEngineOAuthProvider(TEST_PROVIDER_ID);
	} catch {
		// provider may already be absent
	}
	if (ORIGINAL_DEEPSEEK_API_KEY === undefined) Reflect.deleteProperty(process.env, "DEEPSEEK_API_KEY");
	else process.env.DEEPSEEK_API_KEY = ORIGINAL_DEEPSEEK_API_KEY;
});

after(() => {
	if (ORIGINAL_DEEPSEEK_API_KEY === undefined) Reflect.deleteProperty(process.env, "DEEPSEEK_API_KEY");
	else process.env.DEEPSEEK_API_KEY = ORIGINAL_DEEPSEEK_API_KEY;
});

describe("providers/auth in-memory storage", () => {
	it("round-trips stored api keys", async () => {
		const auth = createMemoryAuthStorage();
		auth.setApiKey("openai", "sk-memory");

		const resolved = await auth.resolveApiKey("openai");
		strictEqual(resolved.apiKey, "sk-memory");
		strictEqual(auth.status("openai").source, "stored-api-key");
	});

	it("labels pi-ai provider environment keys by variable name", async () => {
		process.env.DEEPSEEK_API_KEY = "sk-deepseek";
		const auth = createMemoryAuthStorage();

		const resolved = await auth.resolveApiKey("deepseek");
		strictEqual(resolved.apiKey, "sk-deepseek");
		strictEqual(resolved.source, "environment");
		strictEqual(resolved.detail, "DEEPSEEK_API_KEY");
	});

	it("refreshes expired oauth credentials and persists the refreshed token", async () => {
		registerEngineOAuthProvider(TEST_PROVIDER);
		const data: AuthStorageData = {
			[TEST_PROVIDER_ID]: {
				type: "oauth",
				access: "expired-access",
				refresh: "refresh-token",
				expires: Date.now() - 1_000,
				updatedAt: new Date(0).toISOString(),
			},
		};
		const auth = createMemoryAuthStorage(data);

		const resolved = await auth.resolveApiKey(TEST_PROVIDER_ID);
		strictEqual(resolved.apiKey, "Bearer refreshed-access");

		const stored = auth.get(TEST_PROVIDER_ID);
		strictEqual(stored?.type, "oauth");
		if (stored?.type === "oauth") {
			strictEqual(stored.access, "refreshed-access");
			strictEqual(stored.refresh, "refreshed-refresh");
		}
	});
});
