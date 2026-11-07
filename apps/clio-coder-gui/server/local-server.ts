import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setTimeout } from "node:timers/promises";
import { listenPorts } from "./launcher/ports.js";

/** What a ready background app reports about itself; `clio` is the version its process loaded. */
export interface LocalServerMeta {
	clio: string;
	idle?: boolean;
	/** The port that answered, which is the fallback port when the configured one was busy. */
	port?: number;
}

/** Readiness checks are the sole app-owned socket client: fixed loopback, fixed path, no redirects. */
export async function localServerReady(port: number, token: string) {
	return (await findLocalServer(port, token)) !== null;
}

/** The app configured for `port`, wherever it is listening: its own port first, then the documented fallback. */
export async function findLocalServer(port: number, token: string) {
	for (const candidate of listenPorts(port)) {
		const meta = await localServerMeta(candidate, token);
		if (meta) return meta;
	}
	return null;
}

function identity(port: number, token: string) {
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[\w-]{32,256}$/.test(token))
		throw new Error("Invalid local server identity.");
}

interface JsonAnswer {
	status: number;
	value: Record<string, unknown> | null;
}

/** One small JSON exchange with an app listener: fixed loopback, no redirects, a bounded body. */
function exchange(
	port: number,
	listenerPort: number,
	method: "GET" | "POST",
	path: string,
	bearer: string,
	body?: unknown,
): Promise<JsonAnswer | null> {
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise((resolve) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method,
				headers: {
					Authorization: `Bearer ${bearer}`,
					Host: `127.0.0.1:${listenerPort}`,
					...(payload === undefined
						? {}
						: {
								"Content-Type": "application/json",
								"Content-Length": Buffer.byteLength(payload),
								"Idempotency-Key": randomUUID(),
							}),
				},
			},
			(response) => {
				let text = "";
				response.on("data", (chunk: Buffer) => {
					text += chunk.toString("utf8");
					if (text.length > 8192) req.destroy();
				});
				response.on("error", () => resolve(null));
				response.on("end", () => {
					let value: unknown = null;
					try {
						value = JSON.parse(text);
					} catch {
						// A body that is not JSON answers with its status alone.
					}
					resolve({
						status: response.statusCode ?? 0,
						value: value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null,
					});
				});
			},
		);
		req.on("error", () => resolve(null));
		req.setTimeout(1000, () => {
			req.destroy();
			resolve(null);
		});
		req.end(payload);
	});
}

interface Held {
	clientId: string;
	credential: string;
	refreshAt: number;
}
/** Credentials this process holds on app listeners, by listener, launch token and caller. */
const held = new Map<string, Held>();
const HELD_MAX = 512;

/**
 * This process's own credential on the app at `port`, exchanged from its launch token and rotated at
 * half-life, so a probe or a proxied request never sends the launch token anywhere but the exchange.
 * An app from before per-client credentials answers the exchange with 404; its launch token is then
 * the credential, which only lets the version gate read and report it. Null when nothing answers as
 * this app with this token.
 */
export async function clientCredential(
	port: number,
	listenerPort: number,
	token: string,
	label: string,
	caller = "",
): Promise<string | null> {
	identity(port, token);
	identity(listenerPort, token);
	const key = `${port}:${listenerPort}:${token}:${caller}`;
	const current = held.get(key);
	if (current && performance.now() < current.refreshAt) return current.credential;
	if (current) {
		const rotated = await exchange(port, listenerPort, "POST", "/api/auth/rotate", current.credential, {});
		const next = rotated?.status === 200 ? adopt(key, rotated.value) : null;
		if (next) return next;
	}
	const opened = await exchange(port, listenerPort, "POST", "/api/auth/clients", token, {
		label,
		...(current ? { resume: current.clientId } : {}),
	});
	if (opened?.status === 404) return token;
	held.delete(key);
	return opened?.status === 200 ? adopt(key, opened.value) : null;
}
function adopt(key: string, value: Record<string, unknown> | null) {
	const { clientId, credential, rotateIn } = value ?? {};
	if (typeof clientId !== "string" || typeof credential !== "string" || typeof rotateIn !== "number") return null;
	held.delete(key);
	if (held.size >= HELD_MAX) held.delete(held.keys().next().value as string);
	held.set(key, { clientId, credential, refreshAt: performance.now() + rotateIn * 1000 });
	return credential;
}
/** Forget a credential the app refused, so the next call exchanges the launch token again. */
export function dropClientCredential(port: number, listenerPort: number, token: string, caller = "") {
	held.delete(`${port}:${listenerPort}:${token}:${caller}`);
}
/**
 * The meta document of the app reached on `port`, or null when nothing answers as this app with this
 * token. A listener authenticates on its own Host, so a probe through a forward names the listener's
 * port rather than the forward's.
 */
async function readMeta(port: number, token: string, listenerPort = port, label = "Launcher") {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const credential = await clientCredential(port, listenerPort, token, label);
		if (credential === null) return null;
		const answer = await exchange(port, listenerPort, "GET", "/api/meta", credential);
		// A restarted app forgot the held credential; exchange the launch token once more.
		if (answer?.status === 401 && credential !== token) {
			dropClientCredential(port, listenerPort, token);
			continue;
		}
		return answer?.status === 200 ? answer.value : null;
	}
	return null;
}

/** The background app's own report, or null when nothing ready answers as this app with this token. */
export async function localServerMeta(port: number, token: string): Promise<LocalServerMeta | null> {
	const value = await readMeta(port, token);
	return value && value.apiVersion === 1 && value.pwa === true
		? {
				clio: typeof value.clio === "string" ? value.clio.slice(0, 64) : "unknown",
				...(typeof value.idle === "boolean" ? { idle: value.idle } : {}),
				port,
			}
		: null;
}

/** What a fleet node's own GUI reports about itself through its forward; the version gate reads it. */
export interface RemoteServerMeta {
	clio: string;
	build: string | null;
	host: string;
}
export async function remoteServerMeta(
	port: number,
	listenerPort: number,
	token: string,
): Promise<RemoteServerMeta | null> {
	const value = await readMeta(port, token, listenerPort, "Fleet attach");
	if (value?.apiVersion !== 1 || typeof value.clio !== "string") return null;
	return {
		clio: value.clio.slice(0, 64),
		build: typeof value.build === "string" ? value.build.slice(0, 128) : null,
		host: typeof value.host === "string" ? value.host.slice(0, 253) : "",
	};
}

export interface UpstreamRequest {
	method: string;
	/** Path and query as the remote server should see them. */
	path: string;
	/** Lower-cased names; the caller has already removed what must not travel. */
	headers: Record<string, string>;
	body: ReadableStream<Uint8Array> | null;
	signal?: AbortSignal;
}
export interface UpstreamResponse {
	status: number;
	headers: [string, string][];
	body: ReadableStream<Uint8Array>;
}

/**
 * One request to a fleet node's GUI through its SSH forward on `port`, answered as soon as its headers
 * arrive so a stream is piped rather than buffered. The remote listener authenticates on its own Host
 * and Origin, which name `listenerPort`, and on `credential`, this app's own client credential there;
 * the browser's own never reach it.
 */
export function proxyRequest(
	port: number,
	listenerPort: number,
	credential: string,
	init: UpstreamRequest,
): Promise<UpstreamResponse> {
	identity(port, credential);
	identity(listenerPort, credential);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port,
				path: init.path,
				method: init.method,
				headers: {
					...init.headers,
					host: `127.0.0.1:${listenerPort}`,
					origin: `http://127.0.0.1:${listenerPort}`,
					authorization: `Bearer ${credential}`,
				},
			},
			(response) => {
				const headers: [string, string][] = [];
				for (let index = 0; index + 1 < response.rawHeaders.length; index += 2)
					headers.push([response.rawHeaders[index] as string, response.rawHeaders[index + 1] as string]);
				resolve({
					status: response.statusCode ?? 502,
					headers,
					body: Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>,
				});
			},
		);
		req.on("error", reject);
		init.signal?.addEventListener("abort", () => req.destroy(), { once: true });
		if (init.body) Readable.fromWeb(init.body as unknown as NodeReadableStream<Uint8Array>).pipe(req);
		else req.end();
	});
}
/**
 * Ask the app to show a page in the window a launch just brought forward. False when the app did not
 * take the request, which an app still running an older version never does.
 */
export async function showPage(port: number, token: string, path: string) {
	identity(port, token);
	const credential = await clientCredential(port, port, token, "Launcher");
	if (credential === null) return false;
	const answer = await exchange(port, port, "POST", "/api/launch", credential, { path });
	if (answer?.status === 401) dropClientCredential(port, port, token);
	return answer?.status === 200;
}
export async function waitForLocalServer(port: number, token: string): Promise<LocalServerMeta> {
	const deadline = performance.now() + 15_000;
	while (performance.now() < deadline) {
		const meta = await findLocalServer(port, token);
		if (meta) return meta;
		await setTimeout(200);
	}
	throw new Error(
		`Clio did not become ready on port ${listenPorts(port).join(" or ")}. Check background status; another application may be using those ports.`,
	);
}
