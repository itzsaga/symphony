# nono.sh — Research Findings for Symphony v1

## Sources
- `https://nono.sh/` (landing page)
- `https://nono.sh/docs` (docs index)
- `https://nono.sh/docs/llms.txt` (LLM-friendly index)
- `https://nono.sh/docs/cli/usage/flags.md` (CLI reference)
- `https://nono.sh/docs/cli/getting_started/installation.md`
- `https://nono.sh/docs/cli/features/execution-modes.md`

Fetched via `WebFetch`. The site self-describes nono as *"Secure, kernel-enforced sandbox CLI and SDKs for AI agents, MCP and LLM workloads"*.

## Summary

nono enforces an irrevocable allow-list at the kernel level — Landlock on Linux, Seatbelt (`sandbox_init`) on macOS, WSL2 on Windows. It ships in three flavors:

1. A **CLI** (`nono run`, `nono shell`, `nono wrap`) — the right surface for Symphony.
2. A **TypeScript SDK** (`CapabilitySet`, `apply()`) — for in-process sandboxing.
3. A **Python SDK** and a **Rust core library**.

The CLI is the cleanest fit for Symphony's design: every `claude` invocation and every workflow hook gets wrapped in `nono run …` with a Symphony-curated policy.

## Installation

- **macOS:** `brew install nono`
- **Nix (project flake — what Seth wants):**
  - `pkgs.nono` is in nixpkgs (per the install docs).
  - `nix shell nixpkgs#nono` for ad-hoc use.
  - For Symphony: include `nono` as an input in `flake.nix`'s `devShell` so `bun run src/main.ts …` runs in an environment where `nono` is on PATH.
- **Other:** Homebrew, Debian/Ubuntu apt packages, build-from-source.
- **macOS Seatbelt entitlements:** the install docs don't call out anything required; standard `sandbox-exec`-style profile loading works out of the box.

## CLI reference (relevant subset)

**Execution commands:**
- `nono run [OPTIONS] -- <COMMAND> [ARGS...]` — Supervised mode. Parent stays in process tree, forwards signals. **Use this for Claude.**
- `nono shell [OPTIONS]` — interactive sandboxed shell.
- `nono wrap [OPTIONS] -- <COMMAND> [ARGS...]` — Direct mode (`exec()`), nono disappears from process tree. Lower overhead; loses signal forwarding.

**Filesystem flags:**
| Flag | Effect |
|---|---|
| `--allow PATH` / `-a` | Read+write access to a directory (recursive). Repeatable. |
| `--read PATH` / `-r` | Read-only directory (recursive). |
| `--write PATH` / `-w` | Write-only directory (recursive). |
| `--allow-file PATH` | Read+write a single file. |
| `--read-file PATH` | Read-only single file. |
| `--write-file PATH` | Write-only single file. |
| `--allow-cwd` | Grant access to the cwd. |

**Network flags:**
| Flag | Effect |
|---|---|
| `--block-net` | Block all network. Default is network ALLOWED. |
| `--network-profile NAME` | Predefined profile. Built-ins include: `minimal`, `developer`, **`claude-code`**, `codex`, `opencode`, `enterprise`. |
| `--allow-domain DOMAIN` | Add a domain to the proxy allowlist (activates proxy mode). Repeatable. |

**Credential injection:**
| Flag | Effect |
|---|---|
| `--credential SERVICE` | Pull credentials from system keystore. Preset services include `openai`, `anthropic`, `gemini`, `google-ai`. |
| `--env-credential …` | Pull credentials as env vars. |

**Profiles:**
| Flag | Effect |
|---|---|
| `--profile NAME` / `-p` | Use named profile from installed packs or `~/.config/nono/profiles/`. |

**Diagnostics:**
| Flag | Effect |
|---|---|
| `--dry-run` | Show capabilities without executing. |
| `--silent` / `-s` | Suppress nono output. |
| `--verbose` / `-v` | Increase logging (repeatable: `-v`, `-vv`, `-vvv`). |

## Sandbox scope (subprocess inheritance)

From the docs: *"the sandbox applies to restrictions on the directly-invoked executable"* but *"Child processes can bypass this check."* Network sandboxing and filesystem grants apply to **all** child processes created within the sandbox session. Path canonicalization prevents symlink escape.

In Supervised mode (`nono run`), the sandbox covers grandchildren (bash → rg, sed, git, etc.). This is what Claude needs because Claude spawns many tool subprocesses.

## Execution mode choice

The docs explicitly recommend **Supervised mode (`nono run`) for "interactive AI agents"**:
- Signal propagation across the process tree.
- Sandbox covers grandchildren.
- Parent diagnostic output preserved.

**Direct mode (`nono wrap`)** suits *"scripts and CI/CD where you want minimal overhead"* and removes nono from the process tree via `exec()`. We don't want this — we lose signal control across the agent's many child processes.

## Built-in `claude-code` network profile

The big win: **`--network-profile claude-code`** is a built-in profile already calibrated for Claude Code's egress needs. Symphony should start from this profile rather than hand-rolling `--allow-domain api.anthropic.com docs.anthropic.com …`.

We can layer `--allow-domain api.linear.app` on top if the profile doesn't already include Linear (TBD — would need to inspect the profile contents, which the public docs don't enumerate).

## Built-in `anthropic` credential injection

`--credential anthropic` pulls `ANTHROPIC_API_KEY` (or whatever Claude Code uses) from the system keystore and injects it as an env var into the subprocess. We can rely on this instead of plumbing the key through Symphony's process environment.

## Symphony invocation pattern (proposed)

```
nono run \
  --network-profile claude-code \
  --credential anthropic \
  --allow <workspace.root>/<issue.identifier> \
  --read <repo-root>/WORKFLOW.md \
  --read ~/.claude \
  --read /opt/homebrew/bin \
  --read /usr/bin --read /bin --read /usr/local/bin \
  -- claude \
       --output-format stream-json --verbose \
       --input-format stream-json \
       --permission-mode bypassPermissions \
       --add-dir <workspace> \
       --mcp-config <symphony-mcp-config.json>
```

For workflow hooks (`after_create`, `before_run`, `after_run`, `before_remove`):

```
nono run \
  --network-profile claude-code \
  --allow <workspace>/<issue.identifier> \
  --read <repo-root>/WORKFLOW.md \
  -- bash -lc "<hook script>"
```

(Hook policy can be tighter than agent policy since hooks are repo-owned trusted code per spec §15.4 but still benefit from blast-radius limits.)

## Open questions

- **What does the `claude-code` profile actually allow?** Public docs don't enumerate the per-profile rule set. Will need to either inspect the profile after install (`nono run --network-profile claude-code --dry-run -- /bin/true` may dump it via `--verbose`) or accept it as a black box.
- **`linear.app` reachability under `claude-code` profile.** If the profile is strictly Anthropic-API + a few docs domains, our `linear_graphql` MCP server (which lives in the orchestrator process, not in the sandbox) handles Linear calls outside the sandbox — so this may not matter. But if any hook script needs to curl Linear, we need to layer `--allow-domain api.linear.app`.
- **Profile customization for hooks.** Hooks may need broader access (e.g. `git clone`, `bun install`). Decide whether to use the `developer` profile for hooks or define a Symphony-specific profile under `~/.config/nono/profiles/`.
- **Failure mode of the sandbox itself.** What does nono do if a syscall is denied? Process exits with a particular code? Signal? Need to check experimentally; the failure shape determines how the orchestrator surfaces it as a worker exit reason.
