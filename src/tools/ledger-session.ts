import { hostname } from "node:os";
import { publishAgentLedgerEntry } from "../domains/dispatch/agent-ledger-hub.js";
import { appendAgentLedgerEntry, readAgentLedger } from "../domains/dispatch/agent-ledger-store.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import { createLedgerTool } from "./ledger.js";
import type { RegistryDeps, ToolSpec } from "./registry.js";

export function createSessionLedgerTool(dispatch: DispatchContract, flow?: RegistryDeps["flow"]): ToolSpec {
	return createLedgerTool({
		resolveLedger(runId) {
			const owner = dispatchOwnerOf(dispatch);
			const ownership = dispatchOwnership(owner);
			const runs = dispatch.listRuns().filter((run) => ownership.ownsRun(run) && run.projection?.ledgerId);
			const selected = runId === undefined ? undefined : runs.find((run) => run.id === runId);
			const active = [
				...new Set(runs.flatMap((run) => (run.projection?.ledgerId ? [run.projection.ledgerId] : []))),
			].filter((id) => readAgentLedger(id)?.closedAt === null);
			const id = runId === undefined ? (active.length === 1 ? active[0] : undefined) : selected?.projection?.ledgerId;
			if (!id) return null;
			return {
				read() {
					const record = readAgentLedger(id);
					return record === null
						? null
						: { open: record.closedAt === null, watermark: record.sequence, entries: record.entries };
				},
				async post(body) {
					const refusal = flow?.refusal();
					if (refusal) return { ok: false, reason: refusal };
					const carried = flow?.carried();
					const result = await appendAgentLedgerEntry(
						id,
						{
							runId: `main:${owner.sessionId ?? process.pid}`,
							assignmentId: id,
							agentId: "main",
							nodeId: hostname(),
							...(carried ? { flowRestrictions: carried } : {}),
						},
						body,
					);
					if (!result.ok) return { ok: false, reason: result.reason };
					publishAgentLedgerEntry(id, result.entry);
					return { ok: true };
				},
			};
		},
	});
}
