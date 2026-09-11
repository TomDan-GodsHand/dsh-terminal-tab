/** Stylesheet imports reach the bundle as text and are injected by the plugin. */
declare module '*.css' {
  const css: string
  export default css
}
