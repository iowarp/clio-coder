import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolNames } from "../../src/core/tool-names.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { attestedToolSignature, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { registerCoreTools } from "../../src/tools/core-bootstrap.js";
import { createRegistry } from "../../src/tools/registry.js";
import { toolSignatureOf } from "../../src/worker/protocol.js";

/**
 * The orchestrator admits `ledger` for every member of a batch and signs the
 * admitted surface; the worker signs the names a bare worker registry
 * produces, before it knows whether this run bound a ledger port. The two
 * signatures agree only if the worker registry always registers the tool.
 * Gating the session's registration on a port (0.4.2) silently broke that:
 * every batch worker was refused for "tool surface drift" while single
 * dispatches, which never admit `ledger`, kept attesting fine.
 */
describe("worker attestation: ledger on the signed surface", () => {
	const batchSurface = [ToolNames.Read, ToolNames.Grep, ToolNames.Edit, ToolNames.Context, ToolNames.Ledger] as const;

	it("registers ledger on a worker registry with no port bound", () => {
		const registry = createWorkerToolRegistry();
		ok(registry.get(ToolNames.Ledger), "worker registry must carry ledger before any port is bound");
	});

	it("signs a batch member's surface with ledger in it, port or no port", () => {
		const signature = attestedToolSignature({
			allowedTools: [...batchSurface],
			toolsSupported: true,
			agentId: "coder",
			task: "edit src/parser.ts",
		});
		strictEqual(signature, toolSignatureOf([...batchSurface]));
		const withoutLedger = toolSignatureOf(batchSurface.filter((name) => name !== ToolNames.Ledger));
		ok(signature !== withoutLedger, "the signed surface must not drop ledger for want of a port");
	});

	it("keeps ledger off the session registry, which binds no port and has no peers", () => {
		const registry = createRegistry({
			safety: {
				classify: () => ({ actionClass: "read" as const, reasons: [] }),
				evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "read" as const, reasons: [] } }),
				observeLoop: () => ({ looping: false, key: "contract", count: 0 }),
				scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
				isSubset: () => true,
				audit: { recordCount: () => 0 },
			},
		});
		const registration = registerCoreTools(registry);
		strictEqual(registration.includeLedgerTools, false);
		strictEqual(registry.get(ToolNames.Ledger), undefined);
	});
});
