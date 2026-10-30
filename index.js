/**
 * job-hunting — Chinese job search plus profile-driven career planning.
 *
 * Three model-facing tools:
 *   job_search        keyword + city + experience -> verified postings table
 *   career_plan       profile -> target-role verdict, recommended directions, full plan
 *   career_interview  interview questions used to build the profile
 *
 * `career_*` never returns a posting list: it reasons over the person (years, education,
 * skills, past jobs, city tier, pay expectation) and produces a written career plan.
 * Postings only appear as optional market evidence when `market: "quick"` is requested.
 *
 * Discovery goes through `ctx.web` (the host web-search provider). Liveness is checked by
 * fetching the posting's own detail page with a plain node:https request that bypasses the
 * environment HTTP proxy (the desktop build carries a dead proxy in HTTP_PROXY), then reading
 * schema.org JobPosting JSON-LD where a site exposes it.
 *
 * Everything runs with built-in node modules only, so the bundle needs no dependencies.
 */
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import { request as httpRequest, Agent as HttpAgent } from 'node:http'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToDocx } from './docx.js'
import { loadResume } from './resume.js'
import {
  assessTarget,
  buildProfile,
  buildReport,
  careerQuestions,
  recommendCareers,
} from './careers.js'

const name = 'job-hunting'
const inject = ['tools', 'web']

/** Defaults; a row may override any of them through its `config:` block. */
const DEFAULTS = {
  freshnessDays: 7,
  maxResults: 10,
  perSiteLimit: 8,
  timeoutMs: 9000,
  concurrency: 4,
  verifyLimit: 24,
  includeUnverified: true,
  unverifiedCap: 2,
  browserEnabled: true,
  browserHeadless: true,
  browserTimeoutMs: 15000,
  browserLimit: 16,
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** Sites whose detail pages only become readable after a real browser renders them. */
const DEFAULT_BROWSER_SITES = ['iguopin', 'zhipin', '51job']

/**
 * Every board we know how to reach. `resolve` accepts a search-result URL and returns the
 * canonical posting URL, or null when the URL is a category/list page rather than one job.
 */
const SITES = [
  {
    key: 'liepin',
    label: '猎聘',
    host: /(^|\.)liepin\.com$/i,
    query: (kw, city, exp) => `site:liepin.com ${kw} ${city || ''} ${exp || ''} 招聘`.replace(/\s+/g, ' ').trim(),
    resolve: (u) => {
      const m = /^\/job\/(\d{6,})\.shtml$/.exec(u.pathname)
      return m ? `https://www.liepin.com/job/${m[1]}.shtml` : null
    },
  },
  {
    key: 'zhipin',
    label: 'BOSS直聘',
    host: /(^|\.)zhipin\.com$/i,
    query: (kw, city, exp) => `site:zhipin.com ${kw} ${city || ''} ${exp || ''} 招聘`.replace(/\s+/g, ' ').trim(),
    resolve: (u) => {
      const m = /^\/job_detail\/([A-Za-z0-9~_.-]+)\.html$/.exec(u.pathname)
      return m ? `https://www.zhipin.com/job_detail/${m[1]}.html` : null
    },
  },
  {
    key: 'iguopin',
    label: '国聘网',
    host: /(^|\.)iguopin\.com$/i,
    query: (kw, city, exp) => `site:iguopin.com ${kw} ${city || ''} ${exp || ''}`.replace(/\s+/g, ' ').trim(),
    resolve: (u) => {
      const path = u.pathname.replace(/\/+$/, '')
      const id = u.searchParams.get('id') || u.searchParams.get('jobId') || u.searchParams.get('jobid')
      if (!/\/job\/(detail|info)$/i.test(path) && !/\/jobs?$/i.test(path)) return null
      return id && /^\d{4,}$/.test(id) ? `https://www.iguopin.com/job/detail?id=${id}` : null
    },
  },
  {
    key: 'zhaopin',
    label: '智联招聘',
    host: /(^|\.)zhaopin\.com$/i,
    query: (kw, city, exp) => `site:zhaopin.com ${kw} ${city || ''} ${exp || ''} 招聘`.replace(/\s+/g, ' ').trim(),
    resolve: (u) => {
      let m = /^\/jobdetail\/([A-Za-z0-9]+)\.htm$/.exec(u.pathname)
      if (m) return `https://www.zhaopin.com/jobdetail/${m[1]}.htm`
      m = /^\/([A-Za-z0-9]{6,})\.htm$/.exec(u.pathname)
      if (m && /^jobs\./i.test(u.hostname)) return `https://jobs.zhaopin.com/${m[1]}.htm`
      return null
    },
  },
  {
    key: '51job',
    label: '前程无忧',
    host: /(^|\.)51job\.com$/i,
    query: (kw, city, exp) => `site:51job.com ${kw} ${city || ''} ${exp || ''} 招聘`.replace(/\s+/g, ' ').trim(),
    resolve: (u) => {
      if (!/\.html?$/i.test(u.pathname)) return null
      if (!/\d{6,}/.test(u.pathname)) return null
      if (/\/(search|list|joblist|jobs)\/?(index)?\.html?$/i.test(u.pathname)) return null
      return `https://${u.hostname.replace(/^www\./i, 'jobs.')}${u.pathname}`.replace('jobs.jobs.', 'jobs.')
    },
  },
]

/** Posting-level "this job is gone" wording. */
const CLOSED_MARKERS = [
  '职位已关闭',
  '该职位已下线',
  '职位已下线',
  '该职位已失效',
  '职位已失效',
  '已停止招聘',
  '该岗位已关闭',
  '岗位已下线',
  '职位不存在',
  '该职位不存在',
  '已被用户关闭',
  '招聘已结束',
  '该职位已停招',
  '报名结束',
  '报名已结束',
  '已结束招聘',
  '停招',
]

/** Anti-bot / verification interstitials: presence means we could not read the page. */
const BLOCK_MARKERS = [
  '请稍候',
  '安全验证',
  '访问验证',
  '人机验证',
  '滑动验证',
  '环境异常',
  'captcha',
  'Access Denied',
  'Just a moment',
  'Robot Check',
  '访问过于频繁',
  '请开启JavaScript',
]

/** Browser-visible walls that only a human click can pass (IP risk control, sliders). */
const VERIFY_MARKERS = [
  '安全验证',
  '滑动验证',
  '访问验证',
  '人机验证',
  '验证码',
  '正在验证连接安全性',
  'Security Verification',
  '请勾选下方复选框',
  'IP 地址可能存在异常',
  '行为异常',
]

/** Wording that marks padding, agencies, or outright scams rather than a real opening. */
const FRAUD_MARKERS = [
  '押金',
  '保证金',
  '培训费',
  '服装费',
  '体检费',
  '办卡费',
  '刷单',
  '兼职日结',
  '无经验可做',
  '无门槛',
  '学历不限包就业',
  '直招代理',
  '人才派遣',
  '劳务派遣',
  '代理招聘',
]

/** Titles that are list/aggregation pages rather than one posting. */
const NON_JOB_TITLE =
  /(招聘信息|人才网|职位列表|招聘频道|职位搜索|校园招聘|社会招聘|招聘会|求职|职位大全|岗位大全|招聘网|job list|job search)/i

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clampInt = (value, fallback, min, max) => {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

const short = (value, max = 80) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const errText = (error) => short(error?.message || error?.code || String(error), 140)

function firstHit(text, markers) {
  if (!text) return null
  for (const marker of markers) if (text.includes(marker)) return marker
  return null
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/gi, '&')
}

/** Visible text of an HTML document, collapsed to one line. */
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Meta tag content by name or property, tolerating attribute order. */
function metaContent(html, key) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i',
  )
  const tag = re.exec(html)?.[0]
  if (!tag) return ''
  const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
  return decodeEntities(content)
}

/** Years of experience mentioned in a phrase such as "3年以上" or "5-10年". */
function parseYears(text) {
  const s = String(text ?? '')
  if (!s) return null
  if (/经验不限|不限经验|应届|在校|实习/.test(s) && !/\d/.test(s)) return 0
  const m = /(\d{1,2})\s*(?:[-~到至]\s*(\d{1,2}))?\s*年/.exec(s)
  if (!m) return null
  return Number.parseInt(m[1], 10)
}

/** Upper bound of the experience range the user asked for: "1年以内" -> 1, "3-5年" -> 5. */
function wantedYearsMax(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  if (/应届|在校|实习|无经验/.test(s) && !/\d/.test(s)) return 0
  const range = /(\d{1,2})\s*[-~到至]\s*(\d{1,2})\s*年/.exec(s)
  if (range) return Number.parseInt(range[2], 10)
  const within = /(\d{1,2})\s*年\s*(?:以内|以下|及以下)/.exec(s)
  if (within) return Number.parseInt(within[1], 10)
  const single = /(\d{1,2})\s*年/.exec(s)
  if (single) return Number.parseInt(single[1], 10)
  return null
}

const CITIES = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '武汉', '成都', '重庆', '西安', '天津',
  '长沙', '郑州', '青岛', '济南', '合肥', '福州', '厦门', '宁波', '无锡', '东莞', '佛山', '珠海',
  '大连', '沈阳', '长春', '哈尔滨', '石家庄', '太原', '南昌', '南宁', '昆明', '贵阳', '兰州',
  '乌鲁木齐', '呼和浩特', '海口', '三亚', '温州', '常州', '徐州', '烟台', '大连',
]

function detectCity(text) {
  const s = String(text ?? '')
  for (const city of CITIES) if (s.includes(city)) return city
  return ''
}

/**
 * Rendered SPAs print the location as "北京-西城区" right under the salary.
 * Only accept it when the prefix is a known city, so stray "公司-分部" text cannot leak in.
 */
function cityFromRenderedText(text) {
  const s = String(text ?? '')
  const district = /([\u4e00-\u9fa5]{2,4})[-–—]([\u4e00-\u9fa5]{2,6}(?:新区|区|县|市))/u.exec(s)
  if (district) {
    const city = detectCity(district[1])
    if (city) return `${city}-${district[2]}`
  }
  // 国聘 prints "10~15K 南京国机数字科技有限公司": the city sits right after the salary.
  const afterSalary = /(?:面议|[\d.]+\s*[~-]\s*[\d.]+\s*[Kk千万](?:\s*[·•]\s*\d+\s*薪)?)\s*([\u4e00-\u9fa5]{2,8})/u.exec(s)
  if (afterSalary) {
    const city = detectCity(afterSalary[1])
    if (city) return city
  }
  const labeled = /(?:工作地点|办公地点|工作城市|职位地点)\s*[:：]?\s*([\u4e00-\u9fa5]{2,12})/u.exec(s)
  if (labeled) {
    const city = detectCity(labeled[1])
    if (city) return city
  }
  return ''
}

/**
 * Some listings put the work city at the head of the title ("上海Java开发工程师招聘_...").
 * Only the part before the company suffix is trusted: the company's own address is not the job's.
 */
function cityFromSearchTitle(title) {
  const head = String(title ?? '').split(/[_|]/)[0].replace(/招聘.*$/, '')
  return detectCity(head)
}

// Job boards that encode the city in the URL slug (51job: /jobs/wuhu-jjq/..., zhipin: city=101210200).
const CITY_SLUGS = {
  beijing: '北京', shanghai: '上海', guangzhou: '广州', shenzhen: '深圳', hangzhou: '杭州',
  nanjing: '南京', suzhou: '苏州', wuhan: '武汉', chengdu: '成都', chongqing: '重庆',
  xian: '西安', tianjin: '天津', changsha: '长沙', zhengzhou: '郑州', qingdao: '青岛',
  jinan: '济南', hefei: '合肥', fuzhou: '福州', xiamen: '厦门', ningbo: '宁波',
  wuxi: '无锡', dongguan: '东莞', foshan: '佛山', zhuhai: '珠海', dalian: '大连',
  shenyang: '沈阳', changchun: '长春', haerbin: '哈尔滨', harbin: '哈尔滨',
  shijiazhuang: '石家庄', taiyuan: '太原', nanchang: '南昌', nanning: '南宁',
  kunming: '昆明', guiyang: '贵阳', lanzhou: '兰州', wulumuqi: '乌鲁木齐',
  huhehaote: '呼和浩特', haikou: '海口', sanya: '三亚', wenzhou: '温州',
  changzhou: '常州', xuzhou: '徐州', yantai: '烟台', wuhu: '芜湖', maanshan: '马鞍山',
  bengbu: '蚌埠', anqing: '安庆', chuzhou: '滁州', fuyang: '阜阳',
  liuan: '六安', huainan: '淮南', huaibei: '淮北', tongling: '铜陵', xuancheng: '宣城',
  chizhou: '池州', huangshan: '黄山', jiaxing: '嘉兴', huzhou: '湖州', shaoxing: '绍兴',
  jinhua: '金华', taizhou: '台州', yangzhou: '扬州', zhenjiang: '镇江', taian: '泰安',
  weifang: '潍坊', zibo: '淄博', linyi: '临沂',
}

function cityFromUrl(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl || ''))
  } catch {
    return ''
  }
  const segments = url.pathname.toLowerCase().split('/').filter(Boolean)
  for (const segment of segments) {
    const head = segment.split(/[-_.]/)[0]
    if (head && CITY_SLUGS[head]) return CITY_SLUGS[head]
  }
  for (const key of ['city', 'cityname', 'jobarea']) {
    const value = url.searchParams.get(key)
    if (!value) continue
    const lower = value.toLowerCase()
    if (CITY_SLUGS[lower]) return CITY_SLUGS[lower]
  }
  return ''
}

const normalizeCity = (value) => String(value ?? '').replace(/[市省区县]/g, '').trim()

function cityMatches(jobCity, wanted) {
  const job = normalizeCity(jobCity)
  const want = normalizeCity(wanted)
  if (!want) return true
  if (!job) return true // unknown location is not a mismatch
  if (/全国|远程|不限|异地/.test(jobCity)) return true
  return job.includes(want) || want.includes(job)
}

/** Parse a salary string into a numeric monthly range in CNY, when possible. */
function salaryRange(text) {
  const s = String(text ?? '')
  if (!s || /面议|保密|不限/.test(s)) return null
  const monthK = /(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)\s*[Kk千]/.exec(s)
  if (monthK) return [Number(monthK[1]) * 1000, Number(monthK[2]) * 1000]
  const singleK = /(\d+(?:\.\d+)?)\s*[Kk千]/.exec(s)
  if (singleK) {
    const v = Number(singleK[1]) * 1000
    return [v, v]
  }
  const yearWan = /(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)\s*万/.exec(s)
  if (yearWan) {
    return [(Number(yearWan[1]) * 10000) / 12, (Number(yearWan[2]) * 10000) / 12]
  }
  const singleWan = /(\d+(?:\.\d+)?)\s*万/.exec(s)
  if (singleWan) {
    const v = (Number(singleWan[1]) * 10000) / 12
    return [v, v]
  }
  const plain = /(\d{4,6})\s*[-~到]\s*(\d{4,6})/.exec(s)
  if (plain) return [Number(plain[1]), Number(plain[2])]
  return null
}

function salaryTextFromLd(baseSalary) {
  if (!baseSalary) return ''
  if (typeof baseSalary === 'string') return short(baseSalary, 40)
  const value = baseSalary.value
  const unit = (value && typeof value === 'object' && value.unitText) || baseSalary.unitText || ''
  const currency = baseSalary.currency || 'CNY'
  const pick = (node) => {
    if (!node || typeof node !== 'object') return null
    const min = Number(node.minValue)
    const max = Number(node.maxValue)
    const single = Number(node.value)
    if (Number.isFinite(min) && Number.isFinite(max)) return [min, max]
    if (Number.isFinite(single)) return [single, single]
    return null
  }
  const range = pick(value) ?? pick(baseSalary)
  if (!range) return ''
  const [min, max] = range
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const isYear = /year/i.test(unit)
  const isMonth = /month/i.test(unit)
  const isHour = /hour/i.test(unit)
  const isDay = /day/i.test(unit)
  if (isYear) return `${fmt(min / 10000)}-${fmt(max / 10000)}万/年`
  if (isHour) return `${fmt(min)}-${fmt(max)}元/时`
  if (isDay) return `${fmt(min)}-${fmt(max)}元/天`
  if (isMonth || min >= 1000) return `${fmt(min / 1000)}-${fmt(max / 1000)}K/月`
  return `${fmt(min)}-${fmt(max)} ${currency}`
}

function parseDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

const ageInDays = (date, now = Date.now()) =>
  date ? Math.max(0, Math.floor((now - date.getTime()) / 86_400_000)) : null

const isoDay = (date) => (date ? date.toISOString().slice(0, 10) : '')

// ---------------------------------------------------------------------------
// Direct HTTP (bypasses the poisoned HTTP_PROXY / NODE_USE_ENV_PROXY setting)
// ---------------------------------------------------------------------------

const AGENTS = {
  https: new HttpsAgent({ keepAlive: false }),
  http: new HttpAgent({ keepAlive: false }),
}

/**
 * GET a URL and decode the body to UTF-8 text.
 * Resolves (never throws) to `{ ok, status, url, contentType, body, truncated, error }`.
 */
function fetchText(rawUrl, options = {}, depth = 0) {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const signal = options.signal
  if (signal?.aborted) return Promise.resolve({ ok: false, status: 0, url: rawUrl, error: 'aborted' })

  return new Promise((resolve) => {
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      resolve({ ok: false, status: 0, url: rawUrl, error: 'invalid url' })
      return
    }

    let settled = false
    let timer
    let req
    let onAbort
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }

    timer = setTimeout(() => {
      try {
        req?.destroy(new Error('timeout'))
      } catch {}
      finish({ ok: false, status: 0, url: rawUrl, error: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)

    onAbort = () => {
      try {
        req?.destroy(new Error('aborted'))
      } catch {}
      finish({ ok: false, status: 0, url: rawUrl, error: 'aborted' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const isHttps = parsed.protocol === 'https:'
    try {
      req = (isHttps ? httpsRequest : httpRequest)(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          agent: isHttps ? AGENTS.https : AGENTS.http,
          headers: {
            'user-agent': UA,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'accept-encoding': 'gzip, deflate, br',
            connection: 'close',
          },
        },
        (res) => {
          const status = res.statusCode || 0
          const location = res.headers.location
          if (status >= 300 && status < 400 && location && depth < 3) {
            res.resume()
            let next
            try {
              next = new URL(location, parsed).href
            } catch {
              next = location
            }
            clearTimeout(timer)
            fetchText(next, options, depth + 1).then(finish)
            return
          }

          const encoding = String(res.headers['content-encoding'] || '').toLowerCase()
          let stream = res
          try {
            if (encoding === 'gzip') stream = res.pipe(createGunzip())
            else if (encoding === 'deflate') stream = res.pipe(createInflate())
            else if (encoding === 'br') stream = res.pipe(createBrotliDecompress())
          } catch (error) {
            finish({ ok: false, status, url: rawUrl, error: `decode: ${errText(error)}` })
            return
          }

          const chunks = []
          let size = 0
          stream.on('data', (chunk) => {
            size += chunk.length
            if (size <= 4_000_000) chunks.push(chunk)
          })
          stream.on('end', () =>
            finish({
              ok: status >= 200 && status < 300,
              status,
              url: rawUrl,
              finalUrl: rawUrl,
              contentType: String(res.headers['content-type'] || ''),
              body: Buffer.concat(chunks).toString('utf8'),
              truncated: size > 4_000_000,
            }),
          )
          stream.on('error', (error) => finish({ ok: false, status, url: rawUrl, error: errText(error) }))
        },
      )
      req.on('error', (error) => finish({ ok: false, status: 0, url: rawUrl, error: errText(error) }))
      req.end()
    } catch (error) {
      finish({ ok: false, status: 0, url: rawUrl, error: errText(error) })
    }
  })
}

// ---------------------------------------------------------------------------
// Detail-page parsing
// ---------------------------------------------------------------------------

/** First schema.org JobPosting node of a document, or null. */
function pickJobPosting(html) {
  const found = []
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = re.exec(html)) !== null && found.length < 4) {
    const raw = match[1].trim().replace(/^<!--/, '').replace(/-->$/, '').trim()
    if (!raw) continue
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      continue
    }
    walk(data)
  }
  return found[0] || null

  function walk(node) {
    if (!node || typeof node !== 'object' || found.length >= 4) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const type = node['@type']
    const types = Array.isArray(type) ? type : [type]
    if (types.some((value) => typeof value === 'string' && /JobPosting/i.test(value))) found.push(node)
    if (node['@graph']) walk(node['@graph'])
    if (node.mainEntity && node.mainEntity !== node) walk(node.mainEntity)
  }
}

function locationOf(ld) {
  const candidates = Array.isArray(ld.jobLocation) ? ld.jobLocation : [ld.jobLocation]
  for (const item of candidates) {
    if (!item) continue
    if (typeof item === 'string') return { city: item, region: '' }
    const address = item.address
    if (!address) continue
    if (typeof address === 'string') return { city: address, region: '' }
    const city = address.addressLocality || address.addressRegion || ''
    const region = address.addressRegion || ''
    if (city || region) return { city: String(city), region: String(region) }
  }
  return { city: '', region: '' }
}

function jobFromLd(ld) {
  const org = ld.hiringOrganization
  const location = locationOf(ld)
  const salary = salaryTextFromLd(ld.baseSalary)
  const description = stripTags(ld.description || '')
  const posted = parseDate(ld.datePosted)
  return {
    title: short(ld.title || ld.name || '', 120),
    company: short(typeof org === 'string' ? org : org?.name || '', 80),
    city: short(location.city.replace(/^中国[·,\s]*/, ''), 40),
    salary,
    experience: short(typeof ld.experienceRequirements === 'string' ? ld.experienceRequirements : '', 40),
    education: short(
      typeof ld.educationRequirements === 'string'
        ? ld.educationRequirements
        : ld.educationRequirements?.name || '',
      40,
    ),
    description,
    publishedAt: posted,
    validThrough: parseDate(ld.validThrough),
    industry: short(typeof ld.industry === 'string' ? ld.industry : '', 40),
    structured: true,
  }
}

/** Best-effort job fields from a page that has no JobPosting JSON-LD. */
function jobFromHtml(html) {
  const ogTitle = metaContent(html, 'og:title')
  const ogDescription = metaContent(html, 'og:description')
  const titleTag = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim()
  const text = htmlToText(html)
  const rawTitle = ogTitle || titleTag
  const title = cleanTitle(rawTitle)
  const companyMatch = /(?:公司|企业)[:：]\s*([^\s|,，。;；]{2,30})/.exec(text)
  return {
    title,
    company: companyFromSearchTitle(rawTitle) || short(companyMatch?.[1] || '', 80),
    city: cityFromHtml(html),
    // Body text is full of neighbouring "recommended job" cards, so a salary
    // scanned out of it is unreliable; the search snippet is the better source.
    salary: '',
    experience: '',
    education: '',
    description: short(`${ogDescription}\n${text}`, 3000),
    publishedAt: null,
    validThrough: null,
    industry: '',
    textLength: text.length,
    structured: false,
  }
}

/**
 * Fetch and judge one candidate posting.
 * @returns {{ status: string, evidence: string, detail: object|null }}
 */
async function verifyViaHttp(candidate, options) {
  const response = await fetchText(candidate.url, { timeoutMs: options.timeoutMs, signal: options.signal })

  if (!response.ok) {
    if (response.error === 'aborted') return { status: 'unverified', evidence: '请求被取消', detail: null }
    const reason = response.error ? short(response.error, 60) : `HTTP ${response.status}`
    return { status: 'unverified', evidence: `详情页无法访问（${reason}）`, detail: null, retryInBrowser: true }
  }

  const html = response.body || ''
  if (html.length < 600) {
    return {
      status: 'unverified',
      evidence: '详情页为空壳，站点未提供可读内容',
      detail: null,
      retryInBrowser: true,
    }
  }

  const text = htmlToText(html)
  const closed = firstHit(text, CLOSED_MARKERS)
  if (closed) return { status: 'closed', evidence: `详情页提示「${closed}」`, detail: null }

  const blocked =
    firstHit(text, BLOCK_MARKERS) ||
    (/<title[^>]*>[^<]*(请稍候|安全验证|环境异常)/i.test(html) ? '验证页标题' : null)
  if (blocked) {
    return { status: 'unverified', evidence: `站点反爬（命中「${blocked}」）`, detail: null, retryInBrowser: true }
  }

  const ld = pickJobPosting(html)
  if (ld) {
    const detail = jobFromLd(ld)
    if (detail.validThrough && detail.validThrough.getTime() < Date.now()) {
      return { status: 'closed', evidence: `招聘有效期已于 ${isoDay(detail.validThrough)} 结束`, detail }
    }
    return { status: 'open', evidence: '详情页 JobPosting 结构化数据可读', detail }
  }

  const fallback = jobFromHtml(html)
  const looksLikePosting =
    fallback.title &&
    !NON_JOB_TITLE.test(fallback.title) &&
    (fallback.textLength > 600 || /岗位职责|任职要求|职位描述|工作职责/.test(fallback.description))
  if (looksLikePosting) {
    return { status: 'open', evidence: '详情页正文可读（无结构化数据）', detail: fallback }
  }

  return { status: 'unverified', evidence: '详情页无可识别的岗位内容', detail: null, retryInBrowser: true }
}

/**
 * Judge one candidate, preferring whichever channel actually renders that site.
 * Browser-first sites are SPA or anti-bot walls where plain HTTP returns a shell;
 * the rest stay on HTTP (faster, and some sites punish automated browsers).
 */
async function verifyCandidate(candidate, options) {
  const browserReady = Boolean(options.browser)
  const prefersBrowser =
    browserReady && (options.browserUrls ? options.browserUrls.has(candidate.url) : false)

  if (prefersBrowser) {
    const rendered = await verifyViaBrowser(candidate, options)
    if (rendered.status !== 'unavailable') return { ...rendered, via: 'browser' }
    const http = await verifyViaHttp(candidate, options)
    return {
      ...http,
      via: 'http',
      browserNote: rendered.evidence || '浏览器不可用',
    }
  }

  const http = await verifyViaHttp(candidate, options)
  const spare = options.budget ? options.budget.spare : 0
  if (http.retryInBrowser && browserReady && options.browserFallback !== false && spare > 0) {
    if (options.budget) options.budget.spare -= 1
    const rendered = await verifyViaBrowser(candidate, options)
    if (rendered.status !== 'unavailable') {
      delete http.retryInBrowser
      return { ...rendered, via: 'browser', httpNote: http.evidence }
    }
  }
  return { ...http, via: 'http' }
}

// ---------------------------------------------------------------------------
// Browser rendering (Edge/Chrome over CDP) for SPA and anti-bot detail pages
// ---------------------------------------------------------------------------

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

function browserExecutable() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

const cdpSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** DevTools endpoint lives on localhost; the environment proxy must not see it. */
function devtoolsCall(port, path, method = 'GET', timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: AGENTS.http }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('devtools http timeout')))
    req.end()
  })
}

async function waitForDevtoolsPort(profileDir, timeoutMs, since = 0) {
  const file = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await cdpSleep(200)
    try {
      // A stale file from a previous launch would hand back a dead port.
      if (since && statSync(file).mtimeMs < since - 1500) continue
      const port = Number(readFileSync(file, 'utf8').split('\n')[0])
      if (port) return port
    } catch {}
  }
  return 0
}

/** Minimal CDP client: request/response plus a helper to evaluate page scripts. */
class DevtoolsConnection {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      const entry = message.id ? this.pending.get(message.id) : null
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`))
      else entry.resolve(message.result)
    }
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`devtools timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async evaluate(expression, timeoutMs = 15000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    )
    if (result.exceptionDetails) throw new Error('页面脚本执行失败')
    return result.result ? result.result.value : undefined
  }

  close() {
    try {
      this.ws.close()
    } catch {}
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('devtools closed'))
    }
    this.pending.clear()
  }
}

const SNAPSHOT_EXPRESSION =
  'JSON.stringify({ url: location.href, title: document.title, ' +
  'html: document.documentElement ? document.documentElement.outerHTML.slice(0, 900000) : "", ' +
  'text: document.body ? document.body.innerText.slice(0, 24000) : "" })'

/** One page at a time: a single tab that scrolls, wiggles the mouse, then reports what it sees. */
class BrowserSession {
  static async launch(options = {}) {
    const executable = browserExecutable()
    if (!executable) throw new Error('未找到 Edge/Chrome 可执行文件')
    if (typeof WebSocket !== 'function') throw new Error('当前 node 不支持 WebSocket')
    const headless = options.headless !== false
    const suppliedDir = typeof options.profileDir === 'string' ? options.profileDir.trim() : ''
    const ephemeral = !suppliedDir
    // A fresh profile per launch: reusing one lets a crashed run leave a browser
    // lock and a stale DevToolsActivePort behind, which fails the next launch.
    const profileDir = suppliedDir || mkdtempSync(join(tmpdir(), 'dsh-job-hunting-'))
    mkdirSync(profileDir, { recursive: true })
    if (suppliedDir) {
      try {
        rmSync(join(profileDir, 'DevToolsActivePort'), { force: true })
      } catch {}
    }
    const startedAt = Date.now()
    const proc = spawn(
      executable,
      [
        headless ? '--headless=new' : '--window-position=-3200,-3200',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--no-proxy-server',
        '--lang=zh-CN',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--window-size=1366,900',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
    const port = await waitForDevtoolsPort(profileDir, 25000, startedAt)
    if (!port) {
      proc.kill()
      if (ephemeral) {
        try {
          rmSync(profileDir, { recursive: true, force: true })
        } catch {}
      }
      throw new Error('浏览器未在 25 秒内启动')
    }
    const session = new BrowserSession(proc, port, { ...options, profileDir, ephemeral })
    const created = await devtoolsCall(port, '/json/new?about:blank', 'PUT')
    const target = JSON.parse(created.body || '{}')
    if (!target.webSocketDebuggerUrl) {
      session.close()
      throw new Error('浏览器没有可用的调试目标')
    }
    session.targetId = target.id
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('无法连接浏览器调试端口'))
    })
    session.cdp = new DevtoolsConnection(ws)
    await session.cdp.send('Page.enable')
    await session.cdp.send('Runtime.enable')
    return session
  }

  constructor(proc, port, options) {
    this.proc = proc
    this.port = port
    this.profileDir = options.profileDir || ''
    this.ephemeral = options.ephemeral === true
    this.cdp = null
    this.targetId = ''
    this.closed = false
    this.queue = Promise.resolve()
    this.timeoutMs = clampInt(options.timeoutMs, DEFAULTS.browserTimeoutMs, 4000, 40000)
  }

  /** One tab means one page at a time; callers queue instead of fighting over the tab. */
  serialize(task) {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  async snapshot() {
    try {
      const raw = await this.cdp.evaluate(SNAPSHOT_EXPRESSION, 8000)
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed.html !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }

  async humanize() {
    for (let step = 0; step < 2; step += 1) {
      const x = 160 + Math.floor(Math.random() * 900)
      const y = 240 + Math.floor(Math.random() * 480)
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => {})
      await this.cdp
        .evaluate(`window.scrollBy(0, ${200 + step * 260 + Math.floor(Math.random() * 140)}); true`, 4000)
        .catch(() => {})
      await cdpSleep(300 + Math.floor(Math.random() * 260))
    }
  }

  async fetchPage(url, options = {}) {
    if (this.closed || !this.cdp) return { ok: false, error: '浏览器已关闭' }
    const signal = options.signal
    if (signal && signal.aborted) return { ok: false, error: 'aborted' }
    const timeoutMs = clampInt(options.timeoutMs, this.timeoutMs, 4000, 40000)
    try {
      await this.cdp.send('Page.navigate', { url }, timeoutMs)
    } catch (error) {
      return { ok: false, error: short(error.message, 60) }
    }
    const deadline = Date.now() + timeoutMs
    let href = ''
    while (Date.now() < deadline) {
      if (signal && signal.aborted) return { ok: false, error: 'aborted' }
      await cdpSleep(220)
      href = await this.cdp
        .evaluate('location.href === "about:blank" ? "" : document.readyState === "complete" ? location.href : ""', 4000)
        .catch(() => '')
      if (href) break
    }
    if (!href) return { ok: false, error: '页面未在超时前加载完成' }

    // Capture before site scripts can wipe the document, then behave like a reader.
    const first = await this.snapshot()
    await cdpSleep(280)
    await this.humanize()
    const second = await this.snapshot()
    const page = second && (!first || second.html.length >= first.html.length) ? second : first
    if (!page) return { ok: false, error: '页面内容无法读取' }
    return { ok: true, ...page }
  }

  close() {
    if (this.closed) return
    this.closed = true
    const id = this.targetId
    if (id) devtoolsCall(this.port, `/json/close/${encodeURIComponent(id)}`).catch(() => {})
    if (this.cdp) this.cdp.close()
    try {
      this.proc.kill()
    } catch {}
    if (this.ephemeral && this.profileDir) {
      setTimeout(() => {
        try {
          rmSync(this.profileDir, { recursive: true, force: true })
        } catch {}
      }, 1500).unref?.()
    }
  }
}

/** Fields recoverable from a rendered page's visible text (SPA sites publish no JSON-LD). */
function jobFromText(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ')
  const salary = /(\d+(?:\.\d+)?\s*[~-]\s*\d+(?:\.\d+)?\s*[Kk千万])(?:\s*[·•]\s*\d+\s*薪)?/.exec(text)
  const experience = /(\d+\s*[-~]\s*\d+\s*年|\d+\s*年以上|应届|经验不限)/.exec(text)
  const education = /(博士|硕士|本科|大专|MBA|学历不限)/.exec(text)
  return {
    salary: salary ? salary[0].replace(/\s+/g, '') : '',
    experience: experience ? experience[0].replace(/\s+/g, '') : '',
    education: education ? education[0] : '',
  }
}

/** "Java全栈工程师-中电（海南）联合创新研究院有限公司-国聘" -> title + company. */
function parseDocTitle(title) {
  const cleaned = String(title || '').replace(SITE_TAIL_RE, '').trim()
  if (!cleaned) return { title: '', company: '' }
  const match = /^(.{2,60}?)\s*[-–—_]\s*(.{2,40}?(?:公司|集团|银行|分行|研究院|事业部|中心|工作室|医院|大学|学校))\s*$/u.exec(
    cleaned,
  )
  if (match) return { title: match[1].trim(), company: match[2].trim() }
  return { title: cleanTitle(cleaned), company: '' }
}

function verdictFromRendered(candidate, page) {
  const hay = `${page.title || ''}\n${page.text || ''}`
  const wall = firstHit(hay, VERIFY_MARKERS)
  if (wall) {
    return { status: 'unverified', evidence: `站点要求人工验证（命中「${wall}」），浏览器无法自动通过`, detail: null }
  }

  const closed = firstHit(page.text || '', CLOSED_MARKERS)
  if (closed) return { status: 'closed', evidence: `页面提示「${closed}」`, detail: null }

  const detail = jobFromHtml(page.html || '')
  const fromTitle = parseDocTitle(page.title)
  if (fromTitle.title) detail.title = fromTitle.title
  if (fromTitle.company) detail.company = fromTitle.company
  const fromText = jobFromText(page.text)
  if (!detail.company) {
    const renderedCompany = companyFromRenderedText(page.text)
    if (renderedCompany) detail.company = renderedCompany
  }
  if (!detail.city) {
    const renderedCity = cityFromRenderedText(page.text)
    if (renderedCity) detail.city = renderedCity
  }
  if (!detail.salary && fromText.salary) detail.salary = fromText.salary
  if (!detail.experience && fromText.experience) detail.experience = fromText.experience
  if (!detail.education && fromText.education) detail.education = fromText.education
  detail.structured = false

  const looksLikePosting =
    detail.title &&
    !NON_JOB_TITLE.test(detail.title) &&
    ((page.text || '').length > 300 || /岗位职责|任职要求|职位描述|工作职责|职位介绍|职位详情/.test(page.text || ''))
  if (looksLikePosting) {
    return { status: 'open', evidence: '浏览器渲染后正文可读（无结构化数据）', detail }
  }
  return { status: 'unverified', evidence: '浏览器渲染后仍无岗位内容', detail: null }
}

async function verifyViaBrowser(candidate, options) {
  const session = options.browser
  if (!session) return { status: 'unavailable' }
  const page = await session.serialize(() =>
    session.fetchPage(candidate.url, {
      timeoutMs: options.browserTimeoutMs,
      signal: options.signal,
    }),
  )
  if (!page.ok) {
    if (page.error === 'aborted') return { status: 'unverified', evidence: '请求被取消', detail: null }
    return { status: 'unavailable', evidence: `浏览器打开失败（${short(page.error, 40)}）` }
  }
  return verdictFromRendered(candidate, page)
}

// ---------------------------------------------------------------------------
// Search + pipeline
// ---------------------------------------------------------------------------

function classifyUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase()
  for (const site of SITES) {
    if (!site.host.test(host)) continue
    const canonical = site.resolve(parsed)
    if (!canonical) return null
    return { site: site.key, sourceName: site.label, url: canonical }
  }
  return null
}

const SITE_NAME = '(?:猎聘|BOSS直聘|智联招聘|前程无忧|国聘网?|58同城|拉勾|脉脉|看准网)'
const SITE_TAIL_RE = new RegExp(`\\s*[-–—|_]\\s*${SITE_NAME}\\s*$`, 'i')

/** Strip the site chrome that search engines glue onto a page <title>. */
function cleanTitle(raw) {
  let title = String(raw || '').replace(/\s+/g, ' ').trim()
  title = title.replace(SITE_TAIL_RE, '')
  const cut = title.indexOf('招聘_')
  if (cut > 0) title = title.slice(0, cut)
  title = title.replace(/\s*[-–—_|]\s*招聘\s*$/i, '')
  title = title.replace(/[\s_|—–-]+$/, '')
  // 51job glues the city onto the head with an unclosed bracket
  // ("【上海-静安区Java开发工程师…"); the city has its own column anyway.
  if (title.startsWith('【') && !title.includes('】')) {
    title = title.slice(1)
    const district = /^[\u4e00-\u9fa5]{2,4}[-–—][\u4e00-\u9fa5]{2,8}(?:新区|区|县|市)/.exec(title)
    if (district) title = title.slice(district[0].length)
  }
  return short(title.trim(), 90)
}

/**
 * 51job / 智联 body text puts the company right before its company type
 * ("大连隆基信息技术有限公司 外资（非欧美） · 150-500人"), so anchor on that marker.
 */
const RENDERED_COMPANY_RE =
  /([\u4e00-\u9fa5A-Za-z0-9（）()·&.\-]{2,40}?(?:有限公司|有限责任公司|股份有限公司|集团有限公司|集团公司|研究院|银行|分行))\s+(?:外资|民营|国企|合资|外商独资|上市公司|股份制|非营利|事业单位|其它|其他)/

function companyFromRenderedText(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ')
  const hit = RENDERED_COMPANY_RE.exec(text)
  return hit ? short(hit[1].trim(), 80) : ''
}

/** Recover the hiring company from "…_<company>招聘 - 智联招聘" style page titles. */
function companyFromSearchTitle(raw) {
  const text = String(raw || '')
  const patterns = [
    /[_|—–-]\s*([^_|—–-]{2,40}?(?:公司|集团|银行|分行|研究院|事业部|中心|工作室))\s*招聘/,
    /_([^_]{2,40}?)招聘(?:\s*[-–—|_]|$)/,
  ]
  for (const re of patterns) {
    const match = re.exec(text)
    if (match) return short(match[1].trim(), 80)
  }
  return ''
}

/**
 * Best-effort city from a page without JobPosting JSON-LD. Only structured keys
 * are trusted: neighbouring "recommended job" blocks also carry their own city,
 * so a single consistent value is required before believing one.
 */
function cityFromHtml(html) {
  const values = new Set()
  const patterns = [/"addressLocality"\s*:\s*"([^"]{2,20})"/g, /"cityName"\s*:\s*"([^"]{2,20})"/g]
  for (const re of patterns) {
    for (const match of html.matchAll(re)) {
      const known = detectCity(match[1])
      const bare = String(match[1]).replace(/(?:市|地区|特别行政区)$/, '')
      const city = known || (/^[\u4e00-\u9fa5]{2,6}$/.test(bare) ? bare : '')
      if (city) values.add(city)
    }
  }
  return values.size === 1 ? [...values][0] : ''
}

function guessMeta(candidate) {
  const title = short(candidate.searchTitle, 140)
  const snippet = String(candidate.snippet || '')
  const salary = /(\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*[Kk千万]\s*(?:·\s*\d+薪)?)/.exec(
    `${title} ${snippet}`,
  )?.[1]
  const cleaned = cleanTitle(title)
  const city = detectCity(`${title} ${snippet}`)
  return {
    title: cleaned || title || '（标题缺失）',
    company: '',
    city,
    salary: salary ? salary.replace(/\s+/g, '') : '',
    experience: '',
    education: '',
    description: snippet,
    publishedAt: candidate.publishedAt ? parseDate(candidate.publishedAt) : null,
    validThrough: null,
    industry: '',
  }
}

function buildJob(candidate, verification) {
  const meta = guessMeta(candidate)
  const detail = verification.detail
  // Search engines often carry the real company in the title while the detail
  // page's own "公司：" scrape picks up an unrelated neighbouring block.
  const fromTitle = companyFromSearchTitle(candidate.searchTitle)
  const detailCompany = (detail?.company || '').trim()
  const company =
    (fromTitle && (detail?.structured === false || !detailCompany) ? fromTitle : '') ||
    detailCompany ||
    meta.company ||
    ''
  const job = {
    title: cleanTitle(detail?.title || meta.title || ''),
    company: company.trim(),
    city: (detail?.city || cityFromUrl(candidate.url) || meta.city || cityFromSearchTitle(candidate.searchTitle) || '').trim(),
    salary: (detail?.salary || meta.salary || '').trim(),
    experience: (detail?.experience || meta.experience || '').trim(),
    education: (detail?.education || meta.education || '').trim(),
    description: (detail?.description || meta.description || '').trim(),
    published: detail?.publishedAt || meta.publishedAt || null,
    url: candidate.url,
    siteKey: candidate.site,
    sourceName: candidate.sourceName,
    status: verification.status,
    evidence: verification.evidence,
  }
  job.publishedAt = isoDay(job.published)
  job.ageDays = ageInDays(job.published)
  job.spam = firstHit(`${job.title} ${job.description.slice(0, 400)}`, FRAUD_MARKERS)
  job.reasons = []
  job.score = 0
  return job
}

const TOKEN_RE_CACHE = new Map()
function tokenRegex(token) {
  let re = TOKEN_RE_CACHE.get(token)
  if (!re) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i')
    TOKEN_RE_CACHE.set(token, re)
  }
  return re
}

function tokenHits(text, tokens) {
  const source = String(text || '')
  const hits = []
  for (const token of tokens) {
    if (!token) continue
    const matched = /^[\x20-\x7e]+$/.test(token)
      ? tokenRegex(token).test(source)
      : source.includes(token)
    if (matched) hits.push(token)
  }
  return hits
}

/** Turn a search phrase like "Java后端" into tokens that can actually match titles. */
function keywordTokens(keyword) {
  const parts = String(keyword || '')
    .split(/[\s/、,，;；|]+/)
    .filter(Boolean)
  const tokens = new Set(parts)
  for (const part of parts) {
    const pieces = part.split(
      /(?<=[A-Za-z0-9+#.])(?=[\u4e00-\u9fa5])|(?<=[\u4e00-\u9fa5])(?=[A-Za-z0-9+#.])/,
    )
    for (const piece of pieces) if (piece.length > 1) tokens.add(piece)
  }
  for (const skill of tokenHits(keyword, RECOMMEND_SKILLS)) tokens.add(skill)
  for (const role of ROLE_HINTS) if (String(keyword).includes(role[0])) tokens.add(role[0])
  return [...tokens].slice(0, 10)
}

function scoreJob(job, spec) {
  const reasons = []
  let score = 0
  const haystack = `${job.title} ${job.company} ${job.description}`

  const hits = tokenHits(haystack, spec.tokens)
  if (hits.length) {
    score += Math.min(45, 10 + hits.length * 9)
    reasons.push(
      spec.mode === 'search'
        ? `命中关键词 ${hits.slice(0, 5).join('、')}`
        : `命中 ${hits.slice(0, 5).join('、')}`,
    )
  } else if (spec.tokens.length) {
    reasons.push(
      spec.mode === 'search'
        ? `标题与摘要未含关键词「${spec.keyword}」`
        : '未命中简历关键词',
    )
  }

  if (spec.resumeSkills && spec.resumeSkills.length) {
    const matched = spec.resumeSkills.filter((skill) => tokenHits(haystack, [skill]).length > 0)
    if (matched.length) {
      score += Math.min(14, 3 + matched.length * 3)
      reasons.push(`简历技能对得上 ${matched.slice(0, 4).join('、')}`)
    }
  }

  if (spec.city) {
    if (!job.city) {
      score -= 8
      reasons.push('城市未标注，需自行确认')
    } else if (cityMatches(job.city, spec.city)) {
      score += 22
      reasons.push(`工作地点 ${job.city} 与期望一致`)
    } else {
      score -= 30
      reasons.push(`工作地点 ${job.city} 与期望不符`)
    }
  }

  if (spec.years !== null && spec.years !== undefined && job.experience) {
    const need = parseYears(job.experience)
    if (need !== null) {
      if (Math.abs(need - spec.years) <= 1) {
        score += 12
        reasons.push(`经验匹配（要求 ${job.experience}，你约 ${spec.years} 年）`)
      } else if (need > spec.years + 2) {
        score -= 12
        reasons.push(`经验要求偏高（${job.experience}）`)
      }
    }
  }

  if (spec.mode === 'search' && spec.experienceMax !== null && spec.experienceMax !== undefined && job.experience) {
    const need = parseYears(job.experience)
    if (need !== null && need > spec.experienceMax + 1) {
      score -= 26
      reasons.push(`经验要求 ${job.experience}，高于你说的「${spec.experience}」`)
    }
  }

  if (job.status === 'open') {
    score += 12
    reasons.push(`已核实仍在招聘（${job.evidence}）`)
  } else if (job.status === 'closed') {
    score -= 100
  } else {
    reasons.push(`在招状态未核实：${job.evidence}`)
  }

  if (job.ageDays !== null) {
    if (job.ageDays <= 0) {
      score += 10
      reasons.push('今天发布')
    } else if (job.ageDays <= 3) {
      score += 10
      reasons.push(`近 ${job.ageDays} 天发布`)
    } else if (job.ageDays <= 7) score += 6
    else if (job.ageDays <= 30) score += 2
    else score -= 25
  }

  if (spec.expectedSalary) {
    const want = salaryRange(spec.expectedSalary)
    const has = salaryRange(job.salary)
    if (want && has) {
      const overlap = Math.min(want[1], has[1]) - Math.max(want[0], has[0])
      if (overlap >= 0) {
        score += 10
        reasons.push(`薪资区间与期望重叠（${job.salary}）`)
      } else {
        score -= 10
        reasons.push(`薪资低于期望（岗位 ${job.salary}）`)
      }
    }
  }

  if (!job.company) {
    score -= 15
    reasons.push('缺少公司名称')
  }
  if (/人力资源服务|劳务派遣|劳务外包|人才服务|猎头/.test(job.company)) {
    score -= 10
    reasons.push('招聘方为人力/外包机构，需确认实际用工单位')
  }
  if (job.spam) {
    score -= 60
    reasons.push(`疑似低质/虚假招聘（命中「${job.spam}」）`)
  }

  job.score = Math.round(score)
  job.reasons = reasons
  return job
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

async function runSearch(ctx, query, signal, maxResults) {
  try {
    const result = await ctx.web.search({ query, maxResults }, signal)
    return { sources: Array.isArray(result?.sources) ? result.sources : [], error: null }
  } catch (error) {
    return { sources: [], error: errText(error) }
  }
}

async function collectCandidates(ctx, spec, signal, notes) {
  const candidates = []
  const seen = new Set()
  const sites = SITES.filter((site) => spec.sites.includes(site.key))

  const absorb = (sources, onlySite) => {
    for (const source of sources) {
      const url = source?.url
      if (!url) continue
      const info = classifyUrl(url)
      if (!info) continue
      if (onlySite && info.site !== onlySite) continue
      if (!spec.sites.includes(info.site)) continue
      if (seen.has(info.url)) continue
      seen.add(info.url)
      candidates.push({
        site: info.site,
        sourceName: info.sourceName,
        url: info.url,
        searchTitle: short(source.title || '', 160),
        snippet: short(source.snippet || '', 300),
        publishedAt: source.publishedAt || null,
      })
    }
  }

  const results = await Promise.all(
    sites.map(async (site) => {
      const query = site.query(spec.keyword, spec.city, spec.experience)
      const outcome = await runSearch(ctx, query, signal, spec.perSiteLimit)
      return { site, query, outcome }
    }),
  )

  for (const { site, query, outcome } of results) {
    if (outcome.error) notes.push(`搜索失败（${site.label}）：${outcome.error}`)
    else if (outcome.sources.length === 0) notes.push(`搜索无结果（${site.label}）：${short(query, 80)}`)
    absorb(outcome.sources, site.key)
  }

  if (candidates.length === 0) {
    const fallback = `${spec.keyword} ${spec.city || ''} ${spec.experience || ''} 招聘 岗位`.replace(/\s+/g, ' ').trim()
    const outcome = await runSearch(ctx, fallback, signal, Math.min(20, spec.perSiteLimit * 3))
    if (outcome.error) notes.push(`补充搜索失败：${outcome.error}`)
    absorb(outcome.sources, null)
    if (candidates.length) notes.push(`按站点检索无结果，已改用通用检索：${short(fallback, 80)}`)
  }

  return candidates
}

async function runPipeline(ctx, spec, signal) {
  const notes = []
  const candidates = await collectCandidates(ctx, spec, signal, notes)

  if (candidates.length === 0) {
    return {
      query: spec.keyword,
      city: spec.city || '',
      mode: spec.mode,
      total: 0,
      jobs: [],
      scanned: 0,
      verifiedCount: 0,
      closedCount: 0,
      dropped: 0,
      notes: [...notes, '未从招聘网站检索到可识别的岗位详情页链接。'],
    }
  }

  const head = candidates.slice(0, spec.verifyLimit)
  const tail = candidates.slice(spec.verifyLimit)

  let browser = null
  let browserError = ''
  if (spec.browserEnabled) {
    try {
      browser = await BrowserSession.launch({
        headless: spec.browserHeadless,
        timeoutMs: spec.browserTimeoutMs,
      })
    } catch (error) {
      browserError = short(error.message || String(error), 80)
      notes.push(`浏览器核实不可用（${browserError}），本次仅用 HTTP 请求核实。`)
    }
  }

  const browserUrls = new Set(
    head
      .filter((candidate) => (spec.browserSites || []).includes(candidate.site))
      .slice(0, spec.browserLimit)
      .map((candidate) => candidate.url),
  )

  const verifyOptions = {
    timeoutMs: spec.timeoutMs,
    signal,
    browser,
    browserUrls,
    budget: { spare: Math.max(0, spec.browserLimit - browserUrls.size) },
    browserFallback: spec.browserFallback,
    browserTimeoutMs: spec.browserTimeoutMs,
  }

  let verifications
  try {
    verifications = await mapLimit(head, spec.concurrency, (candidate) =>
      verifyCandidate(candidate, verifyOptions),
    )
  } finally {
    if (browser) browser.close()
  }
  for (const candidate of tail) {
    verifications.push({ status: 'unverified', evidence: '超出本次核实数量上限', detail: null })
  }

  if (browser && browserError === '') {
    const viaBrowser = verifications.filter((entry) => entry.via === 'browser')
    const readable = viaBrowser.filter((entry) => entry.status !== 'unverified')
    const walls = viaBrowser.length - readable.length
    if (viaBrowser.length) {
      notes.push(
        `浏览器渲染核实 ${viaBrowser.length} 条：${readable.length} 条读到真实页面，` +
          `${walls} 条被站点验证墙拦下。`,
      )
    }
  }

  const built = await mapLimit(head, spec.concurrency, (candidate, index) =>
    buildJob(candidate, verifications[index]),
  )
  for (let index = 0; index < tail.length; index += 1) {
    built.push(buildJob(tail[index], verifications[head.length + index]))
  }

  let closed = 0
  let spam = 0
  let stale = 0
  let offCity = 0
  let notPosting = 0
  let unverifiedDropped = 0
  let overExp = 0
  let sparse = 0
  const kept = []

  for (const job of built) {
    if (!job.title || NON_JOB_TITLE.test(job.title)) {
      notPosting += 1
      continue
    }
    if (job.status === 'closed') {
      closed += 1
      continue
    }
    if (job.spam) {
      spam += 1
      continue
    }
    if (job.ageDays !== null && job.ageDays > spec.freshnessDays) {
      stale += 1
      continue
    }
    if (spec.city && !cityMatches(job.city, spec.city)) {
      offCity += 1
      continue
    }
    if (spec.mode === 'search' && spec.experienceMax !== null && spec.experienceMax !== undefined && job.experience) {
      const need = parseYears(job.experience)
      if (need !== null && need > spec.experienceMax + 1) {
        overExp += 1
        continue
      }
    }
    if (job.status === 'unverified' && (!spec.includeUnverified || spec.verifiedOnly)) {
      unverifiedDropped += 1
      continue
    }
    if (
      job.status === 'unverified' &&
      !job.company &&
      !job.salary &&
      !job.city &&
      !job.publishedAt
    ) {
      sparse += 1
      continue
    }
    kept.push(job)
  }

  // Cross-site duplicate: same posting id, or same title + company. Some sites
  // expose the same posting under both www and mobile hosts, so the numeric id
  // from the URL is the most reliable key when it exists.
  const jobIdFromUrl = (raw) => {
    try {
      const path = new URL(raw).pathname
      const segments = path.split('/').filter(Boolean).reverse()
      for (const segment of segments) {
        const match = segment.match(/(\d{6,})/)
        if (match) return match[1]
      }
    } catch {
      /* ignore malformed URLs */
    }
    return ''
  }
  const unique = []
  const keys = new Set()
  for (const job of kept) {
    const id = jobIdFromUrl(job.url)
    const key = id
      ? `id:${id}`
      : `${job.title.toLowerCase()}|${job.company.toLowerCase()}|${job.city.toLowerCase()}`
    if (keys.has(key)) continue
    keys.add(key)
    unique.push(job)
  }

  for (const job of unique) scoreJob(job, spec)

  unique.sort((a, b) => {
    const rank = (job) => (job.status === 'open' ? 0 : 1)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (b.score !== a.score) return b.score - a.score
    const age = (value) => (value.ageDays === null ? 9999 : value.ageDays)
    return age(a) - age(b)
  })

  const verifiedJobs = unique.filter((job) => job.status === 'open')
  const unverifiedJobs = unique.filter((job) => job.status !== 'open')
  const selected = verifiedJobs.slice(0, spec.maxResults)
  if (!spec.verifiedOnly && spec.includeUnverified && selected.length < spec.maxResults) {
    const room = spec.maxResults - selected.length
    selected.push(...unverifiedJobs.slice(0, Math.min(spec.unverifiedCap, room)))
  }

  const jobs = selected.map((job) => ({
    title: job.title,
    company: job.company,
    city: job.city,
    salary: job.salary,
    experience: job.experience,
    education: job.education,
    publishedAt: job.publishedAt,
    ageDays: job.ageDays,
    url: job.url,
    source: job.sourceName,
    site: job.siteKey,
    status: job.status,
    evidence: job.evidence,
    score: job.score,
    reasons: job.reasons.slice(0, 5),
  }))

  const filtered = []
  if (closed) filtered.push(`已关闭/下架 ${closed} 条`)
  if (spam) filtered.push(`疑似虚假或低质 ${spam} 条`)
  if (stale) filtered.push(`超过 ${spec.freshnessDays} 天 ${stale} 条`)
  if (offCity && spec.city) filtered.push(`工作地点不符 ${offCity} 条`)
  if (overExp) filtered.push(`经验要求高于「${spec.experience}」 ${overExp} 条`)
  if (notPosting) filtered.push(`非岗位页 ${notPosting} 条`)
  if (unverifiedDropped) filtered.push(`未核实被排除 ${unverifiedDropped} 条`)
  if (sparse) filtered.push(`信息不足 ${sparse} 条`)
  const filteredCount = closed + spam + stale + offCity + notPosting + unverifiedDropped + sparse + overExp
  const deduped = kept.length - unique.length
  const unverified = jobs.filter((job) => job.status === 'unverified')
  const parts = [`候选详情页 ${built.length} 条`]
  if (filteredCount) parts.push(`过滤 ${filteredCount} 条（${filtered.join('；')}）`)
  if (deduped) parts.push(`跨站去重 ${deduped} 条`)
  parts.push(`展示 ${jobs.length} 条`)
  notes.push(`${parts.join('，')}。`)
  if (unverified.length > 0) {
    notes.push(
      `其中 ${unverified.length} 条因站点反爬或信息不足无法核实，已标注「未核实」；` +
        `未核实条目只在已核实结果不足时补位，最多 ${spec.unverifiedCap} 条。`,
    )
  }
  if (spec.verifiedOnly) notes.push('本次只保留已在详情页核实仍在招聘的岗位（verifiedOnly）。')

  return {
    query: spec.keyword,
    city: spec.city || '',
    mode: spec.mode,
    total: jobs.length,
    jobs,
    scanned: built.length,
    verifiedCount: jobs.filter((job) => job.status === 'open').length,
    closedCount: closed,
    dropped: filteredCount,
    notes: notes.slice(0, 12),
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_LABEL = { open: '在招·已核实', unverified: '未核实', closed: '已关闭' }

const cell = (value, fallback = '—') => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text ? text.replace(/\|/g, '\\|') : fallback
}

function renderResult(args, value) {
  const lines = []
  const heading = value.mode === 'recommend' ? '岗位推荐' : '招聘信息搜集'
  lines.push(`**${heading}**：${value.query}${value.city ? ` · ${value.city}` : ''}`)
  lines.push('')
  if (value.resume && value.resume.summary) {
    lines.push(`> 按简历匹配：${cell(value.resume.summary)}`)
    lines.push('')
  }

  if (!value.jobs || value.jobs.length === 0) {
    lines.push('未找到符合条件且可用的岗位。')
  } else {
    lines.push('| # | 岗位名称 | 公司 | 城市 | 薪资 | 经验 | 发布时间 | 信息来源（状态） | 链接 |')
    lines.push('|---|---|---|---|---|---|---|---|---|')
    value.jobs.forEach((job, index) => {
      const ageText =
        job.ageDays === null ? '' : job.ageDays <= 0 ? '（今天）' : `（${job.ageDays} 天前）`
      const published = job.publishedAt ? `${job.publishedAt}${ageText}` : '未标注'
      const source = `${job.source}（${STATUS_LABEL[job.status] || job.status}）`
      lines.push(
        `| ${index + 1} | ${cell(job.title)} | ${cell(job.company)} | ${cell(job.city)} | ${cell(job.salary)} | ${cell(job.experience)} | ${cell(published)} | ${cell(source)} | [查看](${job.url}) |`,
      )
    })
    lines.push('')
    lines.push('**匹配理由**')
    value.jobs.forEach((job, index) => {
      const why = job.reasons.length ? job.reasons.join('；') : '综合匹配'
      lines.push(`${index + 1}. ${cell(job.title)} — ${why}`)
    })
  }

  const notes = (value.notes || []).filter(Boolean)
  if (notes.length) {
    lines.push('')
    lines.push('**说明**')
    for (const note of notes) lines.push(`- ${note}`)
  }

  lines.push('')
  lines.push(
    `> 共 ${value.total} 条结果；核实依据：优先用浏览器渲染详情页，必要时回退 HTTP 抓取（JobPosting 结构化数据 / 正文）；被站点验证墙拦下、无法核实的条目已标注「未核实」。`,
  )

  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------
// Career planning
// ---------------------------------------------------------------------------

/** Pull K/月 ranges out of free text (search snippets, titles). */
function salaryBandIn(text) {
  const hay = String(text || '')
  const bands = []
  const monthK = /(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)\s*[Kk千]/g
  const yearWan = /(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)\s*万\s*(?:\/|每)?\s*年/g
  let match
  while ((match = monthK.exec(hay))) bands.push([Number(match[1]), Number(match[2])])
  while ((match = yearWan.exec(hay))) {
    bands.push([Math.round(Number(match[1]) * 10 / 12 * 10) / 10, Math.round(Number(match[2]) * 10 / 12 * 10) / 10])
  }
  if (!bands.length) return null
  const min = Math.min(...bands.map((band) => band[0]))
  const max = Math.max(...bands.map((band) => band[1]))
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0) return null
  return { min, max }
}

/**
 * Optional market evidence for the recommended directions. Uses the host search
 * provider only (no detail-page fetches), so it costs one query per direction.
 */
async function marketSnapshot(ctx, profile, roles, signal, notes) {
  if (!roles.length) return null
  if (!ctx.web || typeof ctx.web.search !== 'function') {
    notes.push('当前部署没有可用的 web 搜索提供者，市场参考未取。')
    return null
  }
  const out = []
  for (const role of roles) {
    const place = profile.city ? `${profile.city} ` : ''
    const query = `${place}${role.career.name} 招聘 薪资`
    try {
      const result = await ctx.web.search({ query, maxResults: 6 }, signal)
      const sources = Array.isArray(result?.sources) ? result.sources : []
      const texts = sources.map((item) => `${item.title || ''} ${item.snippet || ''}`)
      const localTexts = profile.city
        ? texts.filter((text) => text.includes(String(profile.city).replace(/市$/, '')))
        : []
      const localHay = [localTexts.join('\n'), String(result?.content || '')].filter(Boolean).join('\n')
      const allHay = [String(result?.content || ''), ...texts].join('\n')
      const localBand = localTexts.length ? salaryBandIn(localHay) : null
      let band = localBand || salaryBandIn(allHay)
      let note = '摘要未含薪资信息'
      if (band) {
        note = localBand
          ? `本地样本 ${localTexts.length} 条，来自公开搜索摘要，未逐条核实`
          : `本地样本不足，取全国/周边区间（${sources.length} 条，未逐条核实）`
      }
      // Search snippets happily mix in 外地/大厂 postings; a band far above the
      // local knowledge-base range would mislead, so drop it and say why.
      const salary = role.career.salary || {}
      const expected = salary[profile.cityTier] || salary['二线'] || null
      if (band && expected && (band.min > expected[1] * 1.5 || band.max > expected[1] * 3)) {
        note = `搜索摘要薪资 ${band.min}–${band.max}K 明显高于本地常见区间（${expected[0]}–${expected[1]}K），可能是外地/大厂岗位，未采用`
        band = null
      }
      out.push({
        role: role.career.name,
        samples: localTexts.length || sources.length,
        local: localTexts.length,
        min: band ? band.min : 0,
        max: band ? band.max : 0,
        note,
      })
    } catch (error) {
      out.push({ role: role.career.name, samples: 0, min: 0, max: 0, note: `检索失败：${errText(error)}` })
    }
  }
  const totalSamples = out.reduce((sum, item) => sum + item.samples, 0)
  notes.push(`市场参考：按 ${out.length} 个方向各检索一次，共 ${totalSamples} 条公开搜索结果（未逐条核实）。`)
  return { roles: out }
}

/** Minimal Markdown → HTML for the saved report (headings, tables, lists, bold). */
function inlineHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function mdToHtml(markdown) {
  const lines = String(markdown || '').split(/\r?\n/)
  const out = []
  let list = null
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd()
    if (!line.trim()) {
      closeList()
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`)
      continue
    }
    if (/^-{3,}$/.test(line.trim())) {
      closeList()
      out.push('<hr>')
      continue
    }
    if (/^\|/.test(line.trim())) {
      closeList()
      const rows = []
      let j = i
      while (j < lines.length && /^\|/.test(lines[j].trim())) {
        rows.push(lines[j].trim())
        j += 1
      }
      i = j - 1
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((item) => item.trim())
      const body = rows.filter((row) => !/^\|?[\s:|-]+\|?$/.test(row))
      if (body.length) {
        out.push('<table><thead><tr>' + cells(body[0]).map((cell) => `<th>${inlineHtml(cell)}</th>`).join('') + '</tr></thead><tbody>')
        for (const row of body.slice(1)) {
          out.push('<tr>' + cells(row).map((cell) => `<td>${inlineHtml(cell)}</td>`).join('') + '</tr>')
        }
        out.push('</tbody></table>')
      }
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line.trim())
    if (bullet) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inlineHtml(bullet[1])}</li>`)
      continue
    }
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line.trim())
    if (numbered) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inlineHtml(numbered[2])}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inlineHtml(line.trim())}</p>`)
  }
  closeList()
  return out.join('\n')
}

/** Save the report next to the session working directory as Markdown + a styled HTML file. */
function writeReportFiles(markdown, options = {}) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const dir = options.reportDir || process.cwd()
  mkdirSync(dir, { recursive: true })
  const mdPath = join(dir, `career-plan-${stamp}.md`)
  const htmlPath = join(dir, `career-plan-${stamp}.html`)
  const docxPath = join(dir, `career-plan-${stamp}.docx`)
  writeFileSync(mdPath, markdown, 'utf8')
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>职业规划报告</title>
<style>body{font-family:"Microsoft YaHei",system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 16px;line-height:1.7;color:#1f2328}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f6f8fa}h1{border-bottom:1px solid #d0d7de;padding-bottom:8px}h2{margin-top:28px}code{background:#f6f8fa;padding:1px 4px;border-radius:4px}</style>
</head><body>
${mdToHtml(markdown)}
</body></html>
`
  writeFileSync(htmlPath, html, 'utf8')
  writeFileSync(docxPath, markdownToDocx(markdown))
  return { mdPath, htmlPath, docxPath }
}

function careerValue(profile, assessment, recommendations, market, notes = []) {
  const value = {
    report: '',
    profile: {
      years: profile.years === null ? -1 : profile.years,
      education: profile.education.label || '',
      city: profile.city || '',
      cityTier: profile.cityTier,
      skills: profile.skills.slice(0, 12),
      targetRole: profile.targetRaw || '',
      missing: profile.missing,
    },
    recommendations: recommendations.map((entry) => ({
      name: entry.career.name,
      position: entry.position || '',
      score: entry.score,
      bucket: entry.bucket,
      reasons: entry.reasons,
      salary: entry.salary.text,
      ladder: entry.career.ladder,
      missing: entry.missing.slice(0, 5),
    })),
  }
  if (assessment) {
    value.target = {
      role: assessment.career.name,
      score: assessment.score,
      verdict: assessment.verdict,
      matched: assessment.matched,
      missing: assessment.missing.slice(0, 6),
    }
  }
  value.report = buildReport(profile, assessment, recommendations, { market, notes })
  return value
}

function renderCareer(args, value) {
  const parts = [{ type: 'text', text: value.report }]
  if (value.reportPath) {
    parts.push({
      type: 'text',
      text: `\n\n---\n\n报告已保存为文件：\n\n- Word：\`${value.docxPath}\`\n- Markdown：\`${value.reportPath}\`\n- HTML：\`${value.htmlPath}\``,
    })
  }
  return parts
}

function renderInterview(args, value) {
  const lines = ['**画像访谈**：请逐条回答下面这些问题（可以直接编号回答）', '']
  value.questions.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.question}`)
    lines.push(`   - 为什么问：${item.why}`)
  })
  if (!value.complete) {
    lines.push('')
    lines.push('> 回答完这一轮后再次调用 `career_interview`（把回答并入 background），我会继续追问缺的部分；信息齐了再生成报告。')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const JOB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: '岗位名称' },
    company: { type: 'string', description: '公司名称' },
    city: { type: 'string', description: '工作城市' },
    salary: { type: 'string', description: '薪资文本' },
    experience: { type: 'string', description: '经验要求' },
    education: { type: 'string', description: '学历要求' },
    publishedAt: { type: 'string', description: '发布日期 YYYY-MM-DD，未知为空串' },
    ageDays: { type: 'integer', description: '距今发布天数，未知为 -1' },
    url: { type: 'string', description: '招聘信息链接' },
    source: { type: 'string', description: '信息来源站点' },
    site: { type: 'string', description: '站点标识' },
    status: { type: 'string', enum: ['open', 'unverified', 'closed'], description: '在招状态核实结果' },
    evidence: { type: 'string', description: '核实依据' },
    score: { type: 'integer', description: '匹配分' },
    reasons: { type: 'array', items: { type: 'string' }, description: '匹配理由' },
  },
  required: [
    'title',
    'company',
    'city',
    'salary',
    'experience',
    'education',
    'publishedAt',
    'ageDays',
    'url',
    'source',
    'site',
    'status',
    'evidence',
    'score',
    'reasons',
  ],
}

// `ageDays` is nullable in the value; avoid a schema mismatch by never emitting null.
const normalizeJobForOutput = (job) => ({
  ...job,
  ageDays: job.ageDays === null || job.ageDays === undefined ? -1 : job.ageDays,
})

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: '检索关键词' },
    city: { type: 'string', description: '检索城市' },
    mode: { type: 'string', enum: ['search', 'recommend'], description: '工具模式' },
    total: { type: 'integer', description: '返回条数' },
    scanned: { type: 'integer', description: '处理的候选详情页数' },
    verifiedCount: { type: 'integer', description: '核实仍在招聘的条数' },
    closedCount: { type: 'integer', description: '已关闭条数' },
    dropped: { type: 'integer', description: '被过滤条数' },
    jobs: { type: 'array', items: JOB_SCHEMA, description: '岗位列表' },
    resume: {
      type: 'object',
      additionalProperties: false,
      description: '从简历解析出的信息（仅当传了 resumePath）',
      properties: {
        path: { type: 'string' },
        kind: { type: 'string' },
        summary: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' } },
        years: { type: 'number', description: '工作年限，-1 表示未知' },
        education: { type: 'string' },
        city: { type: 'string' },
      },
      required: ['path', 'kind', 'summary', 'skills', 'years', 'education', 'city'],
    },
    notes: { type: 'array', items: { type: 'string' }, description: '检索与过滤说明' },
  },
  required: ['query', 'city', 'mode', 'total', 'scanned', 'verifiedCount', 'closedCount', 'dropped', 'jobs', 'notes'],
}

const RECOMMENDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: '职业方向名称' },
    position: { type: 'string', description: '定位：目标方向 / 转型方向 / 保底方向 / 主推方向 / 长期方向' },
    score: { type: 'integer', description: '匹配度 0–100' },
    bucket: { type: 'string', description: '结论：稳妥可投 / 可转型 / 长期目标 / 暂不推荐' },
    reasons: { type: 'array', items: { type: 'string' }, description: '为什么适合' },
    salary: { type: 'string', description: '本地起薪参考' },
    ladder: { type: 'array', items: { type: 'string' }, description: '晋升阶梯' },
    missing: { type: 'array', items: { type: 'string' }, description: '需要补齐的能力' },
  },
  required: ['name', 'position', 'score', 'bucket', 'reasons', 'salary', 'ladder', 'missing'],
}

const CAREER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    report: { type: 'string', description: 'Markdown 职业规划报告' },
    reportPath: { type: 'string', description: '报告 Markdown 文件的绝对路径（写入失败时为空字符串）' },
    htmlPath: { type: 'string', description: '报告 HTML 文件的绝对路径，可直接用 Word 或浏览器打开（写入失败时为空字符串）' },
    docxPath: { type: 'string', description: '报告 Word（.docx）文件的绝对路径（写入失败时为空字符串）' },
    profile: {
      type: 'object',
      additionalProperties: false,
      properties: {
        years: { type: 'number', description: '工作年限，未知为 -1' },
        education: { type: 'string', description: '学历' },
        city: { type: 'string', description: '城市' },
        cityTier: { type: 'string', description: '城市等级' },
        skills: { type: 'array', items: { type: 'string' }, description: '识别到的技能' },
        targetRole: { type: 'string', description: '目标岗位，未指定为空串' },
        missing: { type: 'array', items: { type: 'string' }, description: '仍缺的信息' },
      },
      required: ['years', 'education', 'city', 'cityTier', 'skills', 'targetRole', 'missing'],
    },
    target: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', description: '目标岗位名' },
        score: { type: 'integer', description: '适配度' },
        verdict: { type: 'string', description: '结论' },
        matched: { type: 'array', items: { type: 'string' }, description: '匹配点' },
        missing: { type: 'array', items: { type: 'string' }, description: '主要缺口' },
      },
      required: ['role', 'score', 'verdict', 'matched', 'missing'],
    },
    recommendations: { type: 'array', items: RECOMMENDATION_SCHEMA, description: '推荐方向' },
  },
  required: ['report', 'reportPath', 'htmlPath', 'docxPath', 'profile', 'recommendations'],
}

const INTERVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '问题 id' },
          question: { type: 'string', description: '要问用户的问题' },
          why: { type: 'string', description: '为什么问' },
        },
        required: ['id', 'question', 'why'],
      },
      description: '本轮要问的问题，最后一条固定为「还有什么要补充的吗」',
    },
    complete: { type: 'boolean', description: '画像信息是否已足够' },
  },
  required: ['questions', 'complete'],
}

const SEARCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    keyword: {
      type: 'string',
      description: '职位关键词，例如「Java后端」「产品经理」「数据分析」，可包含多个词。',
    },
    city: { type: 'string', description: '工作城市，例如「上海」「北京」。' },
    experience: { type: 'string', description: '工作经验要求，例如「3年」「应届」「5-10年」。' },
    resumePath: {
      type: 'string',
      description:
        '简历文件的绝对路径（.docx / .pdf / .txt / .md）。给了之后会从简历里读出技能、年限、学历和城市，' +
        '参与岗位匹配打分并写进说明；keyword 仍可单独给，缺省时用简历里的技能与岗位线索检索。',
    },
    maxResults: { type: 'integer', description: '最多返回条数，默认 10，上限 30。' },
    freshnessDays: { type: 'integer', description: '只要多少天内发布/更新的岗位，默认 7，最大 180。' },
    verifiedOnly: {
      type: 'boolean',
      description: '为 true 时只返回已在详情页核实仍在招聘的岗位；默认 false，未核实条目只在已核实不足时补位（最多 2 条）。',
    },
  },
  required: [],
}

const CAREER_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    background: {
      type: 'string',
      description:
        '求职者画像的完整文字描述：做过哪些工作、各多久、专业与学历、会的技能/工具、想去的岗位、所在或期望城市、薪资期望、硬性限制（夜班/出差/体力/家庭）、可投入学习时间。把访谈里得到的答案都并进来。',
    },
    city: { type: 'string', description: '所在或期望工作城市；缺省时从 background 中识别。' },
    targetRole: { type: 'string', description: '目标岗位，例如「前端开发工程师」；缺省表示用户还没有目标，只做方向推荐。' },
    expectedSalary: { type: 'string', description: '薪资期望，例如「6K」「8-12K」；用于判断转行期的收入落差。' },
    education: { type: 'string', description: '学历，例如「大专」「本科」；缺省时从 background 中识别。' },
    years: { type: 'number', description: '累计工作年限，可写小数（1.5）；缺省时从 background 中识别。' },
    market: {
      type: 'string',
      enum: ['off', 'quick'],
      description:
        '是否补一份本地岗位市场样本：quick（默认，只用公开搜索结果，不逐条核实，约 10 秒）或 off（不联网）。',
    },
    maxRecommendations: { type: 'integer', description: '推荐方向数量，默认 4，上限 6。' },
  },
  required: ['background'],
}

const INTERVIEW_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    background: { type: 'string', description: '目前已知的信息（用户原话或已答内容），可留空。' },
    answered: {
      type: 'array',
      description: '已经问过并收到回答的问题 id，用来避免重复提问。',
      items: { type: 'string' },
    },
  },
  required: [],
}

const RECOMMEND_SKILLS = [
  'Java', 'Python', 'Go', 'C++', 'C#', 'PHP', 'Ruby', 'Rust', 'Scala', 'Kotlin', 'Swift',
  'JavaScript', 'TypeScript', 'Node.js', 'React', 'Vue', 'Angular', 'Spring', 'Spring Boot',
  'MyBatis', 'Hibernate', 'Django', 'Flask', 'FastAPI', 'MySQL', 'Oracle', 'SQL Server',
  'PostgreSQL', 'Redis', 'MongoDB', 'Kafka', 'RabbitMQ', 'Spark', 'Hadoop', 'Flink',
  'Elasticsearch', 'Docker', 'Kubernetes', 'Linux', 'Android', 'iOS', 'Unity',
  '微服务', '分布式', '高并发', '云计算', '云原生', '前端', '后端', '全栈', '算法',
  '数据结构', '机器学习', '深度学习', '大模型', 'LLM', 'NLP', '推荐系统', '计算机视觉',
  '数据分析', '数据挖掘', '数据仓库', '数仓', 'ETL', 'BI', '测试', '自动化测试', '性能测试',
  '运维', 'DevOps', 'SRE', '网络安全', '信息安全', '渗透测试', '嵌入式', '单片机', 'FPGA',
  '硬件', '机械', '自动化', 'PLC', '机器人', '自动驾驶', '芯片', '半导体', '通信', '5G',
  '游戏开发', '产品经理', '产品设计', '运营', '用户增长', 'UI设计', 'UX', '视觉设计',
  '项目管理', '敏捷', '销售', '财务', '人力', '法务', '供应链', '物流', '采购', '质量管理',
]

/** Skill -> a role phrase a job board search can actually use. */
const ROLE_HINTS = [
  ['Java', 'Java开发工程师'],
  ['Spring', 'Java开发工程师'],
  ['Python', 'Python开发工程师'],
  ['Go', 'Go开发工程师'],
  ['C++', 'C++开发工程师'],
  ['前端', '前端开发工程师'],
  ['React', '前端开发工程师'],
  ['Vue', '前端开发工程师'],
  ['后端', '后端开发工程师'],
  ['全栈', '全栈工程师'],
  ['测试', '测试工程师'],
  ['自动化测试', '测试开发工程师'],
  ['运维', '运维工程师'],
  ['DevOps', 'DevOps工程师'],
  ['算法', '算法工程师'],
  ['机器学习', '算法工程师'],
  ['深度学习', '算法工程师'],
  ['大模型', '大模型算法工程师'],
  ['NLP', 'NLP算法工程师'],
  ['计算机视觉', '计算机视觉工程师'],
  ['推荐系统', '推荐算法工程师'],
  ['数据分析', '数据分析师'],
  ['数据仓库', '数据仓库工程师'],
  ['数仓', '数据仓库工程师'],
  ['产品经理', '产品经理'],
  ['产品设计', '产品经理'],
  ['UI设计', 'UI设计师'],
  ['UX', '交互设计师'],
  ['运营', '运营'],
  ['用户增长', '用户增长运营'],
  ['项目管理', '项目经理'],
  ['网络安全', '安全工程师'],
  ['嵌入式', '嵌入式开发工程师'],
  ['机械', '机械工程师'],
  ['自动化', '自动化工程师'],
  ['Android', 'Android开发工程师'],
  ['iOS', 'iOS开发工程师'],
  ['销售', '销售'],
  ['财务', '财务'],
  ['人力', '人力资源'],
]

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Merge the row config with defaults.
 * @param config - raw row config, possibly empty.
 */
function settings(config) {
  const source = config && typeof config === 'object' ? config : {}
  const sites = Array.isArray(source.sites) && source.sites.length
    ? source.sites.filter((key) => SITES.some((site) => site.key === key))
    : SITES.map((site) => site.key)
  return {
    freshnessDays: clampInt(source.freshnessDays, DEFAULTS.freshnessDays, 1, 180),
    maxResults: clampInt(source.maxResults, DEFAULTS.maxResults, 1, 30),
    perSiteLimit: clampInt(source.perSiteLimit, DEFAULTS.perSiteLimit, 1, 20),
    timeoutMs: clampInt(source.timeoutMs, DEFAULTS.timeoutMs, 2000, 30000),
    concurrency: clampInt(source.concurrency, DEFAULTS.concurrency, 1, 8),
    verifyLimit: clampInt(source.verifyLimit, DEFAULTS.verifyLimit, 1, 60),
    includeUnverified: source.includeUnverified !== false,
    unverifiedCap: clampInt(source.unverifiedCap, DEFAULTS.unverifiedCap, 0, 10),
    browserEnabled: source.browserEnabled !== false,
    browserHeadless: source.browserHeadless !== false,
    browserFallback: source.browserFallback !== false,
    browserTimeoutMs: clampInt(source.browserTimeoutMs, DEFAULTS.browserTimeoutMs, 5000, 45000),
    browserLimit: clampInt(source.browserLimit, DEFAULTS.browserLimit, 0, 20),
    browserSites: Array.isArray(source.browserSites) && source.browserSites.length
      ? source.browserSites.filter((key) => SITES.some((site) => site.key === key))
      : DEFAULT_BROWSER_SITES.slice(),
    sites: sites.length ? sites : SITES.map((site) => site.key),
    reportDir: typeof source.reportDir === 'string' ? source.reportDir.trim() : '',
  }
}

/**
 * Register the job search and recommendation tools.
 * @param ctx - registrant context carrying `tools` and `web`.
 * @param config - deployment settings for this row.
 */
function registerAll(ctx, config) {
  const base = settings(config)

  const decorate = (value) => ({
    ...value,
    jobs: value.jobs.map(normalizeJobForOutput),
  })

  ctx.tools.register({
    name: 'job_search',
    description:
      '按职位关键词、城市、经验要求，从猎聘、BOSS直聘、国聘网、智联招聘、前程无忧等招聘网站搜集在招岗位。' +
      '会用浏览器打开岗位详情页、模拟真人浏览后核实是否仍在招聘（需要渲染的 SPA 站点同样可读），过滤已关闭、过期、疑似虚假或低质的招聘信息，并按匹配度排序。' +
      '结果以 Markdown 表格返回：岗位名称、公司、城市、薪资、经验、发布时间、信息来源与核实状态、链接。' +
      '「核实状态」中「在招·已核实」表示详情页数据可读，「未核实」表示站点反爬或信息不足，' +
      '未核实条目默认只在已核实结果不足时补位（最多 2 条），回答时应提示用户对未核实条目自行确认。' +
      '默认只看 7 天内发布的岗位。' +
      '如果用户给了简历文件（.docx / .pdf / .txt / .md），把路径放进 resumePath：工具会自己读出技能、年限、学历和城市，' +
      '与 keyword 一起参与匹配打分，并在结果上方标注「按简历匹配」；简历只有图片/扫描件、没有文字层时会明确报错，改用文字版简历。' +
      '调用后请把结果表格原样贴进回答正文（工具结果在界面上可能被折叠，只给摘要用户会以为没有结果），并说明哪些条目未核实。' +
      '用户要找某个职位、查某个城市有什么岗位、或需要最新招聘信息时使用。',
    parameters: SEARCH_PARAMETERS,
    timeoutMs: 300_000,
    output: {
      schema: RESULT_SCHEMA,
      render: renderResult,
    },
    async execute(args, exec) {
      const keyword = String(args.keyword || '').trim()
      const resumePath = String(args.resumePath || '').trim()
      let resume = null
      if (resumePath) {
        const loaded = loadResume(resumePath)
        if (!loaded.ok) throw new Error(`简历解析失败：${loaded.error}`)
        resume = loaded
      }
      if (!keyword && !resume) throw new Error('keyword 和 resumePath 至少要给一个')

      const profile = resume ? resume.profile : null
      const query = keyword || (profile.titles.length ? profile.titles[0] : profile.skills.slice(0, 3).join(' '))
      const tokens = keyword
        ? keywordTokens(keyword)
        : keywordTokens(query).concat(profile.skills.slice(0, 6))
      const experienceText = String(args.experience || '').trim()
      const resumeYears = profile ? profile.years : null
      const spec = {
        ...base,
        mode: 'search',
        keyword: query,
        city: String(args.city || '').trim() || (profile && profile.cities.length ? profile.cities[0] : ''),
        experience: experienceText || (resumeYears === 0 ? '应届' : resumeYears ? `${resumeYears}年` : ''),
        experienceMax: wantedYearsMax(experienceText),
        tokens,
        resumeSkills: profile ? profile.skills : [],
        resumeYears,
        maxResults: clampInt(args.maxResults, base.maxResults, 1, 30),
        freshnessDays: clampInt(args.freshnessDays, base.freshnessDays, 1, 180),
        verifiedOnly: args.verifiedOnly === true,
        years: experienceText ? null : resumeYears,
        expectedSalary: '',
      }
      if (!ctx.web || typeof ctx.web.search !== 'function') {
        throw new Error('web 服务不可用：当前部署没有可用的 web 搜索提供者')
      }
      const value = await runPipeline(ctx, spec, exec?.signal)
      if (profile) {
        value.resume = {
          path: resume.path,
          kind: resume.kind,
          summary: resume.summary,
          skills: profile.skills,
          years: resumeYears === null || resumeYears === undefined ? -1 : resumeYears,
          education: profile.education ? profile.education.label || '' : '',
          city: profile.cities.length ? profile.cities[0] : '',
        }
        value.notes = [
          `按简历匹配：${resume.summary}`,
          ...(keyword ? [] : [`未给 keyword，用简历里的${profile.titles.length ? `岗位线索「${profile.titles[0]}」` : '技能'}检索。`]),
          ...value.notes,
        ]
      }
      return decorate(value)
    },
  })

  ctx.tools.register({
    name: 'career_plan',
    description:
      '根据一份用户画像产出「职业规划报告」：判断目标岗位是否适合（如果用户给了目标岗位），推荐 3–6 个可落地的发展方向，' +
      '给出主/备路线、能力差距与补齐清单、风险提醒和 7 天内可做的动作。返回的是一份 Markdown 报告，不是岗位列表；' +
      '只有 market=quick 时才会附带少量公开搜索结果作为薪资/需求参考。' +
      '生成报告的同时会把它写成 Word（.docx）、Markdown 和 HTML 三个文件（默认在工作目录，文件名 career-plan-时间戳），并把绝对路径放在 docxPath / reportPath / htmlPath 里；' +
      '.docx 可以直接用 Word / WPS 打开，HTML 可以直接用浏览器打开。' +
      '画像来源有两种：用户直接说明（做过哪些工作、专业、技能、目标岗位），或你先用 career_interview 提问收集后再调用本工具。' +
      '调用后请把报告正文（至少结论、推荐方向表、文件路径）贴进回答，不要只给文件路径。' +
      '用户说「我适合做什么」「帮我做职业规划」「我这个目标岗位可行吗」「转行做什么好」时使用。',
    parameters: CAREER_PARAMETERS,
    timeoutMs: 120_000,
    output: {
      schema: CAREER_SCHEMA,
      render: renderCareer,
    },
    async execute(args, exec) {
      const background = String(args.background || '').trim()
      if (!background) throw new Error('background 不能为空：请把用户画像写成一段完整描述')
      const profile = buildProfile({
        background,
        city: args.city,
        targetRole: args.targetRole,
        expectedSalary: args.expectedSalary,
        education: args.education,
        years: typeof args.years === 'number' ? args.years : undefined,
      })
      if (!profile.skills.length && profile.years === null && !profile.jobs.length) {
        throw new Error('画像信息太少：至少需要知道做过什么工作或会什么技能，可以先用 career_interview 提问')
      }
      const assessment = assessTarget(profile)
      const limit = clampInt(args.maxRecommendations, 4, 1, 6)
      const recommendations = recommendCareers(profile, limit)
      const notes = []
      let market = null
      if ((args.market || 'quick') !== 'off') {
        market = await marketSnapshot(ctx, profile, recommendations.slice(0, 3), exec?.signal, notes)
      }
      const value = careerValue(profile, assessment, recommendations, market, notes)
      try {
        const paths = writeReportFiles(value.report, { reportDir: base.reportDir })
        value.reportPath = paths.mdPath
        value.htmlPath = paths.htmlPath
        value.docxPath = paths.docxPath
      } catch (error) {
        value.reportPath = ''
        value.htmlPath = ''
        value.docxPath = ''
        notes.push(`报告文件写入失败：${errText(error)}`)
        value.report = buildReport(profile, assessment, recommendations, { market, notes })
      }
      return value
    },
  })

  ctx.tools.register({
    name: 'career_interview',
    description:
      '生成用于建立「用户画像」的访谈问题（最多 5 条，最后一条固定是「还有什么要补充的吗」）。' +
      '把已知信息放进 background、已问过的 id 放进 answered，就会只问还缺的部分；回答后再调用一次，直到 complete。' +
      '信息足够后用 career_plan 生成职业规划报告。用户没有明确目标、或只说了零散情况时使用。',
    parameters: INTERVIEW_PARAMETERS,
    timeoutMs: 10_000,
    output: {
      schema: INTERVIEW_SCHEMA,
      render: renderInterview,
    },
    async execute(args) {
      const background = String(args.background || '').trim()
      const answered = Array.isArray(args.answered)
        ? args.answered.filter((item) => typeof item === 'string')
        : []
      const profile = buildProfile({ background })
      const { questions, complete } = careerQuestions(profile, answered)
      return { questions, complete }
    },
  })
}

function apply(ctx, config) {
  registerAll(ctx, config)
}

export { apply, inject, name }
