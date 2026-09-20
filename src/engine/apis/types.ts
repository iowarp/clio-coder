import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
} from "@earendil-works/pi-ai";

/** Engine-owned API implementation shape; avoids the deprecated compat registry type. */
export interface EngineApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream(model: Model<TApi>, context: Context, options?: TOptions): AssistantMessageEventStream;
	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}
