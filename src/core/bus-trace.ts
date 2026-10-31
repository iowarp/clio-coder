import { telemetryHub } from "./telemetry/hub.js";

/**
 * Bus tracer (observability scaffolding).
 *
 * When `CLIO_CODER_BUS_TRACE=1` is set in the environment, subscribe once to the
 * shutdown-phase channels, `session.ended`, and the domain lifecycle channels
 * (`domain.loaded`/`domain.failed`, suffixed with the domain name), emitting a
 * single prefixed line per event to stderr. Off by default; local debugging can
 * spawn the CLI with the env var to observe bus ordering across a subprocess boundary.
 *
 * In research telemetry mode with `telemetry.research.busTrace`, the same events
 * go as records to the writer the host hands over, which appends them through
 * the telemetry domain, so a terminal UI is never written over;
 * `CLIO_CODER_BUS_TRACE=1` remains the deprecated stderr alias (#434). Both
 * writes are synchronous because these events are few and their order across
 * shutdown is the point.
 *
 * The tracer lives in `src/core/` (engine-free zone) because it is
 * orchestrator-wide observability, not a domain concern. Add channels to the
 * `TRACED_CHANNELS` list if a future front needs to observe them.
 *
 * Ordering invariant: the first `[clio-coder:bus] shutdown.requested` line must
 * never reach stderr before the `Clio Coder: received <SIGNAL>, shutting down...`
 * notice written by termination.installSignalHandlers in
 * src/core/termination.ts. Future edits to termination.ts must preserve that
 * stderr ordering: write the signal notice synchronously from the signal
 * handler before calling shutdown(), which is where ShutdownRequested is emitted.
 */

const TRACED_CHANNELS = [
	"shutdown.requested",
	"shutdown.drained",
	"shutdown.terminated",
	"shutdown.persisted",
	"session.ended",
	"domain.loaded",
	"domain.failed",
] as const;

function traceSuffix(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const name = (payload as { name?: unknown }).name;
	return typeof name === "string" && name.length > 0 ? ` ${name}` : "";
}

let installed = false;

/** `research` is asked on every event, so a settings change applies to the next one; null writes nothing. */
export function installBusTracer(
	research: () => ((record: Record<string, unknown>) => void) | null = () => null,
): void {
	if (installed) return;
	installed = true;
	const stderr = process.env.CLIO_CODER_BUS_TRACE === "1";
	const bus = telemetryHub();
	for (const channel of TRACED_CHANNELS) {
		bus.subscribe(channel, (payload) => {
			if (stderr) process.stderr.write(`[clio-coder:bus] ${channel}${traceSuffix(payload)}\n`);
			const write = research();
			if (write === null) return;
			try {
				write({ at: new Date().toISOString(), channel, name: traceSuffix(payload).trim() || null });
			} catch {
				// A research trace cannot change shutdown or domain loading.
			}
		});
	}
}
