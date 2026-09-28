import { describe, expect, it } from "bun:test";
import {
	type BedrockSignedGetJson,
	fetchBedrockConverseModels,
	fetchBedrockMantleModels,
} from "@oh-my-pi/pi-catalog/discovery/amazon-bedrock";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const opusReference = {
	name: "Claude Opus 5.5 (US)",
	reasoning: true,
	tool_call: true,
	modalities: { input: ["text", "pdf"], output: ["text"] },
	limit: { context: 1_000_000, output: 128_000 },
	cost: { input: 4.4, output: 22, cache_read: 0.22, cache_write: 5.5 },
};

const modelsDevPayload = {
	"amazon-bedrock": {
		models: {
			"us.anthropic.claude-opus-5-5": opusReference,
			"amazon.nova-pro-v1:0": {
				name: "Nova Pro",
				tool_call: true,
				modalities: { input: ["text"], output: ["text"] },
				limit: { context: 300_000, output: 8_192 },
				cost: { input: 0.8, output: 3.2 },
			},
			"openai.gpt-6-sol": {
				name: "GPT-6 Sol",
				reasoning: true,
				tool_call: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 1_050_000, output: 128_000 },
				cost: { input: 5, output: 30 },
			},
		},
	},
};

// models.dev is the only outbound HTTP call the fetchers make directly.
const modelsDevFetch: FetchImpl = async () => Response.json(modelsDevPayload);

function profile(id: string, baseModelId: string, extra: Record<string, unknown> = {}) {
	return {
		inferenceProfileId: id,
		status: "ACTIVE",
		type: "SYSTEM_DEFINED",
		models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${baseModelId}` }],
		...extra,
	};
}

function foundationModel(modelId: string, extra: Record<string, unknown> = {}) {
	return {
		modelId,
		inferenceTypesSupported: ["ON_DEMAND"],
		inferenceAPIsSupported: { converse: { streaming: true } },
		inputModalities: ["TEXT", "IMAGE"],
		outputModalities: ["TEXT"],
		modelLifecycle: { status: "ACTIVE" },
		...extra,
	};
}

type Routes = Record<string, unknown | Error>;

function routedGetJson(routes: Routes, calls: string[] = []): BedrockSignedGetJson {
	return async ({ host, path, query }) => {
		const key = `${host}${path}${query ? `?${query}` : ""}`;
		calls.push(key);
		const route = routes[key];
		if (route === undefined) throw new Error(`HTTP 404 ${key}`);
		if (route instanceof Error) throw route;
		return route;
	};
}

const CONTROL = "bedrock.us-east-1.amazonaws.com";
const FIRST_PAGE = `${CONTROL}/inference-profiles?maxResults=1000`;

describe("fetchBedrockConverseModels", () => {
	it("adds new inference profiles from models.dev metadata and reuses bundled specs", async () => {
		const bundledOpus5 = getBundledModels("amazon-bedrock").find(m => m.id === "us.anthropic.claude-opus-5");
		expect(bundledOpus5).toBeDefined();
		const models = await fetchBedrockConverseModels({
			region: "us-east-1",
			cacheProviderId: "test",
			fetch: modelsDevFetch,
			getJson: routedGetJson({
				[FIRST_PAGE]: {
					inferenceProfileSummaries: [
						profile("us.anthropic.claude-opus-5", "anthropic.claude-opus-5"),
						profile("us.anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5"),
					],
				},
				[`${CONTROL}/foundation-models`]: {
					modelSummaries: [
						foundationModel("anthropic.claude-opus-5-5", { inferenceTypesSupported: ["INFERENCE_PROFILE"] }),
					],
				},
			}),
		});

		expect(models.map(m => m.id).sort()).toEqual(["us.anthropic.claude-opus-5", "us.anthropic.claude-opus-5-5"]);
		const opus5 = models.find(m => m.id === "us.anthropic.claude-opus-5")!;
		expect(opus5.contextWindow).toBe(bundledOpus5!.contextWindow);
		expect(opus5.cost).toEqual(bundledOpus5!.cost);
		const opus55 = models.find(m => m.id === "us.anthropic.claude-opus-5-5")!;
		expect(opus55.api).toBe("bedrock-converse-stream");
		expect(opus55.provider).toBe("amazon-bedrock");
		expect(opus55.contextWindow).toBe(1_000_000);
		expect(opus55.maxTokens).toBe(128_000);
		expect(opus55.cost.input).toBe(4.4);
		// ListFoundationModels reports IMAGE input even though the reference row omits it.
		expect(opus55.input).toContain("image");
	});

	it("follows pagination and skips ids with no metadata instead of defaulting", async () => {
		const calls: string[] = [];
		const models = await fetchBedrockConverseModels({
			region: "us-east-1",
			cacheProviderId: "test",
			fetch: modelsDevFetch,
			getJson: routedGetJson(
				{
					[FIRST_PAGE]: {
						inferenceProfileSummaries: [profile("us.xai.grok-4.7", "xai.grok-4.7")],
						nextToken: "page 2",
					},
					[`${FIRST_PAGE}&nextToken=page%202`]: {
						inferenceProfileSummaries: [
							profile("us.anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5"),
							profile("arn-app-profile", "anthropic.claude-opus-5-5", { type: "APPLICATION" }),
							profile("us.legacy", "anthropic.claude-opus-5-5", { status: "INACTIVE" }),
						],
					},
					[`${CONTROL}/foundation-models`]: new Error("HTTP 403 AccessDenied"),
				},
				calls,
			),
		});

		expect(calls).toContain(`${FIRST_PAGE}&nextToken=page%202`);
		expect(models.map(m => m.id)).toEqual(["us.anthropic.claude-opus-5-5"]);
	});

	it("adds on-demand foundation models and drops end-of-life or non-text ones", async () => {
		const models = await fetchBedrockConverseModels({
			region: "us-east-1",
			cacheProviderId: "test",
			fetch: modelsDevFetch,
			getJson: routedGetJson({
				[FIRST_PAGE]: {
					inferenceProfileSummaries: [profile("us.anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5")],
				},
				[`${CONTROL}/foundation-models`]: {
					modelSummaries: [
						foundationModel("amazon.nova-pro-v1:0"),
						foundationModel("anthropic.claude-opus-5-5", { modelLifecycle: { status: "END_OF_LIFE" } }),
						foundationModel("amazon.nova-canvas-v1:0", { outputModalities: ["IMAGE"] }),
					],
				},
			}),
		});

		// The Opus 5.5 profile is dropped because its base foundation model is end-of-life.
		expect(models.map(m => m.id)).toEqual(["amazon.nova-pro-v1:0"]);
	});

	it("surfaces a ListInferenceProfiles failure so the bundled catalog is kept", async () => {
		await expect(
			fetchBedrockConverseModels({
				region: "us-east-1",
				cacheProviderId: "test",
				fetch: modelsDevFetch,
				getJson: routedGetJson({ [FIRST_PAGE]: new Error("HTTP 403 AccessDenied") }),
			}),
		).rejects.toThrow("403");
	});
});

describe("fetchBedrockMantleModels", () => {
	const bundledWest = getBundledModels("amazon-bedrock-openai").find(m => m.id === "openai.gpt-6-astra");

	it("keeps bundled regions, relocates delisted ones, and adds new OpenAI models", async () => {
		expect(bundledWest?.baseUrl).toBe("https://bedrock-mantle.us-west-2.api.aws");
		const models = await fetchBedrockMantleModels({
			region: "us-east-1",
			cacheProviderId: "test",
			fetch: modelsDevFetch,
			getJson: routedGetJson({
				"bedrock-mantle.us-east-1.api.aws/v1/models": {
					data: [
						{ id: "openai.gpt-5.5", status: "available" },
						{ id: "openai.gpt-6-sol", status: "available" },
						{ id: "openai.gpt-6-astra", status: "available" },
						{ id: "openai.gpt-oss-120b", status: "available" },
						{ id: "anthropic.claude-opus-5-5", status: "available" },
						{ id: "openai.gpt-5.6-luna", status: "deprecated" },
					],
				},
				"bedrock-mantle.us-west-2.api.aws/v1/models": { data: [] },
			}),
		});

		expect(models.map(m => m.id).sort()).toEqual(["openai.gpt-5.5", "openai.gpt-6-astra", "openai.gpt-6-sol"]);
		const astra = models.find(m => m.id === "openai.gpt-6-astra")!;
		expect(astra.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws");
		const sol = models.find(m => m.id === "openai.gpt-6-sol")!;
		expect(sol.api).toBe("bedrock-openai-responses");
		expect(sol.provider).toBe("amazon-bedrock-openai");
		expect(sol.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws");
		expect(sol.contextWindow).toBe(1_050_000);
		expect(sol.applyPatchToolType).toBe("freeform");
	});

	it("tolerates a failing region but throws when every region fails", async () => {
		const partial = await fetchBedrockMantleModels({
			region: "us-east-1",
			cacheProviderId: "test",
			fetch: modelsDevFetch,
			getJson: routedGetJson({
				"bedrock-mantle.us-east-1.api.aws/v1/models": new Error("HTTP 403"),
				"bedrock-mantle.us-west-2.api.aws/v1/models": {
					data: [{ id: "openai.gpt-6-astra", status: "available" }],
				},
			}),
		});
		expect(partial.map(m => [m.id, m.baseUrl, m.contextWindow])).toEqual([
			[bundledWest!.id, bundledWest!.baseUrl, bundledWest!.contextWindow],
		]);

		await expect(
			fetchBedrockMantleModels({
				region: "us-east-1",
				cacheProviderId: "test",
				fetch: modelsDevFetch,
				getJson: routedGetJson({}),
			}),
		).rejects.toThrow("every region");
	});
});

describe("Bedrock discovery cache scope", () => {
	it("scopes the cache namespace to the AWS profile and region", () => {
		const saved = { profile: Bun.env.AWS_PROFILE, region: Bun.env.AWS_REGION };
		try {
			Bun.env.AWS_PROFILE = "profile-a";
			Bun.env.AWS_REGION = "us-east-1";
			const a = resolveModelCacheProviderId("amazon-bedrock");
			Bun.env.AWS_PROFILE = "profile-b";
			const b = resolveModelCacheProviderId("amazon-bedrock");
			Bun.env.AWS_REGION = "us-west-2";
			const c = resolveModelCacheProviderId("amazon-bedrock");
			expect(a).toStartWith("amazon-bedrock:discovery-v1:");
			expect(new Set([a, b, c]).size).toBe(3);
			expect(resolveModelCacheProviderId("amazon-bedrock-openai")).toStartWith(
				"amazon-bedrock-openai:discovery-v1:",
			);
		} finally {
			if (saved.profile === undefined) delete Bun.env.AWS_PROFILE;
			else Bun.env.AWS_PROFILE = saved.profile;
			if (saved.region === undefined) delete Bun.env.AWS_REGION;
			else Bun.env.AWS_REGION = saved.region;
		}
	});
});
