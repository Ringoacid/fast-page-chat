import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { auditSource, collectSourceFiles } from '../scripts/check-release.mjs';

async function fixture(t) {
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'fpc-source-check-'));
  t.after(async () => {
    assert.equal(dirname(await realpath(root)), tempRoot, 'Only this isolated temporary fixture may be removed.');
    await rm(root, { recursive: true, force: true });
  });
  const put = async (path, body) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof body === 'string' ? body : JSON.stringify(body));
  };
  await put('README.md', 'Fixture source');
  await put('LICENSE', 'MIT fixture');
  await put('.env.example', 'OPENAI_API_KEY=\n');
  await put('package.json', { version: '0.10.0' });
  await put('extension/manifest.json', { version: '0.10.0', icons: { 128: 'icons/icon128.png' } });
  await put('extension/icons/icon128.png', 'fixture image');
  await put('extension/privacy.html', '<p>Privacy</p>');
  await put('docs/privacy.html', '<p>Privacy</p>');
  await put('extension/privacy.css', 'body{}');
  await put('docs/privacy.css', 'body{}');
  await put('docs/index.html', '<p>Home</p>');
  await put('docs/publication.json', {
    publisher: 'Test publisher', repositoryUrl: 'https://example.com/source', supportUrl: 'https://example.com/support',
    securityContact: 'https://example.com/security', privacyPolicyUrl: 'https://example.com/privacy', licenseSpdx: 'MIT',
    policyFinalized: true, cleanInstallVerified: false, storeAssetsVerified: false
  });
  return { root, put };
}

test('source export includes reviewed trees and excludes private data, profiles and executables', async t => {
  const { root, put } = await fixture(t);
  for (const name of ['.env', '.local/connection-key.txt', '.research/note.md', 'test-results/profile/Preferences', 'dist/output.json', 'docs/.local/auth.json', 'docs/data/api-settings.json', 'installer/api-settings.json', 'installer/native-host.json', 'server/auth.json', 'installer/private.key', 'installer/runtime.exe']) await put(name, 'not public');
  await put('server/main.mjs', 'export const value = 1;');
  await put('installer/NativeHost.cs', '// source');
  await put('installer/licenses/CODEX-LICENSE.txt', 'license text');
  await put('test/fixtures/DuplicateEnvironment.cs', '// Windows regression fixture');
  await put('test/fixtures/InstallWithoutAuditPrivilege.ps1', '# Windows regression fixture');
  await put('test/fixtures/DuplicateEnvironment.exe', 'not public');
  const files = await collectSourceFiles(root);
  const paths = files.map(file => file.path);
  assert.ok(paths.includes('.env.example'));
  assert.ok(paths.includes('server/main.mjs'));
  assert.ok(paths.includes('installer/NativeHost.cs'));
  assert.ok(paths.includes('installer/licenses/CODEX-LICENSE.txt'));
  assert.ok(paths.includes('test/fixtures/DuplicateEnvironment.cs'));
  assert.ok(paths.includes('test/fixtures/InstallWithoutAuditPrivilege.ps1'));
  assert.ok(!paths.some(path => /not-public|(?:^|\/)\.local|\.research|test-results|^dist\/|auth\.json|api-settings\.json|native-host\.json|\.key$|\.exe$/.test(path)));
  assert.ok(!paths.includes('.env'));
  assert.ok(files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
});

test('source audit reports a synthetic credential without revealing its value', async t => {
  const { root, put } = await fixture(t);
  const fake = ['sk', '-proj-', 'a'.repeat(40)].join('');
  await put('server/leak.mjs', `const credential = ${JSON.stringify(fake)};`);
  const result = await auditSource({ root });
  assert.ok(result.errors.some(error => error.includes('Potential OpenAI key in server/leak.mjs')));
  assert.ok(!JSON.stringify(result.errors).includes(fake));
});

test('source audit refuses configured environment examples and mismatched privacy copies', async t => {
  const { root, put } = await fixture(t);
  await put('.env.example', 'OPENAI_API_KEY=sample-is-not-empty\n');
  await put('docs/privacy.html', '<p>Outdated explanation</p>');
  const result = await auditSource({ root });
  assert.ok(result.errors.some(error => error.includes('.env.example')));
  assert.ok(result.errors.some(error => error.includes('privacy HTML must match')));
});

test('policy publishing and store release require separate evidence', async t => {
  const { root, put } = await fixture(t);
  const policy = await auditSource({ root, policyOnly: true });
  assert.deepEqual(policy.errors, []);
  const release = await auditSource({ root, publicRelease: true });
  assert.ok(release.errors.some(error => error.includes('cleanInstallVerified')));
  assert.ok(release.errors.some(error => error.includes('storeAssetsVerified')));
  const publication = JSON.parse(await readFile(join(root, 'docs/publication.json'), 'utf8'));
  await put('docs/publication.json', { ...publication, policyFinalized: false });
  assert.ok((await auditSource({ root, policyOnly: true })).errors.some(error => error.includes('privacy policy')));
});

test('source audit catches a missing referenced icon and version mismatch', async t => {
  const { root, put } = await fixture(t);
  await put('extension/manifest.json', { version: '0.9.4', icons: { 128: 'missing.png' } });
  const result = await auditSource({ root });
  assert.ok(result.errors.some(error => error.includes('versions differ')));
  assert.ok(result.errors.some(error => error.includes('Missing manifest icon')));
});
