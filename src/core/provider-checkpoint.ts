import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	opendirSync,
	openSync,
	readFileSync,
	statfsSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ProviderCheckpointHandle, ProviderCompactionResult } from "../engine/types.js";
import { isProviderCheckpointHandle } from "./provider-checkpoint-handle.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { clioStateDir } from "./xdg.js";

export interface ProviderCheckpoint extends ProviderCompactionResult {
	version: 1;
	createdAt: string;
	sessionId: string;
	archive: string;
	cutCursor: string;
	entryRefs: string[];
	receiptRefs: string[];
	recallRefs: string[];
	skillContext: unknown;
}

function checkpointPath(handle: ProviderCheckpointHandle): string {
	if (!isProviderCheckpointHandle(handle)) throw new Error("invalid provider checkpoint handle");
	return join(clioStateDir(), "provider-checkpoints", `${handle.digest}.json`);
}

/** Windows and WSL DrvFs synthesize mode bits; ownership and integrity still apply (#423). */
function enforcesPrivateMode(path: string): boolean {
	if (process.platform === "win32") return false;
	if (process.platform === "linux" && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) {
		const type = statfsSync(path).type;
		if (type === 0x01021997 || type === 0x53464846) return false;
	}
	return true;
}

/** The atomic private blob must exist before the session can publish its handle (#423). */
export function prepareProviderCheckpoint(
	checkpoint: ProviderCheckpoint,
	signal?: AbortSignal,
): { handle: ProviderCheckpointHandle; publish: () => void } {
	signal?.throwIfAborted();
	pruneProviderCheckpoints();
	const bytes = JSON.stringify(checkpoint);
	const handle: ProviderCheckpointHandle = {
		version: 1,
		digest: createHash("sha256").update(bytes).digest("hex"),
		outputTokens: checkpoint.usage.output,
	};
	return {
		handle,
		publish: () => {
			signal?.throwIfAborted();
			safeResourceWrite(checkpointPath(handle), bytes, { mode: 0o600, beforeRename: () => signal?.throwIfAborted() });
		},
	};
}

/** No caller receives bytes until ownership, mode, version and integrity have been checked (#423). */
export function readProviderCheckpoint(handle: ProviderCheckpointHandle): ProviderCheckpoint {
	const fd = openSync(checkpointPath(handle), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			(enforcesPrivateMode(checkpointPath(handle)) && (stat.mode & 0o777) !== 0o600) ||
			(process.getuid && stat.uid !== process.getuid())
		)
			throw new Error("provider checkpoint is not a private owned file");
		const bytes = readFileSync(fd, "utf8");
		if (createHash("sha256").update(bytes).digest("hex") !== handle.digest)
			throw new Error("provider checkpoint integrity mismatch");
		const checkpoint = JSON.parse(bytes) as ProviderCheckpoint;
		if (
			checkpoint.version !== 1 ||
			checkpoint.compatibility?.protocol !== "codex-responses-trigger-v1" ||
			typeof checkpoint.outputJson !== "string" ||
			checkpoint.usage?.output !== handle.outputTokens
		)
			throw new Error("unsupported provider checkpoint");
		return checkpoint;
	} finally {
		closeSync(fd);
	}
}

const PRUNE_GRACE_MS = 3_600_000;
const PRUNE_INTERVAL_MS = 60_000;
const PRUNE_MAX_ENTRIES = 2048;
const PRUNE_MAX_BYTES = 8 * 1024 * 1024;
const PRUNE_MAX_MS = 25;
let lastSweep: { root: string; at: number } | undefined;
const pendingSweeps = new Map<string, ReturnType<typeof setTimeout>>();

/** Coalesce bulk deletion; the next native cut can also reclaim unreferenced blobs (#423). */
export function scheduleProviderCheckpointPrune(): void {
	const root = clioStateDir();
	const pending = pendingSweeps.get(root);
	if (pending) clearTimeout(pending);
	const timer = setTimeout(() => {
		pendingSweeps.delete(root);
		sweepProviderCheckpoints(root);
	}, 250);
	timer.unref();
	pendingSweeps.set(root, timer);
}

/** Grace protects another publisher; an owned failed append bypasses grace and throttling (#423). */
export function pruneProviderCheckpoints(failedPublication?: ProviderCheckpointHandle): number {
	return sweepProviderCheckpoints(clioStateDir(), failedPublication);
}

function sweepProviderCheckpoints(root: string, failedPublication?: ProviderCheckpointHandle): number {
	const directory = join(root, "provider-checkpoints");
	const started = performance.now();
	if (!failedPublication && lastSweep?.root === root && started - lastSweep.at < PRUNE_INTERVAL_MS) return 0;
	let remainingEntries = PRUNE_MAX_ENTRIES;
	let remainingBytes = PRUNE_MAX_BYTES;
	const withinBudget = (): void => {
		if (--remainingEntries < 0 || performance.now() - started > PRUNE_MAX_MS)
			throw new Error("provider checkpoint retention budget exhausted");
	};
	const referenced = new Set<string>();
	const collect = (dir: string): void => {
		const entries = opendirSync(dir);
		try {
			for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
				withinBudget();
				const file = join(dir, entry.name);
				if (entry.isDirectory()) collect(file);
				else if (entry.isFile() && entry.name === "current.jsonl") {
					const size = lstatSync(file).size;
					if (size > remainingBytes) throw new Error("provider checkpoint retention byte budget exhausted");
					remainingBytes -= size;
					for (const line of readFileSync(file, "utf8").split("\n")) {
						withinBudget();
						if (!line.includes('"providerCheckpoint"')) continue;
						const row = JSON.parse(line) as { providerCheckpoint?: unknown };
						if (isProviderCheckpointHandle(row.providerCheckpoint)) referenced.add(row.providerCheckpoint.digest);
					}
				}
			}
		} finally {
			entries.closeSync();
		}
	};
	let removed = 0;
	try {
		if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return 0;
		if (!failedPublication) lastSweep = { root, at: started };
		const candidates: Array<{ path: string; digest: string }> = [];
		const consider = (name: string): void => {
			withinBudget();
			if (!/^[a-f0-9]{64}\.json$/u.test(name)) return;
			const path = join(directory, name);
			const stat = lstatSync(path);
			if (!stat.isFile() || (!failedPublication && Date.now() - stat.mtimeMs < PRUNE_GRACE_MS)) return;
			if (
				(enforcesPrivateMode(path) && (stat.mode & 0o777) !== 0o600) ||
				(process.getuid && stat.uid !== process.getuid())
			)
				return;
			candidates.push({ path, digest: name.slice(0, -5) });
		};
		if (failedPublication) {
			if (!isProviderCheckpointHandle(failedPublication)) return 0;
			consider(`${failedPublication.digest}.json`);
		} else {
			const entries = opendirSync(directory);
			try {
				for (let entry = entries.readSync(); entry; entry = entries.readSync()) consider(entry.name);
			} finally {
				entries.closeSync();
			}
		}
		if (candidates.length === 0) return 0;
		if (lstatSync(join(root, "sessions"), { throwIfNoEntry: false })?.isDirectory()) collect(join(root, "sessions"));
		for (const { path, digest } of candidates) {
			withinBudget();
			if (referenced.has(digest)) continue;
			unlinkSync(path);
			removed += 1;
		}
	} catch {
		// An incomplete, unreadable or over-budget scan cannot prove absence. Retain unproven candidates (#423).
	}
	return removed;
}
