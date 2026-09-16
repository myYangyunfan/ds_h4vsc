// Copies the codicon font + css into public/ so that Vite ships them with the
// webview bundle (they are loaded through the webview CSP as local assets).
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const source = join(packageRoot, 'node_modules', '@vscode', 'codicons', 'dist');
const target = join(packageRoot, 'public', 'codicons');

await mkdir(target, { recursive: true });
await copyFile(join(source, 'codicon.css'), join(target, 'codicon.css'));
await copyFile(join(source, 'codicon.ttf'), join(target, 'codicon.ttf'));
console.log('[copy-codicons] done');
