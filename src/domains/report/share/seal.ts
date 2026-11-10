import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";

/**
 * Sealing a share to the Clio maintainers (share intake contract v1): an ephemeral X25519 key agrees a secret with the
 * maintainers' public key, HKDF-SHA256 turns it into an AES-256-GCM key, and the envelope is plain JSON text that fits
 * in a gist. Only the holder of the maintainers' private key can open it; nothing here ever sees that key.
 */

/** The maintainers' intake key. `kid` is the first 16 hex of sha256 over the raw public key. */
export const SHARE_RECIPIENT = {
	kid: "d7aad758f9cb9edc",
	publicKey: "HrgavsjtbzwR5utXQfKg9FzZ62qLykC6kJlqvOC8MS0=",
} as const;

export const SHARE_PLAIN_FORMAT = "clio-coder.share.plain";
export const SHARE_SEALED_FORMAT = "clio-coder.share.sealed";
export const SHARE_ID = /^shr_[0-9a-f]{16}$/u;
export const SHARE_KINDS = ["report-bundle", "telemetry-share"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
const HKDF_INFO = "clio-coder share v1";
/** PKCS#8 DER prefix of an X25519 private key; the raw 32 bytes follow it. */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export function newShareId(): string {
	return `shr_${randomBytes(8).toString("hex")}`;
}

export interface SharePlaintext {
	format: typeof SHARE_PLAIN_FORMAT;
	v: 1;
	kind: ShareKind;
	shareId: string;
	day: string;
	clio: string;
	consent: string[];
	digest: unknown;
	archiveFormat: string;
	/** Base64 of the bundle or share archive bytes. */
	archive: string;
}

export interface SealedShare {
	format: typeof SHARE_SEALED_FORMAT;
	v: 1;
	kid: string;
	shareId: string;
	kind: ShareKind;
	epk: string;
	nonce: string;
	ct: string;
}

function shareKid(rawPublicKey: Buffer): string {
	return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
	if (raw.length !== 32) throw new Error("an X25519 public key is 32 bytes");
	return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
}

function rawPublicKey(key: KeyObject): Buffer {
	const x = key.export({ format: "jwk" }).x;
	if (typeof x !== "string") throw new Error("not an X25519 key");
	return Buffer.from(x, "base64url");
}

function x25519PrivateKey(raw: Buffer): KeyObject {
	if (raw.length !== 32) throw new Error("an X25519 private key is 32 bytes");
	return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function aad(kid: string, shareId: string): Buffer {
	return Buffer.from(`${SHARE_SEALED_FORMAT}/1/${kid}/${shareId}`, "utf8");
}

function deriveKey(privateKey: KeyObject, publicKey: KeyObject, ephemeralRaw: Buffer, recipientRaw: Buffer): Buffer {
	const shared = diffieHellman({ privateKey, publicKey });
	// A low-order point agrees an all-zero secret; a key derived from it protects nothing.
	if (shared.every((byte) => byte === 0)) throw new Error("the X25519 agreement produced no secret");
	return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, recipientRaw]), HKDF_INFO, 32));
}

export interface SealOptions {
	/** Defaults to {@link SHARE_RECIPIENT}. */
	recipient?: { publicKey: string };
	/** Test seams: a fixed ephemeral private key (raw 32 bytes) and nonce make the envelope deterministic. */
	ephemeralPrivateKey?: Buffer;
	nonce?: Buffer;
}

/** Encrypt a share's plaintext to the maintainers. The envelope names only the key id, the share id and its kind. */
export function sealShare(plain: SharePlaintext, options: SealOptions = {}): SealedShare {
	if (!SHARE_ID.test(plain.shareId)) throw new Error(`not a share id: ${plain.shareId}`);
	const recipientRaw = Buffer.from(options.recipient?.publicKey ?? SHARE_RECIPIENT.publicKey, "base64");
	const recipient = publicKeyFromRaw(recipientRaw);
	const kid = shareKid(recipientRaw);
	const ephemeral =
		options.ephemeralPrivateKey !== undefined
			? x25519PrivateKey(options.ephemeralPrivateKey)
			: generateKeyPairSync("x25519").privateKey;
	const ephemeralRaw = rawPublicKey(createPublicKey(ephemeral));
	const key = deriveKey(ephemeral, recipient, ephemeralRaw, recipientRaw);
	const nonce = options.nonce ?? randomBytes(12);
	if (nonce.length !== 12) throw new Error("the nonce is 12 bytes");
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(aad(kid, plain.shareId));
	const ct = Buffer.concat([cipher.update(JSON.stringify(plain), "utf8"), cipher.final(), cipher.getAuthTag()]);
	return {
		format: SHARE_SEALED_FORMAT,
		v: 1,
		kid,
		shareId: plain.shareId,
		kind: plain.kind,
		epk: ephemeralRaw.toString("base64"),
		nonce: nonce.toString("base64"),
		ct: ct.toString("base64"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Open an envelope with the maintainers' PKCS#8 PEM private key. Every field is checked, the tag authenticates the
 * key id and share id, and the plaintext must name the same share and kind as its envelope; anything else throws.
 */
export function openShare(envelope: unknown, privateKeyPem: string): SharePlaintext {
	if (
		!isRecord(envelope) ||
		envelope.format !== SHARE_SEALED_FORMAT ||
		envelope.v !== 1 ||
		typeof envelope.kid !== "string" ||
		typeof envelope.shareId !== "string" ||
		!SHARE_ID.test(envelope.shareId) ||
		!(SHARE_KINDS as ReadonlyArray<unknown>).includes(envelope.kind) ||
		typeof envelope.epk !== "string" ||
		typeof envelope.nonce !== "string" ||
		typeof envelope.ct !== "string"
	)
		throw new Error("not a version 1 sealed share");
	const privateKey = createPrivateKey(privateKeyPem);
	const recipientRaw = rawPublicKey(createPublicKey(privateKey));
	const kid = shareKid(recipientRaw);
	if (envelope.kid !== kid) throw new Error(`the share is sealed to key ${envelope.kid}, not ${kid}`);
	const ephemeralRaw = Buffer.from(envelope.epk, "base64");
	const nonce = Buffer.from(envelope.nonce, "base64");
	const ct = Buffer.from(envelope.ct, "base64");
	if (nonce.length !== 12 || ct.length < 16) throw new Error("the sealed share is truncated");
	const key = deriveKey(privateKey, publicKeyFromRaw(ephemeralRaw), ephemeralRaw, recipientRaw);
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAAD(aad(kid, envelope.shareId));
	decipher.setAuthTag(ct.subarray(ct.length - 16));
	let text: string;
	try {
		text = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8");
	} catch {
		throw new Error("the sealed share does not authenticate: it was altered or sealed to another key");
	}
	const plain: unknown = JSON.parse(text);
	if (!isRecord(plain) || plain.format !== SHARE_PLAIN_FORMAT || plain.v !== 1 || typeof plain.archive !== "string")
		throw new Error("the sealed share holds no version 1 plaintext");
	if (plain.shareId !== envelope.shareId || plain.kind !== envelope.kind)
		throw new Error("the plaintext names another share than its envelope");
	return plain as unknown as SharePlaintext;
}
