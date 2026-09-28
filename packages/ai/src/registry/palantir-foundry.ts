import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * Palantir Foundry's XOS LLM proxy fronts multiple provider-native protocols
 * under one enterprise enrollment. Catalog discovery uses Foundry GraphQL, but
 * token validation stays on the OpenAI Responses proxy because the gateway does
 * not publish a conventional `/models` endpoint.
 */
export const loginPalantirFoundry = createApiKeyLogin({
	providerLabel: "Palantir Foundry",
	authUrl: "https://xos.bpx.com/workspace/developer-console/",
	instructions: "Create a Foundry service-user token with LLM proxy access and copy it",
	promptMessage: "Paste your Palantir Foundry token",
	placeholder: "eyJ...",
	validation: {
		kind: "responses",
		provider: "Palantir Foundry",
		baseUrl: "https://xos.bpx.com/api/v2/llm/proxy/openai/v1",
		model: "gpt-5.6-sol",
	},
});

export const palantirFoundryProvider = {
	id: "palantir-foundry",
	name: "Palantir Foundry",
	login: (cb: OAuthLoginCallbacks) => loginPalantirFoundry(cb),
} as const satisfies ProviderDefinition;
