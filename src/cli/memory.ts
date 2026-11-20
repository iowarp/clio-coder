import { readFile, stat } from "node:fs/promises";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import { claimSealReader, claimsProjectRoot, readClaims } from "../domains/claims/index.js";
import { inspectRunFlowProvenance } from "../domains/evidence/index.js";
import {
	approveMemoryRecord,
	type ClearedMemoryRegressions,
	canonicalMemoryRepositoryIdentity,
	consolidateMemory,
	loadMemoryStore,
	type MemoryConsolidation,
	type MemoryRecord,
	type MemoryScopeSelection,
	memoryAgentIdentity,
	memoryRuntimeIdentity,
	memoryStatus,
	memoryStorePath,
	parseTaskMemoryHandoffSnapshot,
	proposeMemoryFromClaim,
	proposeMemoryFromEvidence,
	proposeMemoryPromotion,
	pruneStaleMemory,
	type ReviewedTaskMemoryHandoffSnapshot,
	readClearedMemoryRegressions,
	rejectMemoryRecord,
	type TaskMemoryHandoffEntry,
} from "../domains/memory/index.js";
import { projectDeclaresFlowRules } from "../domains/safety/flow-policy-snapshot.js";
import { FLOW_RESTRICTION_ENTRY_TYPE } from "../domains/session/history.js";
import { openSession } from "../engine/session.js";
import { printNote } from "./argv.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio-coder memory list [--approved-by operator|guardian] [--json]
clio-coder memory propose --from-evidence <runId> [scope options]
clio-coder memory propose --from-claim <claim-id-prefix>
clio-coder memory promote --from-handoff <path> [--entry <id>...] --scope <scope> [scope options]
clio-coder memory approve <memoryId>
clio-coder memory reject <memoryId>
clio-coder memory prune --stale
clio-coder memory consolidate [--json]

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
with the same pinned conditions disagrees, the record gets a regression and
leaves the prompt until approved again.

list --approved-by keeps the approved records one approver let into the prompt:
guardian for lessons the memory gate approved automatically on execution
evidence, operator for the ones a person approved (a record approved before
approvals were stamped counts as the operator's, as the prompt reads it).
The text listing notes on stderr how many records wait for review. Both listings
note on stderr how many records the store set aside as invalid; --json also
lists them under "invalid" with their issues. Listing never moves them.

consolidate tidies the store by rule, with no model call: records of one claim
merge (other wordings kept as revisions), lessons of this repository whose
command no longer resolves or whose quoted span left its file here are demoted
to notes (an operator-approved one is only reported as withheld), and notes
the automatic tier wrote with no evidence, verdict or delivery are dropped.
Operator decisions are never changed. It runs only when you run it.
`;

type MemoryCommand = "list" | "propose" | "promote" | "approve" | "reject" | "prune" | "consolidate";
type MemoryApprover = "operator" | "guardian";

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
	json: boolean;
	help: boolean;
	approvedBy?: MemoryApprover;
}

function parseMemoryArgs(args: ReadonlyArray<string>): ParsedMemoryArgs {
	const parsed: ParsedMemoryArgs = { entryIds: [], acknowledgeGlobal: false, stale: false, json: false, help: false };
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
				arg === "prune" ||
				arg === "consolidate"
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
		if ((parsed.command === "list" || parsed.command === "consolidate") && arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (parsed.command === "list" && arg === "--approved-by") {
			const value = requireOptionValue(args, index, "--approved-by", "operator or guardian");
			if (value !== "operator" && value !== "guardian") throw new Error("--approved-by requires operator or guardian");
			parsed.approvedBy = value;
			index += 1;
			continue;
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
	if (parsed.command === undefined)
		throw new Error("memory requires list, propose, promote, approve, reject, prune, or consolidate");
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
			const { records: stored, invalid } = await loadMemoryStore(dataDir);
			const { approvedBy } = parsed;
			const records = approvedBy === undefined ? stored : stored.filter((record) => memoryApprover(record) === approvedBy);
			const cleared = readClearedMemoryRegressions(dataDir);
			// Records the validator set aside are absent from the listing; say so rather than look like data loss.
			if (invalid.length > 0)
				printNote(
					`${invalid.length} memory record${invalid.length === 1 ? "" : "s"} set aside as invalid: ${memoryStorePath(dataDir)}: ${invalid[0]?.issues[0] ?? "invalid record"}`,
				);
			if (parsed.json)
				process.stdout.write(
					`${JSON.stringify({ records: records.map((record) => publicMemoryRecord(record, cleared)), invalid })}\n`,
				);
			else {
				const pending = stored.filter((record) => memoryStatus(record) === "proposed").length;
				if (pending > 0)
					printNote(
						`${pending} memory record${pending === 1 ? "" : "s"} pending review; clio-coder memory approve <id> or reject <id>`,
					);
				renderMemoryList(records, cleared);
			}
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
		if (parsed.command === "consolidate") {
			const result = await consolidateMemory(dataDir, { cwd: process.cwd() });
			if (parsed.json) process.stdout.write(`${JSON.stringify(result)}\n`);
			else renderConsolidation(result);
			return 0;
		}
		printError("memory requires list, propose, promote, approve, reject, prune, or consolidate");
		return 2;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

function renderConsolidation(result: MemoryConsolidation): void {
	process.stdout.write(
		`memory consolidate: scanned ${result.scanned}, merged ${result.merged}, demoted ${result.demoted}, withheld ${result.withheld}, dropped ${result.dropped}${result.changed ? "" : "; nothing changed"}\n`,
	);
	for (const item of result.items) {
		const detail =
			item.action === "merged"
				? ` into ${item.into ?? "?"}`
				: item.action === "withheld"
					? `: ${item.reason ?? ""}; its operator approval stands`
					: item.reason === undefined
						? ""
						: `: ${item.reason}`;
		process.stdout.write(`  ${item.action} ${item.id}${detail}\n`);
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
	const read = readClaims(project);
	const matches = read.records.filter((claim) => claim.id.startsWith(prefix));
	const [claim] = matches;
	// An imported claim is another project's lead, inferred here (#406): it never backs a lesson in this project.
	if (
		claim === undefined &&
		read.imports.some((record) => record.claim.id.startsWith(prefix) || record.id.startsWith(prefix))
	) {
		printError(
			`claim '${prefix}' was imported from another project and is inferred here; only a claim this project's own checks recorded can back a memory. Run the check here first.`,
		);
		return 1;
	}
	if (claim === undefined || matches.length > 1) {
		printError(
			claim === undefined
				? `no claim in ${project} has an id starting '${prefix}'`
				: `'${prefix}' matches ${matches.length} claims; give more of the id`,
		);
		return 1;
	}
	// A host-verification claim its cited run's seal does not hold is a log line, not evidence (D3-4).
	const seal = claimSealReader()(claim);
	if (seal.state === "unverified") {
		printError(`claim ${claim.id.slice(0, 12)} is unverified: ${seal.reason}; nothing was proposed`);
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

/**
 * Who let an approved record into the prompt; null for one that is not approved. A record approved before approvals
 * were stamped was reviewed by a person, the reading `projectKeptLesson` gives it.
 */
function memoryApprover(record: MemoryRecord): MemoryApprover | null {
	if (!record.approved) return null;
	return record.approval?.by ?? "operator";
}

/**
 * The fields a reviewer decides on, for `memory list --json`; absent optionals stay absent. Open regressions say why a
 * record is out of the prompt, and the regressions an operator re-approval cleared stay listed (#406), so a reader of
 * the JSON sees a record was once contradicted just as the text listing shows it.
 */
function publicMemoryRecord(record: MemoryRecord, cleared: ReadonlyArray<ClearedMemoryRegressions>) {
	const clearings = cleared.filter((entry) => entry.id === record.id);
	return {
		id: record.id,
		scope: record.scope,
		key: record.key,
		lesson: record.lesson,
		appliesWhen: record.appliesWhen,
		avoidWhen: record.avoidWhen,
		confidence: record.confidence,
		evidenceRefs: record.evidenceRefs,
		createdAt: record.createdAt,
		approved: record.approved,
		...(record.approved && record.approval !== undefined ? { approval: { ...record.approval } } : {}),
		...(record.rejectedAt !== undefined ? { rejectedAt: record.rejectedAt } : {}),
		...(record.repository !== undefined ? { repository: record.repository } : {}),
		...(record.claim !== undefined ? { claim: record.claim } : {}),
		...(record.revisions !== undefined ? { revisions: record.revisions.map((item) => ({ ...item })) } : {}),
		...(deliveries(record) > 0 ? { deliveredCount: deliveries(record) } : {}),
		...(record.lastDeliveredAt !== undefined ? { lastDeliveredAt: record.lastDeliveredAt } : {}),
		...(record.regressions !== undefined && record.regressions.length > 0
			? { regressions: [...record.regressions] }
			: {}),
		...(clearings.length > 0
			? {
					regressionsCleared: clearings.map((entry) => ({
						at: entry.at,
						by: entry.by,
						regressions: [...entry.regressions],
					})),
				}
			: {}),
	};
}

/** A record written before the delivery counter still lists its deliveries as observations until it next changes. */
function deliveries(record: MemoryRecord): number {
	return (record.deliveredCount ?? 0) + (record.observations ?? []).filter((item) => item.kind === "delivered").length;
}

function renderMemoryList(
	records: ReadonlyArray<MemoryRecord>,
	cleared: ReadonlyArray<ClearedMemoryRegressions>,
): void {
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
		if (record.approved && record.approval !== undefined)
			process.stdout.write(`  approved by ${record.approval.by} at ${record.approval.at}\n`);
		// A record with a regression is out of the prompt and recall; say why, since approve clears it.
		for (const regression of record.regressions ?? []) process.stdout.write(`  regression: ${regression}\n`);
		// Re-approval clears regressions from the record; the clearing is kept so the history stays visible.
		for (const entry of cleared.filter((item) => item.id === record.id))
			for (const regression of entry.regressions)
				process.stdout.write(`  cleared by operator approval ${entry.at}: ${regression}\n`);
	}
}
