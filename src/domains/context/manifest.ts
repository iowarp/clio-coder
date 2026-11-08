import type { DomainManifest } from "../../core/domain-loader.js";

export const ContextManifest: DomainManifest<"context"> = {
	name: "context",
	dependsOn: ["resources"],
};
