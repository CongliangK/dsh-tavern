import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildTransferManifest, packTransferBundle, readTransferBundle, safeTransferFileName, TRANSFER_EXTENSION } from '../domain/transfer-bundle.js'
import { createTransferCatalog } from '../domain/transfer-catalog.js'
import { createTransferChats } from '../domain/transfer-chats.js'
import { createTransferFonts } from '../domain/transfer-fonts.js'
import { createTransferImport } from '../domain/transfer-import.js'
import { createTransferMaterials } from '../domain/transfer-materials.js'
import { createTransferPlugins } from '../domain/transfer-plugins.js'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

// A package waiting to be applied lives in memory for a quarter of an hour; a reload asks again.
const TOKEN_TTL_MS = 15 * 60 * 1000
// P0 bundles carry text only; anything far larger is probably not one of ours.
const MAX_IMPORT_BYTES = 128 * 1024 * 1024

function stamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
    pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
}

/** Export / import of `.dshtransfer` bundles (docs/design/data-transfer.md). */
export function createTransferHandlers(deps) {
  const { dataRoot, uploads, fileResources, worldBooks, presetLibrary, promptDocuments, userPreferenceProfile,
    regexManager, readTavernSettings, updateTavernSettings, importCard, importPreset, readCardWorkspace,
    cardPreparation, TAVERN_PACKAGE_VERSION, listTavernSessions, readChat, exportGameSave, importGameSave,
    userPluginInstaller } = deps

  async function writeBackup(name, text) {
    const directory = path.join(dataRoot, '..', 'backups', 'transfer', stamp())
    await mkdir(directory, { recursive: true })
    const target = path.join(directory, safeTransferFileName(name, 'backup.json'))
    await writeFile(target, text)
    return path.relative(path.join(dataRoot, '..'), target).split(path.sep).join('/')
  }

  const chats = createTransferChats({ listSessions: listTavernSessions, readChat, exportSave: exportGameSave, importSave: importGameSave })
  const plugins = createTransferPlugins({ pluginsDir: userPluginInstaller.pluginsDir, listPlugins: () => userPluginInstaller.list() })
  const materials = createTransferMaterials({ fileResources })
  const fonts = createTransferFonts({ fontsDir: path.join(dataRoot, 'fonts') })

  const catalog = createTransferCatalog({
    fileResources,
    cardPreparation,
    readCardWorkspace,
    worldBooks,
    presetLibrary,
    promptDocuments,
    userPreferenceProfile,
    regexManager,
    readTavernSettings,
    tavernVersion: TAVERN_PACKAGE_VERSION,
    fileSize: async relative => (await stat(fileResources.absolute(relative))).size,
    chats,
    plugins,
    materials,
    fonts
  })

  const importer = createTransferImport({
    fileResources, worldBooks, presetLibrary, promptDocuments, userPreferenceProfile, regexManager,
    readTavernSettings, updateTavernSettings, importCard, importPreset, backup: writeBackup, chats, plugins, materials, fonts
  })

  const tokens = new Map()
  function sweepTokens(now = Date.now()) {
    for (const [token, entry] of tokens) if (now - entry.at > TOKEN_TTL_MS) tokens.delete(token)
  }

  return {
    async getTransferCatalog() {
      return await catalog.listParts()
    },

    async createTransferExport(args) {
      const selection = args && typeof args.selection === 'object' && args.selection !== null ? args.selection : {}
      const collected = await catalog.collect(selection, { images: args && args.includeImages !== false })
      if (!collected.parts.length) throw new Error('请至少选择一个板块')
      const name = safeTransferFileName(str(args && args.name) || 'DSH酒馆备份-' + stamp(), 'DSH酒馆备份')
      const manifest = buildTransferManifest({
        name,
        source: { tavern: str(TAVERN_PACKAGE_VERSION), platform: process.platform },
        parts: collected.parts
      })
      const buffer = packTransferBundle({ manifest, files: collected.files })
      return {
        filename: manifest.name + TRANSFER_EXTENSION,
        name: manifest.name,
        base64: buffer.toString('base64'),
        bytes: buffer.length,
        totals: manifest.totals,
        parts: manifest.parts.map(function (part) {
          return { kind: part.kind, label: part.label, items: part.items.length, bytes: part.bytes }
        })
      }
    },

    async previewTransferBundle(args) {
      sweepTokens()
      const upload = await uploads.take(str(args && args.uploadId))
      try {
        const buffer = await readFile(upload.file)
        if (buffer.length > MAX_IMPORT_BYTES) throw new Error('导出包超过 ' + Math.round(MAX_IMPORT_BYTES / 1048576) + ' MB，暂不支持这么大的包')
        const bundle = readTransferBundle(buffer)
        const preview = await importer.preview(bundle.manifest)
        const token = randomUUID()
        tokens.set(token, { at: Date.now(), manifest: bundle.manifest, files: bundle.files })
        return {
          token,
          bundle: {
            name: bundle.manifest.name,
            createdAt: bundle.manifest.createdAt,
            source: bundle.manifest.source,
            bytes: buffer.length,
            totals: preview.totals,
            parts: preview.parts,
            canApply: preview.canApply,
            issues: bundle.issues
          }
        }
      } finally {
        await upload.remove()
      }
    },

    async applyTransferBundle(args) {
      sweepTokens()
      const token = str(args && args.token)
      const entry = tokens.get(token)
      if (!entry) throw new Error('导入会话已过期，请重新选择导出包')
      const policies = args && args.policies && typeof args.policies === 'object' && !Array.isArray(args.policies) ? args.policies : {}
      const result = await importer.apply({ manifest: entry.manifest, files: entry.files, policies })
      tokens.delete(token)
      return result
    }
  }
}
