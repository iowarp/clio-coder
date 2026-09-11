import { Type } from "typebox";
export const API_VERSION = 1;
export const APP_VERSION = "0.0.0";
export const Meta = Type.Object(
	{
		clio: Type.String(),
		app: Type.String(),
		apiVersion: Type.Literal(API_VERSION),
		epoch: Type.String(),
	},
	{ additionalProperties: false },
);
