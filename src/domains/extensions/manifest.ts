import type { DomainManifest } from "../../core/domain-loader.js";

export const ExtensionsManifest: DomainManifest<"extensions"> = {
	name: "extensions",
	dependsOn: ["config"],
};
