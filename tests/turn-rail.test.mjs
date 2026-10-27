// 轮次导航的客户端重画（modules/turn-rail.js）：收起宿主那列，按「点了能落到正文上」另画等距刻度。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../tavern-plugin/src/client/modules/turn-rail.js', import.meta.url), 'utf8')

// 宿主结构：会话滚动区 → nav（宿主那列）→ 每个轮次一个刻度按钮；正文行带 data-chat-turn。
// rows: [[turn, height]]，height 0 就是被折叠/清空、点了只剩空气的那种。
function rail(turns, options = {}) {
  const unloaded = options.unloaded || []
  const marks = turns.map(turn => `<button class="_9dNBWq_mark${unloaded.includes(turn) ? ' _9dNBWq_markUnloaded' : ''}" aria-label="${unloaded.includes(turn) ? '加载并跳转到' : '跳转到'}第 ${turn} 轮">${turn}</button>`).join('')
  const rows = (options.rows || []).map(([turn]) => `<div data-chat-turn="${turn}" data-row="${turn}"></div>`).join('')
  const dom = new JSDOM(`<body><div data-conversation-scroll><div class="_9dNBWq_marks"><nav aria-label="轮次导航">${marks}</nav></div><div data-chat-flow>${rows}</div></div></body>`, { pretendToBeVisual: true })
  const scope = dom.window.document.querySelector('[data-conversation-scroll]')
  const box = { left: 20, right: options.narrow ? 700 : 1200, top: 40, bottom: 640, width: options.narrow ? 680 : 1180, height: 600 }
  scope.getBoundingClientRect = () => box
  for (const [turn, height] of options.rows || []) measure(scope.querySelector('[data-row="' + turn + '"]'), height)
  const clicked = []
  for (const mark of scope.querySelectorAll('._9dNBWq_mark')) mark.addEventListener('click', () => clicked.push(Number(mark.textContent)))
  const context = vm.createContext({ window: dom.window, document: dom.window.document })
  vm.runInContext(source, context)
  return { dom, document: dom.window.document, scope, clicked, create: context.createTurnRailFilter }
}

// jsdom 没有布局：按给定高度给行装一个矩形。
function measure(row, height) {
  row.getBoundingClientRect = () => ({ height, width: 400, top: 0, bottom: height, left: 0, right: 400 })
}

const hostHidden = document => document.querySelector('nav[data-dsh-tavern-rail-hidden]') !== null
const tickTurns = document => [...document.querySelectorAll('.dsh-tavern-turn-rail [data-turn]')].map(node => Number(node.getAttribute('data-turn')))

test('只给点了能落到正文上的轮次画刻度', t => {
  const { dom, document, scope, create } = rail([1, 2, 3, 4], { rows: [[1, 120], [2, 0], [3, 40], [4, 0]] })
  t.after(() => dom.window.close())
  const filter = create(scope)
  filter.apply()
  assert.ok(hostHidden(document), '宿主那列收起来（含重试的空轮）')
  assert.deepEqual(tickTurns(document), [1, 3], '零高度的尝试轮不再占刻度')
  assert.equal(document.querySelector('.dsh-tavern-turn-rail').getAttribute('aria-label'), '轮次导航')
  assert.equal(document.querySelectorAll('.dsh-tavern-turn-rail').length, 1, '只画一列')
  filter.dispose()
  assert.equal(hostHidden(document), false, '卸载后宿主那列回来')
  assert.equal(document.querySelector('.dsh-tavern-turn-rail'), null)
})

test('还没加载的轮次照列：点了会先拉历史再跳', t => {
  const { dom, document, scope, create } = rail([1, 2, 3], { rows: [[1, 80], [2, 0], [3, 0]], unloaded: [3] })
  t.after(() => dom.window.close())
  const filter = create(scope)
  filter.apply()
  assert.deepEqual(tickTurns(document), [1, 3])
  filter.dispose()
})

test('行在页面里就自己滚到这一轮的开头，当前轮镜像宿主的 aria-current', t => {
  const { dom, document, scope, create, clicked } = rail([1, 2, 3], { rows: [[1, 60], [2, 60], [3, 60]] })
  t.after(() => dom.window.close())
  const filter = create(scope)
  filter.apply()
  const hostMark = document.querySelector('._9dNBWq_mark[aria-label="跳转到第 3 轮"]')
  hostMark.setAttribute('aria-current', 'true')
  filter.sync()
  assert.deepEqual([...document.querySelectorAll('.dsh-tavern-turn-rail [data-active]')].map(node => node.getAttribute('data-turn')), ['3'])
  // 行带绝对位置：第 2 轮的行在 900px 处，滚动应落在它的开头。
  const row = scope.querySelector('[data-row="2"]')
  row.getBoundingClientRect = () => ({ height: 60, width: 400, top: 940, bottom: 1000, left: 0, right: 400 })
  document.querySelector('.dsh-tavern-turn-rail [data-turn="2"]').click()
  assert.equal(scope.scrollTop, 940 - 40 - 8, '对齐到行首（会话区顶部 + 8px 留白）')
  assert.deepEqual(clicked, [], '不用再麻烦宿主，它那套负载轮次根本不动')
  filter.dispose()
})

test('行不在页面里才交给宿主拉历史', t => {
  const { dom, document, scope, create, clicked } = rail([1, 2], { rows: [[1, 60]], unloaded: [2] })
  t.after(() => dom.window.close())
  const filter = create(scope)
  filter.apply()
  document.querySelector('.dsh-tavern-turn-rail [data-turn="2"]').click()
  assert.deepEqual(clicked, [2], '没有行：委托宿主刻度')
  filter.dispose()
})

test('窄容器里跟宿主一样不出刻度', t => {
  const { dom, document, scope, create } = rail([1, 2], { narrow: true, rows: [[1, 60], [2, 60]] })
  t.after(() => dom.window.close())
  const filter = create(scope)
  filter.apply()
  assert.equal(document.querySelector('.dsh-tavern-turn-rail').hidden, true)
  filter.dispose()
})

test('也能按显式轮次表或判定函数收窄', t => {
  const { dom, document, scope, create } = rail([1, 2, 3, 4], { rows: [[1, 60], [2, 60], [3, 60], [4, 60]] })
  t.after(() => dom.window.close())
  const filter = create(scope)
  filter.apply([2, 4])
  assert.deepEqual(tickTurns(document), [2, 4])
  filter.apply(turn => turn !== 3)
  assert.deepEqual(tickTurns(document), [1, 2, 4])
  filter.apply()
  assert.deepEqual(tickTurns(document), [1, 2, 3, 4], '不给参数回到默认规则')
  filter.dispose()
})

test('行的高度晚到或新刻度补上来，合并到下一次同步', async t => {
  const { dom, document, scope, create } = rail([1, 2], { rows: [[1, 60], [2, 0]] })
  t.after(() => dom.window.close())
  const filter = create(scope)
  filter.apply()
  assert.deepEqual(tickTurns(document), [1])
  const row = scope.querySelector('[data-row="2"]')
  filter.sync()
  measure(row, 90)
  row.setAttribute('class', 'is-open')
  await new Promise(resolve => dom.window.setTimeout(resolve, 260))
  assert.deepEqual(tickTurns(document), [1, 2], '展开后第 2 轮补上刻度')
  filter.dispose()
})

test('目录里说不出内容的轮次不出刻度（预览也不会为空）', t => {
  const { dom, document, scope, create } = rail([1, 2, 3, 4], { rows: [[1, 120], [2, 30], [3, 0], [4, 60]], unloaded: [4] })
  t.after(() => dom.window.close())
  const filter = create(scope)
  // 目录说：1、3 有正文；2 只有系统消息；4 是空的尝试轮。
  filter.apply({ text: new Set([1, 3]) })
  assert.deepEqual(tickTurns(document), [1, 3], '第 2 轮有行但目录里没内容；第 4 轮目录是空的；第 3 轮目录有正文，留着可往前翻')
  filter.apply({ text: new Set([1, 2, 3, 4]) })
  assert.deepEqual(tickTurns(document), [1, 2, 3, 4], '目录都说有内容时全列，点不到的行会往前翻历史')
  filter.dispose()
})
