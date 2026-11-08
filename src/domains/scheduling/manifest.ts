import type { DomainManifest } from "../../core/domain-loader.js";

export const SchedulingManifest: DomainManifest<"scheduling"> = {
	name: "scheduling",
	dependsOn: ["config", "telemetry"],
};
