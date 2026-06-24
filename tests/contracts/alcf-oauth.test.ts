import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
	ALLOWED_DOMAINS,
	AUTH_CLIENT_ID,
	alcfOAuthProvider,
	buildAuthorizeUrl,
	GATEWAY_CLIENT_ID,
	GATEWAY_SCOPE,
	grantToCredentials,
	loginAlcf,
	parseAuthorizationInput,
	selectGatewayGrant,
} from "../../src/engine/alcf-oauth.js";
import type { OAuthLoginCallbacks } from "../../src/engine/oauth.js";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

interface CapturedRequest {
	url: string;
	body: URLSearchParams;
	headers: Record<string, string>;
}

function stubTokenEndpoint(payload: unknown, captured: CapturedRequest[]): void {
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		captured.push({
			url: String(url),
			body: new URLSearchParams(String(init?.body ?? "")),
			headers,
		});
		return new Response(JSON.stringify(payload), { status: 200 });
	}) as typeof fetch;
}

function noopCallbacks(overrides: Partial<OAuthLoginCallbacks>): OAuthLoginCallbacks {
	return {
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onSelect: async () => undefined,
		...overrides,
	};
}

describe("contracts/alcf-oauth", () => {
	it("builds an authorize URL with PKCE, gateway scope, and domain restriction", () => {
		const url = new URL(buildAuthorizeUrl({ challenge: "CHALLENGE", state: "STATE" }));
		strictEqual(url.origin + url.pathname, "https://auth.globus.org/v2/oauth2/authorize");
		strictEqual(url.searchParams.get("client_id"), AUTH_CLIENT_ID);
		strictEqual(url.searchParams.get("response_type"), "code");
		strictEqual(url.searchParams.get("redirect_uri"), "https://auth.globus.org/v2/web/auth-code");
		strictEqual(url.searchParams.get("scope"), GATEWAY_SCOPE);
		strictEqual(url.searchParams.get("code_challenge"), "CHALLENGE");
		strictEqual(url.searchParams.get("code_challenge_method"), "S256");
		strictEqual(url.searchParams.get("access_type"), "offline");
		strictEqual(url.searchParams.get("session_required_single_domain"), ALLOWED_DOMAINS);
	});

	it("parses an authorization code from a bare code, a URL, or a code fragment", () => {
		strictEqual(parseAuthorizationInput("  RAWCODE  "), "RAWCODE");
		strictEqual(parseAuthorizationInput("https://example.org/cb?code=FROMURL&state=x"), "FROMURL");
		strictEqual(parseAuthorizationInput("code=FROMFRAGMENT&state=x"), "FROMFRAGMENT");
		strictEqual(parseAuthorizationInput(""), "");
	});

	it("selects the gateway grant from other_tokens, not the top-level token", () => {
		const grant = selectGatewayGrant({
			access_token: "TOP_LEVEL_AUTH_TOKEN",
			refresh_token: "TOP_REFRESH",
			expires_in: 3600,
			resource_server: "auth.globus.org",
			other_tokens: [
				{
					access_token: "GATEWAY_TOKEN",
					refresh_token: "GATEWAY_REFRESH",
					expires_in: 3600,
					resource_server: GATEWAY_CLIENT_ID,
					scope: GATEWAY_SCOPE,
				},
			],
		});
		strictEqual(grant.access_token, "GATEWAY_TOKEN");
		strictEqual(grant.refresh_token, "GATEWAY_REFRESH");
	});

	it("treats a single-grant refresh response as the gateway token", () => {
		const grant = selectGatewayGrant({
			access_token: "REFRESHED",
			refresh_token: "NEW_REFRESH",
			expires_in: 3600,
			resource_server: GATEWAY_CLIENT_ID,
		});
		strictEqual(grant.access_token, "REFRESHED");
	});

	it("throws when no grant matches the gateway resource server", () => {
		throws(
			() =>
				selectGatewayGrant({
					access_token: "x",
					resource_server: "auth.globus.org",
					scope: "openid profile",
					other_tokens: [{ access_token: "y", resource_server: "transfer.api.globus.org", scope: "transfer" }],
				}),
			/did not include a grant for the ALCF gateway/,
		);
	});

	it("maps a grant to credentials and applies an expiry skew", () => {
		const before = Date.now();
		const creds = grantToCredentials({ access_token: "A", refresh_token: "R", expires_in: 3600 });
		strictEqual(creds.access, "A");
		strictEqual(creds.refresh, "R");
		ok(creds.expires > before + (3600 - 5 * 60) * 1000 - 2000);
		ok(creds.expires <= Date.now() + (3600 - 5 * 60) * 1000 + 2000);
	});

	it("falls back to the previous refresh token when a refresh response omits one", () => {
		const creds = grantToCredentials({ access_token: "A2", expires_in: 3600 }, "PRIOR_REFRESH");
		strictEqual(creds.refresh, "PRIOR_REFRESH");
	});

	it("throws when a grant has no access or refresh token", () => {
		throws(() => grantToCredentials({ refresh_token: "R", expires_in: 1 }), /missing an access token/);
		throws(() => grantToCredentials({ access_token: "A", expires_in: 1 }), /missing a refresh token/);
	});

	it("drives paste-the-code login and exchanges for the gateway token", async () => {
		const captured: CapturedRequest[] = [];
		stubTokenEndpoint(
			{
				access_token: "GATEWAY_ACCESS",
				refresh_token: "GATEWAY_REFRESH",
				expires_in: 3600,
				resource_server: GATEWAY_CLIENT_ID,
				scope: GATEWAY_SCOPE,
			},
			captured,
		);

		let shownUrl = "";
		const creds = await loginAlcf(
			noopCallbacks({
				onAuth: (info) => {
					shownUrl = info.url;
				},
				onPrompt: async () => "PASTED_CODE",
			}),
		);

		match(shownUrl, /auth\.globus\.org\/v2\/oauth2\/authorize/);
		strictEqual(creds.access, "GATEWAY_ACCESS");
		strictEqual(creds.refresh, "GATEWAY_REFRESH");

		strictEqual(captured.length, 1);
		const req = captured[0];
		ok(req);
		strictEqual(req.url, "https://auth.globus.org/v2/oauth2/token");
		strictEqual(req.body.get("grant_type"), "authorization_code");
		strictEqual(req.body.get("client_id"), AUTH_CLIENT_ID);
		strictEqual(req.body.get("code"), "PASTED_CODE");
		strictEqual(req.body.get("redirect_uri"), "https://auth.globus.org/v2/web/auth-code");
		ok((req.body.get("code_verifier") ?? "").length > 0, "PKCE verifier must be sent");
	});

	it("prefers onManualCodeInput over onPrompt when both are available", async () => {
		const captured: CapturedRequest[] = [];
		stubTokenEndpoint(
			{ access_token: "A", refresh_token: "R", expires_in: 3600, resource_server: GATEWAY_CLIENT_ID },
			captured,
		);
		await loginAlcf(
			noopCallbacks({
				onPrompt: async () => "FROM_PROMPT",
				onManualCodeInput: async () => "FROM_MANUAL",
			}),
		);
		strictEqual(captured[0]?.body.get("code"), "FROM_MANUAL");
	});

	it("rejects login when no code is provided", async () => {
		await rejects(loginAlcf(noopCallbacks({ onPrompt: async () => "   " })), /No authorization code/);
	});

	it("refreshes via grant_type=refresh_token and exposes getApiKey", async () => {
		const captured: CapturedRequest[] = [];
		stubTokenEndpoint(
			{
				access_token: "REFRESHED_ACCESS",
				refresh_token: "ROTATED_REFRESH",
				expires_in: 3600,
				resource_server: GATEWAY_CLIENT_ID,
			},
			captured,
		);
		const creds = await alcfOAuthProvider.refreshToken({ access: "old", refresh: "OLD_REFRESH", expires: 0 });
		strictEqual(creds.access, "REFRESHED_ACCESS");
		strictEqual(captured[0]?.body.get("grant_type"), "refresh_token");
		strictEqual(captured[0]?.body.get("refresh_token"), "OLD_REFRESH");

		strictEqual(alcfOAuthProvider.id, "alcf");
		strictEqual(alcfOAuthProvider.usesCallbackServer, false);
		strictEqual(alcfOAuthProvider.getApiKey({ access: "BEARER", refresh: "r", expires: 1 }), "BEARER");
	});

	it("keeps the gateway client id and scope wired to clio-agent values", () => {
		strictEqual(GATEWAY_CLIENT_ID, "681c10cc-f684-4540-bcd7-0b4df3bc26ef");
		deepStrictEqual(GATEWAY_SCOPE, "https://auth.globus.org/scopes/681c10cc-f684-4540-bcd7-0b4df3bc26ef/action_all");
	});
});
