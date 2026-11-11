import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { withVerificationSlot } from "../../src/domains/dispatch/verification-slot.js";

const LOCK = "dispatch-verification-slot.lock";

async function withSlotDir(fn: (scratch: string, use: (dir: string) => void) => Promise<void>): Promise<void> {
	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-slot-dir-"));
	const saved = process.env.CLIO_CODER_VERIFICATION_SLOT_DIR;
	try {
		await fn(scratch, (dir) => {
			process.env.CLIO_CODER_VERIFICATION_SLOT_DIR = dir;
		});
	} finally {
		if (saved === undefined) delete process.env.CLIO_CODER_VERIFICATION_SLOT_DIR;
		else process.env.CLIO_CODER_VERIFICATION_SLOT_DIR = saved;
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Runs one check through the slot and reports whether it held the lock in `dir` and whether the slot was unavailable. */
async function runCheck(dir: string): Promise<{ ran: boolean; heldLock: boolean; unavailable: unknown[] }> {
	const unavailable: unknown[] = [];
	let heldLock = false;
	const ran = await withVerificationSlot(
		"slot dir test",
		async () => {
			heldLock = existsSync(join(dir, LOCK));
			return true;
		},
		{ onUnavailable: (error) => unavailable.push(error) },
	);
	return { ran, heldLock, unavailable };
}

describe("verification slot directory", { skip: process.getuid === undefined }, () => {
	it("creates a fresh slot directory 0700 and takes the slot in it", () =>
		withSlotDir(async (scratch, use) => {
			const dir = join(scratch, "slot");
			use(dir);
			const result = await runCheck(dir);
			deepStrictEqual(result, { ran: true, heldLock: true, unavailable: [] });
			strictEqual(lstatSync(dir).mode & 0o777, 0o700);
		}));

	it("runs the check without the slot when the directory is open to others", () =>
		withSlotDir(async (scratch, use) => {
			const dir = join(scratch, "slot");
			mkdirSync(dir);
			chmodSync(dir, 0o777);
			use(dir);
			const result = await runCheck(dir);
			strictEqual(result.ran, true);
			strictEqual(result.heldLock, false);
			strictEqual(result.unavailable.length, 1);
			ok(String(result.unavailable[0]).includes("0700"), String(result.unavailable[0]));
			deepStrictEqual(readdirSync(dir), []);
		}));

	it("runs the check without the slot when the directory is a symlink", () =>
		withSlotDir(async (scratch, use) => {
			const target = join(scratch, "elsewhere");
			mkdirSync(target, { mode: 0o700 });
			const dir = join(scratch, "slot");
			symlinkSync(target, dir);
			use(dir);
			const result = await runCheck(dir);
			strictEqual(result.ran, true);
			strictEqual(result.heldLock, false);
			strictEqual(result.unavailable.length, 1);
			deepStrictEqual(readdirSync(target), []);
		}));
});
