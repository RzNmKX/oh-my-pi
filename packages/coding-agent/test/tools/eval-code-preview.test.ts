import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { previewWindowRows } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

/**
 * Defends pending eval preview contracts: ordinary cells keep a bounded source
 * tail in pending and final renderings, while source-free Python cell actions
 * identify the operation instead of rendering an empty placeholder.
 */
describe("eval renderer previews", () => {
	let theme: Theme;
	const total = previewWindowRows() + 5;
	const code = Array.from({ length: total }, (_, i) => `value_${i} = ${i}`).join("\n");
	const firstLine = "value_0 = 0";
	const lastLine = `value_${total - 1} = ${total - 1}`;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	function renderResult(expanded: boolean): string {
		const details: EvalToolDetails = {
			language: "python",
			languages: ["python"],
			cells: [{ index: 0, code, language: "python", output: "", status: "complete", statusEvents: [] }],
		};
		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(120).join("\n"));
	}

	it("caps collapsed result code to the tail window with an earlier-lines marker", () => {
		const rendered = renderResult(false);
		expect(rendered).toContain(lastLine);
		expect(rendered).toContain("earlier line");
		expect(rendered).not.toContain(firstLine);
	});

	it("shows the full source when expanded", () => {
		const rendered = renderResult(true);
		expect(rendered).toContain(firstLine);
		expect(rendered).toContain(lastLine);
		expect(rendered).not.toContain("earlier line");
	});

	it("bounds the pending preview to the same live tail window", () => {
		const component = evalToolRenderer.renderCall(
			{ language: "py", code },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		// Newest streamed line stays visible; earliest lines are elided above it.
		expect(rendered).toContain(lastLine);
		expect(rendered).toContain("earlier line");
		expect(rendered).not.toContain(firstLine);
	});

	it("identifies source-free Python cell actions while pending", () => {
		const render = (args: Parameters<typeof evalToolRenderer.renderCall>[0]): string =>
			Bun.stripANSI(
				evalToolRenderer.renderCall(args, { expanded: false, isPartial: true }, theme).render(120).join("\n"),
			);

		expect(render({ action: "run", language: "py", cell: 2 })).toContain("Rerun Python cell 2");
		expect(
			render({
				action: "edit",
				language: "py",
				cell: 2,
				edits: [
					{ old: "limit = 10", new: "limit = 20" },
					{ old: "offset = 0", new: "offset = 20" },
				],
			}),
		).toContain("Edit and rerun Python cell 2 (2 replacements)");
		expect(render({ action: "replay", language: "py", from: 1, through: 3, reset: true })).toContain(
			"Replay Python cells 1-3 after reset",
		);
		expect(render({ action: "list", language: "py" })).toContain("List stored Python cells");
	});
});
