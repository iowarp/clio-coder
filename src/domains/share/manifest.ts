import type { DomainManifest } from "../../core/domain-loader.js";

export const ShareManifest: DomainManifest<"share"> = {
	name: "share",
	dependsOn: ["config", "extensions", "resources"],
};
