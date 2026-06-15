# GPT-5.5 via AWS Bedrock (bedrock-mantle endpoint)

Tested 2026-06-02 through 2026-06-09 using `myapps-nonprod` profile (account 986792619989), region us-east-2.

## Endpoint

```
POST https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses
```

Note: This is the `openai/v1/responses` path (not `v1/responses` used by other models).

## Auth

Standard AWS SigV4 signing works -- no Bedrock API key needed.

- Service name for signing: `bedrock`
- Region: `us-east-2` (only region available at launch)
- Credentials: Any IAM principal with Bedrock model access

```python
import boto3, json, requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

session = boto3.Session(profile_name='myapps-nonprod')
credentials = session.get_credentials().get_frozen_credentials()

region = 'us-east-2'
url = f'https://bedrock-mantle.{region}.api.aws/openai/v1/responses'
payload = {
    'model': 'openai.gpt-5.5',
    'input': 'Your prompt here',
    'reasoning': {
        'effort': 'high',
        'summary': 'detailed'
    }
}

body = json.dumps(payload)
headers = {'Content-Type': 'application/json'}

request = AWSRequest(method='POST', url=url, data=body, headers=headers)
SigV4Auth(credentials, 'bedrock', region).add_auth(request)

response = requests.post(url, data=body, headers=dict(request.headers), timeout=120)
print(response.json())
```

## Model ID

```
openai.gpt-5.5
```

## Reasoning / Thinking

GPT-5.5 uses reasoning tokens (like o1/o3) but the raw thinking text is NOT exposed through Bedrock.

### Parameters

| Parameter | Valid Values | Effect |
|-----------|-------------|--------|
| `reasoning.effort` | `"low"`, `"medium"`, `"high"` | Controls reasoning depth. Default: `"medium"` |
| `reasoning.summary` | `"auto"`, `"concise"`, `"detailed"` | Requests reasoning summary. All return empty `[]` on Bedrock. |
| `include` | `["reasoning.encrypted_content"]` | Returns encrypted blob (not human-readable) |

### What we observed

- `effort: "high"` does trigger real reasoning (286-516 tokens on math proofs)
- The `reasoning` output block appears in the response but with `summary: []` (empty)
- `reasoning_tokens` in usage shows tokens consumed but content is opaque
- `include: ["reasoning.encrypted_content"]` returns an encrypted blob meant for multi-turn context threading -- not readable
- Quality clearly improves with higher effort (correct LaTeX proofs at `high`)

### Response structure with reasoning

```json
{
  "output": [
    {
      "type": "reasoning",
      "id": "rs_...",
      "summary": []
    },
    {
      "type": "message",
      "role": "assistant",
      "phase": "final_answer",
      "content": [{"type": "output_text", "text": "..."}]
    }
  ],
  "usage": {
    "input_tokens": 12,
    "output_tokens": 600,
    "output_tokens_details": {"reasoning_tokens": 286},
    "total_tokens": 612
  },
  "reasoning": {
    "effort": "high",
    "summary": "detailed",
    "context": "current_turn"
  }
}
```

### Encrypted content (for multi-turn)

With `include: ["reasoning.encrypted_content"]`, the reasoning block includes:

```json
{
  "type": "reasoning",
  "id": "rs_...",
  "encrypted_content": "rsn_pUPh16to4VKY...",
  "summary": []
}
```

This encrypted blob can be passed back in subsequent requests to maintain reasoning continuity, but cannot be decrypted client-side.

## Valid `include` values

```
file_search_call.results
web_search_call.results
web_search_call.action.sources
message.input_image.image_url
computer_call_output.output.image_url
code_interpreter_call.outputs
reasoning.encrypted_content
message.output_text.logprobs
```

## Comparison: Bedrock vs Direct OpenAI API

When using GPT-5.5 via the direct OpenAI API (with OPENAI_API_KEY), thinking blocks ARE visible
in the response as streaming `response.reasoning_summary_text.delta` events. Through Bedrock's
bedrock-mantle endpoint, reasoning is consumed/billed but the text is not exposed.

### Streaming event comparison

**Direct OpenAI API** streams these reasoning events:
- `response.reasoning_summary_part.added`
- `response.reasoning_summary_text.delta` (the actual thinking text, streamed incrementally)
- `response.reasoning_summary_part.done`

**Bedrock bedrock-mantle** only streams:
- `response.output_item.added` (reasoning item with `encrypted_content` -- opaque blob)
- `response.output_item.done`
- `response.output_text.delta` (final answer only)

The reasoning summary events are completely absent from Bedrock's stream. This is why
oh-my-pi shows thinking blocks when using OpenAI directly but not through Bedrock.

### oh-my-pi code reference

The handling for reasoning summaries lives in:
- `packages/ai/src/providers/openai-responses-shared.ts` (lines 344-378)
- Listens for `response.reasoning_summary_text.delta` and emits `thinking_delta` events
- Also sends `include: ["reasoning.encrypted_content"]` and `reasoning.summary: "auto"`

### Bottom line

Bedrock strips the human-readable reasoning summary. You get:
1. Encrypted content (for multi-turn continuity, not human-readable)
2. Token count (billed)
3. Quality improvement (the model did reason internally)

You do NOT get the actual thinking text. This is a Bedrock policy decision.

## Errors

- Model not subscribed: `401 {"error":{"code":"access_denied","message":"Your subscription to the model is being set up..."}}`
- Invalid summary value: `400 {"error":{"code":"invalid_value","message":"Invalid value: 'verbose'. Supported values are: 'concise', 'detailed', and 'auto'."}}`

## Supported Features (from AWS docs)

- Input: Text, Image
- Output: Text
- API: Responses only (not Chat Completions, Converse, or Invoke)
- Endpoint: bedrock-mantle only (not bedrock-runtime)
- Context window: 272K tokens
- Service tier: Standard only (no Priority, Flex, or Reserved)
- Regional: us-east-2 only, no cross-region inference

## Integration with oh-my-pi

### Status (as of 2026-06-09): integrated

Wired as a dedicated provider/API pair:
- Provider: `amazon-bedrock-openai` (`packages/ai/src/registry/amazon-bedrock-openai.ts`)
- API: `bedrock-openai-responses` (`packages/ai/src/providers/amazon-bedrock-openai.ts`)
- Model ref: `amazon-bedrock-openai/openai.gpt-5.5`
- Wire protocol: OpenAI Responses, reusing `openai-responses-shared.ts` (SSE parsing, message conversion)
- Auth: AWS SigV4 (`service=bedrock`), same credential chain as `amazon-bedrock` (env, profile, SSO, IMDS) -- no API key
- Endpoint: `https://bedrock-mantle.{region}.api.aws/openai/v1/responses`; region is **pinned to `us-east-2`** (the only region hosting gpt-5.5 — no cross-region inference). `AWS_REGION`/`AWS_DEFAULT_REGION` are intentionally **not** consulted, since a shell pointed at another region would route to an endpoint that 404s with "model does not exist". Only an explicit `region` option overrides the pin.
- System prompt: sent as `developer`-role input items (reasoning model), not top-level `instructions`

Credentials must belong to an account entitled for `bedrock-mantle:CreateInference` (e.g. `myapps-nonprod`, 986792619989); `us-east-2` only. Smoke test:

```
omp -p "what is 2+2" --model amazon-bedrock-openai/openai.gpt-5.5
```

Discovery: `ListFoundationModels` still omits `openai.gpt-5.5` and `models.dev` maps Bedrock to `bedrock-converse-stream`, so the model is a hardcoded `models.json` entry under the `amazon-bedrock-openai` provider -- there is no discovery path.

### Function calling: server-side finalization bug + salvage

bedrock-mantle **fully generates** a function call (streams `output_item.added` -> `function_call_arguments.delta` -> `.done` -> `output_item.done` with the complete name and arguments) but then **fails to finalize**, emitting `response.failed` with a generic `server_error` ("The server had an error while processing your request") instead of `response.completed`. Verified deterministic across reasoning on/off, strict on/off, `tool_choice` auto/forced, streaming and non-streaming (non-streaming returns HTTP 500), and `store` true/false. Text-only responses finalize normally, and a follow-up request whose input *already contains* `function_call` + `function_call_output` items finalizes normally (the model reads the tool output and replies).

Because the tool call is delivered complete before the failure, the provider **salvages** it: when a function_call `output_item.done` was observed and the terminal error is the `server_error` finalization, the turn ends as `toolUse` (tool call intact) instead of failing. The agent dispatches the tool; the next turn (replaying the tool result) finalizes normally -- so multi-turn tool use works end-to-end despite the broken finalization. The gate is narrow: no completed tool call, or any other error code, still surfaces as a normal error. See `streamBedrockOpenAI` in `amazon-bedrock-openai.ts` and `packages/ai/test/bedrock-openai-tool-call-salvage.test.ts`. Remove the salvage once AWS fixes finalization.

### Reasoning/thinking limitation

Thinking blocks do NOT render: Bedrock suppresses `response.reasoning_summary_text.delta` (only opaque `encrypted_content` is returned). The model reasons internally (tokens billed, quality improves) but the text is opaque. May change as AWS matures the integration.

## Operational notes

### Outage: Jun 4, 2026

Model returned 200 with empty `output: []` and 0 tokens for all requests (including trivial
ones like "What is 2+2?"). Took ~37 seconds per request to return nothing. Lasted the full day.
Resolved by Jun 5.

### Timeline

| Date | Observation |
|------|-------------|
| Jun 1 | GPT-5.5 launched on Bedrock. Model card published. |
| Jun 2 | First successful invocation via SigV4. Reasoning tokens consumed but summaries suppressed. |
| Jun 3 | No changes. Still not in ListFoundationModels. |
| Jun 4 | Model broken -- returns 200 with empty output for all prompts. |
| Jun 5 | Model restored. Reasoning summaries still suppressed. |
| Jun 9 | New "bedrock mantle console" appeared in AWS. GPT-5.5 still not listed there. Still invocable via API. |
| Jun 9 | Integrated into oh-my-pi (`amazon-bedrock-openai` / `bedrock-openai-responses`). Text + multi-turn tool use work end-to-end; function-call finalization returns `server_error` server-side, salvaged client-side. |