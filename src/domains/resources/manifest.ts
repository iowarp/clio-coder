import type { DomainManifest } from "../../core/domain-loader.js";

export const ResourcesManifest: DomainManifest<"resources"> = {
	name: "resources",
	dependsOn: ["config"],
};
