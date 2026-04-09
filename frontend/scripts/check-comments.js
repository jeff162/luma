import fs from 'fs'
import path from 'path'

const ROOT = './src'

// Patterns that indicate useless comments
const BAD_PATTERNS = [
  /\/\/\s*loop/i,
  /\/\/\s*set\s+/i,
  /\/\/\s*render/i,
  /\/\/\s*handle/i,
  /\/\/\s*update/i,
  /\/\/\s*get\s+/i,
]

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n')

  const issues = []

  lines.forEach((line, i) => {
    const trimmed = line.trim()

    if (trimmed.startsWith('//')) {
      for (const pattern of BAD_PATTERNS) {
        if (pattern.test(trimmed)) {
          issues.push({
            line: i + 1,
            text: trimmed
          })
        }
      }
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
