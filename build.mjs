/**
 * Build both halves of the plugin into `lib/`.
 *
 * The Node half (`lib/index.js`) runs from a real install, so its runtime
 * dependencies (`node-pty`, `ws`) stay imports. The browser half
 * (`lib/client.js`) is fetched by the web GUI's module loader outside Vite's
 * module graph, so it must be one self-contained CommonJS bundle wrapped in the
 * loader's factory handoff — the artifact the harness's own client packages
 * emit. Every bare specifier the shell already shares into the frozen module
 * table stays a `require()`; everything else (xterm, the plugin's own code) is
 * inlined.
 *
 * rolldown is the bundler because it compiles inside this process: its native
 * binding is loaded directly, with no helper binary and no pipe. esbuild needs a
 * service subprocess, which pipe-restricted environments refuse.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { rolldown } from 'rolldown'

/** Package name; also the loader entry id stamped into the client bundle. */
const ID = 'dsh-terminal-tab'

/** Virtual-id prefix keeping stylesheet text out of rolldown's own pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'

/**
 * Virtual-id suffix. It must not end in `.css`, or the bundler's own
 * stylesheet guard claims the module before this plugin's loader sees it.
 */
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Specifiers the browser module table answers for every client bundle: the
 * shell-seeded platform modules plus the preloaded runtime row. A `require()`
 * for anything outside this list would throw at boot, so everything else is
 * inlined instead.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Import a stylesheet as its text, so the client bundle stays one artifact.
 * @returns the rolldown plugin.
 */
function stylesheetText() {
  return {
    name: 'dsh-css-text',
    resolveId(source, importer) {
      if (!source.endsWith('.css')) return null
      const virtual = (file) => CSS_VIRTUAL_PREFIX + file + CSS_VIRTUAL_SUFFIX
      if (source.startsWith('.') && importer != null) {
        return virtual(resolvePath(dirname(importer), source))
      }
      if (isAbsolute(source)) return virtual(source)
      // A bare specifier (xterm's own stylesheet) resolves through the
      // package's `exports`, exactly as a runtime `require` would.
      return virtual(createRequire(import.meta.url).resolve(source))
    },
    load(id) {
      if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const file = id.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))}`
    },
  }
}

/** Bundle one entry in this process and write it under `lib/`. */
async function bundle(options, output) {
  const build = await rolldown({
    input: options.input,
    platform: options.platform,
    external: options.external,
    plugins: options.plugins ?? [],
    ...(options.jsx === undefined ? {} : { transform: { jsx: options.jsx } }),
  })
  await build.write({
    dir: 'lib',
    format: options.format,
    entryFileNames: options.fileName,
    ...output,
  })
  await build.close()
}

await bundle({
  input: 'src/index.ts',
  platform: 'node',
  format: 'esm',
  fileName: 'index.js',
  external: ['node-pty', 'ws', '@deepseek-ai/schemastery', /^node:/],
}, {})

await bundle({
  input: 'src/client/index.tsx',
  platform: 'browser',
  format: 'cjs',
  fileName: 'client.js',
  external: CLIENT_EXTERNALS,
  plugins: [stylesheetText()],
  jsx: { runtime: 'automatic' },
}, {
  // The GUI's loader materializes this bundle as one factory: the canvas is the
  // module/exports pair the factory body receives.
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
  intro: 'var module = { exports: {} }; var exports = module.exports;',
  footer: 'return module.exports; } });',
})
