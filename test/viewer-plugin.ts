// The document viewer's URL and table helpers live in the human's own plugin (~/.shepherdr/plugins/markdown-preview),
// which a build stages into user-plugins/. The plugin is not repo content (AGENTS.md), so a clean checkout has neither
// the module nor the screen: the tests that need it skip there instead of failing the typecheck or the test run. With
// the plugin staged they run as usual, against the plugin's real code.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dir, '..', 'user-plugins', 'markdown-preview')

/** whether a build staged the viewer plugin (user-plugins/markdown-preview) here */
export const hasViewerPlugin = existsSync(join(dir, 'links.ts')) && existsSync(join(dir, 'client.tsx'))

export type ViewerLink = { path: string; hash: string }
export interface ViewerLinks {
  documentLink(href: string, origin: string, documentPath?: string): ViewerLink | null
}
export interface ViewerTable {
  previewTable(text: string, sep: string, rows?: number, columns?: number, cell?: number): { rows: string[][]; truncated: boolean }
}

// A computed path: nothing for the type checker to resolve, so a clean checkout still typechecks.
export const links: ViewerLinks | undefined = hasViewerPlugin ? await import(join(dir, 'links.ts')) : undefined
export const table: ViewerTable | undefined = hasViewerPlugin ? await import(join(dir, 'table.ts')) : undefined
