import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { renderSite, markdown, escapeHTML } from '../docs/manual/build.mjs'

import { screenshots, pageScreenshots, screenshotSource } from '../docs/manual/screenshots.mjs'
import { demoDownloads } from '../examples/manual-demo/downloads.mjs'

const root = new URL('../docs/', import.meta.url)
const inventory = await readFile(new URL('feature-inventory.md', root), 'utf8')
const html = await readFile(new URL('index.html', root), 'utf8')
const sandbox = {}
vm.runInNewContext(await readFile(new URL('assets/manual-state.js', root), 'utf8'), sandbox)
const { resolveRoute, searchPages } = sandbox.DshManualState
const pages = [...html.matchAll(/<article class="doc-page" id="([^"]+)" data-group="([^"]+)" data-title="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(([, id, group, title, body]) => ({ id, group, title, text: body.replace(/<[^>]+>/g, ' '), body }))

test('生成结果与文字源一致，避免修改源后忘记重新生成', () => {
  assert.equal(html, renderSite(inventory))
})

test('代码块保持命令原文，转义 HTML 且不误识别管道和 Markdown', () => {
  const command = "echo '<script>**raw**</script>' | next --arg='a&b'\n# heading"
  const rendered = markdown('```bash\n' + command + '\n```', 'test')
  assert.ok(rendered.includes(`<code>${escapeHTML(command)}</code>`))
  assert.doesNotMatch(rendered, /<script>|<strong>|<table>|<h2/)
})

test('截图有有效本地资源、替代文字、说明、来源与放大入口', async () => {
  const expected = Object.values(pageScreenshots).flat().length
  assert.equal((html.match(/<figure class="manual-screenshot">/g) || []).length, expected)
  assert.equal((html.match(/<img /g) || []).length, expected)
  for (const [id, keys] of Object.entries(pageScreenshots)) {
    const body = pages.find(p => p.id === id)?.body
    assert.ok(body, id)
    if (!keys.length) continue
    const source = screenshots[keys[0]].source || screenshotSource
    assert.ok(body.includes(source.label))
    assert.ok(body.includes(source.runtime))
    for (const key of keys) {
      const shot = screenshots[key]
      assert.ok(shot?.alt && shot?.caption, key)
      const src = `images/manual/${shot.file}`
      assert.ok(body.includes(`href="${src}" target="_blank" rel="noopener noreferrer"`))
      assert.ok(body.includes(`src="${src}" alt="${escapeHTML(shot.alt)}" width="${shot.width || 1309}" height="${shot.height || 707}" loading="lazy"`))
      const bytes = await readFile(new URL(src, root))
      assert.ok(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), `${src} must be JPEG or PNG`)
      assert.ok(bytes.length > 1000)
    }
  }
  const provenance = await readFile(new URL('../examples/manual-demo/README.md', import.meta.url), 'utf8')
  assert.match(provenance, /CC0/)
  assert.match(provenance, /独立 DSH Profile/)
})

test('网页公开样例下载与原创源数据一致，人物卡没有远程脚本依赖', async () => {
  for (const [name, source] of Object.entries(demoDownloads)) {
    assert.equal(await readFile(new URL(`examples/manual-demo/${name}`, root), 'utf8'), source)
  }
  const card = JSON.parse(demoDownloads['lighthouse-card.json'])
  assert.equal(card.spec, 'chara_card_v3')
  assert.deepEqual(card.data.extensions.tavern_helper.scripts, [])
  assert.doesNotMatch(demoDownloads['lighthouse-card.json'], /https?:\/\/|\/Users\//)
  assert.match(demoDownloads['README.txt'], /CC0/)
})

test('Markdown 转换转义原始 HTML，只允许安全链接，生成语义表格', () => {
  const result = markdown('## 标题\n\n<script>alert(1)</script>\n\n[不安全](javascript:alert)\n\n[文档](#play)\n\n| 名称 | 说明 |\n| --- | --- |\n| 内容 | 正文 |', 'test')
  assert.doesNotMatch(result, /<script>|href="javascript:/)
  assert.match(result, /&lt;script&gt;/)
  assert.match(result, /href="#play"/)
  assert.match(result, /<th scope="col">名称/)
})

test('新增 Markdown 自动进入对应目录、正文和搜索，链接转为页面地址', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const root = await mkdtemp(path.join(tmpdir(), 'manual-markdown-'))
  try {
    await mkdir(path.join(root, 'play'))
    await writeFile(path.join(root, 'play/first-game.md'), '# 我的第一局\n\n## 开始\n\n独特的教程搜索词。\n\n[帮助](../tips.md)')
    await writeFile(path.join(root, 'tips.md'), '# 使用提示\n\n这里是帮助。\n\n`[示例](missing.md)`')
    const output = renderSite(inventory, root)
    assert.match(output, /href="#first-game"[^>]*>我的第一局<\/a>/)
    assert.match(output, /id="first-game" data-group="play" data-title="我的第一局"/)
    assert.match(output, /href="#tips">帮助<\/a>/)
    assert.match(output, /sidebar-bottom[^]*href="#tips">使用提示/)
    const entries = [...output.matchAll(/<article class="doc-page" id="([^"]+)" data-group="([^"]+)" data-title="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(([, id, group, title, body]) => ({ id, group, title, text: body.replace(/<[^>]+>/g, ' ') }))
    assert.ok(searchPages(entries, '独特的教程搜索词').some(p => p.id === 'first-game'))
    await writeFile(path.join(root, 'a01.md'), '# 冲突\n')
    assert.throws(() => renderSite(inventory, root), /Duplicate documentation page id: a01/)
    await rm(path.join(root, 'a01.md'))
    await writeFile(path.join(root, 'tips.md'), '缺少标题')
    assert.throws(() => renderSite(inventory, root), /must start with # Title/)
    await writeFile(path.join(root, 'tips.md'), '# 帮助\n\n[不存在](missing.md)')
    assert.throws(() => renderSite(inventory, root), /Unknown Markdown page link/)
    await writeFile(path.join(root, 'tips.md'), '# 帮助\n')
    await mkdir(path.join(root, 'unknown'))
    assert.throws(() => renderSite(inventory, root), /Unknown documentation group/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
