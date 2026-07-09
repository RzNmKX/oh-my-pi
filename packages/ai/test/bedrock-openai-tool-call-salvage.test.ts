// Regression: bedrock-mantle (gpt-5.5) returns a generic `server_error`
// (`response.failed`) when *finalizing* any response whose output contains a
// freshly generated function_call, even though it streams the complete tool
// call first and accepts those tool-call items in a follow-up input. The
// provider salvages the completed tool call as a normal `toolUse` turn so the
// agent loop can dispatch it; the next turn (replaying the tool result)
// finalizes normally. These tests pin that contract, and its gates: the
// salvage only fires for an actually-completed tool call AND only for the
// `server_error` finalization code.
import { afterEach, describe, expect, it } from "bun:test";
import { streamBedrockOpenAI } from "@oh-my-pi/pi-ai/providers/amazon-bedrock-openai";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";

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
function sseResponse(events: unknown[]): Response {
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(new TextEncoder().encode(body), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Build a stream that fails finalization, optionally after a complete tool call. */
function failingStream(failure: { code: string; message: string }, withToolCall: boolean): unknown[] {
	const events: unknown[] = [{ type: "response.created", response: { id: "resp_1" } }];
	if (withToolCall) {
		const item = {
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "run_cmd",
			arguments: '{"command":"echo hi"}',
		};
		events.push(
			{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
			{
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: "fc_1",
				delta: '{"command":"echo hi"}',
			},
			{
				type: "response.function_call_arguments.done",
				output_index: 0,
				item_id: "fc_1",
				arguments: '{"command":"echo hi"}',
			},
			{ type: "response.output_item.done", output_index: 0, item },
		);
	}
	events.push({ type: "response.failed", response: { id: "resp_1", status: "failed", error: failure } });
	return events;
}

async function runStream(events: unknown[]): Promise<AssistantMessage> {
	// `$env` is `Bun.env` (aliased to `process.env`); static env credentials let
	// `resolveAwsCredentials` resolve offline so the SigV4 signing path runs
	// without touching the network. Restored per-test below.
	const prevAccessKey = process.env.AWS_ACCESS_KEY_ID;
	const prevSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
	process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLEEXAMPLE12";
	process.env.AWS_SECRET_ACCESS_KEY = "example-secret-key-for-offline-signing";
	try {
		const fetchImpl: FetchImpl = async () => sseResponse(events);
		const context: Context = {
			systemPrompt: ["You are a test agent."],
			messages: [{ role: "user", content: "Run echo hi", timestamp: 0 }],
		};
		return await streamBedrockOpenAI(model, context, { fetch: fetchImpl }).result();
	} finally {
		if (prevAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
		else process.env.AWS_ACCESS_KEY_ID = prevAccessKey;
		if (prevSecretKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
		else process.env.AWS_SECRET_ACCESS_KEY = prevSecretKey;
		clearAwsCredentialCache();
	}
}

afterEach(() => {
	clearAwsCredentialCache();
});

describe("bedrock-openai tool-call finalization salvage", () => {
	it("recovers a completed tool call when finalization fails with server_error", async () => {
		const message = await runStream(
			failingStream(
				{ code: "server_error", message: "The server had an error while processing your request." },
				true,
			),
		);

		expect(message.stopReason).toBe("toolUse");
		expect(message.errorMessage).toBeUndefined();
		const toolCall = message.content.find(block => block.type === "toolCall");
		expect(toolCall).toMatchObject({ name: "run_cmd", arguments: { command: "echo hi" } });
	});

	it("surfaces a server_error as a failed turn when no tool call was produced", async () => {
		const message = await runStream(
			failingStream(
				{ code: "server_error", message: "The server had an error while processing your request." },
				false,
			),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("server_error");
		expect(message.content.some(block => block.type === "toolCall")).toBe(false);
	});

	it("does not salvage a non-server_error failure even after a complete tool call", async () => {
		const message = await runStream(
			failingStream({ code: "rate_limit_exceeded", message: "Slow down." }, true),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("rate_limit_exceeded");
	});
});
