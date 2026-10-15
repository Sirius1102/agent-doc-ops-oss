# Agent文档操作（dockit）

本机通用文档处理装置：把 [`@deepseek-ai/libreoffice-kit`](https://github.com/deepseek-ai/dsh-libreoffice-kit)（DeepSeek 开源，MPL-2.0，预编译 LibreOffice 引擎）包成**绝对路径 + 一条命令 + 一份 JSON**，让本机任何一个 agent（Qoder / ZCode / Codex / LobsterAI / DeepSeek Harness / WorkBuddy / TraeWork…）不需要读源码就能转换、渲染、重算、体检、清洗元数据（OOXML/ODF/PDF 三面）、抽媒体、批量转换、拼拆 PDF、填写 PDF 表单（v2.5.0）与外发前的隐藏内容/外链/内嵌对象/宏体检（v2.6.0），并在交付前拿到**字体缺字**与**元数据**两类自曝证据。

版本 v3.0.1 ｜ 权威文档：本 README（命令面总表）+ `docs/adr/`（关键设计决策）。用法纪律：输入文件只读、产物只落 `_out/`、永不覆盖已有文件。

## 一行调用

```bat
node <REPO>\dockit.js <命令> [参数...]
```

其中 `<REPO>` 是本仓克隆后的目录（见「安装与复现」）。或走同目录 `dockit.bat`（同一件事，少敲 node 与路径）：

```bat
<REPO>\dockit.bat doctor
```

退出码 `0` 成功 / `1` 失败；失败时 stdout 那一行 JSON 带 `code`（kit 的失败码）与 `next`（下一步该干什么）。**不会覆盖任何已有文件，也不会改动输入文件。**

## 命令

| 命令 | 干什么 | 例子 |
|---|---|---|
| `doctor` | 环境自证：Node≥22.19、kit 与平台引擎包在位、`capabilities` 与代码内能力矩阵对账、`_out/_tmp` 可写、字体目录可读、**替身字体哨兵（v1.7.2 起按 `test/font-manifest.json` 的 146 件核全量并自报"已核 N"——135 件替身＋2026-10-10 装载的 11 件常用中文字库；清单标定的机器不是本机时降 WARN，不判红）**、VC++ v14 运行库在位、**Tesseract 与中文语言包两条哨兵（`tesseract-ocr`／`ocr-lang-pack`：chi_sim 在不在**本次解析到的**那个 tessdata）**、OfficeCLI 写后端在位、**v1.9.0 再加两条：`pdf-lib-in-place`（FAIL 类）与 `aux-tools(pandoc/poppler)`（WARN 类）；v2.1.0 补 `poppler-pdf-text-media`（WARN 类：pdftotext/pdfimages 是 pdftext/media 的命令面依赖），v2.3.0 补 `pandoc-markdown`（WARN 类：pandoc 是 markdown 命令后端）；v2.5.0 补 `fontkit-in-place`（FAIL 类：pdfform 的中文字段值嵌字体）** | `dockit.bat doctor` |
| `to` | 转换。按输出后缀路由，输出路径省略时落 `_out/` 并自动去重；**非对齐 OLE 输入自动副本对齐修复并自报 `inputRepair`（v1.8.0）** | `dockit.bat to D:\报告.docx`（出 PDF）；`to D:\报告.docx D:\报告.txt`；`to D:\簿.xlsx D:\表.csv --sheet 第二页` |
| `pages` | 渲染 PNG 逐页图 + manifest + **每页非白像素占比**（证明字真画出来了，不是空白页）；非对齐 OLE 自动副本对齐修复同 `to`（v1.8.0） | `dockit.bat pages 报告.docx --pages 1,3 --dpi 96` |
| `ocr` | Tesseract 文字识别（**外部依赖**，v1.4.0 起，ADR-001）：PNG 单图或 PDF（先渲染 PNG 再逐图识别），逐页行数/字符数/非白像素占比自曝，并报**本次真用的那个目录**里的语言清单（`langCount`/`langs`，`--tessdata-dir` 换了跟着换）；缺引擎回 `unavailable`＋指路（`DOCKIT_TESSERACT`/`DOCKIT_TESSDATA` 可覆盖路径），空结果是数据不是错误 | `dockit.bat ocr 图.png --lang eng`；`ocr 报告.pdf --pages 1,3 --lang chi_sim --tessdata-dir <含 chi_sim 的目录>` |
| `sheets` | 列工作表名。`zip` 路线直接读 OOXML（不起引擎），`render` 路线让引擎自报；`auto` 会自报用了哪条 | `dockit.bat sheets 簿.xlsx` |
| `inspect` | 体检：按 magic bytes 认容器（**不信后缀**）、可转换矩阵、声明的字体族、元数据字段**形状**（字段名+长度，不回显正文）。输入是 **PDF** 时另出纯 JS（pdf-lib，不起引擎）的 `pdf` 结构块：页数、逐页尺寸/方向/旋转、加密状态、**字体嵌入与 CJK 判定**（`fontSummary.unembedded/cjkEmbedded`，中文交付前查"换机会不会变豆腐块"）、**交互表单探测**（`interactive.form='AcroForm'`＋`formFields` 字段数；含表单时 `formAdvice` 点名 combine/split 拼拆会丢表单，见项目总览 §八#25；无表单为 `null`），读不通只在该子块降级。`--deep` 附真实转换的 `missingFonts` | `dockit.bat inspect 报告.docx --deep`；`dockit.bat inspect 报告.pdf` |
| `recalc` | 整簿重算公式（公式保留、值刷新）。`--verify` 逐格对比重算前后的缓存值（**只吃 ZIP 容器 xlsx/ods**；`.xls` 这类 OLE 二进制去掉 `--verify` 直算，或先 `to` 成 xlsx 再 verify） | `dockit.bat recalc 簿.xlsx --verify` |
| `scrub` | 清元数据，**v1.6.0 起 OOXML 与 ODF、v2.5.0 起再加 PDF 面（三族都吃）**：OOXML 清 `docProps`（作者/标题/主题/关键词/最后修改者/公司/模板…）；ODF 清 `meta.xml` 九个目标字段 **＋删 `Thumbnails/thumbnail.png`**（那是第一页的渲染图＝版面内容）。回写**保序、逐条目沿用原包 method**（ODF 规范要求 `mimetype` 首位 + stored；本机引擎实测不拒违规包，所以这条只能自己守，`dump` 能看见）。**PDF 面（v2.5.0）**：清 `/Info` 目标键＋摘除 XMP（`/Metadata`）——**写新文件、非就地**；无元数据/撞车回 `invalid-output`。`--verify`：OOXML/ODF 转成 PDF 后按固定探针清单回查零残留；PDF 面改为重装载产物**结构回查＋明文令牌扫描**双尺 | `dockit.bat scrub 报告.docx --verify`；`scrub 笔记.odt`；`scrub 报告.pdf` |
| `dump` | **包的形状自述，全程不起引擎**（v1.6.0 起）：默认只出部件清单（名字/压缩方法 stored·deflate/压缩前后字节/记录 CRC）+ 每个 XML 部件的**元素与属性计数及其名字**；正文要显式 `--text` 才给，且**元数据部件（`docProps/*`、`meta.xml`）永远只给形状**。三条上限（形状 60 种、扫描 4 MB、正文 300 条）超限一律自报 `truncated`。`--part` 点名单部件，名字写错走候选 | `dockit.bat dump D:\报告.docx`；`dump 报告.pptx --part ppt/slides/slide1.xml` |
| `factcheck` | **核文档里写死的时点事实**（v1.6.0 起）：`rev-list --left-right --count` 的左右列语义（**左列＝落后**）、条数与文件计数的现场值、行数的两种口径（`wc -l` 与编辑器行数）、否定式断言现场跑一遍。逐条判 对／错／口径不唯一／无从核对，🔴 **《迭代日志》里的旧数字按"时点记录"豁免**（与 `doc 卫生` 同一把尺），但语义类写反在哪儿都判错。默认只报数不红，`--strict` 才当闸门。**v2.6.0 起 `--refs`**：给 `文件:行` 型引用做体检——文件在不在、行号越不越界各判一条，并带出那一行现在的 60 字（`lineText`）给人眼对；🔴 **插行推漂但仍界内的这一面判不了**，装置不宣称"引用都还对"（这正是《通用文档纪律》记的那类静默错）；默认不开，开了以后日志里的旧引用走与条数同一支豁免 | `dockit.bat factcheck`；`factcheck --doc 交接件.md --strict`；`factcheck --refs` |
| `verify` | **同源两条取字路线对账**（v1.6.0 起，起引擎）：A=文本层直提（`to txt`），B=渲染层（`pages`→Tesseract 逐页）。报逐页匹配数/行数/非白像素占比、只在 A 出现的行（字形没画出来／缺字）、只在 B 出现的行（幻影）。匹配按**贪心子序列比例**（对 OCR 的换行切分不敏感，只对"这个字在不在、顺序对不对"敏感）；默认只给计数与行号，行文本要显式 `--show`。PDF 只能走渲染半条 ⇒ 自报 `mode:render-only` 且 `clean:null` | `dockit.bat verify 报告.docx --lang chi_sim --tessdata-dir <含 chi_sim 的目录>` |
| `check` | **外发前的形状体检，全程不起引擎、不写盘**（v1.6.0 起；**v2.6.0 起也吃 PDF**）：十三族＝① 出域元数据字段（只给字段名+字节长度，**值不回显**）② 公式错误值的陈旧缓存（`t="e"` 与 `#REF!`/`#DIV/0!` 两种入口）③ 缺替代文字（docx 的 `wp:docPr`、pptx 图片的 `p:cNvPr`；`descr` 只写空格也算缺）④ 空表/空页 ⑤ 包体 CRC 打架复用装置既有的逐条实算 ⑥ **隐藏内容**（docx `w:vanish`/`w:webHidden`、xlsx 隐藏表与隐藏行列、pptx 隐藏页、ODF `table:visibility`/表样式 `table:display="false"`、PDF 的 OCG 图层）⑦ **外部引用**（`TargetMode="External"` 关系、xlsx 外部工作簿、ODF 绝对 `xlink:href`、PDF 的 `/URI`·`/GoToR`·`/Launch`——**目标一律不回显**，地址里可能带用户名与内网主机名）⑧ **内嵌对象**（`*/embeddings/`、ODF `Objects/`、PDF `/Type /EmbeddedFile`）⑨ **宏与脚本**（`vbaProject.bin` 与 `macroEnabled` 内容类型、ODF `Scripts/`·`Basic/`、PDF `/S /JavaScript`·`/AA`·文档级脚本）⑩ **自定义 XML/属性**（`customXml/`、有值的 `docProps/custom.xml` 属性）⑪ **表单字段**（PDF 的 AcroForm 字段数与 XFA 在位）。`--kind` 按族过滤，**过滤态下 `clean` 恒为 false**；报告自报 `kindsApplicable`／`kindsNotApplicable`（**不适用＝明说没查**，不冒充查过）与 `findingsCap`／`findingsTruncated`（清单封顶 200 条，`counts` 恒权威）；🔴 PDF 面有**结构自证**：`/Root` 取不到或页树读不通就 `invalid-document`（pdf-lib 对坏件 load 不抛、返回空壳，少了这层会把坏件洗成 `clean=true`），加密件 `unsupported-format`（不绕加密）；`--backend officecli`（v1.6.0 R6）另跑一次上游 OpenXML schema 校验并把结论并进 `schema` 段——**后端不在位只加一条 warning，`clean` 与退码都不变**（PDF 上这一面不适用，只加 warning）；OLE 在起引擎之前即 `unsupported-format` | `dockit.bat check D:\报告.docx`；`check 报告.pdf`；`check 报告.docx --kind hidden-content,external-link`；`check 合同.docx --backend officecli` |
| `edit` | **写操作**（v1.6.0 R6，后端 OfficeCLI，边界与准入见 `docs/adr/ADR-002-…`）：`edit <输入> <set\|add\|remove> <元素路径> [--prop k=v[,k=v]] [--type 名] [--out 文件]`。🔴 承重 1 的守法形状＝**第一步 copyfile 成 `_out/<名>-<UTC时间戳>-work.<ext>`，后端只碰副本**；操作前后各算一次**原件** sha256，不一致立刻 `code:'failed'` 停手。写完由**装置自己**解 ZIP（解开 XML 实体后）找写进去的值——后端的 `success` 不算结论（实测 `add --prop zzz=…` 回**退码 2 + success:true** 而属性被静默丢弃 ⇒ 那种情况装置报 failed）。只吃 OOXML 三族；非文本的标量属性（`bold=true`）不做值对账但必须在 `verify.notValueChecked` 里自报。**后端 stdout 一律不透传** | `dockit.bat edit D:\簿.docx add /body --type paragraph --prop text=附注` |
| `merge` | 模板填充：`merge <模板> <数据JSON文件> [输出]`，把 `{{key}}` 换成数据值。模板是输入 ⇒ 零改动（前后 sha256 各测一次）；数据**必须是 JSON 文件路径**（不接内联 JSON，shell 引号会把值吃掉）、顶层对象、值全标量、空对象直接 `invalid-document`（装置不假装"成功填了 0 个"）；输出已存在 ⇒ `invalid-output`（**后端那个 `--force` 装置从不传**）。产物由装置回读：逐键数"值出现了"与"`{{key}}` 还在不在"，有残留落 `warnings[]` 而不是判错 | `dockit.bat merge D:\合同模板.docx D:\数据.json` |
| `media` | 把包里嵌入的媒体件抽到目录 + 清单（类型/字节/sha256）。OOXML/ODF 走解包（`word/media`、`ppt/media`、`xl/media`、`Pictures`），**不起引擎**；**PDF 走 poppler `pdfimages`（v2.1.0，原生 CLI、不触 ADR-001）**，先 `-list` 数图、超上限在**落地前**拒（不静默截断、不回 dir），缺 poppler 回 `unavailable`＋指路。预览件（`docProps/thumbnail*`、ODF `Thumbnails/*`）不在采集面；加密 PDF 回 `unsupported-format`；超上限（默认 300）拒绝不截断 | `dockit.bat media 报告.docx`；`media 报告.pdf --max-files 50` |
| `batch` | 目录级批量：逐件走 `to`（默认出 pdf、只扫一层；`--recursive` 进子目录），逐件 JSON + 总账；**单件失败不拖垮其余，有失败整体 `ok=false`**；超件数上限（默认 200）拒绝不截断（v1.9.0）。**v2.6.0 起 `--cmd to|markdown`** 选逐件跑哪条命令面：`markdown` 产物恒 `.md`（此时传 `--to` 直接 `invalid-output`，两支命令面的参数不许混着给），默认 `--ext` 随之换成 markdown 的八个输入族；族外件逐件回 `unsupported-format` 并指路（老族先 `to`、PDF 走 `pdftext`），**不为一件注定失败的件起子进程** | `dockit.bat batch D:\作业 --ext .doc,.docx`；`batch D:\报告 --cmd markdown` |
| `combine` | 按参数顺序把多份 PDF 拼成一份新 PDF：输入逐件只读（哈希在 `sources[]`）、产物新建、**永不覆盖**；加密件与表单不在支持面（v1.9.0） | `dockit.bat combine A.pdf B.pdf` |
| `split` | 拆 PDF——`--ranges 1-3,5,7-` 按区间 / `--every n` 每 N 页 / 都不给＝逐页；产物落新目录 + 逐件页数与哈希；单次最多 100 件（v1.9.0） | `dockit.bat split 合集.pdf --every 10` |
| `pdftext` | **直取 PDF 内嵌文本层**（v2.1.0，poppler `pdftotext`，原生 CLI、免 OCR、不触 ADR-001）：数字中文 PDF 瞬时取字，扫描件/无文本层回空并 warning 指路 `pages`＋`ocr`。文本只落 `.txt`，JSON 只报 `chars/lines/pageBreaks` **不回显正文**（与 ocr 同隐私口径）；`--pages N-M` 只接单段区间（倒序/页码 0/非法写法前置拒）；非 PDF 回 `unsupported-format`、加密件 `unsupported-format`、缺 poppler 回 `unavailable`＋指路 `DOCKIT_POPPLER_BIN` | `dockit.bat pdftext 报告.pdf`；`pdftext 报告.pdf --pages 1-3 --out 摘录.txt` |
| `pageops` | **PDF 页级操作**（v2.2.0，pdf-lib）：`rotate 90/180/270`（绝对角度，可配 `--pages 1-3` 只转指定页）、`delete 2,4`（删页）、`order 3,1,2`（重排，须为 1..N 各一次）；输入只读、产物新建、永不覆盖；加密件不支持；不做解密；🔴 水印机主 2026-10-11 裁不做（v2.4.0 曾实现当轮撤）；空/纯逗号 `--pages` 清单 v2.4.1 起前置拒（实测空清单曾"无操作却报 ok"） | `dockit.bat pageops 合集.pdf rotate 90`；`pageops 合集.pdf delete 2`；`pageops 合集.pdf order 3,1,2` |
| `pipeline` | **多步管线串联**（v2.2.0 立，v2.4.0 扩成**逗号步序列**）：flow＝逗号串联的步序列，步 ∈ `to`/`pages`/`ocr`/`pdftext`（如 `to,pages,ocr`、`to,pdftext`）；旧写法 `to-pages`／`to-pages-ocr` 仍可用；`to` 只能是第一步；逐步子进程、单件失败即停报 `failedStep`；**v2.7.0 起 `--dag flow.json` 走图执行器**（节点带 `needs` 依赖与 `when` 条件谓词，按拓扑序确定性串行；🔴 并发明确不做——并发读数由负载决定，那测的是机器不是正确性） | `dockit.bat pipeline 报告.docx to,pages,ocr --lang chi_sim`；`pipeline 报告.pdf to,pdftext` |
| `markdown` | **文档 → GFM Markdown**（v2.3.0，pandoc 后端）：docx/odt/pptx/xlsx/csv/tsv/html/htm 取成 md（摄取、给 LLM/笔记读；`.doc/.xls/.ppt` 老族先 `to` 转新族；PDF 取字走 `pdftext`）；`--wrap none|auto|preserve`（默认 none 不硬折行）；`--track-changes accept|reject|all`（v2.5.0，**仅 docx**：按接受/拒绝/双向带标记三态取修订视图）；缺 pandoc 回 `unavailable`＋指路 `DOCKIT_PANDOC`（doctor 的 `pandoc-markdown` 只 WARN，外人克隆全绿）；**只落 .md 文件、正文不回显进 JSON**（与 ocr/pdftext 同隐私口径） | `dockit.bat markdown D:\报告.docx`；`dockit.bat markdown 表.xlsx 表.md --wrap auto` |
| `pdfform` | **AcroForm 表单受控填写**（v2.5.0，pdf-lib）：只吃 AcroForm（XFA/加密件 `unsupported-format`、签名类字段不写）；`--list` 列字段名/类型/选项，`--data 数据.json` 按 JSON 值填写（text/checkbox/radio/dropdown/optionlist；顶层对象、值全标量）；中文字段值自动嵌字体（`@pdf-lib/fontkit`＋系统 TTF，`--font` 可覆盖）；`--flatten` 扁平化（不可逆）；**字段值不回显进回报**；写后由装置重新装载产物逐字段回读对账；输入只读、产物新建、永不覆盖 | `dockit.bat pdfform 表单.pdf --list`；`pdfform 表单.pdf --data 数据.json` |
| `redline` | **docx 修订与批注写入**（v2.7.0，纯 ZIP＋XML、零外部依赖；机主撤销"双轨归技能"旧边界后落地）：`redline <输入.docx> <insert\|delete\|comment\|accept\|reject> [--text 文本] [--match 定位串 \| --para N] [--author 名] [--out 文件]`。第一步复制成 `_out/<名>-<UTC时间戳>-redlined.docx`，原件前后各测一次 sha256；写完**装置自己重新解包对账**（数 `w:ins`/`w:del`/`w:comment`、验 `--text` 进没进、验 delete 的原文真进了 `w:delText`、验批注的 rels 与 `[Content_Types]` 登记齐、验 accept/reject 后该留的留着该走的走了）。🔴 格式修订（`rPrChange`/`pPrChange` 等）：accept＝连标记一起清（保留当前格式并 warning），reject＝只要存在就 `unsupported-format`——把旧属性表贴回来这件事装置没有可靠面，**硬做就是假还原** | `dockit.bat redline D:\报告.docx insert --text "附注一" --match "第三章" --author 审`；`redline 报告.docx accept` |
| `redact` | **PDF 真涂黑**（v2.7.0，pdf-lib＋poppler，不依赖 ghostscript/Python）：`redact <输入.pdf> [--needle 串] [--needles 数据.json] [--out 文件]`。三段承重：`pdftotext -bbox` 词框定位 → **删掉页面内容流里命中的 BT…ET 文本绘制组** ＋ 画黑框 → 产物**再抽一遍文本层证明 needle 零命中**。🔴 只画框不删字＝假脱敏，这一条是命令存在的理由；needle 找不到 ⇒ `invalid-output`（不给"空白脱敏回执"）；无文本层（扫描件）⇒ `failed` 指路 `pages`＋`ocr`；加密件 ⇒ `unsupported-format`；输入只读、产物新写、永不覆盖。只删页内容流的文本组——Form XObject／注释外观／附件／XMP 里的同一串不会被删，验收会抓出来，但**别把"这串没了"推广成"这类信息都清了"** | `dockit.bat redact D:\合同.pdf --needle 身份证号` |
| `tables` | **PDF 表格抽取 → CSV**（v2.7.0，几何法、可自证）：`tables <输入.pdf> [--dir 目录] [--pages 1-3] [--max-tables n]`。网格来自内容流的**矢量线段**（实测 LibreOffice 把带边框表格画成 `m`/`l`：N 行→N+1 条横线、M 列→M+1 条竖线；`re` 也吃），单元格必须**四边都有线**才算一个格；文字来自 `pdftotext -bbox` 的词框按中心入格。每表一个 CSV（UTF-8 带 BOM，Excel 中文不乱码）＋清单（页/行列数/格数/字节/sha256）。🔴 没有闭合网格就回空清单＋warning「不猜表」——无边框表、图片表、只有横线的表都不在这一面；OOXML/ODF 的表请直接 `to ... .csv` | `dockit.bat tables D:\报表.pdf`；`tables 扫描包.pdf --pages 2-4` |
| `frommd` | **Markdown 的生产方向**（v2.7.0，md → docx/odt/html/pdf；`markdown` 的反向）：`frommd <输入.md> [输出文件] [--to docx\|odt\|html\|pdf] [--title 名] [--css 样式.css]`。前三者 pandoc 直出（`--sandbox`）；pdf 走两段＝pandoc 出独立 HTML → 本机无头浏览器 `--print-to-pdf`（Chrome/Edge 任一，`DOCKIT_BROWSER` 权威覆盖；🔴 不传 `--no-sandbox`，实测不需要）。中间件一律落**纯 ASCII 临时目录**（poppler 的 argv 中文解码坑同族）。写完**装置自己回读产物核对正文**（docx/odt 解包取 `w:t`、html 去标签、pdf 走 `pdftotext`）：样本词一个都没找到 ⇒ `failed`；找不齐 ⇒ warning「别宣称无损」。🔴 pdf 的版式由浏览器定，与 `to`（LibreOffice）不是同一路线，别互相冒充等价产物 | `dockit.bat frommd D:\笔记.md --to docx`；`frommd 报告.md 报告.pdf --title 季度报告` |
| `compress` | **PDF 无损瘦身**（v2.7.0，纯 pdf-lib，**不依赖 ghostscript**）：`compress <输入.pdf> [输出文件] [--min-stream-bytes n]`。两件动作：① **可达性回收**（从 trailer 的 Root/Info/ID 做引用闭包，闭包外的间接对象整批删——实测 pdf-lib 自己不做回收，孤儿对象会原样进产物）；② 未压缩流改 **deflate**。🔴 "无损"不靠宣称：产物**页数相等 ＋ `pdftotext` 抽出的正文与原件逐字相等**，不等即 `failed`；带 AcroForm 表单／内嵌附件／JavaScript 的件**前置拒**（回收会丢交互层，与 combine/split 同一立场）；pdftotext 不在位时**拒绝出货**。体积没降是合法结果，照实报 `ratioBytes` | `dockit.bat compress D:\扫描件.pdf` |
| `sheetop` | **xlsx 结构微编辑＋公式引用重写**（v2.8.0，纯 ZIP＋XML、不起引擎也能跑）：`sheetop <输入.xlsx> <row-insert|col-insert|row-move|col-move> [--sheet 名] [--at N [--count k] | --from N --to M] [--timeout-ms n] [--skip-recalc] [输出]`。写完**重新解开产物**做**引用图同构对账**（逐条公式重新切词 ⇒ ①非引用片段逐字不变 ②每个引用的落点＝原件同一片段按轴映射的像 ③格子地址集合＝原集合在映射下的像＝双射），不过就 `failed` 并**撤掉产物**。覆盖面：本表与别表指向本表的引用、共享／数组公式的 ref 区、命名域、条件格式与数据验证（sqref＋规则式 `<formula>`）、超链接 ref/location、自动筛选／排序状态、dimension、行 spans、分页符、表（ListObject）范围、图表系列 `<c:f>`、绘图锚点。🔴 **区间映射取"整段的像"而不是"两角的像"**（移列时 `A1:C7` 若只算两角会被写成 `A1:B7`＝少一列）。改过公式的缓存值清掉＋`calcChain.xml` 整件删除＋`fullCalcOnLoad="1"`。默认再跑一把**引擎尺**：原件与产物各重算一次逐格对数值——🔴 **插入类**连公式格一起对（插空行不改任何区间成员），**移动类只比数据格**（把一行/列移进 `SUM` 区间会改变区间覆盖的格子，公式格的数值本来就该变，与 Excel 一致）；`--skip-recalc` 跳过后会在 `warnings` 里明说"数值等价未证"。前置拒：结构化引用 `Table1[列]`、三维引用 `Sheet1:Sheet2!A1`、`dataTable` 公式、R1C1、透视表／外部链接／工作表保护／宏／旧绘图层、`<row>`／`<c>` 缺 `r` 属性 |
| `gc` | **产物区可逆回收**（v2.9.0，`gc [--dir _out|_tmp|both] [--age 天] [--base 前缀] [--exclude 前缀,前缀] [--yes]`）：**默认 dry-run 一个文件都不动**，只列 `candidates`／`bytesTotal`／`topFamilies`／逐目录的「可清／因太新跳过／未匹配条数＋未匹配样本」。回收面由**三条装置签名指纹**钉死，不做人工白名单：① 文件名以装置时间戳 `-20YYMMDDHHMMSS[-N]` 结尾（含扩展名分支）；② 写后端留在 `_out` 的事务残骸 `.savetmp-<32hex>`（只有机器会起这种名）；③ **目录形态**产物同样以时间戳段结尾。🔴 **`--yes` 也不删除**——是把件 `rename` 进隔离区「**仓库同级** `垃圾产物\dockit-gc-<时刻>\`」（隔离区取 `dirname(ROOT)`，🔴 必须与产物区**同卷**：搬运用 `renameSync`，跨卷必 `EXDEV`——真克隆门抓到写死绝对路径时"主树全绿、clone 到别的盘就搬不动"），并写 `MANIFEST.md`（原路径／新相对路径／字节／原 mtime／≤5 MB 件的 sha256），按清单逐条搬回即复原。安全边界三条：只扫 `_out`/`_tmp` 两块（真件样本、`test/fixtures`、`_probe`、`_audit` 永不在面上）、`--age` **下限 1 天**（0 会把别人**正在跑的**那一轮自检目录一起扫走）、指纹匹配不上的一律只列不碰。🔴 **v2.10.0 订正一处过度声明**：装置签名只证明"这不是人起的名字"，**不证明"这不是真工件"**——真交付件（课件/作业）经装置转出的产物同样带时间戳（本机候选面里实测混着 12 件）。所以防误清是**两层**：默认 dry-run 先把清单摊开给人看 ＋ `--exclude 前缀,...` 把要留的圈出去（被排除件**单独记账**，不混进"未匹配"，人一眼能看出自己是"没收"还是"故意留")。回报里 `moved`／`quarantine`／`manifest` 可核 | `dockit.bat gc`（先看清单）；`gc --yes --age 30 --dir _out`；🔴 `--base` 空/纯空白直接拒（v3.0.0） |
| `selftest` | 内置判据全跑（判据条数=161）：合成正向 / 合成反向 / 真实脏样本 / 双向自证 / 失败码族 / 能力对账 / README 对账 / 命令面与配置区默认值对账 / 错拼候选 / 文档卫生 / ADR 订正句与 ADR-002 认领对账 / dump 形状 / check 体检 / 入口登记与字段互不矛盾 / 写能力承重 / ocr / media·batch·PDF 拼拆（v1.9.0）/ 入口卡面·加密拒绝（v1.9.1）/ pdftext 文本层·media 抽 PDF 内嵌图·inspect AcroForm 探针（v2.1.0）/ 修订检测·PDF 双条·poppler 降级·错误地图·页级操作·管线（v2.2.0）/ spawn 统一 stdio·markdown 族（v2.3.0）/ pipeline 步序列（v2.4.0）/ scrub PDF 面·pdfform·markdown 修订足迹（v2.5.0）/ check 外发风险五族·check PDF 面·覆盖面自述·factcheck --refs·batch --cmd markdown（v2.6.0）/ redline·redact·tables·frommd·compress·pipeline DAG·media 编码自曝（v2.7.0）/ sheetop 引用重写（v2.8.0）/ **产物根重定向·输入体积闸二十一族·freePath 单次 readdir·gc 回收面（v2.9.0）** | `dockit.bat selftest` |
| `help` | 命令清单。**`help <命令>` 出该命令的结构化 spec**（每个开关的类型、默认值、默认值来源、会撞的失败码）；`help --json` 出全部命令的结构化 spec（与 README 表格、与配置区常量都由 selftest 对账，漂移就红） | `dockit.bat help ocr` |

## 成本口径（给调用方排计划用；2026-10-14 本机实测中位，Node v24.19.0）

绝对值随本机负载漂，**方法与脚本可复现**（`.cowork-temp/audit-2026-10-14/bench.js`，22 用例 ×3–7 次取中位）。排计划按这几条就够了：

| 面 | 中位 | 该怎么用这个数 |
|---|---|---|
| 装置自身净开销（`help` 40.4 ms − 裸 node 31.5 ms） | **≈9 ms** | 启动面已近地板，别再为"快一点"改装置 |
| 纯 JS 面（`sheets`／`inspect`／`check`／`dump`／`redline`） | **44–65 ms** | 想快就能快；这些族不起引擎 |
| `pdftext`（含一次 poppler 子进程） | **≈117 ms** | 子进程一次的成本 |
| **引擎冷启动**（`to`／`pages`） | **≈1.22–1.26 s/次** | 🔴 这是 kit 的进程模型，装置侧没有低成本杠杆：`batch` 按 **≈1.3 s/件** 排，`pipeline` 每步各起一次 |
| `sheetop` 全量（含引擎尺两遍重算） | **≈2.40 s** | 引擎尺溢价 ≈2.3 s |
| `sheetop --skip-recalc` | **≈111 ms** | 只要改写、不要数值证明时是 20 倍差的选择——代价是 `warnings` 明说"数值等价未证"，转达时不许抹掉 |
| `doctor` | **≈634 ms** | 成本在探针本身（要起 tesseract/officecli），不是解包 |
| `compress`（1.5 KB 件） | **≈252 ms** | 含两次 pdftotext 核验 |
| 一轮全门 | selftest **≈161 s**／变异台全量 **≈546 s**／字体基线 **≈25 s** | 排期用；`--age` 与 `gc` 之后测试产物不再沉积，长跑目录不再膨胀 |

明确**不改**的三项（实测过才写"不值得"）：`NODE_COMPILE_CACHE` 编译缓存（`help` +2 ms、`selftest` −0.8%，实测无效）；OfficeCLI 后端身份章全量哈希（每次调用前后各读 32 MB 并 sha256 ≈40 ms，换"换体必被发现"，保真优先）；引擎冷启动与 CLI 启动（前者属 kit 进程模型＝换依赖，是机主级决策；后者已近地板）。

## 常用三条路（复制即用；把 `<REPO>` 换成克隆目录）

```bat
:: 1) 中文 Word → PDF，并知道有没有缺字
node <REPO>\dockit.js to "D:\报告.docx" "<REPO>\_out\报告.pdf"

:: 2) 看一眼第 1 页到底长没长字（PNG + 非白像素占比）
node <REPO>\dockit.js pages "D:\报告.docx" --pages 1

:: 3) 外发前先清元数据并自证零残留
node <REPO>\dockit.js scrub "D:\报告.docx" --verify
```

## 一条命令装进 agent 技能目录

本仓自带技能定义（`skills/agent-doc-ops/`）与安装器，让任何 agent 一条命令就能装上：

```bat
node install-skill.js            :: 自动探测 %USERPROFILE%\.codex\skills 等目录并安装
node install-skill.js --list     :: 只列出探测到的目录
```

装完后 agent 的技能列表里出现 `agent-doc-ops`，即可按技能卡调用本装置。

## 一条命令启动安装流程（setup）

`setup.js` 是完整安装入口：装 npm 依赖 → 装技能卡（支持**多目录**）→ `doctor` 验收，一条命令串起来：

```bat
node setup.js                    :: 全流程（npm install + 技能卡 + doctor）
node setup.js --skill-dir <目录1> --skill-dir <目录2>   :: 装进多个 agent 技能目录
node setup.js --no-deps          :: 依赖已装过时跳过 npm install
node setup.js --list             :: 只列出探测到的技能目录
```

前提：机器已有 Node ≥ 22.19（本命令用 Node 跑；缺 Node 先装 Node）。**系统侧可选依赖**（Tesseract／Poppler／Pandoc／OfficeCLI）不在这里硬装——平台与授权差异交给最后一步 `doctor` 明确报告缺什么、哪些命令不可用，按 WARN 逐条指路安装。

## 字体装载器（install-fonts）

本仓登记的字体清单（`test/font-manifest.json`，146 件）有配套装载器——把缺的字体从机主侧备份装回系统字体目录，一条命令完成"检测 → 装载 → 验证"：

```bat
node install-fonts.js --list     :: 只列缺失清单，不装
node install-fonts.js            :: 从备份装载（需管理员权限 + --source 指字体备份目录）
node install-fonts.js --check    :: 只复验不装
```

公开仓**不携带字体二进制**（字体有各自版权，仓库只登记名字与校验）；`--source` 指向机主侧字体备份（结构 = manifest.csv 同目录）。装完后 `doctor` 的 `substitute-fonts-present` 哨兵转 PASS。

## 硬口径（细节见《文档操作规范》）

- **引擎不是系统 LibreOffice，且系统 LibreOffice 已于 2026-10-04 卸载**。kit 自带一套引擎（实测 `node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/libreoffice-kit.exe` 178 MB + `program/` 树），不发现也不调用系统安装。
- 🔴 **但字体走系统字体库**：**删任何带字体的程序之前**先跑 `doctor`（替身字体哨兵：v1.7.2 起按 `test/font-manifest.json` 登记清单核**全量**、自报「已核 N／共 N」；清单缺失与非标定机器只 WARN）与 `node test/font-baseline.js check`（26 族基线）。这是装置在 kit 之外的**第一个**外部依赖面（v1.4.0 的 Tesseract 是第二个、v1.6.0 R6 的 OfficeCLI 是第三个——"唯一"那句到 R6 已不成立，见下条）。LibreOffice 当年往 `C:\Windows\Fonts` 装了 135 个度量兼容替身，卸载会一并带走且零报错。**缺件处置**：先做字体备份（装前跑 `node test/font-baseline.js save` 留档），缺了从备份回灌系统目录（需管理员）；**不要**用「仅为我安装」装进用户字体目录——哨兵只扫系统目录，装了对装置不可见、且同名族双真源难对账。
- 🔴 **装置现在有第三个外部依赖，而且它会自己升级自己**（v1.6.0 R6，ADR-002）：写后端 `officecli-win-x64.exe` 钉 v1.0.153／sha256 `05dd7125…c04f3`（三源认领）。**实测 2026-10-06 09:46:59 它在只问了一次 `--version` 之后就地更新到 v1.0.154**（旧字节留档 `bin\officecli-win-x64.exe.old`）——`OFFICECLI_SKIP_UPDATE=1` 只在**带上它的那条路径**上有效。所以装置的每一次后端调用都前后各取一次二进制身份章（`backend.binaryBefore/binaryAfter/binaryDrift`），换了就在 `warnings[]` 里点名；判据 `doc ADR-002` 核的是"盘上这枚必须在文档登记过的若干枚里"——现登记**五枚**（v1.0.153–157；已实测**四次**就地自更新：10-06／10-07／10-10／10-13），冒出没登记的第 N 枚照样红。
- **`edit`/`merge` 是装置第一次"会写盘"**（v1.6.0 R6）：承重 1 的守法形状＝**先复制再委托**，后端只碰 `_out/<名>-<UTC时间戳>-work.<ext>`；原件 sha256 操作前后各测一次，不一致立刻 `code:'failed'`。写进去的值由**装置自己**解开 ZIP 找（后端的 `success` 不算结论——实测 `add --prop zzz=…` 回 **退码 2 + success:true** 而属性被静默丢弃，装置报 failed）。**后端 stdout 一律不透传**（`get <文件> /` 只 3,443 B、0 个 CJK，却带着 `creator`/`lastModifiedBy` 原值）。动词白名单按**动词**给：`refresh`/`screenshot`/`install`/`open`/`save`/`watch` 整族不可达（`refresh` 会拉起 WPS 并改写输入）。
- **数字类交付先 `recalc` 再导出**。kit（和 LibreOffice 一样）在公式**带陈旧缓存值**时直接用缓存——实测 `=SUM(A1:B1)` 缓存被故意写成 999 时，直接导 CSV 得到的是 `999`，`recalc` 后才是 `9`。
- **`missingFonts` 只对源文档成立**。同一个中文文档转出的 PDF 再渲染，`missingFonts` 必为 `[]`，那不代表字体没问题。
- **转换产物自带元数据**。OOXML 的 `dc:creator` / `dc:title` 会进 PDF 的 XMP 包（实测在明文字节里能检索到），外发前按 `scrub --verify` 走。
- **开关是白名单，错拼不会被执行**（v1.6.0）：未知开关与未知命令一律 `invalid-output` + 退码 1，并回 `candidates[]`（最近邻，Damerau 距离、相邻换位算一步）。改前实测的形状是 `to 文件 --tiemout-ms 5` 回 **ok:true** 并按默认 120000ms 跑完——错拼被当成"没提这个开关"。`--json` 是全命令通用的无副作用开关（输出本来就恒是 JSON），在 `help --json` 的 `globalFlags` 里点名。
- 每个操作起一个全新引擎进程（实测单次约 0.8–1.3 s），批量请按串行算时间。
- **v1.9.0 四条新命令的硬口径**：`media` 抽出的媒体件是**文档本体**（外发前过脱敏闸门），预览件不收；`batch` 单件失败不拖垮其余、**有失败整体 `ok=false`**（逐件看 `items[]`）。`combine`/`split` 输入只读、产物新建、**永不覆盖**；加密 PDF 回 `unsupported-format`（先解密），表单与签名不做。装置新增依赖 **pdf-lib**（纯 JS，PDF 面命令用；缺件回 `unavailable`，`doctor` 有 `pdf-lib-in-place` 一条）与 **@pdf-lib/fontkit**（v2.5.0 起，`pdfform` 的中文字段值嵌字体用；缺件回 `unavailable`，`doctor` 有 `fontkit-in-place` 一条）；另有 `aux-tools(pandoc/poppler)` 一条只 WARN 的系统侧辅助工具哨兵。**v1.9.1**：加密件拒绝面固化——码＝`unsupported-format`、`next` 指解密、消息不带库的绕法提示（夹具 `test/fixtures/encrypted.pdf` 入仓）。
- **v2.5.0 三条新面**：`pdfform` 受控填写（只吃 AcroForm；XFA/加密件 `unsupported-format`、签名类不写；`--flatten` 不可逆；**字段值不回显**；写后回读对账）；`scrub` 的 PDF 面（清 `/Info` 目标键＋摘除 XMP、**写新文件非就地**；`--verify` 结构回查＋明文令牌扫描）；`markdown --track-changes accept|reject|all`（仅 docx）。依赖面 +1＝**@pdf-lib/fontkit**（纯 JS，`pdfform` 中文值嵌字体；`doctor` 哨兵 `fontkit-in-place` FAIL 类）。
- **v2.6.0 外发风险面（无新依赖）**：`check` 族数 7→**13**（新增 hidden-content／external-link／embedded-object／macro／custom-xml／form-field），并**首次吃 PDF**（纯 JS 结构面，仍不起引擎、不写盘）。三条硬口径：① **值不回显**——元数据字段名·部件名点名，属性值、外部链接目标、图层名、脚本内容、字段值一律不进回报（地址与层名本身就可能带用户名与内网主机名）；② **覆盖面必须自述**——`kindsApplicable`／`kindsNotApplicable` 说明"这一类容器实际查了哪些族"，不适用不等于查过；`findings` 清单封顶 200 并自报 `findingsTruncated`，`counts` 恒权威；③ 🔴 **能报 clean 之前先自证读得通**——pdf-lib 对坏 PDF 是**容错**的（load 不抛、返回连 catalog 都取不到的空壳），所以 PDF 分支必须有"结构自证"这一层：`/Root` 取不到或页树读不通 ⇒ `invalid-document`，加密件 ⇒ `unsupported-format`，**绝不带着读不全的结构给一个 `clean=true`**。另外 `factcheck --refs` 给 `文件:行` 型引用做体检（文件在否／行号越界否＋带出该行现值），判不了的静默推漂在 note 里明说；`batch --cmd to|markdown` 让批量面有了第二条命令通道（`--cmd markdown` 时给 `--to` 直接拒）。
- **v3.0.0 自检自修轮（机主令升 X；无新依赖，判据仍 161、变异 254→259、命令面 32 不变）**：全量自检抓出并修复**四处"给了却静默生效不了"的形状**——① `freePath`/`freeDir` 在**大小写错位**的同名占用下会发出已存在的路径（v2.9.0 readdir 优化引入；Windows 卷不敏感而集合精确匹配，实测覆盖了既有产物＝违反"绝不覆盖"；现集合跳号＋`existsSync` 复核）；② `--max-input-bytes` 的非法值（`abc`/`0`）被静默回退 256 MB 默认（调用方以为设了上限；现直接 `invalid-output`）；③ `gc --base` 给空/纯空白＝静默"不过滤"（现直接拒，与 `--exclude` 空清单同族）；④ `char-baseline check --at` 缺值被静默忽略照跑原基线（现直接拒）。另：**X 位 2→3**（三段位规则：X 只在机主提出时升，机主 2026-10-14 令「版本号升 3.0.0」）。
- **v2.9.0 性能与问题修复轮（无新依赖，判据 157→161、变异 234→254、命令面 31→32）**：这轮不打新能力，打的是**运行环境工程面与两道缺失的闸**。① **测试产物不再沉积**（O1）：`selftest` 把本次产物根改指 `_tmp/selftest-<时刻>-<pid>/out/` 并**经 `DOCKIT_OUT_DIR` 传给每一个子装置进程**——🔴 **装置的默认落点一字未动**（不设 env 时仍落 `_out`，这一条由判据的行为面钉着：清 env 的子进程必须落 `_out/<件>`、验完立刻删掉探针产物）；本轮实测的沉积形状是一轮全门给 `_out` 加 **858 个文件**。② **`freePath`/`freeDir` 单次 readdir 化**（O3）：旧实现逐号 `existsSync`，同名占用 1,499 个时一次调用要做 1,499 次 stat（实测 **92.3 ms**、≈60 µs/文件）；现在无占用仍是一次探针，有占用才列一次目录在集合里跳号（92 ms → ≈1 ms，且把最坏情形钉死）。③ 🔴 **本地解包路线补上输入体积闸**（F6，含 2026-10-14 自查补的多路输入口：`combine` 逐路过闸、`merge` 的数据件也过闸——只拦第一路等于漏拦，M250／M251 钉这两刀）：kit 路线早有 `--max-input-bytes`／`input-too-large`，而**不起引擎、整件 `readFileSync` 的那 21 族**（`inspect`/`dump`/`check`/`scrub`/`media`/`combine`/`split`/`pageops`/`compress`/`pdftext`/`redact`/`tables`/`redline`/`sheetop`/`pdfform`/`edit`/`merge`/`frommd`/`sheets`/`pipeline`）一条闸都没有——异常大件直接进内存。现默认 256 MB，超限在**任何解包与写盘之前**回 `input-too-large` 并带真实字节数，`--max-input-bytes`／`DOCKIT_MAX_INPUT_BYTES` 可抬（**属放宽规则，需机主明确同意**）；判据按"一族都不许漏"逐族对账，并实测"超限拒收后产物区清单一字不变"。④ **新命令 `gc`**（O2）：见上表——默认 dry-run、`--yes` 也只**搬移不删除**、三条装置签名指纹、`--age` 下限 1 天。⑤ 🔴 **本轮自抓的一条假牙**：产物根判据的行为面原来挂在 `test/fixtures/cn.docx` 上，而**那件根本不存在**（夹具只有 `cn.odt`／`encrypted.pdf`／`wps-newfile.doc`），整段被 `if (existsSync)` 静默跳过＝"跑了验证却没量任何东西"；同族第二处是 gc 判据把三条"该搬的必须不在原位"写反了方向（实现是对的、判据必红）。两条都按承重 #43（自报"跑了"必须同时报"量了多少"）处置：**判据里不许出现"夹具不在就跳过"的形状**。
- **v2.8.0 xlsx 结构微编辑（新命令 `sheetop`，无新依赖）**：把《技能与装置分工表》里"引用重写证不了引用图"那条**不落地**撤销。可证伪的形状＝**引用图同构对账**（写完重新解开产物，逐条公式重新切词：非引用片段逐字不变、每个引用落点＝原件同一片段按轴映射的像、格子地址集合是原集合在映射下的像）＋**引擎重算逐格对数值**。三条不可省略的口径：① 🔴 **区间映射要取"整段的像"**——移列/移行是置换，只算两个角会把 `A1:C7` 写成 `A1:B7`（少一列，实犯）；② 🔴 **引擎尺的期望按操作族分**：插入类连公式格一起对（插空行不改区间成员），移动类只比数据格——把行/列移进 `SUM` 区间，区间成员变了数值本来就该变（与 Excel 一致），拿"逐格等值"去要求移动类就会把正确产物判死；③ 🔴 **改过公式的格必须清缓存 `<v>`＋删 `calcChain.xml`＋写 `fullCalcOnLoad="1"`**，三者缺一都等于把陈旧数交给下一个读方（§7.1 的根）。拒收面照旧点名：结构化引用、三维引用、`dataTable`、R1C1、透视／外链／保护件、缺 `r` 属性。
- **v2.7.0 把先前declared的七项边界落地（机主 2026-10-14 原话撤销；无新依赖，判据 148→156、变异 204→223、命令面 25→30）**：`redline` 写 docx 修订与批注（🔴 双轨既定已撤销，纯 ZIP＋XML、不依赖任何后端；只写标准 OOXML 标记，`accept` 连标记一起清格式修订，**`reject` 只要存在 `w:rPrChange` 等格式修订就 `unsupported-format`——硬做就是假还原**）；`redact` 真涂黑（先删文本层里落在矩形内的 `BT…ET` 组再画黑框，🔴 **写后重新抽字，针串残留即 `code:failed`**，坐标必须把 `-bbox` 的顶原点换成内容流的底原点）；`tables` 只认矢量网格线（四边齐才算格，**无网格不猜表**、给 warning 交 OCR）；`frommd` md→docx/odt/html/pdf（pdf＝pandoc 出 HTML 再用本机 Chrome/Edge `--headless=new` 打印，🔴 **不传 `--no-sandbox`**）；`compress` 无损瘦身（孤儿对象回收＋明文流 deflate；🔴 加密／含 AcroForm／含附件／含 JS 一律前置拒绝，写完核**页数相等＋抽字逐字节相等**）。三条通用口径：① **五件对输入都零写入**（原件 sha256 前后各测一次，不一致立刻 `failed`）；② poppler 的中间件一律落 ASCII 临时目录（`asciiTmpDir`），🔴 中文绝对路径会让它按 ANSI 解 argv 报 I/O Error；③ 产物一律新建、撞名即 `invalid-output`，后端与引擎的 stdout 不透传。

## 验证

```bat
node dockit.js selftest         :: 内置判据（合成正向 / 合成反向 / 真实脏样本 / 对账类），一行 JSON 报 passed|failed|skipped|total
node dockit.js selftest --keep   :: 保留自检目录以便复盘
node test\mutant.js              :: 变异台（变异例数=259，编号 M1–M261（**缺号 M55、M82**——历史留空不回填，实际存在集合以此为准；旧写法"M1–M46 + M49–M100"按槽位凑巧也是 98，但区间外的 M47/M48 实际在、区间内的 M55/M82 实际不在，属成员口径错位，v1.6.2 只改口径）；M47–M48 是《方案》预留给 R6 的两例、本轮补齐；M101–M104 是 v1.6.2 轮为 F-1…F-4 新增的攻击面（**改的是期望值不是松紧**：四条既有判据一条没删没放宽）；M105–M106 是 v1.6.4 轮 R-A／R-B 的配套攻击；M107 是 v1.6.5（机主裁 Q-1）为「集合逐字相等」新增的攻击——**保条数换成员**，旧「只比条数」口径会静默绿；M25 的靶在 R3-a 之后换成"拆掉双族分流守卫"——同一味攻击，不删只换靶；M29 的锚点在 R5 加宽到 `qoder-cn\skills\…`，因为五家落盘后旧锚点命中 5 处会 ANCHOR-AMBIGUOUS 拒跑；M93 专打"全文出现即算过"——`refresh` 在 ADR-002 里出现 6 次，只有抹掉排除项 A 那一行里的它才该红；🔴 M47 是 R6 的正面控制——把 copyfile 打穿让后端直接吃原件，装置的原件 sha 前后对账必须抓住它；M127–M131 是 v1.8.0 轮为「非对齐 OLE 副本对齐修复」新增的五层攻击（触发闸／对齐算术／自报面／无差别修复反例／原件零改动）；M132–M144 是 v1.9.0 轮为 media/batch/combine/split 四条新命令新增的十三层攻击（**改的是期望值不是松紧**）；M145–M146 是 v1.9.1 轮为加密 PDF 拒绝面与错误消息卫生新增的两层攻击；M147–M149 为同日「入口指路卡面」三层攻击（各拆一层、靠注入对照计数现形）；M150–M156 是 v2.1.0 轮新增七层攻击——pdftext 文本层四条（M150 拆 %PDF- magic 守卫、M151 拆 pdftotext 在位降级、M152 拆 --pages 倒置区间校验、M156 让正文回显进 JSON 打隐私牙）、media 抽 PDF 图两条（M153 拆"数图后落地前"上限闸、M154 只拆 pdfimages -list 那份加密特判以证明 list/extract 两层各有牙）、inspect AcroForm 探针一条（M155 把 AcroForm 目录键查飞））；🔴 M157–M171 是 v2.2.0 轮新增十五层攻击——check 修订/批注（M157 摘 ins、M158 摘 del、M159 批注正则打飞）、pages poppler 降级（M160 拆 PDF-only 守卫、M161 拆 poppler 缺失 return null）、recalc 错误地图（M162 错误检测打飞、M163 公式计数打飞）、开关（M164 拆 reencode 非法值校验）、pageops（M165 rotate 角度写死、M166 delete 过滤打飞、M167 order 排回原序）、pipeline（M168 拆 PDF 跳过 to 检测、M169 拆 ocr 步触发）、封顶拒绝（M170 media 超限、M171 split 封顶；M172 拆 pipeline 中途失败的即停；🔴 M173–M174 是 v2.3.0 轮 spawn 统一包装防回退哨兵两层——M173 掏主文件钉桩、M174 掏 test 侧宿主文件（覆盖面），M175–M177 是 markdown 命令三层——缺件降级（M175）、正文隐私（M176）、输出撞车（M177）；M178 是 v2.4.0 轮 pipeline 步序列的未知步拒绝层；🔴 watermark 曾随 v2.4.0 首版配 M178/M179 两例，机主当轮裁撤 watermark 后随能力一起撤、编号收回重用；另 M180–M189 为 v2.5.0 轮 scrub PDF 面／pdfform／markdown 修订足迹新增的十层攻击；🔴 M190–M206 是 v2.6.0 轮为 check 的外发风险面新增的十七层攻击；**M207–M223 是 v2.7.0 轮十七层**——OOXML/ODF 五族（M190 族名打错、M191 拆掉 `w:val="0"` 豁免＝过度报告、M192 外部引用正则失效、M193 把链接目标写进 locator 打隐私、M194 VBA 部件匹配打错、M195 空值自定义属性被点名、M196 ODF 隐藏单元格族失效）、PDF 六族（M197 `/Info` 循环哑火、**M198 拆掉整层"结构自证"——坏 PDF 会被洗成 ok＋clean=true，这一例钉的是本轮实测抓出的假成功洞**、M199 逐对象只认 PDFDict＝附件整族漏报（首版实犯）、M200 XMP 不做 inflate）、覆盖面自述（M201 counts 被截断清单污染、M202 从 docx 适用面摘掉 revisions＝假族名）、factcheck --refs（M203 上界判定拆掉、M204 把 --refs 变成默认开）、batch --cmd（M205 markdown 支被吃掉、M206 `--cmd`/`--to` 互斥守卫拆掉）、**M224／M225／M236 是自指例**（打的是变异台自己的写盘韧性与注入通道，锚串在源码里用拼接断开，否则 `split(find)` 会数到定义行那一处）；**M237–M252 是 v2.9.0 轮十六层**——产物根四条（M237 selftest 不把 env 传给子进程、M238 不设 env 时默认落点被挪走）、freePath 三条（M239 列了目录不查集合、M240 快路径不打条件＝无条件覆盖、M241 `freeDir` 那一侧没同步改回逐号 stat）、体积闸三条（M242 只量不拒、M243 默认常量与 help 的 `default` 字面量脱钩＝按台子纪律②弄坏数据不删比较、M244 `scrub` 一族漏调＝假闸）、体积闸补口两例（M250 combine 只拦第一路输入——收 2..N 份的命令第 2 份起仍整件进内存、M251 merge 的数据件漏闸）；gc 五条（M245 文件侧指纹过宽把人起的名字圈进回收面、M246 第二指纹失效、M247 dry-run 默认翻成执行、M248 `--age` 下限摘回 0、M249 把 `renameSync` 换成 `rmSync`＝可逆隔离变真删除、M252 隔离区落点写回绝对路径＝跨卷形状复辟（主树全绿、clone 到别的盘搬不动，2026-10-14 真克隆门实抓））；**另有一例换靶**：M4（v1.0.x 就有的"freePath 去重"攻击）锚串是旧的"逐号 existsSync"实现，O3 换形状后当场 ANCHOR-MISS——按台子纪律**同一味攻击、不删只换靶**重钉成"去重序号从 1 起"）：逐例弄坏实现或写坏数据，断言"红在该红的条且整轮退码 1"，跑完逐字节还原 + md5 对账
node test\char-baseline.js check  :: 本仓允许字符集基线对账（默认只报新增码点不红；`--strict` 才当闸门；`selftest` 跑它的注入对照；`save` 需机主同意 DOCKIT_BASELINE_CONSENT=1）
node test\font-baseline.js check   :: 26 个字体的解析基线对账（save 一次后要机主同意才覆盖）；换机器/删字体程序前后各跑一次
node test\mutant.js --list       :: 列出每例变异与它应变红的那条判据
```

判据有没有牙由 `test/mutant.js` 回答，不由 selftest 自己回答（套件内不自设变异，避免与外部变异互相顶）。计数口径固定为 `total = passed + failed + skipped`。

## 安装与复现

```bat
git clone https://github.com/Sirius1102/agent-doc-ops-oss.git
cd agent-doc-ops-oss
npm install
node dockit.js doctor
node dockit.js selftest
```

`npm install` 会装齐 `@deepseek-ai/libreoffice-kit`（预编译 LibreOffice 引擎，MPL-2.0）、`pdf-lib` 与 `@pdf-lib/fontkit`（均 MIT）。`doctor` 的 `ocr-lang-pack` 检查是 WARN 类：没装 Tesseract 中文语言包只降 WARN，**外人克隆首跑必须全绿**。

**已知依赖风险（如实披露）**：kit 0.1.5 锁定的 `fflate@0.8.2` 有一个中危漏洞（`unzipSync` 解析畸形 ZIP64 时可进入无限循环，GHSA-px8p-9vwx-vf98），修复版 0.8.3 已发布但 kit 侧未跟进。**上游引擎路径仍受影响**：kit 的 worker 用 fflate 的 `unzipSync` 解析输入文件（`lib/worker.js` L288），所以**走 kit 的所有转换/渲染命令**（`to`/`pages`/`sheets` render 路线等）在吃一个恶意构造的 zip64 畸形文档时可能挂死。缓解：① 装置命令面的解包路线（`inspect`/`check`/`scrub`/`dump`/`redline`/`sheetop` 等 21 族）用自研 ZIP 读取器（逐条 CRC 实算、大小写精确），不走 fflate，该面不受影响；② kit 子进程调用全部带 `--timeout-ms`（默认 120000ms）——🔴 **防护在 kit CLI 内部的 worker 超时机制**（`runKit` 父进程的 `spawnSync` 本身没有操作系统级超时参数在起作用，挂死由 kit worker 自身超时终止并回 `timeout` 失败码）；③ 处理**来源不可信的文档**时优先用装置自己的解包命令面（不起引擎的那 21 族），升 kit 属机主级版本决策。

Node 需 ≥ 22.19.0（本机 v24.19.0 实测）。kit 与引擎包版本独立编号，本装置钉 `0.1.5`；npm 侧依赖共三件：`@deepseek-ai/libreoffice-kit@0.1.5`＋`pdf-lib@1.17.1`＋`@pdf-lib/fontkit@1.1.1`。
