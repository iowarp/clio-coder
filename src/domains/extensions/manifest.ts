import type { DomainManifest } from "../../core/domain-loader.js";

export const ExtensionsManifest: DomainManifest = {
	name: "extensions",
	dependsOn: ["config"],
};
