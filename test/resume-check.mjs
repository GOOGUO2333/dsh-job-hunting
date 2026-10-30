/**
 * Offline regression for resume.js: build a resume as .docx (with the plugin's
 * own docx writer), a .txt copy, and attempt a .pdf conversion when LibreOffice
 * is available; then assert the extracted facts.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToDocx } from '../docx.js'
import { loadResume } from '../resume.js'

const RESUME = `# 张三

- 性别：男 ｜ 出生：2001.05
- 电话：138xxxx1234 ｜ 邮箱：zhangsan@example.com
- 所在城市：芜湖

## 教育背景
2021.09 - 2025.06  某某大学  软件工程  本科

## 专业技能
- 了解 Python，熟悉基础 Linux 命令，了解 MySQL
- 会写测试用例，做过功能测试和接口测试
- 熟悉 Vue、JavaScript、HTML、CSS，用过 Element UI

## 项目经历
2024.03 - 2024.09  校企合作校园二手交易平台（Vue 前端开发）
2024.09 - 2025.01  校企合作实验室设备管理系统（Vue 前端开发）

## 求职意向
软件测试 / 车载测试 / 自动化测试，芜湖
`

const dir = mkdtempSync(join(tmpdir(), 'resume-check-'))
const mdPath = join(dir, 'resume.md')
const docxPath = join(dir, 'resume.docx')
const txtPath = join(dir, 'resume.txt')
writeFileSync(mdPath, RESUME)
writeFileSync(txtPath, RESUME)
writeFileSync(docxPath, markdownToDocx(RESUME))

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(`${name}: ${detail}`)
}

function expectFacts(label, result) {
  console.log(`\n[${label}] ok=${result.ok} kind=${result.kind} chars=${result.chars}${result.error ? ` error=${result.error}` : ''}`)
  check(`${label} 解析成功`, result.ok === true, result.error || 'not ok')
  if (!result.ok) return
  const { profile } = result
  const skills = profile.skills.map((skill) => skill.toLowerCase())
  check(`${label} 认出 Python`, skills.includes('python'), profile.skills.join(','))
  check(`${label} 认出 Vue`, skills.includes('vue'), profile.skills.join(','))
  check(`${label} 认出 测试用例/功能测试`, skills.some((s) => s.includes('测试')), profile.skills.join(','))
  check(`${label} 学历=本科`, (profile.education?.label || '') === '本科', String(profile.education?.label))
  check(`${label} 城市含芜湖`, profile.cities.includes('芜湖'), profile.cities.join(','))
  check(`${label} 岗位线索`, profile.titles.length > 0, profile.titles.join(','))
  check(`${label} 年限非负`, profile.years === null || profile.years >= 0, String(profile.years))
  console.log(`       summary: ${result.summary}`)
}

expectFacts('docx', loadResume(docxPath))
expectFacts('txt', loadResume(txtPath))

// PDF path: only when libreoffice is on PATH.
let converted = false
try {
  const probe = join(dir, 'probe.docx')
  copyFileSync(docxPath, probe)
  execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, docxPath], { stdio: 'ignore', timeout: 120_000 })
  const pdfPath = join(dir, 'resume.pdf')
  converted = existsSync(pdfPath)
  if (converted) expectFacts('pdf', loadResume(pdfPath))
  else console.log('\n[pdf] LibreOffice 转出的 pdf 不存在，跳过')
} catch (error) {
  console.log(`\n[pdf] 跳过（LibreOffice 不可用：${error?.message?.split('\n')[0] || error}）`)
}

// Error handling
const missing = loadResume(join(dir, 'nope.docx'))
check('缺失文件报错', missing.ok === false && /找不到/.test(missing.error), missing.error)
const bare = join(dir, 'empty.txt')
writeFileSync(bare, 'hi')
const tooShort = loadResume(bare)
check('文本过短报错', tooShort.ok === false && /没有读到文字/.test(tooShort.error), tooShort.error)
const gif = join(dir, 'x.gif')
writeFileSync(gif, 'GIF89a')
const badKind = loadResume(gif)
check('不支持格式报错', badKind.ok === false && /只支持/.test(badKind.error), badKind.error)

rmSync(dir, { recursive: true, force: true })
console.log(failures.length ? `\nRESUME FAIL (${failures.length})` : '\nRESUME OK')
process.exit(failures.length ? 1 : 0)
