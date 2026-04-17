/**
 * Hermetic diag for the openai-compat runtime adapter. Impersonates any
 * generic OpenAI-compatible server's `/v1/models` and asserts probe + listModels.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { listModels, openaiCompatAdapter } from "../src/domains/providers/runtimes/openai-compat.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-providers-openai-compat] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-providers-openai-compat] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
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
	check("adapter:id", openaiCompatAdapter.id === "openai-compat");
	check("adapter:tier", openaiCompatAdapter.tier === "native");

	// Authenticated server: asserts the Bearer token is forwarded.
	let sawAuth = false;
	await withServer(
		(req, res) => {
			if (req.headers.authorization === "Bearer sk-test") sawAuth = true;
			if (req.url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: "Meta-Llama-3.1-70B-Instruct" }] }));
				return;
			}
			res.writeHead(404);
			res.end();
		},
		async (url) => {
			const models = await listModels({ url, api_key: "sk-test" });
			check("listModels:returns-ids", models.includes("Meta-Llama-3.1-70B-Instruct"), `got ${JSON.stringify(models)}`);
			check("listModels:forwards-bearer", sawAuth);

			const probe = await openaiCompatAdapter.probe({ endpoints: { vllm: { url, api_key: "sk-test" } } });
			check("probe:ok", probe.ok === true, `got ${JSON.stringify(probe)}`);
		},
	);

	// Bogus endpoint
	const probeBogus = await openaiCompatAdapter.probe({ endpoints: { off: { url: "http://127.0.0.1:1" } } });
	check("probe:bogus-fails", probeBogus.ok === false, `got ${JSON.stringify(probeBogus)}`);

	// canSatisfy with no endpoints
	const noEp = openaiCompatAdapter.canSatisfy({ modelId: "x", credentialsPresent: new Set(), endpoints: {} });
	check("canSatisfy:no-endpoints", noEp.ok === false);

	if (failures.length > 0) {
		process.stderr.write(`[diag-providers-openai-compat] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-providers-openai-compat] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-providers-openai-compat] ERROR ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
