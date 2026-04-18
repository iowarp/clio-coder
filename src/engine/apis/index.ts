import { registerApiProvider } from "@mariozechner/pi-ai";

import { lmstudioNativeApiProvider } from "./lmstudio-native.js";
import { ollamaNativeApiProvider } from "./ollama-native.js";

export { lmstudioNativeApiProvider } from "./lmstudio-native.js";
export { ollamaNativeApiProvider } from "./ollama-native.js";

let registered = false;

export function registerClioApiProviders(): void {
	if (registered) return;
	registered = true;
	registerApiProvider(ollamaNativeApiProvider, "clio");
	registerApiProvider(lmstudioNativeApiProvider, "clio");
}
