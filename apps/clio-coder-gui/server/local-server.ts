import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setTimeout } from "node:timers/promises";
import { launcherProof, sameSecret, serverProof } from "./launch-proof.js";
import { listenPorts } from "./launcher/ports.js";
import type { WindowAnswer } from "./relaunch-model.js";

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
	bearer: string | null,
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
					...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
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
 * This process's own credential on the app at `port`, opened with a proof of its launch token bound to
 * `listenerPort` and rotated at half-life. The launch token itself is never sent: whatever owns the port
 * (another user's listener included) sees only a proof the real app on any other port refuses, and a
 * listener that cannot prove the token back is not this app. Null when nothing answers as this app.
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
	const issued = await exchange(port, listenerPort, "POST", "/api/auth/challenge", null, {});
	const challenge = issued?.status === 200 ? issued.value?.challenge : undefined;
	if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
		held.delete(key);
		return null;
	}
	const opened = await exchange(port, listenerPort, "POST", "/api/auth/clients", null, {
		label,
		...(current ? { resume: current.clientId } : {}),
		challenge,
		proof: launcherProof(token, challenge, listenerPort),
	});
	held.delete(key);
	const answer = opened?.status === 200 ? opened.value?.serverProof : undefined;
	return typeof answer === "string" && sameSecret(serverProof(token, challenge, listenerPort), answer)
		? adopt(key, opened?.value ?? null)
		: null;
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
		if (answer?.status === 401) {
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
 * Ask the app whether a window is open to hear a launch and, with a path, to show that page in the
 * window a launch just brought forward. "unknown" when the app did not take the request.
 */
export async function showPage(port: number, token: string, path?: string): Promise<WindowAnswer> {
	identity(port, token);
	const credential = await clientCredential(port, port, token, "Launcher");
	if (credential === null) return "unknown";
	const answer = await exchange(port, port, "POST", "/api/launch", credential, path === undefined ? {} : { path });
	if (answer?.status === 401) dropClientCredential(port, port, token);
	if (answer?.status !== 200) return "unknown";
	// An older app took a page and said nothing more, which then meant it was shown.
	return answer.value?.shown === false ? "no-window" : "shown";
}
/**
 * A single-use, short-lived ticket for the URL a launcher opens, so the launch token never sits in an
 * opener's argv or the page's storage. Null when the app did not issue one.
 */
export async function launchTicket(port: number, token: string) {
	identity(port, token);
	const credential = await clientCredential(port, port, token, "Launcher");
	if (credential === null) return null;
	const answer = await exchange(port, port, "POST", "/api/auth/launch-ticket", credential, {});
	if (answer?.status === 401) dropClientCredential(port, port, token);
	const ticket = answer?.status === 200 ? answer.value?.ticket : undefined;
	return typeof ticket === "string" && /^[\w-]{43}$/.test(ticket) ? ticket : null;
}
/** With `current`, each attempt proves the token the app published last, since a starting app rotates it. */
export async function waitForLocalServer(
	port: number,
	token: string,
	current?: () => Promise<string>,
): Promise<LocalServerMeta> {
	const deadline = performance.now() + 15_000;
	while (performance.now() < deadline) {
		const meta = await findLocalServer(port, current ? await current().catch(() => token) : token);
		if (meta) return meta;
		await setTimeout(200);
	}
	throw new Error(
		`Clio did not become ready on port ${listenPorts(port).join(" or ")}. Check clio-coder gui background status; another application may be using those ports.`,
	);
}
