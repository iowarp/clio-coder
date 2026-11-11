/**
 * The verification slot: one host-verification check at a time per machine.
 *
 * Host verification runs a task's declared checks on the host, and a whole-repo
 * check (typecheck, a full test suite, an unscoped lint) can use every core.
 * Parallel batches in one session, and parallel Clio sessions on one machine,
 * each ran theirs at once and drove the load far past the core count. Every
 * check that spawns now takes this slot first, so they queue instead. The slot
 * is machine-wide, not per state root, so sessions under different Clio homes
 * queue too: `dispatch-verification-slot.lock` in {@link verificationSlotDir},
 * taken through the shared state-file lock, so a holder that dies frees it and
 * a waiter in the same process queues like one in another.
 *
 * A wait that outlasts {@link VERIFICATION_SLOT_WAIT_MS}, a lock that cannot
 * be taken at all, or a slot directory this user does not hold alone (see
 * {@link ownSlotDir}) runs the check without the slot and says so: the slot is
 * there to spread load, never to fail or hang a verification.
 */

import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { withStateFileLock } from "../../core/state-file-lock.js";

/** How long a check waits for the slot before it runs without it. */
const VERIFICATION_SLOT_WAIT_MS = 30 * 60_000;

/** Feed event type a run's host verification publishes; see {@link VerificationSlotState}. */
export const HOST_VERIFICATION_EVENT = "host_verification";
/** The event's `message`: the run waits for the slot, then holds it and runs its checks. */
export type VerificationSlotState = "waiting for a verification slot" | "running host checks";

export interface VerificationSlotEvents {
	/** Another holder has the slot; called once per wait, before the check runs. */
	onWaiting?: () => void;
	/** This check holds the slot (or gave up waiting for it) and is about to run. */
	onTaken?: () => void;
	/** The slot could not be taken; the check runs without it. */
	onUnavailable?: (error: unknown) => void;
}

/**
 * The machine-level directory holding the slot, shared across Clio homes:
 * `CLIO_CODER_VERIFICATION_SLOT_DIR` when set to an absolute path, else
 * `$XDG_RUNTIME_DIR/clio-coder`, else a per-user directory in the OS temp dir.
 */
function verificationSlotDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.CLIO_CODER_VERIFICATION_SLOT_DIR;
	if (override !== undefined && isAbsolute(override)) return override;
	const runtime = env.XDG_RUNTIME_DIR;
	if (runtime !== undefined && isAbsolute(runtime)) return join(runtime, "clio-coder");
	let user: string;
	try {
		user = String(userInfo().uid >= 0 ? userInfo().uid : userInfo().username);
	} catch {
		user = "user";
	}
	return join(tmpdir(), `clio-coder-${user}`);
}

/**
 * Creates the slot directory 0700 and throws unless it is a real directory
 * this user owns with no group or other bits: in a shared temp dir another
 * user could pre-create it, or a symlink in its place, and so hold or
 * redirect the slot. The owner and mode test is skipped where there are no
 * uids (Windows).
 */
function ownSlotDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const info = lstatSync(dir);
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(
			`The verification slot directory ${dir} is not a directory (a symlink or other file is in its place).`,
		);
	const uid = process.getuid?.();
	if (uid === undefined) return;
	if (info.uid !== uid)
		throw new Error(`The verification slot directory ${dir} is owned by uid ${info.uid}, not this user (uid ${uid}).`);
	if ((info.mode & 0o077) !== 0)
		throw new Error(
			`The verification slot directory ${dir} has mode ${(info.mode & 0o777).toString(8).padStart(4, "0")}; it must be 0700.`,
		);
}

/** Run `fn` holding the verification slot; see the module comment. */
export async function withVerificationSlot<T>(
	note: string,
	fn: () => Promise<T>,
	events: VerificationSlotEvents = {},
	waitMs: number = VERIFICATION_SLOT_WAIT_MS,
): Promise<T> {
	let entered = false;
	let waiting = false;
	const enter = (): Promise<T> => {
		entered = true;
		events.onTaken?.();
		return fn();
	};
	try {
		const dir = verificationSlotDir();
		ownSlotDir(dir);
		return await withStateFileLock(join(dir, "dispatch-verification-slot"), enter, {
			timeoutMs: waitMs,
			note,
			onContended: () => {
				if (waiting) return;
				waiting = true;
				events.onWaiting?.();
			},
		});
	} catch (error) {
		if (entered) throw error;
		events.onUnavailable?.(error);
		return enter();
	}
}
