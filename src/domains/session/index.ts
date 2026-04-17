import type { DomainModule } from "../../core/domain-loader.js";
import { createSessionBundle } from "./extension.js";
import { SessionManifest } from "./manifest.js";

export const SessionDomainModule: DomainModule = {
	manifest: SessionManifest,
	createExtension: createSessionBundle,
};

export { SessionManifest } from "./manifest.js";
export type { SessionContract, SessionMeta, ClioSessionMetaExtension, TurnInput } from "./contract.js";
