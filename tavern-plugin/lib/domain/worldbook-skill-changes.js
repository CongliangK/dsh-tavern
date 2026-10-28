import { randomUUID } from 'node:crypto'
import { appendSessionEvent, sessionEvents } from './session-events.js'

/** Persist the comparison baseline in native history, outside model-visible text.
 * One batch notice per effective version survives restarts and turn retries. */
export function appendWorldbookSkillChanges(payload, snapshot) {
  if (!snapshot || !payload.agent?.session) return null
  const session = payload.agent.session
  const previous = [...sessionEvents(session)].reverse().find(event => event.type === 'user/message' && event.data?.source?.worldbookSkills)?.data.source.worldbookSkills
  if (previous?.version === snapshot.version) return null
  const old = new Map((previous?.entries || []).map(entry => [entry.ref, entry]))
  const current = new Map(snapshot.entries.map(entry => [entry.ref, entry]))
  const added = snapshot.entries.filter(entry => !old.has(entry.ref))
  const changed = snapshot.entries.filter(entry => old.has(entry.ref) && old.get(entry.ref).hash !== entry.hash)
  const removed = [...old.values()].filter(entry => !current.has(entry.ref))
  const lines = ['【世界书 Skill 资料版本】']
  const describe = (label, entries) => {
    if (!entries.length) return
    lines.push(`${label}（${entries.length} 条）：` + entries.slice(0, 12).map(entry => String(entry.title).replace(/\s+/g, ' ').slice(0, 70)).join('；') + (entries.length > 12 ? '；其余请查当前目录' : ''))
  }
  if (previous) {
    describe('新增', added); describe('改写', changed); describe('移出静态 Skill', removed)
    lines.push('上述改写条目的旧正文已失效；移出项可能已删除、停用或转为动态/常驻，不得继续把历史 Skill 内容当作当前资料。需要这些信息时重新加载当前 Skill；动态和常驻内容以本轮运行时注入为准。')
    if (previous.directory !== snapshot.directory) lines.push('资料目录已切换版本，旧绝对路径不再适用于本局；请从当前 Skill 目录重新定位，勿猜测新路径。')
  } else lines.push('静态资料按需读取；后续资料发生修改时，以新的目录和变更通知为准。')
  const message = { id: `tavern-worldbook-skills:${snapshot.version}:${randomUUID()}`, role: 'user', content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'plugin:dsh-tavern', worldbookSkills: snapshot } }
  appendSessionEvent(session, 'user/message', message, { surfaceOp: 'append' })
  // The host already assembled this step's messages before pre-step hooks.
  if (Array.isArray(payload.messages) && !payload.messages.some(item => item.id === message.id)) payload.messages.push(message)
  return message
}
