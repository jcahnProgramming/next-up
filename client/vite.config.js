import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { describeProblems, readLibrary } from '../scripts/logos.js';

const backend = process.env.VITE_BACKEND_URL || 'http://localhost:3230';
const LOGOS_DIR = resolve(import.meta.dirname, '..', 'logos');

export default defineConfig({
  plugins: [react(), logoLibrary(LOGOS_DIR)],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/health': backend,
    },
  },
});

/**
 * `import { logos } from 'virtual:nu-logos'`: the logo library as [{ id, name, url }], built from logos/ by
 * scripts/logos.js. Each file is bundled as a hashed asset; nothing is ever fetched from anywhere else. A bad file
 * stops the build (and the dev server's page) with the list of problems.
 */
function logoLibrary(dir) {
  const ID = 'virtual:nu-logos';
  const RESOLVED = `\0${ID}`;
  let serving = false;
  return {
    name: 'nu-logo-library',
    configResolved(config) {
      serving = config.command === 'serve';
    },
    resolveId(id) {
      return id === ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      // Watching the folder: the build's watch mode needs addWatchFile. The dev server must not get it: it treats a
      // watched file as an import of this module and tries to resolve it, and the folder's Windows path (D:\...)
      // fails there, which broke the page in `npm run dev` on Windows. configureServer below watches it instead.
      if (!serving) this.addWatchFile(dir);
      const { logos, problems } = readLibrary(dir);
      if (problems.length) this.error(describeProblems(problems));
      const imports = logos.map((l, i) => `import u${i} from ${JSON.stringify(`${l.path.replace(/\\/g, '/')}?url`)};`);
      const list = logos.map((l, i) => `{ id: ${JSON.stringify(l.id)}, name: ${JSON.stringify(l.name)}, url: u${i} }`);
      return `${imports.join('\n')}\nexport const logos = Object.freeze([${list.join(', ')}]);\n`;
    },
    configureServer(server) {
      // Adding, removing or renaming a logo reloads the page with the new library.
      server.watcher.add(dir);
      const reload = (file) => {
        if (!resolve(file).startsWith(dir)) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      for (const ev of ['add', 'unlink', 'change']) server.watcher.on(ev, reload);
    },
  };
}
