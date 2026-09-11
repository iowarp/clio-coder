import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { EventHub } from "./services/event-hub.js";
import { OperationRegistry } from "./services/operations.js";
import { ToolchainService } from "./services/toolchain.js";
import { WorkerHost } from "./worker/host.js";

export async function main() {
	const { values } = parseArgs({
		options: { port: { type: "string", default: "0" }, fixture: { type: "boolean", default: false } },
	});
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535.");
	const clientDir = fileURLToPath(new URL("../dist/client/", import.meta.url));
	if (!existsSync(join(clientDir, "index.html")))
		throw new Error("Client build is missing. Run pnpm --filter @iowarp/clio-coder-web build before start.");
	const scratch = values.fixture ? await mkdtemp(join(tmpdir(), "clio-coder-web-fixture-")) : undefined;
	const env = scratch
		? {
				...process.env,
				PATH: "",
				CLIO_CODER_HOME: scratch,
				...Object.fromEntries(
					["CONFIG", "DATA", "STATE", "CACHE"].map((role) => [`CLIO_CODER_${role}_DIR`, join(scratch, role.toLowerCase())]),
				),
			}
		: process.env;
	const settings = { fixture: values.fixture, installDelayMs: 900 };
	const reads = new WorkerHost("reads", settings, env),
		ops = new WorkerHost("ops", settings, env);
	const hub = new EventHub(),
		operations = new OperationRegistry(hub);
	const token = randomBytes(32).toString("base64url");
	let origin = `http://127.0.0.1:${port}`;
	const app = createApp({
		token,
		origin: () => origin,
		hub,
		operations,
		toolchain: new ToolchainService(reads, ops, operations, hub),
		clientDir,
	});
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
		origin = `http://127.0.0.1:${info.port}`;
		if (scratch) console.log(`[clio-coder:web] Fabricated tool fixture; isolated state: ${scratch}`);
		console.log(`[clio-coder:web] ${origin}/#token=${token}`);
	});
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		server.close();
		if ("closeAllConnections" in server) server.closeAllConnections();
		await Promise.all([reads.close(), ops.close()]);
		if (scratch) await rm(scratch, { recursive: true, force: true });
	};
	server.on("error", (error) => {
		console.error("[clio-coder:web]", error.message);
		void close().then(() => {
			process.exitCode = 1;
		});
	});
	process.once("SIGINT", () => {
		void close();
	});
	process.once("SIGTERM", () => {
		void close();
	});
}
void main().catch((error: unknown) => {
	console.error(`[clio-coder:web] ${error instanceof Error ? error.message : "Startup failed."}`);
	process.exitCode = 1;
});
