import { telemetryHub } from "./telemetry/hub.js";

/**
 * Bus tracer (observability scaffolding).
 *
 * Subscribes once to the shutdown-phase channels, `session.ended`, and the domain
 * lifecycle channels (`domain.loaded`/`domain.failed`, with the domain name). In
 * research telemetry mode with `telemetry.research.busTrace`, each event goes as a
 * record to the writer the host hands over, which appends it through the
 * telemetry domain, so a terminal UI is never written over (#434). The write is
 * synchronous because these events are few and their order across shutdown is
 * the point.
 *
 * The tracer lives in `src/core/` (engine-free zone) because it is
 * orchestrator-wide observability, not a domain concern. Add channels to the
 * `TRACED_CHANNELS` list if a future front needs to observe them.
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
	const bus = telemetryHub();
	for (const channel of TRACED_CHANNELS) {
		bus.subscribe(channel, (payload) => {
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
