import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWorldbookFiles } from '../tavern-plugin/lib/domain/worldbook-files.js'
import { virtualHash, virtualScope } from '../tavern-plugin/lib/domain/worldbook-virtual-state.js'

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worldbook-files-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const agent = { session: { id: 'game' } }
  const state = { chat: { sessionId: 'game', cardPath: '江湖.json', worldbookStrategy: 'native-skills' }, worldBook: { view: { entries: [
    { ref: 'a', title: '港口', content: 'Harbor\n港口秘密\n另一行港口' },
    { ref: 'b', title: '港口', content: '另一港口' },
    { ref: 'c', title: '常驻', content: '常驻秘密', constant: true },
    { ref: 'd', title: '动态', content: '<%= value %>' },
    { ref: 'e', title: '关闭', content: '关闭秘密', enabled: false },
    { ref: 'f', title: '[mvu_update]变量更新', content: '更新规则' }
  ] } } }
  const provider = createWorldbookFiles({ directory, load: async scope => scope === agent ? state : null })
  return { directory, agent, state, provider, lookup: { scope: agent } }
}

test('real static files support paged browse and grep, preserve source text and exclude runtime entries', async t => {
  const { provider, lookup } = await fixture(t)
  const listed = await provider.listFiles({ limit: 1 }, lookup)
  assert.equal(listed.total, 2); assert.equal(listed.nextOffset, 1)
  const next = await provider.listFiles({ offset: listed.nextOffset, version: listed.version }, lookup)
  assert.notEqual(next.files[0].path, listed.files[0].path)
  const names = await fs.readdir(listed.directory)
  assert.deepEqual(names.sort(), ['.scope-id', '港口--2.md', '港口.md'].sort())
  assert.match(await fs.readFile(listed.files[0].path, 'utf8'), /Harbor\n港口秘密/)
  const result = await provider.searchFiles({ query: 'HARBOR' }, lookup)
  assert.equal(result.total, 1); assert.equal(result.matches[0].line, 3)
  assert.equal((await provider.searchFiles({ query: 'HARBOR', caseSensitive: true }, lookup)).total, 0)
  const search = await provider.searchFiles({ query: '港口', limit: 2 }, lookup)
  assert.equal(search.total, 5); assert.equal(search.nextOffset, 2)
  assert.equal((await provider.searchFiles({ query: '港口', offset: 2, version: search.version }, lookup)).matches.length, 3)
  assert.equal((await provider.searchFiles({ query: '秘密' }, lookup)).total, 1)
  await assert.rejects(provider.searchFiles({ query: '', limit: 1 }, lookup), /query/)
  await assert.rejects(provider.listFiles({ limit: 0 }, lookup), /limit/)
})

test('edits revoke old paths, restart reuses generation, version reversal restores files, tampering is repaired', async t => {
  const { provider, lookup, state, directory, agent } = await fixture(t)
  const first = await provider.listFiles({}, lookup), original = state.worldBook.view.entries[0].content
  await fs.writeFile(first.files[0].path, 'tampered')
  assert.equal(await provider.authorizeRead(first.files[0].path, lookup), true)
  assert.match(await fs.readFile(first.files[0].path, 'utf8'), /Harbor/)
  state.worldBook.view.entries[0].content = '新港口'
  const second = await provider.listFiles({}, lookup)
  assert.notEqual(first.directory, second.directory)
  assert.equal(await provider.authorizeRead(first.files[0].path, lookup), false)
  await assert.rejects(provider.listFiles({ version: first.version }, lookup), /版本已变化/)
  const cold = createWorldbookFiles({ directory, load: async () => state })
  assert.equal((await cold.listFiles({}, { scope: agent })).directory, second.directory)
  state.worldBook.view.entries[0].content = original
  assert.equal((await provider.listFiles({}, lookup)).directory, first.directory)
  state.worldBook.view.entries = []
  assert.equal((await provider.listFiles({}, lookup)).total, 0)
  assert.equal(await provider.authorizeRead(first.files[0].path, lookup), false)
})

test('reads reject foreign scope, traversal, symlinks, cancellation and legacy mode', async t => {
  const { provider, lookup, state } = await fixture(t)
  const { files } = await provider.listFiles({}, lookup)
  assert.equal(await provider.authorizeRead(files[0].path, { scope: { session: { id: 'foreign' } } }), false)
  assert.equal(await provider.authorizeRead(path.join(files[0].path, '../../secret'), lookup), false)
  await fs.unlink(files[0].path); await fs.symlink(files[1].path, files[0].path)
  await assert.rejects(provider.authorizeRead(files[0].path, lookup), /symlink/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(provider.listFiles({}, { ...lookup, signal: abort.signal }))
  state.chat.worldbookStrategy = 'legacy'
  await assert.rejects(provider.listFiles({}, lookup), /没有可访问/)
})

test('preprocessing visibility remains authoritative and is never executed by file generation', async t => {
  const { provider, lookup, state } = await fixture(t)
  const entries = state.worldBook.view.entries
  entries.push({ ref: 'controller', constant: true, content: '@@generate_before\n<% throw new Error("never execute") %>' })
  assert.equal((await provider.listFiles({}, lookup)).total, 0)
  state.chat.worldBookVirtualState = { schemaVersion: 1, scope: virtualScope(state.chat), visibility: { version: virtualHash(entries), refs: ['a'] }, entries: {} }
  assert.equal((await provider.listFiles({}, lookup)).total, 1)
  entries[0].content = 'changed without runtime visibility update'
  assert.equal((await provider.listFiles({}, lookup)).total, 0)
})

 test('filenames preserve meaningful numbers, strip mechanical tags and remain Windows portable', async t => {
  const { provider, lookup, state } = await fixture(t)
  state.worldBook.view.entries = [
    {ref:'a', title:'158_[worldbook]科举·文科鼎甲', content:'原文'},
    {ref:'b', title:'1556年科举', content:'原文'},
    {ref:'c', title:'CON', content:'原文'},
    {ref:'d', title:'../路径/危险', content:'原文'}
  ]
  const listing = await provider.listFiles({},lookup)
  assert.deepEqual(listing.files.map(f=>path.basename(f.path)),['科举·文科鼎甲.md','1556年科举.md','_CON.md','路径-危险.md'])
})
