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
 * A wait that outlasts {@link VERIFICATION_SLOT_WAIT_MS}, or a lock that cannot
 * be taken at all, runs the check without the slot and says so: the slot is
 * there to spread load, never to fail or hang a verification.
 */

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

function verificationSlotPath(): string {
	return join(verificationSlotDir(), "dispatch-verification-slot");
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
		return await withStateFileLock(verificationSlotPath(), enter, {
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
