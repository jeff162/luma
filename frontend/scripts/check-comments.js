import fs from 'fs'
import path from 'path'

const ROOT = './src'

// Flags low-value *structural-narration* comments — the throwaway labels AGENTS.md calls out
// ("// render", "// handle click", "// update state"). The hard part is not catching those, it's NOT
// catching the same verbs when they appear inside a real intent comment: a full sentence that wraps
// across lines routinely breaks onto "// render ..." or "// set ...", and judging that continuation line
// in isolation is what produced false positives. So a verb match alone is never enough. A comment is
// flagged only when all three hold: it leads with a narration verb, it is short (labels are terse), and
// it is a standalone line — not part of a multi-line comment block, where the prose must be read whole.

const NARRATION_WORDS = ['loop', 'set', 'render', 'handle', 'update', 'get']
const MAX_NARRATION_WORDS = 4

function isCommentLine(line) {
  return Boolean(line) && line.trim().startsWith('//')
}

function commentWords(trimmedLine) {
  return trimmedLine.replace(/^\/\/\s*/, '').split(/\s+/).filter(Boolean)
}

function isLowValueComment(lines, index) {
  const trimmed = lines[index].trim()
  if (!trimmed.startsWith('//')) return false

  const words = commentWords(trimmed)
  if (words.length === 0 || words.length > MAX_NARRATION_WORDS) return false

  const firstWord = words[0].toLowerCase().replace(/[^a-z]/g, '')
  if (!NARRATION_WORDS.includes(firstWord)) return false

  // A continuation/lead-in line of a multi-line comment is prose, not a label — exempt the whole block.
  if (isCommentLine(lines[index - 1]) || isCommentLine(lines[index + 1])) return false

  return true
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n')

  const issues = []
  lines.forEach((line, i) => {
    if (isLowValueComment(lines, i)) {
      issues.push({ line: i + 1, text: line.trim() })
    }
  })

  return issues
}

function walk(dir) {
  let results = []
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file)
    const stat = fs.statSync(full)

    if (stat.isDirectory()) {
      results = results.concat(walk(full))
    } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
      const issues = scanFile(full)
      if (issues.length) {
        results.push({ file: full, issues })
      }
    }
  }
  return results
}

const results = walk(ROOT)

if (results.length) {
  console.log('\n⚠️ Low-value comments detected:\n')

  results.forEach(({ file, issues }) => {
    console.log(file)
    issues.forEach(issue => {
      console.log(`  Line ${issue.line}: ${issue.text}`)
    })
    console.log('')
  })

  process.exit(1)
} else {
  console.log('✅ Comment quality check passed')
}
