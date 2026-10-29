import { activateWorldBook, promptOrder } from './worldbook-activation.js'
import { isStaticWorldbookSkillEntry } from './worldbook-entry-classification.js'
import { worldbookEntryTitle } from './worldbook-entry-title.js'

/** Advisory only: reuse keyword/history/secondary-key matching without recording
 * reads or restricting the searchable file set. Body token budgets do not apply
 * to titles. Runtime preprocessing has already established visibility. */
export function worldbookTitleHints(input) {
  const entries = (input.worldBook?.view?.entries || []).filter(isStaticWorldbookSkillEntry)
  const matched = activateWorldBook({ ...input, entries, isCoolingDown: () => false, ignoreBudget: true })
  const titles = [...new Set(promptOrder(matched.entries).map(worldbookEntryTitle))]
  if (!titles.length) return ''
  const shown = titles.slice(0, 12).map(title => title.slice(0, 80))
  return '【可能相关的世界书条目】\n' + shown.join('；') + (titles.length > shown.length ? `（另有 ${titles.length - shown.length} 个匹配条目未列出）` : '') +
    '\n以上仅为关键词匹配的查阅提醒，不是已读取的设定，也不是搜索范围限制。按需用 worldbook_grep 搜索、read 读取；可继续搜索其他条目。'
}
