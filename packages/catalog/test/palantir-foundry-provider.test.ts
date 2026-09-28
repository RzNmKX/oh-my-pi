import { describe, expect, it } from "bun:test";
import { fetchPalantirFoundryModels } from "@oh-my-pi/pi-catalog/discovery/palantir-foundry";
import { palantirFoundryModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

interface RecordedRequest {
	url: string;
	headers: Headers;
	body: {
		operations: Record<string, string>;
		requests: Array<{ name: string; variables: Record<string, unknown> }>;
	};
}

function sseResponse(data: unknown): Response {
	return new Response(`data:${JSON.stringify({ data })}\n\n`, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function modelRecord(options: {
	rid: string;
	displayName: string;
	modelCreator: string;
	inputTypes: string[];
	vision?: boolean;
	contextWindow: number;
	maxOutputTokens: number | null;
}): unknown {
	return {
		rid: options.rid,
		displayName: options.displayName,
		modelCreator: options.modelCreator,
		resolvedDetails: {
			properties: {
				contextWindow: options.contextWindow,
				maxOutputTokens: options.maxOutputTokens,
			},
			modelSpecs: options.inputTypes.map(inputType => ({
				inputType,
				modelSpec: {
					inputModalities: options.vision
						? [
								{ __typename: "LanguageModelTextInputModality" },
								{ __typename: "LanguageModelVisionInputModality" },
							]
						: [{ __typename: "LanguageModelTextInputModality" }],
				},
			})),
		},
	};
}

describe("Palantir Foundry provider catalog", () => {
	it("discovers native protocols with full-RID routing and omits generic-only rows", async () => {
		const requests: RecordedRequest[] = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			const body = JSON.parse(String(init?.body)) as RecordedRequest["body"];
			const request: RecordedRequest = {
				url: String(input),
				headers: new Headers(init?.headers),
				body,
			};
			requests.push(request);
			const operation = body.requests[0];
			if (operation?.name === "HomeProjectRidQuery") {
				return sseResponse({ homeProject: { rid: "ri.compass.main.folder.home" } });
			}
			if (operation?.name !== "LanguageModelsV4Query") {
				throw new Error(`Unexpected operation: ${operation?.name}`);
			}
			if (operation.variables.pageToken === "second-page") {
				return sseResponse({
					languageModelsV4: {
						nextPageToken: null,
						values: [
							modelRecord({
								rid: "ri.language-model-service..language-model.gpt-4-1",
								displayName: "GPT-4.1",
								modelCreator: "OPEN_AI",
								inputTypes: ["OPEN_AI_RESPONSES"],
								contextWindow: 1_047_576,
								maxOutputTokens: 32_768,
							}),
							modelRecord({
								rid: "ri.language-model-service..language-model.grok-420-reasoning-latest",
								displayName: "Grok 420 Reasoning Latest",
								modelCreator: "X_AI",
								inputTypes: ["X_AI_RESPONSES", "GENERIC_CHAT_COMPLETION"],
								vision: true,
								contextWindow: 2_000_000,
								maxOutputTokens: null,
							}),
							modelRecord({
								rid: "ri.language-model-service..language-model.o1",
								displayName: "o1",
								modelCreator: "OPEN_AI",
								inputTypes: ["GENERIC_CHAT_COMPLETION"],
								contextWindow: 200_000,
								maxOutputTokens: 100_000,
							}),
							modelRecord({
								rid: "ri.language-model-service..language-model.schematic-7b",
								displayName: "Schematic 7B",
								modelCreator: "PALANTIR",
								inputTypes: ["GENERIC_CHAT_COMPLETION"],
								contextWindow: 32_768,
								maxOutputTokens: 8_192,
							}),
						],
					},
				});
			}
			return sseResponse({
				languageModelsV4: {
					nextPageToken: "second-page",
					values: [
						modelRecord({
							rid: "ri.language-model-service..language-model.gpt-5-6-sol",
							displayName: "GPT-5.6 Sol",
							modelCreator: "OPEN_AI",
							inputTypes: ["OPEN_AI_RESPONSES", "OPEN_AI_REASONING"],
							vision: true,
							contextWindow: 1_050_000,
							maxOutputTokens: 128_000,
						}),
						modelRecord({
							rid: "ri.language-model-service..language-model.anthropic-claude-5-sonnet",
							displayName: "Claude Sonnet 5",
							modelCreator: "ANTHROPIC",
							inputTypes: ["CLAUDE_CHAT", "GENERIC_CHAT_COMPLETION"],
							vision: true,
							contextWindow: 1_000_000,
							maxOutputTokens: 128_000,
						}),
						modelRecord({
							rid: "ri.language-model-service..language-model.gemini-3-1-pro",
							displayName: "Gemini 3.1 Pro Preview",
							modelCreator: "GOOGLE_GEMINI",
							inputTypes: ["GEMINI_CHAT", "GENERIC_CHAT_COMPLETION"],
							vision: true,
							contextWindow: 1_048_576,
							maxOutputTokens: 65_536,
						}),
						modelRecord({
							rid: "ri.language-model-service..language-model.grok-4-5",
							displayName: "Grok 4.5",
							modelCreator: "X_AI",
							inputTypes: ["X_AI_RESPONSES", "GENERIC_CHAT_COMPLETION"],
							vision: true,
							contextWindow: 500_000,
							maxOutputTokens: 500_000,
						}),
					],
				},
			});
		};

		const models = await fetchPalantirFoundryModels({
			apiKey: "secret-token",
			fetch: fetchImpl,
		});

		expect(models.map(model => model.id)).toEqual([
			"gpt-5.6-sol",
			"claude-sonnet-5",
			"gemini-3.1-pro-preview",
			"grok-4.5",
			"gpt-4.1",
			"grok-420-reasoning-latest",
		]);
		expect(models[0]).toMatchObject({
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol (Foundry)",
			requestModelId: "ri.language-model-service..language-model.gpt-5-6-sol",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		});
		expect(models[1]).toMatchObject({
			id: "claude-sonnet-5",
			api: "anthropic-messages",
			baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/anthropic",
			requestModelId: "ri.language-model-service..language-model.anthropic-claude-5-sonnet",
			input: ["text", "image"],
			compat: { disableStrictTools: true },
		});
		expect(models[2]).toMatchObject({
			id: "gemini-3.1-pro-preview",
			api: "google-generative-ai",
			baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/google/v1",
			requestModelId: "ri.language-model-service..language-model.gemini-3-1-pro",
			input: ["text", "image"],
		});
		expect(models[3]).toMatchObject({
			id: "grok-4.5",
			api: "openai-responses",
			baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/xai/v1",
			requestModelId: "ri.language-model-service..language-model.grok-4-5",
			input: ["text", "image"],
			compat: { supportsPromptCacheKey: false },
		});
		expect(models[4]).toMatchObject({
			id: "gpt-4.1",
			requestModelId: "ri.language-model-service..language-model.gpt-4-1",
			reasoning: false,
			input: ["text"],
			contextWindow: 1_047_576,
			maxTokens: 32_768,
		});
		expect(models[5]).toMatchObject({
			id: "grok-420-reasoning-latest",
			requestModelId: "ri.language-model-service..language-model.grok-420-reasoning-latest",
			cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 2_000_000,
			maxTokens: 30_000,
		});
		expect(requests.map(request => request.body.requests[0]?.name)).toEqual([
			"HomeProjectRidQuery",
			"LanguageModelsV4Query",
			"LanguageModelsV4Query",
		]);
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret-token");
		expect(requests[0]?.headers.get("fetch-user-agent")).toBe("agent-studio-app forge-graphql-client");
		expect(requests[1]?.body.requests[0]?.variables).toMatchObject({
			attribution: { compass: { rid: "ri.compass.main.folder.home" } },
			modelOrigins: ["PALANTIR_PROVIDED"],
			pageSize: 100,
		});
		expect(requests[1]?.body.operations["0"]).toContain("GENERIC_CHAT_COMPLETION");
		expect(requests[2]?.body.requests[0]?.variables.pageToken).toBe("second-page");
	});

	it("configures credentialed discovery as authoritative", () => {
		const withoutCredential = palantirFoundryModelManagerOptions();
		const withCredential = palantirFoundryModelManagerOptions({ apiKey: "secret-token" });

		expect(withoutCredential.dynamicModelsAuthoritative).toBe(true);
		expect(withoutCredential.fetchDynamicModels).toBeUndefined();
		expect(withCredential.fetchDynamicModels).toBeFunction();
	});
});
