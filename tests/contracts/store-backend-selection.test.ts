import { ok, rejects, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { storeRoot } from "../../src/core/store-paths.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { readStoreBackendSelection } from "../../src/domains/store/selection.js";
import { StoreRefusal } from "../../src/domains/store/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function withHome(fn: (dir: string, root: string) => Promise<void>): Promise<void> {
	const env = await isolateClioEnv("clio-coder-store-backend-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(root, { recursive: true });
		await fn(env.dir, root);
	} finally {
		env.restore();
	}
}

function writeRecord(text: string): void {
	mkdirSync(storeRoot(), { recursive: true });
	writeFileSync(join(storeRoot(), "backend.json"), text);
}

describe("store backend selection", () => {
	it("no record means local", () =>
		withHome(async (_dir, root) => {
			const selection = readStoreBackendSelection();
			strictEqual(selection.record, null);
			strictEqual(selection.problem, null);
			strictEqual((await openStoreBackend(root)).kind, "local");
		}));

	it("an unreadable or wrong-version record is reported and treated as local", () =>
		withHome(async (_dir, root) => {
			for (const text of ["{not json", JSON.stringify({ v: 2, backend: "clio-core" })]) {
				writeRecord(text);
				const selection = readStoreBackendSelection();
				strictEqual(selection.record, null);
				ok(selection.problem?.includes("using the local backend"), selection.problem ?? "no problem reported");
				strictEqual((await openStoreBackend(root)).kind, "local");
			}
		}));

	it("clio-core with a failing host yields unavailable, never local", () =>
		withHome(async (dir, root) => {
			// Something answers on the configured port, so the probe reaches the host, which cannot attach.
			const daemon = net.createServer((socket) => socket.destroy());
			await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
			const savedPath = process.env.PATH;
			try {
				const { port } = daemon.address() as net.AddressInfo;
				const config = join(dir, "clio.yaml");
				writeFileSync(config, `networking:\n  port: ${port}\n`);
				const python = join(dir, "python3");
				writeFileSync(
					python,
					`#!${process.execPath}\n` +
						`const body = Buffer.from(JSON.stringify({ hello: null, error: "cannot attach to the runtime" }));\n` +
						"const head = Buffer.alloc(4); head.writeUInt32BE(body.byteLength);\n" +
						"process.stdout.write(Buffer.concat([head, body]), () => process.exit(3));\n",
				);
				chmodSync(python, 0o755);
				// No clio_run anywhere on PATH: attach only, nothing is started.
				const emptyBin = join(dir, "bin");
				mkdirSync(emptyBin);
				process.env.PATH = emptyBin;
				writeRecord(JSON.stringify({ v: 1, backend: "clio-core", python, config }));

				await rejects(openStoreBackend(root), (error: unknown) => {
					ok(error instanceof StoreRefusal);
					strictEqual(error.reason, "unavailable");
					ok(error.message.includes("cannot attach to the runtime"), error.message);
					ok(error.message.includes("store backend local"), error.message);
					return true;
				});
				strictEqual(existsSync(join(storeRoot(), "projects")), false);
			} finally {
				process.env.PATH = savedPath;
				daemon.close();
			}
		}));
});
