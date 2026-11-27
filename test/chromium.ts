// A real browser for the tests that open one: skipped where none is installed, except on CI (GitHub's runners), where
// a browser that won't start fails the run instead of quietly skipping every browser test.
//
// One browser for the whole run: scripts/test.ts starts it (this file, run on its own) and every test file connects to
// it, each with contexts of its own, so a run holds one browser's processes instead of one browser per file. Run any
// other way, a file launches its own. With SHEPHERDR_TEST_MAP set, it also records which lines of the screen's code
// each test file runs (screen-map.ts).
import { chromium, webkit, type Browser, type Page } from 'playwright-core'

/** a pretend microphone and camera, allowed without asking, and sound that plays without a tap (voice.test.ts) */
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']

export async function launch(): Promise<Browser | null> {
  // who asked (test/layout-tasks.test.ts), while the stack still says so
  const caller = new Error().stack?.match(/\/(test\/[\w.-]+\.test\.tsx?)/)?.[1] ?? 'test/unknown.test.ts'
  const shared = process.env.SHEPHERDR_TEST_BROWSER
  const browser = await (shared ? chromium.connect(shared) : chromium.launch({ args: ARGS })).catch((e) => {
    // what was run, and what the browser said about it: on CI a browser that won't start fails the run, and the reason
    // goes with it
    if (process.env.CI) throw new Error(`The browser did not start: ${shared ? `chromium.connect(${shared})` : `chromium.launch(${ARGS.join(' ')})`}\n${(e as Error).message}`)
    return null
  })
  if (browser && process.env.SHEPHERDR_TEST_MAP) await (await import('./screen-map.ts')).record(browser, caller)
  return browser
}

/** Safari's engine, for the tests of an iPhone (layout-iphone.test.ts): a file of its own launches it, and it skips
 *  where WebKit isn't installed, except on CI */
export async function launchWebkit(): Promise<Browser | null> {
  return webkit.launch().catch((e) => {
    if (process.env.CI) throw e
    return null
  })
}

/** A JPEG of a page, for a frame of the browser panel's stream. The run's one browser takes every file's pages at
 *  once, so a capture of a busy page is refused now and then ("Page.captureScreenshot: Unable to capture screenshot"):
 *  a frame later it is asked again. Any other failure, or this one three times, is chromium's own error, not a test's. */
export async function shot(page: Page): Promise<Buffer> {
  for (let i = 0; ; i++) {
    try {
      return await page.screenshot({ type: 'jpeg' })
    } catch (e) {
      if (i >= 2 || !/Unable to capture screenshot/i.test((e as Error).message)) throw e
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))
    }
  }
}

// the run's browser: prints where to connect, and closes once whoever started it is gone (its stdin ends)
if (import.meta.main) {
  const server = await chromium.launchServer({ args: ARGS })
  console.log(server.wsEndpoint())
  await new Response(Bun.stdin.stream()).text()
  await server.close()
  process.exit(0)
}
