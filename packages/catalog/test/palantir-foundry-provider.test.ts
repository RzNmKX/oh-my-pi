import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchPalantirFoundryModels } from "@oh-my-pi/pi-catalog/discovery/palantir-foundry";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import { palantirFoundryModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

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
			// Pricing is borrowed from the bundled first-party OpenAI row.
			cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		});
		expect(models[1]).toMatchObject({
			id: "claude-sonnet-5",
			api: "anthropic-messages",
			baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/anthropic",
			requestModelId: "ri.language-model-service..language-model.anthropic-claude-5-sonnet",
			input: ["text", "image"],
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

	it("enriches newer Foundry models from models.dev metadata", async () => {
		const fetchImpl: FetchImpl = async (input, init) => {
			if (String(input).includes("catalog.stencil.so")) {
				return new Response(
					JSON.stringify({
						anthropic: {
							models: {
								"claude-opus-5-5": {
									name: "Claude Opus 5.5",
									tool_call: true,
									reasoning: true,
									limit: { context: 1_000_000, output: 128_000 },
									cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
									modalities: { input: ["text", "image"] },
								},
							},
						},
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			const body = JSON.parse(String(init?.body)) as RecordedRequest["body"];
			const operation = body.requests[0];
			if (operation?.name === "HomeProjectRidQuery") {
				return sseResponse({ homeProject: { rid: "ri.compass.main.folder.home" } });
			}
			return sseResponse({
				languageModelsV4: {
					nextPageToken: null,
					values: [
						modelRecord({
							rid: "ri.language-model-service..language-model.anthropic-claude-5-5-opus",
							displayName: "Claude Opus 5.5",
							modelCreator: "ANTHROPIC",
							inputTypes: ["CLAUDE_CHAT", "GENERIC_CHAT_COMPLETION"],
							vision: true,
							contextWindow: 1_000_000,
							maxOutputTokens: 128_000,
						}),
					],
				},
			});
		};
		const options = palantirFoundryModelManagerOptions({ apiKey: "secret-token", fetch: fetchImpl });
		const fetchDynamicModels = options.fetchDynamicModels;
		if (!fetchDynamicModels) throw new Error("Expected credentialed Foundry discovery");

		const models = await fetchDynamicModels();
		if (models === null) throw new Error("Expected complete Foundry discovery");

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "claude-opus-5.5",
			requestModelId: "ri.language-model-service..language-model.anthropic-claude-5-5-opus",
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});
	});

	it("derives every route from the Foundry origin, whatever route the caller passes", async () => {
		const urls: string[] = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			urls.push(String(input));
			const body = JSON.parse(String(init?.body)) as RecordedRequest["body"];
			if (body.requests[0]?.name === "HomeProjectRidQuery") {
				return sseResponse({ homeProject: { rid: "ri.compass.main.folder.home" } });
			}
			return sseResponse({
				languageModelsV4: {
					nextPageToken: null,
					values: [
						modelRecord({
							rid: "ri.language-model-service..language-model.gpt-6-astra",
							displayName: "GPT-6 Astra",
							modelCreator: "OPEN_AI",
							inputTypes: ["OPEN_AI_RESPONSES", "OPEN_AI_REASONING"],
							contextWindow: 1_050_000,
							maxOutputTokens: 128_000,
						}),
					],
				},
			});
		};

		// A registry can infer the provider-wide base URL from any bundled row,
		// including one on the Anthropic route.
		const models = await fetchPalantirFoundryModels({
			apiKey: "secret-token",
			baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/anthropic",
			fetch: fetchImpl,
		});

		expect(urls.every(url => url.startsWith("https://xos.bpx.com/graphql-gateway/api/bulk?q="))).toBe(true);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "gpt-6-astra",
			api: "openai-responses",
			baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/openai/v1",
		});
	});

	it("applies the per-route wire policy from the provider rules", () => {
		const route = "https://xos.bpx.com/api/v2/llm/proxy";
		const build = (id: string, api: Api, baseUrl: string): Model<Api> =>
			buildModel({
				id,
				name: `${id} (Foundry)`,
				api,
				provider: "palantir-foundry",
				baseUrl,
				requestModelId: `ri.language-model-service..language-model.${id}`,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			});

		const claude = build(
			"claude-sonnet-5",
			"anthropic-messages",
			`${route}/anthropic`,
		) as Model<"anthropic-messages">;
		expect(claude.compat).toMatchObject({
			disableStrictTools: true,
			supportsContextManagement: false,
			supportsPromptCacheControl: false,
		});

		const gemini = build(
			"gemini-3.6-flash",
			"google-generative-ai",
			`${route}/google/v1`,
		) as Model<"google-generative-ai">;
		expect(gemini.compat.bearerAuth).toBe(true);

		const grok = build("grok-4.5", "openai-responses", `${route}/xai/v1`) as Model<"openai-responses">;
		expect(grok.compat.omitPromptCacheKey).toBe(true);

		const sol = build("gpt-5.6-sol", "openai-responses", `${route}/openai/v1`) as Model<"openai-responses">;
		expect(sol.compat.omitPromptCacheKey).toBeUndefined();
		expect(sol.applyPatchToolType).toBe("freeform");
		expect(sol.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		// The class-wide GPT-5+ hosted image grant does not reach the proxy.
		expect(sol.hostedImage).toBeUndefined();
		expect(sol.imageModel).toBeUndefined();

		const astra = build("gpt-6-astra", "openai-responses", `${route}/openai/v1`) as Model<"openai-responses">;
		expect(astra.compat.supportsConfigurationUpdate).toBe(false);
		expect(astra.applyPatchToolType).toBeUndefined();
		expect(astra.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
	});

	it("bundles a routed seed so the provider resolves before live discovery", () => {
		const seed = getBundledModels("palantir-foundry");
		const byApi = new Map(seed.map(model => [model.api, model.baseUrl]));

		expect(seed.map(model => model.id)).toContain("gpt-5.6-sol");
		expect(byApi.get("anthropic-messages")).toBe("https://xos.bpx.com/api/v2/llm/proxy/anthropic");
		expect(byApi.get("google-generative-ai")).toBe("https://xos.bpx.com/api/v2/llm/proxy/google/v1");
		for (const model of seed) {
			expect(model.requestModelId).toStartWith("ri.language-model-service..language-model.");
			expect(model.baseUrl).toStartWith("https://xos.bpx.com/api/v2/llm/proxy/");
		}
	});

	it("keeps the credential-scoped roster out of catalog generation", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(entry => entry.providerId === "palantir-foundry");

		expect(descriptor?.defaultModel).toBe("gpt-5.6-sol");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		// `catalogDiscovery` is the generator's only discovery gate; without it a
		// machine holding a Foundry token never bakes its enrollment into models.json.
		expect(descriptor?.catalogDiscovery).toBeUndefined();
	});

	it("configures credentialed discovery as authoritative", () => {
		const withoutCredential = palantirFoundryModelManagerOptions();
		const withCredential = palantirFoundryModelManagerOptions({ apiKey: "secret-token" });

		expect(withoutCredential.dynamicModelsAuthoritative).toBe(true);
		expect(withoutCredential.fetchDynamicModels).toBeUndefined();
		expect(withCredential.fetchDynamicModels).toBeFunction();
	});
});
