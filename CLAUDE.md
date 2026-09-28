# CLAUDE.md

Guidance for working in the `oh-my-pi` monorepo.

## Building & installing the `omp` binary

The thing you actually run is `omp`. On this machine the binary is:

- `C:\Users\Austin.Pivarnik\.bun\bin\omp.exe` — the live binary installed via bun.

Note: `~/.omp/` is the **data/config dir** (databases, `config.yml`, `sessions/`,
`logs/`, `natives/`), NOT where the binary lives.

### Where a local build goes

`bun run build` inside `packages/coding-agent` writes to
`packages/coding-agent/dist/omp.exe` (hard-coded `--outfile` in
`scripts/build-binary.ts`). **It does not touch the live binary**. To run your
local build you must copy it over:

```sh
cp packages/coding-agent/dist/omp.exe ~/.bun/bin/omp.exe
```

(Back up the current one first if you want a rollback: `cp ~/.bun/bin/omp.exe ~/.bun/bin/omp.exe.bak`.)

## GOTCHA: stale native addon after building omp

**Symptom:** after building + copying omp, `omp -v` works but `omp -p "..."`
(or any real run) crashes with:

```
Failed to load pi_natives native addon for win32-x64 (baseline).
... does not expose the @oh-my-pi/pi-natives@16.0.0 version sentinel
`__piNativesV16_0_0`. The .node file on disk is from a different release
than this loader — reinstall to re-sync.
```

**Why:** the omp binary embeds a prebuilt native addon
(`packages/natives/native/pi_natives.<platform>.node`, a Rust/napi-rs build).
That prebuilt `.node` is checked into the tree and is often **stale** — built
from an older release that lacks the current version sentinel. `bun run build`
in `coding-agent` embeds whatever native is sitting there; it does **not**
rebuild it. So you get a fresh loader wrapped around an old native, and they
disagree on the version sentinel.

**Fix — rebuild the native FIRST, then rebuild omp:**

```sh
# 1. Rebuild the native addon (Rust/napi-rs; ~1-2 min, needs the toolchain)
bun --cwd packages/natives run build

# 2. Rebuild omp so it embeds the fresh native
bun --cwd packages/coding-agent run build

# 3. Copy the fresh binary over the live one
cp packages/coding-agent/dist/omp.exe ~/.bun/bin/omp.exe

# 4. Clear stale EXTRACTED native caches so the new embedded one re-extracts
rm -f "$HOME/.omp/natives/"*/pi_natives.win32-x64-baseline.node

# 5. Verify
omp -v            # -> omp/16.0.0
omp -p "say hi"   # -> should reply, not crash
```

The cache-clearing in step 4 matters: on first run the binary extracts its
embedded native to `~/.omp/natives/<version>/`. If a stale `.node` is already
sitting at that path (or the loose copy in `%LOCALAPPDATA%\omp`), it shadows
the fresh one and you get the same sentinel error even after rebuilding.
