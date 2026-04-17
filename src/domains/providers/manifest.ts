import type { DomainManifest } from "../../core/domain-loader.js";

export const ProvidersManifest: DomainManifest = {
	name: "providers",
	dependsOn: ["config"],
};
