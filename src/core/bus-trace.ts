/**
 * Bus tracer (observability scaffolding).
 *
 * When `CLIO_BUS_TRACE=1` is set in the environment, subscribe once to the
 * shutdown-phase channels and `session.end`, emitting a single prefixed line
 * per event to stderr. Off by default; diag scripts spawn the CLI with the
 * env var to observe bus ordering across a subprocess boundary.
 *
 * The tracer lives in `src/core/` (engine-free zone) because it is
 * orchestrator-wide observability, not a domain concern. Add channels to the
 * `TRACED_CHANNELS` list if a future front needs to observe them.
 *
 * Ordering invariant: the first `[clio:bus] shutdown.requested` line must
 * never reach stderr before the `clio: received <SIGNAL>, shutting down...`
 * notice written by termination.installSignalHandlers in
 * src/core/termination.ts. The Front 1 diag (scripts/diag-interactive.ts)
 * asserts the SIGINT notice is present on stderr before the bus trace lines,
 * and future edits to termination.ts must preserve that stderr ordering.
 * Concretely: write the signal notice synchronously from the signal handler
 * before calling shutdown(), which is where ShutdownRequested is emitted.
 */

import { BusChannels } from "./bus-events.js";
import { getSharedBus } from "./shared-bus.js";

const TRACED_CHANNELS = [
	BusChannels.ShutdownRequested,
	BusChannels.ShutdownDrained,
	BusChannels.ShutdownTerminated,
	BusChannels.ShutdownPersisted,
	BusChannels.SessionEnd,
] as const;

let installed = false;

export function installBusTracer(): void {
	if (installed) return;
	if (process.env.CLIO_BUS_TRACE !== "1") return;
	installed = true;
	const bus = getSharedBus();
	for (const channel of TRACED_CHANNELS) {
		bus.on(channel, () => {
			process.stderr.write(`[clio:bus] ${channel}\n`);
		});
	}
}

export function resetBusTracerForTests(): void {
	installed = false;
}
