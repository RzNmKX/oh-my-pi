/**
 * CLAUDE.md Provider
 *
 * Discovers standalone CLAUDE.md files by walking up from cwd.
 * This handles CLAUDE.md files that live in project root (not in config directories
 * like .claude/, which are handled by the Claude Code provider).
 *
 * Claude Code reads a root CLAUDE.md alongside AGENTS.md and .claude/CLAUDE.md, so
 * these files take their own dedupe scope instead of competing for the depth slot.
 */
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import type { LoadContext, LoadResult } from "../capability/types";
import { loadStandaloneContextFiles } from "./helpers";

const PROVIDER_ID = "claude-md";
const DISPLAY_NAME = "CLAUDE.md";
const SCOPE = "claude-md";

/**
 * Load standalone CLAUDE.md files by walking up from cwd
 * (see {@link loadStandaloneContextFiles}).
 */
export async function loadClaudeMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	return loadStandaloneContextFiles(ctx, PROVIDER_ID, "CLAUDE.md", SCOPE);
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Standalone CLAUDE.md files (Claude Code style)",
	priority: 10,
	load: loadClaudeMd,
});
