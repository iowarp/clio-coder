/**
 * llama.cpp splits `--ctx-size` across `--parallel` slots unless `--kv-unified`,
 * so the window one request gets is the quotient. Reading the total as the
 * window armed autocompact at 707,789 tokens on a server that admits 196,608
 * and walked a long session into a hard context failure with the meter at 25%
 * (issue #187). These cases pin the division at the flag parser, the probe, the
 * window resolution, and the two operator surfaces that print the number.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { formatContextWindow, residentModelsSummary } from "../../src/cli/targets.js";
import { resolveContextWindowDetails } from "../../src/domains/providers/runtime-resolution.js";
import {
	llamaCppRequestContextWindow,
	parseLlamaCppServerFlags,
	probeLlamaCppProps,
	probeOpenAIModelCatalog,
} from "../../src/domains/providers/runtimes/common/probe-helpers.js";
import llamacppRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { ProbeContext, RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import { renderContextLedgerLines } from "../../src/interactive/context-overlay.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

const ROUTER_ARGS = [
	"--jinja",
	"--alias",
	"ornith1.5-35b-moe",
	"--ctx-size",
	"786432",
	"--flash-attn",
	"on",
	"--no-kv-unified",
	"--model",
	"/models/ornith.gguf",
	"--n-gpu-layers",
	"99",
	"--parallel",
	"4",
	"--reasoning",
	"on",
	"--reasoning-budget",
	"-1",
];

function window(args: ReadonlyArray<string>): ReturnType<typeof llamaCppRequestContextWindow> {
	return llamaCppRequestContextWindow(parseLlamaCppServerFlags(args));
}

describe("contracts/llama.cpp per-slot context window", () => {
	it("divides --ctx-size by --parallel unless --kv-unified", () => {
		deepStrictEqual(window(["--ctx-size", "786432", "--parallel", "4", "--no-kv-unified"]), {
			contextWindow: 196608,
			slots: { totalContextSize: 786432, slots: 4 },
		});
		deepStrictEqual(window(["--ctx-size", "786432", "--parallel", "4", "--kv-unified"]), { contextWindow: 786432 });
		deepStrictEqual(window(["--ctx-size", "786432"]), { contextWindow: 786432 }, "no --parallel leaves it unchanged");
		deepStrictEqual(window(["--ctx-size", "786432", "--parallel", "1"]), { contextWindow: 786432 });
		// Without either kv flag llama.cpp splits, which is its default.
		deepStrictEqual(window(["--ctx-size", "65536", "--parallel", "2"]), {
			contextWindow: 32768,
			slots: { totalContextSize: 65536, slots: 2 },
		});
		strictEqual(window([]), undefined);
	});

	it("reads the short spellings and the last kv flag given", () => {
		deepStrictEqual(window(["-c", "262144", "-np", "2"]), {
			contextWindow: 131072,
			slots: { totalContextSize: 262144, slots: 2 },
		});
		deepStrictEqual(window(["-c", "262144", "-np", "2", "-kvu"]), { contextWindow: 262144 });
		deepStrictEqual(window(["--ctx-size", "8192", "--parallel", "4", "--kv-unified", "--no-kv-unified"]), {
			contextWindow: 2048,
			slots: { totalContextSize: 8192, slots: 4 },
		});
		strictEqual(parseLlamaCppServerFlags(["--no-kv-unified", "--kv-unified"]).kvUnified, true);
	});

	it("keeps a negative value as a value, so --reasoning-budget -1 still parses", () => {
		const flags = parseLlamaCppServerFlags(ROUTER_ARGS);
		strictEqual(flags.reasoningBudget, -1);
		strictEqual(flags.kvUnified, false);
		strictEqual(flags.parallel, 4);
		strictEqual(flags.contextSize, 786432);
		strictEqual(flags.flashAttention, true);
	});

	describe("through the router probe", () => {
		let server: Server;
		let base = "";
		const ctx: ProbeContext = { credentialsPresent: new Set(), httpTimeoutMs: 2_000 };
		const models = {
			object: "list",
			data: [
				{ id: "ornith1.5-35b-moe", object: "model", status: { value: "sleeping", args: ROUTER_ARGS } },
				{
					id: "ornith1.5-9b-dense",
					object: "model",
					status: {
						value: "unloaded",
						args: ["--ctx-size", "262144", "--kv-unified", "--parallel", "1", "--jinja"],
					},
				},
			],
		};

		before(async () => {
			server = createServer((request, response) => {
				const url = request.url ?? "/";
				if (url.startsWith("/health")) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ status: "ok" }));
					return;
				}
				if (url.startsWith("/props?model=")) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 196608 }, build_info: "b9999" }),
					);
					return;
				}
				if (url === "/props") {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ default_generation_settings: { n_ctx: 0 }, build_info: "b9999" }));
					return;
				}
				if (url.startsWith("/v1/models") || url.startsWith("/models")) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify(models));
					return;
				}
				response.writeHead(404);
				response.end();
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});
		after(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it("reports the per-slot window and the live router sleeping state", async () => {
			const target: TargetDescriptor = { id: "mini", runtime: "llamacpp", url: base, defaultModel: "ornith1.5-35b-moe" };
			ok(llamacppRuntime.probe, "the llama.cpp runtime probes");
			const result = await llamacppRuntime.probe(target, ctx);
			ok(result.ok, result.error);
			strictEqual(result.discoveredCapabilities?.contextWindow, 196608, "the selected model's window is one slot");
			strictEqual(result.discoveredCapabilities?.parallelSlots, 2, "worker props wins over the argv fallback");
			strictEqual(result.capabilityModelId, "ornith1.5-35b-moe");
			strictEqual(result.modelCapabilities?.["ornith1.5-35b-moe"]?.contextWindow, 196608, "the catalog row too");
			strictEqual(result.modelCapabilities?.["ornith1.5-9b-dense"]?.contextWindow, 262144, "--kv-unified is undivided");
			deepStrictEqual(result.modelStates?.["ornith1.5-35b-moe"], {
				state: "unloaded",
				contextSlots: { totalContextSize: 786432, slots: 4 },
			});
			strictEqual(residentModelsSummary(result.modelStates), "resident: none");
			strictEqual(
				result.modelStates?.["ornith1.5-35b-moe"]?.contextLength,
				undefined,
				"a split is not a loaded window: the router lists sleeping and unloaded models with their args too",
			);
			deepStrictEqual(result.modelStates?.["ornith1.5-9b-dense"], { state: "unloaded" });
			const note = result.notes?.find((entry) => entry.includes("196,608 (786,432 / 4 slots)"));
			ok(note, `the probe note names the division: ${JSON.stringify(result.notes)}`);
			ok(note.includes("--parallel"), note);
		});

		it("enriches slots only when the props fixture reports total_slots", async () => {
			strictEqual((await probeLlamaCppProps(base, ctx, "ornith1.5-35b-moe")).discoveredCapabilities?.parallelSlots, 2);
			strictEqual((await probeLlamaCppProps(base, ctx)).discoveredCapabilities?.parallelSlots, undefined);
		});

		it("the shared catalog probe attaches the split without claiming residency", async () => {
			const catalog = await probeOpenAIModelCatalog(base, ctx);
			strictEqual(catalog.modelCapabilities["ornith1.5-35b-moe"]?.contextWindow, 196608);
			strictEqual(catalog.modelStates["ornith1.5-35b-moe"]?.state, "unloaded");
			strictEqual(catalog.modelStates["ornith1.5-9b-dense"]?.contextSlots, undefined);
		});
	});

	it("carries the split into the window details only while the probe decides the window", () => {
		const runtime: RuntimeDescriptor = {
			id: "llamacpp",
			displayName: "llama.cpp",
			kind: "http",
			tier: "local-native",
			apiFamily: "openai-completions",
			auth: "api-key",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, contextWindow: 32768 },
			synthesizeModel() {
				throw new Error("not used in this test");
			},
		};
		const target: TargetDescriptor = { id: "mini", runtime: "llamacpp", capabilities: {} };
		const slots = { totalContextSize: 786432, slots: 4 };

		const probed = resolveContextWindowDetails(target, runtime, "ornith", null, 196608, null, undefined, slots);
		strictEqual(probed.effectiveContextWindow, 196608);
		strictEqual(probed.contextWindowSource, "probe");
		deepStrictEqual(probed.contextWindowSlots, slots);

		const loaded = resolveContextWindowDetails(target, runtime, "ornith", null, 196608, 100000, undefined, slots);
		strictEqual(loaded.effectiveContextWindow, 100000);
		strictEqual(loaded.contextWindowSlots, null, "a loaded window is not explained by the split");

		const overridden = resolveContextWindowDetails(
			{ ...target, capabilities: { contextWindow: 65536 } },
			runtime,
			"ornith",
			null,
			null,
			null,
			undefined,
			slots,
		);
		strictEqual(overridden.contextWindowSlots, null, "an override is not explained by the split either");
	});

	it("/context and targets print the share with its derivation", () => {
		const ledger = buildContextLedger({
			provider: "mini",
			model: "ornith1.5-35b-moe",
			contextWindow: 196608,
			contextWindowSource: "probe",
			contextWindowSlots: { totalContextSize: 786432, slots: 4 },
			compactionThreshold: 0.9,
			compactionAuto: true,
			messageTokens: 20000,
		});
		const summary = renderContextLedgerLines(ledger, 100)
			.map(stripAnsi)
			.find((line) => line.includes("tokens ("));
		ok(summary, "the overlay has a summary line");
		ok(summary.includes("/ 196,608 (786,432 / 4 slots) tokens"), summary);
		ok(summary.includes("probed window"), summary);

		strictEqual(
			formatContextWindow({
				capabilities: { ...EMPTY_CAPABILITIES, contextWindow: 196608 },
				contextWindowProvenance: "discovered",
				target: { id: "mini", runtime: "llamacpp", defaultModel: "ornith1.5-35b-moe" },
				discoveredModelStates: {
					"ornith1.5-35b-moe": { state: "unknown", contextSlots: { totalContextSize: 786432, slots: 4 } },
				},
			}),
			"ctx 196608 (786432 / 4 slots)",
		);
		strictEqual(
			formatContextWindow({
				capabilities: { ...EMPTY_CAPABILITIES, contextWindow: 262144 },
				contextWindowProvenance: "discovered",
			}),
			"ctx 262144",
		);
	});
});
