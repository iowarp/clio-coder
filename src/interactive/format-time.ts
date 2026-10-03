// The formatters live in src/core/format-time.ts so the /view artifact
// providers in src/domains/session/view-artifacts.ts render the same local
// times for the terminal and for ACP clients (ACP ask 03).
export * from "../core/format-time.js";
