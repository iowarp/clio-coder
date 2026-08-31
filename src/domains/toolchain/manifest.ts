import type { DomainManifest } from "../../core/domain-loader.js";

export const ToolchainManifest: DomainManifest = {
	name: "toolchain",
	// The registry is a static table plus filesystem lookups under the data
	// root. It reads no settings and calls no other domain.
	dependsOn: [],
};
