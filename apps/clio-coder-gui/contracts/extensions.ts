import {
	AcpExtensionReloadSchema,
	AcpLibraryReloadSchema,
	AcpSessionExtensionsSchema,
	AcpExtensionsCapability as ExtensionsCapability,
	AcpLibraryCapability as LibraryCapability,
} from "./wire.js";

export { ExtensionsCapability, LibraryCapability };

import type { Static } from "typebox";

// `_clio-coder/extensions/*` and `_clio-coder/library/reload`: the terminal's /extensions view and the two
// reloads. The agent bounds extensions at 64, lines at 40 and every string at 512 bytes.

export const SessionExtensions = AcpSessionExtensionsSchema;
export type SessionExtensions = Static<typeof SessionExtensions>;

export const ExtensionReload = AcpExtensionReloadSchema;
export type ExtensionReload = Static<typeof ExtensionReload>;

export const LibraryReload = AcpLibraryReloadSchema;
