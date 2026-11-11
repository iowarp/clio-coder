import { proxyForUrl } from "../../core/proxy-env.js";

/** Transport failures where a proxy refusal and an unreachable provider read the same. */
const CONNECTION_FAILURE =
	/^Connection error\.|^fetch failed\b|\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|socket hang up/;

/**
 * Name the proxy (credentials redacted by `proxyForUrl`) in a connection-failure message for a request to `baseUrl`.
 * Pi appends the transport cause to the SDK's `Connection error.` (`Connection error.: connect ECONNREFUSED ...`); the
 * note goes before it. Other messages, direct requests and already-annotated messages come back unchanged.
 */
export function withProxyConnectionNote(message: string | undefined, baseUrl: string | undefined): string | undefined {
	if (message === undefined || message.includes("(through proxy ")) return message;
	const trimmed = message.trim();
	if (!CONNECTION_FAILURE.test(trimmed)) return message;
	const proxy = proxyForUrl(baseUrl);
	if (proxy === null) return message;
	const sdk = /^Connection error\.((?:: [^\n]+)?)$/.exec(trimmed);
	if (sdk !== null) return `Connection error. (through proxy ${proxy})${sdk[1] ?? ""}`;
	return `${trimmed} (through proxy ${proxy})`;
}
