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

/** An IPv4 literal as a 32-bit unsigned number, or null. */
function ipv4ToNumber(host: string): number | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/u.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	return value;
}

/** An IPv6 literal (brackets allowed) as a bigint, or null. Embedded IPv4 tails are not parsed. */
function ipv6ToBigInt(host: string): bigint | null {
	const raw = host.replace(/^\[|\]$/gu, "");
	if (!raw.includes(":") || !/^[0-9a-f:]+$/iu.test(raw)) return null;
	const halves = raw.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	let value = 0n;
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/iu.test(group)) return null;
		value = (value << 16n) | BigInt(Number.parseInt(group, 16));
	}
	return value;
}

/** Whether `entry` is a CIDR range or an IPv4 wildcard such as `192.168.*`, which name matching cannot honour. */
function isAddressPattern(entry: string): boolean {
	return entry.includes("/") || /^(\d{1,3}\.){1,3}\*$/u.test(entry);
}

/** Whether the IP literal `host` falls inside a CIDR or IPv4 wildcard `entry`. Host names never match. */
function addressMatches(host: string, entry: string): boolean {
	if (entry.endsWith("*")) return ipv4ToNumber(host) !== null && host.startsWith(entry.slice(0, -1));
	const [base = "", bitsRaw = ""] = entry.split("/");
	if (!/^\d{1,3}$/u.test(bitsRaw)) return false;
	const bits = Number(bitsRaw);
	const v4Base = ipv4ToNumber(base);
	if (v4Base !== null) {
		const v4Host = ipv4ToNumber(host);
		if (v4Host === null || bits > 32) return false;
		const shift = 32 - bits;
		return Math.floor(v4Host / 2 ** shift) === Math.floor(v4Base / 2 ** shift);
	}
	const v6Base = ipv6ToBigInt(base);
	const v6Host = ipv6ToBigInt(host);
	if (v6Base === null || v6Host === null || bits > 128) return false;
	const shift = BigInt(128 - bits);
	return v6Host >> shift === v6Base >> shift;
}

function hostOf(origin: unknown): string | null {
	try {
		return new URL(String(origin)).hostname.toLowerCase();
	} catch {
		return null;
	}
}

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
	// undici matches host names and suffixes only, so CIDR ranges and IP wildcards are matched here and their
	// requests go through a direct agent.
	const addressPatterns = userNoProxy.filter(isAddressPattern);
	const noProxy = [...new Set([...userNoProxy, ...LOOPBACK_HOSTS])];
	try {
		const { Agent, Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
		const proxied = new EnvHttpProxyAgent({
			...(http !== null ? { httpProxy: http } : {}),
			...(https !== null ? { httpsProxy: https } : {}),
			noProxy: noProxy.filter((entry) => !isAddressPattern(entry)).join(","),
		});
		if (addressPatterns.length === 0) setGlobalDispatcher(proxied);
		else {
			const direct = new Agent();
			class AddressBypassDispatcher extends Dispatcher {
				override dispatch(
					options: Parameters<InstanceType<typeof Dispatcher>["dispatch"]>[0],
					handler: Parameters<InstanceType<typeof Dispatcher>["dispatch"]>[1],
				): boolean {
					const host = hostOf(options.origin);
					const bypass = host !== null && addressPatterns.some((entry) => addressMatches(host, entry));
					return (bypass ? direct : proxied).dispatch(options, handler);
				}
				override async close(): Promise<void> {
					await Promise.all([direct.close(), proxied.close()]);
				}
				override async destroy(): Promise<void> {
					await Promise.all([direct.destroy(), proxied.destroy()]);
				}
			}
			setGlobalDispatcher(new AddressBypassDispatcher());
		}
	} catch (err) {
		process.stderr.write(
			`clio-coder: proxy variables ignored (${err instanceof Error ? err.message : String(err)}); requests go direct\n`,
		);
		return;
	}
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
		if (isAddressPattern(entry)) {
			if (addressMatches(host, entry)) return null;
			continue;
		}
		const parsed = entry.match(/^(.+):(\d+)$/);
		if (parsed && Number.parseInt(parsed[2] ?? "", 10) !== port) continue;
		const name = (parsed ? (parsed[1] ?? "") : entry).replace(/^\*?\./, "").toLowerCase();
		if (host === name || host.endsWith(`.${name}`)) return null;
	}
	return proxy;
}
