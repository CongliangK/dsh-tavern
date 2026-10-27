// 轮次导航的客户端重画（modules/turn-rail.js）：收起宿主那列，按 railTurns 另画等距刻度。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../tavern-plugin/src/client/modules/turn-rail.js', import.meta.url), 'utf8')

// 宿主结构：会话滚动区 → nav（宿主那列）→ 每个轮次一个带 aria-label 的刻度按钮。
function rail(turns, options = {}) {
  const marks = turns.map(turn => `<button class="_9dNBWq_mark" aria-label="跳转到第 ${turn} 轮">${turn}</button>`).join('')
  const dom = new JSDOM(`<body><div data-conversation-scroll><div class="_9dNBWq_marks"><nav aria-label="轮次导航">${marks}</nav></div></div></body>`, { pretendToBeVisual: true })
  const scope = dom.window.document.querySelector('[data-conversation-scroll]')
  const box = { left: 20, right: options.narrow ? 700 : 1200, top: 40, bottom: 640, width: options.narrow ? 680 : 1180, height: 600 }
  scope.getBoundingClientRect = () => box
  const clicked = []
  for (const mark of scope.querySelectorAll('._9dNBWq_mark')) mark.addEventListener('click', () => clicked.push(Number(mark.textContent)))
  const context = vm.createContext({ window: dom.window, document: dom.window.document })
  vm.runInContext(source, context)
  return { dom, document: dom.window.document, scope, clicked, create: context.createTurnRailFilter }
}

const hostHidden = document => document.querySelector('nav[data-dsh-tavern-rail-hidden]') !== null
const tickTurns = document => [...document.querySelectorAll('.dsh-tavern-turn-rail [data-turn]')].map(node => Number(node.getAttribute('data-turn')))

test('收起宿主那列，按 railTurns 另画等距刻度', t => {
  const { dom, document, create } = rail([1, 2, 3, 4])
  t.after(() => dom.window.close())
  const railFilter = create(document.querySelector('[data-conversation-scroll]'))
  railFilter.apply([1, 3])
  assert.ok(hostHidden(document), '宿主那列（含重试的空轮）不再显示')
  assert.deepEqual(tickTurns(document), [1, 3])
  assert.equal(document.querySelectorAll('.dsh-tavern-turn-rail').length, 1, '只画一列')
  railFilter.apply([1, 2, 3, 4])
  assert.deepEqual(tickTurns(document), [1, 2, 3, 4], '视图说都还有内容就全部列出')
  railFilter.dispose()
  assert.equal(hostHidden(document), false, '卸载后宿主那列回来')
  assert.equal(document.querySelector('.dsh-tavern-turn-rail'), null)
})

test('点我们的刻度走宿主原来的按钮，当前轮镜像宿主的 aria-current', t => {
  const { dom, document, create, clicked } = rail([1, 2, 3])
  t.after(() => dom.window.close())
  const railFilter = create(document.querySelector('[data-conversation-scroll]'))
  railFilter.apply([2, 3])
  const active = document.querySelector('._9dNBWq_mark[aria-label="跳转到第 3 轮"]')
  active.setAttribute('aria-current', 'true')
  railFilter.sync()
  assert.deepEqual([...document.querySelectorAll('.dsh-tavern-turn-rail [data-active]')].map(node => node.getAttribute('data-turn')), ['3'])
  document.querySelector('.dsh-tavern-turn-rail [data-turn="2"]').click()
  assert.deepEqual(clicked, [2], '委托给宿主刻度，加载历史与跳转逻辑不变')
  railFilter.dispose()
})

test('视图没有 railTurns（旧服务端）时列出宿主全部轮次，不凭空藏', t => {
  const { dom, document, create } = rail([1, 2])
  t.after(() => dom.window.close())
  const railFilter = create(document.querySelector('[data-conversation-scroll]'))
  railFilter.apply(null)
  assert.deepEqual(tickTurns(document), [1, 2], '旧服务端没有这一栏：照列，不筛')
  railFilter.apply([])
  assert.deepEqual(tickTurns(document), [1, 2], '空表也当还没拿到（会话刚打开），不凭空藏')
  railFilter.dispose()
})

test('窄容器里跟宿主一样不出刻度', t => {
  const { dom, document, create } = rail([1, 2], { narrow: true })
  t.after(() => dom.window.close())
  const railFilter = create(document.querySelector('[data-conversation-scroll]'))
  railFilter.apply([1, 2])
  const nav = document.querySelector('.dsh-tavern-turn-rail')
  assert.equal(nav.hidden, true)
  railFilter.dispose()
})

test('宿主重渲染后补上的刻度在下一帧进同一列', async t => {
  const { dom, document, create } = rail([1])
  t.after(() => dom.window.close())
  const railFilter = create(document.querySelector('[data-conversation-scroll]'))
  railFilter.apply([1, 2])
  assert.deepEqual(tickTurns(document), [1], '宿主还没有第 2 轮的刻度')
  const extra = document.createElement('button')
  extra.className = '_9dNBWq_mark'
  extra.setAttribute('aria-label', '跳转到第 2 轮')
  extra.textContent = '2'
  document.querySelector('nav').appendChild(extra)
  await new Promise(resolve => dom.window.requestAnimationFrame(() => resolve(null)))
  await new Promise(resolve => dom.window.requestAnimationFrame(() => resolve(null)))
  assert.deepEqual(tickTurns(document), [1, 2])
  assert.ok(hostHidden(document), '重新渲染出来的宿主列仍然收起')
  railFilter.dispose()
})
