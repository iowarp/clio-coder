import { readFile, stat } from "node:fs/promises";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import { claimsProjectRoot, readClaims } from "../domains/claims/index.js";
import { inspectRunFlowProvenance } from "../domains/evidence/index.js";
import {
	approveMemoryRecord,
	canonicalMemoryRepositoryIdentity,
	loadMemoryRecords,
	type MemoryRecord,
	type MemoryScopeSelection,
	memoryAgentIdentity,
	memoryRuntimeIdentity,
	memoryStatus,
	parseTaskMemoryHandoffSnapshot,
	proposeMemoryFromClaim,
	proposeMemoryFromEvidence,
	proposeMemoryPromotion,
	pruneStaleMemory,
	type ReviewedTaskMemoryHandoffSnapshot,
	rejectMemoryRecord,
	type TaskMemoryHandoffEntry,
} from "../domains/memory/index.js";
import { projectDeclaresFlowRules } from "../domains/safety/flow-policy-snapshot.js";
import { FLOW_RESTRICTION_ENTRY_TYPE } from "../domains/session/history.js";
import { openSession } from "../engine/session.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio-coder memory list
clio-coder memory propose --from-evidence <runId> [scope options]
clio-coder memory propose --from-claim <claim-id-prefix>
clio-coder memory promote --from-handoff <path> [--entry <id>...] --scope <scope> [scope options]
clio-coder memory approve <memoryId>
clio-coder memory reject <memoryId>
clio-coder memory prune --stale

Manage scoped, approved, evidence-linked local memory records.

Scope options:
  --scope repo --repository <canonical-absolute-path>
  --scope global --acknowledge-global
  --scope runtime --runtime <source-runtime-id>
  --scope agent --agent <source-agent-id>

Omit scope options from propose to preserve evidence-inferred scope. Promotion
always requires an explicit scope and creates unapproved records for review.

--from-claim proposes an unapproved repo record resting on one claim of the
project at the current directory (see clio-coder claims). If a later claim
under the same conditions disagrees, the record gets a regression and leaves
the prompt until approved again.
`;

type MemoryCommand = "list" | "propose" | "promote" | "approve" | "reject" | "prune";

interface ParsedMemoryArgs {
	command?: MemoryCommand;
	evidenceId?: string;
	claimId?: string;
	handoffPath?: string;
	entryIds: string[];
	memoryId?: string;
	scope?: "repo" | "global" | "runtime" | "agent";
	repositoryPath?: string;
	acknowledgeGlobal: boolean;
	runtimeId?: string;
	agentId?: string;
	stale: boolean;
	help: boolean;
}

function parseMemoryArgs(args: ReadonlyArray<string>): ParsedMemoryArgs {
	const parsed: ParsedMemoryArgs = { entryIds: [], acknowledgeGlobal: false, stale: false, help: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (parsed.command === undefined) {
			if (
				arg === "list" ||
				arg === "propose" ||
				arg === "promote" ||
				arg === "approve" ||
				arg === "reject" ||
				arg === "prune"
			) {
				parsed.command = arg;
				continue;
			}
			throw new Error(`unknown memory command: ${arg}`);
		}
		if (parsed.command === "propose" || parsed.command === "promote") {
			if (arg === "--from-evidence") {
				if (parsed.command !== "propose") throw new Error("--from-evidence is valid only for memory propose");
				const value = args[index + 1];
				if (value === undefined || value.startsWith("-")) throw new Error("--from-evidence requires a run id");
				parsed.evidenceId = value;
				index += 1;
				continue;
			}
			if (arg === "--from-claim") {
				if (parsed.command !== "propose") throw new Error("--from-claim is valid only for memory propose");
				parsed.claimId = requireOptionValue(args, index, "--from-claim", "a claim id prefix");
				index += 1;
				continue;
			}
			if (arg === "--from-handoff") {
				if (parsed.command !== "promote") throw new Error("--from-handoff is valid only for memory promote");
				const value = requireOptionValue(args, index, "--from-handoff", "a path");
				parsed.handoffPath = value;
				index += 1;
				continue;
			}
			if (arg === "--entry") {
				if (parsed.command !== "promote") throw new Error("--entry is valid only for memory promote");
				parsed.entryIds.push(requireOptionValue(args, index, "--entry", "an entry id"));
				index += 1;
				continue;
			}
			if (arg === "--scope") {
				const value = requireOptionValue(args, index, "--scope", "repo, global, runtime, or agent");
				if (value !== "repo" && value !== "global" && value !== "runtime" && value !== "agent") {
					throw new Error("--scope requires repo, global, runtime, or agent");
				}
				parsed.scope = value;
				index += 1;
				continue;
			}
			if (arg === "--repository") {
				parsed.repositoryPath = requireOptionValue(args, index, "--repository", "a canonical absolute path");
				index += 1;
				continue;
			}
			if (arg === "--acknowledge-global") {
				parsed.acknowledgeGlobal = true;
				continue;
			}
			if (arg === "--runtime") {
				parsed.runtimeId = requireOptionValue(args, index, "--runtime", "a runtime id");
				index += 1;
				continue;
			}
			if (arg === "--agent") {
				parsed.agentId = requireOptionValue(args, index, "--agent", "an agent id");
				index += 1;
				continue;
			}
			throw new Error(`unknown memory ${parsed.command} argument: ${arg}`);
		}
		if (parsed.command === "approve" || parsed.command === "reject") {
			if (parsed.memoryId === undefined && !arg.startsWith("-")) {
				parsed.memoryId = arg;
				continue;
			}
			throw new Error(`unexpected memory ${parsed.command} argument: ${arg}`);
		}
		if (parsed.command === "prune") {
			if (arg === "--stale") {
				parsed.stale = true;
				continue;
			}
			throw new Error(`unknown memory prune argument: ${arg}`);
		}
		throw new Error(`unexpected memory argument: ${arg}`);
	}
	if (parsed.help) return parsed;
	if (parsed.command === undefined) throw new Error("memory requires list, propose, promote, approve, reject, or prune");
	if (parsed.command === "propose" && (parsed.evidenceId === undefined) === (parsed.claimId === undefined)) {
		throw new Error("propose requires one of --from-evidence <runId> or --from-claim <claim-id-prefix>");
	}
	if (parsed.claimId !== undefined && parsed.scope !== undefined) {
		throw new Error("--from-claim takes no scope options; the record is scoped to the claim's repository");
	}
	if (parsed.command === "promote" && parsed.handoffPath === undefined) {
		throw new Error("promote requires --from-handoff <path>");
	}
	if ((parsed.command === "approve" || parsed.command === "reject") && parsed.memoryId === undefined) {
		throw new Error(`${parsed.command} requires a memory id`);
	}
	if (parsed.command === "prune" && !parsed.stale) throw new Error("prune requires --stale");
	if (parsed.command === "promote" && parsed.scope === undefined) {
		throw new Error("promote requires --scope <repo|global|runtime|agent>");
	}
	validateScopeArguments(parsed);
	if (
		parsed.command === "list" &&
		(parsed.evidenceId !== undefined ||
			parsed.handoffPath !== undefined ||
			parsed.entryIds.length > 0 ||
			parsed.memoryId !== undefined ||
			parsed.stale ||
			parsed.scope !== undefined)
	) {
		throw new Error("list does not accept extra arguments");
	}
	return parsed;
}

function requireOptionValue(args: ReadonlyArray<string>, index: number, option: string, expected: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) throw new Error(`${option} requires ${expected}`);
	return value;
}

function validateScopeArguments(parsed: ParsedMemoryArgs): void {
	const hasIdentityOption =
		parsed.repositoryPath !== undefined ||
		parsed.acknowledgeGlobal ||
		parsed.runtimeId !== undefined ||
		parsed.agentId !== undefined;
	if (parsed.scope === undefined) {
		if (hasIdentityOption) throw new Error("scope identity options require --scope");
		return;
	}
	if (parsed.scope === "repo") {
		if (parsed.repositoryPath === undefined)
			throw new Error("repo scope requires --repository <canonical-absolute-path>");
		if (parsed.acknowledgeGlobal || parsed.runtimeId !== undefined || parsed.agentId !== undefined) {
			throw new Error("repo scope accepts only --repository");
		}
		return;
	}
	if (parsed.scope === "global") {
		if (!parsed.acknowledgeGlobal) throw new Error("global scope requires --acknowledge-global");
		if (parsed.repositoryPath !== undefined || parsed.runtimeId !== undefined || parsed.agentId !== undefined) {
			throw new Error("global scope accepts only --acknowledge-global");
		}
		return;
	}
	if (parsed.scope === "runtime") {
		if (parsed.runtimeId === undefined) throw new Error("runtime scope requires --runtime <source-runtime-id>");
		if (parsed.repositoryPath !== undefined || parsed.acknowledgeGlobal || parsed.agentId !== undefined) {
			throw new Error("runtime scope accepts only --runtime");
		}
		return;
	}
	if (parsed.agentId === undefined) throw new Error("agent scope requires --agent <source-agent-id>");
	if (parsed.repositoryPath !== undefined || parsed.acknowledgeGlobal || parsed.runtimeId !== undefined) {
		throw new Error("agent scope accepts only --agent");
	}
}

export async function runMemoryCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedMemoryArgs;
	try {
		parsed = parseMemoryArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		// Usage that accompanies an error goes to stderr with it; see the same
		// note in evidence.ts.
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}

	const dataDir = clioDataDir();
	try {
		if (parsed.command === "list") {
			renderMemoryList(await loadMemoryRecords(dataDir));
			return 0;
		}
		if (parsed.command === "propose" && parsed.claimId !== undefined)
			return await proposeFromClaim(dataDir, parsed.claimId);
		if (parsed.command === "propose") {
			const evidenceId = parsed.evidenceId;
			if (evidenceId === undefined) {
				printError("propose requires --from-evidence <runId>");
				return 2;
			}
			// The ledger row words and scopes the lesson; the run's sealed evidence carries its claims (#434).
			const { openLedger } = await import("../domains/dispatch/state.js");
			const row = openLedger().get(evidenceId);
			const selection = scopeSelection(parsed);
			const flowRefusal = await evidenceFlowRefusal(
				evidenceId,
				selection?.scope === "repo" ? selection.repository.key : (row?.cwd ?? process.cwd()),
			);
			if (flowRefusal !== null) {
				printError(`${flowRefusal}; nothing was proposed`);
				return 1;
			}
			const result = await proposeMemoryFromEvidence(
				dataDir,
				clioStateDir(),
				evidenceId,
				{ task: row?.task ?? null, cwd: row?.cwd ?? null },
				selection,
			);
			renderProposal(result.record, result.created);
			return 0;
		}
		if (parsed.command === "promote") {
			const handoffPath = parsed.handoffPath;
			const selection = scopeSelection(parsed);
			if (handoffPath === undefined || selection === undefined) {
				printError("promote requires a handoff and explicit scope");
				return 2;
			}
			const snapshot = await readReviewedHandoff(handoffPath);
			const flowRefusal = promotionFlowRefusal(
				snapshot.source.sessionId,
				selection.scope === "repo" ? selection.repository.key : process.cwd(),
			);
			if (flowRefusal !== null) {
				printError(`${flowRefusal}; nothing was promoted`);
				return 1;
			}
			const entries = selectHandoffEntries(snapshot, parsed.entryIds);
			for (const entry of entries) {
				const result = await proposeMemoryPromotion(
					dataDir,
					{
						kind: "handoff-snapshot",
						sessionId: snapshot.source.sessionId,
						evidenceRefs: snapshot.source.evidenceRefs,
						runtimeIds: snapshot.source.runtimeIds,
						agentIds: snapshot.source.agentIds,
						entry: handoffTaskEntry(entry),
						redaction: {
							replacementCount: snapshot.redaction.replacementCount,
							sourceFields: snapshot.redaction.sourceFields,
						},
					},
					selection,
				);
				renderProposal(result.record, result.created);
			}
			return 0;
		}
		if (parsed.command === "approve") {
			const memoryId = parsed.memoryId;
			if (memoryId === undefined) {
				printError("approve requires a memory id");
				return 2;
			}
			const record = await approveMemoryRecord(dataDir, memoryId);
			printOk(`approved ${record.id}`);
			return 0;
		}
		if (parsed.command === "reject") {
			const memoryId = parsed.memoryId;
			if (memoryId === undefined) {
				printError("reject requires a memory id");
				return 2;
			}
			const record = await rejectMemoryRecord(dataDir, memoryId);
			printOk(`rejected ${record.id}`);
			return 0;
		}
		if (parsed.command === "prune") {
			const pruned = await pruneStaleMemory(dataDir);
			printOk(`pruned ${pruned.length} stale memory record${pruned.length === 1 ? "" : "s"}`);
			return 0;
		}
		printError("memory requires list, propose, promote, approve, reject, or prune");
		return 2;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

function scopeSelection(parsed: ParsedMemoryArgs): MemoryScopeSelection | undefined {
	if (parsed.scope === undefined) return undefined;
	if (parsed.scope === "repo") {
		const repositoryPath = parsed.repositoryPath;
		if (repositoryPath === undefined) throw new Error("repo scope requires --repository");
		const repository = canonicalMemoryRepositoryIdentity(repositoryPath);
		if (repository === null || repository.key !== repositoryPath) {
			throw new Error("--repository must be an existing canonical absolute repository path");
		}
		return { scope: "repo", repository };
	}
	if (parsed.scope === "global") {
		if (!parsed.acknowledgeGlobal) throw new Error("global scope requires --acknowledge-global");
		return { scope: "global", acknowledgeGlobal: true };
	}
	if (parsed.scope === "runtime") {
		if (parsed.runtimeId === undefined) throw new Error("runtime scope requires --runtime");
		return { scope: "runtime", runtime: memoryRuntimeIdentity(parsed.runtimeId) };
	}
	if (parsed.agentId === undefined) throw new Error("agent scope requires --agent");
	return { scope: "agent", agent: memoryAgentIdentity(parsed.agentId) };
}

/**
 * A record has no flow label and reaches every later route, so a restricted source promotes nothing. The same answer as
 * `/memory seed`: any workspace's session is found by id, and under source rules a source that cannot be read is refused.
 */
function promotionFlowRefusal(sessionId: string, cwd: string): string | null {
	let turns: ReadonlyArray<unknown>;
	try {
		turns = openSession(sessionId).turns();
	} catch (error) {
		if (!projectDeclaresFlowRules(cwd)) return null;
		const why = error instanceof Error ? error.message : String(error);
		return `the information-flow provenance of source session ${sessionId} cannot be read (${why}), and this project declares source rules`;
	}
	const restricted = turns.some((raw) => {
		const entry = raw as { kind?: unknown; customType?: unknown } | null;
		return entry?.kind === "custom" && entry.customType === FLOW_RESTRICTION_ENTRY_TYPE;
	});
	return restricted ? `session ${sessionId} carries an information-flow restriction` : null;
}

/**
 * A lesson from evidence words the run's task and findings, and a record has no flow label. The run's settled record holds
 * what the run carried, and its dispatching session answers as a promotion's source does.
 */
/**
 * Propose a record resting on one claim (#406). The claim's own source decides the flow check, as for any proposal:
 * a host-verified claim is checked through its run, a verify claim through its session.
 */
async function proposeFromClaim(dataDir: string, prefix: string): Promise<number> {
	if (!/^[0-9a-f]{4,64}$/u.test(prefix)) {
		printError("--from-claim needs an id prefix of at least 4 hex characters");
		return 2;
	}
	const project = claimsProjectRoot(process.cwd());
	const matches = readClaims(project).records.filter((claim) => claim.id.startsWith(prefix));
	const [claim] = matches;
	if (claim === undefined || matches.length > 1) {
		printError(
			claim === undefined
				? `no claim in ${project} has an id starting '${prefix}'`
				: `'${prefix}' matches ${matches.length} claims; give more of the id`,
		);
		return 1;
	}
	const source = claim.source;
	const flowRefusal =
		source.channel === "host-verification"
			? await evidenceFlowRefusal(source.runId, project)
			: source.sessionId === null
				? null
				: promotionFlowRefusal(source.sessionId, project);
	if (flowRefusal !== null) {
		printError(`${flowRefusal}; nothing was proposed`);
		return 1;
	}
	const result = await proposeMemoryFromClaim(dataDir, {
		claimId: claim.id,
		text: claim.text,
		check: claim.keys.check,
		project,
		at: claim.at,
	});
	renderProposal(result.record, result.created);
	return 0;
}

async function evidenceFlowRefusal(runId: string, cwd: string): Promise<string | null> {
	const flow = await inspectRunFlowProvenance(clioStateDir(), runId);
	if (flow.restricted) return `run ${runId} carries an information-flow restriction`;
	if (!flow.known && projectDeclaresFlowRules(cwd))
		return `the information-flow provenance of run ${runId} cannot be read, and this project declares source rules`;
	return flow.sessionId === null ? null : promotionFlowRefusal(flow.sessionId, cwd);
}

async function readReviewedHandoff(path: string): Promise<ReviewedTaskMemoryHandoffSnapshot> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error(`task-memory handoff is not a file: ${path}`);
	if (info.size > 1_000_000) throw new Error(`task-memory handoff exceeds 1000000 bytes: ${path}`);
	const snapshot = parseTaskMemoryHandoffSnapshot(await readFile(path, "utf8"));
	if (snapshot === null) throw new Error(`task-memory handoff is invalid: ${path}`);
	if (snapshot.version !== 2) {
		throw new Error("task-memory handoff lacks source session and evidence provenance; create a new redacted handoff");
	}
	return snapshot;
}

interface SelectedHandoffEntry {
	kind: "knowledge" | "procedural";
	entry: TaskMemoryHandoffEntry;
}

function selectHandoffEntries(
	snapshot: ReviewedTaskMemoryHandoffSnapshot,
	entryIds: ReadonlyArray<string>,
): SelectedHandoffEntry[] {
	const entries: SelectedHandoffEntry[] = [
		...snapshot.knowledge.map((entry) => ({ kind: "knowledge" as const, entry })),
		...snapshot.procedural.map((entry) => ({ kind: "procedural" as const, entry })),
	];
	if (entries.length === 0) throw new Error("task-memory handoff contains no promotable entries");
	if (entryIds.length === 0) return entries;
	const requested = new Set(entryIds);
	const selected = entries.filter(({ entry }) => requested.has(entry.id));
	const missing = [...requested].filter((id) => !selected.some(({ entry }) => entry.id === id));
	if (missing.length > 0) throw new Error(`task-memory handoff entry not found: ${missing.join(", ")}`);
	return selected;
}

function handoffTaskEntry(selected: SelectedHandoffEntry): {
	id: string;
	kind: "knowledge" | "procedural";
	content: string;
	createdAt: string;
	lastTouchedAt: string;
	injectionCount: number;
} {
	const createdAt = selected.entry.createdAt;
	const lastTouchedAt = selected.entry.lastTouchedAt;
	if (createdAt === undefined || lastTouchedAt === undefined) {
		throw new Error(`task-memory handoff entry lacks timestamps: ${selected.entry.id}`);
	}
	return {
		id: selected.entry.id,
		kind: selected.kind,
		content: selected.entry.content,
		createdAt,
		lastTouchedAt,
		injectionCount: selected.entry.injectionCount,
	};
}

function renderProposal(record: MemoryRecord, created: boolean): void {
	process.stdout.write(`memory: ${record.id}\n`);
	process.stdout.write(`status: ${created ? "proposed" : memoryStatus(record)}\n`);
	process.stdout.write(`scope: ${record.scope}\n`);
	if (record.repository !== undefined) process.stdout.write(`repository: ${record.repository.key}\n`);
	if (record.runtime !== undefined) process.stdout.write(`runtime: ${record.runtime.key}\n`);
	if (record.agent !== undefined) process.stdout.write(`agent: ${record.agent.key}\n`);
	process.stdout.write(`key: ${record.key}\n`);
	process.stdout.write(`evidence: ${record.evidenceRefs.join(", ")}\n`);
	process.stdout.write(`confidence: ${record.confidence.toFixed(2)}\n`);
	process.stdout.write(`lesson: ${record.lesson}\n`);
	if (record.provenance !== undefined) {
		process.stdout.write(`source: ${record.provenance.sourceKind}\n`);
		if (record.provenance.sourceSessionId !== undefined) {
			process.stdout.write(`source-session: ${record.provenance.sourceSessionId}\n`);
		}
		if (record.provenance.sourceEntryId !== undefined) {
			process.stdout.write(`source-entry: ${record.provenance.sourceEntryId}\n`);
		}
		if (record.provenance.redaction !== undefined) {
			process.stdout.write(
				`redaction: ${record.provenance.redaction.replacementCount} replacement${record.provenance.redaction.replacementCount === 1 ? "" : "s"}; fields=${record.provenance.redaction.sourceFields.join(",") || "none"}\n`,
			);
		}
	}
	process.stdout.write(`review: clio-coder memory approve ${record.id}\n`);
}

function renderMemoryList(records: ReadonlyArray<MemoryRecord>): void {
	process.stdout.write(`${records.length} memory record${records.length === 1 ? "" : "s"}\n`);
	if (records.length === 0) return;
	process.stdout.write("\n");
	for (const record of records) {
		process.stdout.write(
			[
				record.id.padEnd(21),
				memoryStatus(record).padEnd(10),
				record.scope.padEnd(13),
				`confidence=${record.confidence.toFixed(2)}`.padEnd(16),
				`evidence=${record.evidenceRefs.join(",")}`,
			].join(""),
		);
		process.stdout.write("\n");
		process.stdout.write(`  key: ${record.key}\n`);
		process.stdout.write(`  lesson: ${record.lesson}\n`);
		// A record with a regression is out of the prompt and recall; say why, since approve clears it.
		for (const regression of record.regressions ?? []) process.stdout.write(`  regression: ${regression}\n`);
	}
}
