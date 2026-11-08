import type { DomainManifest } from "../../core/domain-loader.js";

export const PluginsManifest: DomainManifest<"plugins"> = { name: "plugins", dependsOn: ["config"] };
