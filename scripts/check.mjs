import { readdir, readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = ['index.js', 'client.js', 'lib/native-client.js', 'lib/coordinator.js', 'lib/config.js', 'lib/browser.js', 'lib/security.js', 'cordis.patch.yml', 'assets/whale.svg', 'skills/whale-computer/SKILL.md'];
const failures = [];
for (const path of required) { try { await access(join(root, path)); } catch { failures.push(`Missing required artifact: ${path}`); } }
async function walk(path) {
  const out = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'research', 'build', 'artifacts', 'work', 'candidates', 'design'].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) out.push(...await walk(child));
    else if (/\.(?:js|mjs)$/.test(entry.name)) out.push(child);
  }
  return out;
}
for (const path of await walk(root)) {
  try { execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' }); }
  catch (error) { failures.push(`Syntax failed: ${path}: ${error.stderr?.toString().slice(0, 1000)}`); }
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const tested = new Set(JSON.parse(await readFile(join(root, 'scripts/tested-dsh-versions.json'), 'utf8')));
const range = manifest.dsh.compatibility.dsh;
for (const version of range.split('||').map(value => value.trim())) {
  if (!tested.has(version)) failures.push('DSH release missing from acceptance matrix: ' + version);
}
for (const [name, peerRange] of Object.entries(manifest.peerDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-') && peerRange !== range) failures.push(name + ' must declare the host range.');
}
const extension = JSON.parse(await readFile(join(root, 'browser-extension/manifest.json'), 'utf8'));
if (extension.version !== manifest.version) failures.push('Release manifest versions must match.');
if (manifest.files.some(f => f.includes('research') || f.includes('node_modules') || f.includes('.test-artifacts'))) failures.push('Research SDKs, dependencies and private test evidence must not be packaged.');
for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'native/THIRD_PARTY_NOTICES.md', 'docs']) {
  if (!manifest.files.includes(notice)) failures.push(`Package must include licenses and referenced documentation: ${notice}`);
  try { await access(join(root, notice)); } catch { failures.push(`Missing notice/documentation: ${notice}`); }
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Required source artifacts, JavaScript syntax and package boundaries passed. This is NOT runtime or GUI acceptance.');
