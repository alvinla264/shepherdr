// The seal of a page an agent wrote: nothing reaches the network and nothing reaches the app. The server sends it as
// an artifact frame's response header; a worktree's preview carries it inside the page, because its file never leaves
// the app.
export const SEALED = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'`

/** a page's own policy, as a meta (a frame's policy can't be a meta, so it rides along as well) plus the phone's
 *  viewport */
const HEAD = `<meta http-equiv="Content-Security-Policy" content="${SEALED}"><meta name="viewport" content="width=device-width,initial-scale=1">`

/** An agent's HTML as a page of its own: the seal first, then whatever it wrote, so the policy governs every element,
 *  even a page whose `<!-- <head> -->`, `<script>` or `<img>` comes first (a meta CSP only covers what follows it).
 *  A parser puts a meta that comes before `<html>` into the head. Never put the page in the app's own DOM: it goes
 *  into an iframe sandbox="allow-scripts allow-forms", as an artifact does */
export function sealedPage(html: string) {
  const doctype = html.match(/^\s*<!doctype[^>]*>/i)
  return `${doctype ? doctype[0] : '<!doctype html>'}${HEAD}${doctype ? html.slice(doctype[0].length) : html}`
}
