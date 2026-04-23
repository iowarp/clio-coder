import { FileAuthStorageBackend } from "./backend-file.js";
import { InMemoryAuthStorageBackend } from "./backend-memory.js";
import { AuthStorage, type AuthStorageData } from "./storage.js";

export function openAuthStorage(path?: string): AuthStorage {
	return new AuthStorage(new FileAuthStorageBackend(path));
}

export function createMemoryAuthStorage(data: AuthStorageData = {}): AuthStorage {
	const backend = new InMemoryAuthStorageBackend();
	const storage = new AuthStorage(backend);
	for (const [providerId, credential] of Object.entries(data)) {
		storage.set(providerId, credential);
	}
	return storage;
}

export { FileAuthStorageBackend } from "./backend-file.js";
export { InMemoryAuthStorageBackend } from "./backend-memory.js";
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
export { AuthStorage, resolveAuthTarget, resolveRuntimeAuthTarget } from "./storage.js";
