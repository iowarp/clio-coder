import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createProvidersBundle, mergeProbeResult } from "../../src/domains/providers/extension.js";
import { resolveModelCapabilities } from "../../src/domains/providers/model-capabilities.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import codexRuntime, {
	CODEX_BACKEND_CLIENT_VERSION,
	createCodexServingWindowReader,
} from "../../src/domains/providers/runtimes/cloud/openai-codex.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const token = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" } })).toString("base64url")}.s`;

async function codexBackend(respond: () => { status: number; body: unknown }): Promise<{
	url: string;
	requests: Array<{ url: string; headers: IncomingHttpHeaders }>;
	close: () => Promise<void>;
}> {
	const requests: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
	const server = createServer((request, response) => {
		requests.push({ url: request.url ?? "", headers: request.headers });
		const { status, body } = respond();
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function probeCodexRoute(backend: { url: string }) {
	const env = await isolateClioEnv("clio-coder-codex-window-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	const target = { id: "codex", runtime: "openai-codex", url: backend.url, defaultModel: "gpt-6-sol" };
	settings.targets = [target];
	const bundle = createProvidersBundle(dispatchStubContext({ settings }));
	bundle.contract.auth.setRuntimeOverrideForTarget(target, codexRuntime, token);
	await bundle.extension.start();
	try {
		const status = await bundle.contract.probeTarget("codex");
		const resolved = resolveRuntimeTarget(bundle.contract, {
			targetId: "codex",
			wireModelId: "gpt-6-sol",
			use: "orchestrator",
			requireTools: false,
			requireOutputBudget: false,
		});
		return { status, resolved };
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
}

it("adopts the Codex backend's context_window as the serving window and max_context_window as the model maximum", async () => {
	const backend = await codexBackend(() => ({
		status: 200,
		body: {
			models: [
				{ slug: "gpt-6-sol", context_window: 272_000, max_context_window: 872_000 },
				{ slug: "gpt-5.5", context_window: 272_000, max_context_window: 272_000 },
			],
		},
	}));
	try {
		const { status, resolved } = await probeCodexRoute(backend);
		strictEqual(backend.requests[0]?.url, `/codex/models?client_version=${CODEX_BACKEND_CLIENT_VERSION}`);
		strictEqual(backend.requests[0]?.headers["chatgpt-account-id"], "acct-fixture");
		strictEqual(backend.requests[0]?.headers.authorization, `Bearer ${token}`);
		strictEqual(status?.available, true);
		ok(resolved.ok);
		const details = resolved.target.contextWindowDetails;
		strictEqual(details.effectiveContextWindow, 272_000);
		strictEqual(details.servingLimit.source, "probe");
		strictEqual(details.servingLimit.kind, "serving-limit");
		strictEqual(details.modelMaximum.value, 872_000);
		strictEqual(details.modelMaximum.source, "probe");
		strictEqual(status?.capabilities.contextWindow, 272_000);
		strictEqual(status?.contextWindowProvenance, "discovered");
	} finally {
		await backend.close();
	}
});

it("keeps a Codex target usable with an unknown window when the models read fails", async () => {
	const backend = await codexBackend(() => ({ status: 500, body: { error: "unavailable" } }));
	try {
		const { status, resolved } = await probeCodexRoute(backend);
		strictEqual(status?.available, true);
		strictEqual(status?.health.status, "healthy");
		ok(status?.probeNotes?.some((note) => /Serving window unknown/u.test(note)));
		ok(resolved.ok);
		strictEqual(resolved.target.contextWindowDetails.effectiveContextWindow, 0);
		strictEqual(resolved.target.contextWindowDetails.servingLimit.kind, "unknown");
		// The status view agrees: the descriptor's 272,000 is a placeholder, and
		// every consumer that reads capabilities.contextWindow must see unknown.
		strictEqual(status?.capabilities.contextWindow, 0);
		strictEqual(status?.contextWindowProvenance, "runtime-default");
		strictEqual(codexRuntime.defaultCapabilities.contextWindow, 272_000);
		const perModel = resolveModelCapabilities(status as NonNullable<typeof status>, "gpt-6-sol", null);
		strictEqual(perModel.contextWindow, 0);
	} finally {
		await backend.close();
	}
});

const probeContext = { credentialsPresent: new Set<string>(), httpTimeoutMs: 2_000, authToken: token };

function windowRows(serving: number) {
	return { models: [{ slug: "gpt-6-sol", context_window: serving, max_context_window: 872_000 }] };
}

it("shows a changed window once the reuse span has passed and coalesces simultaneous reads into one request", async () => {
	let serving = 272_000;
	const backend = await codexBackend(() => ({ status: 200, body: windowRows(serving) }));
	try {
		let clock = 0;
		const read = createCodexServingWindowReader({ now: () => clock, reuseMs: 5_000 });
		const target = { id: "codex", runtime: "openai-codex", url: backend.url };
		const [first, second] = await Promise.all([read(target, probeContext), read(target, probeContext)]);
		strictEqual(backend.requests.length, 1, "simultaneous reads share one request");
		strictEqual(first.modelCapabilities?.["gpt-6-sol"]?.contextWindow, 272_000);
		deepStrictEqual(second, first);

		serving = 400_000;
		clock = 4_999;
		strictEqual((await read(target, probeContext)).modelCapabilities?.["gpt-6-sol"]?.contextWindow, 272_000);
		strictEqual(backend.requests.length, 1, "inside the span the parsed windows are reused");

		clock = 5_000;
		strictEqual((await read(target, probeContext)).modelCapabilities?.["gpt-6-sol"]?.contextWindow, 400_000);
		strictEqual(backend.requests.length, 2, "past the span the server is asked again");
	} finally {
		await backend.close();
	}
});

it("never extends an earlier window across a failed read", async () => {
	let status = 200;
	const backend = await codexBackend(() => ({ status, body: status === 200 ? windowRows(272_000) : { error: "down" } }));
	try {
		let clock = 0;
		const read = createCodexServingWindowReader({ now: () => clock, reuseMs: 5_000 });
		const target = { id: "codex", runtime: "openai-codex", url: backend.url };
		strictEqual((await read(target, probeContext)).ok, true);
		status = 500;
		clock = 6_000;
		strictEqual((await read(target, probeContext)).ok, false);
		status = 200;
		clock = 6_001;
		strictEqual((await read(target, probeContext)).ok, true);
		strictEqual(backend.requests.length, 3, "the failure discarded the reusable windows");
	} finally {
		await backend.close();
	}
});

it("keeps the last reported window through a failed or windowless read of a hosted route", () => {
	const target = { id: "codex", runtime: "openai-codex", url: "http://127.0.0.1:1", defaultModel: "gpt-6-luna" };
	const first = mergeProbeResult(
		codexRuntime,
		target,
		{ ok: true, modelCapabilities: { "gpt-6-luna": { contextWindow: 272_000 } } },
		undefined,
	);
	const previous = {
		target,
		probeCapabilities: first.probeCapabilities,
		probeModelCapabilities: first.probeModelCapabilities,
	};
	for (const probe of [
		{ ok: false, error: "down" },
		{ ok: true, notes: ["listed no window"] },
	]) {
		const merged = mergeProbeResult(codexRuntime, target, probe, previous as never);
		strictEqual(merged.probeModelCapabilities?.["gpt-6-luna"]?.contextWindow, 272_000);
	}
});
