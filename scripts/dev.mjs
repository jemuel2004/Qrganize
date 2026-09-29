// `npm run dev` — starts the backend (port 4000) and the frontend (port 3000)
// together, with prefixed output. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const apps = [
  { name: 'backend ', workspace: '@qrganize/backend', color: '\x1b[35m' },
  { name: 'frontend', workspace: '@qrganize/frontend', color: '\x1b[36m' },
];

const children = apps.map(({ name, workspace, color }) => {
  // One command string (fixed text, no user input) — avoids Node's DEP0190 warning for args + shell.
  const child = spawn(`npm run dev -w ${workspace}`, { shell: true, env: process.env });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', chunk => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', code => {
    console.log(`${prefix}exited (${code ?? 'signal'})`);
    shutdown();
  });
  return child;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // npm spawns next as a grandchild; kill the whole tree on Windows.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGINT');
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
