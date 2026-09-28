import { expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const claudeModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5 (Foundry)",
	api: "anthropic-messages",
	provider: "palantir-foundry",
	baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/anthropic",
	requestModelId: "ri.language-model-service..language-model.anthropic-claude-5-sonnet",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

it("omits unsupported context management from Palantir Claude requests", async () => {
	let capturedBeta: string | null = null;
	const fetch: FetchImpl = async (_input, init) => {
		capturedBeta = new Headers(init?.headers).get("anthropic-beta");
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	};
	const { promise, resolve } = Promise.withResolvers<unknown>();

	await streamAnthropic(claudeModel, context, {
		apiKey: "secret-token",
		thinkingEnabled: true,
		fetch,
		onPayload: payload => resolve(payload),
	}).result();

	const payload = (await promise) as {
		thinking?: { type?: string };
		context_management?: unknown;
	};
	expect(payload.thinking?.type).toBe("adaptive");
	expect(payload.context_management).toBeUndefined();
	expect(capturedBeta ?? "").not.toContain("context-management-2025-06-27");
});

it("omits unsupported prompt cache keys from Palantir xAI requests", async () => {
	let requestedBody: Record<string, unknown> | undefined;
	const fetch: FetchImpl = async (_input, init) => {
		requestedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		return new Response(JSON.stringify({ error: { message: "captured" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	};
	const model: Model<"openai-responses"> = buildModel({
		id: "grok-4.6",
		name: "Grok 4.6 (Foundry)",
		api: "openai-responses",
		provider: "palantir-foundry",
		baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/xai/v1",
		requestModelId: "ri.language-model-service..language-model.grok-4-6",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 500_000,
		compat: { supportsPromptCacheKey: false },
	});

	await streamOpenAIResponses(model, context, {
		apiKey: "secret-token",
		sessionId: "session-that-must-not-be-forwarded",
		fetch,
	}).result();

	expect(requestedBody?.model).toBe("ri.language-model-service..language-model.grok-4-6");
	expect(requestedBody?.prompt_cache_key).toBeUndefined();
});

it("uses bearer auth and the catalog RID for Palantir Gemini models", async () => {
	let requestedUrl: string | undefined;
	let requestedHeaders: Headers | undefined;
	const fetch: FetchImpl = async (input, init) => {
		requestedUrl = String(input);
		requestedHeaders = new Headers(init?.headers);
		const chunk = {
			candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const model: Model<"google-generative-ai"> = buildModel({
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash (Foundry)",
		api: "google-generative-ai",
		provider: "palantir-foundry",
		baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/google/v1",
		requestModelId: "ri.language-model-service..language-model.gemini-3-7-flash",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	});

	const stream = streamGoogle(model, context, { apiKey: "secret-token", fetch });
	for await (const _ of stream as AsyncIterable<AssistantMessageEvent>) {
		// Consume the complete response.
	}

	expect(requestedUrl).toBe(
		"https://xos.bpx.com/api/v2/llm/proxy/google/v1/models/ri.language-model-service..language-model.gemini-3-7-flash:streamGenerateContent?alt=sse",
	);
	expect(requestedHeaders?.get("authorization")).toBe("Bearer secret-token");
	expect(requestedHeaders?.has("x-goog-api-key")).toBe(false);
});
