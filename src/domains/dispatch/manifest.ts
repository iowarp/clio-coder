import type { DomainManifest } from "../../core/domain-loader.js";

export const DispatchManifest: DomainManifest = {
	name: "dispatch",
	dependsOn: ["config", "safety", "modes", "agents", "providers", "middleware"],
};
