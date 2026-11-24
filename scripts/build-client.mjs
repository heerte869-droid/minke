import { build } from 'esbuild';
import './build-browser-extension.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter } from 'node:path';
const {outputFiles} = await build({entryPoints:['lib/display-remote.js'], platform:'browser', format:'iife', globalName:'WhaleDisplayTransport', bundle:true, minify:true, write:false, nodePaths:(process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)});
const embed = async name => 'data:image/png;base64,' + (await readFile('browser-extension/'+name)).toString('base64');
const cursor = { mini:await embed('cursor-mini.png'), large:await embed('cursor-large.png') };
const source = await readFile('client.js','utf8');
await writeFile('client.bundle.js', '(() => {\n' + outputFiles[0].text + '\nconst WhaleCursorPNG = '+JSON.stringify(cursor)+';\n' + source + '\n})();\n');
