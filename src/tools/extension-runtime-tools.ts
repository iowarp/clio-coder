import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { type DynamicToolName, ToolNames } from "../core/tool-names.js";
import { extensionIdentity } from "../domains/extensions/activity.js";
import { extensionToolName } from "../domains/extensions/command-schema.js";
import type { ExtensionRuntimeHookBridge } from "../domains/extensions/runtime-hook-bridge.js";
import { RUNTIME_V2_LIMITS } from "../domains/extensions/runtime-schema-v2.js";
import { type InstalledExtension, isLoadableExtension } from "../domains/extensions/types.js";
import { sessionHoldsToolDetails, storeToolDetail } from "../domains/session/tool-details.js";
import { builtin } from "./builtin-tool-catalog.js";
import { createDetailLedgerTool } from "./ledger.js";
import type { ToolRegistry, ToolResult, ToolSpec } from "./registry.js";

/** What a tool returns to the model is bounded like a command tool's output. */
const RUNTIME_TOOL_OUTPUT_BYTES = 256 * 1024;

function bounded(text: string): string {
	return Buffer.byteLength(text) > RUNTIME_TOOL_OUTPUT_BYTES
		? `${Buffer.from(text).subarray(0, RUNTIME_TOOL_OUTPUT_BYTES).toString("utf8")}\n[output truncated]`
		: text;
}

/**
 * A result with a summary reaches the model as that summary and a `detail_ref`; the full output is stored for the
 * session and `ledger(action="detail", ref=...)` returns it (WTF-P 0.8.3 C3). Without a session store to hold the
 * detail, the model gets the full output as before, so nothing becomes unreachable.
 */
function compactResult(
	summary: string,
	full: string,
	sessionId: string | undefined,
): { output: string; details: { detailRef: string; detailBytes: number } } | null {
	if (sessionId === undefined || sessionId.length === 0) return null;
	let ref: string;
	try {
		ref = storeToolDetail(sessionId, full);
	} catch {
		// The session has no store directory (an unsaved or foreign session id); fall back to the full output.
		return null;
	}
	const bytes = Buffer.byteLength(full);
	return {
		output: `${summary}\ndetail_ref: ${ref} (${bytes} bytes; read it with ledger action="detail" ref="${ref}")`,
		details: { detailRef: ref, detailBytes: bytes },
	};
}

/**
 * A summary's `detail_ref` is read through `ledger(action="detail")`, which a session registers only beside dispatch.
 * Once a generation serves a runtime tool, a session without a ledger gets the detail-only one behind the gateway
 * (WTF-P 0.8.3 C3). Gateway placement with no startup prompt entry adds no schema or prompt byte to any request, so
 * the session's tool signature is the same with or without it, and it stays across reloads so a ref an earlier
 * generation produced stays readable.
 */
export function ensureDetailLedger(registry: Pick<ToolRegistry, "get" | "register">): void {
	if (registry.get(ToolNames.Ledger)) return;
	const ledger = builtin(createDetailLedgerTool(), { path: "src/tools/ledger.ts", scope: "core" });
	registry.register({
		...ledger,
		placement: "gateway",
		...(ledger.metadata ? { metadata: { ...ledger.metadata, startupPrompt: false } } : {}),
	});
}

/**
 * A resumed session whose extensions are gone still carries `detail_ref`s in its transcript, so the session switch
 * registers the detail-only ledger whenever the incoming session's detail store holds entries. The placement is the
 * same gateway one, so the session's tool schema set does not change.
 */
export function ensureDetailLedgerForSession(
	registry: Pick<ToolRegistry, "get" | "register">,
	sessionId: string | null | undefined,
): void {
	if (sessionId === null || sessionId === undefined || registry.get(ToolNames.Ledger)) return;
	if (sessionHoldsToolDetails(sessionId)) ensureDetailLedger(registry);
}

/**
 * Which promoted tools of one extension generation a session attaches, by
 * registry name. Packages are taken in id order and each manifest's own order
 * is kept, so the same generation always attaches the same set whatever order
 * discovery listed it in. Past the session cap a promoted tool is `held`: it
 * stays behind the gateway, where it still runs.
 */
export function promotedRuntimeTools(packages: ReadonlyArray<InstalledExtension>): {
	attached: ReadonlySet<string>;
	held: ReadonlyArray<string>;
} {
	const names = packages
		.filter((entry) => isLoadableExtension(entry) && entry.runtimeV2 !== undefined)
		.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
		.flatMap((entry) => (entry.runtimeV2?.promote ?? []).map((tool) => extensionToolName(entry.id, tool)));
	const unique = [...new Set(names)];
	return {
		attached: new Set(unique.slice(0, RUNTIME_V2_LIMITS.promotedToolsPerSession)),
		held: unique.slice(RUNTIME_V2_LIMITS.promotedToolsPerSession),
	};
}

/**
 * Specs for the tools the running api 2 runtimes of one extension generation
 * serve. Registering one never runs package code: a call goes to the live
 * runtime through the bridge its session host binds, so with no runtime the
 * call fails instead of starting one.
 *
 * Placement is the gateway unless the manifest promotes the tool (B2). A
 * promoted spec differs from its gateway form in placement alone: the name,
 * description, schema, action class and `run` are built the same way, so
 * admission, approval and the loop guard's call identity cannot tell the two
 * apart, and the gateway refuses a direct-placed name, which leaves one route
 * to the tool. The provider's tool schema set therefore depends only on the
 * published generation: a reload that leaves the promoted declarations alone
 * leaves it byte-identical, and one that changes them changes the session's
 * tool signature, which the next turn records as `tool_surface_change` (#423).
 *
 * A result that asks for an interview parks the call until the operator
 * finishes or cancels it, and the answers become the result.
 */
export function buildExtensionRuntimeToolSpecs(
	packages: ReadonlyArray<InstalledExtension>,
	bridge: ExtensionRuntimeHookBridge,
): ToolSpec[] {
	const specs: ToolSpec[] = [];
	const { attached } = promotedRuntimeTools(packages);
	for (const entry of packages) {
		if (!isLoadableExtension(entry) || entry.runtimeV2 === undefined) continue;
		const extensionId = entry.id;
		const owner = extensionIdentity(entry);
		for (const tool of entry.runtimeV2.tools) {
			const name = extensionToolName(extensionId, tool.name) as DynamicToolName;
			specs.push({
				name,
				description: `${tool.description}\nServed by the running ${extensionId}@${entry.version} extension runtime.`,
				parameters: tool.inputSchema as TSchema,
				baseActionClass: tool.actionClass,
				executionMode: "sequential",
				placement: attached.has(name) ? "direct" : "gateway",
				sourceInfo: { path: entry.manifestPath, scope: "domain", extension: entry.provenance, owner },
				metadata: {
					objective: tool.description,
					uiLabel: `${extensionId}/${tool.name}`,
					retrySafety: "not_retry_safe",
					readOnly: tool.readOnly,
					idempotent: tool.idempotent,
					resultSizePolicy: { kind: "bounded", maxBytes: RUNTIME_TOOL_OUTPUT_BYTES },
					costLatency: "local_slow",
				},
				async run(args, options): Promise<ToolResult> {
					if (!Value.Check(tool.inputSchema as TSchema, args))
						return { kind: "error", message: `${name}: input does not match its declared JSON schema`, details: { owner } };
					const executor = bridge.current();
					if (!executor?.tool)
						return { kind: "error", message: `${name}: the ${extensionId} runtime is not running`, details: { owner } };
					try {
						const result = await executor.tool(extensionId, tool.name, args, options?.signal);
						if (result.interview) {
							if (!executor.interview)
								return { kind: "error", message: `${name}: no operator can answer an interview here`, details: { owner } };
							const parked = await executor.interview(extensionId, result.interview, options?.signal);
							const output = bounded(
								JSON.stringify({
									interview: parked.outcome,
									...(parked.reason === undefined ? {} : { reason: parked.reason }),
									answers: parked.answers,
									...(parked.notes === undefined ? {} : { notes: parked.notes }),
									...(parked.other === undefined ? {} : { other: parked.other }),
									...(parked.scripted === undefined ? {} : { scripted: parked.scripted }),
									text: parked.text,
								}),
							);
							// The interview's shape rides the details, which the session ledger keeps, so a reader such as
							// `campaign run` counts the gates a run reached without parsing what the model was shown.
							const details = {
								owner,
								interview: {
									outcome: parked.outcome,
									...(parked.reason === undefined ? {} : { reason: parked.reason }),
									checkpoints: parked.checkpoints ?? [],
								},
							};
							return parked.outcome === "done" ? { kind: "ok", output, details } : { kind: "error", message: output, details };
						}
						const full = result.data === undefined ? result.text : `${result.text}\n${JSON.stringify(result.data)}`;
						const compact = result.summary === undefined ? null : compactResult(result.summary, full, options?.sessionId);
						const output = compact?.output ?? bounded(full);
						const details = { owner, ...(compact?.details ?? {}) };
						return result.isError === true ? { kind: "error", message: output, details } : { kind: "ok", output, details };
					} catch (error) {
						return {
							kind: "error",
							message: `${name}: ${error instanceof Error ? error.message : String(error)}`,
							details: { owner },
						};
					}
				},
			});
		}
	}
	return specs;
}
