// A coordinator's chat is history: its task updates stay in the stream, in time order, none folded away.
import { describe, expect, test } from 'bun:test'
import { cardMessage, type Message } from '../shared/types.ts'
import { layout } from './layout.ts'

const { browser, world, url } = await layout()

describe.skipIf(!browser)('a coordinator chat', () => {
  test('keeps its task updates in time order, with their questions and source, at 390 and 1280 px', async () => {
    const chat = world.chats['p:vm-str:~']
    const before = chat.messages
    const at = Date.now() - 3_600_000
    const updates: Message[] = Array.from({ length: 10 }, (_, i) => cardMessage({
      id: `news-${i}`, task: 'GTM-15', status: i % 2 ? 'done' : 'ready', text: i % 2 ? 'is merged' : 'is ready to merge',
    }, at + i * 1000))
    // one of them needs you: its copy of the task's question answers into the task's chat
    updates.push(cardMessage({
      id: 'news-ask', task: 'GTM-15', status: 'need', text: 'needs you',
      ask: { chat: 'GTM-15/Agent', open: true, questions: [{ id: 'news:ask', kind: 'Question', title: 'Allow writing files?', choices: [{ label: 'Allow' }, { label: 'Deny' }], to: 'GTM-15 agent' }] },
    }, at + 10_000))
    // the agent's own question, unanswered, in between
    updates.push({ id: 'news-question', who: 'agent', at: at + 11_000, question: { id: 'news:colour', kind: 'Form', title: 'Which colour?', choices: [{ label: 'Blue' }, { label: 'Green' }], to: 'home' } })
    // out of order on purpose: only the timestamps decide where each card sits
    chat.messages = [...updates].reverse()
    const order = [...updates].sort((a, b) => a.at! - b.at!).map((m) => m.id)
    try {
      for (const width of [390, 1280]) {
        const page = await browser!.newPage({ viewport: { width, height: 844 } })
        try {
          await page.goto(url())
          await page.locator('[data-whole="news-question"] [data-card]').waitFor()
          // no folding: every update is on screen where its time puts it
          expect(await page.getByText(/Task updates/).count()).toBe(0)
          expect(await page.locator('[data-messages] [data-whole]').evaluateAll((els) => els.map((el) => el.getAttribute('data-whole')))).toEqual(order)
          for (const id of order) expect(await page.locator(`[data-whole="${id}"]`).isVisible()).toBe(true)
          // the needs-you card names the task it comes from, and its question is answerable here
          const card = page.locator('[data-whole="news-ask"] [data-card]')
          expect(await card.locator('[data-card-source]').textContent()).toBe('GTM-15 · Fix webhook signature check')
          expect(await card.getByRole('button', { name: 'Allow', exact: true }).isEnabled()).toBe(true)
          expect(await page.locator('[data-whole="news-question"] [data-card]').getByRole('button', { name: 'Blue', exact: true }).isEnabled()).toBe(true)
          // a reload keeps the same history in the same order
          await page.reload()
          await page.locator('[data-whole="news-question"] [data-card]').waitFor()
          expect(await page.locator('[data-messages] [data-whole]').evaluateAll((els) => els.map((el) => el.getAttribute('data-whole')))).toEqual(order)
        } finally { await page.close() }
      }
    } finally { chat.messages = before }
  }, 30_000)
})
