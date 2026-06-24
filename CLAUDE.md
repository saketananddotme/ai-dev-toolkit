# ai-dev-toolkit (adt)

A CLI package manager for AI skills, agents, rules, and hooks across Cursor, Claude Code, and Codex.

## What it does

`adt` is a zero-dependency Node.js CLI (`bin/adt.js`) that lets users install skill sources (git repos) and symlink them into harness directories — globally (`~/.claude/`, `~/.cursor/`) or per-project (`.claude/`, `.cursor/`).

## Key concepts

- **Source** — a git repo containing skills/agents/rules/hooks (e.g. `obra`, `karpathy`)
- **Install** — clones a source to `~/.adt/sources/`; nothing is wired yet
- **Use** — creates symlinks from the source into harness dirs; scope-aware (global vs project)
- **Scope** — project if inside a `.git` repo or a dir with `.adt`; global otherwise

## File layout

```
bin/adt.js     — entire CLI (~1400 lines, single file, no deps)
catalog.json   — built-in catalog of known sources
```

## Commands

```
adt init                  — detect harnesses, write ~/.adt/ structure
adt install <source>      — clone source to ~/.adt/sources/
adt use [--global] [src]  — symlink source into harness dirs
adt uninstall             — remove symlinks and cleanup
adt list                  — show installed sources
adt search                — search the catalog
```

## Conventions

- No external runtime dependencies — stdlib only
- All state in `~/.adt/` (manifest, state, remote catalog cache)
- Harness paths are defined in `globalHarnessDirs()` and `projectHarnessDirs()` at the top of `bin/adt.js`
- Catalog TTL: 24 hours for remote refresh
