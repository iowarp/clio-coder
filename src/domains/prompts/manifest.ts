import type { DomainManifest } from "../../core/domain-loader.js";

export const PromptsManifest: DomainManifest = {
	name: "prompts",
	// agents: the compiled session prompt carries the fleet roster, so the
	// recipe registry must be loaded before the first compile.
	dependsOn: ["config", "context", "resources", "agents"],
};
