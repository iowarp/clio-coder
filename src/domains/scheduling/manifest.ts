import type { DomainManifest } from "../../core/domain-loader.js";

export const SchedulingManifest: DomainManifest = {
	name: "scheduling",
	dependsOn: ["config", "observability"],
};
