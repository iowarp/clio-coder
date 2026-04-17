/**
 * Hermetic diag for the lmstudio runtime adapter. Verifies the probe tries
 * `/api/v0/models` first (richer LM Studio REST) and falls back to
 * `/v1/models` when the v0 endpoint is absent.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { listModels, lmstudioAdapter } from "../src/domains/providers/runtimes/lmstudio.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-providers-lmstudio] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-providers-lmstudio] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

type Handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

async function withServer<T>(handler: Handler, run: (url: string) => Promise<T>): Promise<T> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		return await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

async function main(): Promise<void> {
	check("adapter:id", lmstudioAdapter.id === "lmstudio");
	check("adapter:tier", lmstudioAdapter.tier === "native");

	// Server A: serves /api/v0/models (preferred path)
	await withServer(
		(req, res) => {
			if (req.url === "/api/v0/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: "qwen3.6-35b-a3b", type: "llm", state: "loaded" }] }));
				return;
			}
			res.writeHead(404);
			res.end();
		},
		async (url) => {
			const models = await listModels({ url });
			check("listModels:v0-path-preferred", models.includes("qwen3.6-35b-a3b"), `got ${JSON.stringify(models)}`);

			const probe = await lmstudioAdapter.probe({ endpoints: { main: { url } } });
			check("probe:v0-ok", probe.ok === true, `got ${JSON.stringify(probe)}`);
		},
	);

	// Server B: only /v1/models (fallback)
	await withServer(
		(req, res) => {
			if (req.url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: "llama-3.1-8b" }] }));
				return;
			}
			res.writeHead(404);
			res.end();
		},
		async (url) => {
			const models = await listModels({ url });
			check("listModels:v1-fallback", models.includes("llama-3.1-8b"), `got ${JSON.stringify(models)}`);

			const probe = await lmstudioAdapter.probe({ endpoints: { main: { url } } });
			check("probe:v1-fallback-ok", probe.ok === true, `got ${JSON.stringify(probe)}`);
		},
	);

	// Bogus endpoint
	const probeBogus = await lmstudioAdapter.probe({ endpoints: { off: { url: "http://127.0.0.1:1" } } });
	check("probe:bogus-fails", probeBogus.ok === false, `got ${JSON.stringify(probeBogus)}`);

	if (failures.length > 0) {
		process.stderr.write(`[diag-providers-lmstudio] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-providers-lmstudio] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-providers-lmstudio] ERROR ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
