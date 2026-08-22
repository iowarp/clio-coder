import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider as registerFauxProvider } from "../../src/engine/api-registry.js";
import type { AgentEvent, EngineModel } from "../../src/engine/types.js";
import { invokeRegisteredTool, resolveAgentTools } from "../../src/tools/agent-tools.js";
import type { ToolResult, ToolSpec } from "../../src/tools/registry.js";
import { createRegistry } from "../../src/tools/registry.js";
import {
	deterministicDiagnosticSummary,
	type ToolResultDisposition,
	type ToolResultDispositionMetadata,
	toolResultContextText,
	toolResultPresentationPolicy,
	toolResultPresentationText,
} from "../../src/tools/result-disposition.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";

const roots: string[] = [];
const savedEnv = {
	CLIO_CODER_HOME: process.env.CLIO_CODER_HOME,
	CLIO_CODER_DATA_DIR: process.env.CLIO_CODER_DATA_DIR,
	CLIO_CODER_CONFIG_DIR: process.env.CLIO_CODER_CONFIG_DIR,
	CLIO_CODER_STATE_DIR: process.env.CLIO_CODER_STATE_DIR,
	CLIO_CODER_CACHE_DIR: process.env.CLIO_CODER_CACHE_DIR,
};

function restoreEnv(key: keyof typeof savedEnv, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function useStateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-result-disposition-"));
	roots.push(root);
	process.env.CLIO_CODER_HOME = root;
	process.env.CLIO_CODER_DATA_DIR = join(root, "data");
	process.env.CLIO_CODER_CONFIG_DIR = join(root, "config");
	process.env.CLIO_CODER_STATE_DIR = join(root, "state");
	process.env.CLIO_CODER_CACHE_DIR = join(root, "cache");
	resetXdgCache();
	return process.env.CLIO_CODER_STATE_DIR;
}

function contextDisposition(mode: "full" | "bounded" | "summary" | "metadata-only", maxBytes: number) {
	return mode === "full" ? ({ mode } as const) : ({ mode, maxBytes } as const);
}

function disposition(
	mode: "full" | "bounded" | "summary" | "metadata-only",
	foldDefault: "folded" | "expanded",
	maxBytes: number,
): ToolResultDisposition {
	return {
		presentation: {
			foldDefault,
			showDiffWhenFolded: false,
			failureExcerpt: true,
			maxBytes: 8_192,
		},
		context: contextDisposition(mode, maxBytes),
	};
}

function mockSpec(
	resultDisposition: ToolResultDisposition | undefined,
	result: ToolResult = { kind: "ok", output: "" },
	hardMaxBytes = 8_192,
): ToolSpec {
	return {
		name: ToolNames.Read,
		description: "disposition test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		metadata: {
			objective: "exercise result disposition",
			uiLabel: "Disposition",
			retrySafety: "idempotent",
			costLatency: "local_fast",
			resultSizePolicy: {
				kind: "bounded",
				maxBytes: hardMaxBytes,
				followUpHint: "call read with offset and limit",
			},
			...(resultDisposition === undefined ? {} : { resultDisposition }),
		},
		run: async () => result,
	};
}

function metadata(result: ToolResult): ToolResultDispositionMetadata {
	const value = result.details?.resultDisposition;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("missing resultDisposition metadata");
	}
	return value as unknown as ToolResultDispositionMetadata;
}

function resultText(result: ToolResult): string {
	return result.kind === "ok" ? result.output : result.message;
}

function allowAllSafety() {
	return {
		classify: () => ({ actionClass: "read" as const, reasons: [] }),
		evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "read" as const, reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	};
}

describe("contracts/tool-result disposition", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		for (const [key, value] of Object.entries(savedEnv)) {
			restoreEnv(key as keyof typeof savedEnv, value);
		}
		resetXdgCache();
	});

	it("keeps every context mode independent from folded and expanded presentation", () => {
		useStateDir();
		const source = Array.from({ length: 80 }, (_, index) => `line ${index + 1}: αβγ🙂`).join("\n");
		const facts = { exitCode: 0, safety: { decision: "allow" }, continuation: "inspect the offload if needed" };
		const modes = ["full", "bounded", "summary", "metadata-only"] as const;

		for (const mode of modes) {
			const folded = shapeToolResult(
				mockSpec(disposition(mode, "folded", 640)),
				{ kind: "ok", output: source, details: facts },
				{ sessionId: `session-${mode}`, toolCallId: "same-call" },
			);
			const expanded = shapeToolResult(
				mockSpec(disposition(mode, "expanded", 640)),
				{ kind: "ok", output: source, details: facts },
				{ sessionId: `session-${mode}`, toolCallId: "same-call" },
			);
			const foldedMetadata = metadata(folded);
			const expandedMetadata = metadata(expanded);

			strictEqual(foldedMetadata.presentation.foldDefault, "folded");
			strictEqual(expandedMetadata.presentation.foldDefault, "expanded");
			strictEqual(toolResultPresentationPolicy(folded)?.foldDefault, "folded");
			strictEqual(toolResultPresentationPolicy(expanded)?.foldDefault, "expanded");
			strictEqual(foldedMetadata.contextBytes, expandedMetadata.contextBytes, mode);
			strictEqual(toolResultContextText(folded), toolResultContextText(expanded), mode);
			strictEqual(foldedMetadata.context.requestedMode, mode);
			strictEqual(foldedMetadata.context.appliedMode, mode);
			strictEqual(foldedMetadata.applications, 1);
			strictEqual(Buffer.byteLength(toolResultContextText(folded), "utf8"), foldedMetadata.contextBytes);
			strictEqual(resultText(folded), source, "presentation remains complete and independent");
			ok(toolResultContextText(folded).includes('"exitCode":0'), mode);
			ok(toolResultContextText(folded).includes('"safety"'), mode);
			ok(toolResultContextText(folded).includes('"continuation"'), mode);
			if (mode !== "full") ok(foldedMetadata.contextBytes <= 640, mode);
		}
	});

	it("produces stable UTF-8-safe bounded excerpts and deterministic code summaries", () => {
		useStateDir();
		const source = `${"🙂αλφα\n".repeat(240)}terminal diagnostic Ω`;
		for (const mode of ["bounded", "summary"] as const) {
			const spec = mockSpec(disposition(mode, "folded", 420));
			const first = shapeToolResult(spec, { kind: "ok", output: source }, { sessionId: mode, toolCallId: "stable" });
			const second = shapeToolResult(spec, { kind: "ok", output: source }, { sessionId: mode, toolCallId: "stable" });
			const firstContext = toolResultContextText(first);
			strictEqual(firstContext, toolResultContextText(second));
			ok(Buffer.byteLength(firstContext, "utf8") <= 420);
			strictEqual(Buffer.from(firstContext, "utf8").toString("utf8"), firstContext);
			strictEqual(firstContext.includes("�"), false);
			if (mode === "summary") {
				deepStrictEqual(metadata(first).summaryProvenance, metadata(second).summaryProvenance);
				strictEqual(metadata(first).summaryProvenance?.producer, "code");
				strictEqual(metadata(first).summaryProvenance?.algorithm, "sha256-head-tail-v1");
			}
		}
	});

	it("downgrades full explicitly at the hard budget and retains the offload artifact", () => {
		const stateDir = useStateDir();
		const source = `${"payload🙂".repeat(300)}\nfinal failure evidence`;
		const shaped = shapeToolResult(
			mockSpec(disposition("full", "expanded", 4_096), { kind: "ok", output: source }, 320),
			{ kind: "ok", output: source },
			{ sessionId: "hard-budget", toolCallId: "full-call" },
		);
		const applied = metadata(shaped);

		deepStrictEqual(applied.downgrade, { from: "full", to: "bounded", reason: "hard-budget" });
		strictEqual(applied.context.requestedMode, "full");
		strictEqual(applied.context.appliedMode, "bounded");
		strictEqual(applied.contextTruncated, true);
		ok(applied.contextBytes <= 320);
		ok(applied.offloadPath);
		strictEqual(applied.offloadPath, join(stateDir, "scratch", "hard-budget", "full-call.txt"));
		strictEqual(readFileSync(applied.offloadPath, "utf8"), source);
		ok(toolResultContextText(shaped).includes("retrieve="));
		strictEqual(toolResultContextText(shaped).includes(source), false);
	});

	it("retains outcome, safety, evidence, continuation, byte counts, and retrieval in metadata-only results", () => {
		useStateDir();
		const facts = {
			exitCode: 7,
			safety: { decision: "allow", evidenceRecorded: true },
			evidence: { receipt: "receipt.json" },
			continuation: "read the artifact with offset=1",
		};
		const cases: ToolResult[] = [
			{ kind: "ok", output: "successful secret-sized payload", details: facts },
			{ kind: "error", message: "failing secret-sized payload", details: facts },
		];

		for (const [index, input] of cases.entries()) {
			const shaped = shapeToolResult(mockSpec(disposition("metadata-only", "folded", 1_024), input), input, {
				sessionId: "metadata",
				toolCallId: `call-${index}`,
			});
			const applied = metadata(shaped);
			const context = toolResultContextText(shaped);
			strictEqual(applied.capturedBytes, Buffer.byteLength(resultText(input), "utf8"));
			strictEqual(applied.displayedBytes, Buffer.byteLength(resultText(shaped), "utf8"));
			strictEqual(applied.contextBytes, Buffer.byteLength(context, "utf8"));
			strictEqual(applied.contextTruncated, true);
			strictEqual(applied.context.appliedMode, "metadata-only");
			strictEqual(shaped.details?.exitCode, 7);
			deepStrictEqual(shaped.details?.safety, facts.safety);
			deepStrictEqual(shaped.details?.evidence, facts.evidence);
			strictEqual(shaped.details?.continuation, facts.continuation);
			ok(context.includes(`kind=${input.kind}`));
			ok(context.includes('"exitCode":7'));
			ok(context.includes('"safety"'));
			ok(context.includes('"evidence"'));
			ok(context.includes('"continuation"'));
			ok(context.includes("capturedBytes="));
			ok(context.includes("retrieve="));
			strictEqual(context.includes(resultText(input)), false);
			ok(applied.offloadPath && existsSync(applied.offloadPath));
			strictEqual(readFileSync(applied.offloadPath, "utf8"), resultText(input));
		}
	});

	it("applies the normalized disposition once after middleware changes the terminal result", async () => {
		useStateDir();
		const afterInputs: MiddlewareHookInput[] = [];
		const middleware: MiddlewareContract = {
			runHook(input) {
				if (input.hook === "after_tool") afterInputs.push(input);
				return {
					hook: input.hook,
					input,
					ruleIds: input.hook === "after_tool" ? ["test.annotate"] : [],
					effects:
						input.hook === "after_tool"
							? [{ kind: "annotate_tool_result", message: "middleware appended once", severity: "info" }]
							: [],
				};
			},
			listRules: () => [],
			snapshot: () => ({ version: 1, rules: [] }),
			registerHook: () => {},
			setDiagnosticSink: () => {},
		};
		const registry = createRegistry({ safety: allowAllSafety(), middleware });
		const spec = mockSpec(disposition("summary", "folded", 1_024), {
			kind: "ok",
			output: "raw tool body",
			details: { evidence: { source: "tool" } },
		});
		registry.register(spec);

		const verdict = await registry.invoke(
			{ tool: ToolNames.Read, args: {} },
			{ sessionId: "middleware", toolCallId: "call-1" },
		);
		strictEqual(verdict.kind, "ok");
		if (verdict.kind !== "ok") throw new Error("expected admitted result");
		strictEqual(afterInputs.length, 1);
		strictEqual(afterInputs[0]?.metadata?.resultBytes, Buffer.byteLength("raw tool body", "utf8"));
		const applied = metadata(verdict.result);
		strictEqual(applied.applications, 1);
		strictEqual(
			applied.capturedBytes,
			Buffer.byteLength("raw tool body\n\n[middleware:info] middleware appended once", "utf8"),
		);
		strictEqual((resultText(verdict.result).match(/middleware appended once/gu) ?? []).length, 1);
		strictEqual(shapeToolResult(spec, verdict.result, { sessionId: "middleware", toolCallId: "call-1" }), verdict.result);
	});

	it("projects only context to the model while retaining presentation text in result details", async () => {
		useStateDir();
		const source = "operator-visible exact result";
		const registry = createRegistry({ safety: allowAllSafety() });
		registry.register(mockSpec(disposition("metadata-only", "expanded", 512), { kind: "ok", output: source }));

		const projected = await invokeRegisteredTool(registry, ToolNames.Read, {});
		const modelText = projected.content[0]?.type === "text" ? projected.content[0].text : "";
		strictEqual(modelText.includes(source), false);
		ok(modelText.includes("[tool-result metadata-only]"));
		const details = projected.details as Record<string, unknown>;
		const applied = (details.resultDisposition as ToolResultDispositionMetadata | undefined) ?? null;
		strictEqual(toolResultPresentationText(projected), source);
		strictEqual(applied?.presentation.content, source);
		strictEqual(applied?.presentation.foldDefault, "expanded");
		strictEqual(applied?.contextBytes, Buffer.byteLength(modelText, "utf8"));
	});

	it("finalizes dispositioned failures as structured engine errors with independent model and presentation text", async () => {
		useStateDir();
		const source = "operator-visible failure evidence";
		const facts = {
			exitCode: 9,
			safety: { decision: "allow", evidenceRecorded: true },
			evidence: { receipt: "failure-receipt.json" },
			continuation: "inspect the retained failure artifact",
		};
		const registry = createRegistry({ safety: allowAllSafety() });
		registry.register(
			mockSpec(disposition("metadata-only", "expanded", 1_024), {
				kind: "error",
				message: source,
				details: facts,
			}),
		);
		await rejects(invokeRegisteredTool(registry, ToolNames.Read, {}), (error: unknown) => {
			return (
				error instanceof Error && error.message.includes("[tool-result metadata-only]") && !error.message.includes(source)
			);
		});

		const faux = registerFauxProvider({
			api: "result-disposition-failure",
			provider: "result-disposition-failure",
			models: [{ id: "result-disposition-failure-model" }],
			tokensPerSecond: 0,
		});
		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall(ToolNames.Read, {}, { id: "failure-call" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("failure observed"),
			]);
			const events: AgentEvent[] = [];
			const { agent } = createEngineAgent({
				initialState: {
					systemPrompt: "exercise dispositioned failure finalization",
					model: faux.getModel() as EngineModel,
					thinkingLevel: "off",
					tools: resolveAgentTools({ registry }),
					messages: [],
				},
			});
			agent.subscribe((event) => {
				events.push(event);
			});
			await agent.prompt("run the failing tool");

			const ended = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end" && event.toolCallId === "failure-call",
			);
			ok(ended);
			strictEqual(ended.isError, true);
			const modelText = ended.result.content[0]?.type === "text" ? ended.result.content[0].text : "";
			const details = ended.result.details as Record<string, unknown>;
			const applied = (details.resultDisposition as ToolResultDispositionMetadata | undefined) ?? null;

			strictEqual(modelText.includes(source), false);
			ok(modelText.includes("[tool-result metadata-only]"));
			strictEqual(toolResultPresentationText(ended.result), source);
			strictEqual(details.kind, "error");
			strictEqual(details.exitCode, 9);
			deepStrictEqual(details.safety, facts.safety);
			deepStrictEqual(details.evidence, facts.evidence);
			strictEqual(details.continuation, facts.continuation);
			strictEqual(applied?.presentation.content, source);
			strictEqual(applied?.presentation.foldDefault, "expanded");
			strictEqual(applied?.context.appliedMode, "metadata-only");
			strictEqual(applied?.contextBytes, Buffer.byteLength(modelText, "utf8"));
			ok(applied?.offloadPath && existsSync(applied.offloadPath));

			const persisted = agent.state.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === "failure-call",
			);
			ok(persisted && persisted.role === "toolResult");
			strictEqual(persisted.isError, true);
			deepStrictEqual(persisted.content, ended.result.content);
			deepStrictEqual(persisted.details, ended.result.details);
		} finally {
			faux.unregister();
		}
	});

	it("summarizes a 2-to-9-line output without duplicating lines, inflating bytes, or offloading", () => {
		const stateDir = useStateDir();
		for (const strategy of ["diagnostic", "head-tail"] as const) {
			for (let lines = 2; lines <= 9; lines += 1) {
				const label = `${strategy}/${lines}`;
				const source = Array.from({ length: lines }, (_, index) => `short line ${index + 1}`).join("\n");
				const spec: ToolSpec = mockSpec({
					presentation: { foldDefault: "folded", showDiffWhenFolded: false, failureExcerpt: true, maxBytes: 8_192 },
					context: { mode: "summary", maxBytes: 1_024, strategy },
				});
				const shaped = shapeToolResult(
					spec,
					{ kind: "ok", output: source },
					{ sessionId: `short-summary-${strategy}`, toolCallId: `call-${lines}` },
				);
				const applied = metadata(shaped);
				const context = toolResultContextText(shaped);

				ok(context.endsWith(`\n${source}`), `${label} body is the whole output verbatim: ${context}`);
				strictEqual(applied.context.appliedMode, "summary", label);
				strictEqual(applied.contextTruncated, false, label);
				strictEqual(applied.offloadPath, undefined, label);
				strictEqual(existsSync(join(stateDir, "scratch")), false, label);
				ok(context.includes("truncated=false"), label);
				ok(context.includes("retrieve="), label);
				for (let index = 1; index <= lines; index += 1) {
					const occurrences = (context.match(new RegExp(`short line ${index}\\b`, "gu")) ?? []).length;
					strictEqual(occurrences, 1, `${label} line ${index}`);
				}
			}
		}
	});

	it("keeps the honest offload and omission facts when a summary really does elide content", () => {
		useStateDir();
		const source = Array.from({ length: 40 }, (_, index) => `line ${index + 1} of a long capture`).join("\n");
		const shaped = shapeToolResult(
			mockSpec({
				presentation: { foldDefault: "folded", showDiffWhenFolded: false, failureExcerpt: true, maxBytes: 8_192 },
				context: { mode: "summary", maxBytes: 1_024, strategy: "diagnostic" },
			}),
			{ kind: "ok", output: source },
			{ sessionId: "long-summary", toolCallId: "call" },
		);
		const applied = metadata(shaped);
		const context = toolResultContextText(shaped);

		strictEqual(applied.contextTruncated, true);
		ok(applied.offloadPath && existsSync(applied.offloadPath));
		strictEqual(readFileSync(applied.offloadPath, "utf8"), source);
		ok(context.includes("truncated=true"));
		ok(context.includes(applied.offloadPath));
		ok(applied.retrieval.includes(applied.offloadPath));
		ok(context.includes("[diagnostic head]"));
	});

	it("redacts secrets under the head-tail summary strategy, not only the diagnostic one", () => {
		useStateDir();
		const secret = "api_key=abcdefghijklmnop";
		const source = `first line\n${secret}\nlast line`;
		for (const strategy of ["head-tail", "diagnostic"] as const) {
			const shaped = shapeToolResult(
				mockSpec({
					presentation: { foldDefault: "folded", showDiffWhenFolded: false, failureExcerpt: true, maxBytes: 8_192 },
					context: { mode: "summary", maxBytes: 1_024, strategy },
				}),
				{ kind: "ok", output: source },
				{ sessionId: `redact-${strategy}`, toolCallId: "call" },
			);
			const applied = metadata(shaped);
			const context = toolResultContextText(shaped);

			strictEqual(context.includes(secret), false, strategy);
			ok(context.includes("api_key=[redacted:assignment]"), strategy);
			strictEqual(applied.summaryProvenance?.redactions, 1, strategy);
			strictEqual(resultText(shaped), source, `${strategy} presentation stays unredacted and independent`);
			// Redaction removes captured bytes, so retrieval facts stay honest.
			strictEqual(applied.contextTruncated, true, strategy);
			ok(applied.offloadPath && existsSync(applied.offloadPath), strategy);
		}
	});

	it("keeps NUL out of model context in every mode without cutting UTF-8 or ANSI escapes", () => {
		useStateDir();
		const ansi = "\u001b[31mred diagnostic\u001b[0m";
		const source = `head 🙂 line\u0000\n${ansi}\u0000 middle\nERROR tail 🙂\u0000`;
		for (const mode of ["full", "bounded", "summary", "metadata-only"] as const) {
			const shaped = shapeToolResult(
				mockSpec(disposition(mode, "folded", 2_048), { kind: "ok", output: source }),
				{ kind: "ok", output: source },
				{ sessionId: `nul-${mode}`, toolCallId: "call" },
			);
			const applied = metadata(shaped);
			const context = toolResultContextText(shaped);

			strictEqual(context.includes("\u0000"), false, `${mode} passes no raw NUL to the model`);
			strictEqual(context.includes("�"), false, mode);
			strictEqual(Buffer.from(context, "utf8").toString("utf8"), context, mode);
			strictEqual(applied.contextBytes, Buffer.byteLength(context, "utf8"), mode);
			ok(applied.contextBytes <= 2_048, mode);
			// Dropping NUL drops captured bytes, so every mode keeps retrieval.
			strictEqual(applied.contextTruncated, true, mode);
			ok(applied.offloadPath && existsSync(applied.offloadPath), mode);
			strictEqual(readFileSync(applied.offloadPath, "utf8"), source, mode);
			strictEqual(resultText(shaped), source, `${mode} presentation keeps the captured bytes`);
			if (mode !== "metadata-only") {
				ok(context.includes(ansi), `${mode} keeps whole ANSI escape sequences`);
				ok(context.includes("🙂"), mode);
			}
		}
	});

	it("fails closed to metadata-only when a result-disposition resolver throws", async () => {
		useStateDir();
		const source = "resolver-failure payload";
		const registry = createRegistry({ safety: allowAllSafety() });
		registry.register({
			...mockSpec(disposition("bounded", "folded", 4_096), { kind: "ok", output: source }),
			resolveResultDisposition: () => {
				throw new Error("resolver exploded");
			},
		});

		const projected = await invokeRegisteredTool(registry, ToolNames.Read, {});
		const modelText = projected.content[0]?.type === "text" ? projected.content[0].text : "";
		const applied = (projected.details as Record<string, unknown>).resultDisposition as ToolResultDispositionMetadata;

		strictEqual(applied.context.requestedMode, "metadata-only", "a failed resolver may not falsify requestedMode");
		strictEqual(applied.context.appliedMode, "metadata-only", "a failed resolver may not widen model context");
		strictEqual(modelText.includes(source), false);
		ok(modelText.includes("[tool-result metadata-only]"));
		// The narrowing is never silent: the metadata names the cause, the model
		// header says why its context is facts-only, and the operator row carries
		// the same diagnostic beside the complete presentation text.
		deepStrictEqual(applied.fallback, { reason: "resolver-error", message: "resolver exploded" });
		ok(modelText.includes('fallback=resolver-error "resolver exploded"'), modelText);
		const presentation = toolResultPresentationText(projected) ?? "";
		ok(presentation.startsWith(source), presentation);
		ok(presentation.includes("fell back to metadata-only: resolver-error (resolver exploded)"), presentation);
		strictEqual(applied.displayedBytes, Buffer.byteLength(presentation, "utf8"));

		// A resolver that returns normally records no fallback at all.
		const healthy = createRegistry({ safety: allowAllSafety() });
		healthy.register({
			...mockSpec(disposition("bounded", "folded", 4_096), { kind: "ok", output: source }),
			resolveResultDisposition: (_args, declared) => declared,
		});
		const intact = await invokeRegisteredTool(healthy, ToolNames.Read, {});
		const intactMetadata = (intact.details as Record<string, unknown>).resultDisposition as ToolResultDispositionMetadata;
		strictEqual(intactMetadata.fallback, undefined);
		strictEqual(toolResultPresentationText(intact), source);
	});

	it("treats whitespace-only output as complete in summary mode and writes no offload for it", async () => {
		const stateDir = useStateDir();
		const blank = "   \n\t\n";
		deepStrictEqual(deterministicDiagnosticSummary(blank, 1_024), { text: "", redactions: 0, complete: true });
		const shaped = shapeToolResult(
			mockSpec({
				...disposition("summary", "folded", 4_096),
				context: { mode: "summary", maxBytes: 4_096, strategy: "diagnostic" },
			}),
			{ kind: "ok", output: blank },
			{ sessionId: "blank-summary", toolCallId: "call" },
		);
		const applied = metadata(shaped);
		strictEqual(applied.contextTruncated, false);
		strictEqual(applied.offloadPath, undefined);
		ok(toolResultContextText(shaped).includes("truncated=false"));
		strictEqual(existsSync(join(stateDir, "scratch", "blank-summary")), false);
	});

	it("leaves undeclared legacy shaping and agent-tool rejection behavior unchanged", async () => {
		const original: ToolResult = { kind: "ok", output: "legacy output" };
		const shaped = shapeToolResult(mockSpec(undefined), original, { sessionId: "legacy", toolCallId: "call" });
		strictEqual(shaped, original);
		strictEqual(shaped.details?.resultDisposition, undefined);
		strictEqual(shaped.modelContext, undefined);

		const registry = createRegistry({ safety: allowAllSafety() });
		registry.register(mockSpec(undefined, { kind: "error", message: "legacy tool failure" }));
		const tool = resolveAgentTools({ registry }).find((candidate) => candidate.name === ToolNames.Read);
		ok(tool);
		await rejects(tool.execute("legacy-failure", {}), /legacy tool failure/u);
		await rejects(invokeRegisteredTool(registry, ToolNames.Read, {}), /legacy tool failure/u);
	});
});
