import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioDataDir, clioStateDir } from "../../src/core/xdg.js";
import { buildEvidence } from "../../src/domains/evidence/index.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { invokeRegisteredTool, type ToolFinishEvent } from "../../src/tools/agent-tools.js";
import { createDataTool } from "../../src/tools/gateway/data-tool.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createRegistry } from "../../src/tools/registry.js";
import { fixtureEnvelope } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

describe("gateway correction contracts", () => {
	let env: Awaited<ReturnType<typeof isolateClioEnv>>;
	beforeEach(async () => {
		env = await isolateClioEnv("gateway-corrections-");
	});
	afterEach(() => env.restore());

	it("refuses normalized protected data paths before the reader runs", async () => {
		const cwd = clioStateDir();
		const registry = createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "read-only" });
		let reads = 0;
		const data = createDataTool({ getCwd: () => cwd });
		registry.register({
			...data,
			placement: "gateway",
			run: async () => {
				reads++;
				return { kind: "ok", output: "unexpected read" };
			},
		});
		registry.register(createGatewayTool({ registry }));
		for (const path of [".env", " .env ", "\t./.env\n", join(cwd, ".env")]) {
			for (const tool of ["data", "gateway"]) {
				const args = { op: "inspect", path };
				const result = await registry.invoke({
					tool,
					args: tool === "data" ? args : { op: "call", capability: "data", args },
				});
				strictEqual(result.kind, "blocked", path);
			}
		}
		strictEqual(reads, 0);
	});

	it("preserves execute and write decisions and finish telemetry at every approval level, including executed errors", async () => {
		for (const actionClass of ["write", "execute"] as const) {
			for (const level of ["read-only", "suggest", "auto-edit", "full-auto"] as const) {
				for (const fails of [false, true]) {
					const records = [];
					for (const placement of ["direct", "gateway"] as const) {
						const registry = createRegistry({ safety: createWorkerSafety({ cwd: clioStateDir() }), autonomy: () => level });
						const name = ToolNames.Artifact;
						let runs = 0;
						registry.register({
							name,
							placement,
							description: "Authority fixture",
							parameters: Type.Object({}),
							baseActionClass: actionClass,
							safetyCall: () => ({
								tool: actionClass === "execute" ? "bash" : "write",
								args: actionClass === "execute" ? { command: "custom-science-executable" } : { path: "report.txt" },
							}),
							run: async () => {
								runs++;
								return fails ? { kind: "error", message: "executed failure" } : { kind: "ok", output: "done" };
							},
						});
						registry.register(createGatewayTool({ registry }));
						const parks: string[] = [];
						registry.onPermissionRequired((_call, decision, meta) => {
							parks.push(decision.classification.actionClass);
							void registry.resumeParkedCalls({
								actionClass: decision.classification.actionClass,
								requestId: meta.requestId,
								requestedBy: "test",
							});
						});
						const tool = placement === "direct" ? name : ToolNames.Gateway;
						const args = placement === "direct" ? {} : { op: "call", capability: name, args: {} };
						const verdict = await registry.invoke({ tool, args });
						ok(verdict.kind !== "not_visible");
						strictEqual(verdict.decision.classification.actionClass, actionClass);
						const events: ToolFinishEvent[] = [];
						await invokeRegisteredTool(registry, tool, args, {
							telemetry: { onFinish: (event) => events.push(event) },
						}).catch(() => {});
						strictEqual(events.length, 1);
						strictEqual(events[0]?.tool, tool);
						strictEqual(events[0]?.actionClass, actionClass);
						strictEqual(runs, level === "read-only" ? 0 : 2);
						strictEqual(parks.length, level === "suggest" || (actionClass === "execute" && level === "auto-edit") ? 2 : 0);
						const event = events[0];
						ok(event);
						const { tool: _tool, durationMs: _duration, ...finish } = event;
						records.push({ decision: verdict.decision, kind: verdict.kind, finish, parks });
					}
					deepStrictEqual(records[1], records[0]);
				}
			}
		}
	});

	it("exports capability identity in paired, unpaired, result-only evidence and transcripts", async () => {
		await mkdir(clioStateDir(), { recursive: true });
		await writeFile(
			join(clioStateDir(), "runs.json"),
			JSON.stringify([{ ...fixtureEnvelope("fixture"), sessionId: "session-1" }]),
		);
		for (const capability of ["artifact", "git"]) {
			const projections = [];
			for (const gateway of [false, true]) {
				const tool = gateway ? "gateway" : capability;
				const args = { op: "log", path: "report.md" };
				const entries: unknown[] = [];
				const message = (role: string, id: string, payload: unknown) => ({
					kind: "message",
					role,
					turnId: id,
					parentTurnId: null,
					timestamp: "2026-09-16T00:00:00.000Z",
					payload,
				});
				for (const id of ["paired", "unpaired"])
					entries.push(
						message("tool_call", id, { id, name: tool, args: gateway ? { op: "call", capability, args } : args }),
					);
				for (const id of ["paired", "result-only"])
					entries.push(
						message("tool_result", `${id}-result`, {
							toolCallId: id,
							toolName: tool,
							result: { kind: "ok", output: "done", details: gateway && id === "result-only" ? { capability } : {} },
						}),
					);
				const dir = join(clioStateDir(), "sessions", "workspace", "session-1");
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, "current.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
				const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), sessionId: "session-1" });
				const events = (await readFile(join(built.directory, "tool-events.jsonl"), "utf8"))
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				strictEqual(events.length, 3);
				for (const event of events) strictEqual(event.tool, capability);
				deepStrictEqual(events.map((event) => event.linkKind).sort(), [
					"session-tool-call",
					"session-tool-call-result",
					"session-tool-result",
				]);
				const transcript = await readFile(join(built.directory, "transcript.md"), "utf8");
				doesNotMatch(transcript, /tool_(?:call|result) gateway/);
				match(transcript, new RegExp(`tool_call ${capability}`));
				match(transcript, new RegExp(`tool_result ${capability}`));
				projections.push({ events, transcript: transcript.split("## Linked Session Transcript")[1] });
			}
			deepStrictEqual(projections[1], projections[0]);
		}
	});
});
