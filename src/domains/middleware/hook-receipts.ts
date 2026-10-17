/**
 * Durable receipt log for user-defined middleware hooks. Every hook execution
 * emits a {@link HookReceipt}; this log keeps a bounded in-memory ring and
 * persists it atomically through safeResourceWrite. Writes are throttled so a
 * per-tool-call cadence never turns into per-call disk I/O; a receipt recorded
 * inside the window gets one trailing write when it closes, and `flush()`
 * forces a final write at shutdown. `clio-coder config inspect` reads the persisted
 * snapshot back with {@link readPersistedHookReceipts}, since it runs as its
 * own process and has no access to a running session's in-memory ring.
 */

import { readFileSync } from "node:fs";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type { HookReceipt } from "./hooks.js";

export const HOOK_RECEIPT_LOG_CAPACITY = 200;
const PERSIST_THROTTLE_MS = 2_000;

export interface HookReceiptLog {
	record(receipt: HookReceipt): void;
	list(): HookReceipt[];
	flush(): void;
}

export interface HookReceiptLogOptions {
	capacity?: number;
	/** Absolute path for the durable JSON snapshot. Omit for in-memory only. */
	persistPath?: string;
	/** Receipts the ring starts with, oldest first, such as the persisted snapshot. */
	initial?: ReadonlyArray<HookReceipt>;
	now?: () => number;
	throttleMs?: number;
}

interface PersistedReceipts {
	version: 1;
	receipts: HookReceipt[];
}

export function createHookReceiptLog(options: HookReceiptLogOptions = {}): HookReceiptLog {
	const capacity = options.capacity ?? HOOK_RECEIPT_LOG_CAPACITY;
	const now = options.now ?? Date.now;
	const throttleMs = options.throttleMs ?? PERSIST_THROTTLE_MS;
	const ring: HookReceipt[] = capacity > 0 ? [...(options.initial ?? [])].slice(-capacity) : [];
	let lastPersistAt = 0;
	let dirty = false;
	let trailing: ReturnType<typeof setTimeout> | undefined;

	const persist = (): void => {
		if (options.persistPath === undefined) return;
		const payload: PersistedReceipts = { version: 1, receipts: ring };
		try {
			safeResourceWrite(options.persistPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
			dirty = false;
		} catch {
			// Receipts are best-effort observability; a failed write must not throw.
		}
	};

	const cancelTrailing = (): void => {
		if (trailing === undefined) return;
		clearTimeout(trailing);
		trailing = undefined;
	};

	return {
		record(receipt) {
			ring.push(receipt);
			while (ring.length > capacity) ring.shift();
			dirty = true;
			const elapsed = now() - lastPersistAt;
			if (elapsed >= throttleMs) {
				cancelTrailing();
				lastPersistAt = now();
				persist();
				return;
			}
			if (options.persistPath === undefined || trailing !== undefined) return;
			// Without a trailing write the last receipt of a burst stayed in
			// memory until the next hooked call or exit, so a live session's
			// snapshot lagged on disk. Unref'd so it never holds the process open.
			trailing = setTimeout(() => {
				trailing = undefined;
				lastPersistAt = now();
				if (dirty) persist();
			}, throttleMs - elapsed);
			trailing.unref?.();
		},
		list() {
			return [...ring];
		},
		flush() {
			cancelTrailing();
			if (dirty) persist();
		},
	};
}

/**
 * Read a log's persisted snapshot back, for a process that never held the
 * live log (`config inspect` runs as its own invocation). A log that has
 * never persisted yet reads as empty, not an error.
 */
export function readPersistedHookReceipts(persistPath: string): HookReceipt[] {
	let raw: string;
	try {
		raw = readFileSync(persistPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const parsed = JSON.parse(raw) as Partial<PersistedReceipts>;
	if (parsed.version !== 1 || !Array.isArray(parsed.receipts)) {
		throw new Error(`${persistPath}: unrecognized hook receipt log shape`);
	}
	return parsed.receipts;
}
