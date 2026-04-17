import type { DomainManifest } from "../../core/domain-loader.js";

export const SafetyManifest: DomainManifest = {
	name: "safety",
	dependsOn: ["config"],
};
