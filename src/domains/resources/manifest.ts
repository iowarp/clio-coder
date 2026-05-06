import type { DomainManifest } from "../../core/domain-loader.js";

export const ResourcesManifest: DomainManifest = {
	name: "resources",
	dependsOn: ["config"],
};
