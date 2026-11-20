import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { ExtensionRuntimeHookExecutor } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { parseExtensionToolResult } from "../../src/domains/extensions/runtime-output-v2.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { storeToolDetail } from "../../src/domains/session/tool-details.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { buildExtensionRuntimeToolSpecs, ensureDetailLedger } from "../../src/tools/extension-runtime-tools.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createLedgerTool } from "../../src/tools/ledger.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { createRegistry, type ToolResult } from "../../src/tools/registry.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

function ok_(result: ToolResult): string {
	if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	return result.output;
}

/** A session store directory, which is where the session's tool details live. */
function sessionStore(sessionId: string): void {
	const directory = path.join(clioStateDir(), "sessions", "compact-repo", sessionId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		path.join(directory, "current.jsonl"),
		`${JSON.stringify({ type: "session", version: 6, id: sessionId, timestamp: new Date().toISOString(), cwd: "/" })}\n`,
	);
}

it("an api 2 tool's summary reaches the model and ledger(ref) returns the stored detail (WTF-P 0.8.3 C3)", async () => {
	const dir = clioStateDir();
	const root = path.join(dir, "..", "source");
	const cwd = path.join(dir, "..", "workspace");
	mkdirSync(root, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		path.join(root, "clio-coder-extension.json"),
		JSON.stringify({
			id: "papers",
			name: "papers",
			version: "1.0.0",
			description: "A runtime whose tool returns a compact result",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				tools: [
					{ name: "outline", description: "Outline a section", actionClass: "read", inputSchema: { type: "object" } },
				],
			},
		}),
	);
	writeFileSync(path.join(root, "extension.mjs"), "export default () => {};\n");
	ok(installExtension(root, { cwd, scope: "user" }).extension?.loadable);
	const [entry] = listInstalledExtensions(cwd, { all: true });
	ok(entry?.runtimeV2);
	const declaration = entry.runtimeV2;

	const detail = Array.from({ length: 400 }, (_, index) => `section ${index}: evidence row ${"x".repeat(40)}`).join(
		"\n",
	);
	const raw = { text: detail, summary: "outline ready: 400 sections, 3 gaps", data: { gaps: 3 } };
	// The host parses what the runtime returned before the tool sees it; an oversized summary is refused.
	throws(() => parseExtensionToolResult({ text: "t", summary: "s".repeat(2049) }, declaration), /summary must be/u);
	const bridge = createExtensionRuntimeHookBridge();
	bridge.bind({
		tool: async () => parseExtensionToolResult(raw, declaration),
	} as unknown as ExtensionRuntimeHookExecutor);
	const [outline] = buildExtensionRuntimeToolSpecs([entry], bridge);
	ok(outline);
	const registry = createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "default" });
	registry.register(outline);

	const sessionId = "compact-session";
	sessionStore(sessionId);
	const verdict = await registry.invoke({ tool: outline.name, args: {} }, { sessionId });
	strictEqual(verdict.kind, "ok", JSON.stringify(verdict));
	if (verdict.kind !== "ok") return;
	const shown = ok_(verdict.result);
	ok(shown.startsWith("outline ready: 400 sections, 3 gaps"), shown);
	ok(!shown.includes("section 399"), "the model sees the summary, not the detail");
	const ref = /detail_ref: (xd_[0-9a-f]{16})/u.exec(shown)?.[1];
	ok(ref, shown);
	ok(Buffer.byteLength(shown) < 512, `the compact result is bounded: ${Buffer.byteLength(shown)} bytes`);

	// The board-less ledger reads the detail from the session's store; ref alone asks for it.
	const ledger = createLedgerTool({});
	const args = ledger.prepareArguments?.({ ref }) ?? { ref };
	strictEqual(args.action, "detail");
	const pages: string[] = [];
	let next: number | undefined = 0;
	while (next !== undefined) {
		const page = ok_(await ledger.run({ ...args, offset: next }, { sessionId }));
		const header = page.slice(0, page.indexOf("\n\n"));
		pages.push(page.slice(header.length + 2));
		const offset = /offset=(\d+)/u.exec(header)?.[1];
		next = offset === undefined ? undefined : Number(offset);
	}
	ok(pages.length > 1, "a detail past one page is read by offset");
	strictEqual(pages.join(""), `${detail}\n${JSON.stringify({ gaps: 3 })}`);

	// Another session's store does not hold it, and a malformed ref is refused before any read.
	sessionStore("other-session");
	match(
		(await ledger.run({ action: "detail", ref }, { sessionId: "other-session" })).kind === "error" ? "refused" : "",
		/refused/u,
	);
	strictEqual((await ledger.run({ action: "detail", ref: "../escape" }, { sessionId })).kind, "error");
});

it("a session without dispatch reads an extension result's detail_ref through the gateway (WTF-P 0.8.3 C3)", async () => {
	const sessionId = "detail-reach-session";
	sessionStore(sessionId);
	const detail = "the whole outline, as the extension returned it";
	const ref = storeToolDetail(sessionId, detail);

	const registry = createRegistry({ safety: createWorkerSafety({ cwd: clioStateDir() }), autonomy: () => "default" });
	registry.register(createGatewayTool({ registry }));
	strictEqual(registry.get(ToolNames.Ledger), undefined, "a session without dispatch registers no ledger");
	ensureDetailLedger(registry);
	ensureDetailLedger(registry);
	const ledger = registry.get(ToolNames.Ledger);
	strictEqual(ledger?.placement, "gateway");
	strictEqual(ledger?.metadata?.startupPrompt, false, "no prompt map entry, so the request bytes do not move");
	deepStrictEqual(
		registry.listGateway().map((spec) => spec.name),
		[ToolNames.Ledger],
	);

	const verdict = await registry.invoke(
		{ tool: ToolNames.Gateway, args: { op: "call", capability: ToolNames.Ledger, args: { ref } } },
		{ sessionId },
	);
	ok(verdict.kind === "ok" && verdict.result.kind === "ok", JSON.stringify(verdict));
	ok(verdict.result.output.endsWith(detail), verdict.result.output);
});

const REPORT_TAIL = "Closing note: the nonuniform path never measures boundary convergence.";
const longReport = JSON.stringify({
	mutatedPaths: [],
	validations: [{ name: "source read", passed: true, evidence: "Read the requested files; no tests ran." }],
	summary: [
		...Array.from({ length: 60 }, (_, index) => `Finding ${index + 1}. The stencil weights differ at row ${index}.`),
		REPORT_TAIL,
	].join("\n\n"),
});

it("a dispatch result is compact by default and monitor(mode=record) returns the whole answer (WTF-P 0.8.3 C3)", {
	timeout: 15_000,
}, async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.safety.autonomy = "yolo";
	const context = dispatchStubContext({ settings });
	const agents = context.getContract("agents");
	ok(agents);
	const bundle = makeDispatchBundle(context, {
		spawnWorker: () => ({
			pid: null,
			promise: Promise.resolve({ exitCode: 0, signal: null }),
			events: (async function* () {
				yield { type: "clio_coder_tool_finish", payload: { tool: "read", outcome: "ok", durationMs: 1 } };
				yield { type: "message_end", message: { role: "assistant", content: longReport, stopReason: "stop" } };
			})(),
			abort: () => {},
			heartbeatAt: { current: Date.now() },
		}),
	});
	const dispatch = createDispatchTool({
		dispatch: bundle.contract,
		bus: context.bus,
		getAgentSpecs: () => agents.listSpecs(),
		getAutonomy: () => "yolo",
	});
	const monitor = createMonitorTool({ dispatch: bundle.contract });
	const intent = { read_roots: ["."], write_roots: [] };
	await bundle.extension.start();
	try {
		const compact = ok_(await dispatch.run({ agent: "coder", task: "Explain the stencils.", intent }, {}));
		const run = bundle.contract.listRuns()[0];
		ok(run);
		// A lone run's answer budget is 12,000 bytes, so the compact form carries this report whole (M3).
		ok(compact.includes(REPORT_TAIL), "the compact form fits the answer in the run's budget");
		match(compact, new RegExp(`- ${run.id} agent=coder exit=0`), "the run line keeps its key facts");
		match(compact, /^ {2}worker (claims|output)/mu, "the trust line stays");
		// The run line keeps what the run delivered and leaves setup diagnostics to the record. Its task declares
		// write_roots: [], so it ran read-only (XR-60) and its trust names no validation rather than an inferred one.
		match(compact, /trust="sealed; no validation observed/u);
		match(compact, /runs read-only: its intent\.write_roots: \[\] declares no writes/u);
		match(compact, /findings=no-validation/u);
		ok(!/budget_recipe_policy=|project_context=|trust_status=|route_decision=/u.test(compact), compact);

		const record = ok_(await monitor.run({ mode: "record", run_id: run.id }, {}));
		ok(record.startsWith("answer (final,"), record.slice(0, 200));
		ok(record.includes(REPORT_TAIL), "the record carries the whole answer");
		ok(record.includes("\n\nrun record:\n{"), "the sealed record follows the answer");

		// An explicit output budget asks for the full form.
		const full = ok_(
			await dispatch.run({ agent: "coder", task: "Explain the stencils.", intent, max_output_bytes: 20_000 }, {}),
		);
		ok(full.includes(REPORT_TAIL), "max_output_bytes returns the whole answer");
		match(full, /budget_recipe_policy=/u, "the full form keeps every run label");
		ok(
			Buffer.byteLength(compact) < Buffer.byteLength(full),
			`compact ${Buffer.byteLength(compact)} vs full ${Buffer.byteLength(full)}`,
		);
	} finally {
		await bundle.extension.stop?.();
	}
});
