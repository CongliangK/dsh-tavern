// 精修 runs: the review of the latest reply against the principles, the edit that follows the
// player's guidance, and the background pre-review that starts the review as soon as a reply is
// written, so pressing 精修 mostly finds it done.

import { createHash } from 'node:crypto'
import { parsePolishReview } from './polish-review.js'

function str(value) { return typeof value === 'string' ? value : value == null ? '' : String(value) }

// The protocol also overrides tool instructions in previously saved custom prompts.
const OUTPUT = '本次只根据当前正文审稿，不推断人物卡设定或跨轮剧情。保留事实、人物意图和有效信息，不补造情节。输出协议以此为准：不调用工具，只返回 JSON {"edits":[{"find":"原文","replace":"替换文字","reason":"简短原因"}]}，最多 12 处；find 必须唯一匹配原文，各处不得重叠；无需修改时返回 {"edits":[]}。'

/** Each review is one stateless call: principles and the current body only. */
export function createPolishReviewer({ prompt, callModel }) {
  const progress = new Map(), queues = new Map()
  async function run(sessionId, texts, guidance, signal) {
    signal?.throwIfAborted()
    const body = texts.join('\n\n')
    if (!body.trim()) throw new Error('这轮没有可精修的正文')
    const rules = str(prompt(guidance ? 'polish-guidance' : 'polish')).trim()
    if (!rules) throw new Error('精修提示词为空，请在系统提示词里填写')
    const status = { phase: 'running', edits: [], startedAt: Date.now() }
    progress.set(sessionId, status)
    try {
      const output = await callModel({ sessionId, signal, system: rules + '\n\n' + OUTPUT,
        messages: [{ role: 'user', content: [{ type: 'text', text: '【本轮正文】\n' + body +
          (guidance ? '\n\n【修改意见】\n' + guidance : '') }] }] })
      signal?.throwIfAborted()
      const reviewed = parsePolishReview(output, texts)
      status.edits = reviewed.edits; status.phase = 'completed'
      return reviewed
    } catch (error) { status.phase = 'failed'; status.error = str(error?.message); throw error }
  }
  function enqueue(sessionId, texts, guidance, signal) {
    const pending = (queues.get(sessionId) || Promise.resolve()).catch(() => {}).then(() => run(sessionId, texts, guidance, signal))
    queues.set(sessionId, pending)
    return pending.finally(() => { if (queues.get(sessionId) === pending) queues.delete(sessionId) })
  }
  return Object.freeze({
    review: (id, texts, signal) => enqueue(id, texts, '', signal),
    guide: (id, texts, guidance, signal) => enqueue(id, texts, str(guidance).trim(), signal),
    progress: id => progress.has(id) ? structuredClone(progress.get(id)) : null
  })
}

/** The text version a review belongs to: the reply's text parts. */
export function polishTextKey(texts) {
  return createHash('sha256').update(JSON.stringify((texts || []).map(str))).digest('hex')
}

/**
 * One review per game kept in memory, for the reply text it read. Starting again for the same
 * text keeps the running one; another text aborts it. A review is only handed to a 精修 of the
 * same text, so an edited, regenerated or rolled back reply never takes a stale one.
 */
export function createPolishPrereview({ enabled, readTexts, review, logger = console }) {
  const jobs = new Map()
  // Text versions a 精修 already produced or reviewed: reviewing them again would only cost.
  const settled = new Map()

  function cancel(sessionId) {
    const job = jobs.get(str(sessionId))
    if (!job) return
    jobs.delete(str(sessionId))
    job.controller.abort()
  }

  async function start(sessionId) {
    const id = str(sessionId)
    if (!id || !await enabled()) return false
    let texts
    try { texts = await readTexts(id) } catch { return false }
    if (!texts?.some(text => str(text).trim())) return false
    const key = polishTextKey(texts)
    if (jobs.get(id)?.key === key || settled.get(id)?.includes(key)) return false
    cancel(id)
    const controller = new AbortController()
    const job = { key, controller, result: review(id, texts, controller.signal) }
    // A failed pre-review only means 精修 reviews on the spot; the page never sees it.
    job.result.catch(error => {
      if (jobs.get(id) === job) jobs.delete(id)
      if (!controller.signal.aborted) logger.warn('dsh-tavern: 精修预审失败，点精修时会重新审稿:', str(error?.message || error))
    })
    jobs.set(id, job)
    return true
  }

  /** The pre-review of exactly these texts, waited for if still running; null when there is none. */
  async function take(sessionId, texts) {
    const id = str(sessionId), job = jobs.get(id)
    if (!job || job.key !== polishTextKey(texts)) return null
    try { return await job.result } catch { return null } finally { if (jobs.get(id) === job) jobs.delete(id) }
  }

  /** A 精修 has used these texts (or produced them); a pre-review of them would be wasted. */
  function settle(sessionId, ...versions) {
    const id = str(sessionId)
    settled.set(id, [...settled.get(id) || [], ...versions.filter(Boolean).map(polishTextKey)].slice(-4))
  }

  return Object.freeze({ start, take, cancel, settle, running: sessionId => jobs.has(str(sessionId)) })
}
