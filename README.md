# job-hunting

给 Agent 用的求职插件：一条线是**跨招聘网站搜集岗位**，并用浏览器打开详情页、模拟真人浏览后核实「是否还在招」；另一条线是**根据用户画像做职业推荐与职业规划**，产出可直接交付的报告。

## 安装

零第三方依赖，装进当前 DSH profile 即可（三个工具会出现在 Agent 的工具列表里）：

```bash
git clone https://github.com/<你的账号>/dsh-plugin-job-hunting.git
```

然后在 DSH 里让 Agent 安装这个目录，或直接调 `plugin_manager`：

```json
{ "action": "install_bundle", "target": "<clone 下来的目录的绝对路径>" }
```

也可以用 git 地址形式（仓库根目录就是包根目录，`package.json` 里声明了 `dsh.bundle.patch`），凡是接受 pnpm/git spec 的安装入口都能直接用：

```
github:<你的账号>/dsh-plugin-job-hunting
```

安装后 profile 里会多出一行 `job-hunting`；报告默认写到进程工作目录，想固定位置就在 profile 的 `cordis.patch.yml` 里给它加 `config.reportDir`。卸载：`plugin_manager` 的 `remove_bundle`，target 用 `dsh-plugin-job-hunting`。

## 工具

| 工具 | 必填参数 | 可选参数 | 用途 |
|---|---|---|---|
| `job_search` | `keyword` 或 `resumePath`（至少一个） | `city`、`experience`、`resumePath`、`maxResults`、`freshnessDays`、`verifiedOnly` | 按职位关键词 + 城市 + 经验搜集在招岗位；给了简历就按简历匹配 |
| `career_plan` | `background` | `city`、`targetRole`、`expectedSalary`、`education`、`years`、`market`、`maxRecommendations` | 画像 → 目标岗位评估 + 职业推荐 + 职业规划报告 |
| `career_interview` | 无 | `background`、`answered` | 按已缺字段生成访谈问题，供问完后回流 `career_plan` |

表格列：`# | 岗位名称 | 公司 | 城市 | 薪资 | 经验 | 发布时间 | 信息来源（状态） | 链接`。
状态取值：`在招·已核实`（详情页结构化数据或正文可读）、`未核实`（站点验证墙 / 信息不足）。
默认口径：只要 **7 天内**发布的岗位；已核实结果优先，未核实条目只在已核实不足时补位，**最多 2 条**（`verifiedOnly: true` 可完全排除）。

## Agent 使用约定

工具返回的内容会显示在界面的工具结果卡片里，长结果可能被折叠。所以调用之后：

- `job_search`：把结果表格**原样贴进回答正文**，不要只给「找到 N 条」的摘要，否则用户会以为没有结果；同时点明哪些条目是「未核实」。
- `career_plan`：把报告正文（结论、推荐方向表、文件路径）贴进回答，不要只丢一个 `.docx` 路径。
- 用户给的是**简历文件**（`.docx` / `.pdf` / `.txt` / `.md`）时：调 `job_search` 直接把文件路径放进 `resumePath`，插件自己解析并参与打分；要出职业规划报告，则把简历要点写成 `background` 交给 `career_plan`（或先读文件再拼）。

## 简历解析（job_search 的 resumePath）

给 `job_search` 传 `resumePath`（`.docx` / `.pdf` / `.txt` / `.md`）后，插件自己把简历读成纯文本再提取画像，不需要 Agent 先转格式：

- `.docx`：按 ZIP 解析中央目录，读 `word/document.xml` 去标签（零依赖，不用 unzip 库）。
- `.pdf`：扫 `stream … endstream`，`FlateDecode` 走 zlib（先 `inflateSync`、失败回退 `inflateRawSync`），从 `Tj` / `TJ` / `'` 操作符里取字面量与十六进制字符串；Word/WPS 导出的 CID 字体（`Type0` / `Identity-H`）会按**每个字体自己的 `ToUnicode` CMap** 把字形码还原成中文（`bfchar` 与 `bfrange` 的数组写法、递增写法都支持），并且按 `/Fx n Tf` 跟踪当前字体，避免不同子集的相同编码互相串字。
- 提取字段：技能（约 150 个词表 + 技能蕴含，如 Vue → JavaScript/HTML/CSS）、工作年限（显式「N 年经验」优先；学生简历的教育/项目区间不计入，`应届/在校` 判 0）、学历、城市（含芜湖等地级市）、岗位线索（软件测试 / 车载测试 / 自动化测试…）。
- 怎么用：技能并入检索词、参与 `scoreJob` 加分（理由里写「简历技能对得上 …」）；没给 `keyword` 时用简历里的岗位线索或技能检索；没给 `city` 时用简历里的城市；没给 `experience` 时用简历年限做软性判断，不做硬过滤。
- 结果上方会有一行 `> 按简历匹配：…`，说明里也会写解析摘要。

限制：图片/扫描版 PDF（没有文字层）读不出内容，会直接报「简历里没有读到文字…请换成文字版」；PDF 若没有 `ToUnicode` 表（罕见，一般出现在某些打印驱动导出的文件里），中文仍可能取不到，这时换 `.docx` 最稳。


## 职业规划（career_plan / career_interview）

画像有两个来源，插件不替用户选路径：

- 用户能自述 → 直接把 `background` 交给 `career_plan`（干过哪些工作、专业、会什么、目标岗位可选、城市、期望薪资）。
- 用户说不清 → 先调 `career_interview`，把问题原样问给用户，拿到回答后再调 `career_plan`。问题按缺失字段生成（学历 / 经历 / 技能 / 目标 / 城市 / 薪资 / 限制 / 学习投入），最后一条固定是「还有什么要补充的吗」。

`career_plan` 输出的是 Markdown 报告，不是岗位列表，九节：个人画像 → 目标岗位是否合适（给了 `targetRole` 才评估，同时仍给推荐方向）→ 推荐方向（目标 / 转型 / 保底 / 长期，附匹配度、为什么适合、起薪参考、需要补齐）→ 路线规划（0–3 月 / 3–12 月 / 1–3 年 + 备选路线）→ 能力差距与补齐清单 → 市场参考 → 风险与提醒 → 还需要确认 → 7 天内下一步。

- 报告同时落盘三个文件（默认目录是进程工作目录，可用配置 `reportDir` 改）：`career-plan-<时间戳>.docx`（Word，零依赖手写 OOXML + ZIP，含标题层级、表格边框、项目符号）、`.md`（源文本）、`.html`（自包含样式，浏览器可直接看）；绝对路径分别在返回值 `docxPath` / `reportPath` / `htmlPath`。
- 匹配度里含「现有经历能不能直接复用」的加权，所以保底方向有可能比目标方向分高；报告会在表格下注明这一点，避免把分数当成「更适合」。

- `market: "quick"`（默认）按前 3 个方向各做一次公开搜索，用岗位标题与摘要估本地样本量和薪资区间；`market: "off"` 不联网，纯画像分析。
- 职业库是插件内置的 25 个职业（前端 / 低代码 / 后端 / 测试 / 运维 / 技术支持 / 数据 / 产品 / 模具维修 / 模具设计 / 数控 / 设备维护 / 质量 / 工艺 / 结构设计 / 技术销售 / 项目 / 供应链 / 生产 / 电工 / 自动化等），每个方向带薪资区间、晋升阶梯、入口要求和常见缺口；城市按一线 / 新一线 / 二线 / 三线取薪资档。这是知识库估算，不是实时行情，报告里会写明；要精确在招岗位仍用 `job_search`。

## 流水线

1. 按站点拼 `site:<host> 关键词 城市 经验` 查询，并发调用 `ctx.web.search`；
2. URL 归一化，只保留详情页（列表页、聚合页、首页一律丢弃）；
3. 核实（hybrid）：
   - **需要渲染的站点（国聘、BOSS直聘、前程无忧）先用无头 Edge/Chrome 打开**：CDP 驱动、移动鼠标 + 滚动两次模拟真人，等 `readyState === 'complete'` 后再取 title / innerText / outerHTML；
   - 猎聘、智联用 HTTP 抓取（更快，且这两家对自动化浏览器有额外风控）；
   - HTTP 遇到空壳 / 验证页 / 无法访问时，自动回落到浏览器再试一次；
4. 解析内容：优先 `application/ld+json` 的 `JobPosting`（标题/公司/城市/薪资/经验/学历/发布时间），无结构化数据时用 `<title>`（`职位-公司-站点` 拆解）+ 正文 + 可见文本兜底；
5. 判定状态：命中关闭词（含国聘的「报名结束」）或 `validThrough` 过期 → 已关闭；命中验证墙词（安全验证、滑动验证、IP 异常…）或没有岗位内容 → 未核实；否则在招；
6. 过滤：已关闭、疑似虚假（押金/培训费/刷单等关键词）、超过 `freshnessDays`、城市不符、信息严重缺失；
7. 打分排序：关键词命中、城市、经验年限、核实状态、发布新鲜度、薪资与期望重叠、公司缺失、人力/外包机构（扣分并提示确认用工单位）、垃圾关键词惩罚；
8. 选取结果：已核实条目优先，未核实条目仅在不足时补位（默认最多 2 条），再按分数取前 `maxResults` 条。

浏览器是**一个标签页、串行**使用（并发请求排队），每次核实约 3–8 秒；默认最多用浏览器核实 16 条（`browserLimit`），因此一次调用可能耗时 1–2 分钟；想快可在配置里调小。

## 数据源核实能力（实测，2026-10-30）

| 站点 | 核实方式 | 结果 | 说明 |
|---|---|---|---|
| 猎聘 | HTTP | ✅ 结构化 | JSON-LD `JobPosting` 字段完整，唯一能严格结构化的源；自动化浏览器会被站点自救跳转/验证码 |
| 智联招聘 | HTTP | 部分 | 无 `JobPosting`，靠 `<title>` + 正文；城市常来自周边推荐块，取不到就留空 |
| 国聘网 | 浏览器渲染 | ✅ 可读 | HTTP 只有 SPA 空壳；渲染后能拿到正文与「报名结束」等状态，是浏览器核实的主力场景 |
| BOSS直聘 | 浏览器渲染 | ❌ 验证墙 | 详情页直连返回「请稍候」；浏览器打开也会跳到「安全验证 / IP 地址可能存在异常」（IP 级风控），只能标未核实 |
| 前程无忧 | 浏览器渲染 | ❌ 验证墙 | HTTP 是阿里云 WAF 挑战页；浏览器打开是滑块验证，无法自动通过 |

因此搜索结果里「来源」标注了站点与状态：验证墙拦下的条目仍展示但标「未核实」，由使用方提示用户自行确认。

## 配置

`cordis.patch.yml` 以空配置插入；插件内 `DEFAULTS` 提供以下基线，工具参数或行配置可覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `freshnessDays` | 7 | 只要多少天内发布的岗位 |
| `maxResults` / `perSiteLimit` | 10 / 8 | 输出条数 / 每个站点取多少条搜索结果 |
| `timeoutMs` / `concurrency` | 9000 / 4 | HTTP 抓取超时、并发 |
| `verifyLimit` | 24 | 单次最多核实多少条详情页 |
| `includeUnverified` / `unverifiedCap` | true / 2 | 是否保留未核实条目 / 最多补位几条 |
| `browserEnabled` | true | 关掉后只用 HTTP 核实 |
| `browserHeadless` | true | 有头模式便于人工观察或临时过验证 |
| `browserTimeoutMs` / `browserLimit` | 15000 / 16 | 单个页面渲染超时 / 最多用浏览器核实几条 |
| `browserSites` | `iguopin`、`zhipin`、`51job` | 哪些站点优先走浏览器 |

`browserSites`、`browserEnabled`、`browserLimit` 等都可以在 profile 的 `cordis.patch.yml` 里通过 `config:` 覆盖。

## 依赖与限制

- `index.js` / `resume.js` / `careers.js` / `docx.js` 都不依赖第三方包，只用 `node:https` / `node:http` / `node:zlib` / `node:child_process` / `node:fs`，避免 bundle 的模块解析问题。
- 浏览器核实需要一个本机 Edge/Chrome：默认找 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，找不到会打印「浏览器核实不可用」并自动退回 HTTP。
- 每次核实用独立临时 user-data-dir（`mkdtemp(%TEMP%/dsh-job-hunting-*)`），不复用上一次的目录，避免残留的 DevToolsActivePort 指向死端口；跑完即关闭进程并删目录。
- 验证码、滑块、IP 级风控不做绕过尝试：识别到验证墙就标「未核实」并写明原因。

## 维护

- 本地冒烟：`node ../tools/smoke.mjs`（桩搜索 + 真实详情页抓取 + 浏览器核实）。
- 实页回归：`node ../tools/real-check.mjs`（只桩搜索，抓真实猎聘/智联/国聘页面）。
- 口径回归：`node ../tools/check-caps.mjs`（7 天新鲜度、已核实优先、未核实最多补位 2 条、`verifiedOnly` 生效、`career_plan` 产出报告）。
- 职业规划回归：`node ../tools/career-check.mjs`（画像解析、目标岗位评估、推荐方向定位、访谈最后一问、`answered` 去重）。
- 简历解析回归：`node ../tools/resume-check.mjs`（docx/txt 抽取、学历/城市/年限、错误分支）；`node ../tools/resume-search.mjs`（`job_search` + `resumePath` 端到端、缺失文件报错）；`node ../tools/pdf-probe.mjs`（自造 Flate 压缩 PDF，验证 PDF 分支）。
- 浏览器探针：`node ../tools/cdp-probe.mjs [--headful] <url>`（直接看某个站点渲染后的标题与正文，排查核实判定）。

## 改代码的约定

改这个插件的源码时，按下面四条来，可以避免「文件在读取之后被改过（file changed since it was read）」这类编辑被拒：

1. **默认只用编辑工具改代码**（`edit` / `write`），不要用 `python - <<'PY'`、heredoc、`>` 重定向直接覆盖源文件。shell 写入不会更新编辑工具记的内容版本，下一步 `edit` 必然被拒。
2. **要整段替换就先写块文件再拼**：把新代码写到 `tools/` 下的临时块文件，用一次性 node 脚本做 splice，**splice 后立刻重新读一次目标文件**，再做后续 `edit`。块文件用完删掉，别留在插件目录里。
3. **同一个文件不并发改**：多条改动合成一次 `edit`，或严格串行；不要一边脚本写、一边工具写同一个文件。
4. **改之前先读**：没读过或读过之后又变了的文件，先 `ops_read_files` 再改。读是工具侧的前置条件，不是形式。

