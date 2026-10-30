// Offline regression for job_search + resumePath.
// Usage: node tools/resume-search.mjs
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { markdownToDocx } from '../docx.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-resume-search-'))
const resumePath = join(dir, 'resume.docx')
writeFileSync(
  resumePath,
  markdownToDocx(
    [
      '# 张同学',
      '',
      '## 基本信息',
      '所在城市：芜湖　学历：本科　专业：软件工程',
      '',
      '## 技能',
      '- 了解 Python，会使用基础 Linux 命令，了解 MySQL',
      '- 会写测试用例，了解功能测试与接口测试',
      '',
      '## 教育背景',
      '2021.09 - 2025.06　某某学院　软件工程　本科',
      '',
      '## 项目经历',
      '- 2024.03 - 2024.09　校企合作 Vue 前端项目：负责页面开发与接口对接',
      '',
      '## 自我介绍',
      '应届毕业生，无相关社会工作经验，希望从事软件测试或车载测试方向。',
    ].join('\n'),
  ),
)

const tools = new Map()
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  web: {
    search: async () => ({
      content: '芜湖 软件测试 招聘：5-8K',
      sources: [{ url: 'https://example.com/job/1', title: '软件测试 5-8K', snippet: '芜湖 软件测试 5-8K' }],
    }),
  },
}

apply(ctx, {})
const tool = tools.get('job_search')
if (!tool) throw new Error('missing tool job_search')

const args = { keyword: '软件测试', city: '芜湖', resumePath, freshnessDays: 30 }
const value = await tool.execute(args, {})

const fails = []
const check = (ok, message) => {
  if (!ok) fails.push(message)
  console.log(`  ${ok ? 'ok' : 'FAIL'}  ${message}`)
}

check(value.resume && value.resume.path === resumePath, '结果里带简历路径')
check(value.resume && value.resume.kind === 'docx', '识别简历格式 docx')
check(value.resume && value.resume.education === '本科', `学历=本科（实际 ${value.resume && value.resume.education}）`)
check(value.resume && value.resume.city === '芜湖', `城市=芜湖（实际 ${value.resume && value.resume.city}）`)
check(value.resume && value.resume.skills.includes('Python'), '认出 Python')
check(value.resume && value.resume.years === 0, `应届生年限=0（实际 ${value.resume && value.resume.years}）`)
check(
  (value.notes || []).some((note) => note.startsWith('按简历匹配：')),
  '说明里有「按简历匹配」',
)

const rendered = tool.output.render(args, value)
  .map((block) => block.text || '')
  .join('\n')
check(rendered.includes('按简历匹配：'), '渲染正文标注「按简历匹配」')
check(rendered.includes('招聘信息搜集'), '渲染正文含结果标题')

// A missing resume file must fail loudly instead of silently searching.
let threw = ''
try {
  await tool.execute({ keyword: '软件测试', resumePath: join(dir, 'nope.docx') }, {})
} catch (error) {
  threw = error.message || String(error)
}
check(threw.includes('简历解析失败'), `缺失简历文件报错（实际「${threw}」）`)

rmSync(dir, { recursive: true, force: true })
console.log(fails.length ? `RESUME SEARCH FAIL (${fails.length})` : 'RESUME SEARCH OK')
process.exit(fails.length ? 1 : 0)
