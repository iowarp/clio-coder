/**
 * Proxy variables for Clio's own HTTP requests. Node's global `fetch` ignores `https_proxy` and friends unless the
 * process starts with `NODE_USE_ENV_PROXY`, so on a cluster or company network that only reaches the internet through a
 * proxy, every model call failed with a bare "Connection error." while curl and npm worked. Installing undici's
 * `EnvHttpProxyAgent` as the global dispatcher routes every `fetch` in this process through the proxy. Loopback is always
 * direct: a cluster user exports `http_proxy` and still runs a local model server on 127.0.0.1.
 */

type ProxyEnv = Readonly<Record<string, string | undefined>>;

interface ActiveProxy {
	http: string | null;
	https: string | null;
	noProxy: ReadonlyArray<string>;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

let active: ActiveProxy | null = null;

function firstSet(env: ProxyEnv, names: ReadonlyArray<string>): string | null {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return null;
}

/** curl accepts `host:port` without a scheme; undici's URL parse would read `host:` as the scheme. */
function withScheme(proxy: string): string {
	return proxy.includes("://") ? proxy : `http://${proxy}`;
}

/** The proxy as an operator may see it: scheme, host and port, never the userinfo. */
function displayProxy(proxy: string): string {
	try {
		const url = new URL(proxy);
		return `${url.protocol}//${url.host}`;
	} catch {
		return "an unparseable proxy URL";
	}
}

/**
 * Route this process's `fetch` through the proxy the environment names. With no proxy variable set nothing is
 * installed, and undici is never loaded. Children inherit the variables and call this themselves.
 */
export async function installProxyFromEnv(env: ProxyEnv = process.env): Promise<void> {
	// Lowercase first, as curl and undici read them.
	const httpRaw = firstSet(env, ["http_proxy", "HTTP_PROXY"]);
	const httpsRaw = firstSet(env, ["https_proxy", "HTTPS_PROXY"]);
	if (httpRaw === null && httpsRaw === null) return;
	const userNoProxy = (firstSet(env, ["no_proxy", "NO_PROXY"]) ?? "").split(/[,\s]+/).filter(Boolean);
	if (userNoProxy.includes("*")) return;
	const http = httpRaw === null ? null : withScheme(httpRaw);
	const https = httpsRaw === null ? http : withScheme(httpsRaw);
	// undici and proxyForUrl match host names and suffixes only, so a CIDR range never bypasses the proxy.
	const cidr = userNoProxy.filter((entry) => entry.includes("/"));
	const noProxy = [...new Set([...userNoProxy.filter((entry) => !entry.includes("/")), ...LOOPBACK_HOSTS])];
	try {
		const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
		setGlobalDispatcher(
			new EnvHttpProxyAgent({
				...(http !== null ? { httpProxy: http } : {}),
				...(https !== null ? { httpsProxy: https } : {}),
				noProxy: noProxy.join(","),
			}),
		);
	} catch (err) {
		process.stderr.write(
			`clio-coder: proxy variables ignored (${err instanceof Error ? err.message : String(err)}); requests go direct\n`,
		);
		return;
	}
	if (cidr.length > 0)
		process.stderr.write(
			`clio-coder: NO_PROXY CIDR entries are not honoured (${cidr.join(",")}); name those hosts in NO_PROXY to reach them directly\n`,
		);
	active = {
		http: http === null ? null : displayProxy(http),
		https: https === null ? null : displayProxy(https),
		noProxy,
	};
}

/** The proxy in effect for HTTPS (credentials redacted) and the bypass list, or null when none was installed. */
export function proxyEnvSummary(): string | null {
	if (active === null) return null;
	return `HTTPS via ${active.https ?? "direct"}${active.http !== active.https ? `, HTTP via ${active.http ?? "direct"}` : ""}; direct for ${active.noProxy.join(",")}`;
}

/** The proxy a request to `url` goes through (credentials redacted), or null when it goes direct. */
export function proxyForUrl(url: string | undefined): string | null {
	if (active === null || url === undefined) return null;
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return null;
	}
	const proxy = target.protocol === "https:" ? active.https : target.protocol === "http:" ? active.http : null;
	if (proxy === null) return null;
	const host = target.host.replace(/:\d*$/, "").toLowerCase();
	const port = Number.parseInt(target.port, 10) || (target.protocol === "https:" ? 443 : 80);
	for (const entry of active.noProxy) {
		const parsed = entry.match(/^(.+):(\d+)$/);
		if (parsed && Number.parseInt(parsed[2] ?? "", 10) !== port) continue;
		const name = (parsed ? (parsed[1] ?? "") : entry).replace(/^\*?\./, "").toLowerCase();
		if (host === name || host.endsWith(`.${name}`)) return null;
	}
	return proxy;
}
