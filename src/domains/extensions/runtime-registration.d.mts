import type { ExtensionRuntimeDeclarationV2 } from "./manifest-v2.js";
import type { ExtensionApiV2 } from "./public-api-v2.js";

export interface RuntimeRegistration {
	api: ExtensionApiV2;
	commands: Map<string, Parameters<ExtensionApiV2["handle"]>[1]>;
	observers: Map<string, Parameters<ExtensionApiV2["on"]>[1]>;
	hooks: Map<string, Parameters<ExtensionApiV2["hook"]>[1]>;
	tools: Map<string, Parameters<ExtensionApiV2["tool"]>[1]>;
	actions: Map<string, Parameters<ExtensionApiV2["action"]>[1]>;
	interviews: Map<string, Parameters<ExtensionApiV2["interview"]>[1]>;
	disposers: Array<Parameters<ExtensionApiV2["onDispose"]>[0]>;
	finish(): void;
}
export function createRuntimeRegistration(declaration: ExtensionRuntimeDeclarationV2): RuntimeRegistration;
