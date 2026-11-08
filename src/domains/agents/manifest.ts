import type { DomainManifest } from "../../core/domain-loader.js";

export const AgentsManifest: DomainManifest<"agents"> = {
	name: "agents",
	dependsOn: ["config"],
};
