/**
 * ALCF / Argonne inference-gateway authentication via Globus Auth.
 *
 * The ALCF inference gateway exposes OpenAI-compatible model endpoints behind
 * Globus. This provider implements the native-app PKCE paste-the-code flow so
 * it works from local terminals and SSH login nodes without a localhost
 * callback.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "@earendil-works/pi-ai";

export const AUTH_CLIENT_ID = "58fdd3bc-e1c3-4ce5-80ea-8d6b87cfb944";
export const GATEWAY_CLIENT_ID = "681c10cc-f684-4540-bcd7-0b4df3bc26ef";
export const GATEWAY_SCOPE = `https://auth.globus.org/scopes/${GATEWAY_CLIENT_ID}/action_all`;
export const ALLOWED_DOMAINS = "anl.gov,alcf.anl.gov";

const AUTHORIZE_URL = "https://auth.globus.org/v2/oauth2/authorize";
const TOKEN_URL = "https://auth.globus.org/v2/oauth2/token";
const REDIRECT_URI = "https://auth.globus.org/v2/web/auth-code";
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64Url(verifierBytes);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function randomState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

export function buildAuthorizeUrl(params: { challenge: string; state: string }): string {
	const query = new URLSearchParams({
		client_id: AUTH_CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: GATEWAY_SCOPE,
		state: params.state,
		code_challenge: params.challenge,
		code_challenge_method: "S256",
		access_type: "offline",
		session_required_single_domain: ALLOWED_DOMAINS,
	});
	return `${AUTHORIZE_URL}?${query.toString()}`;
}

export function parseAuthorizationInput(input: string): string {
	const value = input.trim();
	if (!value) return "";
	try {
		const url = new URL(value);
		const code = url.searchParams.get("code");
		if (code) return code;
	} catch {
		// Not a URL; fall through to fragment/bare-code handling.
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value.includes("?") ? value.slice(value.indexOf("?") + 1) : value);
		const code = params.get("code");
		if (code) return code;
	}
	return value;
}

interface GlobusTokenGrant {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	resource_server?: unknown;
	scope?: unknown;
}

interface GlobusTokenResponse extends GlobusTokenGrant {
	other_tokens?: GlobusTokenGrant[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function selectGatewayGrant(payload: GlobusTokenResponse): GlobusTokenGrant {
	const grants: GlobusTokenGrant[] = [payload, ...(Array.isArray(payload.other_tokens) ? payload.other_tokens : [])];
	const byResourceServer = grants.find((grant) => grant.resource_server === GATEWAY_CLIENT_ID);
	if (byResourceServer) return byResourceServer;
	const byScope = grants.find(
		(grant) => typeof grant.scope === "string" && (grant.scope.includes("action_all") || grant.scope === GATEWAY_SCOPE),
	);
	if (byScope) return byScope;
	if (grants.length === 1 && typeof payload.access_token === "string") return payload;
	throw new Error(
		`Globus token response did not include a grant for the ALCF gateway (resource_server=${GATEWAY_CLIENT_ID}).`,
	);
}

export function grantToCredentials(grant: GlobusTokenGrant, previousRefresh?: string): OAuthCredentials {
	const access = grant.access_token;
	if (typeof access !== "string" || access.length === 0) {
		throw new Error("Globus token response is missing an access token for the ALCF gateway.");
	}
	const refresh =
		typeof grant.refresh_token === "string" && grant.refresh_token.length > 0 ? grant.refresh_token : previousRefresh;
	if (typeof refresh !== "string" || refresh.length === 0) {
		throw new Error("Globus token response is missing a refresh token; cannot persist a renewable session.");
	}
	const expiresInSeconds = typeof grant.expires_in === "number" && grant.expires_in > 0 ? grant.expires_in : 0;
	return {
		access,
		refresh,
		expires: Date.now() + expiresInSeconds * 1000 - EXPIRY_SKEW_MS,
	};
}

async function postForm(body: Record<string, string>): Promise<GlobusTokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Globus token endpoint failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`Globus token endpoint returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!isRecord(parsed)) throw new Error("Globus token endpoint returned a non-object response.");
	return parsed as GlobusTokenResponse;
}

async function exchangeCode(code: string, verifier: string): Promise<OAuthCredentials> {
	const payload = await postForm({
		grant_type: "authorization_code",
		client_id: AUTH_CLIENT_ID,
		code,
		code_verifier: verifier,
		redirect_uri: REDIRECT_URI,
	});
	return grantToCredentials(selectGatewayGrant(payload));
}

async function refreshGatewayToken(refreshToken: string): Promise<OAuthCredentials> {
	const payload = await postForm({
		grant_type: "refresh_token",
		client_id: AUTH_CLIENT_ID,
		refresh_token: refreshToken,
	});
	return grantToCredentials(selectGatewayGrant(payload), refreshToken);
}

export async function loginAlcf(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePkce();
	const url = buildAuthorizeUrl({ challenge, state: randomState() });
	callbacks.onAuth({
		url,
		instructions:
			"Log in with your ALCF / anl.gov identity. Globus will show an authorization code; copy it and paste it here.",
	});
	const pasted = callbacks.onManualCodeInput
		? await callbacks.onManualCodeInput()
		: await callbacks.onPrompt({ message: "Paste the authorization code from Globus", placeholder: "code" });
	const code = parseAuthorizationInput(pasted);
	if (!code) throw new Error("No authorization code was provided.");
	callbacks.onProgress?.("Exchanging authorization code for an ALCF access token...");
	return exchangeCode(code, verifier);
}

export const alcfOAuthProvider: OAuthProviderInterface = {
	id: "alcf",
	name: "ALCF Inference (Globus)",
	usesCallbackServer: false,
	login(callbacks) {
		return loginAlcf(callbacks);
	},
	refreshToken(credentials) {
		return refreshGatewayToken(credentials.refresh);
	},
	getApiKey(credentials) {
		return credentials.access;
	},
};
