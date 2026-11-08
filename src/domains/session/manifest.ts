import type { DomainManifest } from "../../core/domain-loader.js";

export const SessionManifest: DomainManifest<"session"> = {
	name: "session",
	dependsOn: ["config"],
};
