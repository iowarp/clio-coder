import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { BIRTH_TOKEN_SOURCE_AVAILABLE, processAlive, processBirthToken } from "../../core/process-identity.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";

export interface CheckoutWriterLeaseRecord {
	version: 1;
	checkout: string;
	pid: number;
	processBirthToken: string;
	acquiredAt: string;
}

export interface CheckoutWriterLease {
	checkout: string;
	path: string;
	release(): void;
}

export interface CheckoutWriterLeaseProbe {
	birthToken(pid: number): string | null;
	tokenProvesDeath?: boolean;
	alive?(pid: number): boolean;
}

const held = new Map<string, { count: number; path: string }>();
let exitHooksInstalled = false;

function canonicalCheckout(checkout: string): string {
	return realpathSync(checkout);
}

function checkoutWriterLeasePath(checkout: string): string {
	const canonical = canonicalCheckout(checkout);
	const key = createHash("sha256").update(canonical, "utf8").digest("hex");
	return join(clioStateDir(), "checkout-writer-leases", `${key}.json`);
}

function validRecord(value: unknown): value is CheckoutWriterLeaseRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<CheckoutWriterLeaseRecord>;
	return (
		record.version === 1 &&
		typeof record.checkout === "string" &&
		Number.isSafeInteger(record.pid) &&
		(record.pid ?? 0) > 0 &&
		typeof record.processBirthToken === "string" &&
		typeof record.acquiredAt === "string" &&
		Number.isFinite(Date.parse(record.acquiredAt))
	);
}

function readRecord(path: string): CheckoutWriterLeaseRecord | null {
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!validRecord(value)) throw new Error("invalid schema");
		return value;
	} catch (error) {
		throw new Error(
			`checkout writer lease is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function ownerAlive(record: CheckoutWriterLeaseRecord, probe: CheckoutWriterLeaseProbe): boolean {
	const current = probe.birthToken(record.pid);
	if (current === null || current !== record.processBirthToken) return false;
	if (probe.tokenProvesDeath === false) return probe.alive?.(record.pid) ?? false;
	return true;
}

const defaultProbe: CheckoutWriterLeaseProbe = {
	birthToken: processBirthToken,
	tokenProvesDeath: BIRTH_TOKEN_SOURCE_AVAILABLE,
	alive: processAlive,
};

function releaseAllOnExit(): void {
	for (const [checkout, entry] of held) {
		try {
			withStateFileLockSync(entry.path, () => {
				const record = readRecord(entry.path);
				if (record?.checkout === checkout && record.pid === process.pid) unlinkSync(entry.path);
			});
		} catch {
			// Process exit is best effort. A stale record is reclaimed by the next admission.
		}
	}
	held.clear();
}

function installExitHooks(): void {
	if (exitHooksInstalled) return;
	exitHooksInstalled = true;
	process.once("exit", releaseAllOnExit);
}

export function acquireCheckoutWriterLease(input: {
	checkout: string;
	nowMs?: number;
	pid?: number;
	processBirthToken?: string;
	probe?: CheckoutWriterLeaseProbe;
}): CheckoutWriterLease {
	const checkout = canonicalCheckout(input.checkout);
	const path = checkoutWriterLeasePath(checkout);
	const local = held.get(checkout);
	if (local !== undefined && (input.pid === undefined || input.pid === process.pid)) {
		local.count += 1;
		let released = false;
		return {
			checkout,
			path,
			release: () => {
				if (released) return;
				released = true;
				releaseCheckoutWriterLease(checkout);
			},
		};
	}
	mkdirSync(dirname(path), { recursive: true });
	const ownerPid = input.pid ?? process.pid;
	const token = input.processBirthToken ?? processBirthToken(ownerPid);
	if (token === null) throw new Error("dispatch: cannot establish checkout writer process birth token");
	withStateFileLockSync(path, () => {
		const existing = readRecord(path);
		if (existing !== null && ownerAlive(existing, input.probe ?? defaultProbe)) {
			throw new Error(`checkout_writer_lease_held: checkout writer lease is held by pid ${existing.pid}`);
		}
		const record: CheckoutWriterLeaseRecord = {
			version: 1,
			checkout,
			pid: ownerPid,
			processBirthToken: token,
			acquiredAt: new Date(input.nowMs ?? Date.now()).toISOString(),
		};
		atomicWrite(path, JSON.stringify(record, null, 2));
	});
	if (ownerPid === process.pid) {
		held.set(checkout, { count: 1, path });
		installExitHooks();
	}
	let released = false;
	return {
		checkout,
		path,
		release: () => {
			if (released) return;
			released = true;
			if (ownerPid === process.pid) releaseCheckoutWriterLease(checkout);
			else releaseLeaseRecord(path, checkout, ownerPid, token);
		},
	};
}

function releaseLeaseRecord(path: string, checkout: string, pid: number, token: string): void {
	withStateFileLockSync(path, () => {
		const record = readRecord(path);
		if (record?.checkout === checkout && record.pid === pid && record.processBirthToken === token) unlinkSync(path);
	});
}

function releaseCheckoutWriterLease(checkout: string): void {
	const entry = held.get(checkout);
	if (entry === undefined) return;
	entry.count -= 1;
	if (entry.count > 0) return;
	held.delete(checkout);
	const token = processBirthToken(process.pid);
	if (token !== null) releaseLeaseRecord(entry.path, checkout, process.pid, token);
}
