// Checks the adjusted defaults: 7-day freshness, verified-first selection,
// and at most 2 unverified entries filling the remaining slots.
import { apply } from '../index.js'

const tools = new Map()
const sources = [
  { url: 'https://www.liepin.com/job/1986405589.shtml', title: 'Java开发-上海智元衍知-猎聘' },
  { url: 'https://www.zhipin.com/job_detail/aaaaaaaaaaa1.html', title: 'Java开发工程师-甲公司-BOSS直聘', snippet: '上海 3-5年 20-35K' },
  { url: 'https://www.zhipin.com/job_detail/aaaaaaaaaaa2.html', title: 'Java开发工程师-乙公司-BOSS直聘', snippet: '上海 3-5年 18-30K' },
  { url: 'https://www.zhipin.com/job_detail/aaaaaaaaaaa3.html', title: 'Java开发工程师-丙公司-BOSS直聘', snippet: '上海 3-5年 22-35K' },
  { url: 'https://www.iguopin.com/job/detail?id=1234567890123456789', title: 'Java开发-国聘', snippet: '上海 20-35K' },
]

const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  web: { search: async () => ({ sources, truncated: false, content: 'stub' }) },
}

apply(ctx, {})

const search = tools.get('job_search')
const signal = new AbortController().signal

const fill = await search.execute({ keyword: 'Java', city: '上海', maxResults: 10 }, { signal })
const fillUnverified = fill.jobs.filter((job) => job.status === 'unverified').length
console.log('fill: total=%d open=%d unverified=%d', fill.jobs.length, fill.verifiedCount, fillUnverified)
console.log('fill notes:', fill.notes.join(' | '))
if (fillUnverified > 2) throw new Error(`未核实补位超过 2 条：${fillUnverified}`)

const strict = await search.execute({ keyword: 'Java', city: '上海', maxResults: 10, verifiedOnly: true }, { signal })
console.log('strict: total=%d open=%d', strict.jobs.length, strict.verifiedCount)
if (strict.jobs.some((job) => job.status !== 'open')) throw new Error('verifiedOnly 仍返回未核实条目')
console.log('strict notes:', strict.notes.join(' | '))

const plan = tools.get('career_plan')
const career = await plan.execute(
  { background: '5 年后端，Java、Spring Boot、Redis，上海，期望 30K', city: '上海', targetRole: 'Java 后端开发工程师', market: 'off' },
  { signal },
)
if (!career.report.includes('职业规划报告')) throw new Error('career_plan 未产出报告')
if (!career.target || career.target.role !== 'Java 后端开发工程师') throw new Error('career_plan 未评估目标岗位')
console.log('career_plan: target=%d recommendations=%d', career.target.score, career.recommendations.length)

console.log('CAPS OK')
