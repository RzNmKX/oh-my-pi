import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { pythonBackend } from "../../src/eval";
import type { ExecutorBackendResult } from "../../src/eval/backend";
import { EvalTool } from "../../src/tools/eval";
import type { ToolSession } from "../../src/tools";

function createSession(): ToolSession {
	const evalSessionId = `eval-cells-${crypto.randomUUID()}`;
	return {
		cwd: process.cwd(),
		settings: {
			get: (key: string) => {
				if (key === "eval.autoBackground.enabled") return false;
				if (key === "tools.maxTimeout") return 0;
				return undefined;
			},
		} as unknown as ToolSession["settings"],
		getSessionFile: () => null,
		getEvalSessionId: () => evalSessionId,
	} as ToolSession;
}

function successfulResult(code: string): ExecutorBackendResult {
	return {
		output: code,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 1,
		totalBytes: Buffer.byteLength(code),
		outputLines: 1,
		outputBytes: Buffer.byteLength(code),
		displayOutputs: [],
	};
}

describe("EvalTool Python cells", () => {
	afterEach(() => {
		mock.restore();
	});

	it("stores ordinary calls and reruns a cell without source in the new call", async () => {
		const executions: Array<{ code: string; reset: boolean | undefined }> = [];
		spyOn(pythonBackend, "isAvailable").mockResolvedValue(true);
		spyOn(pythonBackend, "execute").mockImplementation(async (code, options) => {
			executions.push({ code, reset: options.reset });
			return successfulResult(code);
		});
		const tool = new EvalTool(createSession());

		await tool.execute("cell-1", { language: "py", code: "value = 1", title: "setup" });
		await tool.execute("cell-2", { language: "py", code: "value += 1" });
		await tool.execute("run-1", {
			action: "run",
			language: "py",
			cell: 1,
			code: "this must not execute",
			from: 1,
			through: 2,
			edits: [{ old: "value = 1", new: "value = 99" }],
		});
		const listed = await tool.execute("list", {
			action: "list",
			language: "py",
			code: "this must not execute",
			cell: 1,
			edits: [{ old: "value = 1", new: "value = 99" }],
		});
		const text = listed.content[0]?.type === "text" ? listed.content[0].text : "";

		expect(executions.map(execution => execution.code)).toEqual(["value = 1", "value += 1", "value = 1"]);
		expect(text).toContain("--- cell 1 [complete; revision 1; runs 2] · setup ---\nvalue = 1");
		expect(text).toContain("--- cell 2 [stale; revision 1; runs 1] ---\nvalue += 1");
	});

	it("edits transactionally with unique exact replacements and runs the revised source", async () => {
		const executions: string[] = [];
		spyOn(pythonBackend, "isAvailable").mockResolvedValue(true);
		spyOn(pythonBackend, "execute").mockImplementation(async code => {
			executions.push(code);
			return successfulResult(code);
		});
		const tool = new EvalTool(createSession());

		await tool.execute("cell-1", { language: "py", code: "value = 1\nprint(value)" });
		await expect(
			tool.execute("bad-edit", {
				action: "edit",
				language: "py",
				cell: 1,
				edits: [
					{ old: "value = 1", new: "value = 2" },
					{ old: "missing", new: "unused" },
				],
			}),
		).rejects.toThrow("edit 2 old text was not found in Python cell 1");
		await tool.execute("good-edit", {
			action: "edit",
			language: "py",
			cell: 1,
			edits: [{ old: "value = 1", new: "value = 2" }],
		});
		const listed = await tool.execute("list", { action: "list", language: "py" });
		const text = listed.content[0]?.type === "text" ? listed.content[0].text : "";

		expect(executions).toEqual(["value = 1\nprint(value)", "value = 2\nprint(value)"]);
		expect(text).toContain("--- cell 1 [complete; revision 2; runs 2] ---\nvalue = 2\nprint(value)");
		expect(text).not.toContain("unused");
	});

	it("replays a range in order and resets only its first cell", async () => {
		const executions: Array<{ code: string; reset: boolean | undefined }> = [];
		spyOn(pythonBackend, "isAvailable").mockResolvedValue(true);
		spyOn(pythonBackend, "execute").mockImplementation(async (code, options) => {
			executions.push({ code, reset: options.reset });
			return successfulResult(code);
		});
		const tool = new EvalTool(createSession());

		await tool.execute("cell-1", { language: "py", code: "a = 1" });
		await tool.execute("cell-2", { language: "py", code: "b = a + 1" });
		await tool.execute("cell-3", { language: "py", code: "c = b + 1" });
		await tool.execute("replay", { action: "replay", language: "py", from: 2, through: 3, reset: true });
		const listed = await tool.execute("list", { action: "list", language: "py" });
		const text = listed.content[0]?.type === "text" ? listed.content[0].text : "";

		expect(executions.slice(-2)).toEqual([
			{ code: "b = a + 1", reset: true },
			{ code: "c = b + 1", reset: false },
		]);
		expect(text).toContain("--- cell 1 [previous-kernel; revision 1; runs 1] ---");
		expect(text).toContain("--- cell 2 [complete; revision 1; runs 2] ---");
		expect(text).toContain("--- cell 3 [complete; revision 1; runs 2] ---");
	});
});
