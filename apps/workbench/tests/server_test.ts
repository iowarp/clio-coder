import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ClioLauncher, EngineError } from "../engine.ts";
import {
	defaultClioLauncher,
	MAX_WEBSOCKET_OUTBOUND_BYTES,
	type RunningWorkbenchServer,
	startWorkbenchServer,
	wouldExceedWebSocketHighWaterMark,
} from "../main.ts";
import { MAX_CLIENT_FRAME_BYTES, parseServerEvent, PROTOCOL_VERSION, type ServerEvent } from "../src/protocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INDEX_HTML =
	"<!doctype html><html><head><title>Workbench server fixture</title></head><body>fixture</body></html>";
const ASSET_JAVASCRIPT = "globalThis.__workbenchServerFixture = true;\n";
const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const ACP_CHILD_FIXTURE = fileURLToPath(new URL("./acp-child-fixture.ts", import.meta.url));
const ACP_TRANSCRIPT_PROXY = String.raw`
const [fixturePath, transcriptPath] = Deno.args;
if (fixturePath === undefined || transcriptPath === undefined) throw new Error("proxy paths are required");

const child = new Deno.Command(Deno.execPath(), {
  args: ["run", "--quiet", "--no-config", fixturePath, "--scenario=permission"],
  stdin: "piped",
  stdout: "piped",
  stderr: "piped",
}).spawn();

const writeAll = async (writer, bytes) => {
  let offset = 0;
  while (offset < bytes.byteLength) offset += await writer.write(bytes.subarray(offset));
};

const decoder = new TextDecoder();
let transcript = "";
let transcriptBytes = 0;
const forwardInput = async () => {
  const writer = child.stdin.getWriter();
  try {
    for await (const chunk of Deno.stdin.readable) {
      transcriptBytes += chunk.byteLength;
      if (transcriptBytes > 64 * 1024) throw new Error("host transcript exceeded its test bound");
      transcript += decoder.decode(chunk, { stream: true });
      await writer.write(chunk);
    }
    transcript += decoder.decode();
  } finally {
    await writer.close().catch(() => undefined);
  }
};

const forwardOutput = async (readable, writer) => {
  for await (const chunk of readable) await writeAll(writer, chunk);
};

const [, , , status] = await Promise.all([
  forwardInput(),
  forwardOutput(child.stdout, Deno.stdout),
  forwardOutput(child.stderr, Deno.stderr),
  child.status,
]);
await Deno.writeTextFile(transcriptPath, transcript);
if (!status.success) Deno.exit(status.code);
`;

interface ServerFixture {
	readonly running: RunningWorkbenchServer;
	readonly temporaryRoot: string;
	close(): Promise<void>;
}

interface HandshakeResponse {
	readonly connection: Deno.Conn;
	readonly status: number;
	readonly headers: ReadonlyMap<string, string>;
	readonly remainder: Uint8Array;
	readonly webSocketKey: string;
}

interface WebSocketFrame {
	readonly opcode: number;
	readonly payload: Uint8Array;
}

interface WebSocketClose {
	readonly code: number;
	readonly reason: string;
}

async function startFixture(eventDelayMs = 3, clioLauncher?: ClioLauncher): Promise<ServerFixture> {
	const temporaryRoot = await Deno.makeTempDir({ prefix: "workbench-server-test-" });
	const distRoot = join(temporaryRoot, "dist");
	try {
		await Deno.mkdir(join(distRoot, "assets"), { recursive: true });
		await Promise.all([
			Deno.writeTextFile(join(distRoot, "index.html"), INDEX_HTML),
			Deno.writeTextFile(join(distRoot, "assets", "fixture.js"), ASSET_JAVASCRIPT),
		]);
		const running = await startWorkbenchServer({
			dataDir: join(temporaryRoot, "data"),
			distRoot: pathToFileURL(`${distRoot}/`),
			eventDelayMs,
			mode: "browser",
			port: 0,
			quiet: true,
			...(clioLauncher === undefined ? {} : { clioLauncher }),
		});
		return {
			running,
			temporaryRoot,
			async close() {
				try {
					await running.close();
				} finally {
					await Deno.remove(temporaryRoot, { recursive: true });
				}
			},
		};
	} catch (error) {
		await Deno.remove(temporaryRoot, { recursive: true });
		throw error;
	}
}

function assertSecurityHeaders(headers: Headers): void {
	match(headers.get("content-security-policy") ?? "", /default-src 'self'/u);
	equal(headers.get("cross-origin-opener-policy"), "same-origin");
	equal(headers.get("cross-origin-resource-policy"), "same-origin");
	equal(headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
	equal(headers.get("referrer-policy"), "no-referrer");
	equal(headers.get("x-content-type-options"), "nosniff");
	equal(headers.get("x-frame-options"), "DENY");
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
	const combined = new Uint8Array(left.byteLength + right.byteLength);
	combined.set(left);
	combined.set(right, left.byteLength);
	return combined;
}

async function writeAll(connection: Deno.Conn, bytes: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) offset += await connection.write(bytes.subarray(offset));
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function findHeaderEnd(bytes: Uint8Array): number {
	for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
		if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
			return index;
		}
	}
	return -1;
}

async function readHandshakeHead(connection: Deno.Conn): Promise<{
	status: number;
	headers: ReadonlyMap<string, string>;
	remainder: Uint8Array;
}> {
	let buffered: Uint8Array = new Uint8Array();
	for (;;) {
		const headerEnd = findHeaderEnd(buffered);
		if (headerEnd >= 0) {
			const lines = decoder.decode(buffered.subarray(0, headerEnd)).split("\r\n");
			const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(lines[0] ?? "");
			if (!statusMatch) throw new Error(`Invalid HTTP handshake status: ${lines[0] ?? "<empty>"}`);
			const headers = new Map<string, string>();
			for (const line of lines.slice(1)) {
				const colon = line.indexOf(":");
				if (colon <= 0) throw new Error(`Invalid HTTP handshake header: ${line}`);
				headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
			}
			return {
				status: Number(statusMatch[1]),
				headers,
				remainder: buffered.slice(headerEnd + 4),
			};
		}
		if (buffered.byteLength > 64 * 1024) throw new Error("HTTP handshake headers exceeded 64 KiB");
		const chunk = new Uint8Array(4096);
		const count = await connection.read(chunk);
		if (count === null) throw new Error("Connection closed before the HTTP handshake completed");
		buffered = concatenate(buffered, chunk.subarray(0, count));
	}
}

async function openHandshake(endpoint: URL, origin?: string): Promise<HandshakeResponse> {
	const connection = await Deno.connect({ hostname: endpoint.hostname, port: Number(endpoint.port) });
	const nonce = crypto.getRandomValues(new Uint8Array(16));
	const webSocketKey = base64(nonce);
	const requestHeaders = [
		`GET ${endpoint.pathname}${endpoint.search} HTTP/1.1`,
		`Host: ${endpoint.host}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Key: ${webSocketKey}`,
		"Sec-WebSocket-Version: 13",
		...(origin === undefined ? [] : [`Origin: ${origin}`]),
		"",
		"",
	];
	try {
		await writeAll(connection, encoder.encode(requestHeaders.join("\r\n")));
		const response = await readHandshakeHead(connection);
		return { connection, webSocketKey, ...response };
	} catch (error) {
		connection.close();
		throw error;
	}
}

async function expectedWebSocketAccept(key: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", encoder.encode(`${key}${WEB_SOCKET_GUID}`));
	return base64(new Uint8Array(digest));
}

async function upgradeStatus(endpoint: URL, origin?: string): Promise<number> {
	const response = await openHandshake(endpoint, origin);
	try {
		return response.status;
	} finally {
		response.connection.close();
	}
}

async function withTimeout<T>(operation: Promise<T>, description: string, milliseconds = 2_000): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds);
	});
	try {
		return await Promise.race([operation, expired]);
	} finally {
		clearTimeout(timeout);
	}
}

class RawWebSocket {
	readonly #connection: Deno.Conn;
	#buffered: Uint8Array;
	#transportClosed = false;

	private constructor(connection: Deno.Conn, buffered: Uint8Array) {
		this.#connection = connection;
		this.#buffered = buffered;
	}

	static async connect(endpoint: URL, origin: string): Promise<RawWebSocket> {
		const response = await openHandshake(endpoint, origin);
		if (response.status !== 101) {
			response.connection.close();
			throw new Error(`WebSocket upgrade returned HTTP ${response.status}`);
		}
		const upgrade = response.headers.get("upgrade")?.toLowerCase();
		const connection = response.headers.get("connection")?.toLowerCase() ?? "";
		const accept = response.headers.get("sec-websocket-accept");
		if (upgrade !== "websocket" || !connection.split(/\s*,\s*/u).includes("upgrade")) {
			response.connection.close();
			throw new Error("WebSocket upgrade response omitted its required headers");
		}
		if (accept !== await expectedWebSocketAccept(response.webSocketKey)) {
			response.connection.close();
			throw new Error("WebSocket upgrade response returned an invalid accept key");
		}
		return new RawWebSocket(response.connection, response.remainder);
	}

	async sendText(value: string): Promise<void> {
		await this.#sendFrame(0x1, encoder.encode(value));
	}

	async readEvent(): Promise<ServerEvent> {
		const frame = await this.#readFrame("a server event");
		if (frame.opcode === 0x8) {
			const close = decodeClose(frame.payload);
			throw new Error(`WebSocket closed with ${close.code}: ${close.reason}`);
		}
		if (frame.opcode !== 0x1) throw new Error(`Expected a text frame, received opcode ${frame.opcode}`);
		return parseServerEvent(decoder.decode(frame.payload));
	}

	async readClose(): Promise<WebSocketClose> {
		for (;;) {
			const frame = await this.#readFrame("the WebSocket close frame");
			if (frame.opcode !== 0x8) continue;
			return decodeClose(frame.payload);
		}
	}

	async closeGracefully(): Promise<void> {
		if (this.#transportClosed) return;
		const payload = new Uint8Array(2);
		new DataView(payload.buffer).setUint16(0, 1000);
		try {
			await this.#sendFrame(0x8, payload);
			await this.readClose();
		} finally {
			this.closeAbruptly();
		}
	}

	closeAbruptly(): void {
		if (this.#transportClosed) return;
		this.#transportClosed = true;
		this.#connection.close();
	}

	async #sendFrame(opcode: number, payload: Uint8Array): Promise<void> {
		if (this.#transportClosed) throw new Error("Cannot write to a closed WebSocket transport");
		const extendedBytes = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
		const maskOffset = 2 + extendedBytes;
		const frame = new Uint8Array(maskOffset + 4 + payload.byteLength);
		frame[0] = 0x80 | opcode;
		frame[1] = 0x80 | (extendedBytes === 0 ? payload.byteLength : extendedBytes === 2 ? 126 : 127);
		const view = new DataView(frame.buffer);
		if (extendedBytes === 2) view.setUint16(2, payload.byteLength);
		else if (extendedBytes === 8) view.setBigUint64(2, BigInt(payload.byteLength));
		const mask = crypto.getRandomValues(new Uint8Array(4));
		frame.set(mask, maskOffset);
		for (let index = 0; index < payload.byteLength; index += 1) {
			frame[maskOffset + 4 + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
		}
		await writeAll(this.#connection, frame);
	}

	async #readFrame(description: string): Promise<WebSocketFrame> {
		return await withTimeout(this.#readFrameWithoutTimeout(), description);
	}

	async #readFrameWithoutTimeout(): Promise<WebSocketFrame> {
		for (;;) {
			const header = await this.#take(2);
			const final = (header[0]! & 0x80) !== 0;
			const reserved = header[0]! & 0x70;
			const opcode = header[0]! & 0x0f;
			const masked = (header[1]! & 0x80) !== 0;
			let payloadLength = header[1]! & 0x7f;
			if (reserved !== 0 || !final) throw new Error("Test client received an unsupported fragmented/extended frame");
			if (payloadLength === 126) payloadLength = new DataView((await this.#take(2)).buffer).getUint16(0);
			else if (payloadLength === 127) {
				const encodedLength = new DataView((await this.#take(8)).buffer).getBigUint64(0);
				if (encodedLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame length was not safe");
				payloadLength = Number(encodedLength);
			}
			if (payloadLength > 1024 * 1024) throw new Error("Test client refused a WebSocket frame larger than 1 MiB");
			const mask = masked ? await this.#take(4) : undefined;
			const payload = await this.#take(payloadLength);
			if (mask) {
				for (let index = 0; index < payload.byteLength; index += 1) {
					payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
				}
			}
			if (opcode === 0x9) {
				await this.#sendFrame(0xa, payload);
				continue;
			}
			if (opcode === 0xa) continue;
			return { opcode, payload };
		}
	}

	async #take(length: number): Promise<Uint8Array> {
		while (this.#buffered.byteLength < length) {
			const chunk = new Uint8Array(Math.max(4096, length - this.#buffered.byteLength));
			const count = await this.#connection.read(chunk);
			if (count === null) throw new Error("WebSocket transport closed before a complete frame arrived");
			this.#buffered = concatenate(this.#buffered, chunk.subarray(0, count));
		}
		const taken = this.#buffered.slice(0, length);
		this.#buffered = this.#buffered.slice(length);
		return taken;
	}
}

function decodeClose(payload: Uint8Array): WebSocketClose {
	if (payload.byteLength === 0) return { code: 1005, reason: "" };
	if (payload.byteLength === 1) throw new Error("Invalid one-byte WebSocket close payload");
	return {
		code: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0),
		reason: decoder.decode(payload.subarray(2)),
	};
}

function eventsEndpoint(running: RunningWorkbenchServer, token = running.token): URL {
	const endpoint = new URL("/api/events", running.url);
	endpoint.protocol = "ws:";
	endpoint.searchParams.set("token", token);
	return endpoint;
}

async function sendCommand(
	socket: RawWebSocket,
	requestId: string,
	kind: string,
	payload: Readonly<Record<string, unknown>>,
): Promise<void> {
	await socket.sendText(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId, kind, payload }));
}

async function collectThrough(socket: RawWebSocket, terminalKind: ServerEvent["kind"]): Promise<ServerEvent[]> {
	const events: ServerEvent[] = [];
	for (let index = 0; index < 32; index += 1) {
		const event = await socket.readEvent();
		events.push(event);
		if (event.kind === terminalKind) return events;
	}
	throw new Error(`Did not receive ${terminalKind} within 32 server events`);
}

function assertContiguous(events: readonly ServerEvent[], workspaceInstanceId: string): void {
	deepStrictEqual(events.map((event) => event.sequence), events.map((_event, index) => index + 1));
	for (const event of events) {
		equal(event.workspaceInstanceId, workspaceInstanceId);
		equal(event.eventId, `event-${String(event.sequence).padStart(6, "0")}`);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readTextFileEventually(path: string, description: string, timeoutMs = 5_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await Deno.readTextFile(path);
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
			await delay(10);
		}
	}
}

Deno.test("outbound WebSocket high-water accounting includes the next UTF-8 frame at the exact boundary", () => {
	equal(wouldExceedWebSocketHighWaterMark(MAX_WEBSOCKET_OUTBOUND_BYTES - 1, 1), false);
	equal(wouldExceedWebSocketHighWaterMark(MAX_WEBSOCKET_OUTBOUND_BYTES, 0), false);
	equal(wouldExceedWebSocketHighWaterMark(MAX_WEBSOCKET_OUTBOUND_BYTES, encoder.encode("x").byteLength), true);
	equal(
		wouldExceedWebSocketHighWaterMark(MAX_WEBSOCKET_OUTBOUND_BYTES - 3, encoder.encode("😀").byteLength),
		true,
	);
	equal(wouldExceedWebSocketHighWaterMark(-1, 1), true);
});

Deno.test("startWorkbenchServer serves bootstrap and static assets with bounded HTTP behavior", async () => {
	const fixture = await startFixture();
	try {
		const { running } = fixture;
		const bootstrapResponse = await fetch(new URL("/api/bootstrap", running.url));
		equal(bootstrapResponse.status, 200);
		equal(bootstrapResponse.headers.get("content-type"), "application/json; charset=utf-8");
		equal(bootstrapResponse.headers.get("cache-control"), "no-store");
		assertSecurityHeaders(bootstrapResponse.headers);
		const bootstrap = await bootstrapResponse.json() as Record<string, unknown>;
		equal(bootstrap.protocolVersion, PROTOCOL_VERSION);
		equal(bootstrap.appName, "Clio Workbench");
		equal(bootstrap.workspaceInstanceId, running.workspaceInstanceId);
		equal(bootstrap.localToken, running.token);
		equal(bootstrap.mode, "browser");
		equal(Object.hasOwn(bootstrap, "fakeEngine"), false);
		ok(Array.isArray(bootstrap.projects));
		equal(bootstrap.projects.length, 2);
		equal(typeof bootstrap.selectedProjectId, "string");
		for (const value of bootstrap.projects) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new Error("Bootstrap project was not a workspace object");
			}
			const workspace = value as Record<string, unknown>;
			if (typeof workspace.engine !== "object" || workspace.engine === null || Array.isArray(workspace.engine)) {
				throw new Error("Bootstrap workspace omitted its engine snapshot");
			}
			const engine = workspace.engine as Record<string, unknown>;
			equal(engine.kind, "fake");
			equal(engine.phase, "ready");
			ok(Array.isArray(engine.facts));
			equal(workspace.pendingPermission, null);
		}

		const indexResponse = await fetch(running.url);
		equal(indexResponse.status, 200);
		equal(indexResponse.headers.get("content-type"), "text/html; charset=utf-8");
		equal(indexResponse.headers.get("cache-control"), "no-cache");
		assertSecurityHeaders(indexResponse.headers);
		equal(await indexResponse.text(), INDEX_HTML);

		const headResponse = await fetch(new URL("/assets/fixture.js", running.url), { method: "HEAD" });
		equal(headResponse.status, 200);
		equal(headResponse.headers.get("content-type"), "text/javascript; charset=utf-8");
		equal(headResponse.headers.get("cache-control"), "public, max-age=3600");
		assertSecurityHeaders(headResponse.headers);
		equal(await headResponse.text(), "");

		const fallbackResponse = await fetch(new URL("/projects/atlas", running.url), {
			headers: { accept: "text/html" },
		});
		equal(fallbackResponse.status, 200);
		equal(await fallbackResponse.text(), INDEX_HTML);

		const traversalResponse = await fetch(`${running.url}/safe/%2e%2e%2fsecret.txt`);
		equal(traversalResponse.status, 400);
		equal(await traversalResponse.text(), "Invalid asset path");
		assertSecurityHeaders(traversalResponse.headers);

		const missingResponse = await fetch(new URL("/missing.js", running.url), {
			headers: { accept: "text/html" },
		});
		equal(missingResponse.status, 404);
		equal(await missingResponse.text(), "Asset not found");

		const methodResponse = await fetch(new URL("/api/bootstrap", running.url), { method: "POST" });
		equal(methodResponse.status, 405);
		equal(await methodResponse.text(), "Method not allowed");
		assertSecurityHeaders(methodResponse.headers);

		const staticMethodResponse = await fetch(running.url, { method: "POST" });
		equal(staticMethodResponse.status, 405);
		equal(await staticMethodResponse.text(), "Method not allowed");

		const eventsWithoutUpgrade = await fetch(new URL("/api/events", running.url));
		equal(eventsWithoutUpgrade.status, 426);
		equal(await eventsWithoutUpgrade.text(), "WebSocket upgrade required");

		const unknownApiResponse = await fetch(new URL("/api/unknown", running.url));
		equal(unknownApiResponse.status, 404);
		deepStrictEqual(await unknownApiResponse.json(), { error: "not-found" });
	} finally {
		await fixture.close();
	}
});

Deno.test("static assets reject file-URL escapes without breaking owned assets or SPA fallback", async () => {
	const fixture = await startFixture();
	try {
		const { running } = fixture;
		const outsidePath = join(fixture.temporaryRoot, "outside-secret.txt");
		await Deno.writeTextFile(outsidePath, "must not be served\n");
		const outsideUrl = pathToFileURL(outsidePath).href;
		const attackPaths = [
			"/file:///etc/passwd",
			`/${outsideUrl}`,
			`/${outsideUrl.replace(/^file:/u, "file%3A").replaceAll("/", "%2F")}`,
			"/FiLe:%2F%2F%2Fetc%2Fpasswd",
		];
		for (const attackPath of attackPaths) {
			const response = await fetch(`${running.url}${attackPath}`);
			equal(response.status, 400, attackPath);
			equal(await response.text(), "Invalid asset path", attackPath);
			assertSecurityHeaders(response.headers);
		}

		const assetResponse = await fetch(new URL("/assets/fixture.js", running.url));
		equal(assetResponse.status, 200);
		equal(await assetResponse.text(), ASSET_JAVASCRIPT);

		const fallbackResponse = await fetch(new URL("/projects/still-local", running.url), {
			headers: { accept: "text/html" },
		});
		equal(fallbackResponse.status, 200);
		equal(await fallbackResponse.text(), INDEX_HTML);
	} finally {
		await fixture.close();
	}
});

Deno.test("the native Windows product launcher remains unavailable without an explicit WSL mapping", async () => {
	const launcher = defaultClioLauncher("windows");
	await rejects(
		launcher.probe("C:\\bounded-project"),
		(error: unknown) =>
			error instanceof EngineError && error.code === "not-ready" &&
			/error.*WSL project mapping|WSL project mapping.*configured/iu.test(error.message),
	);
	throws(
		() => launcher.launch("C:\\bounded-project"),
		(error: unknown) =>
			error instanceof EngineError && error.code === "not-ready" && /explicit WSL configuration/iu.test(error.message),
	);
});

Deno.test("authenticated Origin-bound WebSocket emits one deterministic contiguous v2 turn", async () => {
	const fixture = await startFixture();
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		equal(await upgradeStatus(eventsEndpoint(running), "http://127.0.0.1:1"), 403);
		equal(await upgradeStatus(eventsEndpoint(running)), 403);
		equal(await upgradeStatus(eventsEndpoint(running, `${running.token}-wrong`), running.url), 403);

		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		const projectId = bootstrap.selectedProjectId;
		if (typeof projectId !== "string") throw new Error("Bootstrap did not select a project");

		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		const ready = await socket.readEvent();
		equal(ready.kind, "connection.ready");
		equal(ready.sequence, 1);

		await sendCommand(socket, "request-start-0001", "turn.start", {
			projectId,
			prompt: "Verify the deterministic server integration path",
			fakeScenario: "complete",
		});
		const throughPermission = await collectThrough(socket, "turn.permission.requested");
		deepStrictEqual(throughPermission.map((event) => event.kind), [
			"engine.state",
			"turn.started",
			"turn.thought",
			"turn.agent",
			"turn.tool",
			"turn.tool",
			"turn.change",
			"engine.state",
			"turn.permission.requested",
		]);
		const started = throughPermission.find((event) => event.kind === "turn.started");
		const permission = throughPermission.at(-1);
		if (started?.kind !== "turn.started" || permission?.kind !== "turn.permission.requested") {
			throw new Error("Deterministic turn did not reach its permission boundary");
		}
		equal(started.projectId, projectId);
		equal(started.payload.fakeScenario, "complete");
		equal(started.payload.source, "simulated-by-workbench");
		equal(permission.payload.permissionId, "permission-fake-0001");
		equal(permission.payload.toolCallId, "tool-fake-artifact");
		deepStrictEqual(permission.payload.locations, [{ segments: ["analysis", "convergence-notes.md"] }]);

		await sendCommand(socket, "request-permission-0001", "permission.resolve", {
			projectId,
			turnId: started.turnId,
			permissionId: permission.payload.permissionId,
			decision: "allow-once",
		});
		const throughCompletion = await collectThrough(socket, "turn.terminal");
		deepStrictEqual(throughCompletion.map((event) => event.kind), [
			"turn.permission.resolved",
			"turn.evidence",
			"turn.agent",
			"turn.terminal",
		]);
		const allEvents = [ready, ...throughPermission, ...throughCompletion];
		assertContiguous(allEvents, running.workspaceInstanceId);
		for (const event of allEvents.filter((event) => event.kind.startsWith("turn."))) {
			equal(event.projectId, projectId);
			equal(event.sessionId, started.sessionId);
			equal(event.turnId, started.turnId);
		}
		deepStrictEqual(allEvents.map((event) => event.terminal), [
			...Array.from({ length: allEvents.length - 1 }, () => false),
			true,
		]);
		const completed = throughCompletion.at(-1);
		if (completed?.kind !== "turn.terminal") throw new Error("Deterministic turn did not complete");
		equal(completed.payload.outcome, "completed");
		equal(completed.payload.code, "fake-completed");
		equal(completed.payload.source, "simulated-by-workbench");

		await socket.closeGracefully();
		socket = undefined;
	} finally {
		socket?.closeAbruptly();
		await fixture.close();
	}
});

Deno.test("injected Clio launcher projects one real ACP turn through the neutral v2 host protocol", async () => {
	const probedRoots: string[] = [];
	const launchedRoots: string[] = [];
	const launcher: ClioLauncher = {
		probe(trustedRoot) {
			probedRoots.push(trustedRoot);
			return Promise.resolve({ version: "clio-coder fixture-0.0.0" });
		},
		launch(trustedRoot) {
			launchedRoots.push(trustedRoot);
			return {
				command: Deno.execPath(),
				args: ["run", "--quiet", "--no-config", ACP_CHILD_FIXTURE, "--scenario=happy"],
				cwd: trustedRoot,
				clearEnv: true,
				terminationScope: Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
				redact: [trustedRoot],
			};
		},
	};
	const fixture = await startFixture(3, launcher);
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		const projectId = bootstrap.selectedProjectId;
		if (typeof projectId !== "string") throw new Error("Bootstrap did not select a project");

		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		const events: ServerEvent[] = [await socket.readEvent()];
		await sendCommand(socket, "request-clio-select", "engine.select", { projectId, kind: "clio-acp" });
		const selected = await socket.readEvent();
		events.push(selected);
		if (selected.kind !== "engine.state") throw new Error("Clio selection did not emit engine.state");
		equal(selected.payload.snapshot.kind, "clio-acp");
		equal(selected.payload.snapshot.phase, "unprobed");

		await sendCommand(socket, "request-clio-probe", "engine.probe", { projectId });
		const probing = await socket.readEvent();
		const ready = await socket.readEvent();
		events.push(probing, ready);
		if (probing.kind !== "engine.state" || ready.kind !== "engine.state") {
			throw new Error("Clio probe did not emit bounded readiness states");
		}
		equal(probing.payload.snapshot.phase, "probing");
		equal(ready.payload.snapshot.phase, "ready");

		await sendCommand(socket, "request-clio-turn", "turn.start", {
			projectId,
			prompt: "Exercise the injected ACP host boundary",
		});
		const turnEvents = await collectThrough(socket, "turn.terminal");
		events.push(...turnEvents);
		const started = turnEvents.find((event) => event.kind === "turn.started");
		const terminal = turnEvents.at(-1);
		if (started?.kind !== "turn.started" || terminal?.kind !== "turn.terminal") {
			throw new Error("Injected ACP turn did not reach a neutral terminal event");
		}
		match(started.sessionId ?? "", /^session-clio-/u);
		match(started.turnId ?? "", /^turn-clio-/u);
		ok(turnEvents.some((event) => event.kind === "turn.text"));
		ok(turnEvents.some((event) => event.kind === "turn.thought"));
		deepStrictEqual(
			turnEvents.filter((event) => event.kind === "turn.tool").map((event) => event.payload.status),
			["in_progress", "completed"],
		);
		equal(terminal.payload.outcome, "completed");
		equal(terminal.payload.stopReason, "end_turn");
		equal(terminal.payload.source, "reported-by-clio");
		for (const event of turnEvents.filter((event) => event.kind.startsWith("turn."))) {
			equal(event.projectId, projectId);
			equal(event.sessionId, started.sessionId);
			equal(event.turnId, started.turnId);
		}
		assertContiguous(events, running.workspaceInstanceId);

		deepStrictEqual(probedRoots, launchedRoots);
		equal(probedRoots.length, 1);
		const projection = JSON.stringify(events);
		for (const privateValue of [probedRoots[0], "fixture-session-1", "fixture-tool-1", "rawInput", "rawOutput"]) {
			if (privateValue !== undefined) ok(!projection.includes(privateValue), `host projection leaked ${privateValue}`);
		}
		ok(!projection.includes("demo."));

		await socket.closeGracefully();
		socket = undefined;
	} finally {
		socket?.closeAbruptly();
		await fixture.close();
	}
});

Deno.test("raw WebSocket disconnect cancels a pending ACP permission, retires the child, and releases the slot", async () => {
	const observationRoot = await Deno.makeTempDir({ prefix: "workbench-server-permission-disconnect-" });
	const proxyPath = join(observationRoot, "acp-transcript-proxy.js");
	const transcriptPaths: string[] = [];
	const launchedRoots: string[] = [];
	await Deno.writeTextFile(proxyPath, ACP_TRANSCRIPT_PROXY);
	const launcher: ClioLauncher = {
		probe() {
			return Promise.resolve({ version: "clio-coder fixture-0.0.0" });
		},
		launch(trustedRoot) {
			launchedRoots.push(trustedRoot);
			const transcriptPath = join(observationRoot, `host-transcript-${launchedRoots.length}.jsonl`);
			transcriptPaths.push(transcriptPath);
			return {
				command: Deno.execPath(),
				args: [
					"run",
					"--quiet",
					"--no-config",
					`--allow-run=${Deno.execPath()}`,
					`--allow-write=${transcriptPath}`,
					proxyPath,
					ACP_CHILD_FIXTURE,
					transcriptPath,
				],
				cwd: trustedRoot,
				clearEnv: true,
				terminationScope: Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
				redact: [trustedRoot],
			};
		},
	};

	let fixture: ServerFixture | undefined;
	let owner: RawWebSocket | undefined;
	let successor: RawWebSocket | undefined;
	try {
		fixture = await startFixture(1, launcher);
		const { running } = fixture;
		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		const projectId = bootstrap.selectedProjectId;
		if (typeof projectId !== "string") throw new Error("Bootstrap did not select a project");

		owner = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await owner.readEvent()).kind, "connection.ready");
		await sendCommand(owner, "request-disconnect-select", "engine.select", { projectId, kind: "clio-acp" });
		const selected = await owner.readEvent();
		if (selected.kind !== "engine.state") throw new Error("Clio selection did not emit engine.state");
		equal(selected.payload.snapshot.phase, "unprobed");
		await sendCommand(owner, "request-disconnect-probe", "engine.probe", { projectId });
		const probing = await owner.readEvent();
		const ready = await owner.readEvent();
		if (probing.kind !== "engine.state" || ready.kind !== "engine.state") {
			throw new Error("Clio probe did not emit readiness states");
		}
		equal(probing.payload.snapshot.phase, "probing");
		equal(ready.payload.snapshot.phase, "ready");

		await sendCommand(owner, "request-disconnect-turn", "turn.start", {
			projectId,
			prompt: "Disconnect this browser exactly at the real ACP permission boundary",
		});
		const ownerTurnEvents = await collectThrough(owner, "turn.permission.requested");
		const ownerStarted = ownerTurnEvents.find((event) => event.kind === "turn.started");
		const ownerPermission = ownerTurnEvents.at(-1);
		if (ownerStarted?.kind !== "turn.started" || ownerPermission?.kind !== "turn.permission.requested") {
			throw new Error("The injected ACP turn did not reach its permission boundary");
		}
		equal(ownerPermission.payload.source, "observed-on-acp");
		const busyBootstrap = await fetch(new URL("/api/bootstrap", running.url));
		equal(busyBootstrap.status, 409);
		deepStrictEqual(await busyBootstrap.json(), { error: "engine-busy" });
		assertSecurityHeaders(busyBootstrap.headers);
		owner.closeAbruptly();
		owner = undefined;

		let reconciledBootstrap: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 100 && reconciledBootstrap === undefined; attempt += 1) {
			const response = await fetch(new URL("/api/bootstrap", running.url));
			if (response.status === 409) {
				deepStrictEqual(await response.json(), { error: "engine-busy" });
				await delay(10);
				continue;
			}
			equal(response.status, 200);
			reconciledBootstrap = await response.json() as Record<string, unknown>;
		}
		if (reconciledBootstrap === undefined) {
			throw new Error("Bootstrap did not reconcile the disconnected permission owner");
		}
		const reconciledProjects = reconciledBootstrap.projects;
		if (!Array.isArray(reconciledProjects)) throw new Error("Reconciled bootstrap omitted its projects");
		const reconciledWorkspace = reconciledProjects.find((value) =>
			typeof value === "object" && value !== null && !Array.isArray(value) &&
			(value as Record<string, unknown>).project !== null &&
			typeof (value as Record<string, unknown>).project === "object" &&
			((value as Record<string, unknown>).project as Record<string, unknown>).id === projectId
		) as Record<string, unknown> | undefined;
		if (reconciledWorkspace === undefined) throw new Error("Reconciled bootstrap omitted the active project");
		const reconciledEngine = reconciledWorkspace.engine;
		if (typeof reconciledEngine !== "object" || reconciledEngine === null || Array.isArray(reconciledEngine)) {
			throw new Error("Reconciled bootstrap omitted its engine snapshot");
		}
		equal((reconciledEngine as Record<string, unknown>).phase, "ready");
		equal(reconciledWorkspace.pendingPermission, null);
		equal(reconciledWorkspace.engineGeneration, null);
		equal(reconciledWorkspace.activeTurnId, null);

		const firstTranscriptPath = transcriptPaths[0];
		if (firstTranscriptPath === undefined) throw new Error("The first ACP child was not launched");
		const transcript = await readTextFileEventually(
			firstTranscriptPath,
			"the disconnected owner's retired ACP child transcript",
		);
		const outbound = transcript.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		const permissionResponseIndex = outbound.findIndex((message) =>
			message.id === "fixture-permission-1" && Object.hasOwn(message, "result")
		);
		const cancelIndex = outbound.findIndex((message) => message.method === "session/cancel");
		ok(permissionResponseIndex >= 0, "disconnect did not settle the fixture permission");
		ok(cancelIndex > permissionResponseIndex, "the prompt was not canceled after permission settlement");
		deepStrictEqual(outbound[permissionResponseIndex]?.result, { outcome: { outcome: "cancelled" } });
		equal(Object.hasOwn(outbound[cancelIndex] ?? {}, "id"), false);

		successor = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		const successorEvents: ServerEvent[] = [await successor.readEvent()];
		await sendCommand(successor, "request-after-permission-disconnect", "turn.start", {
			projectId,
			prompt: "Start after the disconnected permission owner was retired",
		});
		const successorStarting = await successor.readEvent();
		successorEvents.push(successorStarting);
		if (successorStarting.kind !== "engine.state") {
			throw new Error(`Unexpected successor event after coherent bootstrap: ${successorStarting.kind}`);
		}
		const throughStarted = await collectThrough(successor, "turn.started");
		successorEvents.push(...throughStarted);
		const successorStarted = throughStarted.at(-1);
		if (successorStarted?.kind !== "turn.started") {
			throw new Error("Coherent bootstrap did not release the global engine slot");
		}
		equal(launchedRoots.length, 2);

		await sendCommand(successor, "request-successor-cancel-real", "turn.cancel", {
			projectId,
			turnId: successorStarted.turnId,
		});
		successorEvents.push(...await collectThrough(successor, "turn.terminal"));
		const successorTerminal = successorEvents.at(-1);
		if (successorTerminal?.kind !== "turn.terminal") throw new Error("The successor turn did not retire");
		equal(successorTerminal.payload.outcome, "canceled");
		assertContiguous(successorEvents, running.workspaceInstanceId);

		await successor.closeGracefully();
		successor = undefined;
	} finally {
		owner?.closeAbruptly();
		successor?.closeAbruptly();
		await fixture?.close();
		await Deno.remove(observationRoot, { recursive: true });
	}
});

Deno.test("WebSocket closes malformed and oversized client frames with protocol-specific codes", async () => {
	const fixture = await startFixture();
	let malformedSocket: RawWebSocket | undefined;
	let longInvalidSocket: RawWebSocket | undefined;
	let oversizedSocket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		malformedSocket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await malformedSocket.readEvent()).kind, "connection.ready");
		await malformedSocket.sendText("{not-json");
		const protocolError = await malformedSocket.readEvent();
		if (protocolError.kind !== "protocol.error") throw new Error("Malformed JSON did not produce protocol.error");
		equal(protocolError.sequence, 2);
		equal(protocolError.terminal, true);
		equal(protocolError.payload.code, "invalid-frame");
		match(protocolError.payload.message, /valid JSON/u);
		const malformedClose = await malformedSocket.readClose();
		equal(malformedClose.code, 1002);
		equal(malformedClose.reason, "Invalid Workbench client protocol frame");
		malformedSocket.closeAbruptly();
		malformedSocket = undefined;

		longInvalidSocket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await longInvalidSocket.readEvent()).kind, "connection.ready");
		await longInvalidSocket.sendText(JSON.stringify({
			protocolVersion: PROTOCOL_VERSION,
			requestId: "request-long-invalid",
			kind: "project.select",
			payload: { projectId: "project-atlas-0001" },
			[`attacker-${"x".repeat(400)}`]: true,
		}));
		const longProtocolError = await longInvalidSocket.readEvent();
		if (longProtocolError.kind !== "protocol.error") throw new Error("Invalid shape did not produce protocol.error");
		equal(longProtocolError.payload.code, "invalid-frame");
		const longInvalidClose = await longInvalidSocket.readClose();
		equal(longInvalidClose.code, 1002);
		equal(longInvalidClose.reason, "Invalid Workbench client protocol frame");
		ok(encoder.encode(longInvalidClose.reason).byteLength <= 123);
		longInvalidSocket.closeAbruptly();
		longInvalidSocket = undefined;

		oversizedSocket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await oversizedSocket.readEvent()).kind, "connection.ready");
		await oversizedSocket.sendText("x".repeat(MAX_CLIENT_FRAME_BYTES + 1));
		const oversizedClose = await oversizedSocket.readClose();
		equal(oversizedClose.code, 1009);
		match(oversizedClose.reason, /exceeded 16 KiB/u);
		oversizedSocket.closeAbruptly();
		oversizedSocket = undefined;
	} finally {
		malformedSocket?.closeAbruptly();
		longInvalidSocket?.closeAbruptly();
		oversizedSocket?.closeAbruptly();
		await fixture.close();
	}
});

Deno.test("active turns block project and engine selection until cancel releases the global slot", async () => {
	const fixture = await startFixture(1_000);
	let owner: RawWebSocket | undefined;
	let contender: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		const projectId = bootstrap.selectedProjectId;
		if (typeof projectId !== "string") throw new Error("Bootstrap did not select a project");
		if (!Array.isArray(bootstrap.projects)) throw new Error("Bootstrap did not return project workspaces");
		const otherProject = bootstrap.projects
			.map((value) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
				const project = (value as Record<string, unknown>).project;
				if (typeof project !== "object" || project === null || Array.isArray(project)) return undefined;
				return (project as Record<string, unknown>).id;
			})
			.find((value): value is string => typeof value === "string" && value !== projectId);
		if (otherProject === undefined) throw new Error("Bootstrap did not return a second project");

		owner = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		contender = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		const ownerEvents: ServerEvent[] = [await owner.readEvent()];
		const contenderEvents: ServerEvent[] = [await contender.readEvent()];

		await sendCommand(owner, "request-owner-start", "turn.start", {
			projectId,
			prompt: "Hold the global engine slot",
			fakeScenario: "complete",
		});
		ownerEvents.push(...await collectThrough(owner, "turn.started"));
		const ownerStarted = ownerEvents.at(-1);
		if (ownerStarted?.kind !== "turn.started") throw new Error("Owner turn did not start");

		await sendCommand(owner, "request-project-select", "project.select", { projectId: otherProject });
		const projectBlocked = await owner.readEvent();
		ownerEvents.push(projectBlocked);
		if (projectBlocked.kind !== "command.error") throw new Error("Project selection was not blocked");
		equal(projectBlocked.payload.code, "conflict");
		equal(projectBlocked.payload.requestId, "request-project-select");
		match(projectBlocked.payload.message, /Cancel the active turn/u);

		await sendCommand(owner, "request-engine-select", "engine.select", { projectId, kind: "clio-acp" });
		const engineBlocked = await owner.readEvent();
		ownerEvents.push(engineBlocked);
		if (engineBlocked.kind !== "command.error") throw new Error("Engine selection was not blocked");
		equal(engineBlocked.payload.code, "conflict");
		equal(engineBlocked.payload.requestId, "request-engine-select");
		match(engineBlocked.payload.message, /Cancel the active turn/u);

		await sendCommand(contender, "request-contender-blocked", "turn.start", {
			projectId: otherProject,
			prompt: "This turn must wait for the global slot",
			fakeScenario: "complete",
		});
		const slotBlocked = await contender.readEvent();
		contenderEvents.push(slotBlocked);
		if (slotBlocked.kind !== "command.error") throw new Error("Concurrent turn was not blocked");
		equal(slotBlocked.payload.code, "conflict");
		equal(slotBlocked.payload.requestId, "request-contender-blocked");

		await sendCommand(owner, "request-owner-cancel", "turn.cancel", {
			projectId,
			turnId: ownerStarted.turnId,
		});
		ownerEvents.push(...await collectThrough(owner, "turn.terminal"));
		const ownerTerminal = ownerEvents.at(-1);
		if (ownerTerminal?.kind !== "turn.terminal") throw new Error("Owner turn did not cancel");
		equal(ownerTerminal.payload.outcome, "canceled");
		equal(ownerTerminal.payload.code, "fake-cancelled");

		await sendCommand(contender, "request-contender-start", "turn.start", {
			projectId: otherProject,
			prompt: "Use the released global engine slot",
			fakeScenario: "complete",
		});
		contenderEvents.push(...await collectThrough(contender, "turn.started"));
		const contenderStarted = contenderEvents.at(-1);
		if (contenderStarted?.kind !== "turn.started") throw new Error("Cancel did not release the global slot");
		equal(contenderStarted.projectId, otherProject);

		await sendCommand(contender, "request-contender-cancel", "turn.cancel", {
			projectId: otherProject,
			turnId: contenderStarted.turnId,
		});
		contenderEvents.push(...await collectThrough(contender, "turn.terminal"));
		assertContiguous(ownerEvents, running.workspaceInstanceId);
		assertContiguous(contenderEvents, running.workspaceInstanceId);

		await owner.closeGracefully();
		owner = undefined;
		await contender.closeGracefully();
		contender = undefined;
	} finally {
		owner?.closeAbruptly();
		contender?.closeAbruptly();
		await fixture.close();
	}
});

Deno.test("disconnecting a turn owner releases the global engine slot for another socket", async () => {
	const fixture = await startFixture(1_000);
	let owner: RawWebSocket | undefined;
	let successor: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		const projectId = bootstrap.selectedProjectId;
		if (typeof projectId !== "string") throw new Error("Bootstrap did not select a project");

		owner = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		successor = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await owner.readEvent()).kind, "connection.ready");
		const successorEvents: ServerEvent[] = [await successor.readEvent()];

		await sendCommand(owner, "request-owner-start", "turn.start", {
			projectId,
			prompt: "Start a turn whose owner will disconnect",
			fakeScenario: "complete",
		});
		const ownerStarted = (await collectThrough(owner, "turn.started")).at(-1);
		if (ownerStarted?.kind !== "turn.started") throw new Error("Owner turn did not start");
		owner.closeAbruptly();
		owner = undefined;

		let successorStarted: ServerEvent | undefined;
		for (let attempt = 0; attempt < 50 && successorStarted === undefined; attempt += 1) {
			await sendCommand(successor, `request-successor-${attempt}`, "turn.start", {
				projectId,
				prompt: "Start after disconnected-owner cleanup",
				fakeScenario: "complete",
			});
			const response: ServerEvent = await successor.readEvent();
			successorEvents.push(response);
			if (response.kind === "command.error") {
				equal(response.payload.code, "conflict");
				await delay(10);
				continue;
			}
			if (response.kind !== "engine.state") throw new Error(`Unexpected successor event: ${response.kind}`);
			const started = await successor.readEvent();
			successorEvents.push(started);
			if (started.kind !== "turn.started") throw new Error(`Unexpected successor event: ${started.kind}`);
			successorStarted = started;
		}
		if (successorStarted?.kind !== "turn.started") {
			throw new Error("The disconnected owner did not release the global engine slot");
		}

		await sendCommand(successor, "request-successor-cancel", "turn.cancel", {
			projectId,
			turnId: successorStarted.turnId,
		});
		successorEvents.push(...await collectThrough(successor, "turn.terminal"));
		const terminal = successorEvents.at(-1);
		if (terminal?.kind !== "turn.terminal") throw new Error("Successor turn did not cancel");
		equal(terminal.payload.outcome, "canceled");
		assertContiguous(successorEvents, running.workspaceInstanceId);

		await successor.closeGracefully();
		successor = undefined;
	} finally {
		owner?.closeAbruptly();
		successor?.closeAbruptly();
		await fixture.close();
	}
});
