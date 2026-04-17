/**
 * Hermetic diag for the ollama runtime adapter. Impersonates ollama's
 * native `/api/tags` endpoint and asserts probe behavior (200 + non-empty
 * models → ok; 200 + empty models → fail with reason; closed port → fail).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { listModels, ollamaAdapter, pullModel } from "../src/domains/providers/runtimes/ollama.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-providers-ollama] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-providers-ollama] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
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
	check("adapter:id", ollamaAdapter.id === "ollama");
	check("adapter:tier", ollamaAdapter.tier === "native");

	// Populated tags
	await withServer(
		(req, res) => {
			if (req.url === "/api/tags") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						models: [{ name: "llama3:latest", model: "llama3:latest" }, { name: "qwen2.5:32b" }],
					}),
				);
				return;
			}
			res.writeHead(404);
			res.end();
		},
		async (url) => {
			const models = await listModels({ url });
			check(
				"listModels:two-models",
				models.length === 2 && models.includes("llama3:latest"),
				`got ${JSON.stringify(models)}`,
			);
			const probe = await ollamaAdapter.probe({ endpoints: { main: { url } } });
			check("probe:ok", probe.ok === true, `got ${JSON.stringify(probe)}`);
		},
	);

	// Empty tags → unhealthy
	await withServer(
		(_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ models: [] }));
		},
		async (url) => {
			const probe = await ollamaAdapter.probe({ endpoints: { main: { url } } });
			check("probe:empty-tags-fails", probe.ok === false, `got ${JSON.stringify(probe)}`);
		},
	);

	// Bogus endpoint
	const probeBogus = await ollamaAdapter.probe({ endpoints: { off: { url: "http://127.0.0.1:1" } } });
	check("probe:bogus-fails", probeBogus.ok === false, `got ${JSON.stringify(probeBogus)}`);

	// pullModel is a v0.2 stub that must throw (so users know to pull externally).
	let threw = false;
	try {
		await pullModel({ url: "http://ignored" }, "x");
	} catch {
		threw = true;
	}
	check("pullModel:stubbed", threw);

	if (failures.length > 0) {
		process.stderr.write(`[diag-providers-ollama] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-providers-ollama] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-providers-ollama] ERROR ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
