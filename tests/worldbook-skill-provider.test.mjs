import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldbookSkillProvider } from '../tavern-plugin/lib/domain/worldbook-skill-provider.js'
import { compileWorldbookSkillClusters } from '../tavern-plugin/lib/domain/worldbook-skill-clustering.js'
import { installWorldbookSkillRead, nativeWorldbookReadAvailable } from '../tavern-plugin/lib/domain/worldbook-skill-read.js'

function fixture(t, extra = {}) {
  const entry = { ref: 'merged:42', sourceUid: 7, sourcePath: 'worldbooks/source.json', title: '城门守卫', primaryKeys: ['城门'], secondaryKeys: ['通行'], content: '  PRIVATE FULL BODY\n\n原文末尾  ', enabled: true }
  const states = new Map(['one', 'two'].map(sessionId => [sessionId, { chat: { id: sessionId, sessionId, cardPath: 'cards/a.json', worldbookStrategy: 'native-skills' }, worldBook: { view: { displayName: 'Current book', entries: [structuredClone(entry)] } } }]))
  const scopes = new Map([...states.keys()].map(id => [id, { session: { id } }]))
  const results = new Map()
  const catalog = { async update(key, entries) { const next = compileWorldbookSkillClusters(entries, { previousClusters: results.get(key)?.clusters }); results.set(key, next); return next }, dispose(key) { if (key) results.delete(key); else results.clear() } }
  const provider = createWorldbookSkillProvider({ load: async scope => scope.background ? null : states.get(scope.session.id), catalog, ...extra })
  t.after(() => provider.dispose())
  const lookup = id => ({ scope: scopes.get(id) || { session: { id } } })
  const candidate = async id => (await provider.list(lookup(id))).candidates[0]
  const paths = async id => { const skill = await candidate(id); const base = skill.resourceBase.path; const index = await provider.readResource(base + '/INDEX.md', lookup(id)); return { skill, base, entry: base + '/' + index.match(/entries\/[a-f0-9]+\.md/)[0] } }
  return { states, scopes, provider, lookup, candidate, paths }
}

test('cluster catalog and SKILL/INDEX contain metadata only; entry resources preserve exact original bytes', async t => {
  const f = fixture(t), before = structuredClone([...f.states])
  const a = await f.paths('one'), b = await f.paths('two')
  assert.notEqual(a.skill.name, b.skill.name)
  const guide = await f.provider.get(a.skill, f.lookup('one'))
  assert.doesNotMatch(JSON.stringify(await f.provider.list(f.lookup('one'))), /PRIVATE FULL BODY/)
  assert.doesNotMatch(guide.content, /PRIVATE FULL BODY/)
  assert.match(guide.content, /INDEX.md/)
  assert.doesNotMatch(await f.provider.readResource(a.base + '/INDEX.md', f.lookup('one')), /PRIVATE FULL BODY/)
  assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), f.states.get('one').worldBook.view.entries[0].content)
  assert.deepEqual([...f.states], before)
})

test('all reads revalidate current game, source edits, disabled entries, strategy and card switches', async t => {
  const f = fixture(t), a = await f.paths('one'), state = f.states.get('one'), entry = state.worldBook.view.entries[0]
  assert.equal(await f.provider.get(a.skill, f.lookup('two')), undefined)
  assert.equal(await f.provider.readResource(a.entry, f.lookup('two')), undefined)
  assert.equal(await f.provider.readResource(a.entry, { scope: { session: { id: 'one' }, background: true } }), undefined)
  assert.deepEqual((await f.provider.list({})).candidates, [])
  entry.content = 'EDITED EXACT\n'; assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), entry.content)
  assert.equal((await f.candidate('one')).name, a.skill.name)
  entry.enabled = false; assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), undefined)
  entry.enabled = true; state.chat.worldbookStrategy = 'legacy'; assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), undefined)
  state.chat.worldbookStrategy = 'native-skills'; state.chat.cardPath = 'cards/b.json'; assert.equal(await f.provider.readResource(a.entry, f.lookup('one')), undefined)
  state.chat.cardPath = 'cards/a.json'; state.worldBook.view.entries = []; assert.equal(await f.provider.get(a.skill, f.lookup('one')), undefined)
})

test('only static nonconstant entries are skills; discovery never calls templates', async t => {
  let executions = 0
  const f = fixture(t, { render() { executions++; throw Error('must not execute') } }), entries = f.states.get('one').worldBook.view.entries
  entries.push({ ...entries[0], ref: 'constant', constant: true }, { ...entries[0], ref: 'dynamic', content: '<%= Math.random() %>' }, { ...entries[0], ref: 'macro', content: '{{getvar::x}}' }, { ...entries[0], ref: 'disabled', enabled: false }, { ...entries[0], ref: 'mvu', title: '[mvu_update]变量更新规则', comment: '[mvu_update]变量更新规则' })
  const a = await f.paths('one')
  assert.deepEqual(a.skill.metadata.worldbook.refs, ['merged:42'])
  await f.provider.get(a.skill, f.lookup('one')); await f.provider.readResource(a.entry, f.lookup('one'))
  assert.equal(executions, 0)
})

test('edit during asynchronous compilation cannot publish stale content or stale permission', async t => {
  const f = fixture(t)
  let first = true, started, resume
  const entered = new Promise(resolve => { started = resolve }), blocked = new Promise(resolve => { resume = resolve })
  const provider = createWorldbookSkillProvider({ load: async () => f.states.get('one'), catalog: { async update(_key, entries) { const output = compileWorldbookSkillClusters(entries); if (first) { first = false; started(); await blocked } return output }, dispose() {} } })
  t.after(() => provider.dispose())
  const pending = provider.list(f.lookup('one')); await entered
  f.states.get('one').worldBook.view.entries[0].constant = true; resume()
  assert.deepEqual((await pending).candidates, [])
})

test('unavailable native resource reader means no unusable skills advertised', async t => {
  const f = fixture(t, { resourcesAvailable: () => false })
  assert.deepEqual((await f.provider.list(f.lookup('one'))).candidates, [])
})

const readTool = { parameters: { type: 'object', properties: { file_path: {} } }, output: { schema: { properties: { path: {}, lines: {}, totalLines: {} } } } }
test('native read adapter uses exact existing protocol, denies cross-game/traversal, and passes ordinary reads through', async t => {
  const f = fixture(t), a = await f.paths('one')
  let handler, ordinary = 0
  const ctx = { tools: { get: name => name === 'read' ? readTool : undefined }, on(name, fn) { assert.equal(name, 'tools/execute'); handler = fn; return () => {} } }
  assert.equal(nativeWorldbookReadAvailable(ctx.tools, f.scopes.get('one')), true)
  installWorldbookSkillRead(ctx, f.provider)
  const run = (path, agent = f.scopes.get('one'), args = {}) => handler({ name: 'read', arguments: { file_path: path, ...args }, agent, signal: new AbortController().signal }, () => { ordinary++; return 'ordinary' })
  const result = await run(a.entry)
  assert.equal(result.value.lines.map(line => line.text).join('\n'), f.states.get('one').worldBook.view.entries[0].content)
  assert.deepEqual((await run(a.entry, undefined, { offset: 2, limit: 1 })).value.lines, [{ number: 2, text: '' }])
  await assert.rejects(run(a.entry, f.scopes.get('two')), /no longer available/)
  await assert.rejects(run(a.base + '/../INDEX.md'), /Invalid/)
  await assert.rejects(run(a.entry, null), /current game/)
  await assert.rejects(run(a.entry, undefined, { offset: 0 }), /positive/)
  assert.equal(await run('/ordinary.txt'), 'ordinary'); assert.equal(ordinary, 1)
})

test('read view is bounded without modifying its original resource; ordinary marker filenames pass through', async t => {
  const f = fixture(t)
  f.states.get('one').worldBook.view.entries[0].content = 'x'.repeat(300000)
  const a = await f.paths('one')
  let handler
  installWorldbookSkillRead({ tools: { get: () => readTool }, on(_name, fn) { handler = fn } }, f.provider)
  const call = path => handler({ name: 'read', arguments: { file_path: path }, agent: f.scopes.get('one'), signal: new AbortController().signal }, () => 'ordinary')
  assert.equal(await call('/notes/__tavern_worldbook__/notes.txt'), 'ordinary')
  const result = await call(a.entry)
  assert.ok(result.value.lines[0].text.length < 2100)
  assert.match(result.value.lines[0].text, /line truncated/)
  assert.equal((await f.provider.readResource(a.entry, f.lookup('one'))).length, 300000)
})

test('pre-step refresh rejects promptly when its caller aborts pending compilation', async t => {
  const f = fixture(t)
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const provider = createWorldbookSkillProvider({ load: async () => f.states.get('one'), catalog: { update: () => pending, dispose() {} } })
  t.after(() => provider.dispose())
  const abort = new AbortController()
  const refreshing = provider.refresh(f.scopes.get('one'), { signal: abort.signal })
  await new Promise(resolve => setImmediate(resolve))
  abort.abort(new Error('stopped'))
  await assert.rejects(refreshing, /stopped/)
  complete({ clusters: [] })
})

test('mounting read for native gameplay does not grant ordinary filesystem access', async t => {
  const f = fixture(t)
  let handler
  installWorldbookSkillRead({ tools: { get: () => readTool }, on(_name, fn) { handler = fn } }, f.provider, { virtualOnly: async scope => scope === f.scopes.get('one') })
  const run = agent => handler({ name: 'read', arguments: { file_path: '/private.txt' }, agent }, () => 'ordinary')
  await assert.rejects(run(f.scopes.get('one')), /limited to its virtual/)
  assert.equal(await run(f.scopes.get('two')), 'ordinary')
})

test('preprocessing-controlled books require current runtime visibility, never execute scripts during discovery', async t => {
  const f = fixture(t), state = f.states.get('one')
  state.worldBook.view.entries.push({ ref: 'controller', content: '@@generate_before\n<% filterEntries() %>', constant: true, enabled: true })
  assert.deepEqual((await f.provider.list(f.lookup('one'))).candidates, [])
  const { virtualHash, virtualScope } = await import('../tavern-plugin/lib/domain/worldbook-virtual-state.js')
  state.chat.worldBookVirtualState = { schemaVersion: 1, scope: virtualScope(state.chat), entries: {}, visibility: { version: virtualHash(state.worldBook.view.entries), refs: ['merged:42'] } }
  assert.equal((await f.provider.list(f.lookup('one'))).candidates.length, 1)
  state.chat.worldBookVirtualState.visibility.refs = []
  assert.deepEqual((await f.provider.list(f.lookup('one'))).candidates, [])
  state.chat.worldBookVirtualState.visibility.refs = ['merged:42']
  state.worldBook.view.entries[0].content = 'new source invalidates old visibility'
  assert.deepEqual((await f.provider.list(f.lookup('one'))).candidates, [])
})

test('inspector shares actual catalog, excludes bodies and revalidates entry paths', async t => {
  const f = fixture(t)
  const view = await f.provider.inspect(f.lookup('one'))
  assert.equal(view.clusters[0].name, (await f.candidate('one')).name)
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE FULL BODY/)
  const entry = view.clusters[0].entries[0]
  assert.equal(await f.provider.readResource(entry.path, f.lookup('one')), f.states.get('one').worldBook.view.entries[0].content)
  assert.equal(await f.provider.readResource(entry.path, f.lookup('two')), undefined)
  f.states.get('one').chat.worldbookStrategy = 'legacy'
  assert.equal(await f.provider.inspect(f.lookup('one')), null)
})
