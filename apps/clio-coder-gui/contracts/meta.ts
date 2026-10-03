import { Type } from "typebox";
export const API_VERSION = 1;
export const APP_VERSION = "0.0.0";
/** Every window title ends with this. The launcher finds an open app window by it, so a title never drops it. */
export const APP_TITLE = "Clio Coder";
export const Meta = Type.Object(
	{
		clio: Type.String(),
		node: Type.String(),
		platform: Type.String(),
		piAgentCore: Type.Union([Type.String(), Type.Null()]),
		piAi: Type.Union([Type.String(), Type.Null()]),
		piTui: Type.Union([Type.String(), Type.Null()]),
		app: Type.String(),
		apiVersion: Type.Literal(API_VERSION),
		epoch: Type.String(),
		pwa: Type.Boolean(),
		idle: Type.Boolean(),
		/** Fixed installed reference root; no arbitrary file reads are exposed. */
		bundledDocsPath: Type.String(),
	},
	{ additionalProperties: false },
);
