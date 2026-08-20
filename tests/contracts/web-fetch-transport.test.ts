import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test from "node:test";
import type { ToolResult } from "../../src/tools/registry.js";
import { webFetchTool } from "../../src/tools/web-fetch.js";

const TEST_TIMEOUT_MS = 5_000;

interface LocalServer {
	origin: string;
	close(): Promise<void>;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<LocalServer> {
	const sockets = new Set<Socket>();
	const server: Server = createServer(handler);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});

	await bounded(
		new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		}),
		"local HTTP server listen",
	);
	const address = server.address() as AddressInfo;

	return {
		origin: `http://127.0.0.1:${address.port}`,
		async close(): Promise<void> {
			server.closeIdleConnections();
			server.closeAllConnections();
			for (const socket of sockets) socket.destroy();
			if (!server.listening) return;
			await bounded(
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
				"local HTTP server close",
			);
		},
	};
}

function assertOk(result: ToolResult): Extract<ToolResult, { kind: "ok" }> {
	ok(result.kind === "ok", result.kind === "error" ? result.message : "expected an ok web_fetch result");
	return result;
}

function assertError(result: ToolResult): Extract<ToolResult, { kind: "error" }> {
	ok(result.kind === "error", result.kind === "ok" ? result.output : "expected an error web_fetch result");
	return result;
}

test("web_fetch preserves method, body, and caller headers through the runtime transport", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const received = deferred<{ method: string; headers: Record<string, string | string[] | undefined>; body: string }>();
	const server = await listen((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const requestBody = Buffer.concat(chunks).toString("utf8");
			received.resolve({ method: request.method ?? "", headers: request.headers, body: requestBody });
			response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ accepted: requestBody }));
		});
	});

	try {
		const result = assertOk(
			await webFetchTool.run({
				url: `${server.origin}/echo`,
				method: "post",
				headers: { "X-Clio-Contract": "transport", "User-Agent": "contract-agent" },
				body: "snowman=☃",
				format: "raw",
				timeout_ms: 1_000,
			}),
		);
		const request = await bounded(received.promise, "echo request");

		strictEqual(request.method, "POST");
		strictEqual(request.body, "snowman=☃");
		strictEqual(request.headers["x-clio-contract"], "transport");
		strictEqual(request.headers["user-agent"], "contract-agent");
		match(result.output, /Content-Type: application\/json; charset=utf-8/);
		match(result.output, /\{"accepted":"snowman=☃"\}/);
		deepStrictEqual(result.details, {
			url: `${server.origin}/echo`,
			status: 200,
			contentType: "application/json; charset=utf-8",
			format: "raw",
			bytesRead: 26,
			truncated: false,
		});
	} finally {
		await server.close();
	}
});

test("web_fetch follows redirects and reports the final response URL", { timeout: TEST_TIMEOUT_MS }, async () => {
	const server = await listen((request, response) => {
		if (request.url === "/redirect") {
			response.writeHead(302, { location: "/final?source=redirect" });
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		response.end("redirect complete");
	});

	try {
		const result = assertOk(
			await webFetchTool.run({ url: `${server.origin}/redirect`, format: "raw", timeout_ms: 1_000 }),
		);
		strictEqual(result.details?.url, `${server.origin}/final?source=redirect`);
		match(result.output, new RegExp(`^URL: ${server.origin.replaceAll(".", "\\.")}/final\\?source=redirect`, "m"));
		match(result.output, /redirect complete/);
	} finally {
		await server.close();
	}
});

test("web_fetch streams UTF-8 safely, truncates by bytes, and cancels the unread response body", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const responseClosed = deferred<number>();
	const totalChunks = 1_000;
	const server = await listen((_request, response) => {
		let chunksSent = 0;
		let timer: NodeJS.Timeout | undefined;
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });

		const writeChunk = (): void => {
			if (response.destroyed) return;
			chunksSent += 1;
			response.write("🙂");
			if (chunksSent >= totalChunks) {
				response.end();
				return;
			}
			timer = setTimeout(writeChunk, 1);
		};
		response.once("close", () => {
			if (timer) clearTimeout(timer);
			responseClosed.resolve(chunksSent);
		});
		writeChunk();
	});

	try {
		const result = assertOk(
			await webFetchTool.run({
				url: `${server.origin}/stream`,
				format: "raw",
				max_bytes: 256,
				timeout_ms: 1_000,
			}),
		);
		const chunksSent = await bounded(responseClosed.promise, "stream cancellation");

		strictEqual(result.details?.truncated, true);
		strictEqual(result.details?.bytesRead, 260);
		ok(result.output.includes("[output truncated]"), result.output);
		ok(!result.output.includes("�"), result.output);
		ok(chunksSent < totalChunks, `client consumed all ${chunksSent} chunks instead of cancelling the stream`);
	} finally {
		await server.close();
	}
});

test("web_fetch maps an external AbortSignal to its stable aborted result", { timeout: TEST_TIMEOUT_MS }, async () => {
	const responseStarted = deferred<void>();
	const responseClosed = deferred<void>();
	const server = await listen((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.write("partial");
		responseStarted.resolve();
		response.once("close", () => responseClosed.resolve());
	});

	try {
		const controller = new AbortController();
		const resultPromise = webFetchTool.run(
			{ url: `${server.origin}/abort`, format: "raw", timeout_ms: 2_000 },
			{ signal: controller.signal },
		);
		await bounded(responseStarted.promise, "abort response start");
		controller.abort();

		deepStrictEqual(await bounded(resultPromise, "aborted web_fetch"), {
			kind: "error",
			message: "web_fetch: request aborted",
		});
		await bounded(responseClosed.promise, "aborted response close");
	} finally {
		await server.close();
	}
});

test("web_fetch enforces its configured request timeout", { timeout: TEST_TIMEOUT_MS }, async () => {
	const responseClosed = deferred<void>();
	const server = await listen((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.write("partial");
		response.once("close", () => responseClosed.resolve());
	});

	try {
		deepStrictEqual(
			await bounded(
				webFetchTool.run({ url: `${server.origin}/timeout`, format: "raw", timeout_ms: 25 }),
				"timed-out web_fetch",
			),
			{ kind: "error", message: "web_fetch: timeout after 25ms" },
		);
		await bounded(responseClosed.promise, "timed-out response close");
	} finally {
		await server.close();
	}
});

test("web_fetch maps HTTP failures to a bounded extracted preview", { timeout: TEST_TIMEOUT_MS }, async () => {
	const server = await listen((_request, response) => {
		response.statusCode = 418;
		response.statusMessage = "Teapot Contract";
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end("<!doctype html><main><h1>Refused</h1><p>contract preview</p></main>");
	});

	try {
		const result = assertError(await webFetchTool.run({ url: `${server.origin}/error`, timeout_ms: 1_000 }));
		strictEqual(result.message, "web_fetch: HTTP 418: Teapot Contract\nPreview:\n# Refused\n\n contract preview");
	} finally {
		await server.close();
	}
});

test("web_fetch rejects binary response types before exposing content", { timeout: TEST_TIMEOUT_MS }, async () => {
	const server = await listen((_request, response) => {
		response.writeHead(200, { "content-type": "application/octet-stream" });
		response.end(Buffer.from([0x00, 0x01, 0x02, 0xff]));
	});

	try {
		deepStrictEqual(await webFetchTool.run({ url: `${server.origin}/binary`, timeout_ms: 1_000 }), {
			kind: "error",
			message: "web_fetch: binary or unsupported content type: application/octet-stream",
		});
	} finally {
		await server.close();
	}
});

test("web_fetch maps a local transport failure instead of throwing", { timeout: TEST_TIMEOUT_MS }, async () => {
	const server = await listen((request) => request.socket.destroy());

	try {
		deepStrictEqual(await webFetchTool.run({ url: `${server.origin}/reset`, timeout_ms: 1_000 }), {
			kind: "error",
			message: "web_fetch: fetch failed",
		});
	} finally {
		await server.close();
	}
});
