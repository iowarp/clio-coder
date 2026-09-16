// Minimal MCP server over stdio for the client contract tests. One JSON-RPC
// message per line. Plain Node, no dependencies. The first argument selects a
// behavior mode; every mode that answers initialize serves the same tools.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";
const write = (message) => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

process.stderr.write("fake server started\n");

if (mode === "ignore-sigterm") {
	process.on("SIGTERM", () => {
		process.stderr.write("ignoring SIGTERM\n");
	});
	setInterval(() => {}, 1_000);
}

const PAGE_ONE = [
	{
		name: "echo",
		description: "Echo the arguments as JSON text.",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
	},
	{ name: "fail", description: "Report a tool error.", inputSchema: { type: "object" } },
	{
		name: "sleep",
		title: "Sleeper",
		description: "Sleep for ms.",
		inputSchema: { type: "object", properties: { ms: { type: "number" } } },
		annotations: { readOnlyHint: true },
	},
];
const PAGE_TWO = [
	{ name: "media", description: "Return every content block type.", inputSchema: { type: "object" } },
	{ name: "structured", description: "Return structured content.", inputSchema: { type: "object" } },
	{ name: "crash", description: "Exit without answering.", inputSchema: { type: "object" } },
	{ name: "oversized", description: "Return a huge text block.", inputSchema: { type: "object" } },
	{ name: "invalid_utf8", description: "Answer with invalid UTF-8.", inputSchema: { type: "object" } },
	{ name: "server_request", description: "Ask the client for its roots first.", inputSchema: { type: "object" } },
	{ name: "list_changed", description: "Notify before answering.", inputSchema: { type: "object" } },
	{ name: "env", description: "Report an environment variable and the cwd.", inputSchema: { type: "object" } },
	{ name: "spawn_descendant", description: "Start a SIGTERM-proof descendant.", inputSchema: { type: "object" } },
	{ name: "stderr_flood", description: "Write far more stderr than any tail keeps.", inputSchema: { type: "object" } },
	{ name: "flood_requests", description: "Stop reading stdin and flood requests.", inputSchema: { type: "object" } },
];

const pendingServerRequests = new Map();
let serverRequestId = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

function handleToolCall(id, params) {
	const name = params?.name;
	const args = params?.arguments ?? {};
	if (mode === "raw-result") {
		reply(id, args.result);
		return;
	}
	if (mode === "raw-numeric-result") {
		// Deliberately emit literals without first converting them to JS numbers.
		const structured =
			'{"integer":9007199254740993,"decimal":0.1000000000000000055511151231257827,"huge":1e400,"negativeZero":-0,"nested":[1e400,-0]}';
		process.stdout.write(
			`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"content":[],"structuredContent":${structured}}}\n`,
		);
		return;
	}
	switch (name) {
		case "echo":
			reply(id, { content: [{ type: "text", text: JSON.stringify(args) }] });
			return;
		case "fail":
			reply(id, { content: [{ type: "text", text: "boom" }], isError: true });
			return;
		case "sleep":
			process.stderr.write("sleep start\n");
			setTimeout(() => reply(id, { content: [{ type: "text", text: "slept" }] }), Number(args.ms ?? 0));
			return;
		case "media":
			reply(id, {
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") },
					{ type: "audio", mimeType: "audio/wav", data: Buffer.from([1, 2, 3, 4]).toString("base64") },
					{ type: "resource", resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "alpha" } },
					{ type: "resource_link", uri: "file:///b.txt", name: "b" },
					{ type: "hologram", payload: 1 },
				],
			});
			return;
		case "structured":
			reply(id, { content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } });
			return;
		case "crash":
			process.exit(3);
			return;
		case "oversized":
			reply(id, { content: [{ type: "text", text: "x".repeat(Number(args.bytes ?? 8192)) }] });
			return;
		case "invalid_utf8":
			process.stdout.write(
				Buffer.concat([
					Buffer.from(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"content":[{"type":"text","text":"`),
					Buffer.from([0xff, 0xfe]),
					Buffer.from('"}]}}\n'),
				]),
			);
			return;
		case "server_request": {
			const requestId = `srv-${++serverRequestId}`;
			pendingServerRequests.set(requestId, (response) => {
				const code = response.error ? response.error.code : "none";
				reply(id, { content: [{ type: "text", text: `client error code ${code}` }] });
			});
			write({ jsonrpc: "2.0", id: requestId, method: "roots/list" });
			return;
		}
		case "list_changed":
			write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			write({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
			reply(id, { content: [{ type: "text", text: "notified" }] });
			return;
		case "env":
			reply(id, {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							fixture: process.env.FIXTURE_VAR ?? null,
							secret: process.env.TEST_MCP_SECRET ?? null,
							cwd: process.cwd(),
						}),
					},
				],
			});
			return;
		case "spawn_descendant": {
			// Same process group, inherits our pipes, ignores SIGTERM: the process a
			// naive close leaves behind. Its SIGTERM handler records the moment of
			// delivery in args.marker, and the pid is reported only after the
			// descendant says the handler is installed. With exitLeader the server
			// itself exits right after answering, so the descendant outlives it.
			const marker = typeof args.marker === "string" ? args.marker : "";
			const descendant = spawn(
				process.execPath,
				[
					"-e",
					[
						"const marker = process.argv[1];",
						'process.on("SIGTERM", () => { if (marker) require("node:fs").writeFileSync(marker, String(Date.now())); });',
						"setInterval(() => {}, 1000);",
						'process.send("ready");',
					].join(" "),
					marker,
				],
				{ stdio: ["inherit", "inherit", "inherit", "ipc"] },
			);
			descendant.once("message", () => {
				descendant.disconnect();
				const text = JSON.stringify({ pid: descendant.pid });
				if (args.exitLeader) {
					// Exit a beat after the reply is flushed so the client reads the answer before it sees the exit.
					process.stdout.write(
						`${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })}\n`,
						() => setTimeout(() => process.exit(0), 20),
					);
					return;
				}
				reply(id, { content: [{ type: "text", text }] });
			});
			return;
		}
		case "stderr_flood": {
			const line = `${"e".repeat(1023)}\n`;
			for (let index = 0; index < 256; index += 1) process.stderr.write(line);
			process.stderr.write("flood done\n", () => reply(id, { content: [{ type: "text", text: "flooded" }] }));
			return;
		}
		case "flood_requests": {
			// Never answer this call: stop reading stdin, then keep asking the client
			// for things so every reply it queues has nowhere to go.
			lines.pause();
			const count = Number(args.count ?? 512);
			const idBytes = Number(args.idBytes ?? 4096);
			for (let index = 0; index < count; index += 1) {
				write({ jsonrpc: "2.0", id: `${index}-${"i".repeat(idBytes)}`, method: "roots/list" });
			}
			return;
		}
		default:
			replyError(id, -32602, `unknown tool: ${String(name)}`);
	}
}

function handleToolList(id, params) {
	if (mode === "endless-tools") {
		const page = Number(params?.cursor ?? 0);
		const tools = Array.from({ length: 100 }, (_, index) => ({
			name: `t${page * 100 + index}`,
			description: "endless",
			inputSchema: { type: "object" },
		}));
		reply(id, { tools, nextCursor: String(page + 1) });
		return;
	}
	if (params?.cursor === "page-2") {
		reply(id, { tools: PAGE_TWO });
		return;
	}
	reply(id, { tools: PAGE_ONE, nextCursor: "page-2" });
}

function handleMessage(message) {
	if (typeof message.method !== "string") {
		const settle = pendingServerRequests.get(message.id);
		if (settle) {
			pendingServerRequests.delete(message.id);
			settle(message);
		}
		return;
	}
	if (message.id === undefined) return;
	switch (message.method) {
		case "initialize":
			if (mode === "silent-init") return;
			if (mode === "exit-on-init") process.exit(7);
			if (mode === "garbage") {
				process.stdout.write("this is not json\n");
				return;
			}
			if (mode === "garbage-then-exit") {
				process.stdout.write("this is not json\n", () => process.exit(9));
				return;
			}
			reply(message.id, {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: "fake", version: "1.0" },
				instructions: "fixture",
			});
			// A server that answers initialize and then never reads again.
			if (mode === "deaf") lines.pause();
			return;
		case "tools/list":
			handleToolList(message.id, message.params);
			return;
		case "tools/call":
			handleToolCall(message.id, message.params);
			return;
		default:
			replyError(message.id, -32601, `method not found: ${message.method}`);
	}
}

lines.on("line", (line) => {
	if (line.trim().length === 0) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	handleMessage(message);
});
lines.on("close", () => {
	if (mode !== "ignore-sigterm") process.exit(0);
});
