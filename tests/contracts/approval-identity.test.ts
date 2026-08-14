import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import {
	BusChannels,
	type PermissionRequestedPayload,
	type PermissionResolvedPayload,
} from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import type { PermissionAuditRecord, ToolCallAuditRecord } from "../../src/domains/safety/audit.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { createSafetyBundle } from "../../src/domains/safety/extension.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../../src/tools/registry.js";

function mockSpec(name: string, baseActionClass: ActionClass): ToolSpec {
	return {
		name: name as ToolName,
		description: "approval identity test tool",
		parameters: Type.Object({}),
		baseActionClass,
		run: async () => ({ kind: "ok", output: "ran" }),
	};
}

function registerMockTools(registry: ToolRegistry): void {
	registry.register(mockSpec(ToolNames.Read, "read"));
	registry.register(mockSpec(ToolNames.Write, "write"));
	registry.register(mockSpec(ToolNames.Bash, "execute"));
}

const bashCall = (command: string) => ({ tool: ToolNames.Bash, args: { command } });
const writeCall = (filePath: string) => ({ tool: ToolNames.Write, args: { file_path: filePath, content: "x" } });

async function settle(): Promise<void> {
	await Promise.resolve();
}

function toolCallRows(stateDir: string): ToolCallAuditRecord[] {
	const auditDir = join(stateDir, "audit");
	let files: string[];
	try {
		files = readdirSync(auditDir).filter((file) => file.endsWith(".jsonl"));
	} catch {
		return [];
	}
	return files.flatMap((file) =>
		readFileSync(join(auditDir, file), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as ToolCallAuditRecord)
			.filter((row) => row.kind === "tool_call"),
	);
}

function permissionRows(stateDir: string): PermissionAuditRecord[] {
	const auditDir = join(stateDir, "audit");
	let files: string[];
	try {
		files = readdirSync(auditDir).filter((file) => file.endsWith(".jsonl"));
	} catch {
		return [];
	}
	return files.flatMap((file) =>
		readFileSync(join(auditDir, file), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as PermissionAuditRecord)
			.filter((row) => row.kind === "permission"),
	);
}

async function withApprovalHarness<T>(
	level: AutonomyLevel,
	fn: (input: {
		registry: ToolRegistry;
		bus: SafeEventBus;
		requests: PermissionRequestedPayload[];
		resolutions: PermissionResolvedPayload[];
	}) => Promise<T>,
): Promise<
	T & {
		rows: ToolCallAuditRecord[];
		permissionRows: PermissionAuditRecord[];
		requests: PermissionRequestedPayload[];
		resolutions: PermissionResolvedPayload[];
	}
> {
	const originalEnv = { ...process.env };
	const scratch = mkdtempSync(join(tmpdir(), "clio-approval-identity-"));
	const stateDir = join(scratch, "state");
	process.env.CLIO_CODER_HOME = scratch;
	process.env.CLIO_CODER_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CODER_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_CODER_STATE_DIR = stateDir;
	process.env.CLIO_CODER_CACHE_DIR = join(scratch, "cache");
	resetXdgCache();

	const bus = createSafeEventBus();
	const requests: PermissionRequestedPayload[] = [];
	const resolutions: PermissionResolvedPayload[] = [];
	bus.on(BusChannels.PermissionRequested, (payload) => {
		requests.push(payload);
	});
	bus.on(BusChannels.PermissionResolved, (payload) => {
		resolutions.push(payload);
	});
	const context: DomainContext = { bus, getContract: () => undefined };
	const bundle = createSafetyBundle(context);
	const registry = createRegistry({ safety: bundle.contract, autonomy: () => level });
	registerMockTools(registry);
	registry.onPermissionRequired((call, decision, meta) => {
		bus.emit(BusChannels.PermissionRequested, {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			origin: "main",
			axis: meta.axis,
			...(decision.kind === "ask" ? { rejection: decision.rejection } : {}),
			...(decision.policy?.reasonCode !== undefined ? { reasonCode: decision.policy.reasonCode } : {}),
			...(decision.policy?.ruleId !== undefined ? { ruleId: decision.policy.ruleId } : {}),
			...(decision.policy?.policySource !== undefined ? { policySource: decision.policy.policySource } : {}),
		});
	});

	let stopped = false;
	await bundle.extension.start();
	try {
		const result = await fn({ registry, bus, requests, resolutions });
		await bundle.extension.stop?.();
		stopped = true;
		return { ...result, rows: toolCallRows(stateDir), permissionRows: permissionRows(stateDir), requests, resolutions };
	} finally {
		if (!stopped) await bundle.extension.stop?.();
		for (const k of Object.keys(process.env)) {
			if (!(k in originalEnv)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(originalEnv)) {
			if (v !== undefined) process.env[k] = v;
		}
		resetXdgCache();
		rmSync(scratch, { recursive: true, force: true });
	}
}

describe("contracts/approval identity", () => {
	it("safety.evaluate records ask classification without publishing a request", async () => {
		const { requests, rows } = await withApprovalHarness("full-auto", async ({ registry, requests }) => {
			const pending = registry.invoke(bashCall("truncate -s 0 server.log"));
			await settle();
			strictEqual(registry.hasParkedCalls(), true);
			strictEqual(requests.length, 1, "the registry composition seam publishes the real request");
			registry.cancelParkedCalls("operator declined");
			await pending;
			return {};
		});

		deepStrictEqual(
			rows.map((row) => row.decision),
			["classified", "permission_requested"],
		);
		strictEqual(requests.length, 1);
		strictEqual(requests[0]?.axis?.startsWith("net:"), true);
	});

	it("read-only mutation denial never publishes PermissionRequested and writes one denied row", async () => {
		const { requests, rows } = await withApprovalHarness("read-only", async ({ registry }) => {
			const verdict = await registry.invoke(writeCall("notes/read-only.txt"));
			strictEqual(verdict.kind, "blocked");
			return {};
		});

		strictEqual(requests.length, 0);
		strictEqual(rows.filter((row) => row.decision === "denied").length, 1);
	});

	it("permission request audit rows are written only for non-main origins", async () => {
		const { permissionRows } = await withApprovalHarness("auto-edit", async ({ bus }) => {
			bus.emit(BusChannels.PermissionRequested, {
				tool: "bash",
				actionClass: "execute",
				requestId: "main-req",
				origin: "main",
				axis: "autonomy:auto-edit",
				rejection: { short: "main ask", detail: "main ask", hints: [] },
			});
			bus.emit(BusChannels.PermissionRequested, {
				tool: "bash",
				actionClass: "execute",
				requestId: "worker-req",
				origin: "worker:run-worker",
				axis: "net:bash-command-substitution",
				rejection: { short: "worker ask", detail: "worker ask", hints: [] },
				requestedBy: "run-worker",
			});
			bus.emit(BusChannels.PermissionRequested, {
				tool: "write",
				actionClass: "write",
				requestId: "delegation-req",
				origin: "delegation:run-delegation",
				axis: "autonomy:suggest",
				summary: "delegation ask",
				requestedBy: "run-delegation",
			});
			bus.emit(BusChannels.PermissionRequested, {
				tool: "read",
				actionClass: "read",
				requestId: "legacy-main",
				axis: "autonomy:auto-edit",
				summary: "legacy ask",
			});
			await settle();
			return {};
		});

		deepStrictEqual(
			permissionRows.map((row) => [row.status, row.requestId, row.origin, row.tool, row.actionClass, row.reason]),
			[
				["requested", "worker-req", "worker:run-worker", "bash", "execute", "worker ask"],
				["requested", "delegation-req", "delegation:run-delegation", "write", "write", "delegation ask"],
			],
		);
	});

	it("ACP permission request audit rows are deduped by requestId", async () => {
		const { permissionRows } = await withApprovalHarness("auto-edit", async ({ bus }) => {
			const duplicateRequest: PermissionRequestedPayload = {
				tool: "bash",
				actionClass: "execute",
				requestId: "acp-dup",
				origin: "acp-server",
				axis: "autonomy:auto-edit",
				rejection: { short: "ACP ask", detail: "ACP ask", hints: [] },
			};
			bus.emit(BusChannels.PermissionRequested, duplicateRequest);
			bus.emit(BusChannels.PermissionRequested, duplicateRequest);
			bus.emit(BusChannels.PermissionRequested, {
				...duplicateRequest,
				requestId: "acp-distinct",
				rejection: { short: "second ask", detail: "second ask", hints: [] },
			});
			await settle();
			return {};
		});

		deepStrictEqual(
			permissionRows.filter((row) => row.status === "requested").map((row) => [row.requestId, row.reason]),
			[
				["acp-dup", "ACP ask"],
				["acp-distinct", "second ask"],
			],
		);
	});

	it("interactive grant joins request, resolution, and tool-call audit by requestId", async () => {
		const { requests, resolutions, rows } = await withApprovalHarness(
			"auto-edit",
			async ({ registry, bus, requests }) => {
				const pending = registry.invoke(bashCall("echo hello"));
				await settle();
				const request = requests[0];
				ok(request?.requestId);
				bus.emit(BusChannels.PermissionResolved, {
					status: "granted",
					requestId: request.requestId,
					origin: "main",
					decidedBy: "operator",
					tool: request.tool,
					actionClass: request.actionClass,
					requestedBy: "tool",
				});
				await registry.resumeParkedCalls({
					actionClass: "execute",
					requestId: request.requestId,
					requestedBy: "tool:one_shot",
				});
				strictEqual((await pending).kind, "ok");
				return {};
			},
		);

		strictEqual(requests.length, 1);
		strictEqual(resolutions.length, 1);
		strictEqual(resolutions[0]?.status, "granted");
		strictEqual(resolutions[0]?.decidedBy, "operator");
		strictEqual(resolutions[0]?.requestId, requests[0]?.requestId);
		const requestedRow = rows.find((row) => row.decision === "permission_requested");
		ok(requestedRow);
		strictEqual(requestedRow.requestId, requests[0]?.requestId);
	});

	it("interactive deny resolves only the shown request by requestId", async () => {
		const { requests, resolutions } = await withApprovalHarness("auto-edit", async ({ registry, bus, requests }) => {
			const first = registry.invoke(bashCall("echo first"));
			const second = registry.invoke(bashCall("echo second"));
			await settle();
			const firstRequest = requests[0];
			const secondRequest = requests[1];
			ok(firstRequest?.requestId);
			ok(secondRequest?.requestId);
			bus.emit(BusChannels.PermissionResolved, {
				status: "denied",
				requestId: firstRequest.requestId,
				origin: "main",
				decidedBy: "operator",
				tool: firstRequest.tool,
				actionClass: firstRequest.actionClass,
				reason: "operator cancelled",
				requestedBy: "tool",
			});
			strictEqual(registry.cancelParkedCall(firstRequest.requestId, "operator cancelled"), true);
			strictEqual((await first).kind, "blocked");
			strictEqual(requests[2]?.requestId, secondRequest.requestId);
			bus.emit(BusChannels.PermissionResolved, {
				status: "granted",
				requestId: secondRequest.requestId,
				origin: "main",
				decidedBy: "operator",
				tool: secondRequest.tool,
				actionClass: secondRequest.actionClass,
				requestedBy: "tool",
			});
			await registry.resumeParkedCalls({
				actionClass: "execute",
				requestId: secondRequest.requestId,
				requestedBy: "tool:one_shot",
			});
			strictEqual((await second).kind, "ok");
			return {};
		});

		strictEqual(requests.length, 3);
		strictEqual(resolutions.length, 2);
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "operator");
		strictEqual(resolutions[0]?.requestId, requests[0]?.requestId);
		strictEqual(resolutions[1]?.status, "granted");
		strictEqual(resolutions[1]?.decidedBy, "operator");
		strictEqual(resolutions[1]?.requestId, requests[1]?.requestId);
	});

	it("headless fast-deny emits adjacent request and policy resolution with one id", async () => {
		const reason = "clio-coder run cannot confirm permission requests; rerun interactively to approve this action.";
		const { requests, resolutions } = await withApprovalHarness("auto-edit", async ({ registry, bus }) => {
			registry.onPermissionRequired((call, decision, meta) => {
				bus.emit(BusChannels.PermissionResolved, {
					status: "denied",
					requestId: meta.requestId,
					origin: "main",
					decidedBy: "policy:no-operator",
					tool: call.tool,
					actionClass: decision.classification.actionClass,
					reason,
					requestedBy: "headless",
				});
				registry.cancelParkedCalls(reason);
			});
			const verdict = await registry.invoke(bashCall("echo hello"));
			strictEqual(verdict.kind, "blocked");
			return {};
		});

		strictEqual(requests.length, 1);
		strictEqual(resolutions.length, 1);
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "policy:no-operator");
		strictEqual(resolutions[0]?.requestId, requests[0]?.requestId);
	});
});
