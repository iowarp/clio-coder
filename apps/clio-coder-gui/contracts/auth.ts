import { type Static, Type } from "typebox";

/** A browser window, launcher probe or proxy hop the server has issued a credential to. */
export const ClientId = Type.String({ pattern: "^[A-Za-z0-9_-]{8,64}$" });
export const ClientLabel = Type.String({ minLength: 1, maxLength: 80 });
export const ClientIdentity = Type.Object({ clientId: ClientId, label: ClientLabel }, { additionalProperties: false });
export type ClientIdentity = Static<typeof ClientIdentity>;

/**
 * The only request the launch token opens. `resume` asks for the id this window held before a reload
 * or a server restart; the server grants it only while no live credential holds that id.
 */
export const ClientBootstrap = Type.Object(
	{
		label: Type.Optional(ClientLabel),
		resume: Type.Optional(ClientId),
		/** A challenge from POST /api/auth/challenge, spent by this request. */
		challenge: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" })),
		/** A launcher's proof that it holds the launch token, over `challenge` and the port it dialed; the token itself is never sent. */
		proof: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" })),
		/** A single-use launch ticket from the URL a launcher opened. */
		ticket: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" })),
	},
	{ additionalProperties: false },
);
export type ClientBootstrap = Static<typeof ClientBootstrap>;
export const ClientCredential = Type.Object(
	{
		clientId: ClientId,
		label: ClientLabel,
		/** Bearer for every other API request. Held in memory; never placed in a URL. */
		credential: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
		expiresAt: Type.String(),
		/** Seconds until the server refuses this credential, and until the client should rotate it. */
		expiresIn: Type.Integer({ minimum: 1 }),
		rotateIn: Type.Integer({ minimum: 0 }),
		/** The app's answer to a launcher's proof, which tells the launcher this listener holds the same launch token. */
		serverProof: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" })),
	},
	{ additionalProperties: false },
);
export type ClientCredential = Static<typeof ClientCredential>;
/** A single-use, short-lived challenge a launcher proves the launch token over, so a proof works once and only here. */
export const LaunchChallenge = Type.Object(
	{ challenge: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }), expiresIn: Type.Integer({ minimum: 1 }) },
	{ additionalProperties: false },
);
export type LaunchChallenge = Static<typeof LaunchChallenge>;
/** A single-use, short-lived proof for the one request a browser cannot attach a header to. */
export const EventTicket = Type.Object(
	{ ticket: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }), expiresIn: Type.Integer({ minimum: 1 }) },
	{ additionalProperties: false },
);
export type EventTicket = Static<typeof EventTicket>;
