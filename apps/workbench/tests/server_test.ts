import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ClioLauncher, HostError } from "../clio-host.ts";
import type { AcpLaunchSpec } from "../acp-client.ts";
import type { ClioCatalogInspector } from "../clio-catalog-inspector.ts";
import type { ClioConfigInspector } from "../clio-config-inspector.ts";
import type { ClioDispatchInspector } from "../clio-dispatch-inspector.ts";
import type { ClioUsageInspector } from "../clio-usage-inspector.ts";
import type { ClioRoutingInspector } from "../clio-routing-inspector.ts";
import {
	defaultClioLauncher,
	MAX_WEBSOCKET_OUTBOUND_BYTES,
	type RunningWorkbenchServer,
	startWorkbenchServer,
	wouldExceedWebSocketHighWaterMark,
} from "../main.ts";
import {
	MAX_CLIENT_FRAME_BYTES,
	parseServerEvent,
	PROTOCOL_VERSION,
	type ServerEvent,
	type WireCatalogInspection,
	type WireConfigInspection,
	type WireDispatchInspection,
	type WireRoutingInspection,
	type WireUsageInspection,
} from "../src/protocol.ts";
import {
	catalogInspectionFixture,
	dispatchInspectionFixture,
	routingInspectionFixture,
	usageInspectionFixture,
} from "./fixtures.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INDEX_HTML =
	"<!doctype html><html><head><title>Workbench server fixture</title></head><body>fixture</body></html>";
const ASSET_JAVASCRIPT = "globalThis.__workbenchServerFixture = true;\n";
const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const ACP_CHILD_FIXTURE = fileURLToPath(new URL("./acp-child-fixture.ts", import.meta.url));
interface ServerFixture {
	readonly running: RunningWorkbenchServer;
	readonly temporaryRoot: string;
	readonly projectRoot: string;
	readonly pidPath: string;
	readonly stateDir: string;
	readonly homePath: string;
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

/** Launches the deterministic ACP child instead of a real `clio-coder acp`. */
function fixtureLauncher(scenario: string, pidPath?: string): ClioLauncher {
	return {
		launch(trustedRoot: string): AcpLaunchSpec {
			return {
				command: Deno.execPath(),
				args: [
					"run",
					"--quiet",
					"--no-config",
					...(pidPath === undefined ? [] : [`--allow-write=${pidPath}`]),
					ACP_CHILD_FIXTURE,
					`--scenario=${scenario}`,
					...(pidPath === undefined ? [] : [`--pid-file=${pidPath}`]),
				],
				cwd: trustedRoot,
				clearEnv: true,
				terminationScope: Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
				redact: [trustedRoot],
			};
		},
	};
}

interface FixtureOptions {
	readonly scenario?: string;
	/** Records the ACP child's pid so a test can prove it is the only one. */
	readonly pidFile?: boolean;
	readonly clioLauncher?: ClioLauncher;
	readonly configInspector?: ClioConfigInspector;
	readonly catalogInspector?: ClioCatalogInspector;
	readonly usageInspector?: ClioUsageInspector;
	readonly routingInspector?: ClioRoutingInspector;
	readonly dispatchInspector?: ClioDispatchInspector;
	readonly disconnectGraceMs?: number;
	readonly permissionEscalateMs?: number;
	readonly permissionBudgetMs?: number;
}

async function startFixture(options: FixtureOptions = {}): Promise<ServerFixture> {
	const temporaryRoot = await Deno.makeTempDir({ prefix: "workbench-server-test-" });
	const distRoot = join(temporaryRoot, "dist");
	const homePath = join(temporaryRoot, "home");
	const stateDir = join(temporaryRoot, "state");
	const projectRoot = join(homePath, "code", "alpha");
	const pidPath = join(temporaryRoot, "child.pid");
	try {
		await Deno.mkdir(join(distRoot, "assets"), { recursive: true });
		await Deno.mkdir(projectRoot, { recursive: true });
		await Deno.writeTextFile(join(projectRoot, "notes.txt"), "fixture note\n");
		await Promise.all([
			Deno.writeTextFile(join(distRoot, "index.html"), INDEX_HTML),
			Deno.writeTextFile(join(distRoot, "assets", "fixture.js"), ASSET_JAVASCRIPT),
		]);
		const running = await startWorkbenchServer({
			distRoot: pathToFileURL(`${distRoot}/`),
			stateDir,
			homePath,
			mode: "browser",
			port: 0,
			quiet: true,
			acpTiming: {
				permissionTimeoutMs: 60_000,
				cancelGraceMs: 300,
				closeTimeoutMs: 300,
				exitGraceMs: 300,
				termGraceMs: 150,
			},
			clioLauncher: options.clioLauncher ??
				fixtureLauncher(options.scenario ?? "happy", options.pidFile === true ? pidPath : undefined),
			...(options.configInspector === undefined ? {} : { configInspector: options.configInspector }),
			...(options.catalogInspector === undefined ? {} : { catalogInspector: options.catalogInspector }),
			...(options.usageInspector === undefined ? {} : { usageInspector: options.usageInspector }),
			...(options.routingInspector === undefined ? {} : { routingInspector: options.routingInspector }),
			...(options.dispatchInspector === undefined ? {} : { dispatchInspector: options.dispatchInspector }),
			...(options.disconnectGraceMs === undefined ? {} : { disconnectGraceMs: options.disconnectGraceMs }),
			...(options.permissionEscalateMs === undefined ? {} : { permissionEscalateMs: options.permissionEscalateMs }),
			...(options.permissionBudgetMs === undefined ? {} : { permissionBudgetMs: options.permissionBudgetMs }),
		});
		return {
			running,
			temporaryRoot,
			projectRoot,
			pidPath,
			stateDir,
			homePath,
			async close() {
				try {
					await running.close();
				} finally {
					await Deno.remove(temporaryRoot, { recursive: true }).catch(() => undefined);
				}
			},
		};
	} catch (error) {
		await Deno.remove(temporaryRoot, { recursive: true }).catch(() => undefined);
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
	for (let index = 0; index < 128; index += 1) {
		const event = await socket.readEvent();
		events.push(event);
		if (event.kind === terminalKind) return events;
	}
	throw new Error(`Did not receive ${terminalKind} within 128 server events`);
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

function configInspectionFixture(): WireConfigInspection {
	return {
		inspectedAt: "2026-08-29T12:00:00.000Z",
		settings: [{ key: "orchestrator.model", source: "project", value: "fixture-model", valueKind: "exact" }],
		settingsTruncated: false,
		entries: [{
			category: "clio-md",
			id: "CLIO-CODER.md",
			scope: "project",
			sourcePath: { segments: ["CLIO-CODER.md"] },
			trust: "trusted",
			precedence: "single",
			reloadClass: "next-turn",
			contextCostTokens: 42,
			facts: [{ label: "Preload", value: "included" }],
		}],
		entriesTruncated: false,
		issueCounts: [],
		issuesTruncated: false,
	};
}

Deno.test("outbound WebSocket high-water accounting includes the next UTF-8 frame at the exact boundary", () => {
	equal(wouldExceedWebSocketHighWaterMark(MAX_WEBSOCKET_OUTBOUND_BYTES - 1, 1), false);
	equal(wouldExceedWebSocketHighWaterMark(MAX_WEBSOCKET_OUTBOUND_BYTES, 0), false);
	equal(wouldExceedWebSocketHighWaterMark(MAX_WEBSOCKET_OUTBOUND_BYTES, encoder.encode("x").byteLength), true);
	equal(wouldExceedWebSocketHighWaterMark(MAX_WEBSOCKET_OUTBOUND_BYTES - 3, encoder.encode("😀").byteLength), true);
	equal(wouldExceedWebSocketHighWaterMark(-1, 1), true);
});

Deno.test("startWorkbenchServer serves a v3 bootstrap and static assets with bounded HTTP behavior", async () => {
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
		equal(bootstrap.appName, "Clio Coder");
		equal(bootstrap.workspaceInstanceId, running.workspaceInstanceId);
		equal(bootstrap.localToken, running.token);
		equal(bootstrap.mode, "browser");
		equal(bootstrap.openProjectId, null);
		equal(bootstrap.workspace, null);
		deepStrictEqual(bootstrap.recent, []);
		equal(bootstrap.homePath, await Deno.realPath(fixture.homePath));
		match(String(bootstrap.stateDirNote), /recent-project list/u);
		match(String(bootstrap.securityNote), /Deno's file grants are broad/u);
		for (
			const removed of ["projects", "selectedProjectId", "fakeEngine", "sandboxLabel", "registerableSandboxFolders"]
		) {
			equal(Object.hasOwn(bootstrap, removed), false, `${removed} must be gone`);
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
		equal(await headResponse.text(), "");

		const fallbackResponse = await fetch(new URL("/projects/alpha", running.url), { headers: { accept: "text/html" } });
		equal(fallbackResponse.status, 200);
		equal(await fallbackResponse.text(), INDEX_HTML);

		const traversalResponse = await fetch(`${running.url}/safe/%2e%2e%2fsecret.txt`);
		equal(traversalResponse.status, 400);
		equal(await traversalResponse.text(), "Invalid asset path");

		const missingResponse = await fetch(new URL("/missing.js", running.url), { headers: { accept: "text/html" } });
		equal(missingResponse.status, 404);
		equal(await missingResponse.text(), "Asset not found");

		const methodResponse = await fetch(new URL("/api/bootstrap", running.url), { method: "POST" });
		equal(methodResponse.status, 405);
		equal(await methodResponse.text(), "Method not allowed");

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
		for (
			const attackPath of [
				"/file:///etc/passwd",
				`/${outsideUrl}`,
				`/${outsideUrl.replace(/^file:/u, "file%3A").replaceAll("/", "%2F")}`,
				"/FiLe:%2F%2F%2Fetc%2Fpasswd",
			]
		) {
			const response = await fetch(`${running.url}${attackPath}`);
			equal(response.status, 400, attackPath);
			equal(await response.text(), "Invalid asset path", attackPath);
			assertSecurityHeaders(response.headers);
		}
		const assetResponse = await fetch(new URL("/assets/fixture.js", running.url));
		equal(assetResponse.status, 200);
		equal(await assetResponse.text(), ASSET_JAVASCRIPT);
	} finally {
		await fixture.close();
	}
});

Deno.test("the native Windows launcher remains unavailable without an explicit WSL mapping", () => {
	const launcher = defaultClioLauncher("windows");
	throws(
		() => launcher.launch("C:\\bounded-project"),
		(error: unknown) =>
			error instanceof HostError && error.code === "not-ready" && /explicit WSL configuration/iu.test(error.message),
	);
});

Deno.test("an authenticated socket opens a real project and drives one contiguous conversation", async () => {
	const fixture = await startFixture({ scenario: "permission" });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		equal(await upgradeStatus(eventsEndpoint(running), "http://127.0.0.1:1"), 403);
		equal(await upgradeStatus(eventsEndpoint(running)), 403);
		equal(await upgradeStatus(eventsEndpoint(running, `${running.token}-wrong`), running.url), 403);

		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		const ready = await socket.readEvent();
		equal(ready.kind, "connection.ready");

		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const opened = await collectThrough(socket, "project.opened");
		const openedEvent = opened.at(-1);
		ok(openedEvent?.kind === "project.opened");
		const workspace = openedEvent.payload.workspace;
		const projectId = workspace.project.id;
		equal(workspace.project.rootPath, await Deno.realPath(fixture.projectRoot));
		equal(workspace.project.available, true);
		ok(workspace.tree.some((node) => node.name === "notes.txt"));

		await sendCommand(socket, "request-turn", "turn.start", { projectId, prompt: "Exercise mediated permission." });
		const untilPermission = await collectThrough(socket, "turn.permission.requested");
		const permission = untilPermission.at(-1);
		ok(permission?.kind === "turn.permission.requested");
		const turnId = permission.turnId;
		ok(turnId);
		await sendCommand(socket, "request-allow", "permission.resolve", {
			projectId,
			turnId,
			permissionId: permission.payload.permissionId,
			decision: "allow-once",
		});
		const untilTerminal = await collectThrough(socket, "turn.terminal");
		const terminal = untilTerminal.at(-1);
		ok(terminal?.kind === "turn.terminal");
		equal(terminal.payload.outcome, "completed");

		const all = [ready, ...opened, ...untilPermission, ...untilTerminal];
		assertContiguous(all, running.workspaceInstanceId);
		const projection = JSON.stringify(all);
		ok(!projection.includes("fixture-session-1"));
		ok(!projection.includes("fixture-permission-1"));
		ok(!projection.includes("rawInput"));
		// The project's own root is the one native path that crosses; nothing else
		// carries it, and no turn event does.
		const turnEvents = all.filter((event) => event.kind.startsWith("turn."));
		ok(turnEvents.length > 0);
		ok(!JSON.stringify(turnEvents).includes(fixture.projectRoot));
		ok(!JSON.stringify(turnEvents).includes(fixture.homePath));

		// A browser reload restores the same conversation from host-held state.
		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		equal(bootstrap.openProjectId, projectId);
		const restored = bootstrap.workspace as Record<string, unknown>;
		const timeline = restored.timeline as Array<Record<string, unknown>>;
		ok(timeline.length >= 3);
		ok(timeline.some((item) => item.kind === "request"));
		ok(timeline.some((item) => item.kind === "approval"));
		ok(timeline.some((item) => item.kind === "outcome"));
		equal(restored.pendingPermission, null);
		equal(restored.activeTurn, null);
		deepStrictEqual((bootstrap.recent as Array<Record<string, unknown>>).map((entry) => entry.id), [projectId]);
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("configuration inspection is cached but never blocks the live ACP control lane", async () => {
	let markStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	let releaseInspection: (() => void) | undefined;
	const released = new Promise<void>((resolve) => {
		releaseInspection = resolve;
	});
	let inspectedRoot: string | null = null;
	const configInspector: ClioConfigInspector = {
		async inspect(trustedRoot) {
			inspectedRoot = trustedRoot;
			markStarted?.();
			await released;
			return configInspectionFixture();
		},
	};
	const fixture = await startFixture({ scenario: "permission", configInspector });
	let socket: RawWebSocket | undefined;
	try {
		socket = await RawWebSocket.connect(eventsEndpoint(fixture.running), fixture.running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const opened = (await collectThrough(socket, "project.opened")).at(-1);
		ok(opened?.kind === "project.opened");
		const projectId = opened.payload.workspace.project.id;
		equal(opened.payload.workspace.configInspection, null);

		await sendCommand(socket, "request-config", "config.inspect", { projectId });
		await started;
		equal(inspectedRoot, await Deno.realPath(fixture.projectRoot));

		// The read process is still parked, yet turn and permission commands run
		// to completion on the independent primary control lane.
		await sendCommand(socket, "request-turn", "turn.start", { projectId, prompt: "Do not wait for the config map." });
		const permission = (await collectThrough(socket, "turn.permission.requested")).at(-1);
		ok(permission?.kind === "turn.permission.requested" && permission.turnId !== undefined);
		await sendCommand(socket, "request-allow", "permission.resolve", {
			projectId,
			turnId: permission.turnId,
			permissionId: permission.payload.permissionId,
			decision: "allow-once",
		});
		const terminal = (await collectThrough(socket, "turn.terminal")).at(-1);
		ok(terminal?.kind === "turn.terminal");
		equal(terminal.payload.outcome, "completed");

		releaseInspection?.();
		const config = (await collectThrough(socket, "config.state")).at(-1);
		ok(config?.kind === "config.state");
		deepStrictEqual(config.payload.inspection, configInspectionFixture());

		const bootstrap = await (await fetch(new URL("/api/bootstrap", fixture.running.url))).json() as {
			workspace: { configInspection: WireConfigInspection };
		};
		deepStrictEqual(bootstrap.workspace.configInspection, configInspectionFixture());
	} finally {
		releaseInspection?.();
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("resource catalog inspection uses the trusted root, broadcasts the typed snapshot, and caches it", async () => {
	let inspectedRoot: string | null = null;
	const catalogInspector: ClioCatalogInspector = {
		inspect(trustedRoot) {
			inspectedRoot = trustedRoot;
			return Promise.resolve(catalogInspectionFixture());
		},
	};
	const fixture = await startFixture({ catalogInspector });
	let socket: RawWebSocket | undefined;
	try {
		socket = await RawWebSocket.connect(eventsEndpoint(fixture.running), fixture.running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const opened = (await collectThrough(socket, "project.opened")).at(-1);
		ok(opened?.kind === "project.opened");
		const projectId = opened.payload.workspace.project.id;
		equal(opened.payload.workspace.catalogInspection, null);

		await sendCommand(socket, "request-catalog", "catalog.inspect", { projectId });
		const catalog = (await collectThrough(socket, "catalog.state")).at(-1);
		ok(catalog?.kind === "catalog.state");
		equal(inspectedRoot, await Deno.realPath(fixture.projectRoot));
		deepStrictEqual(catalog.payload.inspection, catalogInspectionFixture());

		const bootstrap = await (await fetch(new URL("/api/bootstrap", fixture.running.url))).json() as {
			workspace: { catalogInspection: WireCatalogInspection };
		};
		deepStrictEqual(bootstrap.workspace.catalogInspection, catalogInspectionFixture());
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("project usage inspection uses the trusted root, broadcasts the bounded snapshot, and caches it", async () => {
	let inspectedRoot: string | null = null;
	const usageInspector: ClioUsageInspector = {
		inspect(trustedRoot) {
			inspectedRoot = trustedRoot;
			return Promise.resolve(usageInspectionFixture());
		},
	};
	const fixture = await startFixture({ usageInspector });
	let socket: RawWebSocket | undefined;
	try {
		socket = await RawWebSocket.connect(eventsEndpoint(fixture.running), fixture.running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const opened = (await collectThrough(socket, "project.opened")).at(-1);
		ok(opened?.kind === "project.opened");
		const projectId = opened.payload.workspace.project.id;
		equal(opened.payload.workspace.usageInspection, null);

		await sendCommand(socket, "request-usage", "usage.inspect", { projectId });
		const usage = (await collectThrough(socket, "usage.state")).at(-1);
		ok(usage?.kind === "usage.state");
		equal(inspectedRoot, await Deno.realPath(fixture.projectRoot));
		deepStrictEqual(usage.payload.inspection, usageInspectionFixture());

		const bootstrap = await (await fetch(new URL("/api/bootstrap", fixture.running.url))).json() as {
			workspace: { usageInspection: WireUsageInspection };
		};
		deepStrictEqual(bootstrap.workspace.usageInspection, usageInspectionFixture());
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("routing inspection uses the trusted root, broadcasts the bounded snapshot, and caches it", async () => {
	let inspectedRoot: string | null = null;
	const routingInspector: ClioRoutingInspector = {
		inspect(trustedRoot) {
			inspectedRoot = trustedRoot;
			return Promise.resolve(routingInspectionFixture());
		},
	};
	const fixture = await startFixture({ routingInspector });
	let socket: RawWebSocket | undefined;
	try {
		socket = await RawWebSocket.connect(eventsEndpoint(fixture.running), fixture.running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const opened = (await collectThrough(socket, "project.opened")).at(-1);
		ok(opened?.kind === "project.opened");
		const projectId = opened.payload.workspace.project.id;
		equal(opened.payload.workspace.routingInspection, null);

		await sendCommand(socket, "request-routing", "routing.inspect", { projectId });
		const routing = (await collectThrough(socket, "routing.state")).at(-1);
		ok(routing?.kind === "routing.state");
		equal(inspectedRoot, await Deno.realPath(fixture.projectRoot));
		deepStrictEqual(routing.payload.inspection, routingInspectionFixture());

		const bootstrap = await (await fetch(new URL("/api/bootstrap", fixture.running.url))).json() as {
			workspace: { routingInspection: WireRoutingInspection };
		};
		deepStrictEqual(bootstrap.workspace.routingInspection, routingInspectionFixture());
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("dispatch inspection is global, uses the configured home, and survives browser reload", async () => {
	let inspectedCwd: string | null = null;
	const dispatchInspector: ClioDispatchInspector = {
		inspect(cwd) {
			inspectedCwd = cwd;
			return Promise.resolve(dispatchInspectionFixture());
		},
	};
	const fixture = await startFixture({ dispatchInspector });
	let socket: RawWebSocket | undefined;
	try {
		socket = await RawWebSocket.connect(eventsEndpoint(fixture.running), fixture.running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-dispatch", "dispatch.inspect", {});
		const dispatch = (await collectThrough(socket, "dispatch.state")).at(-1);
		ok(dispatch?.kind === "dispatch.state");
		equal(dispatch.projectId, undefined);
		equal(inspectedCwd, fixture.homePath);
		deepStrictEqual(dispatch.payload.inspection, dispatchInspectionFixture());

		const bootstrap = await (await fetch(new URL("/api/bootstrap", fixture.running.url))).json() as {
			dispatchInspection: WireDispatchInspection;
		};
		deepStrictEqual(bootstrap.dispatchInspection, dispatchInspectionFixture());
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("a guarded or missing folder is refused with a reason and nothing is opened", async () => {
	const fixture = await startFixture();
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");

		const refusable = [fixture.homePath, join(fixture.homePath, ".config"), join(fixture.homePath, "absent"), "/"];
		for (const [index, path] of refusable.entries()) {
			await sendCommand(socket, `request-refused-${index}`, "project.open", { path });
			const error = await socket.readEvent();
			ok(error.kind === "command.error", `expected a refusal for ${path}, received ${JSON.stringify(error)}`);
			equal(error.payload.code, "refused");
			ok(error.payload.message.length > 0);
		}

		await sendCommand(socket, "request-unknown", "session.new", { projectId: "project-missing-0001" });
		const missing = await socket.readEvent();
		ok(missing.kind === "command.error");
		equal(missing.payload.code, "not-found");

		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		equal(bootstrap.openProjectId, null);
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("the browser directory picker lists folders only and flags what cannot be opened", async () => {
	const fixture = await startFixture();
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		await Deno.mkdir(join(fixture.homePath, ".config"), { recursive: true });
		await Deno.writeTextFile(join(fixture.homePath, "loose.txt"), "never listed");
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");

		await sendCommand(socket, "request-browse", "project.browse", {});
		const listing = await socket.readEvent();
		ok(listing.kind === "project.browse.listing");
		equal(listing.payload.openable, false);
		ok(listing.payload.reason?.includes("home directory"));
		deepStrictEqual(listing.payload.entries.map((entry) => entry.name).sort(), [".config", "code"]);
		equal(listing.payload.entries.find((entry) => entry.name === ".config")?.guarded, true);
		ok(!JSON.stringify(listing).includes("loose.txt"));
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("a second prompt during an active turn is refused without disturbing the first", async () => {
	const fixture = await startFixture({ scenario: "hang" });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const opened = await collectThrough(socket, "project.opened");
		const openedEvent = opened.at(-1);
		ok(openedEvent?.kind === "project.opened");
		const projectId = openedEvent.payload.workspace.project.id;

		await sendCommand(socket, "request-first", "turn.start", { projectId, prompt: "Park until canceled." });
		const started = await collectThrough(socket, "turn.started");
		const startedEvent = started.at(-1);
		ok(startedEvent?.kind === "turn.started");
		const turnId = startedEvent.turnId;
		ok(turnId);

		await sendCommand(socket, "request-second", "turn.start", { projectId, prompt: "Compete for the prompt." });
		const conflict = await collectThrough(socket, "command.error");
		const conflictEvent = conflict.at(-1);
		ok(conflictEvent?.kind === "command.error");
		equal(conflictEvent.payload.code, "conflict");
		equal(conflictEvent.payload.message, "Clio is still working on the previous prompt. Cancel it or wait.");
		equal(conflictEvent.payload.requestId, "request-second");

		await sendCommand(socket, "request-cancel", "turn.cancel", { projectId, turnId });
		const terminal = (await collectThrough(socket, "turn.terminal")).at(-1);
		ok(terminal?.kind === "turn.terminal");
		equal(terminal.payload.outcome, "canceled");
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("the last socket closing during a turn stops it after the grace window, never as a denial", async () => {
	const fixture = await startFixture({ scenario: "permission", disconnectGraceMs: 50 });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const openedEvent = (await collectThrough(socket, "project.opened")).at(-1);
		ok(openedEvent?.kind === "project.opened");
		const projectId = openedEvent.payload.workspace.project.id;
		await sendCommand(socket, "request-turn", "turn.start", { projectId, prompt: "Disconnect at permission." });
		await collectThrough(socket, "turn.permission.requested");
		socket.closeAbruptly();
		socket = undefined;

		// A new socket receives the full snapshot, so the outcome is observable.
		await delay(400);
		const observer = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		try {
			equal((await observer.readEvent()).kind, "connection.ready");
			const snapshot = await observer.readEvent();
			ok(snapshot.kind === "project.opened");
			const workspace = snapshot.payload.workspace;
			equal(workspace.pendingPermission, null);
			equal(workspace.activeTurn, null);
			const approval = workspace.timeline.find((item) => item.kind === "approval");
			ok(approval);
			ok(approval.summary.includes("Clio was not told no"));
			const outcome = workspace.timeline.find((item) => item.kind === "outcome" || item.kind === "failure");
			ok(outcome);
			ok(outcome.detail === "client-disconnected" || outcome.summary.includes("window went away"));
		} finally {
			await observer.closeGracefully().catch(() => observer.closeAbruptly());
		}
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("a reconnecting socket cancels the grace window and keeps the child alive", async () => {
	const fixture = await startFixture({ scenario: "hang", disconnectGraceMs: 400 });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const openedEvent = (await collectThrough(socket, "project.opened")).at(-1);
		ok(openedEvent?.kind === "project.opened");
		const projectId = openedEvent.payload.workspace.project.id;
		await sendCommand(socket, "request-turn", "turn.start", { projectId, prompt: "Park until canceled." });
		const startedEvent = (await collectThrough(socket, "turn.started")).at(-1);
		ok(startedEvent?.kind === "turn.started");
		const turnId = startedEvent.turnId;
		ok(turnId);
		socket.closeAbruptly();
		socket = undefined;

		const reconnected = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		try {
			equal((await reconnected.readEvent()).kind, "connection.ready");
			const snapshot = await reconnected.readEvent();
			ok(snapshot.kind === "project.opened");
			equal(snapshot.payload.workspace.activeTurn?.turnId, turnId);
			await delay(600);
			await sendCommand(reconnected, "request-cancel", "turn.cancel", { projectId, turnId });
			const terminal = (await collectThrough(reconnected, "turn.terminal")).at(-1);
			ok(terminal?.kind === "turn.terminal");
			equal(terminal.payload.code, "operator-cancelled");
		} finally {
			await reconnected.closeGracefully().catch(() => reconnected.closeAbruptly());
		}
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("malformed and oversized client frames close the socket with protocol-specific codes", async () => {
	const fixture = await startFixture();
	try {
		const { running } = fixture;
		const malformed = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await malformed.readEvent()).kind, "connection.ready");
		await malformed.sendText("{not json");
		const malformedError = await malformed.readEvent();
		ok(malformedError.kind === "protocol.error");
		equal(malformedError.payload.code, "invalid-frame");
		const malformedClose = await malformed.readClose();
		equal(malformedClose.code, 1002);
		malformed.closeAbruptly();

		const oversized = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await oversized.readEvent()).kind, "connection.ready");
		await oversized.sendText(JSON.stringify({
			protocolVersion: PROTOCOL_VERSION,
			requestId: "request-oversized",
			kind: "turn.start",
			payload: { projectId: "project-alpha", prompt: "x".repeat(MAX_CLIENT_FRAME_BYTES) },
		}));
		const oversizedClose = await oversized.readClose();
		equal(oversizedClose.code, 1009);
		oversized.closeAbruptly();
	} finally {
		await fixture.close();
	}
});

Deno.test("closing the server retires the child and leaves no project open", async () => {
	const fixture = await startFixture({ scenario: "hang" });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const openedEvent = (await collectThrough(socket, "project.opened")).at(-1);
		ok(openedEvent?.kind === "project.opened");
		await sendCommand(socket, "request-turn", "turn.start", {
			projectId: openedEvent.payload.workspace.project.id,
			prompt: "Park until shutdown.",
		});
		await collectThrough(socket, "turn.started");
		socket.closeAbruptly();
		socket = undefined;
		const closed = await Promise.race([running.close().then(() => true), delay(10_000).then(() => false)]);
		equal(closed, true);
		await rejects(fetch(new URL("/api/bootstrap", running.url)));
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await Deno.remove(fixture.temporaryRoot, { recursive: true }).catch(() => undefined);
	}
});

Deno.test("three prompts share one session and the third sees the first two", async () => {
	const fixture = await startFixture({ scenario: "conversation" });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const openedEvent = (await collectThrough(socket, "project.opened")).at(-1);
		ok(openedEvent?.kind === "project.opened");
		const projectId = openedEvent.payload.workspace.project.id;
		const sessionId = openedEvent.payload.workspace.clio.session?.id;
		ok(sessionId === undefined || typeof sessionId === "string");

		const answers: string[] = [];
		const turnIds: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			await sendCommand(socket, `request-turn-${index}`, "turn.start", {
				projectId,
				prompt: `Prompt number ${index + 1}.`,
			});
			const events = await collectThrough(socket, "turn.terminal");
			const text = events.filter((event) => event.kind === "turn.text").map((event) =>
				event.kind === "turn.text" ? event.payload.text : ""
			).join("");
			answers.push(text);
			const terminal = events.at(-1);
			ok(terminal?.kind === "turn.terminal");
			ok(terminal.turnId);
			turnIds.push(terminal.turnId);
			equal(terminal.payload.outcome, "completed");
		}
		deepStrictEqual(answers, [
			"This session has seen 1 prompts.",
			"This session has seen 2 prompts.",
			"This session has seen 3 prompts.",
		]);
		deepStrictEqual(turnIds, ["turn-1", "turn-2", "turn-3"]);

		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		const workspace = bootstrap.workspace as Record<string, unknown>;
		const timeline = workspace.timeline as Array<Record<string, unknown>>;
		equal(timeline.filter((item) => item.kind === "request").length, 3);
		ok(timeline.every((item) => item.origin === "live"));
		const session = (workspace.clio as Record<string, unknown>).session as Record<string, unknown>;
		equal(session.target, "lmstudio");
		equal(session.model, "qwen3.8-27b");
		equal(session.resumed, false);
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("closing and reopening a session replays the branch Clio will extend", async () => {
	const fixture = await startFixture({ scenario: "resume" });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const openedEvent = (await collectThrough(socket, "project.opened")).at(-1);
		ok(openedEvent?.kind === "project.opened");
		const projectId = openedEvent.payload.workspace.project.id;
		const earlier = openedEvent.payload.workspace.sessions.find((session) => !session.hosted);
		ok(earlier, "the fixture must offer an earlier session to resume");
		equal(earlier.state, "closed");

		// Opening a project binds no session, so the load runs on the fresh child.
		await sendCommand(socket, "request-load", "session.load", { projectId, sessionId: earlier.id });

		// Every replayed frame must precede the bound-session state that announces the load.
		const replayed: string[] = [];
		let boundIndex = -1;
		for (let index = 0; index < 64 && boundIndex < 0; index += 1) {
			const event = await socket.readEvent();
			if (event.kind.startsWith("turn.")) replayed.push(event.kind);
			if (event.kind === "clio.state" && event.payload.snapshot.session?.resumed === true) boundIndex = index;
		}
		ok(boundIndex >= 0, "the resumed session state never arrived");
		deepStrictEqual(replayed, [
			"turn.started",
			"turn.text",
			"turn.tool",
			"turn.tool",
			"turn.started",
			"turn.text",
			"turn.tool",
		]);

		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		const workspace = bootstrap.workspace as Record<string, unknown>;
		const session = (workspace.clio as Record<string, unknown>).session as Record<string, unknown>;
		equal(session.id, earlier.id);
		equal(session.resumed, true);
		equal(session.replayedTurns, 2);
		equal(session.replayTruncated, false);
		const timeline = workspace.timeline as Array<Record<string, unknown>>;
		ok(timeline.length > 0);
		ok(timeline.every((item) => item.origin === "replay"), "every restored card must be marked as history");
		ok(timeline.every((item) => item.startedAt === null), "replayed cards must not claim a historical clock");
		ok(
			timeline.every((item) => item.source === "replayed-from-clio"),
			"replayed cards must name replay as their source",
		);
		ok(
			timeline.every((item) => item.kind !== "outcome" && item.kind !== "failure"),
			"replay must not synthesize a terminal result",
		);
		deepStrictEqual(
			timeline.filter((item) => item.kind === "request").map((item) => item.summary),
			["Earlier prompt 1", "Earlier prompt 2"],
		);
		deepStrictEqual(
			timeline.map((item) => item.status),
			["replayed", "replayed", "complete", "replayed", "replayed", "replayed"],
		);
		deepStrictEqual([...new Set(timeline.map((item) => item.turnId))], ["turn-1", "turn-2"]);

		// The next live prompt continues the replayed numbering.
		await sendCommand(socket, "request-continue", "turn.start", { projectId, prompt: "Continue the branch." });
		const live = (await collectThrough(socket, "turn.terminal")).at(-1);
		ok(live?.kind === "turn.terminal");
		equal(live.turnId, "turn-3");
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("a reload at every phase neither orphans nor duplicates the child", async () => {
	const fixture = await startFixture({ scenario: "permission", disconnectGraceMs: 5_000, pidFile: true });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");

		// unbound: no project yet
		socket.closeAbruptly();
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");

		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const openedEvent = (await collectThrough(socket, "project.opened")).at(-1);
		ok(openedEvent?.kind === "project.opened");
		const projectId = openedEvent.payload.workspace.project.id;
		const generation = openedEvent.payload.workspace.processGeneration;
		ok(generation);

		// idle
		socket.closeAbruptly();
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		let snapshot = await socket.readEvent();
		ok(snapshot.kind === "project.opened");
		equal(snapshot.payload.workspace.processGeneration, generation);
		equal(snapshot.payload.workspace.activeTurn, null);

		// running, then awaiting-approval
		await sendCommand(socket, "request-turn", "turn.start", { projectId, prompt: "Reload mid-turn." });
		const startedEvent = (await collectThrough(socket, "turn.started")).at(-1);
		ok(startedEvent?.kind === "turn.started");
		const turnId = startedEvent.turnId;
		ok(turnId);
		socket.closeAbruptly();
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		snapshot = await socket.readEvent();
		ok(snapshot.kind === "project.opened");
		equal(snapshot.payload.workspace.processGeneration, generation, "the reload replaced the child");
		equal(snapshot.payload.workspace.activeTurn?.turnId, turnId);

		// The approval was raised while no socket was attached, so the reconnected
		// client learns about it from the snapshot rather than from an event.
		const deadline = Date.now() + 5_000;
		let pendingPermissionId: string | null = null;
		while (pendingPermissionId === null) {
			if (Date.now() >= deadline) throw new Error("The parked approval never reached a reload snapshot.");
			socket.closeAbruptly();
			socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
			equal((await socket.readEvent()).kind, "connection.ready");
			snapshot = await socket.readEvent();
			ok(snapshot.kind === "project.opened");
			equal(snapshot.payload.workspace.processGeneration, generation);
			pendingPermissionId = snapshot.payload.workspace.pendingPermission?.permissionId ?? null;
			if (pendingPermissionId === null) await delay(50);
		}
		ok(snapshot.kind === "project.opened");
		equal(snapshot.payload.workspace.clio.phase, "awaiting-approval");
		equal(snapshot.payload.workspace.activeTurn?.turnId, turnId);

		// cancelling, then settled
		await sendCommand(socket, "request-cancel", "turn.cancel", { projectId, turnId });
		const terminal = (await collectThrough(socket, "turn.terminal")).at(-1);
		ok(terminal?.kind === "turn.terminal");
		equal(terminal.payload.outcome, "canceled");
		socket.closeAbruptly();
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		snapshot = await socket.readEvent();
		ok(snapshot.kind === "project.opened");
		equal(snapshot.payload.workspace.processGeneration, generation, "the session outlived every reload");
		equal(snapshot.payload.workspace.activeTurn, null);
		equal(snapshot.payload.workspace.pendingPermission, null);

		// One prompt still works on that same child.
		await sendCommand(socket, "request-final", "turn.start", { projectId, prompt: "Still one child." });
		const finalPermission = (await collectThrough(socket, "turn.permission.requested")).at(-1);
		ok(finalPermission?.kind === "turn.permission.requested");
		equal(finalPermission.processGeneration, generation);

		// Exactly one child ever existed, and closing the server retires it.
		const childPid = Number(await Deno.readTextFile(fixture.pidPath));
		ok(Number.isSafeInteger(childPid) && childPid > 1);
		equal(
			(await new Deno.Command("kill", { args: ["-s", "0", String(childPid)], stdout: "null", stderr: "null" })
				.output()).success,
			true,
		);
		socket.closeAbruptly();
		socket = undefined;
		await fixture.running.close();
		const retired = await Promise.race([
			(async () => {
				const deadline = Date.now() + 5_000;
				while (Date.now() < deadline) {
					const alive = await new Deno.Command("kill", {
						args: ["-s", "0", String(childPid)],
						stdout: "null",
						stderr: "null",
					}).output();
					if (!alive.success) return true;
					await delay(25);
				}
				return false;
			})(),
			delay(6_000).then(() => false),
		]);
		equal(retired, true, "the ACP child outlived the server");
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("labelling and deleting a session round-trips over the socket", async () => {
	const fixture = await startFixture({ scenario: "conversation" });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const openedEvent = (await collectThrough(socket, "project.opened")).at(-1);
		ok(openedEvent?.kind === "project.opened");
		const projectId = openedEvent.payload.workspace.project.id;
		const earlier = openedEvent.payload.workspace.sessions.find((session) => !session.hosted);
		ok(earlier);
		await sendCommand(socket, "request-new", "session.new", { projectId });
		const bound = (await collectThrough(socket, "session.list")).at(-1);
		ok(bound?.kind === "session.list");
		const hosted = bound.payload.sessions.find((session) => session.hosted);
		ok(hosted);

		await sendCommand(socket, "request-label", "session.label", {
			projectId,
			sessionId: earlier.id,
			label: "Renamed by the operator",
		});
		const labelled = (await collectThrough(socket, "session.list")).at(-1);
		ok(labelled?.kind === "session.list");
		equal(labelled.payload.sessions.find((session) => session.id === earlier.id)?.label, "Renamed by the operator");

		await sendCommand(socket, "request-delete-open", "session.delete", { projectId, sessionId: hosted.id });
		const refusal = (await collectThrough(socket, "command.error")).at(-1);
		ok(refusal?.kind === "command.error");
		equal(refusal.payload.code, "refused");

		await sendCommand(socket, "request-delete", "session.delete", { projectId, sessionId: earlier.id });
		const remaining = (await collectThrough(socket, "session.list")).at(-1);
		ok(remaining?.kind === "session.list");
		deepStrictEqual(remaining.payload.sessions.map((session) => session.id), [hosted.id]);
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("a remembered project whose folder disappears is reported unavailable and refuses to reopen", async () => {
	const fixture = await startFixture();
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");

		await sendCommand(socket, "request-open-alpha", "project.open", { path: fixture.projectRoot });
		const alphaOpened = (await collectThrough(socket, "project.opened")).at(-1);
		ok(alphaOpened?.kind === "project.opened");
		const alphaId = alphaOpened.payload.workspace.project.id;

		// Opening a second folder closes the first without forgetting it, which is
		// the only way a remembered project can be checked for availability.
		const betaRoot = join(fixture.homePath, "code", "beta");
		await Deno.mkdir(betaRoot, { recursive: true });
		await sendCommand(socket, "request-open-beta", "project.open", { path: betaRoot });
		const betaOpened = (await collectThrough(socket, "project.opened")).at(-1);
		ok(betaOpened?.kind === "project.opened");
		const betaId = betaOpened.payload.workspace.project.id;
		ok(betaId !== alphaId);

		await Deno.remove(fixture.projectRoot, { recursive: true });

		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		const recent = bootstrap.recent as Array<Record<string, unknown>>;
		equal(recent.find((entry) => entry.id === alphaId)?.available, false);
		equal(recent.find((entry) => entry.id === betaId)?.available, true);
		equal(bootstrap.openProjectId, betaId);

		await sendCommand(socket, "request-select-alpha", "project.select", { projectId: alphaId });
		const refused = await socket.readEvent();
		ok(refused.kind === "command.error", `expected a refusal, received ${JSON.stringify(refused)}`);
		equal(refused.payload.code, "refused");
		equal(refused.payload.requestId, "request-select-alpha");
		ok(refused.payload.message.length > 0);

		// The refusal must not disturb the project that is actually open.
		const afterRefusal = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		equal(afterRefusal.openProjectId, betaId);

		await sendCommand(socket, "request-forget-alpha", "project.forget", { projectId: alphaId });
		const forgotten = await socket.readEvent();
		ok(forgotten.kind === "project.forgotten");
		equal(forgotten.projectId, alphaId);
		const afterForget = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		deepStrictEqual((afterForget.recent as Array<Record<string, unknown>>).map((entry) => entry.id), [betaId]);
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("settings, targets, and autonomy round-trip over the socket and reach the next prompt", async () => {
	const fixture = await startFixture({ scenario: "settings" });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");

		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const opened = (await collectThrough(socket, "project.opened")).at(-1);
		ok(opened?.kind === "project.opened");
		const workspace = opened.payload.workspace;
		const projectId = workspace.project.id;
		// Opening a project primes both projections, so the settings page has
		// something truthful to show before the operator asks for anything.
		deepStrictEqual(workspace.targets?.map((target) => target.id), ["lmstudio", "offline-lab"]);
		equal(workspace.targetsTruncated, false);
		equal(workspace.settings?.settings["orchestrator.model"], "qwen3.8-27b");
		// No probe has happened, so no health may be claimed.
		deepStrictEqual(workspace.targets?.map((target) => target.health), [null, null]);

		await sendCommand(socket, "request-probe", "targets.probe", { projectId, targetId: "offline-lab" });
		const probed = (await collectThrough(socket, "targets.probed")).at(-1);
		ok(probed?.kind === "targets.probed");
		equal(probed.payload.targetId, "offline-lab");
		equal(probed.payload.health.healthy, false);
		equal(probed.payload.health.reason, "not-configured");

		await sendCommand(socket, "request-patch", "settings.patch", {
			projectId,
			patch: { "orchestrator.model": "qwen3.8-4b" },
		});
		const patched = (await collectThrough(socket, "settings.state")).at(-1);
		ok(patched?.kind === "settings.state");
		equal(patched.payload.settings.settings["orchestrator.model"], "qwen3.8-4b");

		await sendCommand(socket, "request-session", "session.new", { projectId });
		await collectThrough(socket, "session.list");
		await sendCommand(socket, "request-autonomy", "autonomy.set", { projectId, level: "read-only" });
		const stated = (await collectThrough(socket, "clio.state")).at(-1);
		ok(stated?.kind === "clio.state");
		equal(stated.payload.snapshot.session?.autonomy, "read-only");
		equal(stated.payload.snapshot.session?.autonomySource, "session");

		// The M4 gate: what the GUI set is what Clio ran the next turn under.
		await sendCommand(socket, "request-turn", "turn.start", { projectId, prompt: "What autonomy is in force?" });
		const turn = await collectThrough(socket, "turn.terminal");
		const answer = turn.filter((event) => event.kind === "turn.text").map((event) => event.payload.text).join("");
		equal(answer, "This session has seen 1 prompts at autonomy read-only.");

		const bootstrap = await (await fetch(new URL("/api/bootstrap", running.url))).json() as Record<string, unknown>;
		const restored = bootstrap.workspace as Record<string, unknown>;
		equal(restored.targetsTruncated, false);
		const restoredTargets = restored.targets as Array<Record<string, unknown>>;
		equal(
			(restoredTargets.find((target) => target.id === "offline-lab")?.health as Record<string, unknown>)?.healthy,
			false,
		);
		equal(restoredTargets.find((target) => target.id === "lmstudio")?.health ?? null, null);
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});

Deno.test("a shortened target list reaches the client as truncated", async () => {
	const fixture = await startFixture({ scenario: "settings-truncated" });
	let socket: RawWebSocket | undefined;
	try {
		const { running } = fixture;
		socket = await RawWebSocket.connect(eventsEndpoint(running), running.url);
		equal((await socket.readEvent()).kind, "connection.ready");
		await sendCommand(socket, "request-open", "project.open", { path: fixture.projectRoot });
		const opened = (await collectThrough(socket, "project.opened")).at(-1);
		ok(opened?.kind === "project.opened");
		equal(opened.payload.workspace.targetsTruncated, true);
	} finally {
		await socket?.closeGracefully().catch(() => socket?.closeAbruptly());
		await fixture.close();
	}
});
