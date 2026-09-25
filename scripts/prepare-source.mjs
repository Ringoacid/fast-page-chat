import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { auditSource, sourceRoot } from './check-release.mjs';

try {
  const args = process.argv.slice(2);
  let outputArg, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--out' && args[i + 1]) outputArg = args[++i];
    else throw new Error('Usage: node scripts/prepare-source.mjs [--dry-run] [--out dist/new-directory]');
  }
  const result = await auditSource();
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  const distributionRoot = resolve(sourceRoot, 'dist');
  const output = resolve(sourceRoot, outputArg || `dist/fast-page-chat-${result.version}-source`);
  const child = relative(distributionRoot, output);
  if (!child || child === '..' || child.includes(sep) || isAbsolute(child)) throw new Error('Output must be a new direct child directory within this workspace\'s dist directory.');
  console.log(`Source export: ${result.files.length} allowlisted files (${result.files.reduce((sum, file) => sum + file.bytes, 0)} bytes).`);
  console.log('Excluded by construction: .env, .local, .research, test-results, profiles, node_modules, binaries, archives, and files outside the allowlist.');
  for (const message of result.pending) console.log(`PENDING: ${message}`);
  if (dryRun) console.log('Dry run passed. No files were written.');
  else {
    await mkdir(distributionRoot, { recursive: true });
    if (await realpath(distributionRoot) !== distributionRoot) throw new Error('The dist directory must not be a symbolic link.');
    // Refuse an existing target. Never delete or overwrite a previous export.
    await mkdir(output, { recursive: false });
    for (const file of result.files) {
      const bytes = await readFile(resolve(sourceRoot, file.path));
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Source changed during export: ${file.path}. Review the partial output and export to a new directory.`);
      const destination = resolve(output, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx' });
    }
    await writeFile(resolve(output, 'SOURCE-MANIFEST.json'), JSON.stringify({ product: 'Fast Page Chat', version: result.version, files: result.files }, null, 2) + '\n', { flag: 'wx' });
    console.log(`Prepared ${output}`);
    console.log('Review SOURCE-MANIFEST.json before publishing. This command does not create a repository, upload, or publish.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
