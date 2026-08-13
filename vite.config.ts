import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

const require = createRequire(import.meta.url);
const installUrl =
  'https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/dist/awa-toolkit.user.js';

export default defineConfig(({ command }) => {
  const isDev = command === 'serve' || process.env.WATCH === 'true';

  return {
    build: {
      emptyOutDir: true,
      watch: isDev ? {} : null,
    },
    server: {
      port: 3000,
      hmr: true,
      open: false,
    },
    plugins: [
      monkey({
        entry: 'src/main.ts',
        build: {
          fileName: 'awa-toolkit.user.js',
          externalGlobals: isDev ? {} : undefined,
        },
        userscript: {
          namespace: 'UpDownLeftDie/awa-toolkit',
          author: 'jaredcat',
          updateURL: isDev
            ? 'http://localhost:3000/awa-toolkit.user.js'
            : installUrl,
          downloadURL: isDev
            ? 'http://localhost:3000/awa-toolkit.user.js'
            : installUrl,
          license: 'AGPL-3.0-or-later',
          ...require(resolve(process.cwd(), 'src', 'meta.ts')).default,
        },
      }),
    ],
  };
});
