import type { DomainManifest } from "../../core/domain-loader.js";

export const ObservabilityManifest: DomainManifest = {
	// observability listens to dispatch + safety bus channels but never reads
	// their contracts. Keeping dispatch out of dependsOn lets scheduling sit
	// between observability and dispatch (scheduling -> observability, dispatch
	// -> scheduling) without a topological cycle.
	name: "observability",
	dependsOn: ["providers", "session"],
};
