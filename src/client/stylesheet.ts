/**
 * Plugin-owned stylesheet injection.
 *
 * A plugin's styles reach the page as one tagged `<style>` element carrying the
 * plugin id, which is the same ownership marker the GUI's own plugin bundles
 * use. The element is created once per file, at bundle materialization.
 */

/**
 * Install one stylesheet, once per page.
 * @param id - the package name owning the stylesheet.
 * @param file - the stylesheet's name within the package.
 * @param css - the stylesheet text.
 */
export function installStylesheet(id: string, file: string, css: string): void {
  if (typeof document === 'undefined') return
  const tagId = `${id}/${file}`
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = id
  tag.dataset.pluginCss = tagId
  tag.textContent = css
  document.head.appendChild(tag)
}
