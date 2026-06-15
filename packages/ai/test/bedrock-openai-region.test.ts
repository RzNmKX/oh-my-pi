// Regression: gpt-5.5 is hosted only in us-east-1 on bedrock-mantle (no
// cross-region inference). The provider must NOT inherit AWS_REGION /
// AWS_DEFAULT_REGION — a shell pointed at another region would sign and route
// to a regional endpoint that returns 404 "model does not exist". The region
// is pinned to us-east-1 unless an explicit `region` option overrides it.
import { afterEach, describe, expect, it } from "bun:test";
import { streamBedrockOpenAI } from "@oh-my-pi/pi-ai/providers/amazon-bedrock-openai";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";

const model: Model<"bedrock-openai-responses"> = {
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
	compat: undefined,
};
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

/** Run the provider and return the request URL the provider actually targeted. */
async function capturedRequestUrl(region?: string): Promise<string> {
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
	process.env.AWS_REGION = "us-west-2";
	process.env.AWS_DEFAULT_REGION = "eu-west-1";
	let seen = "";
	try {
		const fetchImpl: FetchImpl = async (input: string | URL | Request) => {
			seen = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			return completedResponse();
		};
		const context: Context = {
			systemPrompt: ["You are a test agent."],
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		await streamBedrockOpenAI(model, context, { fetch: fetchImpl, region }).result();
		return seen;
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

describe("bedrock-openai region pinning", () => {
	it("targets us-east-1 even when AWS_REGION points elsewhere", async () => {
		const url = await capturedRequestUrl();
		expect(url).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses");
		expect(url).not.toContain("us-west-2");
		expect(url).not.toContain("eu-west-1");
	});

	it("honors an explicit region option as an override", async () => {
		const url = await capturedRequestUrl("us-gov-west-1");
		expect(url).toBe("https://bedrock-mantle.us-gov-west-1.api.aws/openai/v1/responses");
	});
});
