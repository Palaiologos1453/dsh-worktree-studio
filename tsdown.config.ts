import { defineConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

const clientExternals = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-sidebar/client',
  '@deepseek-ai/dsh-client-locale/client',
]

const CSS_PREFIX = '\0worktree-studio-css:'
const CSS_SUFFIX = '.mjs'

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/commands.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2020',
    dts: false,
    clean: false,
    deps: { neverBundle: clientExternals },
    sourcemap: false,
    plugins: [{
      name: 'worktree-studio-css-modules',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css') || importer === undefined) return null
        return `${CSS_PREFIX}${resolve(dirname(importer), source)}${CSS_SUFFIX}`
      },
      async load(id) {
        if (!id.startsWith(CSS_PREFIX)) return null
        const filename = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
        this.addWatchFile(filename)
        const source = await readFile(filename)
        const compiled = transform({
          filename,
          code: source,
          cssModules: { pattern: 'dws_[hash]_[local]' },
          minify: true,
        })
        const classes: Record<string, string> = {}
        for (const [local, value] of Object.entries(compiled.exports ?? {})) classes[local] = value.name
        return [
          `const css = ${JSON.stringify(compiled.code.toString())};`,
          'const id = "dsh-worktree-studio/worktree-studio";',
          'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\\"dsh-worktree-studio/worktree-studio\\"]") === null) {',
          '  const style = document.createElement("style");',
          '  style.dataset.plugin = "dsh-worktree-studio";',
          '  style.dataset.pluginCss = id;',
          '  style.textContent = css;',
          '  document.head.appendChild(style);',
          '}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.cjs',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-worktree-studio", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
