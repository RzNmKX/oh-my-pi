/**
 * Regression tests for standalone project-root `CLAUDE.md` discovery.
 *
 * Claude Code reads a repo-root `CLAUDE.md`, but the claude provider previously
 * only looked inside `.claude/` directories. A repo carrying only a root-level
 * `CLAUDE.md` therefore loaded no project context at all.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
// Importing discovery registers all providers as a side effect.
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

let tempDir: string;
let home: string;
let project: string;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

async function loadClaudeContextFiles(ctx: LoadContext): Promise<ContextFile[]> {
	const cap = getCapability(contextFileCapability.id);
	if (!cap) throw new Error("context-files capability missing");
	const claude = cap.providers.find(p => p.id === "claude");
	if (!claude) throw new Error("claude context-file provider missing");
	const result = await (claude.load as (ctx: LoadContext) => Promise<{ items: ContextFile[] }>)(ctx);
	return result.items;
}

beforeEach(() => {
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-md-root-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
});

afterEach(() => {
	clearCache();
	removeSyncWithRetries(tempDir);
});

test("root-level CLAUDE.md in cwd is discovered", async () => {
	const claudeMd = path.join(project, "CLAUDE.md");
	writeFile(claudeMd, "# Project guidance\nAlways rebuild the native addon first.\n");

	const items = await loadClaudeContextFiles({ cwd: project, home, repoRoot: project });

	const found = items.find(item => item.path === claudeMd);
	if (!found) throw new Error("root CLAUDE.md not discovered");
	expect(found.level).toBe("project");
	expect(found.depth).toBe(0);
	expect(found.content).toContain("Always rebuild the native addon first.");
});

test("root-level CLAUDE.md is found walking up from a sub-package cwd", async () => {
	const subPkg = path.join(project, "packages", "app");
	fs.mkdirSync(subPkg, { recursive: true });
	const claudeMd = path.join(project, "CLAUDE.md");
	writeFile(claudeMd, "# Repo-wide guidance\n");

	const items = await loadClaudeContextFiles({ cwd: subPkg, home, repoRoot: project });

	const found = items.find(item => item.path === claudeMd);
	if (!found) throw new Error("ancestor CLAUDE.md not discovered");
	expect(found.depth).toBe(2);
});

test("root CLAUDE.md and .claude/CLAUDE.md are both emitted by the provider", async () => {
	const rootMd = path.join(project, "CLAUDE.md");
	const nestedMd = path.join(project, ".claude", "CLAUDE.md");
	writeFile(rootMd, "root level\n");
	writeFile(nestedMd, "config dir level\n");

	const items = await loadClaudeContextFiles({ cwd: project, home, repoRoot: project });

	expect(items.map(i => i.path)).toContain(rootMd);
	expect(items.map(i => i.path)).toContain(nestedMd);
});

test("a dot-directory cwd does not emit its CLAUDE.md as a project file", async () => {
	// $HOME/.claude/CLAUDE.md is the user-level file; walking up from inside a
	// dot-directory must not re-emit it as project context.
	const userClaudeDir = path.join(home, ".claude");
	writeFile(path.join(userClaudeDir, "CLAUDE.md"), "user level\n");

	const items = await loadClaudeContextFiles({ cwd: userClaudeDir, home, repoRoot: null });

	const projectItems = items.filter(item => item.level === "project");
	expect(projectItems).toHaveLength(0);
});

test("root CLAUDE.md and root AGENTS.md both survive dedup", async () => {
	// The claude provider (priority 80) outranks agents-md (10), so without a
	// separate dedupe scope a root CLAUDE.md would shadow AGENTS.md entirely.
	const claudeMd = path.join(project, "CLAUDE.md");
	const agentsMd = path.join(project, "AGENTS.md");
	writeFile(claudeMd, "claude guidance\n");
	writeFile(agentsMd, "agents guidance\n");

	const result = await loadCapability<ContextFile>(contextFileCapability.id, {
		cwd: project,
		providers: ["claude", "agents-md"],
	});

	const paths = result.items.filter(item => item.level === "project").map(item => item.path);
	expect(paths).toContain(claudeMd);
	expect(paths).toContain(agentsMd);
});

test(".claude/CLAUDE.md still shadows AGENTS.md at the same depth", async () => {
	// Pre-existing precedence: a config-dir CLAUDE.md occupies the shared
	// one-file-per-depth slot. Only standalone CLAUDE.md gets its own scope.
	const nestedMd = path.join(project, ".claude", "CLAUDE.md");
	const agentsMd = path.join(project, "AGENTS.md");
	writeFile(nestedMd, "config dir guidance\n");
	writeFile(agentsMd, "agents guidance\n");

	const result = await loadCapability<ContextFile>(contextFileCapability.id, {
		cwd: project,
		providers: ["claude", "agents-md"],
	});

	const paths = result.items.filter(item => item.level === "project").map(item => item.path);
	expect(paths).toEqual([nestedMd]);
});

test("root CLAUDE.md survives the public context-file capability load", async () => {
	const claudeMd = path.join(project, "CLAUDE.md");
	writeFile(claudeMd, "# Sticky project guidance\n");

	const result = await loadCapability<ContextFile>(contextFileCapability.id, {
		cwd: project,
		providers: ["claude"],
	});

	const found = result.items.find(item => item.path === claudeMd);
	if (!found) throw new Error("root CLAUDE.md did not survive dedup");
	expect("_shadowed" in found).toBe(false);
});
