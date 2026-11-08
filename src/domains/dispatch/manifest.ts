import type { DomainManifest } from "../../core/domain-loader.js";

export const DispatchManifest: DomainManifest<"dispatch"> = {
	name: "dispatch",
	dependsOn: ["config", "safety", "agents", "providers", "middleware", "prompts", "scheduling"],
};
