import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { githubToolRenderer } from "../../src/tools/gh-renderer";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

describe("github tool renderer", () => {
	it("sanitizes and truncates run_watch pending selectors", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const component = githubToolRenderer.renderCall(
			{
				op: "run_watch",
				ref: `release\t${"x".repeat(120)}`,
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme!,
		);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("ref release");
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("x".repeat(80));
	});
});
