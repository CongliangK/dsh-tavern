import fs from 'node:fs/promises'
import path from 'node:path'
import { createWorldbookFileStore, worldbookFileDigest, worldbookFileLabel } from './worldbook-file-store.js'
import { worldbookEntryTitle } from './worldbook-entry-title.js'
import { isStaticWorldbookSkillEntry } from './worldbook-entry-classification.js'
import { eligibleVirtualSourceEntries } from './worldbook-virtual-state.js'

const sourceIdentity = source => source?.kind === 'merged'
  ? ['merged', (source.sources || []).map(sourceIdentity)]
  : [source?.kind || '', source?.cardPath || source?.path || '']
function entryIdentity(state, entry) {
  if (entry.plugin) return entry.ref
  const origin = state.worldBook?.mergedSources?.find(book => book.entries.some(item => String(item.uid) === String(entry.sourceUid)))
  const uid = origin?.entries.find(item => String(item.uid) === String(entry.sourceUid))?.originalUid ?? entry.sourceUid ?? entry.ref
  return JSON.stringify([sourceIdentity(origin?.source || state.worldBook?.source), uid])
}

// JSON remains authoritative. Immutable content generations can be shared by games;
// every operation resolves the calling game's CURRENT generation before granting access.
export function createWorldbookFiles({ directory, load, resourcesAvailable = () => true }) {
  const files = createWorldbookFileStore(directory), snapshots = new WeakMap()
  async function current(lookup) {
    lookup?.signal?.throwIfAborted()
    const scope = lookup?.scope
    if (!scope?.session?.id || !resourcesAvailable(scope)) return null
    const state = await load(scope)
    if (!state || (state.authorizedSessionId || state.chat?.sessionId) !== scope.session.id || state.chat.worldbookStrategy !== 'native-skills') return null
    const entries = eligibleVirtualSourceEntries(state.worldBook, state.chat).filter(isStaticWorldbookSkillEntry)
      .sort((a, b) => String(a.ref).localeCompare(String(b.ref)))
    const used = new Set()
    const rows = entries.map(entry => {
      let base = worldbookFileLabel(worldbookEntryTitle(entry))
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base)) base = '_' + base
      let name = base, n = 2
      while (used.has(name.toLowerCase())) name = base + '--' + n++
      used.add(name.toLowerCase())
      return { ref: entry.ref, identity: entryIdentity(state, entry), title: worldbookEntryTitle(entry), filename: name + '.md', content: '# ' + worldbookEntryTitle(entry) + '\n\n' + String(entry.content) + '\n' }
    })
    const key = worldbookFileDigest(JSON.stringify([state.chat.cardPath, rows]))
    await files.assign(key, state.chat.cardPath ? path.parse(state.chat.cardPath).name : state.worldBook?.view?.displayName || '世界书', { versioned: true })
    await files.sync(key, new Map(rows.map(row => [row.filename, row.content])))
    lookup?.signal?.throwIfAborted()
    const root = files.directory(key)
    return { key, root, rows: rows.map(row => ({ ...row, path: path.join(root, row.filename) })) }
  }
  async function resource(requested, lookup) {
    const view = await current(lookup)
    const row = view?.rows.find(row => row.path === path.resolve(String(requested || '')))
    if (!row) return null
    await files.verify(row.path, row.content)
    return row
  }
  function page(args) {
    const offset = args.offset ?? 0, limit = args.limit ?? 30
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('offset 必须为非负整数，limit 必须为 1–100')
    return { offset, limit }
  }
  async function viewFor(args, lookup) {
    const view = await current(lookup)
    if (!view) throw Error('当前任务没有可访问的静态世界书文件')
    if (args.version && args.version !== view.key) throw Error('世界书资料版本已变化，请从第一页重新搜索或浏览')
    return view
  }
  return {
    directory: files.root,
    ownsPath(requested) {
      const relative = path.relative(files.root, path.resolve(String(requested || '')))
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    },
    async authorizeRead(requested, lookup) { return Boolean(await resource(requested, lookup)) },
    async listFiles(args, lookup) {
      const { offset, limit } = page(args), view = await viewFor(args, lookup)
      return { directory: view.root, version: view.key, total: view.rows.length, offset,
        nextOffset: offset + limit < view.rows.length ? offset + limit : null,
        files: view.rows.slice(offset, offset + limit).map(({ path, title }) => ({ path, title })) }
    },
    async searchFiles(args, lookup) {
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500) throw Error('query 需要 1–500 字符的非空搜索文本')
      const { offset, limit } = page(args), view = await viewFor(args, lookup)
      const needle = args.caseSensitive ? args.query : args.query.toLowerCase()
      const matches = []; let total = 0
      for (const row of view.rows) {
        lookup?.signal?.throwIfAborted()
        await files.verify(row.path, row.content)
        const lines = (await fs.readFile(row.path, 'utf8')).split('\n')
        for (let i = 0; i < lines.length; i++) {
          const position = (args.caseSensitive ? lines[i] : lines[i].toLowerCase()).indexOf(needle)
          if (position < 0) continue
          if (total >= offset && matches.length < limit) {
            const start = Math.max(0, position - 120), end = Math.min(lines[i].length, start + 800)
            matches.push({ path: row.path, line: i + 1, text: lines[i].slice(start, end), truncated: start > 0 || end < lines[i].length })
          }
          total++
        }
      }
      return { directory: view.root, version: view.key, total, offset, nextOffset: offset + limit < total ? offset + limit : null, matches }
    },
    async refresh(scope, { signal } = {}) {
      const view = await current({ scope, signal })
      const snapshot = view ? { directory: view.root, entries: view.rows.map(row => ({ ref: row.identity, title: row.title, hash: worldbookFileDigest(row.content) })) } : { directory: '', entries: [] }
      snapshot.version = worldbookFileDigest(JSON.stringify(snapshot))
      const changed = snapshots.get(scope)?.version !== snapshot.version
      snapshots.set(scope, snapshot)
      return changed
    },
    changeSnapshot(scope) { return snapshots.get(scope) },
    async removeChat() {}, // Other games and saved versions may still use these derived files.
    async inspect(lookup) {
      const view = await current(lookup)
      return view ? { directory: view.root, version: view.key, files: view.rows.map(({ path, title, ref }) => ({ path, title, ref })), clusters: [] } : null
    },
    async readEntry(ref, lookup) { const view = await current(lookup); return view?.rows.find(row => row.ref === ref)?.content },
    async readResource(requested, lookup) { const row = await resource(requested, lookup); return row ? fs.readFile(row.path, 'utf8') : undefined },
    dispose(scope) { if (scope) snapshots.delete(scope) }
  }
}
