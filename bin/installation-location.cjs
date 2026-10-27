// Dependency-free: embedded in standalone installers before downloaded code exists.
// A relocated installation keeps logical aliases for old shortcuts and profile links.
// Installers MUST write the physical app directory, never replace those aliases.
const fs = require('node:fs')
const path = require('node:path')
const fail = message => { throw Object.assign(new Error(`酒馆安装目录记录不安全，未修改安装：${message}`), { code: 'INSTALLATION_LOCATION_UNSAFE' }) }
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const inside = (child, root) => { const relative = path.relative(process.platform === 'win32' ? root.toLowerCase() : root, process.platform === 'win32' ? child.toLowerCase() : child); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const overlaps = (left, right) => same(left, right) || inside(left, right) || inside(right, left)
function ordinaryAncestors(directory) {
  let current = path.resolve(directory)
  for (;;) {
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`目录祖先不能是链接或文件：${current}`)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error.code === 'INSTALLATION_LOCATION_UNSAFE') throw error
        fail(`无法验证目录祖先：${current}`)
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/u.test(value) || !same(path.resolve(value), value)) fail('路径不是规范的绝对路径')
  return value
}
function resolveInstallationApp({ dshHome, appDir } = {}) {
  const home = path.resolve(dshHome)
  ordinaryAncestors(path.join(home, 'profile-bridge'))
  const requested = appDir ? path.resolve(appDir) : path.join(home, 'apps', 'dsh-tavern')
  const journal = path.join(home, 'profile-bridge', 'installation-operation.json')
  try {
    if (fs.lstatSync(journal).isSymbolicLink()) fail('安装管理事务记录不能是链接')
    const operation = JSON.parse(fs.readFileSync(journal, 'utf8'))
    if (operation?.schemaVersion !== 1 || !['completed', 'rolled-back'].includes(operation.phase)) fail('上次安装管理尚未安全结束，请先恢复事务与备份')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (error.code === 'INSTALLATION_LOCATION_UNSAFE') throw error
      fail(`无法读取安装管理事务记录：${journal}`)
    }
  }
  const filename = path.join(home, 'profile-bridge', 'installation.json')
  let record
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) fail('安装记录不能是链接')
    record = JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return requested
    if (error.code === 'INSTALLATION_LOCATION_UNSAFE') throw error
    fail(`无法读取 ${filename}`)
  }
  if (record?.schemaVersion !== 1 || record.phase !== 'completed' || !Array.isArray(record.entries)) fail('迁移尚未完成或记录格式不受支持')
  const destination = absolute(record.destination)
  const logicalApp = absolute(record.appDir)
  if (overlaps(destination, home) || overlaps(destination, logicalApp)) fail('迁移目标不能与共享 DSH 或原安装目录重叠')
  ordinaryAncestors(destination)
  const entries = record.entries
  if (entries.length !== 3 || new Set(entries.map(e => e?.kind)).size !== 3 || entries.some(e => !['app', 'profile', 'data'].includes(e?.kind))) fail('迁移目录清单不完整')
  const seen = new Set()
  for (const entry of entries) {
    const from = absolute(entry.from), to = absolute(entry.to)
    if (overlaps(destination, from)) fail('迁移目标不能与原目录重叠')
    ordinaryAncestors(path.dirname(from))
    const expected = entry.kind === 'app' ? logicalApp : entry.kind === 'profile' ? path.join(home, 'profiles', 'tavern') : path.join(home, 'profile-data', 'tavern')
    if (!same(from, expected) || !inside(to, destination) || !same(to, path.join(destination, entry.kind)) || seen.has(to)) fail('迁移目录不匹配')
    seen.add(to)
    try {
      // No aliased destination ancestors: copied trees must remain on the chosen volume.
      if (!same(fs.realpathSync(destination), destination) || !same(fs.realpathSync(to), to) || !fs.lstatSync(to).isDirectory()) fail('迁移目标包含链接或不是目录')
      if (!fs.lstatSync(from).isSymbolicLink() || !same(path.resolve(path.dirname(from), fs.readlinkSync(from)), to) || !same(fs.realpathSync(from), to)) fail('原目录入口已被更改')
    } catch (error) {
      if (error.code === 'INSTALLATION_LOCATION_UNSAFE') throw error
      fail(`目录不可用：${from} → ${to}`)
    }
  }
  const physicalApp = entries.find(entry => entry.kind === 'app').to
  if (appDir && !same(requested, logicalApp) && !same(requested, physicalApp)) fail('指定目录与已迁移的酒馆冲突')
  return physicalApp
}
module.exports = { resolveInstallationApp }
if (require.main === module) {
  try { console.log(resolveInstallationApp({ dshHome: process.argv[2], appDir: process.argv[3] || undefined })) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
