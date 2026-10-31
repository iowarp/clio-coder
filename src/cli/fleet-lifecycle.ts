import {
	SAFE_EXEC_DEFAULT_KILL_GRACE_MS,
	SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS,
	SAFE_EXEC_PIPE_DRAIN_BOUND_MS,
} from "../core/safe-exec.js";
import { getTerminationCoordinator, resolveShutdownHookBudgetMs } from "../core/termination.js";

type FleetTermination = Pick<
	ReturnType<typeof getTerminationCoordinator>,
	"installSignalHandlers" | "onTerminate" | "getExitCode"
> &
	Partial<Pick<ReturnType<typeof getTerminationCoordinator>, "onForceExit">>;

export async function runFleetWithShutdown<T>(
	run: (signal: AbortSignal, registerEmergencySeal: (seal: () => void) => () => void) => Promise<T>,
	/** Runs once the run settles, with how it settled, so the host can name its exit status before teardown. */
	cleanup: (settled: { ok: true; value: T } | { ok: false; error: unknown }) => Promise<void>,
	drainAllowanceMs = 0,
	termination: FleetTermination = getTerminationCoordinator(),
	options: { beginDrain?: () => Promise<void>; notice?: (text: string) => void; cleanupAllowanceMs?: number } = {},
): Promise<T> {
	const controller = new AbortController();
	let finish!: () => void;
	const settled = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const timeoutMs =
		Math.max(
			drainAllowanceMs,
			SAFE_EXEC_DEFAULT_KILL_GRACE_MS + SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS + SAFE_EXEC_PIPE_DRAIN_BOUND_MS,
		) +
		3 * resolveShutdownHookBudgetMs() +
		(options.cleanupAllowanceMs ?? 0);
	let emergencySeal: (() => void) | undefined;
	const unregisterForce = termination.onForceExit?.(() => emergencySeal?.());
	const unregister = termination.onTerminate(
		async (shutdownSignal) => {
			const sealOnDeadline = (): void => {
				emergencySeal?.();
			};
			shutdownSignal.addEventListener("abort", sealOnDeadline, { once: true });
			(options.notice ?? ((text) => process.stderr.write(`${text}\n`)))(
				termination.getExitCode() === 130
					? "Fleet run is sealing; a second Ctrl-C exits without completing sealing."
					: "Fleet run is sealing.",
			);
			controller.abort();
			try {
				if (shutdownSignal.aborted) sealOnDeadline();
				await Promise.all([options.beginDrain?.(), settled]);
			} finally {
				shutdownSignal.removeEventListener("abort", sealOnDeadline);
			}
		},
		{ timeoutMs },
	);
	termination.installSignalHandlers();
	let outcome: { ok: true; value: T } | { ok: false; error: unknown } = { ok: false, error: undefined };
	try {
		const value = await run(controller.signal, (seal) => {
			emergencySeal = seal;
			return () => {
				if (emergencySeal === seal) emergencySeal = undefined;
			};
		});
		outcome = { ok: true, value };
		return value;
	} catch (error) {
		outcome = { ok: false, error };
		throw error;
	} finally {
		try {
			await cleanup(outcome);
		} finally {
			unregister();
			unregisterForce?.();
			finish();
		}
	}
}
