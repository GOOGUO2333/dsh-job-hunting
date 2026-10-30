// Offline regression for career_plan / career_interview.
// Usage: node tools/career-check.mjs [--print]
import { apply } from '../index.js'

const tools = new Map()
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  web: {
    search: async () => ({
      content: '芜湖 前端开发工程师 招聘：6-9K，8-12K，部分岗位 7-10K',
      sources: [
        { url: 'https://example.com/a', title: '前端开发 6-9K', snippet: '芜湖 前端开发工程师 6-9K' },
        { url: 'https://example.com/b', title: '前端 8-12K', snippet: 'Vue 前端 8-12K' },
      ],
    }),
  },
}

apply(ctx, {})
const print = process.argv.includes('--print')
const need = (name) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

const background = [
  '干过 1 年半的模具维修，在校期间写过 3 个校企合作的 Vue 前端项目（负责页面开发与接口对接）。',
  '人在芜湖，大专学历，希望转前端方向发展。',
].join('')

const planTool = need('career_plan')
const value = await planTool.execute(
  {
    background,
    city: '芜湖',
    targetRole: '前端开发工程师',
    expectedSalary: '6K',
    market: 'quick',
  },
  {},
)

const report = value.report
const sections = ['# 职业规划报告', '## 一、个人画像', '## 二、目标岗位是否合适', '## 三、推荐方向', '## 五、能力差距', '## 七、风险与提醒', '## 九、下一步']
for (const section of sections) {
  if (!report.includes(section)) throw new Error(`report missing section: ${section}`)
}
if (!value.target) throw new Error('target verdict missing')
if (!value.recommendations.length) throw new Error('no recommendations')
if (value.profile.years !== 1.5) throw new Error(`years parsed wrong: ${value.profile.years}`)
if (value.profile.education !== '大专') throw new Error(`education parsed wrong: ${value.profile.education}`)
if (value.profile.city !== '芜湖') throw new Error(`city parsed wrong: ${value.profile.city}`)

const interview = need('career_interview')
const first = await interview.execute({})
if (!first.questions.length) throw new Error('no interview questions')
const last = first.questions[first.questions.length - 1]
if (!last.question.includes('补充')) throw new Error(`last question must ask for supplements, got: ${last.question}`)
if (first.complete) throw new Error('empty profile should not be complete')

const second = await interview.execute({
  background: '我做过模具维修，会一点 CAD 和 Vue，在芜湖，大专',
  answered: ['degree', 'jobs'],
})
if (second.questions.some((item) => item.id === 'degree' || item.id === 'jobs')) {
  throw new Error('answered questions were repeated')
}

console.log('career tools registered:', [...tools.keys()].join(', '))
console.log('profile:', JSON.stringify(value.profile))
console.log('target:', JSON.stringify(value.target))
console.log('recommendations:')
for (const item of value.recommendations) {
  console.log(`  - ${item.name} score=${item.score} ${item.bucket} salary=${item.salary}`)
}
if (print) {
  console.log('\n===== report =====\n')
  console.log(report)
}
console.log('\nCAREER OK')
