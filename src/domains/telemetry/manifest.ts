import type { DomainManifest } from "../../core/domain-loader.js";

export const TelemetryManifest: DomainManifest = {
	// telemetry listens to dispatch + safety bus channels but never reads
	// their contracts. Keeping dispatch out of dependsOn lets scheduling sit
	// between telemetry and dispatch (scheduling -> telemetry, dispatch
	// -> scheduling) without a topological cycle.
	name: "telemetry",
	// Telemetry capture follows the operator's `telemetry` settings (#434).
	dependsOn: ["config", "providers", "session"],
};
