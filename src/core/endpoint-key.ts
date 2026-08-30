/**
 * Canonical identity of an OpenAI-compatible inference endpoint: normalized
 * HTTP scheme, lower-cased host, normalized port, and normalized base path with
 * a conventional terminal `/v1` mount stripped. Credentials, query, and
 * fragment do not participate. Host aliases are not resolved, so
 * `localhost` and `127.0.0.1` stay distinct. Shared by dispatch capacity and
 * residency locking so both speak the same key for one server.
 */
export function canonicalEndpointUrl(raw: string | null | undefined): string | null {
	if (!raw?.trim()) return null;
	try {
		const url = new URL(raw.trim().replace(/^ws:/u, "http:").replace(/^wss:/u, "https:"));
		url.protocol = url.protocol.toLowerCase();
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hostname = url.hostname.toLowerCase();
		url.username = "";
		url.password = "";
		url.hash = "";
		url.search = "";
		let path = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/$/u, "");
		if (path.endsWith("/v1")) path = path.slice(0, -3);
		url.pathname = path || "/";
		return url.toString().replace(/\/$/u, "");
	} catch {
		return null;
	}
}
