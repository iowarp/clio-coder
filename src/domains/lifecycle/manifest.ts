import type { DomainManifest } from "../../core/domain-loader.js";

export const LifecycleManifest: DomainManifest = {
	name: "lifecycle",
	dependsOn: ["config"],
};
