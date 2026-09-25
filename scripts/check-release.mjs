import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootFiles = ['.env.example', '.gitignore', 'README.md', 'TODO.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'start.ps1', 'login.ps1'];
// Only these source trees and file types may enter the public-source export.
// Do not add an entire workspace or an arbitrary directory from command-line input.
const sourceTrees = new Map([
  ['extension', new Set(['.js', '.json', '.html', '.css', '.svg', '.png', '.ico'])],
  ['server', new Set(['.mjs'])],
  ['scripts', new Set(['.mjs', '.ps1'])],
  ['installer', new Set(['.cs', '.ps1', '.json', '.md', '.txt', '.manifest'])],
  ['test', new Set(['.mjs', '.cs', '.ps1'])],
  ['assets', new Set(['.svg', '.png', '.ico'])],
  ['docs', new Set(['.md', '.html', '.css', '.json', '.svg', '.png', '.ico'])],
  ['.github', new Set(['.yml', '.yaml', '.md'])]
]);
const forbiddenNames = /^(?:\.env(?:\..+)?|\.local|\.research|\.git|node_modules|test-results|dist|coverage|data|profiles?|browser-profile|auth\.json|api-settings\.json|native-host\.json|credentials?(?:\..+)?|connection-key\.txt|.*\.(?:log|pem|key|pfx|p12|exe|dll|zip))$/i;
const textExtensions = new Set(['.mjs', '.js', '.json', '.html', '.css', '.svg', '.md', '.txt', '.ps1', '.cs', '.manifest', '.yml', '.yaml']);
const secretPatterns = [
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['OAuth credential', /["'](?:access_token|refresh_token|id_token)["']\s*:\s*["'][A-Za-z0-9._~+\/-]{24,}["']/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['connection secret', /["'](?:token|connectionKey)["']\s*:\s*["'][a-f0-9]{64}["']/i]
];

async function optionalStat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith('..' + sep) && !resolve(path).startsWith('\\\\');
}

export async function collectSourceFiles(root = sourceRoot) {
  root = await realpath(root);
  const files = [];
  async function accept(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in public source: ${relative(root, path)}`);
    if (!stat.isFile() || !inside(root, await realpath(path))) throw new Error(`Invalid source file: ${relative(root, path)}`);
    const bytes = await readFile(path);
    files.push({ path: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  for (const name of rootFiles) {
    if (await optionalStat(resolve(root, name))) await accept(resolve(root, name));
  }
  async function walk(path, types) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in public source: ${relative(root, path)}`);
    if (!stat.isDirectory()) throw new Error(`Expected a source directory: ${relative(root, path)}`);
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (forbiddenNames.test(entry.name) || entry.name.startsWith('.')) continue;
      const target = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in public source: ${relative(root, target)}`);
      if (entry.isDirectory()) await walk(target, types);
      else if (entry.isFile() && types.has(extname(entry.name).toLowerCase())) await accept(target);
    }
  }
  for (const [name, types] of sourceTrees) if (await optionalStat(resolve(root, name))) await walk(resolve(root, name), types);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function auditSource({ root = sourceRoot, publicRelease = false, policyOnly = false } = {}) {
  const files = await collectSourceFiles(root);
  const errors = [], pending = [];
  const paths = new Set(files.map(file => file.path));
  for (const required of ['README.md', 'LICENSE', 'package.json', 'extension/manifest.json', 'extension/privacy.html', 'docs/privacy.html', 'docs/publication.json']) {
    if (!paths.has(required)) errors.push(`Missing public source file: ${required}`);
  }
  for (const file of files) {
    if (!textExtensions.has(extname(file.path)) && !['.env.example', 'LICENSE', '.gitignore'].includes(file.path)) continue;
    const body = await readFile(resolve(root, file.path), 'utf8');
    for (const [kind, pattern] of secretPatterns) if (pattern.test(body)) errors.push(`Potential ${kind} in ${file.path}; value withheld.`);
    if (file.path === '.env.example') {
      for (const line of body.split(/\r?\n/)) {
        if (/^\s*[A-Z][A-Z0-9_]*\s*=\s*\S/.test(line)) errors.push('The distributable .env.example must not contain configured values.');
      }
    }
  }
  const manifest = JSON.parse(await readFile(resolve(root, 'extension/manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (pkg.version !== manifest.version) errors.push('package.json and extension/manifest.json versions differ.');
  for (const path of Object.values(manifest.icons || {})) if (!paths.has('extension/' + path)) errors.push(`Missing manifest icon: ${path}`);
  if (!manifest.icons?.['128']) pending.push('A manifest icon at 128px is required before store release.');
  if (paths.has('extension/privacy.html') && paths.has('docs/privacy.html')) {
    if (!Buffer.from(await readFile(resolve(root, 'extension/privacy.html'))).equals(await readFile(resolve(root, 'docs/privacy.html')))) errors.push('Bundled and public privacy HTML must match.');
    if (!Buffer.from(await readFile(resolve(root, 'extension/privacy.css'))).equals(await readFile(resolve(root, 'docs/privacy.css')))) errors.push('Bundled and public privacy CSS must match.');
  }
  const publication = JSON.parse(await readFile(resolve(root, 'docs/publication.json'), 'utf8'));
  const policyPending = [];
  for (const key of ['publisher', 'repositoryUrl', 'supportUrl', 'securityContact', 'privacyPolicyUrl', 'licenseSpdx']) {
    if (typeof publication[key] !== 'string' || !publication[key].trim()) policyPending.push(`Publication field is not set: ${key}`);
  }
  for (const key of ['repositoryUrl', 'supportUrl', 'privacyPolicyUrl']) if (publication[key] && !/^https:\/\//.test(publication[key])) policyPending.push(`Publication URL must use HTTPS: ${key}`);
  if (!publication.policyFinalized) policyPending.push('The privacy policy still needs final implementation review.');
  for (const path of ['extension/privacy.html', 'docs/index.html']) if ((await readFile(resolve(root, path), 'utf8')).includes('PUBLICATION_PENDING')) policyPending.push(`Unresolved publication notice in ${path}`);
  if (publicRelease || policyOnly) errors.push(...policyPending); else pending.push(...policyPending);
  for (const key of ['cleanInstallVerified', 'storeAssetsVerified']) if (!publication[key]) pending.push(`Release evidence is not confirmed: ${key}`);
  if (publicRelease) errors.push(...pending);
  return { version: pkg.version, files, errors: [...new Set(errors)], pending: [...new Set(pending)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--public', '--policy'].includes(arg))) throw new Error('Usage: node scripts/check-release.mjs [--public | --policy]');
    const result = await auditSource({ publicRelease: args.includes('--public'), policyOnly: args.includes('--policy') });
    console.log(`Checked ${result.files.length} allowlisted files for Fast Page Chat ${result.version}. Secret values are never printed.`);
    for (const message of result.pending) console.log(`PENDING: ${message}`);
    for (const message of result.errors) console.error(`ERROR: ${message}`);
    if (result.errors.length) process.exitCode = 1;
    else console.log('Source checks passed. No publication or upload was performed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
