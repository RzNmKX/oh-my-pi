/**
 * Amazon Bedrock OpenAI Responses provider.
 *
 * Speaks the OpenAI Responses API wire protocol against the `bedrock-mantle`
 * endpoint (`https://bedrock-mantle.{region}.api.aws/openai/v1/responses`)
 * using AWS SigV4 signing. This is required for models like `openai.gpt-5.5`
 * which are only available through this endpoint (not bedrock-runtime Converse).
 *
 * Key differences from the standard `openai-responses` provider:
 *  - Auth: SigV4 signing (service="bedrock") instead of Bearer token
 *  - Endpoint: bedrock-mantle, not api.openai.com
 *  - Reasoning: summaries are suppressed by Bedrock (encrypted blobs only)
 *  - No OpenAI SDK dependency; raw fetch + SSE parsing
 */

import { extractHttpStatusFromError, fetchWithRetry, readSseEvents } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { ResponseInput, ResponseStreamEvent } from "./openai-responses-wire";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type {
	AssistantMessage,
	Context,
	Model,
	RawSseEvent,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolChoice,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { appendRawHttpRequestDumpFor400, type RawHttpRequestDump } from "../utils/http-inspector";
import { adaptSchemaForStrict, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { mapToOpenAIResponsesToolChoice } from "../utils/tool-choice";
import { resolveAwsCredentials } from "./aws-credentials";
import { signRequest } from "./aws-sigv4";
import {
	appendResponsesToolResultMessages,
	applyCommonResponsesSamplingParams,
	applyResponsesReasoningParams,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createInitialResponsesAssistantMessage,
	processResponsesStream,
	repairOrphanResponsesToolCalls,
	repairOrphanResponsesToolOutputs,
} from "./openai-shared";
import { transformMessages } from "./transform-messages";

/**
 * Minimal compat surface for GPT-5.5 on bedrock-mantle. The model object's
 * `compat` field may be undefined when tests or direct registry usage skip
 * full model resolution. This static object provides the fields that
 * `resolveOpenAICompatPolicy` dereferences, tuned for the bedrock-mantle
 * wire behavior (standard OpenAI Responses API, no special quirks).
 */
const BEDROCK_OPENAI_COMPAT = {
	supportsDeveloperRole: true,
	supportsStrictMode: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsReasoningParams: true,
	thinkingFormat: "openai" as const,
	reasoningDisableMode: "omit-effort" as const,
	omitReasoningEffort: false,
	includeEncryptedReasoning: true,
	filterReasoningHistory: false,
	disableReasoningOnForcedToolChoice: false,
	disableReasoningOnToolChoice: false,
	supportsToolChoice: true,
	supportsForcedToolChoice: true,
	supportsNamedToolChoice: true,
	requiresReasoningContentForToolCalls: false,
	requiresReasoningContentForAllAssistantTurns: false,
	allowsSyntheticReasoningContentForToolCalls: false,
	replayReasoningContent: false,
	qwenPreserveThinking: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresAssistantContentForToolCalls: false,
	stripDeepseekSpecialTokens: false,
	reasoningDeltasMayBeCumulative: false,
	emptyLengthFinishIsContextError: false,
	usesOpenAIToolCallIdLimit: false,
	isOpenRouterHost: false,
	alwaysSendMaxTokens: false,
	wireModelIdMode: "raw" as const,
	streamIdleTimeoutMs: 0,
};

export interface BedrockOpenAIOptions extends StreamOptions {
	region?: string;
	profile?: string;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	toolChoice?: ToolChoice;
}

export const streamBedrockOpenAI: StreamFunction<"bedrock-openai-responses"> = (
	model: Model<"bedrock-openai-responses">,
	context: Context,
	options: BedrockOpenAIOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = createInitialResponsesAssistantMessage(
			"bedrock-openai-responses",
			model.provider,
			model.id,
		);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const onSseEvent = options.onSseEvent;

		try {
			// bedrock-mantle hosts gpt-5.5 in us-east-1 (OpenAI Responses API path).
			// Do NOT inherit AWS_REGION — a shell pointing at any other region routes to a
			// regional endpoint that returns 404 "model does not exist". Pin us-east-1 unless
			// an explicit option overrides it (future regions / tests).
			const region = options.region || "us-east-1";
			const messages = convertConversationMessages(model, context);
			const params = buildRequestParams(model, context, messages, options);
			options.onPayload?.(params);

			const host = `bedrock-mantle.${region}.api.aws`;
			const urlPath = "/openai/v1/responses";
			const url = `https://${host}${urlPath}`;
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url,
				body: params,
			};

			const bodyText = JSON.stringify(params);
			const body = new TextEncoder().encode(bodyText);
			const baseHeaders: Record<string, string> = {
				"content-type": "application/json",
				accept: "text/event-stream",
			};

			const credentials = await resolveAwsCredentials({
				profile: options.profile,
				region,
				signal: options.signal,
			});
			const signed = await signRequest({
				method: "POST",
				host,
				path: urlPath,
				body,
				region,
				service: "bedrock",
				credentials,
				headers: baseHeaders,
			});
			const requestHeaders = { ...baseHeaders, ...signed };

			const response = await fetchWithRetry(url, {
				method: "POST",
				headers: requestHeaders,
				body,
				signal: options.signal,
				fetch: options.fetch,
			});

			if (!response.ok) {
				const errBody = await response.text().catch(() => "");
				throw new AIError.BedrockApiError(
					`Bedrock OpenAI HTTP ${response.status}: ${errBody.slice(0, 1000)}`,
					response.status,
				);
			}
			if (!response.body) throw new Error("Bedrock OpenAI response has no body");

			stream.push({ type: "start", partial: output });

			const events = parseSseToResponseEvents(
				response.body,
				options.signal,
				onSseEvent ? event => onSseEvent(event, model) : undefined,
			);
			// bedrock-mantle (gpt-5.5) currently emits a generic `server_error`
			// (`response.failed`) when *finalizing* any response whose output contains
			// a freshly generated function_call — even though it streams the complete
			// tool call first (name + full arguments + output_item.done) and accepts
			// those same tool-call items in a follow-up input (verified end-to-end).
			// Salvage the completed tool call so the agent loop can dispatch it; the
			// next turn (replaying the tool result) finalizes normally. Gated on an
			// actually-completed function_call so unrelated stream errors still surface.
			let sawCompletedToolCall = false;
			try {
				await processResponsesStream(events, output, stream, model, {
					onFirstToken: () => {
						if (!firstTokenTime) firstTokenTime = Date.now();
					},
					onOutputItemDone: (item: { type: string }) => {
						if (item.type === "function_call" || item.type === "custom_tool_call") {
							sawCompletedToolCall = true;
						}
					},
				});
			} catch (streamError) {
				if (!sawCompletedToolCall || !isBedrockToolCallFinalizationError(streamError)) {
					throw streamError;
				}
				output.stopReason = "toolUse";
			}

			if (options.signal?.aborted) throw new Error("Request was aborted");

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage ?? "An unknown error occurred");
			}

			calculateCost(model, output.usage);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as { index?: number }).index;
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error);
			const baseMessage = error instanceof Error ? error.message : JSON.stringify(error);
			output.errorMessage = await appendRawHttpRequestDumpFor400(baseMessage, error, rawRequestDump);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * bedrock-mantle returns a generic `server_error` (delivered as a
 * `response.failed` SSE event) when finalizing a gpt-5.5 response that contains
 * a freshly generated function_call. The tool call itself is streamed in full
 * beforehand, so the provider salvages it rather than failing the turn — see the
 * call site. Detect that specific finalization error by its error code.
 */
function isBedrockToolCallFinalizationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("server_error");
}

// ---------------------------------------------------------------------------
// SSE → ResponseStreamEvent parsing
// ---------------------------------------------------------------------------

async function* parseSseToResponseEvents(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	sseObserver?: (event: RawSseEvent) => void,
): AsyncGenerator<ResponseStreamEvent> {
	for await (const sse of readSseEvents(body, signal)) {
		if (sseObserver) notifyRawSseEvent(sseObserver, sse);
		if (!sse.data || sse.data === "[DONE]") continue;
		try {
			const event = JSON.parse(sse.data) as ResponseStreamEvent;
			yield event;
		} catch {
			// Skip malformed SSE frames
		}
	}
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

interface BedrockOpenAIRequestParams {
	model: string;
	input: ResponseInput;
	instructions?: string;
	stream: true;
	tools?: unknown[];
	tool_choice?: unknown;
	include?: string[];
	reasoning?: { effort?: string; summary?: string };
	max_output_tokens?: number;
	temperature?: number;
	top_p?: number;
	store: false;
}

function buildRequestParams(
	model: Model<"bedrock-openai-responses">,
	context: Context,
	messages: ResponseInput,
	options: BedrockOpenAIOptions,
): BedrockOpenAIRequestParams {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	let systemInstructions: string | undefined;

	if (systemPrompts.length > 0) {
		// bedrock-mantle uses the developer role for reasoning models
		if (model.reasoning) {
			messages.unshift(
				...systemPrompts.map(systemPrompt => ({ role: "developer" as const, content: systemPrompt })),
			);
		} else {
			systemInstructions = systemPrompts.join("\n\n");
		}
	}

	const params: BedrockOpenAIRequestParams = {
		model: model.id,
		input: messages,
		instructions: systemInstructions,
		stream: true,
		store: false,
	};

	// Sampling params
	applyCommonResponsesSamplingParams(params as any, options, model);

	// Reasoning params — request encrypted content for multi-turn continuity.
	// Provide fallback compat so tests/direct invocations don't crash when
	// model.compat is undefined.
	const modelWithCompat = model.compat ? model : { ...model, compat: BEDROCK_OPENAI_COMPAT };
	applyResponsesReasoningParams(params as any, modelWithCompat as any, options, messages, undefined, true, false);

	// Tools
	if (context.tools) {
		params.tools = convertTools(context.tools);
		if (options.toolChoice) {
			params.tool_choice = mapToOpenAIResponsesToolChoice(options.toolChoice);
		}
	}

	return params;
}

function convertTools(tools: Tool[]): unknown[] {
	return tools.map(tool => {
		const baseParameters = toolWireSchema(tool);
		const responseParameters = sanitizeSchemaForOpenAIResponses(baseParameters);
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(responseParameters, true);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict && { strict: true }),
		};
	});
}

// ---------------------------------------------------------------------------
// Conversation history conversion
// ---------------------------------------------------------------------------

function convertConversationMessages(model: Model<"bedrock-openai-responses">, context: Context): ResponseInput {
	const messages: ResponseInput = [];
	const knownCallIds = new Set<string>();
	const supportsImages = model.input.includes("image");
	const transformedMessages = transformMessages(context.messages, model);

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const content = convertResponsesInputContent(msg.content, supportsImages, false);
			if (!content) continue;
			messages.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const outputItems = convertResponsesAssistantMessage(assistantMsg, model, msgIndex, knownCallIds, true);
			if (outputItems.length === 0) continue;
			messages.push(...outputItems);
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(messages, msg, model, false, false, knownCallIds);
		}
		msgIndex++;
	}

	return repairOrphanResponsesToolCalls(repairOrphanResponsesToolOutputs(messages));
}
