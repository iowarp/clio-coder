import type { DomainManifest } from "../../core/domain-loader.js";

export const InteropManifest: DomainManifest<"interop"> = {
	name: "interop",
	dependsOn: ["config"],
};
