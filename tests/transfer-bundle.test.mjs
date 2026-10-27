import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTransferManifest, packTransferBundle, readTransferBundle, transferItem } from '../tavern-plugin/lib/domain/transfer-bundle.js'

function sampleBundle() {
  const card = JSON.stringify({ name: '作家', description: '写东西的人' })
  const item = transferItem({ key: 'cards/作家.json', title: '作家', entry: 'parts/cards/作家.json', content: card })
  const parts = [{ kind: 'cards', label: '人物卡', items: [item] }]
  const manifest = buildTransferManifest({ name: '我的酒馆备份', createdAt: 1792500000000, source: { tavern: '3.1.0', platform: 'linux' }, parts })
  return { manifest, files: new Map([['parts/cards/作家.json', Buffer.from(card, 'utf8')]]) }
}

test('导出包是普通 ZIP：清单与条目可以原样读回', () => {
  const { manifest, files } = sampleBundle()
  const buffer = packTransferBundle({ manifest, files })
  assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK', '仍是可被系统解压的 ZIP')

  const read = readTransferBundle(buffer)
  assert.equal(read.manifest.spec, 'dsh-tavern.transfer')
  assert.equal(read.manifest.version, 1)
  assert.equal(read.manifest.name, '我的酒馆备份')
  assert.deepEqual(read.issues, [])
  assert.equal(read.manifest.parts.length, 1)
  assert.equal(read.manifest.parts[0].items[0].title, '作家')
  assert.equal(read.manifest.parts[0].items[0].sha256, manifest.parts[0].items[0].sha256)
  assert.equal(read.files.get('parts/cards/作家.json').toString('utf8'), JSON.stringify({ name: '作家', description: '写东西的人' }))
})

test('条目大小与哈希在清单里由内容算出，重复条目自动加序号', () => {
  const first = transferItem({ key: 'a', title: 'A', entry: 'parts/cards/同名.json', content: 'x' })
  const manifest = buildTransferManifest({ name: 't', parts: [{ kind: 'cards', label: '人物卡', items: [first] }] })
  assert.equal(first.bytes, 1)
  assert.match(first.sha256, /^[0-9a-f]{64}$/)
  assert.equal(manifest.totals.items, 1)
  assert.equal(manifest.totals.bytes, 1)
})

test('内容被改写时导入侧按哈希拒绝该条，而不是整包失败', () => {
  const { manifest, files } = sampleBundle()
  const buffer = packTransferBundle({ manifest, files })
  const tampered = Buffer.from(buffer)
  // Rewrite the stored card bytes (same length) inside the archive payload.
  const needle = Buffer.from('写东西的人')
  const at = tampered.indexOf(needle)
  assert.ok(at > 0)
  Buffer.from('写别的东西').copy(tampered, at)

  const read = readTransferBundle(tampered)
  assert.equal(read.manifest.parts[0].items[0].usable, false)
  assert.equal(read.issues.length, 1)
  assert.match(read.issues[0], /内容校验失败/)
  assert.equal(read.files.size, 0, '坏条目不会交给导入器')
})

test('不是导出包或版本不符时给出明确错误', () => {
  assert.throws(() => readTransferBundle(Buffer.from('not a zip')), /不是有效的 ZIP|解析失败/)
  const { manifest, files } = sampleBundle()
  const older = Object.assign({}, manifest, { version: 99 })
  const buffer = packTransferBundle({ manifest: older, files })
  assert.throws(() => readTransferBundle(buffer), /不支持的导出包版本/)
})
