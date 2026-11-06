# CLAUDE.md

Guidance for working in the `oh-my-pi` monorepo on this machine. `AGENTS.md`
holds the project rules; this file covers the local build, install, and the
fork's customizations.

## Building & installing the `omp` binary

The thing you actually run is `omp`. On this machine the binary is:

- `C:\Users\Austin.Pivarnik\.bun\bin\omp.exe` — the live binary installed via bun.

Note: `~/.omp/` is the **data/config dir** (databases, `agent/config.yml`,
`agent/models.yml`, `sessions/`, `logs/`, `natives/`), NOT where the binary lives.

Toolchain: Bun >= 1.4.4 (root `packageManager`, `packages/utils` engines) and the
Rust toolchain pinned in `rust-toolchain.toml`.

### Full build (after any version bump)

`bun run build` in `packages/coding-agent` embeds whatever native addon sits in
`packages/natives/native/`; it does **not** rebuild it, and nothing at build time
checks that addon's version. Rebuild the native first whenever the package
version changes:

```sh
# 1. Native addon (Rust/napi-rs). ~12.5 min on the first build after a
#    toolchain bump. Leaves packages/natives/native/index.d.ts modified
#    (doc comments only); `git checkout` it.
(cd packages/natives && bun run build)

# 2. omp itself (about 1 min). Run it FROM the package dir:
#    `bun --cwd packages/coding-agent run build` from the repo root exits 0
#    without compiling, leaving a stale dist/omp.exe. Check its mtime.
(cd packages/coding-agent && bun run build)

# 3. Back up, then install. Windows will not overwrite a running exe, and
#    there are usually omp sessions open, so rename the live one aside
#    (running sessions keep working) instead of copying over it.
mv ~/.bun/bin/omp.exe ~/.bun/bin/omp.exe.retired-$(date +%Y%m%d)-<old-version>
cp packages/coding-agent/dist/omp.exe ~/.bun/bin/omp.exe

# 4. Verify
omp -v                                  # -> omp/18.17.0
omp --smoke-test                        # -> smoke-test: ok
omp -p --no-session "say hi"            # -> should reply, not crash
```

### Stale native addon

On first run the binary extracts its embedded native to
`~/.omp/natives/<version>/pi_natives.win32-x64-modern.node` (this CPU uses the
`modern` variant, not `baseline`). The loader checks a per-release version
sentinel and fails at load time, not build time, with:

```
... does not expose the @oh-my-pi/pi-natives@<version> version sentinel ...
```

That means either step 1 was skipped (rebuild the native, then omp) or a stale
extracted copy is shadowing the embedded one. Check and clear it:

```sh
cmp ~/.omp/natives/<version>/pi_natives.win32-x64-modern.node \
    packages/natives/native/pi_natives.win32-x64-modern.node
rm -f "$HOME/.omp/natives/<version>/"pi_natives.win32-x64-*.node
```

Tests run against `packages/natives/native/` directly, so a stale addon there
also fails `bun test` with "is the @oh-my-pi/pi-natives@<old> addon, not @<new>".

### Never enable `update.auto`

`update.auto` (default `false`) self-updates a compiled binary in `~/.bun/bin`
to the upstream release, replacing this fork's build. Leave it off; upgrade by
rebasing the fork commits instead.

## Fork customizations

Branch `upgrade/18.17.0`, cut from upstream tag `v18.17.0`. Port these onto the
next release tag when upgrading:

| Commit | Change |
|---|---|
| `6a7719889f` | fix(ai): tolerate `null` summary parts in finished Responses reasoning items |
| `c2b21428c0` | feat(coding-agent): load project-root `CLAUDE.md` beside `AGENTS.md` and `.claude/CLAUDE.md` |
| `20cf19ebaa` | fix(ai): SigV4-sign Bedrock Mantle requests for a pinned host's region, not `AWS_REGION` |
| `1aa0e59f5a`, `364edfce83` | feat(coding-agent): Python eval cell store (`run`/`edit`/`replay`/`list` by cell id) |
| `2d743dbbdc`, `a5e680116f` | feat(catalog): Palantir Foundry provider (`palantir-foundry`, `PALANTIR_API_KEY`) |

The Palantir port touches catalog KDL and regenerates `rules.json`,
`auth-ids.ts`, `provider-ids.ts`, and `models.json`. On conflicts, resolve the
KDL and source, then regenerate from `packages/catalog` (`bun run gen:compat`,
`bun run gen:models`) rather than merging generated files by hand.

Dropped at the 18.17.0 upgrade: `/collab web` (branch `origin/austin`) and the
fork's Bedrock model discovery. Upstream now layers the models.dev catalog onto
`amazon-bedrock` at runtime, so new Claude models appear without a rebuild.

## User config that depends on this fork

- `~/.omp/agent/models.yml` defines GPT-6 Astra and Sol under `bedrock-mantle`,
  each pinned to its regional host (Astra us-west-2, Sol us-east-1). Signing
  for the pinned host's region needs `20cf19ebaa`; without it Sol is signed for
  `AWS_REGION` (us-west-2) and Mantle answers 401 "Credential should be scoped
  to a valid region". Mantle GPT models must be added there
  by hand: GPT-6 over Converse (`amazon-bedrock/us.openai.gpt-6-*`) is denied
  in the nonprod account by an org SCP.
- The provider `baseUrl` stays at upstream's `{region}` template. A concrete
  provider URL would re-point the bundled gpt-5.x Mantle models too.
- `amazon-bedrock` sets `User-Agent` in models.yml headers, replacing the old
  fork's `BEDROCK_USER_AGENT` env handling.
- Mantle needs `AWS_PROFILE=myapps-nonprod`; the default `corpct-bedrock` role
  lacks `bedrock-mantle:CreateInference`.
