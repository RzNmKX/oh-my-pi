// Mantle models may live in different regions. Catalog endpoints, not ambient
// AWS region settings, must determine both routing and SigV4 signing scope.
import { afterEach, describe, expect, it } from "bun:test";
import { type BedrockOpenAIOptions, streamBedrockOpenAI } from "@oh-my-pi/pi-ai/providers/amazon-bedrock-openai";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"bedrock-openai-responses"> = buildModel({
	id: "openai.gpt-5.5",
	name: "GPT-5.5 (Bedrock)",
	api: "bedrock-openai-responses",
	provider: "amazon-bedrock-openai",
	baseUrl: "https://bedrock-mantle.us-east-1.api.aws",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
});
function completedResponse(): Response {
	const events = [
		{ type: "response.created", response: { id: "resp_1" } },
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(new TextEncoder().encode(body), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Capture the destination and real SigV4 scope without making an HTTP request. */
async function capturedRequest(
	requestModel: Model<"bedrock-openai-responses"> = model,
	region?: string,
	reasoning?: BedrockOpenAIOptions["reasoning"],
): Promise<{ url: string; authorization: string | null; payload: unknown }> {
	const prev = {
		accessKey: process.env.AWS_ACCESS_KEY_ID,
		secretKey: process.env.AWS_SECRET_ACCESS_KEY,
		awsRegion: process.env.AWS_REGION,
		awsDefaultRegion: process.env.AWS_DEFAULT_REGION,
	};
	// Static creds let resolveAwsCredentials run offline; the misconfigured
	// region env vars are exactly what must NOT leak into the endpoint.
	process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLEEXAMPLE12";
	process.env.AWS_SECRET_ACCESS_KEY = "example-secret-key-for-offline-signing";
	process.env.AWS_REGION = "us-east-2";
	process.env.AWS_DEFAULT_REGION = "eu-west-1";
	let seen = { url: "", authorization: null as string | null };
	let payload: unknown;
	try {
		const fetchImpl: FetchImpl = async (input: string | URL | Request, init) => {
			seen = {
				url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				authorization: new Headers(init?.headers).get("authorization"),
			};
			return completedResponse();
		};
		const context: Context = {
			systemPrompt: ["You are a test agent."],
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		const result = await streamBedrockOpenAI(requestModel, context, {
			fetch: fetchImpl,
			region,
			reasoning,
			onPayload: value => {
				payload = value;
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		return { ...seen, payload };
	} finally {
		for (const [key, value] of [
			["AWS_ACCESS_KEY_ID", prev.accessKey],
			["AWS_SECRET_ACCESS_KEY", prev.secretKey],
			["AWS_REGION", prev.awsRegion],
			["AWS_DEFAULT_REGION", prev.awsDefaultRegion],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		clearAwsCredentialCache();
	}
}

afterEach(() => {
	clearAwsCredentialCache();
});

describe("bedrock-openai regional endpoints", () => {
	it("routes and signs east models in us-east-1 despite ambient region settings", async () => {
		const request = await capturedRequest();
		expect(request.url).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses");
		expect(request.authorization).toContain("/us-east-1/bedrock/aws4_request");
	});

	it("routes and signs Astra in its catalog region rather than the east default", async () => {
		const request = await capturedRequest({
			...model,
			id: "openai.gpt-6-astra",
			baseUrl: "https://bedrock-mantle.us-west-2.api.aws",
		});
		expect(request.url).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses");
		expect(request.authorization).toContain("/us-west-2/bedrock/aws4_request");
	});

	it("uses an explicit region override for both the endpoint and signature", async () => {
		const request = await capturedRequest(
			{ ...model, id: "openai.gpt-6-astra", baseUrl: "https://bedrock-mantle.us-west-2.api.aws" },
			"us-east-1",
		);
		expect(request.url).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses");
		expect(request.authorization).toContain("/us-east-1/bedrock/aws4_request");
	});

	it("sends Astra's max reasoning effort and encrypted continuity on the wire", async () => {
		const astra = buildModel({
			...model,
			id: "openai.gpt-6-astra",
			baseUrl: "https://bedrock-mantle.us-west-2.api.aws",
			thinking: undefined,
			compat: undefined,
		});
		const request = await capturedRequest(astra, undefined, "max");
		expect(request.payload).toMatchObject({
			model: "openai.gpt-6-astra",
			reasoning: { effort: "max" },
			include: ["reasoning.encrypted_content"],
			store: false,
		});
	});

	it("rejects an invalid catalog endpoint instead of silently routing to Virginia", async () => {
		let requested = false;
		const result = await streamBedrockOpenAI(
			{ ...model, baseUrl: "https://api.openai.com/v1" },
			{ messages: [] },
			{
				fetch: async () => {
					requested = true;
					return completedResponse();
				},
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid Bedrock Mantle endpoint");
		expect(requested).toBe(false);
	});
});
