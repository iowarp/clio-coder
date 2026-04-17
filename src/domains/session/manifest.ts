import type { DomainManifest } from "../../core/domain-loader.js";

export const SessionManifest: DomainManifest = {
	name: "session",
	dependsOn: ["config", "modes"],
};
