import { sessionEvents } from './session-events.js'
import { isProducerSource } from './message-source.js'

/** Compare each latest snapshot with evidence still present on the native surface.
 * No memory-only 'already restored' flag: retry, restart, compaction and rewinds
 * all derive the same answer from the model-visible messages. Metadata alone is
 * insufficient: the snapshot body must still be present, not only a summary.
 */
export function virtualWorldbookRestoreRefs(session, state) {
  if (state?.schemaVersion !== 1 || !state.entries) return []
  const missing = new Set(Object.keys(state.entries).filter(ref => (state.entries[ref]?.contextText ?? state.entries[ref]?.text)))
  const events = new Map(sessionEvents(session).map(event => [event.seq, event]))
  for (const seq of session?.surface?.nodes || []) {
    const event = events.get(seq)
    if (event?.type !== 'user/message') continue
    const message = event.data, source = message?.source, marker = source?.virtualWorldbook
    if (!isProducerSource(source, 'dsh-tavern') || marker?.scope !== state.scope) continue
    const text = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
    for (const ref of missing) {
      const snapshot = state.entries[ref]
      if (marker.entries?.[ref] === snapshot.renderHash && text.includes(snapshot.contextText ?? snapshot.text)) missing.delete(ref)
    }
  }
  return [...missing]
}

/** Request-only sections preserve source whitespace and never enter chat history. */
export function withVirtualWorldbook(sections, context) {
  const fixed = sections.filter(section => section.name !== 'tavern:constant-worldbook')
  return context ? [{ name: 'tavern:constant-worldbook', text: '【常驻世界书】\n' + context }, ...fixed] : fixed
}
