import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, getEvalToolDescription } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(opts: {
	spawns?: string | null;
	backends?: Record<string, boolean>;
	preludes?: () => readonly EvalPreludeDefinition[];
}): ToolSession {
	const settings = Settings.isolated();
	for (const [key, value] of Object.entries(opts.backends ?? {})) settings.set(key as never, value);
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => opts.spawns ?? "*",
		...(opts.preludes ? { getEvalPreludes: opts.preludes } : {}),
		settings,
	} as unknown as ToolSession;
}

interface WireProperty {
	const?: string;
	enum?: string[];
	description?: string;
}

interface EvalWireSchema {
	type?: string;
	anyOf?: unknown[];
	properties?: {
		action?: WireProperty;
		language?: WireProperty;
		code?: WireProperty;
	};
}

/** Pull the provider-facing eval fields from its single root object schema. */
function wireEvalFields(tool: EvalTool): {
	rootType?: string;
	hasRootUnion: boolean;
	languages: string[];
	actions: string[];
	languageDescription?: string;
	codeDescription?: string;
} {
	const wire = toolWireSchema(tool as unknown as AiTool) as EvalWireSchema;
	const language = wire.properties?.language;
	const action = wire.properties?.action;
	const languages = Array.isArray(language?.enum)
		? [...language.enum].sort()
		: typeof language?.const === "string"
			? [language.const]
			: [];
	const actions = Array.isArray(action?.enum)
		? [...action.enum]
		: typeof action?.const === "string"
			? [action.const]
			: [];
	return {
		rootType: wire.type,
		hasRootUnion: Array.isArray(wire.anyOf),
		languages,
		actions,
		languageDescription: language?.description,
		codeDescription: wire.properties?.code?.description,
	};
}

describe("eval tool description", () => {
	it("advertises agent() when spawns are allowed", () => {
		const text = getEvalToolDescription({ py: true, js: true, spawns: true });
		expect(text).toContain("agent(prompt");
	});

	it("omits agent() when the session forbids spawning", () => {
		// Subagents with spawns: undefined (resolved to "") cannot launch tasks.
		// The prelude doc must not promise a helper that always throws.
		const text = getEvalToolDescription({ py: true, js: true, spawns: false });
		expect(text).not.toContain("agent(prompt");
	});

	it("EvalTool description reflects spawn policy from the session", () => {
		const wildcard = new EvalTool(makeSession({ spawns: "*" })).description;
		const denied = new EvalTool(makeSession({ spawns: "" })).description;
		expect(wildcard).toContain("agent(prompt");
		expect(denied).not.toContain("agent(prompt");
	});

	it("hides eval-defined tool guidance when eval.tools.enabled is off", () => {
		const enabled = getEvalToolDescription({ evalTools: true });
		const disabled = getEvalToolDescription({ evalTools: false });
		expect(enabled).toContain("@tool");
		expect(enabled).toContain("tools?=None");
		expect(disabled).not.toContain("@tool");
		expect(disabled).not.toContain("tools?=None");
	});

	it("composes only current enabled prelude documentation", () => {
		let enabled = true;
		const prelude: EvalPreludeDefinition = {
			name: "fixture",
			documentation: "CURRENT PRELUDE DOCUMENTATION",
			javascript: "",
			python: "",
			exports: [],
			enabled: () => enabled,
			async invoke() {
				return { content: [] };
			},
		};
		const tool = new EvalTool(makeSession({ preludes: () => [prelude] }));
		expect(tool.description).toContain("CURRENT PRELUDE DOCUMENTATION");
		enabled = false;
		expect(tool.description).not.toContain("CURRENT PRELUDE DOCUMENTATION");
	});

	it("documents stored Python cells only when Python is enabled", () => {
		const python = getEvalToolDescription({ py: true, js: true });
		expect(python).toContain("Every ordinary Python call stores one stable, 1-based cell.");
		expect(python).toContain('Source changes → `action: "edit"`');
		expect(python).toContain("`replay` runs an inclusive range in order");

		const javascript = getEvalToolDescription({ py: false, js: true });
		expect(javascript).not.toContain("Python cells:");
	});
});

describe("eval tool dynamic schema", () => {
	// resolveEvalBackends lets PI_* env flags override settings; neutralize them per-test
	// so the schema is driven purely by the isolated settings (and restore to avoid leaks).
	const EVAL_ENV_FLAGS = ["PI_PY", "PI_JS"] as const;
	let savedEnv: Record<string, string | undefined>;
	beforeEach(() => {
		savedEnv = {};
		for (const flag of EVAL_ENV_FLAGS) {
			savedEnv[flag] = Bun.env[flag];
			delete Bun.env[flag];
		}
	});
	afterEach(() => {
		for (const flag of EVAL_ENV_FLAGS) {
			const prior = savedEnv[flag];
			if (prior === undefined) delete Bun.env[flag];
			else Bun.env[flag] = prior;
		}
	});

	it("advertises one provider-compatible object schema with Python cell actions", () => {
		const tool = new EvalTool(makeSession({}));
		const fields = wireEvalFields(tool);
		expect(fields.rootType).toBe("object");
		expect(fields.hasRootUnion).toBe(false);
		expect(fields.languages).toEqual(["js", "py"]);
		expect(fields.languageDescription).toBe('runtime: "py" for the IPython kernel, "js" for the persistent JS VM');
		expect(fields.codeDescription).toBe("code to run in this eval call, verbatim. Use top-level await freely.");
		expect(fields.actions).toEqual(["execute", "run", "edit", "replay", "list"]);
		expect(tool.summary).toBe("Execute Python or JavaScript code in an in-process eval backend");
		expect(tool.description).not.toMatch(/ruby|julia/i);
		const exampleActions = tool.examples.map(ex => ("call" in ex ? ex.call.action : null));
		expect(exampleActions).toEqual([undefined, undefined, undefined, "run", "edit", "replay", "list"]);
	});

	it("enforces each action contract without a root schema union", () => {
		const parameters = new EvalTool(makeSession({})).parameters;
		expect(() => parameters.assert({ language: "py" })).toThrow(/"code" is required/);
		expect(() => parameters.assert({ action: "run", language: "js", cell: 1 })).toThrow(
			/action "run" requires language "py"/,
		);
		expect(() => parameters.assert({ action: "edit", language: "py", cell: 1 })).toThrow(
			/"cell" and "edits" are required/,
		);
		expect(() => parameters.assert({ action: "list", language: "py", code: "x = 1" })).toThrow(
			/accepts only "action" and "language"/,
		);
		expect(parameters.assert({ action: "run", language: "py", cell: 1 })).toEqual({
			action: "run",
			language: "py",
			cell: 1,
		});
	});

	it("omits Python cell actions when only JavaScript is enabled", () => {
		const tool = new EvalTool(makeSession({ backends: { "eval.py": false, "eval.js": true } }));
		const fields = wireEvalFields(tool);
		expect(fields.rootType).toBe("object");
		expect(fields.hasRootUnion).toBe(false);
		expect(fields.languages).toEqual(["js"]);
		expect(fields.actions).toEqual(["execute"]);
		expect(tool.description).not.toContain("Python cells:");
	});
});
