/**
 * Bus tracer (observability scaffolding).
 *
 * When `CLIO_CODER_BUS_TRACE=1` is set in the environment, subscribe once to the
 * shutdown-phase channels, `session.end`, and the domain lifecycle channels
 * (`domain.loaded`/`domain.failed`, suffixed with the domain name), emitting a
 * single prefixed line per event to stderr. Off by default; local debugging can
 * spawn the CLI with the env var to observe bus ordering across a subprocess boundary.
 *
 * In research telemetry mode with `telemetry.research.busTrace`, the same events
 * are appended as JSON lines to the file the host names instead, so a terminal
 * UI is never written over; `CLIO_CODER_BUS_TRACE=1` remains the deprecated
 * stderr alias (#434). Both writes are synchronous because these events are few
 * and their order across shutdown is the point.
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

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { BusChannels } from "./bus-events.js";
import { getSharedBus } from "./shared-bus.js";

const TRACED_CHANNELS = [
	BusChannels.ShutdownRequested,
	BusChannels.ShutdownDrained,
	BusChannels.ShutdownTerminated,
	BusChannels.ShutdownPersisted,
	BusChannels.SessionEnd,
	BusChannels.DomainLoaded,
	BusChannels.DomainFailed,
] as const;

function traceSuffix(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const name = (payload as { name?: unknown }).name;
	return typeof name === "string" && name.length > 0 ? ` ${name}` : "";
}

/** One previous generation is kept, so a long-lived install's trace stays bounded. */
const RESEARCH_TRACE_BYTES = 8 * 1024 * 1024;

function appendResearchLine(path: string, channel: string, payload: unknown): void {
	try {
		const line = `${JSON.stringify({ at: new Date().toISOString(), channel, name: traceSuffix(payload).trim() || null })}\n`;
		if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > RESEARCH_TRACE_BYTES)
			renameSync(path, `${path}.1`);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		appendFileSync(path, line, { mode: 0o600 });
	} catch {
		// A research trace cannot change shutdown or domain loading.
	}
}

let installed = false;

/** `researchFile` is asked on every event, so a settings change applies to the next one. */
export function installBusTracer(researchFile: () => string | null = () => null): void {
	if (installed) return;
	installed = true;
	const stderr = process.env.CLIO_CODER_BUS_TRACE === "1";
	const bus = getSharedBus();
	for (const channel of TRACED_CHANNELS) {
		bus.on(channel, (payload) => {
			if (stderr) process.stderr.write(`[clio-coder:bus] ${channel}${traceSuffix(payload)}\n`);
			const path = researchFile();
			if (path !== null) appendResearchLine(path, channel, payload);
		});
	}
}
