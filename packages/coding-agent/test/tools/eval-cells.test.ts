import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { pythonBackend } from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendResult } from "@oh-my-pi/pi-coding-agent/eval/backend";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { getEvalState } from "@oh-my-pi/pi-coding-agent/eval/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(): ToolSession {
	const evalSessionId = `eval-cells-${crypto.randomUUID()}`;
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => evalSessionId,
	};
}

function echoResult(code: string): ExecutorBackendResult {
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

/** Backend that echoes each cell's source as its output, recording what ran. */
function echoBackend(): Array<{ code: string; reset: boolean | undefined }> {
	const executions: Array<{ code: string; reset: boolean | undefined }> = [];
	vi.spyOn(pythonBackend, "checkAvailability").mockResolvedValue({ ok: true });
	vi.spyOn(pythonBackend, "execute").mockImplementation(async (code, options) => {
		executions.push({ code, reset: options.reset });
		return echoResult(code);
	});
	return executions;
}

async function listCells(tool: EvalTool): Promise<string> {
	const listed = await tool.execute(`list-${crypto.randomUUID()}`, { action: "list", language: "py" });
	return listed.content.find(block => block.type === "text")?.text ?? "";
}

describe("EvalTool Python cells", () => {
	afterEach(() => vi.restoreAllMocks());

	it("stores ordinary calls and reruns a cell without source, ignoring unused fields", async () => {
		const executions = echoBackend();
		const tool = new EvalTool(makeSession());

		await tool.execute("cell-1", { language: "py", code: "value = 1", title: "setup" });
		await tool.execute("cell-2", { language: "py", code: "value += 1" });
		// Strict providers send every key; fields the action does not use are ignored.
		await tool.execute("run-1", {
			action: "run",
			language: "py",
			cell: 1,
			code: "this must not execute",
			from: 0,
			through: 0,
			edits: [{ old: "value = 1", new: "value = 99" }],
		});
		const listed = await tool.execute("list", {
			action: "list",
			language: "py",
			code: "this must not execute",
			cell: 1,
			edits: [{ old: "value = 1", new: "value = 99" }],
		});
		const text = listed.content.find(block => block.type === "text")?.text ?? "";

		expect(executions.map(execution => execution.code)).toEqual(["value = 1", "value += 1", "value = 1"]);
		expect(text).toContain(
			"--- cell 1 [complete; revision 1; runs 2] · setup ---\nvalue = 1\n--- output ---\nvalue = 1",
		);
		// Cell 1 ran after cell 2, so cell 2's output no longer reflects the kernel.
		expect(text).toContain("--- cell 2 [stale; revision 1; runs 1] ---\nvalue += 1\n--- output ---\nvalue += 1");
	});

	it("accepts strict-provider sentinels on a new cell and stores it", async () => {
		const executions = echoBackend();
		const tool = new EvalTool(makeSession());

		await tool.execute("cell-1", {
			action: "execute",
			language: "py",
			code: "value = 1",
			cell: 0,
			edits: [],
			from: 0,
			through: 0,
		});

		expect(executions.map(execution => execution.code)).toEqual(["value = 1"]);
		expect(await listCells(tool)).toContain("--- cell 1 [complete; revision 1; runs 1] ---\nvalue = 1");
	});

	it("edits transactionally with unique exact replacements and runs the revised source", async () => {
		const executions = echoBackend();
		const tool = new EvalTool(makeSession());

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
		await expect(
			tool.execute("ambiguous-edit", {
				action: "edit",
				language: "py",
				cell: 1,
				edits: [{ old: "value", new: "other" }],
			}),
		).rejects.toThrow("edit 1 old text matches more than once in Python cell 1");
		await tool.execute("good-edit", {
			action: "edit",
			language: "py",
			cell: 1,
			edits: [{ old: "value = 1", new: "value = 2" }],
		});
		const text = await listCells(tool);

		expect(executions.map(execution => execution.code)).toEqual([
			"value = 1\nprint(value)",
			"value = 2\nprint(value)",
		]);
		expect(text).toContain("--- cell 1 [complete; revision 2; runs 2] ---\nvalue = 2\nprint(value)");
		expect(text).not.toContain("unused");
		expect(text).not.toContain("other");
	});

	it("replays a range in order and resets only before its first cell", async () => {
		const executions = echoBackend();
		const tool = new EvalTool(makeSession());

		await tool.execute("cell-1", { language: "py", code: "a = 1" });
		await tool.execute("cell-2", { language: "py", code: "b = a + 1" });
		await tool.execute("cell-3", { language: "py", code: "c = b + 1" });
		await tool.execute("replay", { action: "replay", language: "py", from: 2, through: 3, reset: true });
		const text = await listCells(tool);

		expect(executions.slice(-2)).toEqual([
			{ code: "b = a + 1", reset: true },
			{ code: "c = b + 1", reset: false },
		]);
		expect(text).toContain("--- cell 1 [previous-kernel; revision 1; runs 1] ---");
		expect(text).toContain("--- cell 2 [complete; revision 1; runs 2] ---");
		expect(text).toContain("--- cell 3 [complete; revision 1; runs 2] ---");
	});

	it("rejects stored-cell actions that miss their required fields or target JavaScript", async () => {
		const executions = echoBackend();
		const tool = new EvalTool(makeSession());

		await expect(tool.execute("run", { action: "run", language: "py", cell: 0 })).rejects.toThrow(
			'"cell" is required for action "run"',
		);
		await expect(tool.execute("edit", { action: "edit", language: "py", cell: 1, edits: [] })).rejects.toThrow(
			'"cell" and "edits" are required for action "edit"',
		);
		await expect(tool.execute("js", { action: "list", language: "js" })).rejects.toThrow(
			'action "list" requires language "py"',
		);
		await expect(tool.execute("missing", { action: "run", language: "py", cell: 1 })).rejects.toThrow(
			"Python cell 1 does not exist; list cells first",
		);
		await expect(tool.execute("new", { language: "py" })).rejects.toThrow('"code" is required for a new eval cell');
		expect(executions).toEqual([]);
		expect(await listCells(tool)).toBe("No stored Python cells (kernel epoch 0).");
	});
});

describe("EvalTool Python cell kernel provenance", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("marks runs from a killed kernel as previous-kernel and reruns stored source in the new kernel", async () => {
		const session = makeSession();
		const tool = new EvalTool(session);

		const first = await tool.execute("cell-1", {
			language: "py",
			code: "import os\nprint('pid', os.getpid())",
			timeout: 60,
		});
		const pid = Number(/pid (\d+)/.exec(first.content.find(block => block.type === "text")?.text ?? "")?.[1]);
		expect(Number.isInteger(pid)).toBe(true);
		expect(pid).not.toBe(process.pid);
		expect(await listCells(tool)).toContain("--- cell 1 [complete; revision 1; runs 1] ---");

		// The kernel's death is a real OS event; poll the host registry until it records it.
		process.kill(pid, "SIGKILL");
		const deadline = Date.now() + 15_000;
		while (getEvalState(session)?.runtimes.some(runtime => runtime.language === "python" && runtime.alive)) {
			if (Date.now() > deadline) throw new Error(`host never saw Python kernel ${pid} die`);
			await Bun.sleep(20);
		}
		expect(await listCells(tool)).toContain("--- cell 1 [previous-kernel; revision 1; runs 1] ---");

		const rerun = await tool.execute("run-1", { action: "run", language: "py", cell: 1, timeout: 60 });
		const rerunPid = Number(/pid (\d+)/.exec(rerun.content.find(block => block.type === "text")?.text ?? "")?.[1]);
		expect(rerunPid).not.toBe(pid);
		expect(await listCells(tool)).toContain("--- cell 1 [complete; revision 1; runs 2] ---");
	}, 120_000);
});
