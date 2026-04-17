import type { DomainManifest } from "../../core/domain-loader.js";

export const ObservabilityManifest: DomainManifest = {
	name: "observability",
	dependsOn: ["providers", "dispatch", "session"],
};
