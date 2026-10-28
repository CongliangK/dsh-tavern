import { WORLDBOOK_SKILL_RESOURCE_ROOT } from './worldbook-skill-provider.js'

/** Existing DSH read protocol only. No tool registration, physical file, shell
 * fallback, new search system, or modification of DSH's filesystem backend.
 */
export function nativeWorldbookReadAvailable(tools, scope) {
  const tool = tools?.get('read', scope)
  const schema = tool?.output?.schema
  return Boolean(tool?.parameters?.properties?.file_path && schema?.properties?.path && schema?.properties?.lines && schema?.properties?.totalLines)
}
export function installWorldbookSkillRead(ctx, provider, { virtualOnly = async () => false } = {}) {
  return ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'read') return next()
    const requested = exec.arguments?.file_path
    if (typeof requested !== 'string' || !/^[/\\]*__tavern_worldbook__(?:[/\\]|$)/.test(requested)) {
      if (await virtualOnly(exec.agent)) throw new Error('This game’s read tool is limited to its virtual worldbook resources')
      return next()
    }
    // Reject aliases and traversal rather than letting the filesystem normalize
    // them into another game's namespace. Virtual resources never exist on disk.
    if (!requested.startsWith(WORLDBOOK_SKILL_RESOURCE_ROOT) || !/^\/__tavern_worldbook__\/[a-f0-9]{20}\/[a-z0-9-]+\/(?:SKILL\.md|INDEX\.md|entries\/[a-f0-9]{20}\.md)$/.test(requested)) throw new Error('Invalid virtual worldbook resource path')
    if (!exec.agent?.session?.id || !nativeWorldbookReadAvailable(ctx.tools, exec.agent)) throw new Error('Virtual worldbook resources require the current game’s native read tool')
    exec.signal?.throwIfAborted()
    const offset = exec.arguments.offset ?? 1, limit = exec.arguments.limit ?? 2000
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('read offset/limit must be positive integers; limit cannot exceed 2000')
    const body = await provider.readResource(requested, { scope: exec.agent, signal: exec.signal })
    exec.signal?.throwIfAborted()
    if (body === undefined) throw new Error('Worldbook resource is unknown or no longer available in this game')
    // Match the native reader's default safety ceiling. This is a bounded tool
    // VIEW; provider.readResource still returns the exact unmodified source.
    const all = body ? body.split('\n') : []
    if (body.endsWith('\n')) all.pop()
    if (offset > all.length && !(all.length === 0 && offset === 1)) throw new Error('read offset is out of range')
    const lines = []
    let bytes = 0
    for (let index = offset - 1; index < Math.min(all.length, offset - 1 + limit); index++) {
      const raw = all[index].replace(/\r$/, '')
      const text = raw.length > 2000 ? raw.slice(0, 2000) + '... (line truncated to 2000 chars)' : raw
      const cost = Buffer.byteLength(text, 'utf8') + (lines.length ? 1 : 0)
      if (bytes + cost > 50 * 1024) break
      bytes += cost
      lines.push({ number: index + 1, text })
    }
    return { isError: false, value: { path: requested, offset, lines, totalLines: all.length }, content: [] }
  })
}
