import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolSpeculationPolicy,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, ToolExample } from "@oh-my-pi/pi-ai";
import { formatBackgroundNotice } from "@oh-my-pi/pi-tui/tools/bash";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isRecord, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { raceJobSettlement, resolveAutoBackgroundWaitMs } from "../async";
import { jsBackend, pythonBackend } from "../eval";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../eval/bridge-timeout";
import { IdleTimeout } from "../eval/idle-timeout";
import { type EvalPreludeDefinition, evalPreludeSummary, getEnabledEvalPreludes } from "../eval/preludes";
import { prepareEvalSource } from "../eval/input";
import {
	getPythonCellStore,
	type PythonCellRunStatus,
	type PythonCellSnapshot,
	type PythonCellStore,
} from "../eval/py/cell-store";
import type { BackendProbeOptions } from "../eval/probe";
import { defaultEvalSessionId } from "../eval/session-id";
import { EvalShadowCellSession } from "../eval/speculation/cell-session";
import { runWithEvalShadowCell } from "../eval/speculation/runtime-context";
import type {
	EvalCellResult,
	EvalLanguage,
	EvalStatusEvent,
	EvalToolDetails,
	EvalViewEntry,
} from "@oh-my-pi/pi-tui/tools/eval";
import evalDescription from "../prompts/tools/eval.md" with { type: "text" };
import evalAgentsTopic from "../prompts/tools/eval-agents.md" with { type: "text" };
import evalJudgeTopic from "../prompts/tools/eval-judge.md" with { type: "text" };
import evalHelpersTopic from "../prompts/tools/eval-helpers.md" with { type: "text" };
import {
	DEFAULT_MAX_BYTES,
	findColumnCapped,
	OutputSink,
	type OutputSummary,
	TailBuffer,
} from "@oh-my-pi/pi-tui/tools/streaming-output";
import { sessionDelegationBias } from "../task/prompt-policy";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { canSpawnAtDepth } from "../task/types";
import { webpExclusionForModel } from "@oh-my-pi/pi-tui/chat/image-loading";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { type EvalBackendsAllowance, resolveAdvertisedEvalBackends, resolveEvalBackends } from "./eval-backends";
import { recordStatusEvent, type StatusEventLog } from "@oh-my-pi/pi-tui/tools/eval";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { resolveOutputMaxColumns, resolveOutputSinkArtifactMaxBytes, resolveOutputSinkHeadBytes } from "./output-meta";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { hasWaitTool } from "./wait";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

import {
	cfgEvalAutoBackgroundEnabled,
	cfgEvalAutoBackgroundThresholdMs,
	cfgEvalAutoProvision,
	cfgEvalToolsEnabled,
} from "../eval/settings";
import { cfgTaskMaxRecursionDepth, perCallModelEnabled } from "../task/settings";
import { getPerCallModelAdvertisement, type PerCallModelAdvertisement } from "../task/model-approval";
import { shapeToolResult } from "../spotlight";
import { cfgToolsMaxTimeout, cfgToolsSpeculativeExecutionEnabled } from "./settings";

/** Language tokens the eval tool accepts, in stable display order. */
export type EvalLanguageToken = "py" | "js";
const EVAL_LANGUAGE_ORDER: readonly EvalLanguageToken[] = ["py", "js"];
const EVAL_LANGUAGE_RUNTIME: Record<EvalLanguageToken, string> = {
	py: '"py": Python with IPython-style magics (not IPython)',
	js: '"js": Bun',
};
const EVAL_LANGUAGE_NAME: Record<EvalLanguageToken, string> = {
	py: "Python",
	js: "JavaScript",
};

/** Join names as an English "or" list: ["A"]→"A", ["A","B"]→"A or B", 3+→"A, B, or C". */
function joinWithOr(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} or ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function describeLanguageField(langs: readonly EvalLanguageToken[]): string {
	return langs.map(lang => EVAL_LANGUAGE_RUNTIME[lang]).join("; ");
}

/** One-line discovery summary listing the runtimes available this session. */
function summarizeEvalLanguages(langs: readonly EvalLanguageToken[]): string {
	const names = langs.map(lang => EVAL_LANGUAGE_NAME[lang]);
	return names.length > 0
		? `Execute ${joinWithOr(names)} in persistent kernels; load scripts or install packages`
		: "No eval runtimes are currently available";
}

/** Resolved-allowance → enabled language tokens, preserving display order. */
function enabledEvalLanguages(backends: EvalBackendsAllowance): EvalLanguageToken[] {
	const allowed: Record<EvalLanguageToken, boolean> = {
		py: backends.python,
		js: backends.js,
	};
	return EVAL_LANGUAGE_ORDER.filter(lang => allowed[lang]);
}

const EVAL_ACTION_ORDER = ["execute", "run", "edit", "replay", "list"] as const;
type EvalAction = (typeof EVAL_ACTION_ORDER)[number];

const evalCellIndex = type("number.integer").describe("Stable 1-based Python cell index.");
const evalCellEditSchema = type({
	old: type("string").describe("Exact text to replace; must occur exactly once."),
	new: type("string").describe("Replacement text."),
});

function evalTimeoutSchema(maxTimeout?: number) {
	const { min, max } = TOOL_TIMEOUTS.eval;
	const configured =
		maxTimeout !== undefined && maxTimeout > 0
			? ` Configured tools.maxTimeout: ${maxTimeout}s (effective ceiling ${clampTimeout("eval", max, maxTimeout)}s).`
			: "";
	return type("number").describe(
		`Cell deadline in seconds; nonzero values clamp to ${min}–${max}; 0 disables it.${configured}`,
	);
}

interface EvalSchemaInput {
	action?: EvalAction;
	language: EvalLanguageToken;
	code?: string;
	cell?: number;
	edits?: Array<{ old: string; new: string }>;
	from?: number;
	through?: number;
}

/** Whether `action` runs or lists stored Python cells rather than a new cell. */
function isStoredCellAction(action: EvalAction | undefined): action is Exclude<EvalAction, "execute"> {
	return action !== undefined && action !== "execute";
}

/** 1-based stored-cell index; `0` and non-integers are strict-provider unset sentinels. */
function storedCellIndex(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

/**
 * Required fields per action. Unused sibling fields are ignored: strict provider
 * wire schemas make models send every key.
 */
function evalInputConstraint(params: EvalSchemaInput): string | undefined {
	const action = params.action ?? "execute";
	if (action !== "execute" && params.language !== "py") return `action "${action}" requires language "py"`;
	switch (action) {
		case "execute":
			return params.code === undefined ? '"code" is required for a new eval cell' : undefined;
		case "run":
			return storedCellIndex(params.cell) === undefined ? '"cell" is required for action "run"' : undefined;
		case "edit":
			return storedCellIndex(params.cell) === undefined || !params.edits?.length
				? '"cell" and "edits" are required for action "edit"'
				: undefined;
		case "replay":
		case "list":
			return undefined;
	}
}

const evalCellCommonFields = {
	"title?": type("string").describe("Short transcript label."),
	"reset?": type("boolean").describe("Wipe only this kernel."),
};

/**
 * Per-call input: one new cell, or one action on stored Python cells. State
 * persists within a language across calls, so each call is one logical step and
 * later calls reuse what earlier ones defined. The schema is one object with
 * cross-field narrowing because providers reject a root union.
 */
function buildCellSchema(langs: readonly EvalLanguageToken[], maxTimeout?: number) {
	const schema = type({
		"action?": type
			.enumerated(...EVAL_ACTION_ORDER)
			.describe("Run a new cell, or act on stored Python cells; omit for a new cell."),
		language: type.enumerated(...langs).describe(describeLanguageField(langs)),
		"code?": type("string").describe("New cell: code or standalone % command; top-level await works."),
		"cell?": evalCellIndex,
		"edits?": evalCellEditSchema.array().describe("Exact replacements, applied atomically in order."),
		"from?": evalCellIndex.describe("First stored cell to replay; default 1."),
		"through?": evalCellIndex.describe("Last stored cell to replay; default the newest."),
		...evalCellCommonFields,
		"timeout?": evalTimeoutSchema(maxTimeout),
	});
	return schema.narrow((params, ctx) => {
		const constraint = evalInputConstraint(params);
		return constraint === undefined || ctx.mustBe(constraint);
	});
}

/** Full-union schema: the type-level source of truth and the dispatch validator. */
export const evalSchema = buildCellSchema(EVAL_LANGUAGE_ORDER);

/**
 * Build a session-scoped copy of the eval schema whose `language` enum and field
 * descriptions advertise only the runtimes enabled for this session. Disabled
 * backends never reach the model: the wire schema, BM25 discovery corpus, and
 * tool description stay in lockstep with {@link resolveAdvertisedEvalBackends}.
 * Stored cells are Python-only, so without Python only new cells are advertised;
 * dispatch still validates against the full {@link evalSchema}.
 */
function buildEvalSchema(langs: readonly EvalLanguageToken[], maxTimeout?: number): typeof evalSchema {
	if (langs.includes("py")) return buildCellSchema(langs, maxTimeout);
	const schema = type({
		language: type.enumerated(...langs).describe(describeLanguageField(langs)),
		code: type("string").describe("Code or standalone % command; top-level await works."),
		...evalCellCommonFields,
		"timeout?": evalTimeoutSchema(maxTimeout),
	});
	return schema as unknown as typeof evalSchema;
}
export type EvalToolParams = typeof evalSchema.infer;
export type EvalCellInput = EvalToolParams;

export type EvalToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: EvalToolDetails | undefined;
};

export type EvalProxyExecutor = (params: EvalToolParams, signal?: AbortSignal) => Promise<EvalToolResult>;

/** Largest pretty view (by `JSON.stringify` length) kept in a cell's details; bigger ones show as text only. */
const MAX_VIEW_JSON_CHARS = 32 * 1024;
/** Most pretty views kept per cell; the excess shows as text only. */
const MAX_VIEWS_PER_CELL = 16;
/** Minimum spacing between live eval updates; bursts coalesce to one trailing snapshot. */
const LIVE_UPDATE_INTERVAL_MS = 50;

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
	/**
	 * Parent spawn policy (`getSessionSpawns`). `true`/omitted means unrestricted,
	 * `false`/`""` hides `agent()`, and a comma list drives the advertised default.
	 */
	spawns?: boolean | string | null;
	/** Advertise auto-backgrounding of long-running cells in the tool prompt. */
	autoBackgroundEnabled?: boolean;
	/** Advertise `@tool` / `tool(fn)` and the `tools` spawn option (`eval.tools.enabled`). */
	evalTools?: boolean;
	/** Push `workpool()` as the default for independent items (model delegation bias `eager`). Default: true. */
	eagerDelegation?: boolean;
	/** Point blocked callers at the `wait` tool; false when the session lacks it (subagents). Default: true. */
	waitTool?: boolean;
	/** Enabled preludes; each becomes an `xd://eval/<name>` doc topic, inlined when it asks to be. */
	preludes?: readonly Pick<EvalPreludeDefinition, "name" | "documentation" | "inlineDocumentation">[];
	/**
	 * Inline every doc topic instead of linking `xd://eval/<topic>`. Required
	 * when the session cannot `read` (the only transport for topic docs).
	 */
	inlineTopics?: boolean;
	/** Whether missing runtimes and environments may be provisioned automatically. */
	autoProvision?: boolean;
	/** `task.perCallModel` accepts `model` for eval: advertise it on `agent()`/`workpool()`. Default: false. */
	perCallModel?: boolean;
	/** Operator-owned role selectors and narrowing allowlist; bare values use the current model registry. */
	perCallModelAdvertisement?: PerCallModelAdvertisement;
	/** Canonical and wire names currently accepted by the session tool bridge. */
	toolNames?: readonly string[];
	/** Configured global ceiling for nonzero cell deadlines. */
	maxTimeout?: number;
}

function evalTemplateContext(options: EvalToolDescriptionOptions) {
	const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
	return {
		py: options.py ?? true,
		js: options.js ?? true,
		evalTools: options.evalTools ?? true,
		eagerDelegation: options.eagerDelegation ?? true,
		waitTool: options.waitTool ?? true,
		autoBackgroundEnabled: options.autoBackgroundEnabled ?? false,
		spawns: spawnPolicy.enabled,
		spawnDefaultAgent: spawnPolicy.defaultAgent,
		spawnAllowedAgentsText: spawnPolicy.allowedPromptText,
		autoProvision: options.autoProvision ?? true,
		perCallModel: options.perCallModel ?? false,
		perCallModelAdvertisement: options.perCallModelAdvertisement,
		timeoutMin: TOOL_TIMEOUTS.eval.min,
		timeoutMax: TOOL_TIMEOUTS.eval.max,
		configuredMaxTimeout: options.maxTimeout !== undefined && options.maxTimeout > 0 ? options.maxTimeout : undefined,
		timeoutCeiling: clampTimeout("eval", TOOL_TIMEOUTS.eval.max, options.maxTimeout),
	};
}

/**
 * On-demand eval docs (`topic → markdown`) served at `xd://eval/<topic>`:
 * `judge` (including completion), `helpers`, `agents` (when spawning is allowed),
 * and one per enabled prelude.
 */
export function getEvalDocTopics(options: EvalToolDescriptionOptions = {}): Record<string, string> {
	const context = evalTemplateContext(options);
	const topics: Record<string, string> = {
		judge: prompt.render(evalJudgeTopic, context),
		helpers: prompt.render(evalHelpersTopic, context),
	};
	if (context.spawns) topics.agents = prompt.render(evalAgentsTopic, context);
	for (const prelude of options.preludes ?? []) {
		const doc = prelude.documentation.trim();
		if (doc) topics[prelude.name] = doc;
	}
	return topics;
}

/** Model-facing eval description: core kernel surface plus one pointer per linked doc topic. */
export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const preludes: { name: string; summary: string }[] = [];
	const inlinePreludes: { name: string; documentation: string }[] = [];
	for (const prelude of options.preludes ?? []) {
		if (prelude.inlineDocumentation && !options.inlineTopics) {
			const documentation = prelude.documentation.trim();
			if (documentation) inlinePreludes.push({ name: prelude.name, documentation });
			continue;
		}
		const summary = evalPreludeSummary(prelude);
		if (summary) preludes.push({ name: prelude.name, summary });
	}
	return prompt.render(evalDescription, {
		...evalTemplateContext(options),
		preludes,
		toolNames: options.toolNames,
		inlinePreludes,
		inlineTopics: options.inlineTopics ? Object.values(getEvalDocTopics(options)).join("\n\n") : undefined,
	});
}

export interface EvalToolOptions {
	proxyExecutor?: EvalProxyExecutor;
}

interface ResolvedBackend {
	backend: ExecutorBackend;
	notice?: string;
}

interface ResolvedEvalCell {
	index: number;
	title?: string;
	code: string;
	displayCode: string;
	environmentChange?: boolean;
	filename?: string;
	packages?: string[];
	environment?: "managed" | "project";
	timeoutMs: number;
	reset: boolean;
	resolved: ResolvedBackend;
	/** Stored Python cell this run executes; its run provenance is recorded in the session's cell store. */
	pythonCellId?: number;
}

/** Settlement handed from a managed eval job to its foreground waiter. */
type ManagedEvalJobCompletion =
	| { kind: "completed"; result: AgentToolResult<EvalToolDetails | undefined> }
	| { kind: "failed"; error: unknown };

function uniqueEvalLanguages(cells: ResolvedEvalCell[]): EvalLanguage[] {
	return [...new Set(cells.map(cell => cell.resolved.backend.id))];
}

function detailsNotice(cells: ResolvedEvalCell[]): string | undefined {
	const notices = [
		...new Set(cells.map(cell => cell.resolved.notice).filter((notice): notice is string => Boolean(notice))),
	];
	return notices.length > 0 ? notices.join(" ") : undefined;
}

async function resolveBackend(
	session: ToolSession,
	language: EvalLanguage,
	probeOpts?: BackendProbeOptions,
): Promise<ResolvedBackend> {
	const backends = resolveEvalBackends(session);
	const allowPy = backends.python;
	const allowJs = backends.js;

	if (language === "python") {
		if (!allowPy) throw new ToolError("Python backend is disabled (PI_PY=0 or eval.py = false).");
		const availability = await pythonBackend.checkAvailability(session, probeOpts);
		throwIfAborted(probeOpts?.signal);
		if (!availability.ok) {
			const remedy = allowJs
				? 'Python backend is unavailable in this session. Pass language: "js", or provide a working Python 3.8+ on PATH (or set python.interpreter).'
				: 'Python backend is unavailable in this session. Provide a working Python 3.8+ on PATH (or set python.interpreter) to use language: "py".';
			const reason = availability.reason
				? truncateToWidth(
						replaceTabs(sanitizeText(shortenEmbeddedPaths(availability.reason))).replaceAll("\n", " "),
						TRUNCATE_LENGTHS.RECAP,
					)
				: undefined;
			throw new ToolError(reason ? `${remedy}\n${reason}` : remedy);
		}
		return { backend: pythonBackend };
	}
	if (language !== "js") throw new ToolError(`Unsupported eval language: ${String(language)}`);
	if (!allowJs) throw new ToolError("JavaScript backend is disabled (PI_JS=0 or eval.js = false).");
	return { backend: jsBackend };
}
function formatEvalInputLanguage(value: string): string {
	if (value === "py" || value === "python") return "python";
	if (value === "js" || value === "javascript") return "javascript";
	return value;
}

/** A replay's cell range; unset bounds mean the first and the newest cell. */
function formatReplayRange(from: unknown, through: unknown): string {
	const first = typeof from === "number" ? storedCellIndex(from) : undefined;
	const last = typeof through === "number" ? storedCellIndex(through) : undefined;
	return `${first ?? 1}–${last ?? "latest"}`;
}

/** The stored cells a `run`, `edit`, or `replay` executes; `edit` applies its replacements first. */
function selectStoredCells(store: PythonCellStore, params: EvalToolParams): PythonCellSnapshot[] {
	const cellId = storedCellIndex(params.cell);
	try {
		switch (params.action) {
			case "run":
				if (cellId === undefined) throw new Error('"cell" is required for action "run"');
				return [store.get(cellId)];
			case "edit":
				if (cellId === undefined || !params.edits?.length) {
					throw new Error('"cell" and "edits" are required for action "edit"');
				}
				return [store.edit(cellId, params.edits)];
			case "replay":
				return store.range(storedCellIndex(params.from), storedCellIndex(params.through));
			default:
				throw new Error(`action "${params.action}" does not run stored Python cells`);
		}
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
}

/** `list` output: each cell's exact source, last-run output, and provenance. */
function formatStoredCells(store: PythonCellStore): string {
	const cells = store.list();
	if (cells.length === 0) return `No stored Python cells (kernel epoch ${store.epoch}).`;
	return [
		`Python cells (kernel epoch ${store.epoch}; ${cells.length} stored):`,
		...cells.map(cell => {
			const title = cell.title ? ` · ${cell.title}` : "";
			const output = cell.output?.length ? cell.output : "(no output)";
			return `\n--- cell ${cell.id} [${cell.state}; revision ${cell.revision}; runs ${cell.runCount}]${title} ---\n${cell.code}\n--- output ---\n${output}`;
		}),
	].join("\n");
}

export class EvalTool implements AgentTool<typeof evalSchema> {
	readonly name = "eval";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = isRecord(args) ? args : {};
		const language =
			typeof params.language === "string" ? formatEvalInputLanguage(params.language) : "javascript (default)";
		const lines = [`Language: ${language}`];
		const cell = typeof params.cell === "number" ? params.cell : "?";
		switch (params.action) {
			case "list":
				lines.push("Action: list stored Python cells");
				break;
			case "run":
				lines.push(`Action: rerun Python cell ${cell}`);
				break;
			case "edit":
				lines.push(
					`Action: edit and rerun Python cell ${cell}`,
					`Edits:\n${truncateForPrompt(JSON.stringify(params.edits ?? [], null, 2))}`,
				);
				break;
			case "replay":
				lines.push(`Action: replay Python cells ${formatReplayRange(params.from, params.through)}`);
				break;
			default:
				lines.push(`Code:\n${truncateForPrompt(typeof params.code === "string" ? params.code : "")}`);
		}
		return lines;
	};
	get summary(): string {
		return summarizeEvalLanguages(this.#enabledLanguages());
	}

	readonly loadMode = "essential";
	readonly label = "Eval";
	get description(): string {
		return getEvalToolDescription(this.#descriptionOptions());
	}

	/**
	 * `xd://eval/<topic>` docs follow the live prelude set so a prelude announced
	 * by the mid-session notice is readable before the description catches up.
	 */
	docTopics(): Record<string, string> {
		return getEvalDocTopics({
			...this.#descriptionOptions(),
			preludes: getEnabledEvalPreludes(this.session?.getEvalPreludes?.() ?? []),
		});
	}

	/**
	 * Session state feeding the description. Preludes come from the advertised
	 * snapshot, not the live set, so toggles never rewrite the cached tool prefix.
	 */
	#descriptionOptions(): EvalToolDescriptionOptions {
		const session = this.session;
		if (!session) return {};
		const backends = resolveAdvertisedEvalBackends(session);
		const depthAllowsSpawning = canSpawnAtDepth(
			cfgTaskMaxRecursionDepth.get(session.settings),
			session.taskDepth ?? 0,
		);
		const perCallModel = perCallModelEnabled(session.settings, "eval");
		return {
			py: backends.python,
			js: backends.js,
			spawns: depthAllowsSpawning ? (session.getSessionSpawns?.() ?? "*") : false,
			autoBackgroundEnabled: cfgEvalAutoBackgroundEnabled.get(session.settings),
			evalTools: cfgEvalToolsEnabled.get(session.settings),
			eagerDelegation: sessionDelegationBias(session) === "eager",
			waitTool: hasWaitTool(session),
			preludes: this.#advertisedPreludes(session),
			inlineTopics: session.isToolActive?.("read") === false,
			autoProvision: cfgEvalAutoProvision.get(session.settings),
			perCallModel,
			perCallModelAdvertisement: perCallModel
				? getPerCallModelAdvertisement(session.settings, session.getActiveModel?.(), session.modelRegistry)
				: undefined,
			toolNames: session.getAdvertisedEvalToolNames?.(),
			maxTimeout: cfgToolsMaxTimeout.get(session.settings),
		};
	}

	/** Frozen advertised snapshot; sessions without a snapshot owner advertise the live set. */
	#advertisedPreludes(session: ToolSession): readonly EvalPreludeDefinition[] {
		return session.getAdvertisedEvalPreludes?.() ?? getEnabledEvalPreludes(session.getEvalPreludes?.() ?? []);
	}

	/** Only syntax not obvious from the field schema; filtered by enabled language. */
	static readonly #examples: readonly ToolExample<typeof evalSchema.infer>[] = [
		{
			caption: "Load a script with spaces without echoing its source",
			call: { language: "py", code: '%load "scripts/my setup.py"' },
		},
		{
			caption: "Rerun stored Python cell 2 without resending its source",
			call: { action: "run", language: "py", cell: 2 },
		},
		{
			caption: "Edit stored Python cell 2, then run the revision",
			call: {
				action: "edit",
				language: "py",
				cell: 2,
				edits: [{ old: "limit = 10", new: "limit = 50" }],
			},
		},
		{
			caption: "Reset the kernel, then replay stored Python cells 1-3 in order",
			call: { action: "replay", language: "py", from: 1, through: 3, reset: true },
		},
	];
	get examples(): readonly ToolExample<typeof evalSchema.infer>[] {
		const langs = new Set(this.#enabledLanguages());
		return EvalTool.#examples.filter(ex => "call" in ex && langs.has(ex.call.language));
	}
	get parameters(): typeof evalSchema {
		const langs = this.#enabledLanguages();
		const maxTimeout = this.session ? cfgToolsMaxTimeout.get(this.session.settings) : undefined;
		if (langs.length === EVAL_LANGUAGE_ORDER.length && !maxTimeout) return evalSchema;
		const key = `${langs.join(",")}:${maxTimeout ?? 0}`;
		if (this.#paramsKey !== key) {
			this.#cachedParams = buildEvalSchema(langs, maxTimeout);
			this.#paramsKey = key;
		}
		return this.#cachedParams ?? evalSchema;
	}
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly intent = (args: Partial<typeof evalSchema.infer>): string | undefined => {
		const title = typeof args.title === "string" ? args.title : undefined;
		if (title) return title;
		const cell = typeof args.cell === "number" ? args.cell : "?";
		switch (args.action) {
			case "list":
				return "listing Python cells";
			case "run":
				return `rerunning Python cell ${cell}`;
			case "edit":
				return `editing Python cell ${cell}`;
			case "replay":
				return `replaying Python cells ${formatReplayRange(args.from, args.through)}`;
			default: {
				const language = typeof args.language === "string" ? formatEvalInputLanguage(args.language) : "javascript";
				return `running ${language}`;
			}
		}
	};

	readonly speculation: ToolSpeculationPolicy = {
		stream: {
			open: async context => {
				if (!this.session) return undefined;
				// The coordinator also exists for `task.speculativeLaunch`; eval shadows
				// belong to the read/eval speculation slice only.
				if (!cfgToolsSpeculativeExecutionEnabled.get(this.session.settings)) return undefined;
				if (cfgEvalAutoBackgroundEnabled.get(this.session.settings)) return undefined;
				const parentToolCallId = context.parentToolCallId;
				const cell = new EvalShadowCellSession({
					coordinator: context.coordinator,
					parentToolCallId,
					session: this.session,
					cwd: this.session.cwd,
					sessionId: this.session.getEvalSessionId?.() ?? defaultEvalSessionId(this.session),
					kernelOwnerId: this.session.getEvalKernelOwnerId?.() ?? undefined,
					onDiscard: () => {
						if (this.#shadowCells.get(parentToolCallId) === cell) this.#shadowCells.delete(parentToolCallId);
					},
				});
				this.#shadowCells.set(parentToolCallId, cell);
				return cell;
			},
		},
	};
	readonly #proxyExecutor?: EvalProxyExecutor;

	#paramsKey?: string;
	#cachedParams?: typeof evalSchema;
	readonly #shadowCells = new Map<string, EvalShadowCellSession>();
	readonly #environmentModes: Partial<Record<EvalLanguage, "managed" | "project">> = {};

	/**
	 * Languages enabled for this session, in display order. Detached tools (no
	 * session) fall back to the shipped defaults (py/js). Synchronous reads use
	 * only definitive memoized probes, never blocking runtime discovery.
	 */
	#enabledLanguages(): EvalLanguageToken[] {
		return this.session ? enabledEvalLanguages(resolveAdvertisedEvalBackends(this.session)) : ["py", "js"];
	}

	constructor(
		private readonly session: ToolSession | null,
		options?: EvalToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
	}

	async execute(
		toolCallId: string,
		params: typeof evalSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		const result = await this.#execute(toolCallId, params, signal, onUpdate, ctx);
		// `list` must return exact cell source, so Spotlight never rewrites it.
		if (!this.session || params.action === "list") return result;
		// A stored-cell action ignores any `code` sent; its cells carry the stored source it ran.
		const source = isStoredCellAction(params.action)
			? result.details?.cells?.map(cell => cell.code).join("\n\n")
			: params.code;
		if (source === undefined) return result;
		// Output shaped by the session's Spotlight experiment no longer matches the sink's line ranges.
		return shapeToolResult(
			this.session,
			toolCallId,
			{ tool: "eval", command: source, source, exitCode: result.isError ? 1 : 0 },
			result,
			signal,
			{ dropTruncation: true },
		);
	}

	async #execute(
		_toolCallId: string,
		params: typeof evalSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		const validated = evalSchema(params);
		if (validated instanceof type.errors) {
			throw new ToolError(`Validation failed for tool "eval": ${validated.summary}`);
		}
		params = validated;

		const shadowCell = this.#shadowCells.get(_toolCallId);
		this.#shadowCells.delete(_toolCallId);
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("Eval tool requires a session when not using proxy executor");
		}
		const session = this.session;
		const storedAction = isStoredCellAction(params.action);
		if (shadowCell && storedAction) {
			await shadowCell.discard("stored-cell eval actions run stored source");
		}
		if (params.action === "list") {
			return {
				content: [{ type: "text", text: formatStoredCells(getPythonCellStore(session)) }],
				details: undefined,
			};
		}
		// Every Python cell, new or stored, records its run; the schema limits stored actions to Python.
		const pythonCellStore = params.language === "py" ? getPythonCellStore(session) : undefined;
		const excludeWebP = webpExclusionForModel(session.getActiveModel?.());

		const cellLanguage: EvalLanguage = params.language === "py" ? "python" : params.language;
		const toTimeoutSec = (timeout: number | undefined): number =>
			timeout === 0 ? 0 : clampTimeout("eval", timeout, cfgToolsMaxTimeout.get(session.settings));
		// Bound backend discovery by the eval cell's own timeout and abort signal:
		// the cell IdleTimeout is armed only later in #runCells, so a hung runtime
		// probe would otherwise wedge the whole turn (issue #9466).
		const cellTimeoutSec = toTimeoutSec(params.timeout);
		const cellTimeoutMs = cellTimeoutSec * 1000;
		const timeoutNotice =
			params.timeout !== undefined && params.timeout !== cellTimeoutSec
				? `Eval timeout clamped from ${params.timeout}s to ${cellTimeoutSec}s.`
				: undefined;
		if (timeoutNotice) {
			onUpdate?.({
				content: [{ type: "text", text: timeoutNotice }],
				details: { language: cellLanguage, languages: [cellLanguage], notice: timeoutNotice },
			});
		}
		const resolved = await resolveBackend(session, cellLanguage, { signal, timeoutMs: cellTimeoutMs });
		resolved.notice = [timeoutNotice, resolved.notice].filter(Boolean).join(" ") || undefined;
		const projectEnvironment = this.#environmentModes[cellLanguage] === "project" ? "project" : undefined;
		const cells: ResolvedEvalCell[] = [];
		if (storedAction) {
			const storedCells = selectStoredCells(getPythonCellStore(session), params);
			for (const [i, cell] of storedCells.entries()) {
				// Stored source is what the model wrote: a `%load` cell rereads its file on every run.
				const source = await prepareEvalSource({ language: "py", code: cell.code }, session, signal);
				cells.push({
					index: i,
					title: params.action === "replay" ? cell.title : (params.title ?? cell.title),
					...source,
					displayCode: cell.code,
					environment: projectEnvironment,
					timeoutMs: toTimeoutSec(params.timeout ?? cell.timeout) * 1000,
					reset: i === 0 && (params.reset ?? false),
					resolved,
					pythonCellId: cell.id,
				});
			}
		} else {
			if (params.code === undefined) throw new ToolError('"code" is required for a new eval cell');
			const code = params.code;
			const source = await prepareEvalSource({ language: params.language, code }, session, signal);
			if (shadowCell && (source.filename || source.packages?.length || source.environment)) {
				await shadowCell.discard("file-backed or environment-changing eval requires authoritative execution");
			}
			const storedCell = pythonCellStore?.append(code, { title: params.title, timeout: params.timeout });
			cells.push({
				index: 0,
				title: params.title,
				...source,
				displayCode: code,
				environmentChange: source.environment !== undefined,
				environment: source.environment ?? projectEnvironment,
				timeoutMs: cellTimeoutMs,
				reset: params.reset ?? false,
				resolved,
				pythonCellId: storedCell?.id,
			});
		}
		const languages = uniqueEvalLanguages(cells);
		const notice = detailsNotice(cells);
		const sessionAbortController = new AbortController();
		const emitToolUpdate = onUpdate
			? (text: string, details: EvalToolDetails): void => {
					onUpdate({ content: [{ type: "text", text }], details });
				}
			: undefined;
		const run = async (
			runSignal: AbortSignal | undefined,
			emitUpdate: ((text: string, details: EvalToolDetails) => void) | undefined,
			foreground: () => boolean,
		): Promise<AgentToolResult<EvalToolDetails | undefined>> => {
			// Re-check the retained namespace against the streamed planning snapshot:
			// timers, background work, or concurrent session users may have changed
			// it after the speculative children started. On mismatch the children
			// were projected from stale state, so discard the session and run the
			// cell without it (claims then miss and execution is ordinary).
			let activeShadowCell = shadowCell;
			const snapshotToken = shadowCell?.snapshotToken;
			if (shadowCell && snapshotToken) {
				const tokenIsPython = snapshotToken.language === "py";
				let current = tokenIsPython === (cellLanguage === "python");
				if (current) {
					current = await shadowCell.verifySnapshotCurrent().catch(() => false);
				}
				if (!current) {
					await shadowCell.discard("retained eval state changed after shadow planning").catch(() => undefined);
					activeShadowCell = undefined;
				}
			}
			const execution = runWithEvalShadowCell(activeShadowCell, () =>
				this.#runCells({
					session,
					cells,
					languages,
					notice,
					excludeWebP,
					signal: runSignal,
					sessionAbortController,
					pythonCellStore,
					emitUpdate,
					foreground,
				}),
			);
			return session.trackEvalExecution?.(execution, sessionAbortController) ?? execution;
		};

		const autoBgManager = session.asyncJobManager;
		// At the running-job cap, fall through to direct foreground execution
		// instead of failing every eval call until a slot frees up.
		if (!cfgEvalAutoBackgroundEnabled.get(session.settings) || !autoBgManager || autoBgManager.atCapacity) {
			return await run(signal, emitToolUpdate, () => true);
		}

		const thresholdMs = Math.max(0, Math.floor(cfgEvalAutoBackgroundThresholdMs.get(session.settings)));
		// The wait budget mirrors #runCells' clamped cell timeout. The cell budget
		// is runtime work (it pauses across agent()/tool bridge calls), so a cell
		// can legitimately outlive it in wall time — exactly the case
		// backgrounding exists for.
		const clampedCellTimeoutSec = cells[0].timeoutMs === 0 ? undefined : cells[0].timeoutMs / 1000;
		const autoBackgroundWaitMs = resolveAutoBackgroundWaitMs(
			thresholdMs,
			clampedCellTimeoutSec === undefined ? undefined : clampedCellTimeoutSec * 1000,
		);
		const startBackgrounded = autoBackgroundWaitMs === 0;

		const rawLabel =
			(cells.length === 1
				? cells[0].title?.trim() || cells[0].displayCode.trim().split("\n", 1)[0]
				: params.title?.trim() || `replay ${cells.length} cells`) || "eval cell";
		const label = rawLabel.length > 120 ? `${rawLabel.slice(0, 117)}...` : rawLabel;

		let latestText = notice ?? "";
		let latestDetails: EvalToolDetails | undefined;
		let backgrounded = startBackgrounded;
		const completion = Promise.withResolvers<ManagedEvalJobCompletion>();

		const jobId = autoBgManager.register(
			"eval",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				// Once backgrounded, the job's frames carry `details.async` so the call's
				// card keeps filling and settles with the job.
				const showJobFrame = (
					text: string,
					details: EvalToolDetails | undefined,
					state: "running" | "completed" | "failed" | "cancelled",
				): void => {
					// Replies are drawn from the frames of the call while it waits and from its result;
					// a job frame repeating them after the call returned would draw them again.
					if (backgrounded) {
						emitToolUpdate?.(text, { ...details, replies: undefined, async: { state, jobId, type: "eval" } });
					}
				};
				try {
					const result = await run(
						runSignal,
						(text, details) => {
							latestText = text;
							latestDetails = details;
							void reportProgress(text, { async: { state: "running", jobId, type: "eval" } });
							if (backgrounded) showJobFrame(text, details, "running");
							else emitToolUpdate?.(text, details);
						},
						() => !backgrounded,
					);
					const finalText =
						(result.content.find(block => block.type === "text")?.text ?? "") +
						formatOutputNotice(result.details?.meta);
					latestText = finalText;
					latestDetails = result.details;
					// Hand the full result (images included) to the foreground waiter
					// before deciding the job's terminal state.
					completion.resolve({ kind: "completed", result });
					if (result.isError === true) {
						// A failed, cancelled, or timed-out cell is a completed execution
						// that errored. Re-enter the failure path so the job manager
						// records it as failed and delivers the error text.
						throw new ToolError(finalText || "Eval cell failed");
					}
					showJobFrame(finalText, result.details, "completed");
					await reportProgress(finalText, {
						...result.details,
						async: { state: "completed", jobId, type: "eval" },
					});
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					showJobFrame(message, latestDetails, runSignal.aborted ? "cancelled" : "failed");
					await reportProgress(message, {
						...latestDetails,
						async: { state: "failed", jobId, type: "eval" },
					});
					throw error;
				}
			},
			{
				ownerId: session.getAgentId?.() ?? undefined,
				foreground: !startBackgrounded,
				intent: session.getToolCallIntent?.(_toolCallId),
			},
		);

		const backgroundStartResult = (extraNotice?: string) =>
			this.#buildBackgroundStartResult(
				jobId,
				cells,
				languages,
				notice,
				latestText,
				latestDetails,
				clampedCellTimeoutSec,
				extraNotice,
			);
		if (startBackgrounded) {
			return backgroundStartResult();
		}
		// The job was registered as foreground-backed: hidden from listings and
		// delivery-suppressed until backgroundJob() promotes it, so a cell
		// finishing within the wait never surfaces as a background job.
		const waitResult = await raceJobSettlement(
			completion.promise,
			autoBackgroundWaitMs,
			signal,
			ctx?.toolCall?.steeringSignal,
		);
		if (waitResult.kind === "completed") {
			autoBgManager.releaseForegroundJob(jobId);
			return waitResult.result;
		}
		if (waitResult.kind === "failed") {
			autoBgManager.releaseForegroundJob(jobId);
			throw waitResult.error;
		}
		if (waitResult.kind === "aborted") {
			autoBgManager.cancel(jobId);
			autoBgManager.releaseForegroundJob(jobId);
			throw new ToolAbortError(latestText || "Eval cell aborted");
		}
		backgrounded = true;
		autoBgManager.backgroundJob(jobId);
		// "steer": a queued user/peer message arrived mid-wait — background the
		// cell (it keeps running) so the message injects promptly.
		const steerNotice =
			waitResult.kind === "steer"
				? "Backgrounded early to handle an incoming message; the cell keeps running."
				: undefined;
		return backgroundStartResult(steerNotice);
	}

	/**
	 * Tool result returned when a cell converts into a background job: the live
	 * output tail plus the background notice stating the cell's deadline
	 * (`timeoutSec`, `undefined` when disabled), with details carrying the running
	 * cell snapshot and the async job marker the transcript renderer keys on.
	 */
	#buildBackgroundStartResult(
		jobId: string,
		cells: ResolvedEvalCell[],
		languages: EvalLanguage[],
		notice: string | undefined,
		previewText: string,
		latestDetails: EvalToolDetails | undefined,
		timeoutSec: number | undefined,
		extraNotice?: string,
	): AgentToolResult<EvalToolDetails> {
		// latestDetails snapshots are per-update copies (buildUpdateDetails), so
		// tagging the async marker on cannot leak into later job progress.
		const details: EvalToolDetails = latestDetails ?? {
			language: languages[0],
			languages,
			cells: cells.map(cell => ({
				index: cell.index,
				title: cell.title,
				code: cell.displayCode,
				language: cell.resolved.backend.id,
				output: previewText,
				status: "running" as const,
			})),
		};
		if (notice) details.notice ??= notice;
		details.async = { state: "running", jobId, type: "eval" };
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (notice && !trimmedPreview.startsWith(notice)) lines.push(notice, "");
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (extraNotice) {
			lines.push(extraNotice, "");
		}
		lines.push(formatBackgroundNotice(jobId, timeoutSec));
		return { content: [{ type: "text", text: lines.join("\n") }], details };
	}

	/**
	 * Execute the resolved cells against their backends, streaming tail/detail
	 * updates through `emitUpdate`. Runs identically in the foreground path and
	 * inside a managed background job (which passes the job's own signal).
	 */
	async #runCells(options: {
		session: ToolSession;
		cells: ResolvedEvalCell[];
		languages: EvalLanguage[];
		notice: string | undefined;
		excludeWebP: boolean | undefined;
		signal: AbortSignal | undefined;
		sessionAbortController: AbortController;
		/** Records each stored Python cell's run; set for Python calls. */
		pythonCellStore: PythonCellStore | undefined;
		emitUpdate?: (text: string, details: EvalToolDetails) => void;
		/** Whether the call still waits on the cells; `out://` replies are drawn only then. */
		foreground: () => boolean;
	}): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		const {
			session,
			cells,
			languages,
			notice,
			excludeWebP,
			signal,
			sessionAbortController,
			pythonCellStore,
			emitUpdate,
			foreground,
		} = options;
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		let updateTimer: NodeJS.Timeout | undefined;
		const finalizeOutput = async (): Promise<OutputSummary | undefined> => {
			if (outputDumped || !outputSink) return outputSummary;
			outputSummary = await outputSink.dump();
			outputDumped = true;
			return outputSummary;
		};
		try {
			if (signal?.aborted) {
				throw new ToolAbortError();
			}
			session.assertEvalExecutionAllowed?.();

			const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);
			const images: ImageContent[] = [];
			const callStatus: StatusEventLog = {};
			const replies: string[] = [];

			const cellResults: EvalCellResult[] = cells.map(cell => ({
				index: cell.index,
				title: cell.title,
				code: cell.displayCode,
				language: cell.resolved.backend.id,
				output: "",
				status: "pending",
			}));
			const cellOutputs: string[] = [];
			// The cell currently inside backend.execute(). Streamed stdout is
			// appended to its rendered `output` live so a long-running cell (e.g. a
			// sleep loop) shows progress instead of nothing until it returns. Its
			// live output is the suffix of the aggregate `tailBuffer` streamed since
			// the cell started (`chars` UTF-16 units), sliced only when an update is
			// emitted; on completion the authoritative `cellResult.output` (below)
			// overwrites this live tail.
			let activeLiveCell: { result: EvalCellResult; chars: number } | undefined;

			const buildUpdateDetails = (): EvalToolDetails => {
				const details: EvalToolDetails = {
					language: languages[0],
					languages,
					cells: cellResults.map(cell => ({
						...cell,
						statusEvents: cell.statusEvents ? [...cell.statusEvents] : undefined,
					})),
				};
				if (images.length > 0) {
					details.images = images;
				}
				if (callStatus.statusEvents) {
					details.statusEvents = callStatus.statusEvents;
					details.statusEventsElided = callStatus.statusEventsElided;
				}
				if (replies.length > 0) {
					details.replies = [...replies];
				}
				if (notice) {
					details.notice = notice;
				}
				return details;
			};

			// Stdout chunks and status events can arrive hundreds of times per
			// second; each emitted update rebuilds details and re-renders the card.
			// Coalesce to one trailing update per interval — the snapshot is taken
			// at flush time, so the newest state wins.
			const flushUpdate = () => {
				if (!updateTimer) return;
				clearTimeout(updateTimer);
				updateTimer = undefined;
				const text = tailBuffer.text();
				if (activeLiveCell) {
					const { chars } = activeLiveCell;
					activeLiveCell.result.output = chars >= text.length ? text : text.slice(text.length - chars);
				}
				emitUpdate?.(notice ? `${notice}\n\n${text}` : text, buildUpdateDetails());
			};
			const pushUpdate = () => {
				if (!emitUpdate || updateTimer) return;
				updateTimer = setTimeout(flushUpdate, LIVE_UPDATE_INTERVAL_MS);
			};
			// What bridged calls write to `out://`. Each frame carries the replies so far and the transcript
			// draws the new ones; once the call returns (backgrounded), nothing would draw them.
			const onReply = (text: string): void => {
				if (!foreground()) {
					throw new ToolError("out:// replies reach the user only while the eval cell runs in the foreground.");
				}
				replies.push(text);
				// Publish now rather than on the coalescing timer, so a cell backgrounded right after still carries it.
				pushUpdate();
				flushUpdate();
			};

			const sessionFile = session.getSessionFile?.() ?? undefined;
			const kernelOwnerId = session.getEvalKernelOwnerId?.() ?? undefined;
			const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.("eval")) ?? {};
			session.assertEvalExecutionAllowed?.();
			outputSink = new OutputSink({
				artifactPath,
				artifactId,
				headBytes: resolveOutputSinkHeadBytes(session.settings),
				artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(session.settings),
				maxColumns: resolveOutputMaxColumns(session.settings),
				onChunk: chunk => {
					tailBuffer.append(chunk);
					if (activeLiveCell) activeLiveCell.chars += chunk.length;
					pushUpdate();
				},
			});
			const sessionId = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);

			for (let i = 0; i < cells.length; i++) {
				const cell = cells[i];
				const backend = cell.resolved.backend;
				// The per-cell `timeout` is a budget on the cell runtime's *own*
				// work. Host-side waits on `agent()`/`completion()` handles,
				// `tool.task()`/`tool.wait()`, and browser/computer preludes suspend
				// that budget entirely and restart a fresh timeout window when control
				// returns to the active backend runtime. Compute, stdout, `log()`/`phase()`, and
				// ordinary tool calls all count against the budget. The watchdog drives
				// `combinedSignal`; we pass no wall-clock deadline downstream so the
				// backends never arm a competing fixed timer.
				const idleTimeoutMs = cell.timeoutMs === 0 ? undefined : cell.timeoutMs;
				const idle = idleTimeoutMs === undefined ? undefined : new IdleTimeout(idleTimeoutMs);
				const combinedSignal =
					signal && idle
						? AbortSignal.any([signal, idle.signal, sessionAbortController.signal])
						: signal
							? AbortSignal.any([signal, sessionAbortController.signal])
							: idle
								? AbortSignal.any([idle.signal, sessionAbortController.signal])
								: sessionAbortController.signal;

				const cellResult = cellResults[i];
				cellResult.status = "running";
				cellResult.output = "";
				cellResult.views = undefined;
				cellResult.statusEvents = undefined;
				cellResult.statusEventsElided = undefined;
				cellResult.exitCode = undefined;
				cellResult.durationMs = undefined;
				activeLiveCell = { result: cellResult, chars: 0 };
				pushUpdate();

				const startTime = Date.now();
				// A reset wipes the kernel, so every earlier stored run now belongs to a previous kernel.
				if (cell.reset) pythonCellStore?.beginKernelEpoch();
				const runToken = cell.pythonCellId === undefined ? undefined : pythonCellStore?.startRun(cell.pythonCellId);
				const finishStoredRun = (status: Exclude<PythonCellRunStatus, "running">, output?: string): void => {
					if (runToken) pythonCellStore?.finishRun(runToken, status, output);
				};
				let result: ExecutorBackendResult;
				try {
					result = await backend.execute(cell.code, {
						cwd: session.cwd,
						sessionId,
						sessionFile: sessionFile ?? undefined,
						kernelOwnerId,
						signal: combinedSignal,
						session,
						idleTimeoutMs,
						reset: cell.reset,
						filename: cell.filename,
						packages: cell.packages,
						environment: cell.environment,
						onChunk: chunk => {
							outputSink!.push(chunk);
						},
						onReply,
						onStatus: event => {
							if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
								idle?.pause();
								return;
							}
							if (event.op === EVAL_TIMEOUT_RESUME_OP) {
								idle?.resume();
								return;
							}
							recordStatusEvent(cellResult, {
								...event,
								resolvedThinkingLevel: parseConfiguredThinkingLevel(
									typeof event.resolvedThinkingLevel === "string" ? event.resolvedThinkingLevel : undefined,
								),
							});
							pushUpdate();
						},
					});
				} catch (error) {
					finishStoredRun(combinedSignal.aborted ? "cancelled" : "error");
					throw error;
				} finally {
					idle?.dispose();
					// Publish the cell's last live state before its final output replaces it.
					flushUpdate();
					activeLiveCell = undefined;
				}
				const durationMs = Date.now() - startTime;

				const cellStatus: StatusEventLog = {};
				const cellViews: EvalViewEntry[] = [];
				const cellImageNotes: string[] = [];
				for (const output of result.displayOutputs) {
					if (output.type === "view") {
						// Views only restyle text already in stdout; dropped ones still show as that text.
						if (cellViews.length >= MAX_VIEWS_PER_CELL) continue;
						if (JSON.stringify(output.view).length > MAX_VIEW_JSON_CHARS) continue;
						const text = sanitizeText(output.text).trim();
						if (text) cellViews.push({ text, view: output.view });
					}
					if (output.type === "image") {
						// Computer frames have a matching native input coordinate space. Generic
						// display resizing must not change it; provider-boundary safety still applies.
						if (output.detail === "original") {
							images.push(output);
							continue;
						}
						const resized = await resizeImage(output, { excludeWebP });
						const data = resized.data;
						const image: ImageContent = {
							type: "image",
							data,
							mimeType: resized.mimeType,
							...(output.detail === undefined ? {} : { detail: output.detail }),
							// Remote references are valid only while the bytes remain unchanged.
							...(data === output.data && resized.mimeType === output.mimeType
								? { url: output.url, providerFile: output.providerFile }
								: {}),
						};
						images.push(image);
						const dimensionNote = formatDimensionNote(resized);
						if (dimensionNote) {
							cellImageNotes.push(`image ${cellImageNotes.length + 1}: ${dimensionNote}`);
						}
					}
					if (output.type === "status") {
						const event: EvalStatusEvent = {
							...output.event,
							resolvedThinkingLevel: parseConfiguredThinkingLevel(
								typeof output.event.resolvedThinkingLevel === "string"
									? output.event.resolvedThinkingLevel
									: undefined,
							),
						};
						recordStatusEvent(callStatus, event);
						recordStatusEvent(cellStatus, event);
					}
				}

				const runtimeOutput = result.output.trim();
				const stdoutTrimmed =
					cell.environmentChange && result.exitCode === 0
						? `${runtimeOutput ? `${runtimeOutput}\n` : ""}Eval environment: ${cell.environment}.`
						: runtimeOutput;
				const imageText = cellImageNotes.join("\n");
				const cellOutput = [stdoutTrimmed, imageText].filter(Boolean).join("\n\n");
				finishStoredRun(
					result.cancelled
						? "cancelled"
						: result.exitCode !== 0 && result.exitCode !== undefined
							? "error"
							: "complete",
					cellOutput,
				);
				cellResult.output = cellOutput;
				cellResult.views = cellViews.length > 0 ? placeViews(cellOutput, cellViews) : undefined;
				cellResult.exitCode = result.exitCode;
				cellResult.durationMs = durationMs;
				cellResult.statusEvents = cellStatus.statusEvents;
				cellResult.statusEventsElided = cellStatus.statusEventsElided;

				if (cellOutput) {
					cellOutputs.push(cellOutput);
					tailBuffer.append(cellOutput);
				}

				if (result.cancelled || (result.exitCode !== 0 && result.exitCode !== undefined)) {
					cellResult.status = "error";
					pushUpdate();
					const combinedOutput = cellOutputs.join("\n\n");
					const exitLine = `Command exited with code ${result.exitCode}`;
					const outputText = result.cancelled
						? combinedOutput || result.output || "Command aborted"
						: combinedOutput
							? `${combinedOutput}\n\n${exitLine}`
							: exitLine;

					const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						cells: cellResults,
						statusEvents: callStatus.statusEvents,
						statusEventsElided: callStatus.statusEventsElided,
						replies: replies.length > 0 ? replies : undefined,
						isError: true,
					};
					if (notice) details.notice = notice;

					return toolResult(details)
						.content([{ type: "text", text: notice ? `${notice}\n\n${outputText}` : outputText }, ...images])
						.truncationFromSummary(summaryForMeta, { direction: "tail" })
						.error()
						.done();
				}

				if (cell.environmentChange && cell.environment) {
					this.#environmentModes[backend.id] = cell.environment;
				}
				cellResult.status = "complete";
				pushUpdate();
			}

			const combinedOutput = cellOutputs.join("\n\n");
			const hasImages = images.length > 0;
			const outputText =
				combinedOutput ||
				(hasImages ? `(${images.length} image${images.length === 1 ? "" : "s"}; no text output)` : "(no output)");
			const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);

			const details: EvalToolDetails = {
				language: languages[0],
				languages,
				cells: cellResults,
				statusEvents: callStatus.statusEvents,
				statusEventsElided: callStatus.statusEventsElided,
				replies: replies.length > 0 ? replies : undefined,
			};
			if (notice) details.notice = notice;

			return toolResult(details)
				.content([{ type: "text", text: notice ? `${notice}\n\n${outputText}` : outputText }, ...images])
				.truncationFromSummary(summaryForMeta, { direction: "tail" })
				.done();
		} finally {
			clearTimeout(updateTimer);
			if (!outputDumped) {
				try {
					await finalizeOutput();
				} catch {}
			}
		}
	}
}

/**
 * `views` with each `text` replaced by the span of `output` that shows it, which renderers look
 * for: the column cap cuts long printed lines to a head and `…`. Views whose text does not show
 * keep theirs.
 */
function placeViews(output: string, views: readonly EvalViewEntry[]): EvalViewEntry[] {
	let cursor = 0;
	return views.map(entry => {
		const span = findColumnCapped(output, entry.text, cursor);
		if (!span) return entry;
		cursor = span.end;
		return { text: output.slice(span.start, span.end), view: entry.view };
	});
}

async function summarizeFinal(
	combinedOutput: string,
	finalizeOutput: () => Promise<OutputSummary | undefined>,
): Promise<OutputSummary> {
	const rawSummary = (await finalizeOutput()) ?? {
		output: "",
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	};
	const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
	const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
	const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
	const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
	return {
		output: combinedOutput,
		truncated: rawSummary.truncated,
		totalLines: outputLines + missingLines,
		totalBytes: outputBytes + missingBytes,
		outputLines,
		outputBytes,
		artifactId: rawSummary.artifactId,
		artifactElidedBytes: rawSummary.artifactElidedBytes,
		artifactError: rawSummary.artifactError,
		columnDroppedBytes: rawSummary.columnDroppedBytes,
		columnTruncatedLines: rawSummary.columnTruncatedLines,
		columnTruncatedRange: rawSummary.columnTruncatedRange,
		columnMax: rawSummary.columnMax,
	};
}
