# Eval Python Cell Store Handoff

## Goal

Make `eval` notebook-like for Python only while preserving the existing persistent IPython namespace:

- Every ordinary `{ language: "py", code: "..." }` call becomes a stable stored cell.
- Rerun a cell without resending its source.
- Edit a stored cell with atomic exact replacements, then run it.
- Replay a stored range in order, optionally resetting the kernel first.
- List exact cell sources and provenance after a kernel reset or crash.
- Leave JavaScript eval behavior unchanged.

## Branch

`feat/eval-cell-store`

Expected fork remote: `fork` → `https://github.com/RzNmKX/oh-my-pi.git`

## Current implementation

### `packages/coding-agent/src/eval/py/cell-store.ts`

New host-side `PythonCellStore`:

- Stable 1-based cell IDs.
- Exact source, title, original timeout, revision, run count.
- Kernel epochs survive kernel reset because storage is outside IPython.
- States: `never`, `previous-kernel`, `running`, `complete`, `error`, `cancelled`, `stale`.
- A downstream cell becomes stale when an earlier cell is rerun later.
- Exact edits are transactional and reject missing or ambiguous `old` text.
- Stores are held in a `WeakMap` keyed by `ToolSession`; no explicit disposal path or process-lifetime leak.

### `packages/coding-agent/src/tools/eval.ts`

The strict schema is now a discriminated union:

```json
{ "language": "py", "code": "x = 1" }
{ "action": "run", "language": "py", "cell": 1 }
{ "action": "edit", "language": "py", "cell": 1, "edits": [{ "old": "x = 1", "new": "x = 2" }] }
{ "action": "replay", "language": "py", "from": 1, "through": 3, "reset": true }
{ "action": "list", "language": "py" }
```

Ordinary Python execution appends a cell. Run/edit/replay resolve stored source host-side and feed it through the existing backend, streaming, timeout, artifact, and auto-background path. Run completion updates provenance. Kernel epoch advances immediately before a stored Python cell executes with `reset: true`.

### `packages/coding-agent/test/tools/eval-cells.test.ts`

New tool-level contract tests cover:

- Automatic storage and source-free rerun.
- Downstream stale detection.
- Transactional exact edit plus revised-source execution.
- Ordered replay with reset only on the first cell.
- Previous-kernel provenance after reset.

## Verified so far

- LSP diagnostics are clean for:
  - `packages/coding-agent/src/tools/eval.ts`
  - `packages/coding-agent/src/eval/py/cell-store.ts`
- `bun install --ignore-scripts` completed and restored workspace links.
- `bun run build:native` rebuilt the current Windows binding.
- `bun run check:types` passes in `packages/coding-agent`.
- `bun test test/tools/eval-cells.test.ts` passes: 3 tests, 11 assertions.

## Remaining work

1. Expand `packages/coding-agent/test/tools/eval-cells.test.ts` only if review finds an uncovered observable boundary; the current focused suite passes.
2. Update `packages/coding-agent/src/prompts/tools/eval.md` so models know automatic storage and all four Python cell actions. Keep source-edit guidance explicit: use `action: "edit"`; do not reconstruct whole cells unless replacement matching requires it.
3. Approval text and action-specific intent are implemented. Add action examples and pending render behavior in `packages/coding-agent/src/tools/eval.ts` / `eval-render.ts` for action calls that have no `code` field.
4. Update schema-description tests, especially `packages/coding-agent/test/tools/eval-description.test.ts`; the wire schema is now `anyOf` rather than one flat object.
5. Add an `[Unreleased]` entry under `### Added` in `packages/coding-agent/CHANGELOG.md`.
6. Run focused eval tests, then `bun check`.
7. Live smoke with a real Python backend:
   - execute cell 1 defining state;
   - execute cell 2 consuming it;
   - rerun cell 1 by ID;
   - list and confirm cell 2 is stale;
   - edit cell 1 by exact replacement;
   - replay downstream cells;
   - replay all with `reset: true` and confirm namespace reconstruction.
8. Review the final diff. Do not push to upstream.

## Design constraints

- Python only. Do not add JS cell management.
- Stored source must remain host-side so kernel death does not erase it.
- Do not build prompts in TypeScript; prompt instructions belong in the existing Markdown prompt.
- Preserve the current one-cell-per-ordinary-call workflow; cell actions are additive.
- Avoid `.ipynb` file coupling. This is session execution history/provenance, not notebook document persistence.
- No compatibility aliases or secondary API shapes.
