import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Only this public directory is scanned; local research elsewhere stays private.
export function readMarkdownPages(root, groups, reserved = []) {
  const pages = [], ids = new Set(reserved)
  function visit(directory, group) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (directory !== root || !groups.includes(entry.name)) throw new Error(`Unknown documentation group: ${file}`)
        visit(file, entry.name)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const id = entry.name.slice(0, -3)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Use a lowercase slug for the Markdown filename: ${file}`)
        if (ids.has(id)) throw new Error(`Duplicate documentation page id: ${id} (${file})`)
        ids.add(id)
        const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
        const title = /^# +(.+)\n?/.exec(text)
        if (!title) throw new Error(`Markdown page must start with # Title: ${file}`)
        pages.push({ id, title: title[1].trim(), group, intro: '', content: text.slice(title[0].length).trim(), file })
      }
    }
  }
  visit(root, 'help')
  const routes = new Map(pages.map(page => [path.resolve(page.file), page.id]))
  return pages.map(({ file, ...page }) => ({ ...page, content: page.content.split(/(```[^]*?```|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part.replace(/\]\(([^\s)]+\.md)\)/g, (match, target) => {
    if (/^[a-z]+:/i.test(target)) return match
    const route = routes.get(path.resolve(path.dirname(file), target))
    if (!route) throw new Error(`Unknown Markdown page link: ${target} (${file})`)
    return `](#${route})`
  })).join('') }))
}
