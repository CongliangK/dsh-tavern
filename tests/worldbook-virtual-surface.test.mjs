import test from 'node:test'
import assert from 'node:assert/strict'
import { virtualWorldbookRestoreRefs, withVirtualWorldbook } from '../tavern-plugin/lib/domain/worldbook-virtual-surface.js'
import { createForegroundFrameSessionAdapter } from '../tavern-plugin/lib/domain/foreground-frame-session-adapter.js'

const state = () => ({ schemaVersion: 1, scope: '["game","card"]', entries: {
  first: { text: '晴天', renderHash: 'sun' }, second: { text: '港口开放', renderHash: 'port' }
} })
function message(ref, text, hash, scope = state().scope) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-tavern', virtualWorldbook: { scope, entries: { [ref]: hash } } } }
}
function session(messages) {
  return { events: messages.map((data, seq) => ({ seq, type: 'user/message', data })), surface: { nodes: messages.map((_, i) => i) } }
}
test('restore is derived per entry from actual native surface after compaction and cold restart', () => {
  const live = session([message('first', '晴天', 'sun'), message('second', '港口开放', 'port')])
  assert.deepEqual(virtualWorldbookRestoreRefs(live, state()), [])
  live.surface.nodes = [1]
  assert.deepEqual(virtualWorldbookRestoreRefs(live, state()), ['first'])
  const cold = structuredClone(live)
  assert.deepEqual(virtualWorldbookRestoreRefs(cold, state()), ['first'])
  // Restoring is a request projection: repeated requests must continue to carry
  // the missing latest value, rather than an in-memory once-only restoration.
  assert.deepEqual(virtualWorldbookRestoreRefs(cold, state()), ['first'])
  cold.surface.nodes = []
  assert.deepEqual(virtualWorldbookRestoreRefs(cold, state()), ['first', 'second'])
})
test('old hash, wrong scope, producer or summarized content cannot suppress a latest snapshot', () => {
  for (const item of [message('first', '晴天', 'old'), message('first', '晴天', 'sun', 'other'), message('first', '摘要', 'sun'), { ...message('first', '晴天', 'sun'), source: { kind: 'user', virtualWorldbook: { scope: state().scope, entries: { first: 'sun' } } } }]) {
    assert.deepEqual(virtualWorldbookRestoreRefs(session([item]), state()), ['first', 'second'])
  }
})
test('native frames attach identity/hash evidence and do not coalesce distinct equal-text entries', () => {
  const adapter = createForegroundFrameSessionAdapter({ id: () => 'id' })
  const frame = { kind: 'foreground', frameId: 'frame', turn: 1, operationId: 'op', contributions: [{ slot: 'activeWorldbook', text: '晴天' }], source: { worldBook: { virtualWorldbook: { scope: state().scope, entries: { first: 'sun' } } } } }
  const first = adapter.append({ frame, step: 1, messages: [], session: session([]) }).messages[0]
  const next = { ...frame, frameId: 'next', source: { worldBook: { virtualWorldbook: { scope: state().scope, entries: { second: 'sun' } } } } }
  const second = adapter.append({ frame: next, step: 1, messages: [], session: session([first]) }).messages[0]
  assert.equal(first.source.virtualWorldbook.entries.first, 'sun')
  assert.equal(second.source.virtualWorldbook.entries.second, 'sun')
  assert.deepEqual(virtualWorldbookRestoreRefs(session([first]), state()), ['second'])
})
test('native request prefix preserves original whitespace without modifying persisted sections', () => {
  const fixed = [{ name: 'tavern:constant-worldbook', text: 'stale' }, { name: 'card', text: 'card' }]
  const result = withVirtualWorldbook(fixed, '  exact\n\n')
  assert.equal(result[0].text, '【常驻世界书】\n  exact\n\n')
  assert.equal(result[1], fixed[1])
  assert.equal(fixed[0].text, 'stale')
})

test('actual system assembly hook passes missing snapshots, leaves history untouched, and excludes background', async () => {
  const { registerTurnLifecycleHooks } = await import('../tavern-plugin/lib/hooks/turn-lifecycle.js')
  const hooks = new Map(), calls = []
  const nativeSession = { id: 'game', ...session([message('first', '晴天', 'sun')]) }
  const chat = { mode: 'story', worldbookStrategy: 'native-skills', worldBookVirtualState: state(), messages: [] }
  let background = false
  registerTurnLifecycleHooks({
    ctx: { on: (name, callback) => hooks.set(name, callback) },
    backgroundAgentRunner: { owns: () => background }, hookChatForSession: async () => chat,
    sessionStore: { flush: async () => assert.fail('assembly must not append restored snapshots to history') },
    turnOrchestrator: { modeFor: async () => 'story' }, ensureNativeSystemPrefix: async () => {},
    publishResourceWorkspace: async () => null, readChatCard: async () => ({}), runtimePrompt: () => '',
    foregroundStrategies: { assembleSystemPrompt: async (assembly, options) => ({ ...assembly, sections: options.fixedSystemSections }) },
    nativeWorldBookTemplateContext: async (_chat, _card, options) => {
      calls.push(options)
      return { prefixContext: '  STATIC EXACT\n\n港口开放' }
    }
  })
  const initial = structuredClone(nativeSession)
  const assemble = hooks.get('system-prompt/assemble')
  const result = await assemble({}, { agent: { session: nativeSession } }, async () => ({ sections: [] }))
  assert.deepEqual(calls[0], { restoreRefs: ['second'] })
  assert.match(result.sections[0].text, /  STATIC EXACT\n\n港口开放/)
  assert.deepEqual(nativeSession, initial)
  await assemble({}, { agent: { session: nativeSession } }, async () => ({ sections: [] }))
  assert.deepEqual(calls[1], { restoreRefs: ['second'] }, 'request-only recovery survives subsequent requests')
  background = true
  await assemble({}, { agent: { session: nativeSession } }, async () => ({ sections: [] }))
  assert.equal(calls.length, 2)
})

test('empty renders restore their withdrawal marker, not the formerly rendered facts', () => {
  const current = state()
  current.entries.first = { text: '', contextText: '[first withdrawn]', renderHash: 'empty' }
  assert.deepEqual(virtualWorldbookRestoreRefs(session([message('first', '晴天', 'sun')]), current), ['first', 'second'])
  assert.deepEqual(virtualWorldbookRestoreRefs(session([message('first', '[first withdrawn]', 'empty')]), current), ['second'])
})

test('small entry edits append deltas while preserving base messages and restoration evidence', () => {
  const adapter = createForegroundFrameSessionAdapter({ id: () => crypto.randomUUID() })
  const scope = 'test-card', messages = []
  const body = value => '# 通用规则\n' + '不变的世界规则。\n'.repeat(100) + '\n关系：' + value + '\n结尾规则。'
  const append = value => {
    const text = body(value), frame = { kind: 'foreground', frameId: 'frame-' + value, contributions: [{ slot: 'activeWorldbook', text }], source: { worldBook: { virtualWorldbook: { scope, entries: { a: value }, texts: { a: text } } } } }
    const before = JSON.stringify(messages)
    const result = adapter.append({ frame, step: 1, messages: [], session: session(messages) }).messages
    assert.equal(JSON.stringify(messages), before, 'never mutate historical cache prefix')
    messages.push(...result)
    return result[0].content[0].text
  }
  assert.match(append('19'), /不变的世界规则/)
  const delta = append('22')
  assert.match(delta, /旧段落：\n关系：19\n新段落：\n关系：22/)
  assert.doesNotMatch(delta, /不变的世界规则/)
  append('25')
  const current = { schemaVersion: 1, scope, entries: { a: { text: body('25'), renderHash: '25' } } }
  assert.deepEqual(virtualWorldbookRestoreRefs(session(messages), current), [])
  assert.deepEqual(virtualWorldbookRestoreRefs(session(messages.slice(1)), current), ['a'], 'missing base restores full body')
  assert.deepEqual(virtualWorldbookRestoreRefs(session([messages[0], messages[2]]), current), ['a'], 'missing intermediate update restores full body')
  messages.splice(1)
  assert.match(append('26'), /关系：19/, 'rewind uses live base, not future state')
})

test('fixed platform rules persist once while current state and card tail instructions remain per turn', () => {
  const adapter = createForegroundFrameSessionAdapter({ id: () => crypto.randomUUID() })
  const frame = id => ({ kind: 'foreground', frameId: id, contributions: [
    { slot: 'writingRules', text: '固定写作原则', source: { stage: 'context-plan', sectionKind: 'base' } },
    { slot: 'currentStateProjection', text: '当前现场' },
    { slot: 'writingRules', text: '卡片尾部指令', source: { stage: 'context-plan', sectionKind: 'card-instruction' } }
  ] })
  const first = adapter.append({ frame: frame('one'), step: 1, messages: [] }).messages
  const second = adapter.append({ frame: frame('two'), step: 1, messages: [], session: session(first) }).messages
  const text = JSON.stringify(second.map(m => m.content))
  assert.doesNotMatch(text, /固定写作原则/)
  assert.match(text, /当前现场/)
  assert.match(text, /卡片尾部指令/)
  const restored = adapter.append({ frame: frame('three'), step: 1, messages: [], session: session(first.slice(1)) }).messages
  assert.match(JSON.stringify(restored.map(m => m.content)), /固定写作原则/)
})

test('delta falls back for ambiguous edits, insertions and markup; isolated cards never borrow a base', async () => {
  const { worldbookContextDelta } = await import('../tavern-plugin/lib/domain/worldbook-context-delta.js')
  const base = '# 规则\n' + '稳定内容\n'.repeat(100) + '重复行\n重复行\n<state>旧</state>'
  const marker = { scope: 'one', texts: { a: base } }
  const first = worldbookContextDelta(null, marker, base)
  const history = [{ content: [{ type: 'text', text: first.text }], source: { kind: 'plugin:dsh-tavern', virtualWorldbook: marker, worldbookEntrySnapshots: first.records } }]
  for (const next of [base.replace('重复行', '新行'), base + '\n新增', base.replace('<state>旧</state>', '<state>新</state>')]) {
    assert.equal(worldbookContextDelta(null, { scope: 'one', texts: { a: next } }, next, history).text, next)
  }
  const next = base.replace('# 规则', '# 新规则')
  assert.equal(worldbookContextDelta(null, { scope: 'other', texts: { a: next } }, next, history).text, next)
})

test('fixed rule changes append a replacement and retries preserve existing messages byte for byte', () => {
  const adapter = createForegroundFrameSessionAdapter({ id: () => crypto.randomUUID() })
  const frame = (id, text) => ({ kind: 'foreground', frameId: id, contributions: [{ slot: 'writingRules', text, source: { stage: 'context-plan', sectionKind: 'base' } }] })
  const one = adapter.append({ frame: frame('one', '旧原则'), step: 1, messages: [] }).messages
  const before = JSON.stringify(one)
  const two = adapter.append({ frame: frame('two', '新原则'), step: 1, messages: one }).messages
  assert.equal(JSON.stringify(one), before)
  assert.equal(two.length, 2)
  assert.match(two[1].content[0].text, /新原则/)
  assert.deepEqual(adapter.append({ frame: frame('two', '新原则'), step: 1, messages: two }).messages, two)
})
