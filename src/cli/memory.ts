import { clioDataDir } from "../core/xdg.js";
import {
	approveMemoryRecord,
	loadMemoryRecords,
	type MemoryRecord,
	memoryStatus,
	proposeMemoryFromEvidence,
	pruneStaleMemory,
	rejectMemoryRecord,
} from "../domains/memory/index.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio memory list
clio memory propose --from-evidence <evidenceId>
clio memory approve <memoryId>
clio memory reject <memoryId>
clio memory prune --stale

Manage scoped, approved, evidence-linked local memory records.
`;

type MemoryCommand = "list" | "propose" | "approve" | "reject" | "prune";

interface ParsedMemoryArgs {
	command?: MemoryCommand;
	evidenceId?: string;
	memoryId?: string;
	stale: boolean;
	help: boolean;
}

function parseMemoryArgs(args: ReadonlyArray<string>): ParsedMemoryArgs {
	const parsed: ParsedMemoryArgs = { stale: false, help: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (parsed.command === undefined) {
			if (arg === "list" || arg === "propose" || arg === "approve" || arg === "reject" || arg === "prune") {
				parsed.command = arg;
				continue;
			}
			throw new Error(`unknown memory command: ${arg}`);
		}
		if (parsed.command === "propose") {
			if (arg === "--from-evidence") {
				const value = args[index + 1];
				if (value === undefined || value.startsWith("-")) throw new Error("--from-evidence requires an evidence id");
				parsed.evidenceId = value;
				index += 1;
				continue;
			}
			throw new Error(`unknown memory propose argument: ${arg}`);
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
	if (parsed.command === undefined) throw new Error("memory requires list, propose, approve, reject, or prune");
	if (parsed.command === "propose" && parsed.evidenceId === undefined) {
		throw new Error("propose requires --from-evidence <evidenceId>");
	}
	if ((parsed.command === "approve" || parsed.command === "reject") && parsed.memoryId === undefined) {
		throw new Error(`${parsed.command} requires a memory id`);
	}
	if (parsed.command === "prune" && !parsed.stale) throw new Error("prune requires --stale");
	if (parsed.command === "list" && (parsed.evidenceId !== undefined || parsed.memoryId !== undefined || parsed.stale)) {
		throw new Error("list does not accept extra arguments");
	}
	return parsed;
}

export async function runMemoryCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedMemoryArgs;
	try {
		parsed = parseMemoryArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stdout.write(HELP);
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
		if (parsed.command === "propose") {
			const evidenceId = parsed.evidenceId;
			if (evidenceId === undefined) {
				printError("propose requires --from-evidence <evidenceId>");
				return 2;
			}
			const result = await proposeMemoryFromEvidence(dataDir, evidenceId);
			renderProposal(result.record, result.created);
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
		printError("memory requires list, propose, approve, reject, or prune");
		return 2;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

function renderProposal(record: MemoryRecord, created: boolean): void {
	process.stdout.write(`memory: ${record.id}\n`);
	process.stdout.write(`status: ${created ? "proposed" : memoryStatus(record)}\n`);
	process.stdout.write(`scope: ${record.scope}\n`);
	process.stdout.write(`key: ${record.key}\n`);
	process.stdout.write(`evidence: ${record.evidenceRefs.join(", ")}\n`);
	process.stdout.write(`confidence: ${record.confidence.toFixed(2)}\n`);
	process.stdout.write(`lesson: ${record.lesson}\n`);
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
	}
}
