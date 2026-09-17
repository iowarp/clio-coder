import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import {
	appendSessionFileEntry,
	createSession,
	openSession,
	readSessionFileEntries,
	readSessionMeta,
	sessionPaths,
} from "../../src/engine/session.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const at = "2026-09-17T00:00:00.000Z";
const text = "before é中🧪 after";
const turn = (id: string, parentId: string | null = null) => ({
	id,
	parentId,
	at,
	kind: "user" as const,
	payload: { text },
});
const entry = (id: string) => ({
	kind: "message",
	turnId: id,
	parentTurnId: null,
	timestamp: at,
	role: "user",
	payload: { text },
});

// Track descriptors from fixture creation onward, including the append fd
// already held when fault injection starts. Closing removes reused fd numbers.
const descriptorPaths = new Map<number, string>();
const syncedPaths: Array<string | undefined> = [];
function trackFixtureDescriptors(): () => void {
	const open = fs.openSync;
	const close = fs.closeSync;
	const fsync = fs.fsyncSync;
	fs.openSync = (path, flags, mode) => {
		const fd = open(path, flags, mode);
		descriptorPaths.set(fd, resolve(path instanceof URL ? fileURLToPath(path) : path.toString()));
		return fd;
	};
	fs.closeSync = (fd) => {
		close(fd);
		descriptorPaths.delete(fd);
	};
	fs.fsyncSync = (fd) => {
		fsync(fd);
		syncedPaths.push(descriptorPaths.get(fd));
	};
	syncBuiltinESMExports();
	return () => {
		fs.openSync = open;
		fs.closeSync = close;
		fs.fsyncSync = fsync;
		descriptorPaths.clear();
		syncedPaths.length = 0;
		syncBuiltinESMExports();
	};
}

// Patch only the intended fd and always restore the live ESM bindings.
function withWriteFault(
	path: string | RegExp,
	mode: "short" | "zero" | "throw",
	run: () => void,
	prefixBytes = 1,
): void {
	const original = fs.writeSync;
	let calls = 0;
	fs.writeSync = ((fd: number, data: Uint8Array | string, offset?: number, length?: number) => {
		const target = descriptorPaths.get(fd);
		if (target === undefined || (typeof path === "string" ? target !== resolve(path) : !path.test(target)))
			return Reflect.apply(original, fs, [fd, data, offset, length]);
		calls += 1;
		if (mode === "zero" && calls > 1) return 0;
		if (mode === "throw" && calls > 1) throw new Error("injected write failure");
		const bytes = typeof data === "string" ? Buffer.from(data) : data;
		return original(fd, bytes, offset ?? 0, Math.min(length ?? bytes.length, prefixBytes));
	}) as typeof fs.writeSync;
	syncBuiltinESMExports();
	try {
		run();
		ok(calls > 0, "fault must hit the intended ledger");
		if (mode !== "short") strictEqual(calls, 2, "write a real prefix before the injected failure");
	} finally {
		fs.writeSync = original;
		syncBuiltinESMExports();
	}
}

describe("session integrity", () => {
	let scratch: IsolatedClioEnv;
	let restoreDescriptors: () => void;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-session-integrity-");
		restoreDescriptors = trackFixtureDescriptors();
	});
	afterEach(() => {
		try {
			scratch.restore();
		} finally {
			restoreDescriptors();
		}
	});

	for (const transition of ["resume", "switchBranch"] as const) {
		for (const invalid of [{ garbled: true }, { ...entry("bad"), role: "invalid" }, null]) {
			it(`${transition} refuses schema-invalid JSON without changing either owner or bytes: ${JSON.stringify(invalid)}`, async () => {
				const events: unknown[] = [];
				const current = createSessionBundle({
					bus: { emit: (...args: unknown[]) => events.push(args) },
				} as unknown as DomainContext).contract;
				const old = current.create({ cwd: scratch.dir });
				current.append(turn("old"));
				const bad = createSession({ cwd: scratch.dir });
				bad.writer.append(turn("candidate"));
				await bad.writer.close();
				const oldPaths = sessionPaths(old);
				const badPaths = sessionPaths(bad.meta);
				if (invalid === null) {
					fs.writeFileSync(badPaths.meta, JSON.stringify({ ...readSessionMeta(bad.meta.id), sessionFormatVersion: 3 }));
				}
				fs.appendFileSync(badPaths.current, `${JSON.stringify(invalid)}\n`);
				const paths = [oldPaths.current, oldPaths.meta, badPaths.current, badPaths.meta];
				const before = paths.map((path) => fs.readFileSync(path, "utf8"));
				try {
					throws(() => current[transition](bad.meta.id), /unreadable entry/u);
					strictEqual(current.current()?.id, old.id);
					strictEqual(current.current()?.endedAt, null);
					deepStrictEqual(
						paths.map((path) => fs.readFileSync(path, "utf8")),
						before,
					);
					deepStrictEqual(events, []);
					current.append(turn("continued", "old"));
					strictEqual((openSession(old.id).turns().at(-1) as { turnId: string }).turnId, "continued");
					current.tree();
				} finally {
					await current.close();
				}
			});
		}
	}

	for (const version of [2, 3, 4, 5]) {
		it(`preserves version ${version} admission and torn-tail recovery`, async () => {
			const current = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
			const old = current.create({ cwd: scratch.dir });
			current.append(turn("old"));
			const candidate = createSession({ cwd: scratch.dir });
			candidate.writer.append(turn("candidate"));
			await candidate.writer.close();
			const paths = sessionPaths(candidate.meta);
			fs.writeFileSync(
				paths.meta,
				JSON.stringify({ ...readSessionMeta(candidate.meta.id), sessionFormatVersion: version }),
			);
			// Headerless version 3 remains a supported normalization boundary.
			if (version === 3) fs.writeFileSync(paths.current, `${JSON.stringify(entry("candidate"))}\n`);
			fs.appendFileSync(paths.current, '{"interrupted":');
			try {
				if (version === 2 || version === 5) {
					const before = fs.readFileSync(paths.meta, "utf8");
					throws(() => current.resume(candidate.meta.id), /unsupported format version|newer Clio/u);
					strictEqual(current.current()?.id, old.id);
					strictEqual(fs.readFileSync(paths.meta, "utf8"), before);
					current.append(turn("continued", "old"));
				} else {
					current.switchBranch(candidate.meta.id);
					strictEqual(current.current()?.sessionFormatVersion, 4);
					current.append(turn("continued", "candidate"));
					deepStrictEqual(
						openSession(candidate.meta.id)
							.turns()
							.map((value) => (value as { turnId: string }).turnId),
						["candidate", "continued"],
					);
					current.tree();
				}
			} finally {
				await current.close();
			}
		});
	}

	for (const operation of ["append", "replace", "off-current"] as const) {
		for (const mode of ["short", "zero", "throw"] as const) {
			it(`${operation} handles ${mode} byte writes without losing a later record`, async () => {
				const live = createSession({ cwd: scratch.dir });
				live.writer.append(turn("original"));
				const paths = sessionPaths(live.meta);
				const before = fs.readFileSync(paths.current);
				const write = () => {
					if (operation === "append") live.writer.append(turn("attempt", "original"));
					else if (operation === "replace") live.writer.replaceEntries([entry("attempt")]);
					else appendSessionFileEntry(paths.current, entry("attempt"));
				};
				try {
					withWriteFault(operation === "replace" ? `${paths.current}.tmp` : paths.current, mode, () => {
						if (mode === "short") write();
						else throws(write, /no progress|injected write failure/u);
					});
					if (mode !== "short") {
						deepStrictEqual(fs.readFileSync(paths.current), before);
						if (operation === "replace") strictEqual(fs.existsSync(`${paths.current}.tmp`), false);
					}
					const expected =
						mode === "short" ? (operation === "replace" ? ["attempt"] : ["original", "attempt"]) : ["original"];
					live.writer.append(turn("continued", expected.at(-1)));
					expected.push("continued");
					await live.writer.close();
					const warnings: unknown[] = [];
					const records = readSessionFileEntries(paths.current, { onWarning: (warning) => warnings.push(warning) }).slice(
						1,
					) as Array<{ turnId: string; payload: { text: string } }>;
					deepStrictEqual(warnings, []);
					deepStrictEqual(
						records.map((record) => record.turnId),
						expected,
					);
					ok(records.every((record) => record.payload.text === text));
					const tree = JSON.parse(fs.readFileSync(paths.tree, "utf8")) as Array<{ id: string }>;
					deepStrictEqual(
						tree.map((node) => node.id),
						expected.filter((id) => operation !== "off-current" || id !== "attempt"),
					);
				} finally {
					await live.writer.close();
				}
			});
		}
	}

	it("reports rollback failure and separates its torn bytes before a later append", async () => {
		const live = createSession({ cwd: scratch.dir });
		live.writer.append(turn("original"));
		const paths = sessionPaths(live.meta);
		const original = fs.ftruncateSync;
		fs.ftruncateSync = () => {
			throw new Error("injected rollback failure");
		};
		syncBuiltinESMExports();
		try {
			withWriteFault(paths.current, "throw", () => {
				throws(
					() => live.writer.append(turn("failed", "original")),
					(error: unknown) => {
						ok(error instanceof AggregateError);
						deepStrictEqual(
							error.errors.map((cause: Error) => cause.message),
							["injected write failure", "injected rollback failure"],
						);
						return true;
					},
				);
			});
		} finally {
			fs.ftruncateSync = original;
			syncBuiltinESMExports();
		}
		try {
			live.writer.append(turn("continued", "original"));
			await live.writer.close();
			const warnings: unknown[] = [];
			const records = readSessionFileEntries(paths.current, { onWarning: (warning) => warnings.push(warning) }).slice(
				1,
			) as Array<{ turnId: string }>;
			strictEqual(warnings.length, 1);
			deepStrictEqual(
				records.map((record) => record.turnId),
				["original", "continued"],
			);
			const tree = JSON.parse(fs.readFileSync(paths.tree, "utf8")) as Array<{ id: string }>;
			deepStrictEqual(
				tree.map((node) => node.id),
				["original", "continued"],
			);
		} finally {
			await live.writer.close();
		}
	});

	it("does not leave an incomplete initial temp file for recovery to promote", () => {
		withWriteFault(/[\\/]current\.jsonl\.tmp$/u, "zero", () => {
			throws(() => createSession({ cwd: scratch.dir }), /no progress/u);
		});
		const files = fs.readdirSync(scratch.dir, { recursive: true }) as string[];
		ok(files.some((path) => path.endsWith("meta.json")));
		strictEqual(
			files.some((path) => path.endsWith("current.jsonl.tmp") || path.endsWith("current.jsonl")),
			false,
		);
	});

	it("resumes a persisted branch pin and appends from that selected leaf", async () => {
		const current = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
		const branch = current.create({ cwd: scratch.dir });
		current.append(turn("root"));
		current.append(turn("tip", "root"));
		current.switchTurn("root");
		current.create({ cwd: scratch.dir });
		try {
			current.resume(branch.id);
			current.append(turn("alternate", "root"));
			await current.close();
			const reader = openSession(branch.id);
			strictEqual(reader.tree().at(-1)?.parentId, "root");
			deepStrictEqual(
				reader.tree().map((node) => node.id),
				["root", "tip", "alternate"],
			);
		} finally {
			await current.close();
		}
	});

	it("retains the original ledger and tree when temp publication fails", async () => {
		const live = createSession({ cwd: scratch.dir });
		live.writer.append(turn("original"));
		const paths = sessionPaths(live.meta);
		const before = fs.readFileSync(paths.current);
		const original = fs.renameSync;
		fs.renameSync = (source, target) => {
			if (String(target) === paths.current) throw new Error("injected publication failure");
			return original(source, target);
		};
		syncBuiltinESMExports();
		try {
			throws(() => live.writer.replaceEntries([entry("replacement")]), /injected publication failure/u);
		} finally {
			fs.renameSync = original;
			syncBuiltinESMExports();
		}
		try {
			deepStrictEqual(fs.readFileSync(paths.current), before);
			live.writer.append(turn("continued", "original"));
			await live.writer.close();
			deepStrictEqual(
				openSession(live.meta.id)
					.tree()
					.map((node) => node.id),
				["original", "continued"],
			);
		} finally {
			await live.writer.close();
		}
	});
	it("retains the debounced flush after a failed append without a later successful append", async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout"] });
		const live = createSession({ cwd: scratch.dir });
		const paths = sessionPaths(live.meta);
		live.writer.append(turn("accepted"));
		const before = fs.readFileSync(paths.current);
		try {
			withWriteFault(
				paths.current,
				"throw",
				() => {
					throws(() => live.writer.append(turn("failed", "accepted")), /injected write failure/u);
				},
				3,
			);
			syncedPaths.length = 0;
			context.mock.timers.tick(500);
			deepStrictEqual(syncedPaths, [paths.current]);
			deepStrictEqual(fs.readFileSync(paths.current), before);
		} finally {
			await live.writer.close();
		}
	});

	for (const boundary of ["flushAppends", "persistTree", "close"] as const) {
		for (const failFlush of [false, true]) {
			it(`retains pending durability after failed append through ${boundary}, flush failure ${failFlush}`, async () => {
				const live = createSession({ cwd: scratch.dir });
				const paths = sessionPaths(live.meta);
				live.writer.append(turn("accepted"));
				const before = fs.readFileSync(paths.current);
				withWriteFault(
					paths.current,
					"throw",
					() => {
						throws(() => live.writer.append(turn("failed", "accepted")), /injected write failure/u);
					},
					3,
				);
				deepStrictEqual(fs.readFileSync(paths.current), before);
				syncedPaths.length = 0;
				const fsync = fs.fsyncSync;
				let hits = 0;
				try {
					if (failFlush) {
						fs.fsyncSync = (fd) => {
							if (descriptorPaths.get(fd) === paths.current) {
								hits += 1;
								throw new Error("injected flush failure");
							}
							fsync(fd);
						};
						syncBuiltinESMExports();
						if (boundary === "flushAppends") throws(() => live.writer.flushAppends(), /injected flush failure/u);
						else await rejects(live.writer[boundary](), /injected flush failure/u);
						strictEqual(hits, 1);
						strictEqual(readSessionMeta(live.meta.id).endedAt, null);
						fs.fsyncSync = fsync;
						syncBuiltinESMExports();
					}
					const completion = live.writer[boundary]();
					// These effects must happen before the returned Promise settles.
					ok(syncedPaths.includes(paths.current));
					if (boundary === "persistTree" || boundary === "close") {
						deepStrictEqual(
							JSON.parse(fs.readFileSync(paths.tree, "utf8")).map((node: { id: string }) => node.id),
							["accepted"],
						);
					}
					if (boundary === "close") ok(readSessionMeta(live.meta.id).endedAt);
					await completion;
					deepStrictEqual(fs.readFileSync(paths.current), before);
				} finally {
					fs.fsyncSync = fsync;
					syncBuiltinESMExports();
					await live.writer.close();
				}
			});
		}
	}

	for (const rollbackFails of [false, true]) {
		it(`preserves write and close diagnostics with rollback failure ${rollbackFails}`, async () => {
			const live = createSession({ cwd: scratch.dir });
			live.writer.append(turn("accepted"));
			const paths = sessionPaths(live.meta);
			const close = fs.closeSync;
			const truncate = fs.ftruncateSync;
			let closeHits = 0;
			fs.closeSync = (fd) => {
				const target = descriptorPaths.get(fd);
				close(fd);
				if (target === paths.current) {
					closeHits += 1;
					throw new Error("injected close failure");
				}
			};
			if (rollbackFails)
				fs.ftruncateSync = () => {
					throw new Error("injected rollback failure");
				};
			syncBuiltinESMExports();
			try {
				withWriteFault(
					paths.current,
					"throw",
					() => {
						throws(
							() => live.writer.append(turn("failed", "accepted")),
							(error: unknown) => {
								ok(error instanceof AggregateError);
								strictEqual(error.errors[1].message, "injected close failure");
								if (rollbackFails) {
									ok(error.errors[0] instanceof AggregateError);
									deepStrictEqual(
										error.errors[0].errors.map((cause: Error) => cause.message),
										["injected write failure", "injected rollback failure"],
									);
								} else strictEqual(error.errors[0].message, "injected write failure");
								return true;
							},
						);
					},
					3,
				);
				strictEqual(closeHits, 1);
			} finally {
				fs.closeSync = close;
				fs.ftruncateSync = truncate;
				syncBuiltinESMExports();
			}
			try {
				live.writer.flushAppends();
				live.writer.append(turn("continued", "accepted"));
				await live.writer.close();
				const warnings: unknown[] = [];
				const records = readSessionFileEntries(paths.current, { onWarning: (warning) => warnings.push(warning) }).slice(
					1,
				) as Array<{ turnId: string }>;
				deepStrictEqual(
					records.map((record) => record.turnId),
					["accepted", "continued"],
				);
				strictEqual(warnings.length, rollbackFails ? 1 : 0);
			} finally {
				await live.writer.close();
			}
		});
	}

	for (const transition of ["resume", "switchBranch"] as const) {
		for (const version of [2, 5]) {
			it(`${transition} refuses version ${version} before publishing recovery files`, async () => {
				const events: unknown[] = [];
				const current = createSessionBundle({
					bus: { emit: (...args: unknown[]) => events.push(args) },
				} as unknown as DomainContext).contract;
				const old = current.create({ cwd: scratch.dir });
				current.append(turn("old"));
				const candidate = createSession({ cwd: scratch.dir });
				candidate.writer.append(turn("candidate"));
				await candidate.writer.close();
				const paths = sessionPaths(candidate.meta);
				fs.writeFileSync(
					paths.meta,
					JSON.stringify({ ...readSessionMeta(candidate.meta.id), sessionFormatVersion: version }),
				);
				fs.renameSync(paths.current, `${paths.current}.tmp`);
				const preservedPaths = [paths.meta, `${paths.current}.tmp`, sessionPaths(old).meta, sessionPaths(old).current];
				const before = preservedPaths.map((path) => fs.readFileSync(path));
				try {
					throws(() => current[transition](candidate.meta.id), /unsupported format version|newer Clio/u);
					strictEqual(fs.existsSync(paths.current), false);
					deepStrictEqual(
						preservedPaths.map((path) => fs.readFileSync(path)),
						before,
					);
					strictEqual(current.current()?.id, old.id);
					deepStrictEqual(events, []);
					current.append(turn("continued", "old"));
					deepStrictEqual(
						openSession(old.id)
							.tree()
							.map((node) => node.id),
						["old", "continued"],
					);
				} finally {
					await current.close();
				}
			});
		}
		it(`${transition} reopens and restamps version 3 in one metadata publication`, async () => {
			const current = createSessionBundle({ bus: { emit: () => {} } } as unknown as DomainContext).contract;
			const old = current.create({ cwd: scratch.dir });
			const candidate = createSession({ cwd: scratch.dir });
			await candidate.writer.close();
			const paths = sessionPaths(candidate.meta);
			fs.writeFileSync(paths.meta, JSON.stringify({ ...readSessionMeta(candidate.meta.id), sessionFormatVersion: 3 }));
			const before = fs.readFileSync(paths.meta);
			const rename = fs.renameSync;
			let publications = 0;
			let refuse = true;
			fs.renameSync = (from, to) => {
				if (resolve(to.toString()) !== resolve(paths.meta)) return rename(from, to);
				publications += 1;
				if (refuse) throw new Error("injected metadata publication failure");
				return rename(from, to);
			};
			syncBuiltinESMExports();
			try {
				throws(() => current[transition](candidate.meta.id), /injected metadata publication failure/u);
				deepStrictEqual(fs.readFileSync(paths.meta), before);
				strictEqual(current.current()?.id, old.id);
				refuse = false;
				publications = 0;
				current[transition](candidate.meta.id);
				strictEqual(publications, 1);
				strictEqual(readSessionMeta(candidate.meta.id).endedAt, null);
				strictEqual(readSessionMeta(candidate.meta.id).sessionFormatVersion, 4);
			} finally {
				fs.renameSync = rename;
				syncBuiltinESMExports();
				await current.close();
			}
		});
		for (const mode of ["zero", "throw"] as const) {
			it(`${transition} preserves both lifecycle states when headerless normalization encounters ${mode}`, async () => {
				const events: unknown[] = [];
				const current = createSessionBundle({
					bus: { emit: (...args: unknown[]) => events.push(args) },
				} as unknown as DomainContext).contract;
				const old = current.create({ cwd: scratch.dir });
				current.append(turn("old"));
				const candidate = createSession({ cwd: scratch.dir });
				await candidate.writer.close();
				const paths = sessionPaths(candidate.meta);
				fs.writeFileSync(paths.meta, JSON.stringify({ ...readSessionMeta(candidate.meta.id), sessionFormatVersion: 3 }));
				fs.writeFileSync(paths.current, `${JSON.stringify(entry("candidate"))}\n`);
				const preservedPaths = [paths.meta, paths.current, sessionPaths(old).meta, sessionPaths(old).current];
				const before = preservedPaths.map((path) => fs.readFileSync(path));
				ok(readSessionMeta(candidate.meta.id).endedAt);
				try {
					withWriteFault(
						`${paths.current}.tmp`,
						mode,
						() => {
							throws(() => current[transition](candidate.meta.id), /no progress|injected write failure/u);
						},
						7,
					);
					deepStrictEqual(
						preservedPaths.map((path) => fs.readFileSync(path)),
						before,
					);
					strictEqual(fs.existsSync(`${paths.current}.tmp`), false);
					strictEqual(current.current()?.id, old.id);
					strictEqual(current.current()?.endedAt, null);
					deepStrictEqual(events, []);
					current.append(turn("continued", "old"));
					deepStrictEqual(
						openSession(old.id)
							.tree()
							.map((node) => node.id),
						["old", "continued"],
					);
					current[transition](candidate.meta.id);
					strictEqual(readSessionMeta(candidate.meta.id).endedAt, null);
					strictEqual(current.current()?.sessionFormatVersion, 4);
					current.append(turn("candidate-continued", "candidate"));
				} finally {
					await current.close();
				}
			});
		}
	}
});
