import type { DomainManifest } from "../../core/domain-loader.js";

export const SafetyManifest: DomainManifest<"safety"> = {
	name: "safety",
	dependsOn: ["config"],
};
