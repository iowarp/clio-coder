/**
 * Hermetic diag for the llamacpp runtime adapter. Spins a tiny Node HTTP
 * server on an ephemeral port that impersonates llama-server's `/health`
 * + `/v1/models` endpoints. Points the adapter at that port and asserts
 * probe/listModels/probeEndpoints return the expected results.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { listModels, llamacppAdapter, probeLoaded } from "../src/domains/providers/runtimes/llamacpp.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-providers-llamacpp] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-providers-llamacpp] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function withServer<T>(
	handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
	run: (url: string) => Promise<T>,
): Promise<T> {
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
	check("adapter:id", llamacppAdapter.id === "llamacpp");
	check("adapter:tier", llamacppAdapter.tier === "native");

	// canSatisfy: no endpoints → false
	const noEp = llamacppAdapter.canSatisfy({ modelId: "x", credentialsPresent: new Set(), endpoints: {} });
	check("canSatisfy:no-endpoints", noEp.ok === false && /no llamacpp endpoints/.test(noEp.reason));

	// canSatisfy: one endpoint → true
	const oneEp = llamacppAdapter.canSatisfy({
		modelId: "x",
		credentialsPresent: new Set(),
		endpoints: { a: { url: "http://ignored" } },
	});
	check("canSatisfy:one-endpoint", oneEp.ok === true);

	await withServer(
		(req, res) => {
			if (req.url === "/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ status: "ok" }));
				return;
			}
			if (req.url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						object: "list",
						data: [
							{ id: "Qwen3.6-35B", status: { value: "loaded" } },
							{ id: "gpt-oss-120b", status: { value: "idle" } },
						],
					}),
				);
				return;
			}
			res.writeHead(404);
			res.end();
		},
		async (url) => {
			const spec = { url };
			const models = await listModels(spec);
			check(
				"listModels:two-entries",
				models.length === 2 && models.includes("Qwen3.6-35B"),
				`got ${JSON.stringify(models)}`,
			);

			const loaded = await probeLoaded(spec);
			check("probeLoaded:one-loaded", loaded.length === 1 && loaded[0] === "Qwen3.6-35B", `got ${JSON.stringify(loaded)}`);

			const probe = await llamacppAdapter.probe({ endpoints: { local: spec } });
			check("probe:aggregate-ok", probe.ok === true, `got ${JSON.stringify(probe)}`);

			const endpointResults = await llamacppAdapter.probeEndpoints?.({ local: spec });
			check(
				"probeEndpoints:local-ok",
				(endpointResults ?? []).length === 1 && endpointResults?.[0]?.ok === true,
				`got ${JSON.stringify(endpointResults)}`,
			);
			check(
				"probeEndpoints:models-returned",
				(endpointResults?.[0]?.models ?? []).includes("Qwen3.6-35B"),
				`got ${JSON.stringify(endpointResults?.[0]?.models)}`,
			);
		},
	);

	// Bogus endpoint on a closed port must fail fast.
	const probeBogus = await llamacppAdapter.probe({ endpoints: { off: { url: "http://127.0.0.1:1" } } });
	check("probe:bogus-fails", probeBogus.ok === false, `got ${JSON.stringify(probeBogus)}`);

	if (failures.length > 0) {
		process.stderr.write(`[diag-providers-llamacpp] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-providers-llamacpp] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-providers-llamacpp] ERROR ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
