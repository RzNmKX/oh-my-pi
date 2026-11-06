import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-tui/tools/eval";

type EvalArgs = Parameters<typeof evalToolRenderer.renderCall>[0];

/**
 * Stored Python cell actions send no source, so the pending call names the
 * operation (terminal and native views) instead of an empty placeholder.
 */
describe("eval renderer: stored Python cell actions", () => {
	let theme: Theme;

	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	const cases: Array<[EvalArgs, string]> = [
		[{ action: "run", language: "py", cell: 2 }, "Rerun Python cell 2"],
		[
			{
				action: "edit",
				language: "py",
				cell: 2,
				edits: [
					{ old: "limit = 10", new: "limit = 20" },
					{ old: "offset = 0", new: "offset = 20" },
				],
			},
			"Edit and rerun Python cell 2 (2 replacements)",
		],
		[{ action: "replay", language: "py", from: 1, through: 3, reset: true }, "Replay Python cells 1-3 after reset"],
		[{ action: "replay", language: "py" }, "Replay Python cells 1-latest"],
		[{ action: "list", language: "py" }, "List stored Python cells"],
	];

	for (const [args, label] of cases) {
		it(`names "${label}" while pending`, () => {
			const rendered = Bun.stripANSI(
				evalToolRenderer.renderCall(args, { expanded: false, isPartial: true }, theme).render(120).join("\n"),
			);
			expect(rendered).toContain(label);
			const view = evalToolRenderer.describeCall(args, { expanded: false, isPartial: true });
			expect(view.tool?.title).toBe(label);
		});
	}

	it("keeps the placeholder for a new cell whose code has not streamed yet", () => {
		const rendered = Bun.stripANSI(
			evalToolRenderer
				.renderCall({ action: "execute", language: "py" }, { expanded: false, isPartial: true }, theme)
				.render(120)
				.join("\n"),
		);
		expect(rendered).toContain("…");
		expect(evalToolRenderer.describeCall({ language: "py" }, { expanded: false, isPartial: true }).tool?.title).toBe(
			"Eval",
		);
	});
});
