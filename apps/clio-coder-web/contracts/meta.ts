import { Type } from "typebox";
export const API_VERSION = 1;
export const APP_VERSION = "0.0.0";
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
	},
	{ additionalProperties: false },
);
