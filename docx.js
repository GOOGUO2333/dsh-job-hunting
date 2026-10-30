// DOCX writer for career reports.
//
// Zero dependencies: builds the WordprocessingML parts by hand and packs them
// into a ZIP archive with stored (uncompressed) entries plus a CRC32 per entry.
// Enough for a text report with headings, tables, bullets and inline bold/code,
// and it keeps the plugin free of npm packages.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    Math.floor(date.getSeconds() / 2)
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f)
  return { time, day }
}

function zipStore(entries) {
  const { time, day } = dosDateTime(new Date())
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }

  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralPart.length, 12)
  end.writeUInt32LE(localPart.length, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([localPart, centralPart, end])
}

const XML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => XML_ESCAPES[character])
}

function runXml(text, options = {}) {
  if (!text) return ''
  const props = []
  if (options.bold) props.push('<w:b/>')
  if (options.code) {
    props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>')
    props.push('<w:sz w:val="18"/>')
  }
  if (options.color) props.push(`<w:color w:val="${options.color}"/>`)
  if (options.size) props.push(`<w:sz w:val="${options.size}"/>`)
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*)/

function inlineRuns(text, options = {}) {
  return String(text)
    .split(INLINE_RE)
    .filter((chunk) => chunk !== '' && chunk !== undefined)
    .map((chunk) => {
      if (chunk.length > 2 && chunk.startsWith('`') && chunk.endsWith('`')) {
        return runXml(chunk.slice(1, -1), { ...options, code: true })
      }
      if (chunk.length > 4 && chunk.startsWith('**') && chunk.endsWith('**')) {
        return runXml(chunk.slice(2, -2), { ...options, bold: true })
      }
      return runXml(chunk, options)
    })
    .join('')
}

function paragraphXml(runs, options = {}) {
  const props = []
  if (options.align) props.push(`<w:jc w:val="${options.align}"/>`)
  if (options.keepNext) props.push('<w:keepNext/>')
  const spacing = []
  if (options.before !== undefined) spacing.push(`w:before="${options.before}"`)
  if (options.after !== undefined) spacing.push(`w:after="${options.after}"`)
  if (spacing.length) props.push(`<w:spacing ${spacing.join(' ')}/>`)
  if (options.indent !== undefined) {
    const hanging = options.hanging !== undefined ? ` w:hanging="${options.hanging}"` : ''
    props.push(`<w:ind w:left="${options.indent}"${hanging}/>`)
  }
  const pPr = props.length ? `<w:pPr>${props.join('')}</w:pPr>` : ''
  return `<w:p>${pPr}${runs}</w:p>`
}

function gridWidths(columns, total = 9600) {
  const width = Math.floor(total / Math.max(1, columns))
  return new Array(columns).fill(width)
}

const BORDER = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>`

function tableXml(header, rows) {
  const columns = header.length
  const widths = gridWidths(columns)
  const grid = `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`
  const tblPr =
    '<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(BORDER).join('') +
    '</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="90" w:type="dxa"/>' +
    '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr>'

  const row = (cells, { header: isHeader = false } = {}) => {
    const tcs = cells
      .map((cell, index) => {
        const width = widths[index] || widths[0]
        const shade = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F5F8"/>' : ''
        const runs = inlineRuns(cell, isHeader ? { bold: true } : {})
        return (
          `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr>` +
          paragraphXml(runs, { after: 0, indent: 0 }) +
          '</w:tc>'
        )
      })
      .join('')
    return `<w:tr>${isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs}</w:tr>`
  }

  const body = [row(header, { header: true }), ...rows.map((cells) => row(cells))].join('')
  return `<w:tbl>${tblPr}${grid}${body}</w:tbl>` + paragraphXml('', { after: 120 })
}

function splitTableRow(line) {
  let body = String(line).trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  return body.split('|').map((cell) => cell.trim())
}

function documentXml(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n')
  const body = []
  const isDivider = (line) => /^[|:\-\s]+$/.test(line) && line.includes('-')

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = raw.trim()
    if (!line) continue

    if (/^---+$/.test(line)) {
      body.push(
        paragraphXml(runXml('· · ·', { color: '9AA0A6' }), { align: 'center', after: 160 }),
      )
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].trim()
      if (level === 1) {
        body.push(
          paragraphXml(runXml(text, { bold: true, size: 36, color: '1F3A5F' }), {
            align: 'center',
            before: 0,
            after: 240,
          }),
        )
      } else if (level === 2) {
        body.push(
          paragraphXml(runXml(text, { bold: true, size: 28, color: '1F3A5F' }), {
            before: 280,
            after: 120,
            keepNext: true,
          }),
        )
      } else {
        body.push(
          paragraphXml(runXml(text, { bold: true, size: 23 }), {
            before: 200,
            after: 80,
            keepNext: true,
          }),
        )
      }
      continue
    }

    if (line.startsWith('|') && index + 1 < lines.length && isDivider(lines[index + 1].trim())) {
      const header = splitTableRow(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      index -= 1
      body.push(tableXml(header, rows))
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      body.push(
        paragraphXml(runXml('• ', {}) + inlineRuns(bullet[1]), {
          indent: 400,
          hanging: 220,
          after: 60,
        }),
      )
      continue
    }

    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      body.push(
        paragraphXml(runXml(`${numbered[1]}. `, { bold: true }) + inlineRuns(numbered[2]), {
          indent: 400,
          hanging: 260,
          after: 60,
        }),
      )
      continue
    }

    const quote = /^>\s*(.*)$/.exec(line)
    if (quote) {
      body.push(
        paragraphXml(inlineRuns(quote[1], { color: '57606A' }), { indent: 300, after: 80 }),
      )
      continue
    }

    body.push(paragraphXml(inlineRuns(line), { after: 120 }))
  }

  const sectPr =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" ' +
    'w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body.join('')}${sectPr}</w:body></w:document>`
  )
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>' +
  '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
  '<w:qFormat/></w:style></w:styles>'

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '</Types>'

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

const DOCUMENT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>'

/**
 * Convert a Markdown report into a .docx buffer.
 * Handles headings (#~###), tables, bullets, numbered lists, quotes, `---`
 * dividers, and inline **bold** / `code`.
 */
export function markdownToDocx(markdown) {
  return zipStore([
    { name: '[Content_Types].xml', data: CONTENT_TYPES_XML },
    { name: '_rels/.rels', data: ROOT_RELS_XML },
    { name: 'word/document.xml', data: documentXml(markdown) },
    { name: 'word/styles.xml', data: STYLES_XML },
    { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS_XML },
  ])
}
