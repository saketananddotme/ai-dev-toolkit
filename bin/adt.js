#!/usr/bin/env node
'use strict';

// ─── Stdlib ───────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const https = require('node:https');
const { execSync, spawnSync } = require('node:child_process');

// ─── Paths ────────────────────────────────────────────────────────────────────

const PKG_DIR = path.resolve(__dirname, '..');
const HOME = process.env.HOME || process.env.USERPROFILE;
const ADT_DIR = path.join(HOME, '.adt');
const SOURCES_DIR = path.join(ADT_DIR, 'sources');
const MANIFEST_FILE = path.join(ADT_DIR, '.manifest.json');
const STATE_FILE = path.join(ADT_DIR, '.state.json');
const REMOTE_CATALOG_FILE = path.join(ADT_DIR, 'catalog-remote.json');
const LOCAL_CATALOG_FILE = path.join(PKG_DIR, 'catalog.json');

// Harness directory layouts.
// Global scope writes to ~/.cursor/, ~/.claude/, ~/.codex/.
// Project scope writes to <project>/.cursor/, <project>/.claude/, but Claude Code reads
// project memory from <project>/CLAUDE.md (root-level), not <project>/.claude/CLAUDE.md.
function globalHarnessDirs() {
  return {
    cursor: {
      rules: path.join(HOME, '.cursor', 'rules'),
      skills: path.join(HOME, '.cursor', 'skills'),
      agents: path.join(HOME, '.cursor', 'agents'),
      hooks: path.join(HOME, '.cursor', 'hooks'),
    },
    claude: {
      skills: path.join(HOME, '.claude', 'skills'),
      agents: path.join(HOME, '.claude', 'agents'),
      hooks: path.join(HOME, '.claude', 'hooks'),
      claudeMd: path.join(HOME, '.claude', 'CLAUDE.md'),
    },
    codex: {
      skills: path.join(HOME, '.codex', 'skills'),
      agents: path.join(HOME, '.codex', 'agents'),
    },
  };
}

function projectHarnessDirs(projectRoot) {
  return {
    cursor: {
      rules: path.join(projectRoot, '.cursor', 'rules'),
      skills: path.join(projectRoot, '.cursor', 'skills'),
      agents: path.join(projectRoot, '.cursor', 'agents'),
      hooks: path.join(projectRoot, '.cursor', 'hooks'),
    },
    claude: {
      skills: path.join(projectRoot, '.claude', 'skills'),
      agents: path.join(projectRoot, '.claude', 'agents'),
      hooks: path.join(projectRoot, '.claude', 'hooks'),
      claudeMd: path.join(projectRoot, 'CLAUDE.md'),
    },
    codex: {
      skills: path.join(projectRoot, '.codex', 'skills'),
      agents: path.join(projectRoot, '.codex', 'agents'),
    },
  };
}

const HARNESS_NAMES = ['cursor', 'claude', 'codex'];

// Maps content type → harness → subdirectory key
const TYPE_HARNESS_MAP = {
  skill: { cursor: 'skills', claude: 'skills', codex: 'skills' },
  agent: { cursor: 'agents', claude: 'agents', codex: 'agents' },
  rule: { cursor: 'rules' },
  hook: { cursor: 'hooks', claude: 'hooks' },
};

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_SKIP_BUCKETS = ['deprecated', 'in-progress'];

// ─── Colours ─────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

const ok = (msg) => console.log(`  ${C.green}✓${C.reset} ${msg}`);
const warn = (msg) => console.log(`  ${C.yellow}⚠${C.reset}  ${msg}`);
const err = (msg) => console.log(`  ${C.red}✗${C.reset} ${msg}`);
const info = (msg) => console.log(`  ${C.dim}${msg}${C.reset}`);
const header = (msg) => console.log(`\n${C.bold}${msg}${C.reset}`);
const skip = (msg) => console.log(`  ${C.dim}–${C.reset} ${msg} ${C.dim}(already installed)${C.reset}`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function prompt(rl, question, defaultValue) {
  const hint = defaultValue != null && defaultValue !== '' ? ` ${C.dim}[${defaultValue}]${C.reset}` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${hint}: `, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed === '' ? (defaultValue ?? '') : trimmed);
    });
  });
}

function promptYesNo(rl, question, defaultYes) {
  const def = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`${question} (${def}): `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
  });
}

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function diskSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  try {
    const result = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
    const kb = parseInt(result.stdout.split('\t')[0], 10);
    return isNaN(kb) ? 0 : kb * 1024;
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function detectHarnesses() {
  return HARNESS_NAMES.filter((h) => fs.existsSync(path.join(HOME, `.${h}`)));
}

// ─── State ────────────────────────────────────────────────────────────────────
// .state.json: harnesses[], userSources{}, catalogFetchedAt

const DEFAULT_STATE = { harnesses: [], userSources: {}, catalogFetchedAt: 0 };

function readState() {
  if (!fs.existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(state) {
  mkdirp(ADT_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
// Schema:
//   { version, items: [{ path, source, type, name, harness, scope, projectRoot?, contentHash? }] }
// scope is 'global' or 'project'. projectRoot is set only when scope === 'project'.

const MANIFEST_VERSION = 2;

function readManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return { version: MANIFEST_VERSION, items: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    const items = Array.isArray(raw.items) ? raw.items : [];
    return { version: MANIFEST_VERSION, items };
  } catch {
    return { version: MANIFEST_VERSION, items: [] };
  }
}

function writeManifest(manifest) {
  mkdirp(ADT_DIR);
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
}

function addManifestEntry(manifest, entry) {
  // Remove stale entry first (idempotent)
  manifest.items = manifest.items.filter((i) => i.path !== entry.path);
  manifest.items.push(entry);
}

function removeManifestEntries(manifest, predicate) {
  const removed = manifest.items.filter(predicate);
  manifest.items = manifest.items.filter((i) => !predicate(i));
  return removed;
}

function findManifestEntries(manifest, predicate) {
  return manifest.items.filter(predicate);
}

// ─── Scope detection ──────────────────────────────────────────────────────────
// Walk up from cwd looking for a project marker.
// First pass prefers .adt (explicit intent); second pass falls back to .git.
// Never treat $HOME as a project root.

function detectScope(cwd, opts = {}) {
  if (opts.forceGlobal) return { kind: 'global' };
  const start = path.resolve(cwd);
  const passes = [
    (dir) => fs.existsSync(path.join(dir, '.adt')),
    // .git may be a directory or a file (worktrees) — existsSync handles both.
    (dir) => fs.existsSync(path.join(dir, '.git')),
  ];
  for (const matches of passes) {
    let cur = start;
    while (true) {
      if (cur === HOME) break;
      if (matches(cur)) return { kind: 'project', root: cur };
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return { kind: 'global' };
}

function scopeContext(scope) {
  if (scope.kind === 'global') {
    return { kind: 'global', harnessDirs: globalHarnessDirs() };
  }
  return { kind: 'project', root: scope.root, harnessDirs: projectHarnessDirs(scope.root) };
}

// ─── Project config (.adt, jsonl) ─────────────────────────────────────────────

function projectConfigPath(root) { return path.join(root, '.adt'); }

function readProjectConfig(root) {
  const file = projectConfigPath(root);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return entries;
}

function writeProjectConfig(root, entries) {
  const file = projectConfigPath(root);
  if (entries.length === 0) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, body);
}

function addProjectConfigEntry(root, entry) {
  const entries = readProjectConfig(root);
  const idx = entries.findIndex((e) => e.source === entry.source && (e.item || null) === (entry.item || null));
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  writeProjectConfig(root, entries);
}

function removeProjectConfigEntries(root, predicate) {
  const entries = readProjectConfig(root);
  const remaining = entries.filter((e) => !predicate(e));
  writeProjectConfig(root, remaining);
  return entries.length - remaining.length;
}

// ─── .gitignore management ────────────────────────────────────────────────────

const GITIGNORE_BEGIN = '# BEGIN ADT';
const GITIGNORE_END = '# END ADT';
const GITIGNORE_DEFAULT_ENTRIES = ['.adt', '.claude/', '.cursor/', '.codex/'];

function ensureGitignore(root, entries = GITIGNORE_DEFAULT_ENTRIES) {
  const file = path.join(root, '.gitignore');
  let existing = '';
  if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf8');
  if (existing.includes(GITIGNORE_BEGIN)) return false; // already managed
  const block = `${existing && !existing.endsWith('\n') ? '\n' : ''}${GITIGNORE_BEGIN}\n${entries.join('\n')}\n${GITIGNORE_END}\n`;
  fs.writeFileSync(file, existing + block);
  return true;
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

function loadLocalCatalog() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_CATALOG_FILE, 'utf8'));
  } catch {
    return { version: 1, sources: {} };
  }
}

async function fetchRemoteCatalog(remoteUrl, force = false) {
  const state = readState();
  const cached = fs.existsSync(REMOTE_CATALOG_FILE);
  const age = Date.now() - (state.catalogFetchedAt || 0);
  if (cached && !force && age < CATALOG_TTL_MS) {
    try { return JSON.parse(fs.readFileSync(REMOTE_CATALOG_FILE, 'utf8')); } catch {}
  }
  try {
    const raw = await fetchUrl(remoteUrl);
    const data = JSON.parse(raw);
    mkdirp(ADT_DIR);
    fs.writeFileSync(REMOTE_CATALOG_FILE, JSON.stringify(data, null, 2) + '\n');
    state.catalogFetchedAt = Date.now();
    writeState(state);
    return data;
  } catch {
    if (cached) {
      try { return JSON.parse(fs.readFileSync(REMOTE_CATALOG_FILE, 'utf8')); } catch {}
    }
    return null;
  }
}

async function getCatalog(opts = {}) {
  const local = loadLocalCatalog();
  let remote = null;
  if (local.remote_url && !opts.offlineOnly) {
    remote = await fetchRemoteCatalog(local.remote_url, opts.force);
  }
  const state = readState();
  // Merge: remote > local built-in > user sources
  const merged = { ...local.sources };
  if (remote && remote.sources) Object.assign(merged, remote.sources);
  // User-added sources take precedence
  Object.assign(merged, state.userSources || {});
  return merged;
}

// ─── Auto-discovery ───────────────────────────────────────────────────────────

function loadSkipBuckets() {
  const local = loadLocalCatalog();
  return new Set(Array.isArray(local.skipBuckets) ? local.skipBuckets : DEFAULT_SKIP_BUCKETS);
}

function scanSkills(dir, out, skipBuckets) {
  // A directory with SKILL.md *is* the skill; don't recurse further.
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
    const name = path.basename(dir);
    if (!out.find((s) => s.name === name)) out.push({ name, path: dir });
    return;
  }
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (skipBuckets.has(entry)) continue;
    const full = path.join(dir, entry);
    try {
      if (fs.lstatSync(full).isDirectory()) scanSkills(full, out, skipBuckets);
    } catch {}
  }
}

function discoverSource(sourceDir) {
  const result = { skills: [], agents: [], rules: [], hooks: [], hasCLAUDEMd: false };
  if (!fs.existsSync(sourceDir)) return result;

  // Skills: recursively walk skills/ for any directory containing SKILL.md.
  // Bucket folders listed in catalog.skipBuckets (e.g. deprecated, in-progress) are pruned.
  const skipBuckets = loadSkipBuckets();
  const skillsDir = path.join(sourceDir, 'skills');
  if (fs.existsSync(skillsDir)) scanSkills(skillsDir, result.skills, skipBuckets);

  // Agents: .md files in agents/
  const agentsDir = path.join(sourceDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (file.endsWith('.md') && file !== 'README.md') {
        result.agents.push({ name: file.replace(/\.md$/, ''), path: path.join(agentsDir, file) });
      }
    }
  }

  // Rules: .mdc files (recursive under rules/)
  const rulesDir = path.join(sourceDir, 'rules');
  if (fs.existsSync(rulesDir)) {
    function scanRules(dir) {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.lstatSync(full).isDirectory()) {
          scanRules(full);
        } else if (entry.endsWith('.mdc')) {
          result.rules.push({ name: entry, path: full });
        }
      }
    }
    scanRules(rulesDir);
  }

  // Hooks: directories in hooks/ that contain scripts, or hook scripts directly
  const hooksDir = path.join(sourceDir, 'hooks');
  if (fs.existsSync(hooksDir)) {
    for (const entry of fs.readdirSync(hooksDir)) {
      const full = path.join(hooksDir, entry);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        result.hooks.push({ name: entry, path: full, isDir: true });
      } else if (!entry.endsWith('.json') && !entry.endsWith('.md')) {
        result.hooks.push({ name: entry, path: full, isDir: false });
      }
    }
  }

  // CLAUDE.md
  if (fs.existsSync(path.join(sourceDir, 'CLAUDE.md'))) {
    result.hasCLAUDEMd = true;
  }

  return result;
}

// ─── Harness linking ──────────────────────────────────────────────────────────

function createSymlink(src, dest) {
  // Edge case #2: real file blocks
  try {
    const stat = fs.lstatSync(dest);
    if (!stat.isSymbolicLink()) {
      return { ok: false, reason: 'collision' };
    }
    const current = fs.readlinkSync(dest);
    if (current === src) return { ok: true, reason: 'already' };
    fs.unlinkSync(dest);
  } catch {
    // dest doesn't exist — fall through
  }
  try {
    mkdirp(path.dirname(dest));
    fs.symlinkSync(src, dest);
    // Edge case #12: chmod scripts
    const scriptsDir = path.join(src, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      try { execSync(`chmod +x "${scriptsDir}"/*.sh 2>/dev/null`); } catch {}
    }
    return { ok: true, reason: 'created' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function removeSymlink(linkPath) {
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
      return true;
    }
  } catch {}
  return false;
}

// Install one item into all configured harnesses using the provided harness dir map.
// harnessDirs is the output of globalHarnessDirs() or projectHarnessDirs(root).
// Returns { linked: string[], skipped: string[], collisions: string[], errors: string[], destPaths: { [harness]: string } }
function linkItemToHarnesses(item, harnesses, harnessDirs) {
  const linked = [], skipped = [], collisions = [], errors = [];
  const destPaths = {};
  const typeMap = TYPE_HARNESS_MAP[item.type];
  if (!typeMap) return { linked, skipped, collisions, errors, destPaths };

  for (const harness of harnesses) {
    const subdirKey = typeMap[harness];
    if (!subdirKey) continue;
    const harnessBase = harnessDirs[harness];
    if (!harnessBase) continue;
    const targetDir = harnessBase[subdirKey];
    if (!targetDir) continue;

    // For rules (.mdc files) the dest is file, not dir
    const isFile = item.type === 'rule' || (item.type === 'agent' && !fs.lstatSync(item.srcPath).isDirectory());
    const destName = isFile ? path.basename(item.srcPath) : item.name;
    const destPath = path.join(targetDir, destName);
    destPaths[harness] = destPath;

    const result = createSymlink(item.srcPath, destPath);
    if (result.ok && result.reason === 'created') linked.push(harness);
    else if (result.ok && result.reason === 'already') skipped.push(harness);
    else if (result.reason === 'collision') collisions.push(harness);
    else errors.push(`${harness}: ${result.reason}`);
  }
  return { linked, skipped, collisions, errors, destPaths };
}

// ─── CLAUDE.md markers ────────────────────────────────────────────────────────

function markerStart(sourceName) { return `<!-- ADT:${sourceName}:START -->`; }
function markerEnd(sourceName) { return `<!-- ADT:${sourceName}:END -->`; }

function insertClaudeMdBlock(claudeMdPath, sourceName, content) {
  mkdirp(path.dirname(claudeMdPath));
  const block = `\n${markerStart(sourceName)}\n\n${content.trim()}\n\n${markerEnd(sourceName)}\n`;
  const contentHash = crypto.createHash('sha256').update(content.trim()).digest('hex');

  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf8');
    if (existing.includes(markerStart(sourceName))) {
      return { already: true };
    }
    fs.appendFileSync(claudeMdPath, block);
  } else {
    fs.writeFileSync(claudeMdPath, block);
  }
  return { contentHash };
}

// Edge case #8: detect if user modified block content
function claudeMdBlockEdited(claudeMdPath, sourceName, originalHash) {
  if (!fs.existsSync(claudeMdPath)) return false;
  const content = fs.readFileSync(claudeMdPath, 'utf8');
  const start = markerStart(sourceName);
  const end = markerEnd(sourceName);
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1) return false;
  const inner = content.slice(startIdx + start.length, endIdx).trim();
  const currentHash = crypto.createHash('sha256').update(inner).digest('hex');
  return currentHash !== originalHash;
}

async function removeClaudeMdBlock(claudeMdPath, sourceName, originalHash, autoYes) {
  if (!fs.existsSync(claudeMdPath)) return;
  const content = fs.readFileSync(claudeMdPath, 'utf8');
  const start = markerStart(sourceName);
  const end = markerEnd(sourceName);
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1) return;

  if (originalHash && claudeMdBlockEdited(claudeMdPath, sourceName, originalHash)) {
    if (!autoYes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const preserve = await promptYesNo(rl, `  ${C.yellow}CLAUDE.md marker block for "${sourceName}" was manually edited. Preserve your edits?${C.reset}`, true);
      rl.close();
      if (preserve) {
        info(`Preserving edited CLAUDE.md block for "${sourceName}".`);
        return;
      }
    }
  }

  const after = endIdx !== -1 ? endIdx + end.length : content.length;
  const before = content.slice(0, startIdx).replace(/\n+$/, '');
  const rest = content.slice(after);
  fs.writeFileSync(claudeMdPath, before + (rest.startsWith('\n') ? rest : '\n' + rest));
}

// ─── Source management ────────────────────────────────────────────────────────

function getSourceDir(sourceName) {
  return path.join(SOURCES_DIR, sourceName);
}

async function cloneOrPullSource(sourceName, repoUrl, ref = 'main') {
  const destDir = getSourceDir(sourceName);
  mkdirp(SOURCES_DIR);

  if (fs.existsSync(destDir)) {
    // Edge case #3: warn on local changes
    const statusResult = git(['status', '--porcelain'], destDir);
    if (statusResult.stdout.trim()) {
      warn(`Source "${sourceName}" has local changes. These will be overwritten on pull.`);
    }
    info(`Pulling ${sourceName}...`);
    const pull = git(['pull', '--ff-only', 'origin', ref], destDir);
    if (pull.code !== 0) {
      // Try reset
      git(['fetch', 'origin', ref], destDir);
      git(['reset', '--hard', `origin/${ref}`], destDir);
    }
    return { action: 'pulled', dir: destDir };
  }

  info(`Cloning ${sourceName} from ${repoUrl}...`);
  mkdirp(destDir);
  // Try with explicit branch first, fall back to default branch
  let clone = git(['clone', '--depth', '1', '--branch', ref, repoUrl, destDir]);
  if (clone.code !== 0) {
    clone = git(['clone', '--depth', '1', repoUrl, destDir]);
  }
  if (clone.code !== 0) {
    // Edge case #6: clean up partial clone
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
    throw new Error(`Failed to clone ${sourceName}: ${clone.stderr.trim()}`);
  }
  return { action: 'cloned', dir: destDir };
}

// ─── Install / Remove ─────────────────────────────────────────────────────────

// Create symlinks for items from a cloned source, scoped to either global or project.
// scopeCtx: { kind: 'global'|'project', root?: string, harnessDirs: object }
// Returns { results: { installed, skipped, collisions, errors }, discovered }
async function applyLinks(sourceName, harnesses, scopeCtx, filterItem = null) {
  const sourceDir = getSourceDir(sourceName);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source "${sourceName}" not installed locally. Run: adt install ${sourceName}`);
  }

  const discovered = discoverSource(sourceDir);
  const manifest = readManifest();
  const results = { installed: [], skipped: [], collisions: [], errors: [] };
  const { kind: scope, root: projectRoot, harnessDirs } = scopeCtx;

  const allItems = [
    ...discovered.skills.map((s) => ({ ...s, type: 'skill', srcPath: s.path })),
    ...discovered.agents.map((a) => ({ ...a, type: 'agent', srcPath: a.path })),
    ...discovered.rules.map((r) => ({ ...r, type: 'rule', srcPath: r.path })),
    ...discovered.hooks.map((h) => ({ ...h, type: 'hook', srcPath: h.path })),
  ];

  for (const item of allItems) {
    if (filterItem && item.name !== filterItem) continue;

    const { linked, skipped, collisions, errors, destPaths } = linkItemToHarnesses(item, harnesses, harnessDirs);

    if (linked.length > 0) {
      for (const harness of linked) {
        const destPath = destPaths[harness];
        if (!destPath) continue;
        const entry = {
          path: destPath,
          source: sourceName,
          type: item.type,
          name: item.name,
          harness,
          scope,
        };
        if (scope === 'project') entry.projectRoot = projectRoot;
        addManifestEntry(manifest, entry);
      }
      results.installed.push({ name: `${sourceName}/${item.name}`, type: item.type, harnesses: linked });
    }
    if (skipped.length > 0) results.skipped.push(`${sourceName}/${item.name}`);
    collisions.forEach((h) => results.collisions.push({ item: `${sourceName}/${item.name}`, harness: h }));
    errors.forEach((e) => results.errors.push(e));
  }

  // CLAUDE.md — only when applying the whole source (not a single item filter)
  if (discovered.hasCLAUDEMd && !filterItem && harnesses.includes('claude') && harnessDirs.claude?.claudeMd) {
    const claudeMdSrc = path.join(sourceDir, 'CLAUDE.md');
    const claudeMdDest = harnessDirs.claude.claudeMd;
    const manifestKey = `${claudeMdDest}#marker:${sourceName}`;
    const existing = findManifestEntries(
      manifest,
      (i) => i.type === 'claudemd' && i.path === manifestKey,
    );
    if (existing.length === 0) {
      const content = fs.readFileSync(claudeMdSrc, 'utf8');
      const insertResult = insertClaudeMdBlock(claudeMdDest, sourceName, content);
      if (!insertResult.already) {
        const entry = {
          path: manifestKey,
          source: sourceName,
          type: 'claudemd',
          name: sourceName,
          harness: 'claude',
          scope,
          contentHash: insertResult.contentHash,
        };
        if (scope === 'project') entry.projectRoot = projectRoot;
        addManifestEntry(manifest, entry);
        results.installed.push({ name: `${sourceName}/CLAUDE.md`, type: 'memory', harnesses: ['claude'] });
      } else {
        results.skipped.push(`${sourceName}/CLAUDE.md`);
      }
    }
  }

  writeManifest(manifest);
  return { results, discovered };
}

async function removeItems(predicate, autoYes = false) {
  const manifest = readManifest();
  const toRemove = findManifestEntries(manifest, predicate);
  const removed = [], errors = [];

  for (const entry of toRemove) {
    if (entry.type === 'claudemd') {
      const [mdPath, markerKey] = entry.path.split('#marker:');
      await removeClaudeMdBlock(mdPath, markerKey, entry.contentHash, autoYes);
      removed.push(entry.path);
    } else {
      if (removeSymlink(entry.path)) {
        removed.push(entry.path);
      } else {
        errors.push(entry.path);
      }
    }
  }

  removeManifestEntries(manifest, predicate);
  writeManifest(manifest);
  return { removed, errors };
}

// ─── Repair broken symlinks after update ──────────────────────────────────────

function repairManifest() {
  const manifest = readManifest();
  const broken = [];
  for (const entry of manifest.items) {
    if (entry.type === 'claudemd') continue;
    try {
      const stat = fs.lstatSync(entry.path);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(entry.path);
        if (!fs.existsSync(target)) broken.push(entry);
      }
    } catch {
      broken.push(entry);
    }
  }
  if (broken.length > 0) {
    // Edge case #4 & #5: remove dead entries
    for (const b of broken) {
      warn(`Removing broken link: ${path.basename(b.path)} (${b.source}/${b.name}) — target deleted upstream`);
      try { fs.unlinkSync(b.path); } catch {}
    }
    removeManifestEntries(manifest, (i) => broken.some((b) => b.path === i.path));
    writeManifest(manifest);
  }
  return broken;
}

// ─── Command: init ────────────────────────────────────────────────────────────

async function cmdInit(args) {
  const autoYes = args.includes('--yes') || args.includes('-y');
  header('ADT — init');

  const rl = autoYes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const detected = detectHarnesses();
    let harnesses = detected;

    if (!autoYes) {
      console.log(`\n  Detected harnesses: ${detected.length ? detected.join(', ') : 'none'}`);
      const answer = await prompt(rl, `  Which harnesses to configure? (comma-separated)`, detected.join(', '));
      harnesses = answer.split(',').map((s) => s.trim()).filter((h) => HARNESS_NAMES.includes(h));
    }

    if (harnesses.length === 0) {
      warn('No valid harnesses selected. Run: adt init again or add harness dirs first.');
      return;
    }

    const state = readState();
    state.harnesses = harnesses;
    writeState(state);
    ok(`Configured harnesses: ${harnesses.join(', ')}`);

    // Fetch catalog
    info('Fetching remote catalog...');
    const catalog = await getCatalog({ force: true });
    const sourceNames = Object.keys(catalog);
    console.log(`  Available sources: ${sourceNames.join(', ')}`);

    if (!autoYes) {
      const toInstall = await prompt(rl, '  Install + use globally now? (space or comma-separated names, or Enter to skip)', '');
      const names = toInstall.split(/[\s,]+/).filter(Boolean);
      for (const name of names) {
        if (!catalog[name]) { warn(`Unknown source: ${name}. Use "adt source add ${name} <url>" to add custom sources.`); continue; }
        try {
          await cloneOrPullSource(name, catalog[name].repo, catalog[name].ref || 'main');
          ok(`Installed source "${name}"`);
        } catch (e) { err(`Failed to install ${name}: ${e.message}`); continue; }
        await cmdUse([name, '--global']);
      }
    }

    console.log(`\n${C.green}${C.bold}Init complete.${C.reset}`);
    info('Install a source:    adt install <source>      (clones it locally)');
    info('Activate globally:   adt use --global <source>');
    info('Activate in project: cd to project, then adt use <source>');
    info('List installed:      adt list --installed');
  } finally {
    if (rl) rl.close();
  }
}

// ─── Command: source ──────────────────────────────────────────────────────────

async function cmdSourceAdd(args, silent = false) {
  const [name, url, ref = 'main'] = args;
  if (!name || !url) {
    console.log('\nUsage: adt source add <name> <url> [ref]\n');
    process.exit(1);
  }

  if (!silent) header(`ADT — source add "${name}"`);

  const state = readState();
  state.userSources = state.userSources || {};
  state.userSources[name] = { repo: url, label: name, ref };
  writeState(state);

  try {
    const r = await cloneOrPullSource(name, url, ref);
    ok(`Source "${name}" ${r.action} → ${r.dir}`);
    const discovered = discoverSource(r.dir);
    info(`Discovered: ${discovered.skills.length} skills, ${discovered.agents.length} agents, ${discovered.rules.length} rules, ${discovered.hooks.length} hooks${discovered.hasCLAUDEMd ? ', 1 CLAUDE.md' : ''}`);
  } catch (e) {
    err(`Failed to add source "${name}": ${e.message}`);
    // Remove from state on failure
    delete state.userSources[name];
    writeState(state);
    process.exit(1);
  }
}

async function cmdSourceRemove(args) {
  const [name] = args;
  if (!name) { console.log('\nUsage: adt source remove <name>\n'); process.exit(1); }
  header(`ADT — source remove "${name}"`);

  // Collect affected project roots before deletion for transparency.
  const manifestBefore = readManifest();
  const projectRoots = [
    ...new Set(
      manifestBefore.items
        .filter((i) => i.source === name && i.scope === 'project' && i.projectRoot)
        .map((i) => i.projectRoot),
    ),
  ];

  // Remove all installed items for this source across every scope.
  await removeItems((i) => i.source === name, true);

  // Drop .adt entries from each project root we touched.
  for (const root of projectRoots) {
    if (!fs.existsSync(root)) continue;
    removeProjectConfigEntries(root, (e) => e.source === name);
  }
  if (projectRoots.length > 0) {
    info(`Cleaned project symlinks across ${projectRoots.length} root(s):`);
    projectRoots.forEach((r) => info(`  ${r}`));
  }

  // Remove cloned dir
  const sourceDir = getSourceDir(name);
  if (fs.existsSync(sourceDir)) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    ok(`Removed ${sourceDir}`);
  }

  // Remove from user sources
  const state = readState();
  delete (state.userSources || {})[name];
  writeState(state);
  ok(`Source "${name}" removed.`);
}

async function cmdSourceList() {
  const catalog = await getCatalog();
  header('ADT — sources');
  const state = readState();
  for (const [name, src] of Object.entries(catalog)) {
    const cloned = fs.existsSync(getSourceDir(name));
    const tag = state.userSources?.[name] ? `${C.cyan}[custom]${C.reset}` : `${C.dim}[built-in]${C.reset}`;
    const clonedTag = cloned ? `${C.green}✓ cloned${C.reset}` : `${C.dim}not cloned${C.reset}`;
    console.log(`  ${C.bold}${name}${C.reset} ${tag}  ${clonedTag}`);
    info(`  ${src.label || src.repo}`);
  }
}

async function cmdSourceUpdate(args) {
  const targetName = args[0];
  const catalog = await getCatalog();
  const state = readState();
  const toUpdate = targetName ? [targetName] : Object.keys(catalog).filter((n) => fs.existsSync(getSourceDir(n)));

  header(`ADT — source update${targetName ? ` "${targetName}"` : ' (all)'}`);

  for (const name of toUpdate) {
    const src = catalog[name];
    if (!src) { warn(`Unknown source: ${name}`); continue; }
    try {
      const r = await cloneOrPullSource(name, src.repo, src.ref || 'main');
      ok(`${name}: ${r.action}`);
      const broken = repairManifest();
      if (broken.length > 0) warn(`${broken.length} broken link(s) cleaned for ${name}`);
    } catch (e) {
      err(`Failed to update ${name}: ${e.message}`);
    }
  }
}

async function cmdSource(args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'add':    await cmdSourceAdd(rest); break;
    case 'remove': await cmdSourceRemove(rest); break;
    case 'list':   await cmdSourceList(); break;
    case 'update': await cmdSourceUpdate(rest); break;
    default:
      console.log('\nUsage: adt source <add|remove|list|update> [args]\n');
      process.exit(1);
  }
}

// ─── Command: install (clone only — does NOT create symlinks) ────────────────

async function cmdInstall(args, silent = false) {
  const target = args[0];
  if (!target) { console.log('\nUsage: adt install <source>\n'); process.exit(1); }

  // Bare source name only — `install` is for making the source available.
  // Use `adt use <source>[/<item>]` afterwards to activate.
  if (target.includes('/')) {
    err('`adt install` takes a source name only. To activate a single item, run: adt use <source>/<item>');
    process.exit(1);
  }
  const sourceName = target;

  if (!silent) header(`ADT — install "${sourceName}"`);

  const state = readState();
  const catalog = await getCatalog({ offlineOnly: false });
  const src = catalog[sourceName] || state.userSources?.[sourceName];
  if (!src) {
    err(`Unknown source "${sourceName}". Add it first: adt source add ${sourceName} <url>`);
    process.exit(1);
  }

  try {
    const r = await cloneOrPullSource(sourceName, src.repo, src.ref || 'main');
    ok(`Source "${sourceName}" ${r.action} → ${r.dir}`);
  } catch (e) {
    err(`Cannot install "${sourceName}": ${e.message}`);
    process.exit(1);
  }

  const discovered = discoverSource(getSourceDir(sourceName));
  info(`Discovered: ${discovered.skills.length} skills, ${discovered.agents.length} agents, ${discovered.rules.length} rules, ${discovered.hooks.length} hooks${discovered.hasCLAUDEMd ? ', 1 CLAUDE.md' : ''}`);

  if (!silent) {
    console.log(`\n  ${C.green}Done.${C.reset} Activate with:`);
    info(`  adt use ${sourceName}            (project scope if inside a project, else global)`);
    info(`  adt use --global ${sourceName}   (force global)`);
  }
}

// ─── Command: use / unuse ─────────────────────────────────────────────────────

function parseScopeArgs(args) {
  const forceGlobal = args.includes('--global') || args.includes('-g');
  const positional = args.filter((a) => !a.startsWith('-'));
  return { forceGlobal, positional };
}

function harnessesForScope(scopeCtx, state) {
  // Always use the user's configured global harness list as the set to wire up.
  // For project scope this rewires the same harnesses but rooted in the project dir.
  if (state.harnesses && state.harnesses.length > 0) return state.harnesses;
  // Fall back to detection if state was never configured.
  return detectHarnesses();
}

async function cmdUse(args) {
  const { forceGlobal, positional } = parseScopeArgs(args);
  const target = positional[0];

  // Auto-init harnesses on first use
  const stateInit = readState();
  if (stateInit.harnesses.length === 0) {
    info('No harnesses configured. Running init first...');
    await cmdInit(['--yes']);
  }
  const state = readState();
  const scope = detectScope(process.cwd(), { forceGlobal });
  const ctx = scopeContext(scope);
  const harnesses = harnessesForScope(ctx, state);

  // Bootstrap mode: `adt use` with no args inside a project replays .adt
  if (!target) {
    if (scope.kind !== 'project') {
      console.log('\nUsage: adt use <source>[/<item>] [--global]\n');
      console.log('Run inside a project directory with no args to re-apply its .adt entries.');
      process.exit(1);
    }
    const entries = readProjectConfig(scope.root);
    if (entries.length === 0) {
      info(`No .adt entries in ${scope.root}. Add some with: adt use <source>`);
      return;
    }
    header(`ADT — use (bootstrap from .adt in ${scope.root})`);
    for (const entry of entries) {
      await applyAndReport(entry.source, entry.item || null, ctx, harnesses, scope, /*writeConfig*/ false);
    }
    return;
  }

  const [sourceName, itemName] = target.includes('/') ? target.split('/') : [target, null];

  if (!fs.existsSync(getSourceDir(sourceName))) {
    err(`Source "${sourceName}" is not installed locally. Run: adt install ${sourceName}`);
    process.exit(1);
  }

  header(`ADT — use "${target}" (${scope.kind}${scope.kind === 'project' ? `: ${scope.root}` : ''})`);
  await applyAndReport(sourceName, itemName, ctx, harnesses, scope, /*writeConfig*/ true);
}

async function applyAndReport(sourceName, itemName, ctx, harnesses, scope, writeConfig) {
  const { results } = await applyLinks(sourceName, harnesses, ctx, itemName);

  for (const item of results.installed) {
    ok(`${item.name} (${item.type}) → ${item.harnesses.join(', ')}`);
  }
  for (const s of results.skipped) skip(s);
  for (const c of results.collisions) {
    warn(`${c.item} — collision in ${c.harness} (real file exists, skipped)`);
  }
  for (const e of results.errors) err(e);

  if (scope.kind === 'project' && writeConfig) {
    const entry = { source: sourceName, added: new Date().toISOString() };
    if (itemName) entry.item = itemName;
    addProjectConfigEntry(scope.root, entry);
    const wroteGitignore = ensureGitignore(scope.root);
    if (wroteGitignore) info(`Added ADT block to ${path.join(scope.root, '.gitignore')}`);
  }

  const count = results.installed.length;
  const skippedCount = results.skipped.length;
  const msg = [
    count > 0 ? `${count} linked` : '',
    skippedCount > 0 ? `${skippedCount} already active` : '',
  ].filter(Boolean).join(', ');
  console.log(`  ${C.green}${sourceName}: ${msg || 'nothing new'}${C.reset}`);
}

async function cmdUnuse(args) {
  const { forceGlobal, positional } = parseScopeArgs(args);
  const target = positional[0];
  if (!target) { console.log('\nUsage: adt unuse <source>[/<item>] [--global]\n'); process.exit(1); }

  const scope = detectScope(process.cwd(), { forceGlobal });
  const [sourceName, itemName] = target.includes('/') ? target.split('/') : [target, null];

  header(`ADT — unuse "${target}" (${scope.kind}${scope.kind === 'project' ? `: ${scope.root}` : ''})`);

  const predicate = (i) => {
    if (i.source !== sourceName) return false;
    if (itemName && i.name !== itemName) return false;
    if (scope.kind === 'global') return i.scope === 'global';
    return i.scope === 'project' && i.projectRoot === scope.root;
  };

  const { removed, errors } = await removeItems(predicate);
  removed.forEach((p) => ok(`Removed: ${path.basename(p)}`));
  errors.forEach((p) => warn(`Could not remove: ${path.basename(p)}`));

  if (scope.kind === 'project') {
    const dropped = removeProjectConfigEntries(scope.root, (e) => {
      if (e.source !== sourceName) return false;
      if (itemName && e.item !== itemName) return false;
      return true;
    });
    if (dropped > 0) info(`Removed ${dropped} entry/entries from ${projectConfigPath(scope.root)}`);
  }

  console.log(`\n  ${C.green}Done.${C.reset} ${removed.length} item(s) removed.`);
}

// ─── Command: remove (deprecated alias for unuse) ─────────────────────────────

async function cmdRemove(args) {
  warn('`adt remove` is deprecated. Use `adt unuse` instead.');
  return cmdUnuse(args);
}

// ─── Command: update ──────────────────────────────────────────────────────────

async function cmdUpdate() {
  header('ADT — update');
  await cmdSourceUpdate([]);
  ok('All sources updated.');
}

// ─── Command: list ────────────────────────────────────────────────────────────

async function cmdList(args) {
  const installedOnly = args.includes('--installed');
  const globalOnly = args.includes('--global');
  const projectOnly = args.includes('--project');
  const targetSource = args.find((a) => !a.startsWith('-'));

  // Sources downloaded locally (regardless of activation)
  if (installedOnly) {
    header('ADT — installed sources (downloaded)');
    if (!fs.existsSync(SOURCES_DIR)) {
      info('Nothing installed. Run: adt install <source>');
      return;
    }
    const sources = fs.readdirSync(SOURCES_DIR).filter((n) => {
      try { return fs.lstatSync(path.join(SOURCES_DIR, n)).isDirectory(); } catch { return false; }
    });
    if (sources.length === 0) {
      info('Nothing installed. Run: adt install <source>');
      return;
    }
    for (const name of sources) {
      const d = discoverSource(path.join(SOURCES_DIR, name));
      const parts = [];
      if (d.skills.length) parts.push(`${d.skills.length} skills`);
      if (d.agents.length) parts.push(`${d.agents.length} agents`);
      if (d.rules.length) parts.push(`${d.rules.length} rules`);
      if (d.hooks.length) parts.push(`${d.hooks.length} hooks`);
      if (d.hasCLAUDEMd) parts.push('CLAUDE.md');
      console.log(`  ${C.bold}${name}${C.reset} ${C.dim}— ${parts.join(', ') || 'empty'}${C.reset}`);
    }
    return;
  }

  // Activations (scope-filtered)
  if (globalOnly || projectOnly) {
    const scopeNow = projectOnly ? detectScope(process.cwd()) : { kind: 'global' };
    if (projectOnly && scopeNow.kind !== 'project') {
      info('Not inside a project directory. Run from a project root, or use --global.');
      return;
    }
    header(`ADT — active${globalOnly ? ' (global)' : ` (project: ${scopeNow.root})`}`);
    const manifest = readManifest();
    const filtered = manifest.items.filter((i) => {
      if (globalOnly) return i.scope === 'global';
      return i.scope === 'project' && i.projectRoot === scopeNow.root;
    });
    if (filtered.length === 0) { info('Nothing active in this scope.'); return; }
    const bySource = {};
    for (const item of filtered) {
      const key = `${item.type}:${item.name}`;
      bySource[item.source] = bySource[item.source] || {};
      if (!bySource[item.source][key]) {
        bySource[item.source][key] = { type: item.type, name: item.name, harnesses: [] };
      }
      if (item.harness) bySource[item.source][key].harnesses.push(item.harness);
    }
    for (const [src, items] of Object.entries(bySource)) {
      console.log(`\n  ${C.bold}${src}${C.reset}`);
      for (const item of Object.values(items)) {
        const harnessList = item.harnesses.length ? `${C.dim}(${item.harnesses.join(', ')})${C.reset}` : '';
        console.log(`    ${item.type.padEnd(8)}  ${item.name} ${harnessList}`);
      }
    }
    return;
  }

  header('ADT — available items');
  const catalog = await getCatalog();
  const sources = targetSource ? { [targetSource]: catalog[targetSource] } : catalog;

  for (const [name, src] of Object.entries(sources)) {
    if (!src) { warn(`Unknown source: ${name}`); continue; }
    const sourceDir = getSourceDir(name);
    if (!fs.existsSync(sourceDir)) {
      console.log(`\n  ${C.bold}${name}${C.reset} ${C.dim}(not cloned — run: adt source add ${name} ${src.repo})${C.reset}`);
      continue;
    }
    const discovered = discoverSource(sourceDir);
    console.log(`\n  ${C.bold}${name}${C.reset} — ${src.label || ''}`);
    if (discovered.skills.length) {
      console.log(`    ${C.cyan}Skills (${discovered.skills.length}):${C.reset}`);
      discovered.skills.forEach((s) => console.log(`      ${name}/${s.name}`));
    }
    if (discovered.agents.length) {
      console.log(`    ${C.cyan}Agents (${discovered.agents.length}):${C.reset}`);
      discovered.agents.forEach((a) => console.log(`      ${name}/${a.name}`));
    }
    if (discovered.rules.length) {
      console.log(`    ${C.cyan}Rules (${discovered.rules.length}):${C.reset}`);
      discovered.rules.forEach((r) => console.log(`      ${name}/${r.name}`));
    }
    if (discovered.hooks.length) {
      console.log(`    ${C.cyan}Hooks (${discovered.hooks.length}):${C.reset}`);
      discovered.hooks.forEach((h) => console.log(`      ${name}/${h.name}`));
    }
    if (discovered.hasCLAUDEMd) console.log(`    ${C.cyan}CLAUDE.md${C.reset}`);
  }
}

// ─── Command: status ──────────────────────────────────────────────────────────

async function cmdStatus() {
  header('ADT — status');
  const state = readState();
  const manifest = readManifest();
  const scope = detectScope(process.cwd());

  console.log(`\n  ${C.bold}Current scope:${C.reset} ${scope.kind === 'project' ? `project (${scope.root})` : 'global'}`);
  console.log(`  ${C.bold}Harnesses:${C.reset} ${state.harnesses.length ? state.harnesses.join(', ') : 'none configured'}`);

  // Globally active
  const globalItems = manifest.items.filter((i) => i.scope === 'global');
  const globalBySource = {};
  for (const item of globalItems) {
    globalBySource[item.source] = (globalBySource[item.source] || 0) + 1;
  }
  console.log(`\n  ${C.bold}Globally active:${C.reset} ${globalItems.length} item(s) across ${Object.keys(globalBySource).length} source(s)`);
  for (const [src, count] of Object.entries(globalBySource)) {
    const sourceDir = getSourceDir(src);
    let health = `${C.dim}not cloned${C.reset}`;
    if (fs.existsSync(sourceDir)) {
      const gitLog = git(['log', '-1', '--format=%cr'], sourceDir);
      health = gitLog.stdout.trim() ? `last pulled ${gitLog.stdout.trim()}` : 'cloned';
    }
    console.log(`    ${src}: ${count} items — ${health}`);
  }

  // Project active (current scope only)
  if (scope.kind === 'project') {
    const projectItems = manifest.items.filter((i) => i.scope === 'project' && i.projectRoot === scope.root);
    const byProjSource = {};
    for (const item of projectItems) {
      byProjSource[item.source] = (byProjSource[item.source] || 0) + 1;
    }
    console.log(`\n  ${C.bold}Project active:${C.reset} ${projectItems.length} item(s) across ${Object.keys(byProjSource).length} source(s)`);
    for (const [src, count] of Object.entries(byProjSource)) {
      console.log(`    ${src}: ${count} items`);
    }
    const cfgPath = projectConfigPath(scope.root);
    if (fs.existsSync(cfgPath)) info(`Config: ${cfgPath}`);
  }

  // Project roots touched (other than current)
  const otherRoots = [...new Set(
    manifest.items
      .filter((i) => i.scope === 'project' && i.projectRoot && i.projectRoot !== scope.root)
      .map((i) => i.projectRoot),
  )];
  if (otherRoots.length > 0) {
    console.log(`\n  ${C.bold}Other project roots with ADT links:${C.reset}`);
    otherRoots.forEach((r) => info(r));
  }

  const adtSize = diskSize(ADT_DIR);
  console.log(`\n  ${C.bold}~/.adt/:${C.reset} ${formatBytes(adtSize)}`);
}

// ─── Command: uninstall ───────────────────────────────────────────────────────

async function cmdUninstall(args) {
  const autoYes = args.includes('--yes') || args.includes('-y');
  header('ADT — uninstall');

  const manifest = readManifest();
  const symlinks = manifest.items.filter((i) => i.type !== 'claudemd');
  const claudeMdEntries = manifest.items.filter((i) => i.type === 'claudemd');
  const adtSize = diskSize(ADT_DIR);

  if (manifest.items.length === 0 && !fs.existsSync(ADT_DIR)) {
    info('Nothing to remove. ADT is already uninstalled.');
    return;
  }

  console.log(`\n  This will remove:`);
  if (symlinks.length > 0) console.log(`    ${symlinks.length} symlink(s) from harness directories`);
  if (claudeMdEntries.length > 0) console.log(`    ${claudeMdEntries.length} CLAUDE.md marker block(s)`);
  if (fs.existsSync(ADT_DIR)) console.log(`    ~/.adt/ directory (${formatBytes(adtSize)})`);

  if (!autoYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirmed = await promptYesNo(rl, '\n  Are you sure?', false);
    rl.close();
    if (!confirmed) {
      info('Aborted. Nothing removed.');
      return;
    }
  }

  // Remove symlinks
  for (const entry of symlinks) {
    removeSymlink(entry.path);
  }
  if (symlinks.length > 0) ok(`Removed ${symlinks.length} symlink(s)`);

  // Remove CLAUDE.md markers
  for (const entry of claudeMdEntries) {
    const [mdPath, markerKey] = entry.path.split('#marker:');
    await removeClaudeMdBlock(mdPath, markerKey, entry.contentHash, autoYes);
  }
  if (claudeMdEntries.length > 0) ok('Removed CLAUDE.md marker block(s)');

  // Remove ~/.adt/
  if (fs.existsSync(ADT_DIR)) {
    fs.rmSync(ADT_DIR, { recursive: true, force: true });
    ok('Removed ~/.adt/');
  }

  console.log(`\n${C.green}${C.bold}ADT fully uninstalled.${C.reset}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

(async () => {
  try {
    switch (cmd) {
      case 'init':      await cmdInit(rest); break;
      case 'source':    await cmdSource(rest); break;
      case 'install':   await cmdInstall(rest); break;
      case 'use':       await cmdUse(rest); break;
      case 'unuse':     await cmdUnuse(rest); break;
      case 'remove':    await cmdRemove(rest); break;
      case 'update':    await cmdUpdate(); break;
      case 'list':      await cmdList(rest); break;
      case 'status':    await cmdStatus(); break;
      case 'uninstall': await cmdUninstall(rest); break;
      default:
        console.log(`
${C.bold}adt${C.reset} — AI skill package manager (nvm-style)

${C.cyan}Setup:${C.reset}
  adt init                          Interactive setup: detect harnesses, configure
  adt init --yes                    Non-interactive (detect defaults)

${C.cyan}Sources:${C.reset}
  adt source add <name> <url>       Add a git repo as a source
  adt source remove <name>          Remove a source (everywhere — global + projects)
  adt source list                   List all sources
  adt source update [name]          Pull latest from upstream

${C.cyan}Install (download):${C.reset}
  adt install <source>              Clone source to ~/.adt/sources/ (no symlinks yet)

${C.cyan}Use (activate):${C.reset}
  adt use <source>                  Activate — project scope if in a project, else global
  adt use <source>/<item>           Activate just one skill/agent/rule
  adt use --global <source>         Force global activation from anywhere
  adt use                           (in a project) Re-apply entries from .adt
  adt unuse <source>[/<item>]       Deactivate (scope-aware; --global to override)
  adt update                        Pull all sources and repair broken links

${C.cyan}Inspect:${C.reset}
  adt list                          Show all available items (by source)
  adt list <source>                 Show items in one source
  adt list --installed              Show downloaded sources
  adt list --global                 Show globally-active items
  adt list --project                Show items active in the current project
  adt status                        Show scope + active items (global + project)

${C.cyan}Uninstall:${C.reset}
  adt uninstall                     Interactive: remove everything ADT created

${C.cyan}Install adt itself:${C.reset}
  npm install -g @saketananddotme/adt

${C.dim}Tip: scope is auto-detected. Inside a git repo or a directory with a .adt file,
\`adt use foo\` writes project-local symlinks and updates .adt. Anywhere else it
activates globally. The .adt file is personal — it's auto-added to .gitignore.${C.reset}
`);
    }
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
})();
