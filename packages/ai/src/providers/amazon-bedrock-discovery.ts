/**
 * SigV4-signed JSON GET used by Bedrock model discovery (control-plane
 * `ListInferenceProfiles` / `ListFoundationModels` and mantle `/v1/models`).
 * Shares the provider credential chain so discovery sees the same identity
 * that inference requests use.
 */
import type { BedrockSignedGetJson } from "@oh-my-pi/pi-catalog/discovery/amazon-bedrock";
import type { FetchImpl } from "../types";
import { resolveAwsCredentials } from "./aws-credentials";
import { signRequest } from "./aws-sigv4";

const DISCOVERY_TIMEOUT_MS = 15_000;
const EMPTY_BODY = new Uint8Array();

export interface BedrockDiscoveryClientOptions {
	profile?: string;
	fetch?: FetchImpl;
}

export function createBedrockSignedGetJson(options: BedrockDiscoveryClientOptions = {}): BedrockSignedGetJson {
	const fetchImpl = options.fetch ?? (globalThis.fetch as FetchImpl);
	return async ({ host, path, query, region }) => {
		const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
		const credentials = await resolveAwsCredentials({ profile: options.profile, region, signal, fetch: fetchImpl });
		const headers = { accept: "application/json" };
		const signed = await signRequest({
			method: "GET",
			host,
			path,
			query,
			body: EMPTY_BODY,
			region,
			service: "bedrock",
			credentials,
			headers,
		});
		const url = `https://${host}${path}${query ? `?${query}` : ""}`;
		const response = await fetchImpl(url, { method: "GET", headers: { ...headers, ...signed }, signal });
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Bedrock discovery GET ${host}${path} failed: HTTP ${response.status} ${body}`);
		}
		return response.json();
	};
}
