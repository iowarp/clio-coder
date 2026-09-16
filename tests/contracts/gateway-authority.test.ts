import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ToolCallAuditInput } from "../../src/domains/safety/audit.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import type { SafetyContract, SafetyDecision } from "../../src/domains/safety/contract.js";
import { foldSessionArtifacts } from "../../src/domains/session/session-artifacts.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createArtifactTool } from "../../src/tools/artifact.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createRegistry, type RegistryVerdict, type ToolRegistry } from "../../src/tools/registry.js";
import { gitTool } from "../../src/tools/safe-exec.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Direct and gateway invocation preserve the same authority and evidence
 * (v0.4.9 mandate §8). For a write-class capability (artifact) and an
 * execute-plane one (git), the policy decision, the park/approval behavior at
 * every autonomy level, and the audit and ledger records are equal whether the
 * capability is invoked directly, in a registry that places it direct, or
 * through `gateway call`.
 */

const LEVELS: ReadonlyArray<AutonomyLevel> = ["read-only", "suggest", "auto-edit", "full-auto"];
const roots: string[] = [];

function scratch(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-gateway-authority-")));
	roots.push(root);
	return root;
}

interface ParkRecord {
	tool: string;
	actionClass: string;
	short: string;
}

interface Harness {
	cwd: string;
	registry: ToolRegistry;
	rows: ToolCallAuditInput[];
	parks: ParkRecord[];
}

/**
 * The two registries run in their own scratch workspaces, and the policy
 * decision records the workspace it evaluated in. Replace it with a marker so
 * the comparison is about the decision, not about which temp dir hosted it.
 */
function neutral<T>(value: T, cwd: string): T {
	return JSON.parse(JSON.stringify(value).split(cwd).join("<cwd>")) as T;
}

function auditing(base: SafetyContract, rows: ToolCallAuditInput[]): SafetyContract {
	return {
		...base,
		audit: {
			recordCount: () => rows.length,
			recordToolCall: (input) => {
				rows.push(input);
			},
		},
	};
}

/** Build the registry under test; `placement` decides whether artifact and git are attached or gatewayed. */
function harness(
	cwd: string,
	level: AutonomyLevel,
	placement: "direct" | "gateway",
	answer: "approve" | "deny",
): Harness {
	const rows: ToolCallAuditInput[] = [];
	const parks: ParkRecord[] = [];
	const registry = createRegistry({ safety: auditing(createWorkerSafety({ cwd }), rows), autonomy: () => level });
	registry.register({ ...createArtifactTool({ getCwd: () => cwd }), placement });
	registry.register({ ...gitTool, placement });
	registry.register(createGatewayTool({ registry }));
	registry.onPermissionRequired((call, decision, meta) => {
		parks.push({
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			short: "rejection" in decision ? decision.rejection.short : "",
		});
		if (answer === "approve") {
			void registry.resumeParkedCalls({
				actionClass: decision.classification.actionClass,
				requestId: meta.requestId,
				requestedBy: "test",
			});
		} else {
			registry.cancelParkedCall(meta.requestId, "denied by the operator");
		}
	});
	return { cwd, registry, rows, parks };
}

const ARTIFACT_ARGS = { kind: "report", content: "# Findings\n\nAll equal.\n", path: "notes/REPORT.md" };
const GIT_ARGS = { op: "log", limit: 1 };

function invokeDirect(registry: ToolRegistry, tool: string, args: Record<string, unknown>): Promise<RegistryVerdict> {
	return registry.invoke({ tool, args });
}

function invokeGateway(registry: ToolRegistry, tool: string, args: Record<string, unknown>): Promise<RegistryVerdict> {
	return registry.invoke({ tool: ToolNames.Gateway, args: { op: "call", capability: tool, args } });
}

/** Audit rows for one capability, with the per-registry request id removed and the workspace neutralized. */
function capabilityRows(source: Harness, tool: string): Array<Record<string, unknown>> {
	return neutral(
		source.rows
			.filter((row) => row.tool === tool)
			.map(({ requestId: _requestId, now: _now, ...rest }) => ({ ...rest }) as Record<string, unknown>),
		source.cwd,
	);
}

function blockedDecision(source: Harness, verdict: RegistryVerdict): SafetyDecision {
	if (verdict.kind !== "blocked") throw new Error(`expected a blocked verdict, got ${verdict.kind}`);
	return neutral(verdict.decision, source.cwd);
}

function okResult(verdict: RegistryVerdict) {
	if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error(JSON.stringify(verdict));
	return verdict.result;
}

describe("direct and gateway invocation preserve the same authority", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-gateway-authority-");
	});
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		env.restore();
	});

	it("denies a write-class capability at read-only identically, with the capability's own audit row", async () => {
		const direct = harness(scratch(), "read-only", "direct", "approve");
		const gateway = harness(scratch(), "read-only", "gateway", "approve");
		const viaDirect = await invokeDirect(direct.registry, ToolNames.Artifact, ARTIFACT_ARGS);
		const viaGateway = await invokeGateway(gateway.registry, ToolNames.Artifact, ARTIFACT_ARGS);
		strictEqual(viaDirect.kind, "blocked");
		strictEqual(viaGateway.kind, "blocked", "the gateway call settles as the capability's own block");
		if (viaDirect.kind !== "blocked" || viaGateway.kind !== "blocked") return;
		strictEqual(viaGateway.reason, viaDirect.reason);
		deepStrictEqual(blockedDecision(gateway, viaGateway), blockedDecision(direct, viaDirect));
		deepStrictEqual(capabilityRows(gateway, ToolNames.Artifact), capabilityRows(direct, ToolNames.Artifact));
		strictEqual(capabilityRows(direct, ToolNames.Artifact)[0]?.decision, "denied");
		deepStrictEqual(direct.parks, []);
		deepStrictEqual(gateway.parks, []);
	});

	it("parks a write-class capability at suggest under the capability's name and honors the operator's answer identically", async () => {
		for (const answer of ["approve", "deny"] as const) {
			const directCwd = scratch();
			const gatewayCwd = scratch();
			const direct = harness(directCwd, "suggest", "direct", answer);
			const gateway = harness(gatewayCwd, "suggest", "gateway", answer);
			const viaDirect = await invokeDirect(direct.registry, ToolNames.Artifact, ARTIFACT_ARGS);
			const viaGateway = await invokeGateway(gateway.registry, ToolNames.Artifact, ARTIFACT_ARGS);
			deepStrictEqual(direct.parks, [{ tool: ToolNames.Artifact, actionClass: "write", short: direct.parks[0]?.short }]);
			deepStrictEqual(gateway.parks, direct.parks, "the approval card names the capability, not the gateway");
			deepStrictEqual(capabilityRows(gateway, ToolNames.Artifact), capabilityRows(direct, ToolNames.Artifact));
			if (answer === "approve") {
				const directResult = okResult(viaDirect);
				const gatewayResult = okResult(viaGateway);
				strictEqual(gatewayResult.output, directResult.output);
				strictEqual(gatewayResult.terminate, true);
				strictEqual(directResult.terminate, true);
				ok(existsSync(join(directCwd, "notes", "REPORT.md")));
				ok(existsSync(join(gatewayCwd, "notes", "REPORT.md")));
				strictEqual(readFileSync(join(gatewayCwd, "notes", "REPORT.md"), "utf8"), ARTIFACT_ARGS.content);
			} else {
				strictEqual(viaDirect.kind, "blocked");
				strictEqual(viaGateway.kind, "blocked");
				if (viaDirect.kind !== "blocked" || viaGateway.kind !== "blocked") return;
				strictEqual(viaGateway.reason, viaDirect.reason);
				deepStrictEqual(blockedDecision(gateway, viaGateway), blockedDecision(direct, viaDirect));
				ok(!existsSync(join(directCwd, "notes", "REPORT.md")));
				ok(!existsSync(join(gatewayCwd, "notes", "REPORT.md")));
			}
		}
	});

	it("runs a write-class capability at auto-edit and full-auto with equal decisions, results, and audit rows", async () => {
		for (const level of ["auto-edit", "full-auto"] as const) {
			const directCwd = scratch();
			const gatewayCwd = scratch();
			const direct = harness(directCwd, level, "direct", "approve");
			const gateway = harness(gatewayCwd, level, "gateway", "approve");
			const directResult = okResult(await invokeDirect(direct.registry, ToolNames.Artifact, ARTIFACT_ARGS));
			const gatewayResult = okResult(await invokeGateway(gateway.registry, ToolNames.Artifact, ARTIFACT_ARGS));
			deepStrictEqual(direct.parks, []);
			deepStrictEqual(gateway.parks, []);
			strictEqual(gatewayResult.output, directResult.output);
			deepStrictEqual(
				{ kind: gatewayResult.details?.kind, terminate: gatewayResult.terminate },
				{ kind: "report", terminate: true },
			);
			deepStrictEqual(gatewayResult.details?.paths, [join(gatewayCwd, "notes", "REPORT.md")]);
			deepStrictEqual(directResult.details?.paths, [join(directCwd, "notes", "REPORT.md")]);
			strictEqual(gatewayResult.details?.capability, ToolNames.Artifact);
			const rows = capabilityRows(direct, ToolNames.Artifact);
			deepStrictEqual(capabilityRows(gateway, ToolNames.Artifact), rows);
			strictEqual(rows[0]?.decision, "allowed");
			strictEqual((rows[0]?.classification as { actionClass: string }).actionClass, "write");
		}
	});

	it("runs the execute-plane git capability with equal decisions and outputs at every level", async () => {
		for (const level of LEVELS) {
			const direct = harness(scratch(), level, "direct", "approve");
			const gateway = harness(scratch(), level, "gateway", "approve");
			const viaDirect = await invokeDirect(direct.registry, ToolNames.Git, GIT_ARGS);
			const viaGateway = await invokeGateway(gateway.registry, ToolNames.Git, GIT_ARGS);
			strictEqual(viaDirect.kind, "ok", `${level}: git is read class on the safe-exec spine`);
			strictEqual(viaGateway.kind, "ok", `${level}: the gateway path admits git the same way`);
			if (viaDirect.kind !== "ok" || viaGateway.kind !== "ok") return;
			strictEqual(viaGateway.result.kind, viaDirect.result.kind);
			if (viaDirect.result.kind === "ok" && viaGateway.result.kind === "ok") {
				strictEqual(viaGateway.result.output, viaDirect.result.output);
				strictEqual(viaGateway.result.details?.capability, ToolNames.Git);
			}
			deepStrictEqual(capabilityRows(gateway, ToolNames.Git), capabilityRows(direct, ToolNames.Git));
			deepStrictEqual(gateway.parks, direct.parks);
		}
	});

	it("propagates the terminal artifact contract through the gateway so the turn ends and /view lists the document", async () => {
		const cwd = scratch();
		const gateway = harness(cwd, "full-auto", "gateway", "approve");
		const args = { op: "call", capability: ToolNames.Artifact, args: ARTIFACT_ARGS };
		const verdict = await gateway.registry.invoke({ tool: ToolNames.Gateway, args });
		const result = okResult(verdict);
		strictEqual(result.terminate, true, "terminate crosses the gateway");
		strictEqual(result.details?.kind, "report");
		deepStrictEqual(result.details?.paths, [join(cwd, "notes", "REPORT.md")]);
		// The ledger records the call under `gateway`; the artifact fold unwraps
		// it through the stamped capability and lists the document for /view.
		const entries = [
			{
				kind: "message",
				role: "tool_call",
				turnId: "call-1",
				timestamp: "2026-09-16T00:00:00.000Z",
				payload: { name: ToolNames.Gateway, toolCallId: "call-1", args },
			},
			{
				kind: "message",
				role: "tool_result",
				turnId: "call-1",
				timestamp: "2026-09-16T00:00:01.000Z",
				payload: {
					toolName: ToolNames.Gateway,
					toolCallId: "call-1",
					isError: false,
					outcome: "ok",
					result: { kind: "ok", output: result.output, details: result.details },
				},
			},
		];
		const artifacts = foldSessionArtifacts(entries, { workspace: cwd });
		deepStrictEqual(
			artifacts.map((artifact) => ({ path: artifact.path, tool: artifact.tool, kind: artifact.artifactKind })),
			[{ path: join(cwd, "notes", "REPORT.md"), tool: ToolNames.Artifact, kind: "report" }],
		);
	});
});
