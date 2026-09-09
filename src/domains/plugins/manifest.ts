import type { DomainManifest } from "../../core/domain-loader.js";

export const PluginsManifest: DomainManifest = { name: "plugins", dependsOn: ["config"] };
