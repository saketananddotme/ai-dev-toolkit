# adt — AI skill package manager

A package manager for AI skills, agents, commands, rules, and hooks — for Cursor, Claude Code, and Codex.

Think `nvm` for AI skills: **install** any skill source from a git repo, then **use** it globally or just inside one project. Different projects can have different skills active without polluting your global setup.

## Install

```bash
npm install -g @saketananddotme/adt
adt init
```

## Mental model

There are two distinct steps, by design:

| Step | Command | What it does |
|---|---|---|
| Install | `adt install <source>` | Clones the source to `~/.adt/sources/`. Nothing is wired into your editor yet. |
| Use | `adt use <source>` | Creates symlinks into the harness directories (Cursor, Claude Code, Codex) so the skills are actually picked up. |

`adt use` is **scope-aware**:

- Run from a project directory (anywhere inside a `.git` repo, or a dir with a `.adt` file) → **project scope**. Symlinks go into `<project>/.claude/skills/`, `<project>/.cursor/rules/`, etc.
- Run from anywhere else (your home directory, `/tmp`, …) → **global scope**. Symlinks go into `~/.claude/skills/`, `~/.cursor/rules/`, etc.
- `adt use --global <source>` forces global from any directory.

You can have the same source active globally **and** project-locally at the same time — they layer.

## Quick start

```bash
# 1. One-time setup (detects which harnesses you have)
adt init

# 2. Install (download) the sources you want available on this machine
adt install obra
adt install karpathy

# 3. Activate globally — affects every project
adt use --global obra

# 4. Activate per-project (no flag needed — scope detected from cwd)
cd ~/Projects/my-react-app
adt use karpathy
#   → writes symlinks into ./.claude/skills/ etc.
#   → records the choice in ./.adt
#   → adds .adt and harness dirs to ./.gitignore

# 5. New worktree / project — bootstrap from .adt
cd ~/Projects/my-other-app
adt use            # reads .adt and re-applies its entries
```

## The `.adt` file

When you run `adt use <source>` inside a project, ADT writes a personal config file at `<project>/.adt`:

```jsonl
{"source":"karpathy","added":"2026-05-23T10:14:02Z"}
{"source":"obra","item":"spec-driven-development","added":"2026-05-23T10:14:05Z"}
```

It's newline-delimited JSON, one entry per line. The file is **personal** — it's auto-added to your `.gitignore` along with the harness dirs the activation creates. You can hand-edit it freely.

Run `adt use` (no args) inside a project to replay everything in its `.adt`.

## Commands

### Setup
```
adt init                          Interactive setup: detect harnesses, configure
adt init --yes                    Non-interactive with detected defaults
```

### Sources
```
adt source add <name> <url>       Register a custom git repo as a source
adt source remove <name>          Remove a source (cleans symlinks everywhere — global + every project)
adt source list                   List built-in + custom sources
adt source update [name]          Pull latest from upstream
```

### Install (download)
```
adt install <source>              Clone source to ~/.adt/sources/ (no symlinks yet)
```

### Use (activate)
```
adt use <source>                  Activate — project scope if in a project, else global
adt use <source>/<item>           Activate one specific skill / agent / rule
adt use --global <source>         Force global from anywhere
adt use                           (inside a project) Re-apply entries from .adt
adt unuse <source>[/<item>]       Deactivate (scope-aware; --global to override)
adt update                        Pull all sources and repair broken links
```

### Inspect
```
adt list                          Available items grouped by source
adt list <source>                 Available items in one source
adt list --installed              Sources downloaded on this machine
adt list --global                 Items currently active globally
adt list --project                Items currently active in this project
adt status                        Detected scope + global + project summary
adt info <source>                 Metadata, content counts, and activation status
adt outdated                      Show sources that have upstream updates
adt pin <source> [ref]            Lock a source to its current commit (or a ref)
adt unpin <source>                Remove the pin — source will update normally again
```

### Uninstall
```
adt uninstall                     Interactive: removes every symlink, every .adt block,
                                  and the entire ~/.adt/ directory
```

`npm uninstall -g @saketananddotme/adt` also removes everything ADT created.

## Built-in sources

| Name | Repo | Content |
|---|---|---|
| `obra` | [obra/superpowers](https://github.com/obra/superpowers) | 14 skills for rapid prototyping |
| `addy` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | 23 skills, 3 agents, 7 commands |
| `matt` | [mattpocock/skills](https://github.com/mattpocock/skills) | 20 skills for daily debugging |
| `karpathy` | [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) | Karpathy-style coding guidelines |

## How source repos are structured

ADT auto-discovers content in any git repo using these conventions:

```
your-skill-repo/
├── skills/              # any dir containing SKILL.md (recursive) → installed as skill
├── agents/              # .md files → installed as agents
├── commands/            # .md or .toml files → installed as slash commands (Claude Code)
├── .claude/commands/    # alternate location for slash commands (also scanned)
├── rules/               # .mdc files (recursive) → installed as rules (Cursor only)
├── hooks/               # hook scripts/dirs → installed as hooks
└── CLAUDE.md            # appended as a marker block in ~/.claude/CLAUDE.md (global)
                        #   or <project>/CLAUDE.md (project scope)
```

`skills/` is walked recursively, so bucketed layouts like `skills/<bucket>/<name>/SKILL.md` work the same as flat `skills/<name>/SKILL.md`. Bucket folders listed in `catalog.json` under `skipBuckets` (default: `deprecated`, `in-progress`) are pruned — useful for repos that keep archived or unfinished skills next to live ones.

No special config needed. ADT scans for these directories automatically.

## Scope detection rules

When you run `adt use <source>`, ADT walks up from your current directory:

1. First, looks for a `.adt` file. If found, you're in a project — that directory is the project root.
2. Otherwise, looks for a `.git` directory or file. If found, that directory is the project root.
3. Otherwise, scope is global. Symlinks go to `~/.cursor/`, `~/.claude/`, `~/.codex/`.

`$HOME` is never treated as a project root. The `--global` flag bypasses detection.

Git worktrees work naturally — each worktree has its own `.git` file and can hold its own `.adt`.

## Key behaviors

- **Never destroys what isn't yours.** ADT tracks every symlink it creates in `~/.adt/.manifest.json` and only removes its own entries.
- **Idempotent.** Activating an already-active item is a no-op.
- **Collision-safe.** If a real (non-symlink) file exists at the destination, ADT warns and skips.
- **Layered.** A source can be active globally and project-locally at the same time — they live in different directories and don't conflict.
- **Auto-gitignore.** First project `adt use` writes a managed `# BEGIN ADT … # END ADT` block to `.gitignore`. ADT never edits between those markers afterwards — you can change them however you like.
## Runtime directory

```
~/.adt/
├── sources/              # Cloned git repos
├── .manifest.json        # Every symlink ADT created (global + project scopes)
├── .state.json           # Harness config and user sources
└── catalog-remote.json   # Cached remote catalog
```

Project-local files:
```
<project>/
├── .adt                    # Personal project config (jsonl). Never committed.
├── .gitignore              # Auto-amended with ADT-managed block
├── .claude/skills/...      # Project-local symlinks created by `adt use`
├── .claude/commands/...    # Slash command symlinks (Claude Code)
├── .cursor/rules/...
└── CLAUDE.md               # Project memory block (if source has CLAUDE.md)
```
