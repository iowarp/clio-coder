import type { DomainManifest } from "../../core/domain-loader.js";

export const ProvidersManifest: DomainManifest<"providers"> = {
	name: "providers",
	dependsOn: ["config"] as const,
};
