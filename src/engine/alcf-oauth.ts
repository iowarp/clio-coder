/**
 * ALCF / Argonne inference-gateway authentication via Globus Auth.
 *
 * ALCF exposes vLLM-backed, OpenAI-compatible model servers (Sophia, Metis)
 * behind a single public gateway at https://inference-api.alcf.anl.gov. Access
 * requires a short-lived Globus access token tied to an anl.gov / alcf.anl.gov
 * (or affiliated) identity.
 *
 * This is the TypeScript port of clio-agent's
 * `providers/argonne_auth.py`, implemented as a pi-ai `OAuthProviderInterface`
 * so clio-coder's existing auth storage handles persistence and refresh. The
 * entire Globus apparatus exists only to deposit a bearer token; everything
 * downstream is plain `Authorization: Bearer <token>` against an
 * OpenAI-compatible endpoint (see runtimes/cloud/alcf.ts).
 *
 * Login is the paste-the-code (Globus "native app") flow: we send the user to
 * the Globus authorize URL with `redirect_uri` pointing at Globus's own
 * auth-code display page, then read the code they paste back. No localhost /
 * loopback server is used, so the flow works identically on a laptop or over
 * SSH into an ALCF login node.
 *
 * The provider id is "alcf" (not "globus") so it matches the runtime id: the
 * `clio configure` flow defaults an oauth endpoint's `oauthProfile` to its
 * runtime id, and `clio auth login alcf` resolves to this provider with no
 * special-casing.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Constants — match clio-agent / alcf-agentics-workflow exactly so a user's
// existing Globus consent for this client carries over.
// ---------------------------------------------------------------------------

/** Public (native-app) client id users authenticate as. */
export const AUTH_CLIENT_ID = "58fdd3bc-e1c3-4ce5-80ea-8d6b87cfb944";
/** Resource server (client id) of the ALCF inference gateway. */
export const GATEWAY_CLIENT_ID = "681c10cc-f684-4540-bcd7-0b4df3bc26ef";
/** Scope whose token is the bearer for the inference gateway. */
export const GATEWAY_SCOPE = `https://auth.globus.org/scopes/${GATEWAY_CLIENT_ID}/action_all`;
/** Globus only honours these identity domains for the gateway. */
export const ALLOWED_DOMAINS = "anl.gov,alcf.anl.gov";

const AUTHORIZE_URL = "https://auth.globus.org/v2/oauth2/authorize";
const TOKEN_URL = "https://auth.globus.org/v2/oauth2/token";
/**
 * Globus-hosted page that displays the authorization code for the user to copy.
 * Using this redirect (instead of a localhost callback) is what makes the flow
 * SSH-safe: nothing has to connect back to the machine running clio.
 */
const REDIRECT_URI = "https://auth.globus.org/v2/web/auth-code";

/** Refresh ~5 minutes before the real expiry to avoid edge-of-expiry 401s. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// PKCE (inline; pi-ai's helper is not part of its public API)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// URL + payload helpers (pure, unit-tested without network)
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(params: { challenge: string; state: string }): string {
	const query = new URLSearchParams({
		client_id: AUTH_CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: GATEWAY_SCOPE,
		state: params.state,
		code_challenge: params.challenge,
		code_challenge_method: "S256",
		// Globus issues refresh tokens when offline access is requested.
		access_type: "offline",
		// Force the user onto an ALCF-allowed identity domain; a personal
		// Google identity would otherwise be 403'd by the gateway.
		session_required_single_domain: ALLOWED_DOMAINS,
	});
	return `${AUTHORIZE_URL}?${query.toString()}`;
}

/**
 * Extract just the authorization code from whatever the user pasted. Globus's
 * auth-code page shows a bare code, but users sometimes paste a full URL or a
 * `code=...` fragment, so we accept all three.
 */
export function parseAuthorizationInput(input: string): string {
	const value = input.trim();
	if (!value) return "";
	try {
		const url = new URL(value);
		const code = url.searchParams.get("code");
		if (code) return code;
	} catch {
		// not a URL; fall through
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

/**
 * Globus returns one token grant per resource server: the top-level fields are
 * one grant and `other_tokens[]` holds the rest. The bearer for the inference
 * gateway is the grant whose `resource_server` is the gateway client id — NOT
 * necessarily the top-level token. Picking the wrong one is the single most
 * likely correctness bug, so selection is explicit and unit-tested.
 */
export function selectGatewayGrant(payload: GlobusTokenResponse): GlobusTokenGrant {
	const grants: GlobusTokenGrant[] = [payload, ...(Array.isArray(payload.other_tokens) ? payload.other_tokens : [])];
	const byResourceServer = grants.find((grant) => grant.resource_server === GATEWAY_CLIENT_ID);
	if (byResourceServer) return byResourceServer;
	const byScope = grants.find(
		(grant) => typeof grant.scope === "string" && (grant.scope.includes("action_all") || grant.scope === GATEWAY_SCOPE),
	);
	if (byScope) return byScope;
	// Single-grant responses (e.g. a refresh that only returns the gateway
	// token) have no resource_server discriminator to match on.
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

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export async function loginAlcf(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePkce();
	const url = buildAuthorizeUrl({ challenge, state: randomState() });
	callbacks.onAuth({
		url,
		instructions:
			"Log in with your ALCF / anl.gov identity. Globus will then show an " +
			"authorization code — copy it and paste it here.",
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
