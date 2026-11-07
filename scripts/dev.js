// Cross-platform dev launcher: runs the web server (watch mode), the MCP server
// and the Vite dev server together. Ctrl+C stops all of them.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const withMcp = !process.argv.includes('--no-mcp');

const procs = [
  ['server', ['run', 'dev', '--workspace', 'server']],
  ...(withMcp ? [['mcp', ['run', 'dev:mcp', '--workspace', 'server']]] : []),
  ['client', ['run', 'dev', '--workspace', 'client']],
].map(([name, args]) => {
  // Windows can only start npm.cmd through a shell, and Node deprecates passing an argument list along with
  // shell: true (DEP0190), so there the command goes as one string. The arguments are the fixed ones above, never
  // user input. Elsewhere npm starts directly, without a shell.
  const opts = { stdio: ['ignore', 'pipe', 'pipe'] };
  const child =
    process.platform === 'win32' ? spawn([npm, ...args].join(' '), { ...opts, shell: true }) : spawn(npm, args, opts);
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join('\n');
  child.stdout.on('data', (d) => console.log(prefix(d)));
  child.stderr.on('data', (d) => console.error(prefix(d)));
  child.on('exit', (code) => console.log(`[${name}] exited with code ${code}`));
  return child;
});

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
