import type { DomainManifest } from "../../core/domain-loader.js";

export const PromptsManifest: DomainManifest = {
	name: "prompts",
	dependsOn: ["config", "modes"],
};
