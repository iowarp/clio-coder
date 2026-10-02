/**
 * Files this session's typed write created, keyed by physical path, with the
 * identity its own last write or edit left behind.
 *
 * The `outside-file-replacement` safety rail asks before write or edit
 * replaces an existing file outside the workspace, at every posture short of
 * an operator confirmation. A file the session created moments earlier is its
 * own draft, and asking again on every revision parked YOLO runs on approval
 * cards for notes Clio had just written. The rail lets YOLO through only while
 * the file's current identity still matches this record: an external write, an
 * atomic replace or a touch changes the inode, size or mtime and the rail asks
 * again. A file that existed before the session never enters the record.
 *
 * Per process and in memory: a worker keeps its own, and the safety domain
 * clears it whenever the session is parked (new, resume, fork, close).
 */
export interface AuthoredFileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

const authored = new Map<string, AuthoredFileIdentity>();

function sameIdentity(a: AuthoredFileIdentity, b: AuthoredFileIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function identityOf(info: AuthoredFileIdentity): AuthoredFileIdentity {
	return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
}

/**
 * Records one published write. A publish that created the file starts a
 * record; one that replaced a recorded file refreshes it only when the file it
 * replaced was still the session's own last version, and otherwise drops it.
 */
export function recordAuthoredPublish(
	target: string,
	previous: AuthoredFileIdentity | null,
	after: AuthoredFileIdentity,
): void {
	if (previous === null) {
		authored.set(target, identityOf(after));
		return;
	}
	const known = authored.get(target);
	if (known === undefined) return;
	if (sameIdentity(known, previous)) authored.set(target, identityOf(after));
	else authored.delete(target);
}

/** True when this session created target and nothing else has written it since. */
export function isSessionAuthoredFile(target: string, current: AuthoredFileIdentity): boolean {
	const known = authored.get(target);
	return known !== undefined && sameIdentity(known, current);
}

export function clearSessionAuthoredFiles(): void {
	authored.clear();
}
