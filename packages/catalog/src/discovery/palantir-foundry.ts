import { readSseEvents } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import { resolveModelReference } from "../identity/reference";
import { getBundledModels } from "../models";
import type { Api, FetchImpl, ModelSpec } from "../types";
import { discoveryFetch, isRecord, toPositiveNumberOrNull } from "../utils";

export const PALANTIR_FOUNDRY_BASE_URL = "https://xos.bpx.com/api/v2/llm/proxy/openai/v1";
const PALANTIR_GRAPHQL_USER_AGENT = "agent-studio-app forge-graphql-client";
const PALANTIR_PAGE_SIZE = 100;

const HOME_PROJECT_QUERY = `query HomeProjectRidQuery {
  homeProject {
    rid
  }
}`;

const LANGUAGE_MODELS_QUERY = `query LanguageModelsV4Query(
  $attribution: LanguageModelAttribution!
  $modelOrigins: [LanguageModelOrigin!]
  $pageSize: Int!
  $pageToken: PageToken
) {
  languageModelsV4(
    pageSize: $pageSize
    pageToken: $pageToken
    modelOrigins: $modelOrigins
    permissionAndFilter: {
      usable: {
        attribution: $attribution
        filter: {inputType: {inputTypes: [GENERIC_CHAT_COMPLETION]}}
      }
    }
  ) {
    nextPageToken
    values {
      rid
      displayName
      modelCreator
      resolvedDetails(attribution: $attribution) {
        properties {
          ... on CompletionLanguageModelProperties {
            contextWindow
            maxOutputTokens
          }
        }
        modelSpecs {
          inputType
          modelSpec {
            inputModalities {
              __typename
            }
          }
        }
      }
    }
  }
}`;

interface GraphQlError {
	message?: unknown;
}

interface GraphQlEnvelope<T> {
	data?: T;
	errors?: GraphQlError[];
}

interface HomeProjectData {
	homeProject?: { rid?: unknown } | null;
}

interface LanguageModelsData {
	languageModelsV4?: {
		nextPageToken?: unknown;
		values?: unknown;
	} | null;
}

export interface PalantirFoundryDiscoveryOptions {
	apiKey: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

async function executeGraphQl<T>(
	endpoint: string,
	apiKey: string,
	operationName: string,
	query: string,
	variables: Record<string, unknown>,
	fetchImpl: FetchImpl,
): Promise<T> {
	const response = await fetchImpl(`${endpoint}?q=${encodeURIComponent(operationName)}`, {
		method: "POST",
		headers: {
			Accept: "text/event-stream",
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"fetch-user-agent": PALANTIR_GRAPHQL_USER_AGENT,
		},
		body: JSON.stringify({
			operations: { "0": query },
			requests: [{ hash: "0", name: operationName, variables }],
		}),
	});
	if (!response.ok) {
		throw new Error(`Palantir catalog request failed: HTTP ${response.status}`);
	}
	if (!response.body) {
		throw new Error("Palantir catalog response has no body");
	}

	let data: T | undefined;
	for await (const event of readSseEvents(response.body)) {
		if (!event.data) continue;
		const envelope = JSON.parse(event.data) as GraphQlEnvelope<T>;
		if (envelope.errors?.length) {
			const messages = envelope.errors
				.map(error => (typeof error.message === "string" ? error.message : "Unknown GraphQL error"))
				.join("; ");
			throw new Error(`Palantir catalog GraphQL error: ${messages}`);
		}
		if (envelope.data !== undefined) {
			data = envelope.data;
		}
	}
	if (data === undefined) {
		throw new Error("Palantir catalog response contained no data");
	}
	return data;
}

function modelInputTypes(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const inputTypes: string[] = [];
	for (const spec of value) {
		if (isRecord(spec) && typeof spec.inputType === "string") {
			inputTypes.push(spec.inputType);
		}
	}
	return inputTypes;
}

function supportsVision(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	for (const spec of value) {
		if (!isRecord(spec) || !isRecord(spec.modelSpec) || !Array.isArray(spec.modelSpec.inputModalities)) {
			continue;
		}
		if (
			spec.modelSpec.inputModalities.some(
				modality => isRecord(modality) && modality.__typename === "LanguageModelVisionInputModality",
			)
		) {
			return true;
		}
	}
	return false;
}

function mapPalantirModel(value: unknown, baseUrl: string): ModelSpec<Api> | null {
	if (
		!isRecord(value) ||
		typeof value.rid !== "string" ||
		typeof value.displayName !== "string" ||
		typeof value.modelCreator !== "string"
	) {
		return null;
	}
	const resolvedDetails = value.resolvedDetails;
	if (!isRecord(resolvedDetails) || !isRecord(resolvedDetails.properties)) {
		return null;
	}
	const inputTypes = modelInputTypes(resolvedDetails.modelSpecs);
	const origin = new URL(baseUrl).origin;
	let api: Api;
	let modelBaseUrl: string;
	if (inputTypes.includes("CLAUDE_CHAT")) {
		api = "anthropic-messages";
		modelBaseUrl = `${origin}/api/v2/llm/proxy/anthropic`;
	} else if (inputTypes.includes("GEMINI_CHAT")) {
		api = "google-generative-ai";
		modelBaseUrl = `${origin}/api/v2/llm/proxy/google/v1`;
	} else if (inputTypes.includes("X_AI_RESPONSES")) {
		api = "openai-responses";
		modelBaseUrl = `${origin}/api/v2/llm/proxy/xai/v1`;
	} else if (inputTypes.includes("OPEN_AI_RESPONSES")) {
		api = "openai-responses";
		modelBaseUrl = baseUrl;
	} else {
		logger.warn("Skipping Palantir model without a supported client transport", {
			displayName: value.displayName,
			inputTypes,
			rid: value.rid,
		});
		return null;
	}

	const id = value.displayName
		.trim()
		.toLowerCase()
		.replace(/\s+\(([^)]+)\)$/, "-$1")
		.replace(/\s+/g, "-");
	if (!id) return null;
	const referenceIds = [id];
	if (id === "grok-420-reasoning-latest") {
		referenceIds.push("grok-4.20-beta-latest-reasoning");
	} else if (id === "grok-420-non-reasoning-latest") {
		referenceIds.push("grok-4.20-beta-latest-non-reasoning");
	} else if (id === "gemma-4-26b-a4b") {
		referenceIds.push("gemma-4-26b-a4b-it");
	}
	const references = getBundledModelReferenceIndex();
	let reference: ModelSpec | undefined;
	for (const referenceId of referenceIds) {
		reference = resolveModelReference(referenceId, references);
		if (reference) break;
	}
	if (!reference) {
		reference = getBundledModels("xai").find(model => referenceIds.includes(model.id));
	}
	if (!reference) {
		logger.warn("Skipping Palantir model without canonical pricing", { id, rid: value.rid });
		return null;
	}
	const contextWindow =
		toPositiveNumberOrNull(resolvedDetails.properties.contextWindow) ??
		toPositiveNumberOrNull(reference.contextWindow);
	const maxTokens =
		toPositiveNumberOrNull(resolvedDetails.properties.maxOutputTokens) ?? toPositiveNumberOrNull(reference.maxTokens);
	if (contextWindow === null || maxTokens === null) {
		logger.warn("Skipping Palantir model without catalog or canonical limits", {
			displayName: value.displayName,
			rid: value.rid,
		});
		return null;
	}
	return {
		id,
		name: `${value.displayName.trim()} (Foundry)`,
		api,
		provider: "palantir-foundry",
		baseUrl: modelBaseUrl,
		requestModelId: value.rid,
		reasoning: inputTypes.includes("OPEN_AI_REASONING") || reference.reasoning,
		input: supportsVision(resolvedDetails.modelSpecs) ? ["text", "image"] : ["text"],
		cost: { ...reference.cost },
		contextWindow,
		maxTokens,
		...(api === "anthropic-messages" ? { compat: { disableStrictTools: true } } : undefined),
		...(api === "openai-responses" && modelBaseUrl !== baseUrl
			? { compat: { supportsPromptCacheKey: false } }
			: undefined),
		...(api === "openai-responses" && modelBaseUrl === baseUrl && /^gpt-5(?:[.-]|$)/i.test(id)
			? { applyPatchToolType: "freeform" as const }
			: undefined),
	};
}

export async function fetchPalantirFoundryModels(options: PalantirFoundryDiscoveryOptions): Promise<ModelSpec<Api>[]> {
	const baseUrl = options.baseUrl ?? PALANTIR_FOUNDRY_BASE_URL;
	const endpoint = `${new URL(baseUrl).origin}/graphql-gateway/api/bulk`;
	const fetchImpl = discoveryFetch(options.fetch);
	const homeProject = await executeGraphQl<HomeProjectData>(
		endpoint,
		options.apiKey,
		"HomeProjectRidQuery",
		HOME_PROJECT_QUERY,
		{},
		fetchImpl,
	);
	const homeProjectRid = homeProject.homeProject?.rid;
	if (typeof homeProjectRid !== "string" || homeProjectRid.length === 0) {
		throw new Error("Palantir catalog did not return a home project RID");
	}

	const models = new Map<string, ModelSpec<Api>>();
	const seenPageTokens = new Set<string>();
	let pageToken: string | undefined;
	do {
		const page = await executeGraphQl<LanguageModelsData>(
			endpoint,
			options.apiKey,
			"LanguageModelsV4Query",
			LANGUAGE_MODELS_QUERY,
			{
				attribution: { compass: { rid: homeProjectRid } },
				modelOrigins: ["PALANTIR_PROVIDED"],
				pageSize: PALANTIR_PAGE_SIZE,
				...(pageToken ? { pageToken } : undefined),
			},
			fetchImpl,
		);
		const values = page.languageModelsV4?.values;
		if (!Array.isArray(values)) {
			throw new Error("Palantir catalog returned an invalid model page");
		}
		for (const value of values) {
			const model = mapPalantirModel(value, baseUrl);
			if (model) models.set(model.id, model);
		}
		const nextPageToken = page.languageModelsV4?.nextPageToken;
		if (nextPageToken == null) {
			pageToken = undefined;
		} else if (typeof nextPageToken !== "string" || nextPageToken.length === 0) {
			throw new Error("Palantir catalog returned an invalid page token");
		} else if (seenPageTokens.has(nextPageToken)) {
			throw new Error("Palantir catalog repeated a page token");
		} else {
			seenPageTokens.add(nextPageToken);
			pageToken = nextPageToken;
		}
	} while (pageToken);

	return [...models.values()];
}
