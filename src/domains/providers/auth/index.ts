import { FileAuthStorageBackend } from "./backend-file.js";
import { AuthStorage } from "./storage.js";

export function openAuthStorage(path?: string): AuthStorage {
	return new AuthStorage(new FileAuthStorageBackend(path));
}

export { authStoragePath, FileAuthStorageBackend } from "./backend-file.js";
export { InMemoryAuthStorageBackend } from "./backend-memory.js";
export { isBuiltinClaudeAcp, resolveClaudeLaunchCredential } from "./claude-subscription.js";
export type {
	ApiKeyCredential,
	AuthCredential,
	AuthResolution,
	AuthStatus,
	AuthStorageBackend,
	AuthStorageData,
	AuthTarget,
	OAuthCredential,
} from "./storage.js";
export {
	AuthStorage,
	AuthStorageDamagedError,
	authNotRequiredStatus,
	RETIRED_GITHUB_COPILOT_MESSAGE,
	RETIRED_GITHUB_COPILOT_PROVIDER_ID,
	resolveAuthTarget,
	resolveRuntimeAuthTarget,
	targetRequiresAuth,
} from "./storage.js";
export { applyTargetCredentialPlan, planTargetCredentialRemoval } from "./target-credential.js";
