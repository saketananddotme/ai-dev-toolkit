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

const HARNESS_DIRS = {
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

// Maps content type → harness → subdirectory key
const TYPE_HARNESS_MAP = {
  skill: { cursor: 'skills', claude: 'skills', codex: 'skills' },
  agent: { cursor: 'agents', claude: 'agents', codex: 'agents' },
  rule: { cursor: 'rules' },
  hook: { cursor: 'hooks', claude: 'hooks' },
};

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  return Object.keys(HARNESS_DIRS).filter((h) => {
    const base = path.join(HOME, `.${h}`);
    return fs.existsSync(base);
  });
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
// .manifest.json: { version: 1, items: [{ path, source, type, name, contentHash? }] }

const MANIFEST_VERSION = 1;

function readManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return { version: MANIFEST_VERSION, items: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    // Migrate if needed
    if (!raw.version || raw.version < MANIFEST_VERSION) {
      return { version: MANIFEST_VERSION, items: Array.isArray(raw.items) ? raw.items : [] };
    }
    return raw;
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

function discoverSource(sourceDir) {
  const result = { skills: [], agents: [], rules: [], hooks: [], hasCLAUDEMd: false };
  if (!fs.existsSync(sourceDir)) return result;

  // Skills: directories containing SKILL.md (recursive up to 2 levels)
  for (const base of ['skills', 'skills/engineering', '']) {
    const dir = base ? path.join(sourceDir, base) : sourceDir;
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory() && fs.existsSync(path.join(full, 'SKILL.md'))) {
        // Avoid duplicates
        if (!result.skills.find((s) => s.name === entry)) {
          result.skills.push({ name: entry, path: full });
        }
      }
    }
  }

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

// Install one item into all configured harnesses
// Returns { linked: string[], skipped: string[], collisions: string[], errors: string[] }
function linkItemToHarnesses(item, harnesses) {
  const linked = [], skipped = [], collisions = [], errors = [];
  const typeMap = TYPE_HARNESS_MAP[item.type];
  if (!typeMap) return { linked, skipped, collisions, errors };

  for (const harness of harnesses) {
    const subdirKey = typeMap[harness];
    if (!subdirKey) continue;
    const harnessBase = HARNESS_DIRS[harness];
    if (!harnessBase) continue;
    const targetDir = harnessBase[subdirKey];
    if (!targetDir) continue;

    // For rules (.mdc files) the dest is file, not dir
    const isFile = item.type === 'rule' || (item.type === 'agent' && !fs.lstatSync(item.srcPath).isDirectory());
    const destName = isFile ? path.basename(item.srcPath) : item.name;
    const destPath = path.join(targetDir, destName);

    const result = createSymlink(item.srcPath, destPath);
    if (result.ok && result.reason === 'created') linked.push(harness);
    else if (result.ok && result.reason === 'already') skipped.push(harness);
    else if (result.reason === 'collision') collisions.push(harness);
    else errors.push(`${harness}: ${result.reason}`);
  }
  return { linked, skipped, collisions, errors };
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

// Returns list of installed items with warnings
async function installSource(sourceName, harnesses, filterItem = null, autoYes = false) {
  const sourceDir = getSourceDir(sourceName);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source "${sourceName}" not cloned. Run: adt source add ${sourceName} <url>`);
  }

  const discovered = discoverSource(sourceDir);
  const manifest = readManifest();
  const results = { installed: [], skipped: [], collisions: [], errors: [] };

  const allItems = [
    ...discovered.skills.map((s) => ({ ...s, type: 'skill', srcPath: s.path })),
    ...discovered.agents.map((a) => ({ ...a, type: 'agent', srcPath: a.path })),
    ...discovered.rules.map((r) => ({ ...r, type: 'rule', srcPath: r.path })),
    ...discovered.hooks.map((h) => ({ ...h, type: 'hook', srcPath: h.path })),
  ];

  for (const item of allItems) {
    if (filterItem && item.name !== filterItem) continue;

    const { linked, skipped, collisions, errors } = linkItemToHarnesses(item, harnesses);

    if (linked.length > 0) {
      // Record in manifest — one entry per harness link
      for (const harness of linked) {
        const typeMap = TYPE_HARNESS_MAP[item.type];
        const subdirKey = typeMap?.[harness];
        const harnessBase = HARNESS_DIRS[harness];
        if (!subdirKey || !harnessBase) continue;
        const isFile = item.type === 'rule' || (item.type === 'agent' && !fs.lstatSync(item.srcPath).isDirectory());
        const destName = isFile ? path.basename(item.srcPath) : item.name;
        const destPath = path.join(harnessBase[subdirKey], destName);
        addManifestEntry(manifest, {
          path: destPath,
          source: sourceName,
          type: item.type,
          name: item.name,
          harness,
        });
      }
      results.installed.push({ name: `${sourceName}/${item.name}`, type: item.type, harnesses: linked });
    }
    if (skipped.length > 0) results.skipped.push(`${sourceName}/${item.name}`);
    collisions.forEach((h) => results.collisions.push({ item: `${sourceName}/${item.name}`, harness: h }));
    errors.forEach((e) => results.errors.push(e));
  }

  // CLAUDE.md
  if (discovered.hasCLAUDEMd && !filterItem) {
    const claudeMdSrc = path.join(sourceDir, 'CLAUDE.md');
    const existing = findManifestEntries(manifest, (i) => i.source === sourceName && i.type === 'claudemd');
    if (existing.length === 0 && harnesses.includes('claude')) {
      const content = fs.readFileSync(claudeMdSrc, 'utf8');
      const insertResult = insertClaudeMdBlock(HARNESS_DIRS.claude.claudeMd, sourceName, content);
      if (!insertResult.already) {
        addManifestEntry(manifest, {
          path: `${HARNESS_DIRS.claude.claudeMd}#marker:${sourceName}`,
          source: sourceName,
          type: 'claudemd',
          name: sourceName,
          contentHash: insertResult.contentHash,
        });
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
      harnesses = answer.split(',').map((s) => s.trim()).filter((h) => HARNESS_DIRS[h]);
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
      const toInstall = await prompt(rl, '  Install any sources now? (space or comma-separated names, or Enter to skip)', '');
      const names = toInstall.split(/[\s,]+/).filter(Boolean);
      for (const name of names) {
        if (!catalog[name]) { warn(`Unknown source: ${name}. Use "adt source add ${name} <url>" to add custom sources.`); continue; }
        await cmdSourceAdd([name, catalog[name].repo, catalog[name].ref || 'main'], true);
        await cmdInstall([name], true);
      }
    }

    console.log(`\n${C.green}${C.bold}Init complete.${C.reset}`);
    info('Add custom sources:  adt source add <name> <url>');
    info('Install a source:    adt install <source>');
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

  // Remove installed items from this source
  await removeItems((i) => i.source === name, true);

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

// ─── Command: install ─────────────────────────────────────────────────────────

async function cmdInstall(args, silent = false) {
  const target = args[0];
  if (!target) { console.log('\nUsage: adt install <source> | adt install <source>/<item>\n'); process.exit(1); }

  // Edge case #1: auto-init if no state
  const state = readState();
  if (state.harnesses.length === 0) {
    if (!silent) info('No harnesses configured. Running init first...');
    await cmdInit(['--yes']);
    return cmdInstall(args, silent);
  }
  const harnesses = state.harnesses;

  const [sourceName, itemName] = target.includes('/') ? target.split('/') : [target, null];

  if (!silent) header(`ADT — install "${target}"`);

  const catalog = await getCatalog({ offlineOnly: true });

  // Ensure source is cloned
  if (!fs.existsSync(getSourceDir(sourceName))) {
    const src = catalog[sourceName] || state.userSources?.[sourceName];
    if (!src) {
      err(`Unknown source "${sourceName}". Add it first: adt source add ${sourceName} <url>`);
      process.exit(1);
    }
    try {
      await cloneOrPullSource(sourceName, src.repo, src.ref || 'main');
    } catch (e) {
      err(`Cannot clone source "${sourceName}": ${e.message}`);
      process.exit(1);
    }
  }

  const { results } = await installSource(sourceName, harnesses, itemName, false);

  // Report
  for (const item of results.installed) {
    ok(`${item.name} (${item.type}) → ${item.harnesses.join(', ')}`);
  }
  for (const s of results.skipped) {
    skip(s);
  }
  for (const c of results.collisions) {
    warn(`${c.item} — collision in ${c.harness} (real file exists, skipped)`);
  }
  for (const e of results.errors) {
    err(e);
  }

  if (!silent) {
    const count = results.installed.length;
    const skippedCount = results.skipped.length;
    const msg = [
      count > 0 ? `${count} installed` : '',
      skippedCount > 0 ? `${skippedCount} already present` : '',
    ].filter(Boolean).join(', ');
    console.log(`\n  ${C.green}Done.${C.reset} ${msg || 'Nothing new to install.'}`);
  }
}

// ─── Command: remove ──────────────────────────────────────────────────────────

async function cmdRemove(args) {
  const target = args[0];
  if (!target) { console.log('\nUsage: adt remove <source> | adt remove <source>/<item>\n'); process.exit(1); }
  header(`ADT — remove "${target}"`);

  const [sourceName, itemName] = target.includes('/') ? target.split('/') : [target, null];
  const predicate = itemName
    ? (i) => i.source === sourceName && i.name === itemName
    : (i) => i.source === sourceName;

  const { removed, errors } = await removeItems(predicate);

  removed.forEach((p) => ok(`Removed: ${path.basename(p)}`));
  errors.forEach((p) => warn(`Could not remove: ${path.basename(p)}`));
  console.log(`\n  ${C.green}Done.${C.reset} ${removed.length} item(s) removed.`);
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
  const targetSource = args.find((a) => !a.startsWith('-'));

  if (installedOnly) {
    header('ADT — installed items');
    const manifest = readManifest();
    if (manifest.items.length === 0) {
      info('Nothing installed. Run: adt install <source>');
      return;
    }
    // Group by source → name → collect harnesses
    const bySource = {};
    for (const item of manifest.items) {
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

  console.log(`\n  ${C.bold}Harnesses:${C.reset} ${state.harnesses.length ? state.harnesses.join(', ') : 'none configured'}`);

  const bySource = {};
  for (const item of manifest.items) {
    bySource[item.source] = (bySource[item.source] || 0) + 1;
  }
  console.log(`\n  ${C.bold}Installed:${C.reset} ${manifest.items.length} items across ${Object.keys(bySource).length} source(s)`);
  for (const [src, count] of Object.entries(bySource)) {
    const sourceDir = getSourceDir(src);
    let health = `${C.dim}not cloned${C.reset}`;
    if (fs.existsSync(sourceDir)) {
      const gitLog = git(['log', '-1', '--format=%cr'], sourceDir);
      health = gitLog.stdout.trim() ? `last pulled ${gitLog.stdout.trim()}` : 'cloned';
    }
    console.log(`    ${src}: ${count} items — ${health}`);
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
      case 'remove':    await cmdRemove(rest); break;
      case 'update':    await cmdUpdate(); break;
      case 'list':      await cmdList(rest); break;
      case 'status':    await cmdStatus(); break;
      case 'uninstall': await cmdUninstall(rest); break;
      default:
        console.log(`
${C.bold}adt${C.reset} — AI skill package manager

${C.cyan}Setup:${C.reset}
  adt init                          Interactive setup: harnesses + first sources
  adt init --yes                    Non-interactive (detect defaults)

${C.cyan}Sources:${C.reset}
  adt source add <name> <url>       Add a git repo as a source
  adt source remove <name>          Remove a source
  adt source list                   List all sources
  adt source update [name]          Pull latest from upstream

${C.cyan}Skills, agents, rules, hooks:${C.reset}
  adt install <source>              Install all items from a source
  adt install <source>/<item>       Install one item
  adt remove <source>               Remove all items from a source
  adt remove <source>/<item>        Remove one item
  adt update                        Pull all sources and re-link

${C.cyan}Inspect:${C.reset}
  adt list                          Show all available items (by source)
  adt list <source>                 Show items in one source
  adt list --installed              Show only installed items
  adt status                        Show harness config and install summary

${C.cyan}Uninstall:${C.reset}
  adt uninstall                     Interactive: remove everything ADT created

${C.cyan}Install:${C.reset}
  npm install -g @saketananddotme/adt
`);
    }
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
})();
