import type { DomainManifest } from "../../core/domain-loader.js";

export const ModesManifest: DomainManifest = {
	name: "modes",
	dependsOn: ["config", "safety"],
};
