// Career knowledge base, profile parsing and planning engine.
//
// Pure data + pure functions: no network, no Cordis APIs. index.js turns the
// results into tool output. Everything is Chinese-facing because the target
// users are Chinese job seekers.

// ---------------------------------------------------------------------------
// Cities and salary tiers
// ---------------------------------------------------------------------------

const TIER1 = ['北京', '上海', '深圳', '广州']
const NEW_TIER1 = [
  '杭州', '成都', '武汉', '南京', '苏州', '西安', '重庆', '天津', '长沙', '郑州',
  '东莞', '佛山', '合肥', '青岛', '宁波', '厦门', '济南', '无锡', '福州', '昆明',
]
const TIER2 = [
  '石家庄', '太原', '呼和浩特', '沈阳', '大连', '长春', '哈尔滨', '南昌', '南宁',
  '贵阳', '兰州', '海口', '乌鲁木齐', '银川', '西宁', '拉萨', '温州', '嘉兴', '绍兴',
  '金华', '台州', '泉州', '烟台', '潍坊', '徐州', '常州', '南通', '扬州', '盐城',
  '惠州', '珠海', '中山', '江门', '汕头', '湛江', '株洲', '湘潭', '衡阳', '宜昌',
  '襄阳', '洛阳', '绵阳', '宜宾', '桂林', '柳州', '三亚', '包头', '鄂尔多斯', '大庆',
  '吉林', '鞍山', '抚顺',
]

// Prefecture-level cities outside the tier lists: they still need to be
// recognised in a resume/履历, they simply land in the「三线」salary band.
const OTHER_CITIES = [
  '芜湖', '马鞍山', '蚌埠', '安庆', '阜阳', '滁州', '六安', '宿州', '淮南', '淮北',
  '铜陵', '黄山', '宣城', '池州', '亳州', '马鞍山', '泰州', '镇江', '连云港', '宿迁',
  '淮安', '湖州', '衢州', '丽水', '舟山', '漳州', '龙岩', '三明', '南平', '莆田',
  '宁德', '景德镇', '九江', '赣州', '上饶', '宜春', '吉安', '抚州', '新余', '萍乡',
  '鹰潭', '淄博', '枣庄', '东营', '济宁', '泰安', '威海', '日照', '临沂', '德州',
  '聊城', '滨州', '菏泽', '开封', '平顶山', '安阳', '新乡', '焦作', '许昌', '漯河',
  '三门峡', '南阳', '商丘', '信阳', '周口', '驻马店', '黄石', '十堰', '荆州', '荆门',
  '鄂州', '孝感', '黄冈', '咸宁', '随州', '岳阳', '常德', '张家界', '益阳', '郴州',
  '永州', '怀化', '娄底', '韶关', '梅州', '汕尾', '河源', '阳江', '清远', '东莞',
  '揭阳', '云浮', '茂名', '肇庆', '潮州', '泸州', '德阳', '广元', '遂宁', '内江',
  '乐山', '南充', '眉山', '广安', '达州', '雅安', '巴中', '资阳', '自贡', '攀枝花',
  '遵义', '六盘水', '安顺', '曲靖', '玉溪', '保山', '昭通', '丽江', '普洱', '临沧',
  '宝鸡', '咸阳', '渭南', '延安', '汉中', '榆林', '安康', '商洛', '天水', '白银',
]

const CITY_NAMES = [...new Set([...TIER1, ...NEW_TIER1, ...TIER2, ...OTHER_CITIES])]

const cityTierOf = (city) => {
  const name = String(city || '').replace(/[市省]/g, '').trim()
  if (!name) return '三线'
  if (TIER1.includes(name)) return '一线'
  if (NEW_TIER1.includes(name)) return '新一线'
  if (TIER2.includes(name)) return '二线'
  return '三线'
}

const normalizeCityName = (value) => String(value || '').replace(/[市省]/g, '').trim()

function detectCity(text) {
  const hay = String(text || '')
  if (!hay) return ''
  // longer names first, so 「马鞍山」 wins over 「鞍山」
  const ordered = [...CITY_NAMES].sort((a, b) => b.length - a.length)
  for (const name of ordered) if (hay.includes(name)) return name
  return ''
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const hasLatin = (token) => /[A-Za-z]/.test(token)

function mentions(text, token) {
  const hay = String(text || '')
  if (!hay || !token) return false
  if (!hasLatin(token)) return hay.includes(token)
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9+#.])${escaped}($|[^A-Za-z0-9+#.])`,
    'i',
  )
  return pattern.test(hay)
}

function unique(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const key = String(item || '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

const EDUCATION_LEVELS = [
  { key: '博士', rank: 7 },
  { key: '硕士', rank: 6, aliases: ['研究生', 'MBA'] },
  { key: '本科', rank: 5, aliases: ['学士'] },
  { key: '大专', rank: 4, aliases: ['专科', '高职', '高专'] },
  { key: '中专', rank: 3, aliases: ['中职', '职高', '技校', '技师学院'] },
  { key: '高中', rank: 2 },
  { key: '初中', rank: 1 },
]

function detectEducation(text) {
  const hay = String(text || '')
  for (const level of EDUCATION_LEVELS) {
    const words = [level.key, ...(level.aliases || [])]
    if (words.some((word) => hay.includes(word))) {
      return { label: level.key, rank: level.rank }
    }
  }
  return { label: '', rank: 0 }
}

function parseYears(text) {
  const hay = String(text || '')
  const half = /(\d{1,2})\s*年\s*(?:半|多|半多)/.exec(hay)
  if (half) return Number(half[1]) + 0.5
  const range = /(\d{1,2}(?:\.\d)?)\s*[-~到至]\s*(\d{1,2}(?:\.\d)?)\s*年/.exec(hay)
  if (range) return Number(range[2])
  const single = /(\d{1,2}(?:\.\d)?)\s*年/.exec(hay)
  if (single) return Number(single[1])
  const months = /(\d{1,2})\s*个\s*月/.exec(hay)
  if (months) return Math.round((Number(months[1]) / 12) * 10) / 10
  if (/应届|在校|实习/.test(hay)) return 0
  return null
}

// ---------------------------------------------------------------------------
// Work-experience families
// ---------------------------------------------------------------------------

const EXPERIENCE_FAMILIES = [
  {
    key: '制造',
    label: '制造/设备/品质',
    words: [
      '模具', '钳工', '注塑', '冲压', '机修', '设备', '装配', '车床', '铣床', '磨床',
      '焊接', '产线', '车间', '品质', '检验', '质检', '工艺', '数控', 'CNC',
      '加工中心', '电工', 'PLC', '工厂', '生产', '机械', '机电', '自动化产线',
    ],
  },
  {
    key: 'web',
    label: '前端/网页',
    words: ['前端', 'Vue', 'React', '小程序', '网页', '页面', '组件', 'CSS', 'HTML', 'Angular'],
  },
  {
    key: 'backend',
    label: '后端/服务端',
    words: ['Java', '后端', 'Spring', '服务端', 'MySQL', 'Redis', '接口开发', '微服务', 'Python后端'],
  },
  {
    key: 'data',
    label: '数据',
    words: ['数据分析', '数据挖掘', 'SQL', '报表', '数据可视化', '数仓', 'ETL', 'BI'],
  },
  {
    key: 'qa',
    label: '测试',
    words: ['测试', '用例', 'Bug', '自动化测试', '性能测试'],
  },
  {
    key: 'ops',
    label: '运维/网络',
    words: ['运维', 'Linux', '服务器', '网络', '弱电', 'Docker', 'Kubernetes'],
  },
  {
    key: 'sales',
    label: '销售/商务',
    words: ['销售', '客户开发', '渠道', '商务', '门店', '导购', '回款', '招投标'],
  },
  {
    key: 'service',
    label: '客服/售后',
    words: ['客服', '售后', '客户支持', '工单', '投诉'],
  },
  {
    key: 'finance',
    label: '财务',
    words: ['会计', '财务', '出纳', '报税', '做账'],
  },
  {
    key: 'marketing',
    label: '运营/市场',
    words: ['运营', '新媒体', '文案', '活动策划', '推广', '电商', '投放'],
  },
  {
    key: 'edu',
    label: '教育/培训',
    words: ['教师', '助教', '家教', '培训', '课程顾问', '讲师'],
  },
  {
    key: 'supply',
    label: '采购/供应链',
    words: ['采购', '供应链', '仓储', '库存', '物流', '跟单'],
  },
]

function detectFamilies(text) {
  const hay = String(text || '')
  return EXPERIENCE_FAMILIES.filter((family) => family.words.some((word) => mentions(hay, word))).map(
    (family) => family.key,
  )
}

// ---------------------------------------------------------------------------
// Career catalogue
//
// salary: monthly value in K (thousand CNY), per city tier.
// ladder: the three rungs recruiters actually see (entry → mid → senior).
// ---------------------------------------------------------------------------

const CAREERS = [
  {
    key: 'frontend',
    name: '前端开发工程师',
    family: 'web',
    aliases: ['前端', 'web前端', 'H5', '网页开发', '前端开发工程师', '前端工程师', 'Vue开发'],
    skills: ['前端', 'Vue', 'React', 'JavaScript', 'TypeScript', 'HTML', 'CSS', '小程序', 'uni-app', 'Element UI', 'Ant Design', 'Webpack'],
    families: ['web'],
    minYears: 0,
    eduRank: 4,
    ladder: ['前端开发工程师', '高级前端工程师', '前端负责人 / 架构师'],
    salary: { 一线: [9, 20], 新一线: [7, 14], 二线: [6, 11], 三线: [4.5, 8] },
    entry: '作品集比文凭重要：2–3 个可运行的项目（部署上线）就能过初筛',
    certificates: ['软考（可选）', '无硬性证书'],
    gap: ['组件化与工程化（vite/webpack）', '一个真实业务项目（有接口、有状态管理）', 'Git 协作与代码规范'],
    demand: '岗位量大，初级竞争激烈，二三线城市以下本地机会少、多为外包驻场',
  },
  {
    key: 'lowcode',
    name: '低代码 / 实施工程师',
    family: 'web',
    aliases: ['低代码', '实施工程师', '实施顾问', 'ERP实施', 'MES实施', '配置工程师', '数字化转型'],
    skills: ['低代码', '实施', 'ERP', '金蝶', '用友', 'SAP', 'MES', '配置', 'SQL', '项目管理', 'Excel'],
    families: ['web', 'backend', '制造'],
    minYears: 0,
    eduRank: 4,
    ladder: ['实施工程师', '高级实施 / 解决方案顾问', '项目经理 / 交付负责人'],
    salary: { 一线: [8, 16], 新一线: [6, 12], 二线: [5, 9], 三线: [4, 7] },
    entry: '懂业务比懂代码更值钱：制造业背景 + 会配系统就是稀缺组合',
    certificates: ['厂商认证（金蝶/用友/钉钉宜搭等，可选）'],
    gap: ['一个低代码平台的实操（宜搭/简道云/活字格）', 'SQL 基础与企业业务流程图', '需求访谈与文档能力'],
    demand: '制造业数字化转型带动需求，二三线城市也有本地项目，出差较多',
  },
  {
    key: 'backend',
    name: 'Java 后端开发工程师',
    family: 'backend',
    aliases: ['Java', 'Java开发', '后端', '服务端开发', 'Java后端'],
    skills: ['Java', 'Spring', 'Spring Boot', 'MyBatis', 'MySQL', 'Redis', 'Kafka', '微服务', '分布式', 'Docker'],
    families: ['backend'],
    minYears: 0.5,
    eduRank: 4,
    ladder: ['Java 开发工程师', '高级后端 / 技术专家', '架构师 / 技术负责人'],
    salary: { 一线: [11, 24], 新一线: [8, 16], 二线: [7, 12], 三线: [5.5, 9] },
    entry: '门槛高于前端：要能讲清一个完整后端项目（鉴权、缓存、并发、部署）',
    certificates: ['无硬性证书'],
    gap: ['Spring Boot 完整项目（含数据库与部署）', '并发与 JVM 基础', '常见中间件的使用场景'],
    demand: '岗位多但初中级饱和，非科班转行需要项目 + 刷题双线准备',
  },
  {
    key: 'qa',
    name: '软件测试工程师',
    family: 'qa',
    aliases: ['测试', '软件测试', '测试工程师', 'QA', '自动化测试'],
    skills: ['测试', '功能测试', '接口测试', '自动化测试', 'Selenium', 'Postman', 'JMeter', 'Python', '缺陷管理'],
    families: ['qa', 'web'],
    minYears: 0,
    eduRank: 4,
    ladder: ['测试工程师', '自动化 / 测试开发', '测试负责人 / 质量架构'],
    salary: { 一线: [8, 16], 新一线: [6, 12], 二线: [5, 9], 三线: [4, 7] },
    entry: '转行门槛最低的 IT 岗之一：会用工具、能写清用例就能入行',
    certificates: ['ISTQB（可选）'],
    gap: ['接口测试实操（Postman + 断言）', 'Python 或 Java 基础（写自动化脚本）', '一个完整项目的测试用例集'],
    demand: '入门宽松，外包与驻场岗多；自动化方向薪资明显更高',
  },
  {
    key: 'ops',
    name: '运维 / 网络工程师',
    family: 'ops',
    aliases: ['运维', '网络工程师', '系统管理员', 'IT运维', '弱电工程师'],
    skills: ['Linux', '运维', '服务器', '网络', 'Docker', 'Kubernetes', 'Shell', '监控', '网络安全'],
    families: ['ops'],
    minYears: 0,
    eduRank: 4,
    ladder: ['运维工程师', '高级运维 / SRE', '运维负责人 / 云平台工程师'],
    salary: { 一线: [8, 17], 新一线: [6, 12], 二线: [5, 9], 三线: [4, 7] },
    entry: '有硬件/机修手感的人转运维有优势：排障思维相通',
    certificates: ['HCIA / CCNA（可选）', 'RHCE（可选）'],
    gap: ['Linux 常用命令与排障', '一台云服务器的部署与监控', '网络基础（TCP/IP、VLAN）'],
    demand: '传统运维在收缩，云与安全方向仍在招；值班/夜班较常见',
  },
  {
    key: 'support',
    name: 'IT 技术支持 / 售后工程师',
    family: 'support',
    aliases: ['技术支持', '售后工程师', '客户支持', '售后技术支持', '技术服务'],
    skills: ['技术支持', '售后', '故障排查', '装机', '网络', '客户沟通', '工单', '系统维护'],
    families: ['service', 'ops', '制造'],
    minYears: 0,
    eduRank: 3,
    ladder: ['技术支持工程师', '高级支持 / 售前支持', '服务经理 / 交付经理'],
    salary: { 一线: [7, 13], 新一线: [6, 10], 二线: [5, 8], 三线: [3.8, 6.5] },
    entry: '最像「手艺人」的 IT 岗：动手能力 + 沟通，学历要求最宽松',
    certificates: ['厂商认证（华为/思科/海康等，可选）'],
    gap: ['常见软硬件故障的排查手册', '客户沟通与工单记录习惯', '一门脚本（Python/Shell）做重复工作'],
    demand: '二三线城市机会相对多，设备厂商、系统集成商常年招人',
  },
  {
    key: 'data',
    name: '数据分析师',
    family: 'data',
    aliases: ['数据分析', '数据分析师', 'BI', '数据运营', '商业分析'],
    skills: ['数据分析', 'SQL', 'Excel', 'Python', 'Tableau', 'Power BI', '可视化', '统计', '业务分析'],
    families: ['data'],
    minYears: 0.5,
    eduRank: 5,
    ladder: ['数据分析师', '高级分析师 / 数据产品', '数据负责人 / 数据科学家'],
    salary: { 一线: [9, 20], 新一线: [7, 14], 二线: [6, 11], 三线: [4.5, 8] },
    entry: '学历与业务理解双重门槛，多数岗位要求本科及以上',
    certificates: ['无硬性证书'],
    gap: ['SQL 熟练（窗口函数、多表关联）', '一个真实数据集的分析报告', '指标体系与 AB 测试常识'],
    demand: '一线与新一线需求稳定，二三线多集中在电商、零售、制造企业',
  },
  {
    key: 'pm',
    name: '产品经理',
    family: 'pm',
    aliases: ['产品经理', '产品助理', '产品', '需求分析'],
    skills: ['产品', '需求', '原型', 'Axure', 'PRD', '用户研究', '竞品分析', '数据分析', '项目管理'],
    families: ['pm', 'marketing'],
    minYears: 1,
    eduRank: 5,
    ladder: ['产品助理', '产品经理', '高级产品 / 产品负责人'],
    salary: { 一线: [12, 25], 新一线: [9, 18], 二线: [7, 13], 三线: [6, 10] },
    entry: '看似无门槛，实际要求行业理解与沟通能力，转行者常从产品助理切入',
    certificates: ['NPDP（可选）'],
    gap: ['一份可讲的 PRD 与原型', '目标行业的业务理解', '数据驱动的决策案例'],
    demand: '岗位集中在互联网与软件公司，二三线城市机会有限',
  },
  {
    key: 'mold-repair',
    name: '模具维修 / 模具钳工',
    family: '制造',
    aliases: ['模具维修', '模具钳工', '修模', '模具师傅', '模具工'],
    skills: ['模具', '注塑模', '冲压模', '钳工', '维修', '抛光', '装配', 'UG', 'CAD'],
    families: ['制造'],
    minYears: 0,
    eduRank: 3,
    ladder: ['模具维修工', '模具主管 / 高级技师', '模具经理 / 技术专家'],
    salary: { 一线: [8, 15], 新一线: [7, 12], 二线: [6, 10], 三线: [5, 8] },
    entry: '纯手艺岗：经验与手感就是资历，学历不是门槛',
    certificates: ['模具工职业技能等级证（可选）'],
    gap: ['补齐 UG/CAD 绘图能力（往设计方向走）', '注塑/冲压工艺参数理解', '设备与模具保养规程'],
    demand: '制造业稳定需求，师傅带徒为主；愿意上夜班、去工业区机会更多',
  },
  {
    key: 'mold-design',
    name: '模具设计工程师',
    family: '制造',
    aliases: ['模具设计', '模具工程师', '结构工程师（模具）'],
    skills: ['模具设计', 'UG', 'SolidWorks', 'CAD', '冲压', '注塑', 'DFM', '公差', '图纸'],
    families: ['制造'],
    minYears: 2,
    eduRank: 4,
    ladder: ['模具设计助理', '模具设计工程师', '设计主管 / 技术经理'],
    salary: { 一线: [10, 20], 新一线: [8, 15], 二线: [7, 12], 三线: [5.5, 9] },
    entry: '维修经验转设计是常见路径：懂现场的人画图，方案更落地',
    certificates: ['无硬性证书'],
    gap: ['UG/NX 或 SolidWorks 建模与出图', '模具结构与标准件选型', 'DFM 与试模问题分析'],
    demand: '有二三年维修底子再转设计，比零基础学设计更有竞争力',
  },
  {
    key: 'cnc',
    name: 'CNC 编程 / 加工中心',
    family: '制造',
    aliases: ['CNC', '数控', '加工中心', '数控编程', 'CNC编程'],
    skills: ['CNC', '数控', '加工中心', '编程', 'UG', 'Mastercam', '车床', '铣', '刀具'],
    families: ['制造'],
    minYears: 0.5,
    eduRank: 3,
    ladder: ['CNC 操作工', 'CNC 编程员', '工艺主管 / 编程组长'],
    salary: { 一线: [8, 16], 新一线: [7, 12], 二线: [6, 10], 三线: [5, 8.5] },
    entry: '从操机到编程是标准晋升路径，会 UG 编程薪资跳一档',
    certificates: ['数控车/铣中级工（可选）'],
    gap: ['UG 或 Mastercam 编程', '刀路与工装夹具设计', '读图与公差配合'],
    demand: '制造业密集地区长期缺编程人员，加班较多',
  },
  {
    key: 'equipment',
    name: '设备维护 / 机电维修',
    family: '制造',
    aliases: ['设备维护', '设备工程师', '机电维修', '设备维修', '维修工程师'],
    skills: ['设备维护', '机电', '电工', '维修', '保养', 'PLC', '故障排查', '液压', '气动'],
    families: ['制造', 'ops'],
    minYears: 0,
    eduRank: 3,
    ladder: ['设备维修工', '设备工程师', '设备经理 / 自动化工程师'],
    salary: { 一线: [7, 14], 新一线: [6, 11], 二线: [5, 9], 三线: [4.5, 7.5] },
    entry: '与模具维修高度相通，换行业不换手艺',
    certificates: ['低压电工证（上岗必需）'],
    gap: ['低压电工证', 'PLC 基础（西门子/三菱）', '设备点检与备件管理'],
    demand: '所有工厂都需要，二三线城市岗位密度高于 IT 岗',
  },
  {
    key: 'quality',
    name: '品质工程师（QC/QE）',
    family: '制造',
    aliases: ['品质', '质量工程师', 'QC', 'QA', 'QE', '检验员', '质量'],
    skills: ['品质', '质量', 'QC', 'QA', 'QE', '检验', 'ISO9001', 'SPC', '8D', '来料检验', '客诉'],
    families: ['制造'],
    minYears: 0,
    eduRank: 4,
    ladder: ['检验员 / QC', 'QE 品质工程师', '品质主管 / 质量经理'],
    salary: { 一线: [8, 15], 新一线: [6, 11], 二线: [5.5, 9], 三线: [4.5, 7.5] },
    entry: '懂现场缺陷怎么产生的人做品质最有说服力，转型成本低',
    certificates: ['内审员（可选）'],
    gap: ['8D 与 5Why 报告写法', 'SPC / MSA / FMEA 工具', 'ISO9001 体系条款'],
    demand: '制造业标配岗位，汽车与电子行业要求更高、薪资更好',
  },
  {
    key: 'process',
    name: '生产工艺工程师（PE）',
    family: '制造',
    aliases: ['工艺工程师', 'PE', '生产工艺', '制程工程师', 'IE'],
    skills: ['工艺', '生产', '制程', 'PE', 'SOP', 'IE', '产线', '改善', '工装', '精益'],
    families: ['制造'],
    minYears: 0.5,
    eduRank: 4,
    ladder: ['工艺助理', '工艺工程师', '工艺主管 / 制造经理'],
    salary: { 一线: [9, 17], 新一线: [7, 13], 二线: [6, 10], 三线: [5, 8] },
    entry: '要求能写文件、能上产线、能跟改善，维修经验是加分项',
    certificates: ['无硬性证书'],
    gap: ['SOP 与工艺文件编写', '工时测算与产线平衡', '精益改善案例（降本/提效）'],
    demand: '制造业升级中需求稳定，晋升路径清晰',
  },
  {
    key: 'industrial-design',
    name: '产品结构设计',
    family: '制造',
    aliases: ['结构设计', '产品设计', '机械设计', '钣金设计', '工业设计'],
    skills: ['结构设计', 'CAD', 'SolidWorks', 'Pro/E', '钣金', '塑料件', '工业设计', '图纸', '公差'],
    families: ['制造'],
    minYears: 1,
    eduRank: 4,
    ladder: ['绘图员 / 设计助理', '结构设计工程师', '设计主管 / 研发经理'],
    salary: { 一线: [9, 18], 新一线: [7, 13], 二线: [6, 10], 三线: [5, 8] },
    entry: '绘图是硬门槛，能用三维软件出可制造图纸才有面试机会',
    certificates: ['无硬性证书'],
    gap: ['SolidWorks / Pro-E 建模与出工程图', '材料与加工工艺常识', '两三个完整设计作品'],
    demand: '家电、汽车零部件、装备制造都有需求，二三线城市机会中等',
  },
  {
    key: 'sales-tech',
    name: '工业软件 / 设备技术销售（售前）',
    family: 'sales',
    aliases: ['技术销售', '售前', '销售工程师', '解决方案', '售前工程师'],
    skills: ['销售', '客户', '方案', '售前', '演示', '商务', '招投标', '客户需求', '技术背景'],
    families: ['sales', '制造'],
    minYears: 0,
    eduRank: 4,
    ladder: ['销售工程师', '高级销售 / 售前顾问', '区域经理 / 销售总监'],
    salary: { 一线: [8, 20], 新一线: [6, 15], 二线: [5, 12], 三线: [4.5, 10] },
    entry: '「懂技术 + 敢开口」是稀缺组合，底薪不高但提成空间大',
    certificates: ['无硬性证书'],
    gap: ['行业产品知识（CAD/ERP/设备）', '方案讲解与演示能力', '客户拜访与跟单节奏'],
    demand: '制造业与软件厂商都在招，收入波动大，适合能扛业绩压力的人',
  },
  {
    key: 'project',
    name: '项目经理 / 交付管理',
    family: 'pm',
    aliases: ['项目经理', '交付经理', '实施项目经理', '项目主管'],
    skills: ['项目管理', '交付', '进度', '沟通', '协调', 'PMP', '实施', '风险', '验收'],
    families: ['pm', '制造'],
    minYears: 1,
    eduRank: 4,
    ladder: ['项目助理', '项目经理', '项目总监 / PMO'],
    salary: { 一线: [10, 20], 新一线: [8, 15], 二线: [7, 12], 三线: [5.5, 9] },
    entry: '需要「带过事」的证据：排期、协调、验收，哪怕是一个小项目',
    certificates: ['PMP（可选）'],
    gap: ['一份项目计划与风险清单', '跨部门协调的实战案例', '验收与回款流程理解'],
    demand: '软件实施、制造、工程行业都缺，出差比例高',
  },
  {
    key: 'supply',
    name: '采购 / 供应链专员',
    family: 'supply',
    aliases: ['采购', '供应链', '采购专员', '物流', '计划员', 'PMC'],
    skills: ['采购', '供应商', '询价', '物流', '库存', '供应链', '商务谈判', 'ERP', 'Excel'],
    families: ['supply', '制造'],
    minYears: 0,
    eduRank: 4,
    ladder: ['采购专员', '采购主管 / SQE', '供应链经理'],
    salary: { 一线: [7, 13], 新一线: [6, 10], 二线: [5, 8], 三线: [4, 6.5] },
    entry: '制造业背景的人懂物料与工艺，比纯文职转采购更有优势',
    certificates: ['无硬性证书'],
    gap: ['询价比价与合同要点', 'ERP 采购模块操作', '供应商评估与跟单'],
    demand: '稳定但晋升慢，汽车/电子行业薪资更好',
  },
  {
    key: 'production',
    name: '生产管理 / 车间主管',
    family: '制造',
    aliases: ['生产管理', '车间主管', '班组长', '生产主管', '厂长助理'],
    skills: ['生产管理', '班组', '车间', '排产', '人员管理', '5S', '安全', '产能'],
    families: ['制造'],
    minYears: 1,
    eduRank: 3,
    ladder: ['班组长', '车间主管', '生产经理 / 厂长'],
    salary: { 一线: [7, 13], 新一线: [6, 11], 二线: [5, 9], 三线: [4.5, 7.5] },
    entry: '从一线提拔为主，靠的是带人、排产、扛指标的能力',
    certificates: ['安全员证（可选）'],
    gap: ['排产与产能测算', '班组人员与绩效管理', '5S 与安全生产管理'],
    demand: '所有工厂都有需求，晋升靠现场业绩',
  },
  {
    key: 'electrician',
    name: '电工 / 电气维修',
    family: '制造',
    aliases: ['电工', '电气维修', '低压电工', '配电', '电气工程师'],
    skills: ['电工', '电气', 'PLC', '接线', '配电', '维修', '变频器', '仪表'],
    families: ['制造'],
    minYears: 0,
    eduRank: 3,
    ladder: ['电工', '电气技师 / PLC 编程', '电气主管 / 自动化工程师'],
    salary: { 一线: [7, 13], 新一线: [6, 10], 二线: [5, 8.5], 三线: [4.5, 7] },
    entry: '持证上岗是硬要求，PLC 是拉开差距的关键',
    certificates: ['低压电工证（必需）', '高压电工证（可选）'],
    gap: ['低压电工证', 'PLC 编程（西门子 S7-200/1200）', '电气图纸识读'],
    demand: '工厂与物业都需要，夜班与值班较常见',
  },
  {
    key: 'automation',
    name: '自动化 / 机器人调试',
    family: '制造',
    aliases: ['机器人调试', '自动化工程师', 'PLC工程师', '视觉调试', '电气自动化'],
    skills: ['PLC', '机器人', 'ABB', '发那科', '视觉', '调试', '自动化', '伺服', 'HMI'],
    families: ['制造'],
    minYears: 1,
    eduRank: 4,
    ladder: ['调试助理', '自动化工程师', '自动化主管 / 项目负责人'],
    salary: { 一线: [9, 18], 新一线: [7, 13], 二线: [6, 11], 三线: [5, 9] },
    entry: '会调试一台设备，比会背理论更值钱；出差与驻场较多',
    certificates: ['无硬性证书'],
    gap: ['PLC 编程与 HMI 组态', '一种机器人示教（ABB/发那科）', '电气原理图与伺服调试'],
    demand: '制造业自动化改造持续缺人，薪资高于普通维修岗',
  },
  {
    key: 'quality-it',
    name: '质量体系 / 内审员',
    family: '制造',
    aliases: ['质量体系', '内审员', '体系工程师', 'ISO'],
    skills: ['ISO9001', 'IATF16949', '体系', '内审', '文件', '审核', '质量'],
    families: ['制造'],
    minYears: 1,
    eduRank: 4,
    ladder: ['体系专员', '体系工程师', '质量经理'],
    salary: { 一线: [8, 14], 新一线: [6, 11], 二线: [5, 9], 三线: [4.5, 7.5] },
    entry: '偏文职的技术岗，适合细心、擅长写文件的人',
    certificates: ['内审员证（建议考）'],
    gap: ['ISO9001 条款与审核技巧', '体系文件的编写与维护', '一次内部审核实操'],
    demand: '汽车零部件、医疗器械要求高，外资企业更看重',
  },
  {
    key: 'ecommerce-ops',
    name: '电商 / 新媒体运营',
    family: 'marketing',
    aliases: ['电商运营', '新媒体运营', '运营', '直播运营', '内容运营'],
    skills: ['运营', '电商', '淘宝', '抖音', '小红书', '文案', '直播', '投放', '数据分析'],
    families: ['marketing'],
    minYears: 0,
    eduRank: 3,
    ladder: ['运营助理', '运营专员 / 店长', '运营主管 / 操盘手'],
    salary: { 一线: [7, 15], 新一线: [6, 12], 二线: [5, 9], 三线: [4, 7] },
    entry: '入门宽松但淘汰快，能拿出账号数据或爆款案例才算数',
    certificates: ['无硬性证书'],
    gap: ['一个自己运营的账号或店铺', '基础数据复盘（点击率/转化率）', '文案与素材制作'],
    demand: '二三线城市也有本地商家需求，薪资天花板取决于业绩',
  },
  {
    key: 'sales-b2b',
    name: 'B2B 销售 / 客户经理',
    family: 'sales',
    aliases: ['销售', '客户经理', '大客户销售', '渠道销售', '业务员'],
    skills: ['销售', '客户开发', '拜访', '谈判', '回款', '渠道', '方案'],
    families: ['sales'],
    minYears: 0,
    eduRank: 3,
    ladder: ['销售代表', '客户经理', '区域经理 / 销售总监'],
    salary: { 一线: [6, 18], 新一线: [5, 14], 二线: [4.5, 11], 三线: [4, 9] },
    entry: '不看学历看结果，但前半年收入低、淘汰率高',
    certificates: ['无硬性证书'],
    gap: ['一份行业客户名单与拜访计划', '产品价值话术', '报价与合同流程'],
    demand: '所有行业都缺销售，关键在选对行业与产品',
  },
]

const careerByKey = new Map(CAREERS.map((career) => [career.key, career]))

const ALL_SKILLS = unique(CAREERS.flatMap((career) => career.skills)).sort((a, b) => b.length - a.length)

/** Skills that entail other skills: mentioning Vue already means JS/HTML/CSS. */
const SKILL_IMPLIES = {
  Vue: ['JavaScript', 'HTML', 'CSS', '前端'],
  React: ['JavaScript', 'HTML', 'CSS', '前端'],
  Angular: ['TypeScript', 'HTML', 'CSS', '前端'],
  'uni-app': ['Vue', '小程序', '前端'],
  小程序: ['JavaScript', '前端'],
  TypeScript: ['JavaScript'],
  JavaScript: ['HTML', 'CSS'],
  'Spring Boot': ['Java', 'Spring'],
  Spring: ['Java'],
  MyBatis: ['Java', 'SQL'],
  MySQL: ['SQL'],
  PostgreSQL: ['SQL'],
  Oracle: ['SQL'],
  'SQL Server': ['SQL'],
  SQL: ['Excel'],
  Linux: ['运维'],
  Docker: ['Linux'],
  Kubernetes: ['Docker', 'Linux'],
  PLC: ['自动化', '电工', '电气'],
  电气: ['电工'],
  数控: ['CNC'],
  加工中心: ['CNC'],
  UG: ['CAD'],
  SolidWorks: ['CAD'],
  'Pro/E': ['CAD'],
  模具: ['CAD'],
  注塑模: ['模具'],
  冲压模: ['模具'],
  低代码: ['实施'],
  ERP: ['实施', 'SQL'],
  MES: ['实施'],
  品质: ['质量', '检验'],
  'ISO9001': ['体系', '质量'],
  数据分析: ['Excel', 'SQL'],
  Excel: ['数据分析'],
  Python: ['脚本'],
}

function expandSkills(skills, text) {
  const out = new Set(skills)
  for (let pass = 0; pass < 2; pass += 1) {
    for (const skill of [...out]) {
      for (const implied of SKILL_IMPLIES[skill] || []) {
        if (ALL_SKILLS.includes(implied) || mentions(text, implied)) out.add(implied)
      }
    }
  }
  return [...out]
}

function detectSkills(text) {
  const hay = String(text || '')
  return ALL_SKILLS.filter((skill) => mentions(hay, skill))
}

function findCareer(name) {
  const wanted = String(name || '').trim()
  if (!wanted) return null
  const lower = wanted.toLowerCase()
  for (const career of CAREERS) {
    const names = [career.name, ...(career.aliases || [])]
    if (names.some((candidate) => candidate.toLowerCase() === lower)) return career
  }
  for (const career of CAREERS) {
    const names = [career.name, ...(career.aliases || [])]
    if (names.some((candidate) => lower.includes(candidate.toLowerCase()) || candidate.toLowerCase().includes(lower))) {
      return career
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function buildProfile(input = {}) {
  const text = [input.background, input.notes, (input.skills || []).join(' '), (input.jobs || []).join(' ')]
    .filter(Boolean)
    .join('\n')

  const skills = expandSkills(
    unique([...(input.skills || []).map((item) => String(item).trim()), ...detectSkills(text)]),
    text,
  )

  const years = typeof input.years === 'number' ? input.years : parseYears(text)
  const education = detectEducation([input.education, text].filter(Boolean).join(' '))
  const city = normalizeCityName(input.city) || detectCity(text)
  const families = unique([...detectFamilies(text)])
  const targetRaw = String(input.targetRole || '').trim()
  const target = findCareer(targetRaw)

  // Experience phrases: split into clauses and keep the ones that read like a job.
  const jobs = []
  const jobVerb = /干过|做过|从事|任职|工作了|在职|实习|兼职|打工|担任/
  const wishful = /希望|想|目标|打算|准备|考虑|计划|将来|以后|想要/
  const projectish = /在校|学校|校企|课程|毕设|毕业设计|项目|比赛|大赛|论文|社团/
  const skillish = /^(?:会用|会|熟悉|掌握|了解|精通|用过|没有|没做过|不会|都是|也|还)/
  const clauses = String(text || '').split(/[。；;\n]|(?<=[，,])/u).map((item) => item.trim())
  for (const clause of clauses) {
    if (!clause || clause.length < 2) continue
    if (wishful.test(clause)) continue
    const hasJobVerb = jobVerb.test(clause)
    if (!hasJobVerb && projectish.test(clause)) continue
    if (!hasJobVerb && skillish.test(clause)) continue
    if (!hasJobVerb && /没有|没做过|不会|没干过/.test(clause)) continue
    const looksLikeJob =
      hasJobVerb || EXPERIENCE_FAMILIES.some((family) => family.words.some((word) => mentions(clause, word)))
    if (!looksLikeJob) continue
    const cleaned = clause
      .replace(/^(?:我|本人)?(?:曾经|之前|以前|现在|目前)?(?:干过|做过|从事|任职|工作了|在职|实习过|兼职过|担任)/, '')
      .replace(/^(?:的|了)+/, '')
      .replace(/[，,。；;]+$/, '')
      .trim()
    if (cleaned.length < 2) continue
    jobs.push(cleaned.length > 26 ? `${cleaned.slice(0, 26)}…` : cleaned)
  }

  const degreeBlocked = education.rank > 0 && education.rank < 4

  const missing = []
  if (years === null) missing.push('工作年限')
  if (!skills.length) missing.push('会什么（技能/工具）')
  if (!education.label) missing.push('学历')
  if (!city) missing.push('所在城市 / 期望城市')
  if (!targetRaw) missing.push('是否有目标岗位（可选）')
  if (!jobs.length) missing.push('做过哪些工作')

  return {
    text,
    years,
    education,
    city,
    cityTier: cityTierOf(city),
    skills,
    families,
    targetRaw,
    target,
    jobs: unique(jobs).slice(0, 6),
    expectedSalary: String(input.expectedSalary || '').trim(),
    constraints: String(input.constraints || '').trim(),
    degreeBlocked,
    missing,
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const EDU_OK = (profile, career) => {
  if (!profile.education.rank) return 0.5
  return profile.education.rank >= career.eduRank ? 1 : profile.education.rank >= career.eduRank - 1 ? 0.6 : 0.2
}

function salaryHint(career, profile) {
  const band = career.salary[profile.cityTier] || career.salary['三线']
  return { min: band[0], max: band[1], tier: profile.cityTier, text: `${band[0]}–${band[1]}K/月` }
}

function scoreCareer(profile, career) {
  const matched = career.skills.filter((skill) => profile.skills.includes(skill))
  const missing = career.skills.filter((skill) => !profile.skills.includes(skill))

  const skillNeed = Math.min(career.skills.length, 4)
  const skillRatio = skillNeed ? Math.min(1, matched.length / skillNeed) : 0
  const expHit = career.families.some((family) => profile.families.includes(family))
  // "Same path" = the role is entirely inside what the person already does, not merely adjacent.
  const samePath = expHit && career.families.every((family) => profile.families.includes(family))
  const degree = EDU_OK(profile, career)
  const years = profile.years === null ? 0.6 : Math.min(1, profile.years / Math.max(1, career.minYears))
  const ladderGap = career.eduRank - (profile.education.rank || 4)

  let score =
    skillRatio * 34 +
    (expHit ? 24 : career.families.includes('sales') || career.families.includes('pm') ? 8 : 4) +
    degree * 14 +
    years * 12 +
    (profile.skills.length >= 4 ? 6 : 0)

  if (ladderGap >= 2) score -= 12
  if (career.minYears > 0 && profile.years !== null && profile.years < career.minYears) {
    score -= 6 * (career.minYears - profile.years)
  }
  // Someone who named a target wants to move: do not hand them their current job as the plan.
  if (samePath && profile.target && career.key !== profile.target.key) score -= 8
  // Bridge roles that use both the existing experience and the target direction.
  const targetFamilies = profile.target?.families || []
  const bridge =
    career.key !== profile.target?.key &&
    career.families.some((family) => profile.families.includes(family)) &&
    career.families.some((family) => targetFamilies.includes(family))
  if (bridge) score += 6
  score = Math.max(0, Math.min(100, Math.round(score)))

  const reasons = []
  if (matched.length) reasons.push(`已有技能命中：${matched.slice(0, 4).join('、')}`)
  if (expHit) reasons.push('过往工作与这个方向相通')
  if (profile.years !== null && profile.years >= career.minYears) reasons.push('年限达到入口要求')
  if (!matched.length && !expHit) reasons.push('目前没有直接对口的技能或经验')
  if (bridge) reasons.push('能把现有经历和目标方向接上（桥接岗）')
  if (missing.length) reasons.push(`还需补：${missing.slice(0, 3).join('、')}`)

  const bucket =
    score >= 62 ? '稳妥可投' : score >= 45 ? '可转型（需补齐）' : score >= 28 ? '长期目标（1–3 年）' : '暂不推荐'

  return { career, score, matched, missing, reasons, bucket, expHit, samePath, salary: salaryHint(career, profile) }
}

/**
 * Rank directions for the plan. A named target is always shown first (the user asked
 * about it), then the strongest alternatives by score with at most two "keep doing
 * what you already do" fallbacks.
 */
function recommendCareers(profile, limit = 4) {
  const scored = CAREERS.map((career) => scoreCareer(profile, career))
  const targetKey = profile.target?.key
  const targetEntry = scored.find((entry) => entry.career.key === targetKey) || null
  const others = scored
    .filter((entry) => entry.career.key !== targetKey)
    .sort((a, b) => b.score - a.score)

  const picked = []
  const targetFirst = targetEntry && targetEntry.score >= 30
  if (targetFirst) picked.push({ ...targetEntry, position: '目标方向' })

  let steadyUsed = 0
  for (const entry of others) {
    if (picked.length >= limit) break
    if (entry.score < 25) continue
    if (entry.samePath) {
      if (steadyUsed >= 2) continue
      steadyUsed += 1
      picked.push({ ...entry, position: '保底方向' })
      continue
    }
    picked.push({ ...entry, position: entry.score >= 45 ? '转型方向' : '长期方向' })
  }

  if (targetEntry && !targetFirst) picked.push({ ...targetEntry, position: '目标方向（当前不建议）' })
  if (!picked.length) {
    const fallback = others[0] || targetEntry
    if (fallback) picked.push({ ...fallback, position: '主推方向' })
  }
  if (!targetEntry && picked.length) {
    // No target was named: the strongest match is the recommendation itself, not a fallback.
    picked[0] = { ...picked[0], position: '主推方向' }
  } else if (!targetFirst && picked.length) {
    picked[0] = { ...picked[0], position: picked[0].samePath ? '保底方向' : '主推方向' }
  }

  return picked.slice(0, limit).map((entry) => ({ ...entry, bucket: bucketFor(entry) }))
}

function bucketFor(entry) {
  if (entry.position === '目标方向') {
    return entry.score >= 62 ? '目标方向·匹配度够' : '目标方向·需补齐'
  }
  if (entry.position?.startsWith('目标方向')) return '目标方向·当前不建议'
  if (entry.position === '保底方向') return '保底·现有路径'
  if (entry.position === '主推方向') return entry.score >= 62 ? '主推·匹配度够' : '主推·需补齐'
  if (entry.position === '转型方向') return '可转型·需补齐'
  if (entry.position === '长期方向') return '长期目标'
  return entry.bucket
}

function assessTarget(profile) {
  if (!profile.target) return null
  const scored = scoreCareer(profile, profile.target)
  const verdict =
    scored.score >= 62 ? '适合，可以直接按这个方向准备' : scored.score >= 48 ? '有条件适合，补齐关键缺口后可行' : scored.score >= 32 ? '需要较长准备期（6–12 个月）' : '暂不建议直接转，建议先走相邻岗位'
  return { ...scored, verdict }
}

// ---------------------------------------------------------------------------
// Interview questions
// ---------------------------------------------------------------------------

function careerQuestions(profile, answered = []) {
  const asked = new Set(answered)
  const bank = [
    {
      id: 'degree',
      when: () => !profile.education.label,
      question: '你的最高学历是什么？专业是什么？毕业几年了？',
      why: '学历和专业会直接决定哪些岗位的简历能过筛。',
    },
    {
      id: 'jobs',
      when: () => !profile.jobs.length,
      question: '你做过的每份工作分别是什么？各做了多久？其中哪部分你做得最顺手、哪部分最不想再干？',
      why: '过往经历里「顺手」的部分通常就是能迁移的能力，「不想再干」的部分决定要避开什么。',
    },
    {
      id: 'skills',
      when: () => profile.skills.length < 3,
      question: '你会哪些具体技能或工具？包括软件（CAD、Excel、PS…）、设备、证书，哪怕只是会用一点。',
      why: '技能清单是匹配岗位的核心输入，很多「会一点」的东西其实是加分项。',
    },
    {
      id: 'target',
      when: () => !profile.targetRaw,
      question: '你心里有没有想去的岗位或行业？为什么想去做这个？（没有也可以直接说没有）',
      why: '有目标可以帮你评估可行性；没有目标我会按你的能力给出几个方向。',
    },
    {
      id: 'city',
      when: () => !profile.city,
      question: '你现在在哪个城市？愿不愿意去外地或周边城市工作？能接受通勤多久？',
      why: '岗位密度直接受城市影响，同一个岗位在不同城市的机会可能差十倍。',
    },
    {
      id: 'salary',
      when: () => !profile.expectedSalary,
      question: '你对薪资的期望是多少？能接受的最低线是多少（前半年可以低一些吗）？',
      why: '期望薪资决定我们该瞄准哪些岗位，也用来判断转行期的收入缺口。',
    },
    {
      id: 'constraints',
      when: () => !profile.constraints,
      question: '工作上有什么硬性限制吗？比如能不能上夜班/倒班、能不能出差、体力活能不能干、家里是否需要照顾、有没有在考什么证？',
      why: '这些限制会筛掉一部分岗位，早知道能少走弯路。',
    },
    {
      id: 'learning',
      when: () => true,
      question: '如果要在下班后学新东西，你每周大概能投入多少小时？愿意花钱报班吗（预算多少）？',
      why: '规划必须和可投入的时间、预算匹配，否则就是空计划。',
    },
  ]

  const questions = bank
    .filter((item) => !asked.has(item.id) && item.when())
    .slice(0, 5)
    .map(({ id, question, why }) => ({ id, question, why }))

  questions.push({
    id: 'extra',
    question: '最后：还有什么要补充的吗？（家庭情况、身体条件、地域限制、讨厌做的事、特别想做的事，都可以说）',
    why: '真实规划常常被这些「没写进简历」的信息改变。',
  })

  return { questions, complete: questions.length === 1 }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const cell = (value) => String(value ?? '').replace(/\|/g, '／').replace(/\n/g, ' ').trim() || '—'

function formatYears(years) {
  if (years === null) return '未明确'
  return years === 0 ? '应届/无全职经验' : `${years} 年`
}

function tierNote(profile) {
  const tier = profile.cityTier
  const city = profile.city || '未填城市'
  const map = {
    一线: '一线城市岗位密度最高，但初级岗位竞争也最激烈，生活成本要计入',
    新一线: '新一线机会多、竞争小于一线，是转行常见落点',
    二线: '二线城市岗位以制造、本地服务、外包为主，纯互联网岗偏少',
    三线: '三线及以下城市岗位密度低，本地机会多集中在制造与本地服务，远程/外包/异地就业要一并考虑',
  }
  return `${city}（${tier}）：${map[tier]}`
}

function buildReport(profile, assessment, recommendations, options = {}) {
  const market = options.market || null
  const notes = options.notes || []
  const lines = []
  lines.push('# 职业规划报告')
  lines.push('')
  lines.push('## 一、个人画像')
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('|---|---|')
  lines.push(`| 工作年限 | ${formatYears(profile.years)} |`)
  lines.push(`| 学历 | ${cell(profile.education.label || '未明确')} |`)
  lines.push(`| 经历 | ${cell(profile.jobs.join('；') || '未明确')} |`)
  lines.push(`| 技能 | ${cell(profile.skills.slice(0, 8).join('、') || '未明确')} |`)
  lines.push(`| 目标岗位 | ${cell(profile.targetRaw || '未指定')} |`)
  lines.push(`| 城市 | ${cell(profile.city || '未明确')} |`)
  lines.push(`| 薪资期望 | ${cell(profile.expectedSalary || '未明确')} |`)
  if (profile.constraints) lines.push(`| 限制条件 | ${cell(profile.constraints)} |`)
  lines.push('')
  lines.push(tierNote(profile))
  lines.push('')

  if (assessment) {
    lines.push('## 二、目标岗位是否合适')
    lines.push('')
    lines.push(`**结论：${assessment.verdict}**（适配度 ${assessment.score}/100）`)
    lines.push('')
    lines.push(`- 岗位：${assessment.career.name}`)
    lines.push(`- 入口要求：${assessment.career.entry}`)
    lines.push(`- 薪资参考：${assessment.salary.text}`)
    if (assessment.matched.length) lines.push(`- 匹配点：${assessment.matched.join('、')}`)
    if (assessment.missing.length) lines.push(`- 主要缺口：${assessment.missing.slice(0, 5).join('、')}`)
    if (assessment.career.gap?.length) lines.push(`- 补齐建议：${assessment.career.gap.slice(0, 3).join('；')}`)
    lines.push('')
  } else {
    lines.push('## 二、目标岗位是否合适')
    lines.push('')
    lines.push('本次没有指定目标岗位，因此直接按画像给出方向（如果你有目标，告诉我岗位名，我会单独评估它的可行性）。')
    lines.push('')
  }

  lines.push('## 三、推荐方向')
  lines.push('')
  lines.push('| 方向 | 定位 | 匹配度 | 结论 | 为什么适合 | 起薪参考 | 需要补齐 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const entry of recommendations) {
    lines.push(
      `| ${cell(entry.career.name)} | ${cell(entry.position || '')} | ${entry.score} | ${cell(entry.bucket)} | ${cell(entry.reasons.join('；'))} | ${cell(entry.salary.text)} | ${cell(entry.missing.slice(0, 2).join('、') || '无')} |`,
    )
  }
  lines.push('')

  // A fallback direction can outscore the primary one, because the score counts
  // "you can reuse what you already have". Say so instead of letting the numbers
  // argue on their own.
  const lead = recommendations[0]
  const ahead = lead ? recommendations.slice(1).filter((entry) => entry.score > lead.score) : []
  if (ahead.length) {
    const names = ahead.map((entry) => `${entry.career.name}（${entry.score}）`).join('、')
    lines.push(
      `> 注意：${names} 的匹配度高于主方向 ${lead.career.name}（${lead.score}）。匹配度里算进了「现有经历能不能直接用上」，所以分数高只说明这条路起步更省力，不代表更适合你；主方向仍按你的目标和长期收益来定。`,
    )
    lines.push('')
  }

  const primary = recommendations[0]
  const backup = recommendations[1]
  if (primary) {
    lines.push('## 四、路线规划')
    lines.push('')
    lines.push(`**主路线：${primary.career.name}**（${primary.position || '目标方向'}）`)
    lines.push('')
    lines.push(`- 0–3 个月：${primary.career.gap[0] || '补基础技能'}；同时做 1 个能拿出手的成果`)
    lines.push(`- 3–12 个月：${primary.career.gap[1] || '进入目标岗位'}；目标是从助理/初级岗切入`)
    lines.push(`- 1–3 年：${primary.career.ladder[1] || '做到中级'}；${primary.career.ladder[2] ? `长期可到 ${primary.career.ladder[2]}` : '再决定是否转管理'}`)
    if (backup) {
      lines.push('')
      lines.push(`**备选路线：${backup.career.name}**（匹配度 ${backup.score}，${backup.bucket}）`)
      lines.push('')
      lines.push(`- 与主路线共用基础能力，变量是：${backup.missing.slice(0, 2).join('、') || '积累经验'}`)
      lines.push(`- 如果主路线 3 个月内没有面试机会，优先切到这条，先就业再图发展`)
    }
    lines.push('')
  }

  lines.push('## 五、能力差距与补齐清单')
  lines.push('')
  const focus = recommendations.filter((entry) => /目标|主推|转型/.test(entry.position || ''))
  const gapSource = (focus.length ? focus : recommendations).slice(0, 2)
  const gapSkills = unique(gapSource.flatMap((entry) => entry.missing)).slice(0, 6)
  if (gapSkills.length) {
    lines.push(`- 技能：${gapSkills.join('、')}`)
  }
  if (primary) {
    lines.push(`- 作品/项目：${primary.career.gap?.[1] || '做一个与目标岗位直接相关的完整成果'}`)
    const certs = (primary.career.certificates || []).filter((cert) => !cert.includes('无硬性'))
    if (certs.length) lines.push(`- 证书：${certs.join('、')}`)
  }
  lines.push('- 学习投入：优先用免费资源（B 站/YouTube + 官方文档）搭骨架，再决定是否付费系统学')
  if (profile.degreeBlocked) {
    lines.push('- 学历：目前学历会让一部分岗位在筛选阶段被挡，优先投「学历不限/经验优先」的岗位，或同步考虑专升本/成考')
  }
  lines.push('')

  lines.push('## 六、市场参考')
  lines.push('')
  if (market && market.roles?.length) {
    lines.push('| 方向 | 本地在招样本 | 薪资区间（月） | 观察 |')
    lines.push('|---|---|---|---|')
    for (const item of market.roles) {
      lines.push(
        `| ${cell(item.role)} | ${item.samples} 条 | ${item.min ? `${item.min}–${item.max}K` : '未取到'} | ${cell(item.note || '')} |`,
      )
    }
    lines.push('')
    lines.push('样本来自公开搜索结果的岗位标题与摘要，未逐条核实，仅作方向性参考；要精确数据用 `job_search`。')
    if (notes.length) lines.push(...notes.map((note) => `- ${note}`))
  } else {
    lines.push('本次未抓取招聘市场数据。需要真实在招岗位与薪资样本时，可以重新调用并设置 `market: "quick"`，或用 `job_search` 查具体岗位。')
    if (notes.length) lines.push(...notes.map((note) => `- ${note}`))
  }
  lines.push('')

  lines.push('## 七、风险与提醒')
  lines.push('')
  const risks = []
  if (profile.cityTier === '三线' || profile.cityTier === '二线') {
    risks.push('本地岗位密度有限：目标岗位在本地可能只有个位数机会，需要考虑周边城市、远程或外包驻场')
  }
  if (profile.target && assessment && assessment.score < 62) {
    risks.push(`目标岗位目前匹配度不足（${assessment.score}），裸辞脱产转行的风险较高，建议先在职准备`)
  }
  if (primary && primary.missing.length >= 3) {
    risks.push('技能缺口超过 3 项，容易陷入「学不完」的状态，先锁定 1–2 个能立刻用上的技能')
  }
  risks.push('警惕「包就业/培训贷」类机构：先交钱的转行课，签约前一定看合同里的退款条款')
  if (profile.years !== null && profile.years < 1) {
    risks.push('工作年限短，简历上要用项目成果补经验，不要只写「负责…」')
  }
  lines.push(...risks.map((risk) => `- ${risk}`))
  lines.push('')

  lines.push('## 八、还需要确认')
  lines.push('')
  if (profile.missing.length) {
    lines.push(...profile.missing.map((item) => `- ${item}`))
  } else {
    lines.push('- 暂无关键缺失信息；如果要更精确（比如具体薪资底线、能否出差），可以继续补充')
  }
  lines.push('')

  if (primary) {
    lines.push('## 九、下一步（7 天内可做）')
    lines.push('')
    lines.push(`1. 用 1 天时间确认 ${primary.career.name} 在本地及周边的真实岗位数量（可用 job_search 查）`)
    lines.push(`2. 补齐「${primary.missing[0] || primary.career.gap[0] || '基础技能'}」，做出第一版成果`)
    lines.push('3. 把简历改成「成果导向」，每个项目写清做了什么、用了什么、结果如何')
    lines.push('')
  }

  lines.push('---')
  lines.push('数据来源与局限：职业路径与薪资区间来自公开行业区间与本工具知识库，按城市等级估算；市场参考仅取公开搜索摘要。真实决策前请以招聘平台在招信息与面试反馈为准。')
  lines.push('')

  return lines.join('\n')
}

export {
  CAREERS,
  EXPERIENCE_FAMILIES,
  ALL_SKILLS,
  assessTarget,
  buildProfile,
  buildReport,
  careerQuestions,
  cityTierOf,
  detectCity,
  detectEducation,
  findCareer,
  parseYears,
  recommendCareers,
  scoreCareer,
}
