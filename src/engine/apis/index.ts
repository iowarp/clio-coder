import { registerApiProvider } from "@mariozechner/pi-ai";

import { ollamaNativeApiProvider } from "./ollama-native.js";

export { ollamaNativeApiProvider } from "./ollama-native.js";

let registered = false;

export function registerClioApiProviders(): void {
	if (registered) return;
	registered = true;
	registerApiProvider(ollamaNativeApiProvider, "clio");
}
