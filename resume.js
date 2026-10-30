/**
 * Resume reading and extraction.
 *
 * `job_search` takes a resume file (`.docx` / `.pdf` / `.txt` / `.md`), pulls
 * the plain text out of it, and derives the few facts a job search can use:
 * skills, years of experience, education level, and the cities mentioned.
 *
 * Everything here is zero-dependency: .docx is a ZIP holding XML (zlib
 * `inflateRaw` + a small central-directory reader), and .pdf text is pulled
 * from the FlateDecode content streams. Scanned/image-only PDFs have no text
 * layer, so they come back as `no-text` instead of pretending to be empty.
 */
import { readFileSync, statSync } from 'node:fs'
import { inflateRawSync, inflateSync } from 'node:zlib'
import { detectCity, detectEducation, parseYears } from './careers.js'

const MAX_BYTES = 12 * 1024 * 1024

/** Skill + tool vocabulary. Matched case-insensitively against resume text. */
const SKILLS = [
  // languages
  'Python', 'Java', 'JavaScript', 'TypeScript', 'Go', 'C', 'C++', 'C#', 'PHP', 'Ruby', 'Rust', 'Kotlin',
  'Swift', 'SQL', 'Shell', 'Bash', 'Lua', 'Scala', 'MATLAB',
  // web / frontend
  'Vue', 'React', 'Angular', 'jQuery', 'HTML', 'CSS', 'Sass', 'Less', 'Webpack', 'Vite', 'Node.js',
  'Element UI', 'Ant Design', '小程序', 'uni-app', 'Flutter', 'React Native',
  // backend / middleware
  'Spring', 'Spring Boot', 'Spring Cloud', 'MyBatis', 'Django', 'Flask', 'FastAPI', 'Express', 'Koa',
  'Redis', 'MongoDB', 'Kafka', 'RabbitMQ', 'Elasticsearch', 'Nginx', 'Tomcat', 'gRPC', 'RESTful',
  // testing
  'Selenium', 'Appium', 'Postman', 'JMeter', 'LoadRunner', 'Pytest', 'JUnit', 'TestNG', 'Cypress',
  'Playwright', 'Robot Framework', 'Allure', 'Fiddler', 'Charles', 'Burp Suite', '安全测试', '性能测试',
  '功能测试', '接口测试', '自动化测试', '测试用例', '缺陷管理', '单元测试', '持续集成', '测试计划',
  'CANoe', 'CANalyzer', 'CAN 总线', 'UDS', '诊断', 'CAPL', 'Vector', '同星', 'HIL', '座舱', '域控',
  // data / ops
  'Linux', 'Docker', 'Kubernetes', 'Jenkins', 'Git', 'GitLab', 'SVN', 'Ansible', 'Prometheus',
  'Grafana', 'ELK', 'MySQL', 'PostgreSQL', 'Oracle', 'SQL Server', 'ClickHouse', 'Hive', 'Spark',
  'Flink', 'Hadoop', 'ETL', 'Tableau', 'Power BI', 'Excel', 'Pandas', 'NumPy', 'Tableau',
  // design / manufacturing
  'SolidWorks', 'UG', 'Pro/E', 'CAD', 'CAE', 'AutoCAD', 'CATIA', 'Injection', 'PLC', 'CNC',
  'MES', 'ERP', 'CRM', 'SAP', 'OA', '低代码', '实施', '售前',
]

const EDUCATION_RE = /博士|硕士|研究生|本科|学士|大专|专科|高职|中专|中职|技校|高中/

const TITLE_HINTS = [
  '软件测试工程师', '测试工程师', '自动化测试', '车载测试', '功能测试', '接口测试', '测试开发',
  '前端开发工程师', '前端工程师', 'Web 前端', '后端开发工程师', 'Java 工程师', '全栈工程师',
  '运维工程师', '实施工程师', '技术支持', '数据分析师', '产品经理', '项目经理', '机械工程师',
  '模具工程师', '工艺工程师', '质量工程师', '设备工程师', '电气工程师', '销售工程师',
]

/** Read the ZIP central directory and return a name → entry map. */
function readZip(buffer) {
  const entries = new Map()
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/docx 文件')
  const count = buffer.readUInt16LE(eocd + 10)
  let pointer = buffer.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) break
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8')
    entries.set(name, { method, compressedSize, localOffset })
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntry(buffer, entry) {
  if (!entry) return null
  const local = entry.localOffset
  if (buffer.readUInt32LE(local) !== 0x04034b50) return null
  const nameLength = buffer.readUInt16LE(local + 26)
  const extraLength = buffer.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  return null
}

function xmlToText(xml) {
  return String(xml)
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function docxToText(buffer) {
  const entries = readZip(buffer)
  const main = entries.get('word/document.xml')
  if (!main) throw new Error('docx 里没有 word/document.xml')
  const xml = readZipEntry(buffer, main)?.toString('utf8') || ''
  return xmlToText(xml)
}

/** Decode one `stream … endstream` payload found inside an object body. */
function streamPayload(body) {
  const start = body.indexOf('stream')
  if (start < 0) return ''
  let dataStart = start + 'stream'.length
  while (body[dataStart] === '\r' || body[dataStart] === '\n') dataStart += 1
  const end = body.indexOf('endstream', dataStart)
  if (end < 0) return ''
  const dict = body.slice(0, start)
  if (/DCTDecode|JPXDecode|CCITTFaxDecode/.test(dict)) return ''
  const text = body.slice(dataStart, end)
  if (!/FlateDecode/.test(dict)) return text
  // PDF FlateDecode is zlib-wrapped; some writers emit raw deflate instead.
  const raw = Buffer.from(text, 'latin1')
  try {
    return inflateSync(raw).toString('latin1')
  } catch {
    try {
      return inflateRawSync(raw).toString('latin1')
    } catch {
      return ''
    }
  }
}

/** UTF-16BE hex payload -> string. */
function hexToUnicode(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '')
  let out = ''
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    out += String.fromCodePoint(parseInt(clean.slice(i, i + 4), 16))
  }
  return out
}

/** Read code -> unicode pairs out of a ToUnicode CMap. */
function readCMap(text, into) {
  const key = (code) => code.toString(16).toUpperCase()
  const charBlocks = /beginbfchar([\s\S]*?)endbfchar/g
  let block
  while ((block = charBlocks.exec(text))) {
    const pair = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g
    let match
    while ((match = pair.exec(block[1]))) into.set(match[1].toUpperCase(), hexToUnicode(match[2]))
  }
  const rangeBlocks = /beginbfrange([\s\S]*?)endbfrange/g
  while ((block = rangeBlocks.exec(text))) {
    let body = block[1]
    // Array form first, and blank it out: its `<hex> <hex> <hex>` neighbours would
    // otherwise be read as stepped ranges (start=0x4E13 end=0x4E1A …) and flood the map.
    body = body.replace(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g, (_, low, high, list) => {
      const start = parseInt(low, 16)
      const end = parseInt(high, 16)
      const items = [...list.matchAll(/<([0-9a-fA-F]*)>/g)].map((entry) => hexToUnicode(entry[1]))
      const limit = Math.min(items.length, end - start + 1)
      for (let offset = 0; offset < limit; offset += 1) into.set(key(start + offset), items[offset])
      return ' '
    })
    const stepped = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
    let match
    while ((match = stepped.exec(body))) {
      const start = parseInt(match[1], 16)
      const end = parseInt(match[2], 16)
      const dst = parseInt(match[3], 16)
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(dst)) continue
      if (end < start || end - start > 0x0fff) continue
      for (let code = start; code <= end; code += 1) {
        into.set(key(code), String.fromCodePoint(dst + (code - start)))
      }
    }
  }
}

/** Decode glyph-code bytes with one CMap, preferring the width it actually covers. */
function bytesToText(bytes, cmaps) {
  if (cmaps && cmaps.size && bytes.length >= 2) {
    for (const width of [2, 1]) {
      if (bytes.length % width !== 0) continue
      const codes = []
      for (let i = 0; i < bytes.length; i += width) {
        let code = 0
        for (let k = 0; k < width; k += 1) code = (code << 8) | bytes[i + k]
        codes.push(code.toString(16).toUpperCase())
      }
      const hits = codes.filter((code) => cmaps.has(code)).length
      if (hits / codes.length >= 0.6) return codes.map((code) => cmaps.get(code)).join('')
    }
  }
  return bytes.map((byte) => String.fromCharCode(byte)).join('')
}

function decodePdfString(literal, cmaps) {
  const bytes = []
  for (let i = 0; i < literal.length; i += 1) {
    const char = literal[i]
    if (char !== '\\') {
      bytes.push(char.charCodeAt(0) & 0xff)
      continue
    }
    const next = literal[i + 1]
    if (next === undefined) break
    i += 1
    if (next === 'n') bytes.push(10)
    else if (next === 'r') bytes.push(13)
    else if (next === 't') bytes.push(9)
    else if (next === 'b') bytes.push(8)
    else if (next === 'f') bytes.push(12)
    else if (/[0-7]/.test(next)) {
      let octal = next
      while (octal.length < 3 && /[0-7]/.test(literal[i + 1] || '')) {
        octal += literal[i + 1]
        i += 1
      }
      bytes.push(parseInt(octal, 8) & 0xff)
    } else bytes.push(next.charCodeAt(0) & 0xff)
  }
  return bytesToText(bytes, cmaps)
}

function decodeHexString(hex, cmaps) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const bytes = []
  for (let i = 0; i + 1 < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16))
  return bytesToText(bytes, cmaps)
}

/**
 * Pull text out of a PDF. Word/WPS export CID-keyed fonts (Identity-H), so glyph codes
 * must go through each font's ToUnicode CMap: `/F1 12 Tf` switches the active font, and a
 * single merged table collides because subset fonts reuse the same codes.
 */
function pdfToText(buffer) {
  const latin = buffer.toString('latin1')
  const objects = new Map()
  const objectRe = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g
  let match
  while ((match = objectRe.exec(latin))) objects.set(Number(match[1]), match[2])

  const merged = new Map()
  const cmapCache = new Map()
  const cmapOfObject = (num) => {
    if (cmapCache.has(num)) return cmapCache.get(num)
    const cmap = new Map()
    const body = objects.get(num)
    if (body) readCMap(streamPayload(body), cmap)
    cmapCache.set(num, cmap)
    for (const [code, char] of cmap) if (!merged.has(code)) merged.set(code, char)
    return cmap
  }

  // Font resource name (/F1) -> font object, then fill its ToUnicode CMap.
  const fontsByName = new Map()
  const fontDict = /\/Font\s*<<([\s\S]*?)>>/g
  while ((match = fontDict.exec(latin))) {
    const pair = /\/(F\d+)\s+(\d+)\s+0\s+R/g
    let entry
    while ((entry = pair.exec(match[1]))) fontsByName.set(entry[1], Number(entry[2]))
  }
  // Font object -> its ToUnicode CMap. The font dict has no stream of its own, so this
  // indirection is what `/F7 1 Tf` has to be resolved through.
  const cmapByFontObject = new Map()
  for (const [num, body] of objects) {
    if (!/\/Type\s*\/Font/.test(body)) continue
    const toUnicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body)
    if (toUnicode) cmapByFontObject.set(num, cmapOfObject(Number(toUnicode[1])))
  }

  const chunks = []
  for (const body of objects.values()) {
    if (!/stream/.test(body)) continue
    if (/\/Type\s*\/Font/.test(body) || /\/Type\s*\/ObjStm/.test(body)) continue
    const content = streamPayload(body)
    if (!content || content.includes('begincmap') || !/(Tj|TJ)/.test(content)) continue
    const text = contentStreamToText(content, fontsByName, cmapByFontObject, merged)
    if (text.trim()) chunks.push(text)
  }
  return chunks.join('\n')
}

function contentStreamToText(content, fontsByName, cmapByFontObject, merged) {
  const parts = []
  const token =
    /\/(F\d+)\s+[\d.]+\s+Tf|\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|')|<([0-9a-fA-F\s]+)>\s*(?:Tj|TJ)|\[((?:[^\][])*?)\]\s*TJ/g
  let current = merged
  let match
  while ((match = token.exec(content))) {
    if (match[1]) {
      const fontNum = fontsByName.get(match[1])
      const own = fontNum === undefined ? undefined : cmapByFontObject.get(fontNum)
      current = own && own.size ? own : merged
      continue
    }
    if (match[2] !== undefined) {
      parts.push(decodePdfString(match[2], current))
      continue
    }
    if (match[3] !== undefined) {
      parts.push(decodeHexString(match[3], current))
      continue
    }
    if (match[4] !== undefined) {
      const inner = match[4]
      let piece = ''
      let innerMatch
      const innerLiteral = /\(((?:\\.|[^\\()])*)\)/g
      const innerHex = /<([0-9a-fA-F\s]+)>/g
      while ((innerMatch = innerLiteral.exec(inner))) piece += decodePdfString(innerMatch[1], current)
      while ((innerMatch = innerHex.exec(inner))) piece += decodeHexString(innerMatch[1], current)
      parts.push(piece)
    }
  }
  return parts.join('')
}

function normalizePdfText(text) {
  return String(text)
    // PDF literal strings frequently carry UTF-16BE surrogates as bytes; strip
    // control chars that would otherwise pollute keyword matching.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
}

function kindOf(filePath) {
  const lower = String(filePath).toLowerCase()
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.txt')) return 'txt'
  return ''
}

function unique(items) {
  return [...new Set(items)]
}

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Years of experience: explicit mentions first, then date ranges of actual work. */
function detectYears(text) {
  const hay = String(text)
  const explicit = [
    /(\d+(?:\.\d+)?)\s*年(?:以上)?(?:相关)?(?:工作|从业|开发|测试|设计|维修|运营)?经验/,
    /(?:工作|从业|开发|测试|设计|维修|运营)\s*(\d+(?:\.\d+)?)\s*年/,
    /(\d+(?:\.\d+)?)\s*年(?:半|多|半多)\s*(?:工作|经验|从业|开发|测试)/,
  ]
  for (const pattern of explicit) {
    const match = hay.match(pattern)
    if (match) {
      const years = Number(match[1])
      if (Number.isFinite(years) && years >= 0 && years < 50) return years
    }
  }
  const student = /应届|在校|实习/.test(hay)
  // Student / fresh-grad resumes: student projects are not work experience.
  if (student && !/工作|任职|就职|在职|从业/.test(hay)) return 0
  // Only date ranges that sit next to work words count; education and project
  // ranges would otherwise inflate a fresh grad into "4 years of experience".
  if (!/工作|任职|就职|在职|从业|实习|兼职/.test(hay)) {
    return student ? 0 : null
  }
  const spans = []
  const range = /(20\d{2})\s*[.\-/年]\s*(\d{1,2})?\s*(?:月)?\s*[-–—~至到]\s*(20\d{2})\s*[.\-/年]\s*(\d{1,2})?/g
  // PDF text usually arrives without line breaks, so judge each range by its
  // neighbourhood: it must sit next to a company/role word and must not be the
  // education span (which would turn a fresh grad into "4 years of experience").
  const workNear = /公司|集团|科技|工作|任职|就职|在职|从业|实习|兼职|岗位/
  const schoolNear = /教育|学院|大学|学校|本科|专科|硕士|博士|就读|毕业|学历|专业|课程|届/
  let match
  while ((match = range.exec(hay))) {
    const before = hay.slice(Math.max(0, match.index - 60), match.index)
    if (!workNear.test(before)) continue
    const tight = before.slice(-20)
    if (schoolNear.test(tight) && !workNear.test(tight)) continue
    const start = Number(match[1]) + (Number(match[2] || 1) - 1) / 12
    const end = Number(match[3]) + (Number(match[4] || 1) - 1) / 12
    if (end >= start) spans.push([start, end])
  }
  if (!spans.length) return student ? 0 : null
  // Merge overlapping ranges so concurrent jobs are not counted twice.
  spans.sort((a, b) => a[0] - b[0])
  let total = 0
  let [cursorStart, cursorEnd] = spans[0]
  for (const [start, end] of spans.slice(1)) {
    if (start <= cursorEnd) {
      cursorEnd = Math.max(cursorEnd, end)
    } else {
      total += cursorEnd - cursorStart
      cursorStart = start
      cursorEnd = end
    }
  }
  total += cursorEnd - cursorStart
  return Math.round(total * 2) / 2
}

function detectCities(text) {
  const found = []
  for (const token of String(text).split(/[^\u4e00-\u9fa5]{1,}/)) {
    if (token.length < 2) continue
    const city = detectCity(token)
    if (city && !found.includes(city)) found.push(city)
  }
  return found.slice(0, 5)
}

/**
 * Read a resume file and extract what a job search can use.
 * Never throws: failures come back as `{ok: false, error}`.
 */
export function readResumeText(filePath) {
  const path = String(filePath || '').trim()
  if (!path) return { ok: false, error: '简历路径为空' }
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { ok: false, error: `找不到简历文件：${path}` }
  }
  if (!stat.isFile()) return { ok: false, error: `简历路径不是文件：${path}` }
  if (stat.size > MAX_BYTES) return { ok: false, error: '简历文件超过 12MB，无法解析' }
  const kind = kindOf(path)
  if (!kind) return { ok: false, error: '只支持 .docx / .pdf / .txt / .md 格式的简历' }
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    return { ok: false, error: `读取简历失败：${error?.message || error}` }
  }
  let text = ''
  try {
    if (kind === 'docx') text = docxToText(buffer)
    else if (kind === 'pdf') text = normalizePdfText(pdfToText(buffer))
    else text = buffer.toString('utf8')
  } catch (error) {
    return { ok: false, error: `解析简历失败：${error?.message || error}` }
  }
  text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim()
  if (text.length < 20) {
    return {
      ok: false,
      error: '简历里没有读到文字（可能是扫描件/图片版 PDF），请换成文字版 PDF、Word 或直接说一遍情况',
      kind,
      text,
    }
  }
  return { ok: true, kind, text }
}

/** Turn resume text into the facts `job_search` can use. */
export function resumeProfileFromText(text) {
  const hay = String(text || '')
  const lower = hay.toLowerCase()
  const skills = []
  for (const skill of SKILLS) {
    const needle = skill.toLowerCase()
    const pattern = /^[\x00-\x7f]+$/.test(skill)
      ? new RegExp(`(^|[^a-z0-9+#.])${escapeRe(needle)}([^a-z0-9+#.]|$)`)
      : new RegExp(escapeRe(skill))
    if (pattern.test(lower)) skills.push(skill)
  }
  const years = detectYears(hay)
  const education = EDUCATION_RE.test(hay) ? detectEducation(hay) : null
  const titles = TITLE_HINTS.filter((title) => hay.includes(title))
  const cities = detectCities(hay)
  return {
    skills: unique(skills),
    years,
    education,
    titles: unique(titles).slice(0, 5),
    cities,
    parseYears: parseYears,
  }
}

/** One-line summary used in tool output and match reasons. */
export function describeResume(profile) {
  const bits = []
  if (profile.skills.length) bits.push(`技能 ${profile.skills.slice(0, 8).join('、')}`)
  if (profile.years === 0) bits.push('应届/无全职经验')
  else if (profile.years !== null && profile.years !== undefined) bits.push(`${profile.years} 年经验`)
  if (profile.education) bits.push(profile.education.label || profile.education)
  if (profile.titles.length) bits.push(`做过/写过 ${profile.titles.slice(0, 3).join('、')}`)
  return bits.join('；') || '未提取到可用信息'
}

/** Read + profile in one call. */
export function loadResume(filePath) {
  const read = readResumeText(filePath)
  if (!read.ok) return read
  const profile = resumeProfileFromText(read.text)
  return {
    ok: true,
    kind: read.kind,
    path: String(filePath),
    chars: read.text.length,
    text: read.text,
    profile,
    summary: describeResume(profile),
  }
}
