import { $env } from "@oh-my-pi/pi-utils";
import type { ProviderDefinition } from "./types";

export const amazonBedrockOpenaiProvider = {
	id: "amazon-bedrock-openai",
	name: "Amazon Bedrock (OpenAI)",
	// Same credential chain as amazon-bedrock — SigV4 auth, no API key.
	envKeys: () => {
		const hasEcsCredentials =
			!!$env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!$env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
		const hasWebIdentity = !!$env.AWS_WEB_IDENTITY_TOKEN_FILE && !!$env.AWS_ROLE_ARN;
		if (
			$env.AWS_PROFILE ||
			($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY) ||
			$env.AWS_BEARER_TOKEN_BEDROCK ||
			hasEcsCredentials ||
			hasWebIdentity
		) {
			return "<authenticated>";
		}
	},
} as const satisfies ProviderDefinition;
