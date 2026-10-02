import type { ClioAppKeybindings } from "../domains/config/keybindings.js";

// Keep Pi's ambient augmentation at the engine boundary; action IDs remain Clio-owned.
declare module "@earendil-works/pi-tui" {
	interface Keybindings extends ClioAppKeybindings {}
}
