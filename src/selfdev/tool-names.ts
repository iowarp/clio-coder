import { dynamicToolName, type ToolName } from "../core/tool-names.js";

export const SelfDevToolNames = {
	ClioIntrospect: dynamicToolName("clio_introspect"),
	ClioRecall: dynamicToolName("clio_recall"),
	ClioRemember: dynamicToolName("clio_remember"),
	ClioMemoryMaintain: dynamicToolName("clio_memory_maintain"),
} as const;

export const SELFDEV_WORKER_TOOL_NAMES: ReadonlyArray<ToolName> = [
	SelfDevToolNames.ClioIntrospect,
	SelfDevToolNames.ClioRecall,
	SelfDevToolNames.ClioRemember,
	SelfDevToolNames.ClioMemoryMaintain,
];
