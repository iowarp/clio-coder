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

/** The meta document of the app listening on `port`, or null when nothing answers as this app with this token. */
function readMeta(port: number, token: string) {
	identity(port, token);
	return new Promise<Record<string, unknown> | null>((resolve) => {
		const req = request(
			{ hostname: "127.0.0.1", port, path: "/api/meta", headers: { Authorization: `Bearer ${token}` } },
			(response) => {
				let body = "";
				response.on("data", (chunk: Buffer) => {
					body += chunk.toString("utf8");
					if (body.length > 8192) req.destroy();
				});
				response.on("error", () => resolve(null));
				response.on("end", () => {
					try {
						const value: unknown = JSON.parse(body);
						resolve(
							response.statusCode === 200 && value && typeof value === "object" && !Array.isArray(value)
								? (value as Record<string, unknown>)
								: null,
						);
					} catch {
						resolve(null);
					}
				});
			},
		);
		req.on("error", () => resolve(null));
		req.setTimeout(1000, () => {
			req.destroy();
			resolve(null);
		});
		req.end();
	});
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
export async function remoteServerMeta(port: number, token: string): Promise<RemoteServerMeta | null> {
	const value = await readMeta(port, token);
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
 * One request to a fleet node's GUI through its SSH forward, answered as soon as its headers arrive so
 * a stream is piped rather than buffered. The remote listener authenticates on its own Host, Origin
 * and bearer, which this sets; the browser's own never reach it.
 */
export function proxyRequest(port: number, token: string, init: UpstreamRequest): Promise<UpstreamResponse> {
	identity(port, token);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port,
				path: init.path,
				method: init.method,
				headers: {
					...init.headers,
					host: `127.0.0.1:${port}`,
					origin: `http://127.0.0.1:${port}`,
					authorization: `Bearer ${token}`,
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
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[\w-]{32,256}$/.test(token))
		throw new Error("Invalid local server identity.");
	const body = JSON.stringify({ path });
	return new Promise<boolean>((resolve) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port,
				path: "/api/launch",
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
					"Idempotency-Key": randomUUID(),
				},
			},
			(response) => {
				response.resume();
				response.on("error", () => resolve(false));
				response.on("end", () => resolve(response.statusCode === 200));
			},
		);
		req.on("error", () => resolve(false));
		req.setTimeout(1000, () => {
			req.destroy();
			resolve(false);
		});
		req.end(body);
	});
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
