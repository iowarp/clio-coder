// The /view providers moved to src/domains/session/view-artifacts.ts so ACP
// clients read the same artifacts (ACP ask 03). Existing contract tests import
// them from this path.
export * from "../../domains/session/view-artifacts.js";
