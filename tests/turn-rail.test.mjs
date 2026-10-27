// 轮次导航的客户端筛选（modules/turn-rail.js）：按 railTurns 把正文里已经没有的轮次刻度藏起来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../tavern-plugin/src/client/modules/turn-rail.js', import.meta.url), 'utf8')

function rail(turns) {
  const marks = turns.map(turn => `<button class="_9dNBWq_mark" aria-label="跳转到第 ${turn} 轮"></button>`).join('')
  const dom = new JSDOM(`<div data-conversation-scroll><div class="_9dNBWq_marks">${marks}</div></div>`, { pretendToBeVisual: true })
  const context = vm.createContext({ window: dom.window, document: dom.window.document })
  vm.runInContext(source, context)
  return { dom, document: dom.window.document, create: context.createTurnRailFilter }
}

const hiddenTurns = document => [...document.querySelectorAll('[data-dsh-tavern-rail-hidden]')]
  .map(mark => Number((mark.getAttribute('aria-label').match(/第 (\d+) 轮/) || [])[1]))

test('只留下 railTurns 里的刻度，其余打上隐藏标记', t => {
  const { dom, document, create } = rail([1, 2, 3, 4])
  t.after(() => dom.window.close())
  const filter = create(document.querySelector('[data-conversation-scroll]'), { window: dom.window })
  filter.apply([1, 3])
  assert.deepEqual(hiddenTurns(document), [2, 4], '重试把这两轮撑进了刻度，正文里已经没有它们')
  filter.apply([1, 3])
  assert.deepEqual(hiddenTurns(document), [2, 4], '同样的轮次不重复写属性')
  filter.apply([1, 2, 3, 4])
  assert.deepEqual(hiddenTurns(document), [], '视图说都还有内容就全部显示')
  filter.dispose()
  assert.deepEqual(hiddenTurns(document), [], '卸载后不留痕迹')
})

test('视图没有 railTurns（旧服务端）时不筛，宁可多几根也不藏', t => {
  const { dom, document, create } = rail([1, 2])
  t.after(() => dom.window.close())
  const filter = create(document.querySelector('[data-conversation-scroll]'), { window: dom.window })
  filter.apply(null)
  assert.deepEqual(hiddenTurns(document), [])
  filter.apply(undefined)
  assert.deepEqual(hiddenTurns(document), [])
  filter.apply([])
  assert.deepEqual(hiddenTurns(document), [1, 2], '表面真的空了才全藏')
  filter.dispose()
})

test('新画出来的刻度在下一帧被同一个筛选收掉', async t => {
  const { dom, document, create } = rail([1, 2])
  t.after(() => dom.window.close())
  const filter = create(document.querySelector('[data-conversation-scroll]'), { window: dom.window })
  filter.apply([1])
  const extra = document.createElement('button')
  extra.className = '_9dNBWq_mark'
  extra.setAttribute('aria-label', '跳转到第 3 轮')
  document.querySelector('._9dNBWq_marks').append(extra)
  await new Promise(resolve => dom.window.requestAnimationFrame(() => resolve(null)))
  assert.deepEqual(hiddenTurns(document), [2, 3], '重渲染补上的刻度也要藏')
  filter.dispose()
  assert.deepEqual(hiddenTurns(document), [])
})
