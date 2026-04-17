import type { DomainManifest } from "../../core/domain-loader.js";

export const AgentsManifest: DomainManifest = {
	name: "agents",
	dependsOn: ["config", "modes"],
};
