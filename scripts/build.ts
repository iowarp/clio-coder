import { build } from "tsup";
import config from "../tsup.config.js";

// Loading through tsx keeps tsup from writing a temporary bundled config into
// the checkout. Build and watch share the same entry and asset policy.
if (typeof config === "function" || Array.isArray(config)) throw new Error("Expected one root build configuration.");
await build({ ...config, config: false, ...(process.argv.includes("--watch") ? { watch: true } : {}) });
