# adt — AI skill package manager

A package manager for AI skills, agents, rules, and hooks — for Cursor, Claude Code, and Codex.

Like `brew` for AI tools: install skills from any git repo, manage them with simple commands, switch between frameworks without destroying your existing setup.

## Install

```bash
npm install -g @saketananddotme/adt
adt init
```

## Quick start

```bash
# Set up harnesses (Cursor, Claude Code, Codex — auto-detected)
adt init

# Install skills from a built-in source
adt install obra                       # All 14 skills from obra/superpowers
adt install addy/spec-driven-development  # One specific skill

# See what's installed
adt list --installed

# Add your own skill repo
adt source add myteam https://github.com/myteam/ai-skills.git
adt install myteam

# Stay in sync with upstream
adt update

# Uninstall everything cleanly
adt uninstall
```

## Commands

### Setup
```
adt init                          Interactive setup: detect harnesses, install first sources
adt init --yes                    Non-interactive with detected defaults
```

### Sources
```
adt source add <name> <url>       Add a git repo as a source
adt source remove <name>          Remove a source and all its installed items
adt source list                   List all configured sources
adt source update [name]          Pull latest from upstream (all or one)
```

### Install / Remove
```
adt install <source>              Install everything from a source
adt install <source>/<item>       Install one skill, agent, rule, or hook
adt remove <source>               Remove everything from a source
adt remove <source>/<item>        Remove one item
adt update                        Pull all sources and re-link
```

### Inspect
```
adt list                          Show all available items (by source)
adt list <source>                 Show available items in one source
adt list --installed              Show only what's currently installed
adt status                        Harness config, installed counts, source health
```

### Uninstall
```
adt uninstall                     Interactive: shows summary, asks to confirm, removes everything
```

`npm uninstall -g @saketananddotme/adt` also removes everything ADT created.

## Built-in sources

| Name | Repo | Content |
|---|---|---|
| `obra` | [obra/superpowers](https://github.com/obra/superpowers) | 14 skills for rapid prototyping |
| `addy` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | Skills for codebase safety |
| `matt` | [mattpocock/skills](https://github.com/mattpocock/skills) | Daily debugging shortcuts |
| `karpathy` | [jy-tan/andrej-karpathy-skills](https://github.com/jy-tan/andrej-karpathy-skills) | Karpathy-style guidelines |

## How source repos are structured

ADT auto-discovers content in any git repo using these conventions:

```
your-skill-repo/
├── skills/           # dirs with SKILL.md → installed as skills
├── agents/           # .md files → installed as agents
├── rules/            # .mdc files (recursive) → installed as rules (Cursor only)
├── hooks/            # hook scripts/dirs → installed as hooks
└── CLAUDE.md         # inserted as a marker block in ~/.claude/CLAUDE.md
```

No special config needed. ADT scans for these directories automatically.

## Key behaviors

- **Never destroys what isn't yours** — ADT tracks every symlink it creates in `~/.adt/.manifest.json` and only removes its own entries
- **Idempotent** — installing an already-installed item is a no-op
- **Clean uninstall** — removes every symlink, CLAUDE.md block, and `~/.adt/` with no orphans
- **Collision-safe** — if a real file exists at the link destination, ADT warns and skips (never overwrites)

## Runtime directory

```
~/.adt/
├── sources/              # Cloned git repos
├── .manifest.json        # Every symlink ADT created
├── .state.json           # Harness config and user sources
└── catalog-remote.json   # Cached remote catalog
```
