import test from 'node:test'
import assert from 'node:assert/strict'
import { isStaticWorldbookSkillEntry } from '../tavern-plugin/lib/domain/worldbook-entry-classification.js'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { eligibleVirtualSourceEntries } from '../tavern-plugin/lib/domain/worldbook-virtual-state.js'
const entry = (ref, content, extra = {}) => ({ ref, content, enabled: true, ...extra })
const plain = entry('data', 'STATIC OPTIONAL', { primaryKeys: ['topic'] })
const others = [entry('constant', 'CONSTANT', { constant: true }),
  entry('dynamic', '<%= value %>', { primaryKeys: ['topic'] }),
  entry('macro', '{{char}}', { constant: true }),
  entry('mvu', 'MVU RULE', { comment: '[mvu_update]规则' }),
  entry('disabled', 'DISABLED', { constant: true, enabled: false })]
function project(entries, runtime = { render: async text => ({ ok: true, text: text.includes('<%') ? 'DYNAMIC' : text, scopes: {} }) }) {
  return createForegroundWorldbook({ bound: async () => ({ view: { entries } }), runtime: async () => runtime, globalVariables: async () => ({}) })
}
const chat = strategy => ({ sessionId: 'game', cardPath: 'card', worldbookStrategy: strategy, messages: [], worldBookReads: {} })
test('only enabled nonconstant plain data is eligible; macros, programs, MVU and initialization stay native', () => {
  assert.equal(isStaticWorldbookSkillEntry(plain), true)
  for (const e of [...others, entry('empty', ''), entry('ejs', '<% broken'), entry('macro', '{{unknown}}'),
    entry('init', '{}', { comment: '[InitVar]初始化' }), entry('script', '<script>run()</script>'),
    entry('code', '```javascript\nrun()\n```'), entry('decorator', '@@generate\nplain')]) {
    assert.equal(isStaticWorldbookSkillEntry(e), false, e.ref)
  }
})
test('Skill mode preserves legacy activation, placement, rendering and cooldown for remaining entries', async () => {
  const native = project([plain, ...others]), legacy = project(others)
  const a = chat('native-skills'), b = chat('legacy')
  for (const [turn, userText] of [[1, 'nothing'], [2, 'topic'], [3, 'topic'], [14, 'topic']]) {
    a.messages = b.messages = [{ role: 'assistant', turn, text: '' }]
    const input = { card: { name: 'Hero' }, userText, requestKey: String(turn) }
    const actual = await native({ ...input, chat: a }), expected = await legacy({ ...input, chat: b })
    assert.equal(actual.error, null)
    for (const field of ['context', 'prefixContext', 'refs', 'reads', 'renderedEntries', 'macroState']) assert.deepEqual(actual[field], expected[field], field)
    assert.doesNotMatch(actual.context + actual.prefixContext, /STATIC OPTIONAL|MVU RULE|DISABLED/)
    assert.deepEqual(actual.virtualState.entries, {}, 'do not retain old dynamic snapshots')
    a.worldBookReads = actual.reads; b.worldBookReads = expected.reads
  }
})
test('preprocessing sees whole book; transformed static sources stay native and are not exported as stale Skills', async () => {
  const controller = entry('controller', '@@generate\n<%= control %>', { constant: true })
  const entries = [controller, plain]
  let seen
  const runtime = { render: async () => ({ ok: true, text: 'CONTROLLER', scopes: {} }),
    prepareWorldbook: async rows => { seen = rows.map(row => row.uid); return { entries: rows.map(row => row.uid === 'data' ? { ...row, content: 'TRANSFORMED', constant: true } : row), scopes: {} } } }
  const c = chat('native-skills')
  const result = await project(entries, runtime)({ chat: c, card: {}, userText: 'topic' })
  assert.deepEqual(seen, ['controller', 'data'])
  assert.match(result.context + result.prefixContext, /TRANSFORMED/)
  c.worldBookVirtualState = result.virtualState
  assert.deepEqual(eligibleVirtualSourceEntries({ view: { entries } }, c).filter(isStaticWorldbookSkillEntry), [])
})
test('full source book remains visible to template resource lookups while optional static text is excluded', async () => {
  let refs
  const result = await project([plain, ...others], { render: async (_text, context) => {
    refs = context.worldBookEntries.map(row => row.ref)
    return { ok: true, text: 'DYNAMIC', scopes: {} }
  } })({ chat: chat('native-skills'), card: {}, userText: 'topic' })
  assert.equal(result.error, null)
  assert.ok(refs.includes('data'))
  assert.doesNotMatch(result.context + result.prefixContext, /STATIC OPTIONAL/)
})
