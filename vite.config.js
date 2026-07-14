// Production builds ship ONLY the Garda map (the public site); dev serves
// everything. VITE_AREAS overrides either way (VITE_AREAS=halouny,garda
// for a full production build). The logic lives here rather than in the
// Pages workflow so deploy pushes need no `workflow` token scope.

import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ command, mode }) => {
  const areas = process.env.VITE_AREAS
    ?? (command === 'build' && mode === 'production' ? 'garda' : '');
  const shipped = areas.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    base: './',
    build: { target: 'esnext' },
    define: {
      // areas.js reads this; '' means all areas (dev default)
      'import.meta.env.VITE_AREAS': JSON.stringify(areas),
    },
    plugins: [{
      name: 'prune-unshipped-area-data',
      closeBundle() {
        if (!shipped.length) return;
        const dataDir = path.resolve('dist/data');
        if (!fs.existsSync(dataDir)) return;
        for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
          if (entry.isDirectory() && !shipped.includes(entry.name)) {
            fs.rmSync(path.join(dataDir, entry.name), { recursive: true });
            console.log(`  pruned dist/data/${entry.name} (not shipped)`);
          }
        }
      },
    }],
  };
});
