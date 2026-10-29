import assert from 'node:assert/strict'
import test from 'node:test'
import { createPolishReviewer } from '../tavern-plugin/lib/domain/polish-run.js'
import { createPlayHandlers } from '../tavern-plugin/lib/rpc/play.js'
import { applyPolishEdits } from '../tavern-plugin/lib/domain/polish-review.js'

test('每次精修仅一次无工具请求：原则和当前正文，没有历史或人物卡', async () => {
  const calls = []
  const reviewer = createPolishReviewer({ prompt: name => name === 'polish' ? '审稿原则' : '按意见修改',
    callModel: async request => { calls.push(request); return '{"edits":[]}' },
    latestFloors() { throw Error('不能读历史') }, readCard() { throw Error('不能读人物卡') }, runAgent() { throw Error('不能创建 Agent') } })
  await reviewer.review('game', ['第一轮正文'])
  await reviewer.review('game', ['第二轮正文'])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].system, calls[1].system)
  assert.match(calls[1].system, /审稿原则/)
  assert.deepEqual(calls[1].messages, [{ role: 'user', content: [{ type: 'text', text: '【本轮正文】\n第二轮正文' }] }])
  assert.equal(calls[1].tools, undefined)
  assert.doesNotMatch(JSON.stringify(calls[1]), /第一轮正文/)
  await reviewer.guide('game', ['第二轮正文'], '缩短句子')
  assert.equal(calls.length, 3)
  assert.match(calls[2].system, /按意见修改/)
  assert.doesNotMatch(calls[2].system, /审稿原则/)
  assert.match(calls[2].messages[0].content[0].text, /缩短句子/)
})

test('单次返回的修改校验定位，失败和取消不冒充成功', async () => {
  const reviewer = createPolishReviewer({ prompt: () => '原则', callModel: async () => JSON.stringify({ edits: [
    { find: '甲。', replace: '乙。', reason: '修改' }, { find: '乙。', replace: '丙。', reason: '修改' },
    { find: '不存在', replace: '', reason: '错误' }] }) })
  const result = await reviewer.review('game', ['甲。乙。'])
  assert.equal(result.edits[2].status, 'missing')
  assert.deepEqual(applyPolishEdits(['甲。乙。'], result.edits.filter(e => e.status === 'ok')), ['乙。丙。'])
  const failed = createPolishReviewer({ prompt: () => '原则', callModel: async () => { throw Error('模型失败') } })
  await assert.rejects(failed.review('game', ['正文']), /模型失败/)
  assert.equal(failed.progress('game').phase, 'failed')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(reviewer.review('game', ['正文'], controller.signal), { name: 'AbortError' })
})

test('RPC 普通精修与按意见修改各只调用一次，保存原文供对比撤销；失败不保存', async () => {
  for (const guidance of ['', '缩短']) for (const fail of [false, true]) {
    const calls = [], saves = [], records = []
    const run = async kind => { calls.push(kind); if (fail) throw Error('模型失败'); return { edits: [{ find: '甲。', replace: '改。', reason: '修改', status: 'ok' }], fallback: '' } }
    const handlers = createPlayHandlers({ str: value => String(value || ''), reconcileStory: async () => {}, notifyPluginTimeline() {},
      polishPrereview: { settle() {}, cancel() {}, take: async () => null },
      bodyEditor: { read: async () => ({ token: 'v1', turn: 1, parts: [{ kind: 'text', text: '甲。乙。' }] }), save: async (_, change) => { saves.push(change); return {} } },
      polishReviewer: { review: () => run('review'), guide: () => run('guide') },
      polishRecords: { save: async (_, turn, record) => records.push(record) } })
    if (fail) await assert.rejects(handlers.polishBody({ sessionId: 'game', guidance }), /模型失败/)
    else await handlers.polishBody({ sessionId: 'game', guidance })
    assert.deepEqual(calls, [guidance ? 'guide' : 'review'])
    assert.equal(saves.length, fail ? 0 : 1)
    if (!fail) { assert.deepEqual(saves[0], { token: 'v1', texts: ['改。乙。'] }); assert.deepEqual(records[0].original, ['甲。乙。']) }
  }
})
