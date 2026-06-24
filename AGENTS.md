# Agent Guidelines

## Project context

This is a single-file CLI tool (`bin/adt.js`, ~1400 lines, zero dependencies). All logic lives there. Do not split it into multiple files unless explicitly asked.

## Before making changes

- Read `bin/adt.js` from the relevant section; don't rewrite unrelated areas
- The harness directory mappings are at the top — update both `globalHarnessDirs()` and `projectHarnessDirs()` if adding a new harness

## Testing

There is no automated test suite. Verify changes manually:

```bash
node bin/adt.js --help
node bin/adt.js <command> --dry-run  # where supported
```

## What not to do

- Do not add npm dependencies
- Do not split `bin/adt.js` into modules
- Do not add a build step
- Do not modify `catalog.json` without being asked — it maps source aliases to git URLs
