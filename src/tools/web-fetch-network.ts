import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { WEB_FETCH_ALLOW_PRIVATE_NETWORK_ENV } from "./network-policy.js";

const blocked = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(address, prefix, "ipv4");
// Permit only global unicast IPv6. Block transition mechanisms that can embed
// an IPv4 destination and local/documentation allocations within that range.
for (const [address, prefix] of [
	["2001::", 32],
	["2001:db8::", 32],
	["2002::", 16],
] as const)
	blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function isPublicWebAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !blocked.check(address, "ipv4");
	return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export class WebFetchNetworkError extends Error {
	constructor(message: string) {
		super(`WEB_FETCH_PRIVATE_NETWORK: ${message}`);
		this.name = "WebFetchNetworkError";
	}
}

interface Address {
	address: string;
	family: number;
}
export interface WebFetchNetworkDependencies {
	resolve?: (hostname: string) => Promise<Address[]>;
	request?: (url: URL, init: RequestInit, address: Address) => Promise<Response>;
	allowPrivateNetwork?: boolean;
}

/** Pin the checked address in the socket lookup while retaining the URL host
 * for Host, TLS SNI and certificate verification. No second DNS resolution,
 * proxy, pooled socket, or automatic redirect can bypass admission. */
async function requestPinnedWebUrl(url: URL, init: RequestInit, address: Address): Promise<Response> {
	return new Promise((resolve, reject) => {
		const headers = new Headers(init.headers);
		headers.delete("host");
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{
				method: init.method ?? "GET",
				headers: Object.fromEntries(headers),
				agent: false,
				...(init.signal ? { signal: init.signal } : {}),
				lookup: (_hostname, options, callback) => {
					if (options.all) callback(null, [address]);
					else callback(null, address.address, address.family);
				},
			},
			(response) => {
				const responseHeaders = new Headers();
				for (const [key, value] of Object.entries(response.headers)) {
					if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
				}
				const status = response.statusCode ?? 500;
				let stream: Readable = response;
				const encoding = responseHeaders.get("content-encoding");
				const decoder =
					encoding === "gzip"
						? createGunzip()
						: encoding === "br"
							? createBrotliDecompress()
							: encoding === "deflate"
								? createInflate()
								: null;
				if (decoder) {
					response.on("error", (error) => decoder.destroy(error));
					decoder.on("close", () => response.destroy());
					stream = response.pipe(decoder);
					responseHeaders.delete("content-encoding");
					responseHeaders.delete("content-length");
				}
				const noBody = init.method === "HEAD" || [204, 205, 304].includes(status);
				if (noBody) response.resume();
				const result = new Response(noBody ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>), {
					status,
					statusText: response.statusMessage ?? "",
					headers: responseHeaders,
				});
				Object.defineProperty(result, "url", { value: url.toString() });
				resolve(result);
			},
		);
		request.on("error", reject);
		request.end(typeof init.body === "string" ? init.body : undefined);
	});
}

/** DNS lookup itself is not cancellable; stop awaiting it on turn cancellation. */
async function abortableLookup(
	pending: Promise<Address[]>,
	signal: AbortSignal | null | undefined,
): Promise<Address[]> {
	if (!signal) return pending;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** Every hop, including helper URLs, resolves and validates before connecting. */
export async function fetchWebUrl(
	input: string | URL,
	initial: RequestInit = {},
	dependencies: WebFetchNetworkDependencies = {},
): Promise<Response> {
	let url = new URL(input);
	const init = { ...initial, headers: new Headers(initial.headers) };
	const allowPrivate = dependencies.allowPrivateNetwork ?? process.env[WEB_FETCH_ALLOW_PRIVATE_NETWORK_ENV] === "1";
	for (let hop = 0; hop <= 10; hop++) {
		init.signal?.throwIfAborted();
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
			throw new Error("web_fetch: unsupported URL scheme or embedded credentials");
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		const addresses = isIP(hostname)
			? [{ address: hostname, family: isIP(hostname) }]
			: await abortableLookup((dependencies.resolve ?? ((host) => lookup(host, { all: true })))(hostname), init.signal);
		init.signal?.throwIfAborted();
		const address = addresses[0];
		if (address === undefined) throw new Error("web_fetch: DNS returned no addresses");
		if (!allowPrivate && addresses.some((address) => !isPublicWebAddress(address.address)))
			throw new WebFetchNetworkError(
				`destination ${url.hostname} is not public; operator opt-in ${WEB_FETCH_ALLOW_PRIVATE_NETWORK_ENV}=1 is required`,
			);
		const response = await (dependencies.request ?? requestPinnedWebUrl)(url, init, address);
		const location = response.headers.get("location");
		if (![301, 302, 303, 307, 308].includes(response.status) || location === null) return response;
		await response.body?.cancel();
		if (hop === 10) throw new Error("web_fetch: too many redirects");
		const next = new URL(location, url);
		if (next.origin !== url.origin) {
			// Custom headers can carry credentials too. A cross-origin redirect gets
			// no caller headers; the target still receives the ordinary Host header.
			init.headers = new Headers();
		}
		if (
			(response.status === 303 && init.method !== "HEAD") ||
			([301, 302].includes(response.status) && init.method === "POST")
		) {
			init.method = "GET";
			delete init.body;
			init.headers.delete("content-type");
			init.headers.delete("content-length");
		}
		url = next;
	}
	throw new Error("web_fetch: too many redirects");
}
