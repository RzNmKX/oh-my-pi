/**
 * Runtime model discovery for Amazon Bedrock.
 *
 * Two surfaces, both SigV4-signed (the signer lives in `@oh-my-pi/pi-ai`, so
 * callers inject it as {@link BedrockSignedGetJson}):
 *
 *  - `amazon-bedrock` (Converse): `ListInferenceProfiles` (required) and
 *    `ListFoundationModels` (optional; many SSO roles are denied it) on the
 *    `bedrock.{region}.amazonaws.com` control plane.
 *  - `amazon-bedrock-openai` (Responses on `bedrock-mantle`): the signed
 *    `/v1/models` listing, queried per region because mantle availability is
 *    regional.
 *
 * Neither API reports context windows or pricing, so a discovered id only
 * becomes a model when the bundled catalog or models.dev carries metadata for
 * that exact id. Ids without upstream metadata are skipped, never defaulted.
 */
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { ModelManagerOptions } from "../model-manager";
import { getBundledModels } from "../models";
import { createBundledReferenceMap } from "../provider-models/bundled-references";
import { fetchWellKnownModels, mapBedrockModelsDevReferences } from "../provider-models/openai-compat";
import type { Api, FetchImpl, ModelSpec } from "../types";
import { cleanModelName, isRecord } from "../utils";

/** Performs a SigV4-signed GET and returns the parsed JSON body; throws on non-2xx. */
export type BedrockSignedGetJson = (request: {
	host: string;
	path: string;
	query?: string;
	region: string;
}) => Promise<unknown>;

export interface BedrockDiscoveryConfig {
	getJson: BedrockSignedGetJson;
	/** Control-plane region for Converse discovery; preferred mantle region. */
	region: string;
	/** Cache namespace (scoped to the AWS profile/region by the caller). */
	cacheProviderId: string;
	fetch?: FetchImpl;
}

const BEDROCK_RUNTIME_BASE_URL = "https://bedrock-runtime.us-east-1.amazonaws.com";
const FOUNDATION_MODEL_ARN_SEGMENT = "foundation-model/";

interface FoundationModelSummary {
	modelId: string;
	onDemand: boolean;
	converseStreaming: boolean;
	textOutput: boolean;
	imageInput: boolean;
	lifecycle: string | undefined;
}

interface InferenceProfileSummary {
	id: string;
	baseModelId: string | undefined;
}

function parseFoundationModels(payload: unknown): FoundationModelSummary[] {
	if (!isRecord(payload) || !Array.isArray(payload.modelSummaries)) {
		throw new Error("Bedrock ListFoundationModels returned an invalid payload");
	}
	const out: FoundationModelSummary[] = [];
	for (const entry of payload.modelSummaries) {
		if (!isRecord(entry) || typeof entry.modelId !== "string") continue;
		const inferenceTypes = Array.isArray(entry.inferenceTypesSupported) ? entry.inferenceTypesSupported : [];
		const outputModalities = Array.isArray(entry.outputModalities) ? entry.outputModalities : [];
		const inputModalities = Array.isArray(entry.inputModalities) ? entry.inputModalities : [];
		const apis = isRecord(entry.inferenceAPIsSupported) ? entry.inferenceAPIsSupported : undefined;
		const converse = apis && isRecord(apis.converse) ? apis.converse : undefined;
		const lifecycle = isRecord(entry.modelLifecycle) ? entry.modelLifecycle.status : undefined;
		out.push({
			modelId: entry.modelId,
			onDemand: inferenceTypes.includes("ON_DEMAND"),
			// Older rows omit inferenceAPIsSupported; fall back to the legacy streaming flag.
			converseStreaming: converse ? converse.streaming === true : entry.responseStreamingSupported === true,
			textOutput: outputModalities.includes("TEXT"),
			imageInput: inputModalities.includes("IMAGE"),
			lifecycle: typeof lifecycle === "string" ? lifecycle : undefined,
		});
	}
	return out;
}

async function listInferenceProfiles(config: BedrockDiscoveryConfig): Promise<InferenceProfileSummary[]> {
	const host = `bedrock.${config.region}.amazonaws.com`;
	const out: InferenceProfileSummary[] = [];
	const seenTokens = new Set<string>();
	let nextToken: string | undefined;
	do {
		const query = `maxResults=1000${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ""}`;
		const payload = await config.getJson({ host, path: "/inference-profiles", query, region: config.region });
		if (!isRecord(payload) || !Array.isArray(payload.inferenceProfileSummaries)) {
			throw new Error("Bedrock ListInferenceProfiles returned an invalid payload");
		}
		for (const entry of payload.inferenceProfileSummaries) {
			if (!isRecord(entry) || typeof entry.inferenceProfileId !== "string") continue;
			// APPLICATION profiles are addressed by ARN and carry no catalog identity.
			if (entry.status !== "ACTIVE" || entry.type !== "SYSTEM_DEFINED") continue;
			let baseModelId: string | undefined;
			if (Array.isArray(entry.models)) {
				for (const model of entry.models) {
					if (!isRecord(model) || typeof model.modelArn !== "string") continue;
					const index = model.modelArn.indexOf(FOUNDATION_MODEL_ARN_SEGMENT);
					if (index !== -1) {
						baseModelId = model.modelArn.slice(index + FOUNDATION_MODEL_ARN_SEGMENT.length);
						break;
					}
				}
			}
			out.push({ id: entry.inferenceProfileId, baseModelId });
		}
		const token = payload.nextToken;
		if (typeof token !== "string" || token.length === 0) {
			nextToken = undefined;
		} else if (seenTokens.has(token)) {
			throw new Error("Bedrock ListInferenceProfiles repeated a page token");
		} else {
			seenTokens.add(token);
			nextToken = token;
		}
	} while (nextToken);
	return out;
}

async function listFoundationModels(config: BedrockDiscoveryConfig): Promise<FoundationModelSummary[] | null> {
	try {
		const payload = await config.getJson({
			host: `bedrock.${config.region}.amazonaws.com`,
			path: "/foundation-models",
			region: config.region,
		});
		return parseFoundationModels(payload);
	} catch (error) {
		logger.debug("Bedrock ListFoundationModels unavailable; discovering inference profiles only", {
			region: config.region,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function loadModelsDevReferences(fetchImpl: FetchImpl | undefined): Promise<Map<string, ModelSpec<Api>>> {
	const references = new Map<string, ModelSpec<Api>>();
	try {
		for (const model of mapBedrockModelsDevReferences(await fetchWellKnownModels(fetchImpl))) {
			references.set(model.id, model);
		}
	} catch (error) {
		logger.debug("models.dev unavailable for Bedrock discovery metadata", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return references;
}

function isUsableFoundationModel(model: FoundationModelSummary): boolean {
	return model.converseStreaming && model.textOutput && model.lifecycle !== "END_OF_LIFE";
}

/**
 * Discovers the Converse models this AWS identity can invoke: every active
 * system-defined inference profile, plus on-demand foundation models when
 * `ListFoundationModels` is permitted.
 */
export async function fetchBedrockConverseModels(config: BedrockDiscoveryConfig): Promise<ModelSpec<Api>[]> {
	const [profiles, foundationModels, modelsDevReferences] = await Promise.all([
		listInferenceProfiles(config),
		listFoundationModels(config),
		loadModelsDevReferences(config.fetch),
	]);
	const bundled = createBundledReferenceMap<Api>("amazon-bedrock");
	const foundationById = new Map(foundationModels?.map(model => [model.modelId, model]));

	const candidates = new Map<string, string | undefined>();
	for (const profile of profiles) candidates.set(profile.id, profile.baseModelId);
	for (const model of foundationModels ?? []) {
		if (model.onDemand && isUsableFoundationModel(model)) candidates.set(model.modelId, model.modelId);
	}

	const models: ModelSpec<Api>[] = [];
	const skipped: string[] = [];
	for (const [id, baseModelId] of candidates) {
		const foundation = baseModelId ? foundationById.get(baseModelId) : undefined;
		if (foundation && !isUsableFoundationModel(foundation)) continue;
		const existing = bundled.get(id);
		if (existing) {
			models.push(existing);
			continue;
		}
		const reference = modelsDevReferences.get(id);
		if (!reference) {
			skipped.push(id);
			continue;
		}
		models.push({
			...reference,
			name: cleanModelName(reference.name),
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: BEDROCK_RUNTIME_BASE_URL,
			...(foundation?.imageInput && !reference.input.includes("image")
				? { input: [...reference.input, "image"] as ModelSpec<Api>["input"] }
				: undefined),
		});
	}
	if (skipped.length > 0) {
		logger.debug("Skipping Bedrock models without catalog or models.dev metadata", { ids: skipped });
	}
	return models;
}

function mantleRegionFromBaseUrl(baseUrl: string): string | undefined {
	return new URL(baseUrl).hostname.match(/^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/)?.[1];
}

function mantleBaseUrl(region: string): string {
	return `https://bedrock-mantle.${region}.api.aws`;
}

/**
 * Whether a mantle listing entry is served by the OpenAI Responses transport
 * this provider speaks. Mantle also lists Anthropic/Qwen/etc. rows, but the
 * provider (and its GPT-tuned request shaping) targets first-party OpenAI
 * models only; the open-weight gpt-oss family is excluded for the same reason.
 */
function isMantleResponsesModel(id: string): boolean {
	return id.startsWith("openai.gpt-") && !id.startsWith("openai.gpt-oss");
}

/**
 * Discovers `bedrock-mantle` OpenAI models per region. The preferred region is
 * queried first, then every region already used by a bundled mantle model.
 * A model keeps its bundled region when that region still lists it.
 */
export async function fetchBedrockMantleModels(config: BedrockDiscoveryConfig): Promise<ModelSpec<Api>[]> {
	const bundled = createBundledReferenceMap<Api>("amazon-bedrock-openai");
	const regions = [config.region];
	for (const model of getBundledModels("amazon-bedrock-openai")) {
		const region = mantleRegionFromBaseUrl(model.baseUrl);
		if (region && !regions.includes(region)) regions.push(region);
	}

	const listings = await Promise.all(
		regions.map(async region => {
			try {
				const payload = await config.getJson({
					host: `bedrock-mantle.${region}.api.aws`,
					path: "/v1/models",
					region,
				});
				if (!isRecord(payload) || !Array.isArray(payload.data)) {
					throw new Error("Bedrock Mantle /v1/models returned an invalid payload");
				}
				const ids = new Set<string>();
				for (const entry of payload.data) {
					if (isRecord(entry) && typeof entry.id === "string" && entry.status === "available") {
						ids.add(entry.id);
					}
				}
				return { region, ids };
			} catch (error) {
				logger.debug("Bedrock Mantle model listing failed", {
					region,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			}
		}),
	);
	const succeeded = listings.filter(listing => listing !== null);
	if (succeeded.length === 0) {
		throw new Error(`Bedrock Mantle model listing failed in every region (${regions.join(", ")})`);
	}

	const modelsDevReferences = await loadModelsDevReferences(config.fetch);
	const models: ModelSpec<Api>[] = [];
	const skipped: string[] = [];
	const discoveredIds = new Set(succeeded.flatMap(listing => [...listing.ids]));
	for (const id of discoveredIds) {
		if (!isMantleResponsesModel(id)) continue;
		const existing = bundled.get(id);
		const existingRegion = existing ? mantleRegionFromBaseUrl(existing.baseUrl) : undefined;
		const region =
			succeeded.find(listing => listing.region === existingRegion && listing.ids.has(id))?.region ??
			succeeded.find(listing => listing.ids.has(id))!.region;
		if (existing) {
			models.push(existingRegion === region ? existing : { ...existing, baseUrl: mantleBaseUrl(region) });
			continue;
		}
		const reference = modelsDevReferences.get(id);
		if (!reference) {
			skipped.push(id);
			continue;
		}
		models.push({
			...reference,
			name: cleanModelName(reference.name),
			api: "bedrock-openai-responses",
			provider: "amazon-bedrock-openai",
			baseUrl: mantleBaseUrl(region),
			applyPatchToolType: "freeform",
		});
	}
	if (skipped.length > 0) {
		logger.debug("Skipping Bedrock Mantle models without catalog or models.dev metadata", { ids: skipped });
	}
	return models;
}

/**
 * Converse discovery is additive: accounts denied `ListFoundationModels` only
 * see inference profiles, so bundled on-demand models must not be pruned.
 */
export function amazonBedrockModelManagerOptions(config: BedrockDiscoveryConfig): ModelManagerOptions<Api> {
	return {
		providerId: "amazon-bedrock",
		cacheProviderId: config.cacheProviderId,
		fetchDynamicModels: () => fetchBedrockConverseModels(config),
	};
}

/** Mantle discovery is additive: a region that fails to list must not drop its bundled models. */
export function amazonBedrockOpenAIModelManagerOptions(config: BedrockDiscoveryConfig): ModelManagerOptions<Api> {
	return {
		providerId: "amazon-bedrock-openai",
		cacheProviderId: config.cacheProviderId,
		fetchDynamicModels: () => fetchBedrockMantleModels(config),
	};
}
