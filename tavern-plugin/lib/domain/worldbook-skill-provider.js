import fs from 'node:fs/promises'
import path from 'node:path'
import { createWorldbookSkillFiles, skillDigest, skillFileLabel, referenceFile } from './worldbook-skill-files.js'
import { isMvuUpdateEntry } from './worldbook-recall.js'
import { classifyWorldbookEntry } from './worldbook-entry-classification.js'
import { createWorldbookSkillCatalog } from './worldbook-skill-catalog.js'
import { eligibleVirtualSourceEntries } from './worldbook-virtual-state.js'

const digest = skillDigest
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const eligible = entry => entry.enabled !== false && !isMvuUpdateEntry(entry) && text(entry.content) && classifyWorldbookEntry(entry).kind === 'static-skill'
export const WORLDBOOK_SKILL_RESOURCE_ROOT = '/__tavern_worldbook__/'
const scopeKey = state => digest(JSON.stringify([state.chat.sessionId, state.chat.id, state.chat.cardPath]))
const members = (state, cluster) => entriesOf(state).filter(entry => cluster.refs.includes(entry.ref))
const clusterDirectory = cluster => cluster.directoryName
export function nameWorldbookSkillDirectories(clusters) {
  const used = new Set(), names = new Map()
  // Stable ordering makes collision suffixes independent of catalog display order.
  for (const cluster of [...clusters].sort((a, b) => a.id.localeCompare(b.id))) {
    const base = skillFileLabel(cluster.title.replace(/[\s·]+/g, '、'))
    let name = base, suffix = 2
    while (used.has(name.toLocaleLowerCase('en-US'))) name = `${base}--${suffix++}`
    used.add(name.toLocaleLowerCase('en-US')); names.set(cluster.id, name)
  }
  return clusters.map(cluster => ({ ...cluster, directoryName: names.get(cluster.id) }))
}
const sourceEntries = new WeakMap()
const entriesOf = state => {
  if (!sourceEntries.has(state)) sourceEntries.set(state, eligibleVirtualSourceEntries(state.worldBook, state.chat).filter(eligible))
  return sourceEntries.get(state)
}
const versionOf = state => JSON.stringify(entriesOf(state))
function abortable(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Worldbook lookup aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Per-game discovery with real, derived Skill bundles. JSON is authoritative;
 * the host's native read tool reads the synchronized files. */
export function createWorldbookSkillProvider({ load, directory, catalog = createWorldbookSkillCatalog(), resourcesAvailable = () => true }) {
  if (!directory) throw new Error('Worldbook Skill output directory is required')
  const files = createWorldbookSkillFiles(directory)
  const sessionKeys = new Map()
  const provider = 'tavern-worldbook'
  const scopes = new WeakMap()
  const owners = new Map()
  const release = key => {
    const count = (owners.get(key) || 1) - 1
    if (count > 0) owners.set(key, count)
    else { owners.delete(key); catalog.dispose(key) }
  }
  const collected = new FinalizationRegistry(release)
  function track(scope, key) {
    if (!scope || typeof scope !== 'object') return
    const previous = scopes.get(scope)
    if (previous === key) return
    if (previous) { collected.unregister(scope); release(previous) }
    if (key) { scopes.set(scope, key); owners.set(key, (owners.get(key) || 0) + 1); collected.register(scope, key, scope) }
    else scopes.delete(scope)
  }
  async function stateFor(lookup) {
    lookup?.signal?.throwIfAborted()
    if (!lookup?.scope?.session?.id) return null
    const state = await load(lookup.scope)
    if (state) sourceEntries.delete(state)
    const allowed = state?.chat?.sessionId === lookup.scope.session.id && state.chat.worldbookStrategy === 'native-skills' && resourcesAvailable(lookup.scope)
    track(lookup.scope, allowed ? scopeKey(state) : null)
    return allowed ? state : null
  }
  function candidate(state, cluster) {
    const key = scopeKey(state)
    const directory = path.join(files.directory(key), clusterDirectory(cluster))
    return {
      name: `wb-${key}-${cluster.id}`,
      description: `涉及${cluster.keywords.join('、')}时查阅。包含：${members(state, cluster).slice(0, 5).map(e => text(e.title || e.comment || e.ref)).join('；')}。`,
      invocation: { modelInvocable: true, userInvocable: false }, source: provider, provider, rank: 600,
      locator: { sessionId: state.chat.sessionId, scopeKey: key, clusterId: cluster.id },
      resourceBase: { kind: 'directory', path: directory },
      metadata: { worldbook: { refs: cluster.refs, keywords: cluster.keywords, book: state.worldBook.view.displayName } }
    }
  }
  const operations = new Map()
  async function current(lookup) {
    const id = lookup?.scope?.session?.id || ''
    const job = (operations.get(id) || Promise.resolve()).catch(() => {}).then(() => buildCurrent(lookup))
    operations.set(id, job)
    try { return await job } finally { if (operations.get(id) === job) operations.delete(id) }
  }
  async function buildCurrent(lookup) {
    // Edits during the worker build cannot authorize the old result. Retry only
    // while the caller remains live; each generation is cancelled by catalog.update.
    for (;;) {
      const state = await stateFor(lookup)
      if (!state) {
        const previous = sessionKeys.get(lookup?.scope?.session?.id)
        if (previous) { sessionKeys.delete(lookup.scope.session.id); await files.remove(previous) }
        return null
      }
      const version = versionOf(state), key = scopeKey(state)
      let compiled = await abortable(catalog.update(key, entriesOf(state)), lookup?.signal)
      lookup?.signal?.throwIfAborted()
      const latest = await stateFor(lookup)
      if (!latest) return null
      if (scopeKey(latest) !== key || versionOf(latest) !== version) continue
      compiled = { ...compiled, clusters: nameWorldbookSkillDirectories(compiled.clusters) }
      const prepared = documents(latest, compiled)
      await files.sync(key, prepared)
      const verified = await stateFor(lookup)
      if (!verified || scopeKey(verified) !== key || versionOf(verified) !== version) {
        await files.remove(key)
        if (!verified) return null
        continue
      }
      const previousKey = sessionKeys.get(verified.chat.sessionId)
      sessionKeys.set(verified.chat.sessionId, key)
      if (previousKey && previousKey !== key) await files.remove(previousKey)
      return { state: verified, compiled, documents: prepared }
    }
  }
  const versions = new WeakMap()
  function guide(state, cluster) {
    const item = candidate(state, cluster)
    const entries = members(state, cluster)
    const label = value => text(value).replace(/[\[\]\\]/g, '\\$&')
    return `---\nname: ${item.name}\ndescription: ${JSON.stringify(item.description)}\n---\n\n# ${cluster.title}\n\n` + entries.map(entry => `- [${label(entry.title || entry.comment || entry.ref)}](${referenceFile(entry, entries)})`).join('\n') + '\n'
  }
  function documents(state, compiled) {
    const output = new Map()
    for (const cluster of compiled.clusters) {
      const base = clusterDirectory(cluster)
      output.set(`${base}/SKILL.md`, guide(state, cluster))
      const entries = members(state, cluster)
      for (const entry of entries) output.set(`${base}/${referenceFile(entry, entries)}`, String(entry.content ?? ''))
    }
    return output
  }
  async function resource(resourcePath, lookup) {
    const result = await current(lookup)
    if (!result || !path.isAbsolute(resourcePath) || path.normalize(resourcePath) !== resourcePath) return undefined
    const base = files.directory(scopeKey(result.state))
    const relative = path.relative(base, resourcePath).split(path.sep).join('/')
    if (!result.documents.has(relative)) return undefined
    await files.verify(resourcePath, result.documents.get(relative))
    return resourcePath
  }
  return {
    name: provider,
    directory: files.root,
    ownsPath(resourcePath) {
      const relative = path.relative(files.root, path.resolve(String(resourcePath || '')))
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    },
    async authorizeRead(resourcePath, lookup) { return Boolean(await resource(resourcePath, lookup)) },
    async removeChat(chat) {
      if (!chat) return
      const key = sessionKeys.get(chat.sessionId) || scopeKey({ chat })
      sessionKeys.delete(chat.sessionId)
      await files.remove(key)
    },
    async refresh(scope, { signal } = {}) {
      if (!scope || typeof scope !== 'object') return false
      const result = await current({ scope, signal })
      const candidates = result ? result.compiled.clusters.map(cluster => candidate(result.state, cluster)) : []
      const version = JSON.stringify(candidates), previous = versions.get(scope)
      versions.set(scope, version)
      return previous === undefined ? candidates.length > 0 : previous !== version
    },
    async inspect(lookup) {
      const result = await current(lookup)
      if (!result) return null
      const entries = entriesOf(result.state)
      return { directory: files.directory(scopeKey(result.state)), book: result.state.worldBook.view.displayName, metrics: result.compiled.metrics,
        clusters: result.compiled.clusters.map(cluster => {
          const item = candidate(result.state, cluster)
          return { name: item.name, title: cluster.title, keywords: cluster.keywords, guide: guide(result.state, cluster), directory: item.resourceBase.path,
            entries: entries.filter(entry => cluster.refs.includes(entry.ref)).map(entry => ({
              ref: entry.ref, title: text(entry.title || entry.comment || entry.ref),
              source: entry.sourcePath, uid: entry.sourceUid,
              path: path.join(item.resourceBase.path, referenceFile(entry, members(result.state, cluster))),
              previousPath: path.join(files.directory(scopeKey(result.state)), `${skillFileLabel(cluster.title)}--${cluster.id}`, referenceFile(entry, members(result.state, cluster))),
              legacyPath: `${WORLDBOOK_SKILL_RESOURCE_ROOT}${scopeKey(result.state)}/${cluster.id}/entries/${digest(entry.ref)}.md`
            })) }
        }) }
    },
    async list(lookup) {
      const result = await current(lookup)
      return { candidates: result ? result.compiled.clusters.map(cluster => candidate(result.state, cluster)) : [], complete: true }
    },
    async get(previous, lookup) {
      const result = await current(lookup)
      if (!result || previous.locator?.sessionId !== result.state.chat.sessionId || previous.locator.scopeKey !== scopeKey(result.state)) return undefined
      const cluster = result.compiled.clusters.find(item => item.id === previous.locator.clusterId)
      if (!cluster) return undefined
      const fresh = candidate(result.state, cluster)
      if (fresh.name !== previous.name) return undefined
      const file = path.join(fresh.resourceBase.path, 'SKILL.md')
      await files.verify(file, guide(result.state, cluster))
      return { ...fresh, content: (await fs.readFile(file, 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '').trim() }
    },
    async readResource(resourcePath, lookup) {
      const file = await resource(resourcePath, lookup)
      return file ? fs.readFile(file, 'utf8') : undefined
    },
    dispose(scope) {
      if (scope) { track(scope, null); versions.delete(scope) }
      else { catalog.dispose(); owners.clear() }
    }
  }
}
