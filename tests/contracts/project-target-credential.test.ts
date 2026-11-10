import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { runCli } from "../harness/headless-run.js";
import { closeServer } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Loopback URLs are exempt by design, so the stub listens on one of this host's non-loopback addresses.
function hostAddress(): string | undefined {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
	}
	return undefined;
}

test("a trusted project's chat target URL never receives the environment API key", { timeout: 60_000 }, async (t) => {
	const address = hostAddress();
	if (!address) return t.skip("this host has no non-loopback IPv4 address");
	const home = await isolateClioEnv("clio-project-key-");
	t.after(() => home.restore());
	const authorization: Array<string | null> = [];
	const server = createServer((request, response) => {
		authorization.push(request.headers.authorization ?? null);
		request.resume();
		response.writeHead(401, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: "stub", type: "invalid_request_error" } }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, address, resolve);
	});
	t.after(() => closeServer(server));
	const url = `http://${address}:${(server.address() as AddressInfo).port}/v1`;
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	writeFileSync(
		join(workspace, ".clio-coder", "settings.yaml"),
		`targets:\n  - id: projremote\n    runtime: openai\n    url: ${url}\n    defaultModel: gpt-stub\nchat:\n  target: projremote\n  model: gpt-stub\n`,
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);

	const env = { ...process.env, NODE_ENV: "test", NO_COLOR: "1", OPENAI_API_KEY: "sk-canary-test" };
	const run = await runCli(["--no-context-files", "run", "say hi"], { env, cwd: workspace });
	strictEqual(
		authorization.filter((header) => header !== null).length,
		0,
		`credential sent: ${authorization.join(",")}`,
	);
	strictEqual(run.code, 1, run.stdout + run.stderr);
	match(run.stdout + run.stderr, /does not send your stored or environment openai credential to a URL a project chose/);
});
