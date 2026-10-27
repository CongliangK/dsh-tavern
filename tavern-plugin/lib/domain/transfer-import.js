import path from 'node:path'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function stemOf(value) {
  return path.posix.basename(str(value), path.posix.extname(str(value))) || '未命名'
}

const IMPORTABLE = Object.freeze(['cards', 'worldbooks', 'presets', 'prompts', 'profile', 'regex', 'settings', 'chats', 'plugins', 'scripts', 'fonts'])
const SETTINGS_PART = 'settings'

/** A name that does not collide: 名字, 名字 (2), 名字 (3), … */
function uniqueName(taken, base, limit = 60) {
  const key = value => String(value).toLowerCase()
  if (!taken.has(key(base))) return base
  for (let index = 2; index < limit; index += 1) {
    const candidate = base + ' (' + index + ')'
    if (!taken.has(key(candidate))) return candidate
  }
  return base + ' (' + Date.now() + ')'
}

function errorText(error) {
  return str(error && (error.message || error)).slice(0, 300) || '未知错误'
}

/**
 * Import a `.dshtransfer` bundle: preview shows what would happen, apply writes it.
 * Defaults are additive — a same-named card/world book/preset/profile is added as a copy, never
 * overwritten. The one singleton, settings, merges whitelisted fields after a backup.
 */
export function createTransferImport(deps) {
  const { fileResources, worldBooks, presetLibrary, promptDocuments, userPreferenceProfile, regexManager,
    readTavernSettings, updateTavernSettings, importCard, importPreset, backup, chats, plugins, materials, fonts } = deps

  async function cardIndex() {
    const names = new Set(), stems = new Set()
    for (const cardPath of await fileResources.list('card').catch(() => [])) {
      stems.add(stemOf(cardPath))
      const text = await fileResources.readText(cardPath).catch(() => undefined)
      if (text === undefined) continue
      try {
        const value = JSON.parse(text)
        if (str(value && value.name)) names.add(str(value.name))
      } catch { /* keep the stem only */ }
    }
    return { names, stems }
  }

  async function existingIndex() {
    const [cards, worlds, presets, profiles] = await Promise.all([
      cardIndex(),
      worldBooks.catalog().then(catalog => catalog.standalone).catch(() => []),
      presetLibrary.catalog().then(catalog => catalog.presets).catch(() => []),
      userPreferenceProfile.read().then(library => library.profiles || []).catch(() => [])
    ])
    const regex = await regexManager.read('').catch(() => ({ global: [] }))
    const pluginFolders = plugins ? new Set((await plugins.list().catch(() => [])).map(row => str(row.key).toLowerCase())) : new Set()
    const settings = readTavernSettings()
    const materialNames = new Set()
    if (materials) for (const row of await materials.list().catch(() => [])) materialNames.add(str(row.title).toLowerCase())
    const fontIds = new Set()
    if (fonts) for (const row of await fonts.list().catch(() => [])) fontIds.add(str(row.key).toLowerCase())
    return {
      cardNames: new Set([...cards.names].map(value => value.toLowerCase())),
      cardStems: new Set([...cards.stems].map(value => value.toLowerCase())),
      worldNames: new Set(worlds.map(row => str(row.name || stemOf(row.path)).toLowerCase())),
      worldStems: new Set(worlds.map(row => stemOf(row.path).toLowerCase())),
      presetNames: new Set(presets.map(row => str(row.title || stemOf(row.path)).toLowerCase())),
      presetStems: new Set(presets.map(row => stemOf(row.path).toLowerCase())),
      promptNames: new Set((((settings.promptSets || {}).sets) || []).map(row => str(row.name).toLowerCase())),
      profileNames: new Set(profiles.map(row => str(row.name).toLowerCase())),
      regexIds: new Set((regex.global || []).map(row => str(row.id))),
      pluginFolders,
      materialNames,
      fontIds
    }
  }

  function itemConflict(index, kind, item) {
    const title = str(item.title).toLowerCase()
    const stem = stemOf(item.entry).toLowerCase()
    if (kind === 'cards') return index.cardNames.has(title) || index.cardStems.has(stem) ? '本机已有同名人物卡，会加「导入」副本' : ''
    if (kind === 'worldbooks') return index.worldNames.has(title) || index.worldStems.has(stem) ? '本机已有同名世界书，会加「导入」副本' : ''
    if (kind === 'presets') return index.presetNames.has(title) || index.presetStems.has(stem) ? '本机已有同名预设，会加「导入」副本' : ''
    if (kind === 'prompts') return index.promptNames.has(title) ? '本机已有同名方案，会加新方案' : ''
    if (kind === 'profile') return index.profileNames.has(title) ? '本机已有同名长期偏好，会加新的一份' : ''
    if (kind === 'regex') return index.regexIds.has(str(item.key)) ? '同编号的正则已存在，会换新编号' : ''
    if (kind === 'chats') return ''
    if (kind === 'plugins') return index.pluginFolders.has(stemOf(item.entry).toLowerCase()) ? '同文件夹的插件已存在，会加序号' : ''
    if (kind === 'scripts') return index.materialNames.has(title) ? '同名素材已存在，会加序号' : ''
    if (kind === 'fonts') return index.fontIds.has(str(item.key).toLowerCase()) ? '同 id 的字体已存在，会加序号' : ''
    if (kind === 'settings') return '按白名单字段合并；写入前备份当前设置'
    return ''
  }

  async function preview(manifest) {
    const index = await existingIndex()
    const parts = manifest.parts.map(function (part) {
      if (!IMPORTABLE.includes(part.kind)) {
        return { kind: part.kind, label: part.label, importable: false, conflicts: 0,
          note: '下一版支持，这次不会导入', items: part.items.map(function (item) {
            return { key: item.key, title: item.title, bytes: item.bytes, conflict: false, reason: '' }
          }) }
      }
      const items = part.items.map(function (item) {
        return { key: item.key, title: item.title, bytes: item.bytes, conflict: itemConflict(index, part.kind, item) !== '',
          reason: itemConflict(index, part.kind, item) }
      })
      return { kind: part.kind, label: part.label, importable: true,
        conflicts: items.filter(function (item) { return item.conflict }).length,
        overwriteAllowed: part.kind === SETTINGS_PART, items }
    })
    return {
      parts,
      canApply: parts.some(function (part) { return part.importable && part.items.length }),
      totals: { items: parts.reduce(function (sum, part) { return sum + part.items.length }, 0),
        conflicts: parts.reduce(function (sum, part) { return sum + part.conflicts }, 0) }
    }
  }

  async function apply({ manifest, files, policies = {} }) {
    const index = await existingIndex()
    const used = {
      cardStems: new Set(index.cardStems), worldStems: new Set(index.worldStems), presetStems: new Set(index.presetStems),
      promptNames: new Set(index.promptNames), profileNames: new Set(index.profileNames),
      pluginFolders: new Set(index.pluginFolders), materialNames: new Set(index.materialNames), fontIds: new Set(index.fontIds)
    }
    const results = []
    let backupPath = ''

    for (const part of manifest.parts) {
      const result = { kind: part.kind, label: part.label, added: 0, skipped: 0, overwritten: 0, failed: [] }
      results.push(result)
      if (!IMPORTABLE.includes(part.kind)) { result.skipped = part.items.length; result.note = '下一版支持'; continue }
      const policy = policies[part.kind] === 'skip' ? 'skip' : 'apply'
      if (policy === 'skip') { result.skipped = part.items.length; continue }

      for (const item of part.items) {
        const content = files.get(item.entry)
        if (content === undefined) { result.failed.push({ title: item.title, error: '包内缺少该文件' }); continue }
        const text = content.toString('utf8')
        try {
          if (part.kind === 'cards') {
            let document
            try { document = JSON.parse(text) } catch { throw new Error('人物卡不是有效的 JSON') }
            const base = stemOf(item.entry)
            const target = uniqueName(used.cardStems, base)
            await importCard({ name: target + '.json', text })
            used.cardStems.add(target.toLowerCase())
            result.added += 1
            continue
          }
          if (part.kind === 'worldbooks') {
            const base = stemOf(item.entry)
            const target = uniqueName(used.worldStems, base)
            await worldBooks.import({ name: target + '.json', text })
            used.worldStems.add(target.toLowerCase())
            result.added += 1
            continue
          }
          if (part.kind === 'presets') {
            const base = stemOf(item.entry)
            const target = uniqueName(used.presetStems, base)
            await importPreset({ name: target + '.json', text })
            used.presetStems.add(target.toLowerCase())
            result.added += 1
            continue
          }
          if (part.kind === 'prompts') {
            let document
            try { document = JSON.parse(text) } catch { throw new Error('提示词文件不是有效的 JSON') }
            const patch = promptDocuments.import(document, item.title)
            const name = uniqueName(used.promptNames, patch.name || item.title)
            patch.name = name
            await updateTavernSettings({ promptSet: patch })
            used.promptNames.add(name.toLowerCase())
            result.added += 1
            continue
          }
          if (part.kind === 'profile') {
            let document
            try { document = JSON.parse(text) } catch { throw new Error('长期偏好文件不是有效的 JSON') }
            const list = Array.isArray(document && document.profiles) ? document.profiles : []
            if (!list.length) throw new Error('包里没有可导入的长期偏好')
            for (const row of list) {
              const name = uniqueName(used.profileNames, str(row.name) || '导入的长期偏好')
              const content = str(row.injectionText).trim()
              if (!content) { result.failed.push({ title: name, error: '正文为空' }); continue }
              await userPreferenceProfile.manage({ action: 'create', name, content, summary: str(row.summary) })
              used.profileNames.add(name.toLowerCase())
              result.added += 1
            }
            continue
          }
          if (part.kind === 'regex') {
            let scripts
            try { scripts = JSON.parse(text) } catch { throw new Error('正则文件不是有效的 JSON') }
            if (!Array.isArray(scripts) || !scripts.length) throw new Error('包里没有正则')
            const imported = await regexManager.importGlobal({ text: JSON.stringify(scripts), fileName: item.title })
            result.added += Number(imported.imported) || 0
            continue
          }
          if (part.kind === 'fonts') {
            if (!fonts) throw new Error('字体导入不可用')
            const imported = await fonts.importOne({ key: item.key, content })
            used.fontIds.add(str(imported.id).toLowerCase())
            result.added += 1
            continue
          }
          if (part.kind === 'scripts') {
            if (!materials) throw new Error('剧本与素材导入不可用')
            await materials.importOne({ title: item.title, content })
            result.added += 1
            continue
          }
          if (part.kind === 'chats') {
            if (!chats) throw new Error('对话导入不可用')
            const imported = await chats.importOne({ title: item.title, content })
            result.added += 1
            result.chatIds = (result.chatIds || []).concat(imported.chatId ? [imported.chatId] : [])
            continue
          }
          if (part.kind === 'plugins') {
            if (!plugins) throw new Error('插件导入不可用')
            const imported = await plugins.importOne({ key: item.key, title: item.title, content })
            used.pluginFolders.add(str(imported.folder).toLowerCase())
            result.added += 1
            continue
          }
          if (part.kind === 'settings') {
            let value
            try { value = JSON.parse(text) } catch { throw new Error('设置文件不是有效的 JSON') }
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置文件内容无效')
            if (!backupPath) {
              const saved = await backup('tavern-settings.json', JSON.stringify(readTavernSettings(), null, 2) + '\n')
              backupPath = str(backup && saved)
            }
            try { await updateTavernSettings(value) }
            catch (error) {
              // One unknown key must not discard the rest: retry field by field.
              const failedFields = []
              for (const key of Object.keys(value)) {
                try { await updateTavernSettings({ [key]: value[key] }) } catch (fieldError) { failedFields.push(key + '：' + errorText(fieldError)) }
              }
              if (failedFields.length) result.failed.push({ title: '部分设置', error: failedFields.join('；') })
            }
            result.overwritten += 1
            continue
          }
          result.skipped += 1
        } catch (error) {
          result.failed.push({ title: item.title, error: errorText(error) })
        }
      }
    }

    return { results, backupPath }
  }

  return Object.freeze({ preview, apply })
}
