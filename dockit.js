#!/usr/bin/env node
/**
 * dockit.js — 本机文档操作装置（项目：Agent文档操作）
 * 版本：v3.2.0（版本号同步面：package.json / 本文件 VERSION / README 版本行）
 *
 * 职责：把 @deepseek-ai/libreoffice-kit 的预编译 LibreOffice 引擎包成「绝对路径 + 一条命令 + 一份 JSON」，
 *       让可运行 Node 命令的 Agent 按 CLI/JSON 契约集成，安全地转换、渲染、重算、体检 Office 文档，
 *       并在交付前给出字体与元数据的自曝证据。
 * 依赖：只依赖同目录 node_modules 里的 kit（钉 KIT_VERSION）；其余一律 Node 标准库（含手写 ZIP 读写，不引第三方压缩包库）。
 *
 * 承重约束（改动前先读 README 与 docs/adr/）：
 *  1) 原件只读。本装置对输入文件零写入；所有产物落 _out/ 或 --out 显式路径。
 *  2) 绝不覆盖输出。kit 自身用独占创建（EEXIST 即失败），本装置在选路径时先做去重，避免把"失败"当"成功"。
 *  3) 默认不回显文档正文。体检类命令只给字段名 + 长度 + 哈希（脱敏指南 §1.2 形状探针口径）。
 *  4) 失败必须给下一步动作（next 字段），不裸抛退出码。
 */

//#region 配置 / 常量区
const VERSION = '3.2.0';
const KIT_VERSION = '0.1.5';            // 本仓锁定版本；升级需单独验证
const ROOT = __dirname;
const KIT_CLI = ROOT + '/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js';
/** R-A（v1.6.4）：kit CLI 解析**函数化**——配置区默认 + `DOCKIT_KIT_CLI` 覆盖 + 自报解析来源（对齐 resolveOfficecliExe 的形状）。
 *  覆盖通道是"依赖声明"体系的注入面：覆盖率闸臂①/④ 靠它把子 selftest 指到缺失态、臂③ 靠它指到"存在但坏"的 exe。
 *  解析器必须是函数且每次现算（不缓存）——判据在跑的时候把它指到别的路径上，要真的按指的路走（M94 同一条教训）。 */
function resolveKitCli() {
  const fromEnv = process.env.DOCKIT_KIT_CLI || '';
  const exe = fromEnv || KIT_CLI;
  return { exe, source: fromEnv ? 'env DOCKIT_KIT_CLI' : '配置区默认', present: fs.existsSync(exe) };
}
// v2.9.0 O1：产物根可被 DOCKIT_OUT_DIR 覆盖——**只为测试态开**（selftest 把子进程指到本次运行目录的 out/），
// 不设 env 时仍等于 ROOT/_out，装置默认落点一字未变。治的是「一轮全量测试让 _out 从 11,820 涨到 12,678 文件」的沉积。
let OUT_DIR = process.env.DOCKIT_OUT_DIR && String(process.env.DOCKIT_OUT_DIR).trim()
  ? require("node:path").resolve(String(process.env.DOCKIT_OUT_DIR).trim()) // 🔴 不能在这里用文件里那个 const path——OUT_DIR 在它上面，会撞 TDZ（不设 env 走默认分支不报错，一设 env 子进程全崩：本仓配置区顺序坑的反面）
  : ROOT + '/_out';
const TMP_DIR = ROOT + '/_tmp';
const DEFAULT_TIMEOUT_MS = 120000;
const DPI_DEFAULT = 144;                 // 引擎默认（2026-10-06 实测：不传 --dpi 时 tile=1224×1584 = 8.5″×11″ @144）
const MAX_PIXEL_TILES = 40;              // 像素自证最多扫这么多 tile，超了自报 truncated
const DEFAULT_SHEETS_METHOD = 'auto';    // sheets 未点名路线时的默认（先 zip 后 render，并自报用了哪条）
const DEFAULT_TO_OUTPUT_EXT = 'pdf';     // to 省略输出路径时产的后缀
const DEFAULT_RECALC_OUTPUT_EXT = 'xlsx';// recalc 省略输出路径时产的后缀
// ---- Tesseract（ocr 外部依赖，v1.4.0 起，ADR-001）：路径字面量全仓只在此出现一次（总纲第七节可扩展性）。
// 常驻进程读不到后设的 User 环境变量（本机踩过）⇒ 调用方以 out 里自报的实际解析路径为准，别只信自己刚 set 的值。
const TESSERACT_DIR = process.env.DOCKIT_TESSERACT_DIR || 'C:\\Program Files\\Tesseract-OCR';
const TESSERACT_EXE = process.env.DOCKIT_TESSERACT || TESSERACT_DIR + '\\tesseract.exe';
const TESSDATA_DIR = process.env.DOCKIT_TESSDATA || TESSERACT_DIR + '\\tessdata';
const OCR_DEFAULT_LANG = process.env.DOCKIT_OCR_LANG || 'eng';
// OfficeCLI 写后端（ADR-002，v1.6.0 R0-b 起在册）。与 Tesseract 两个常量同形状：**配置区默认 + 环境变量覆盖**，
// 且解析器必须做成**函数**而不是加载期常量——判据要在跑的时候把 `DOCKIT_OFFICECLI` 指到不存在的路径上，
// 亲眼看它真的按指的路径走（"覆盖面存在但没人覆盖过"就是假牙；ADR-002 §三-4）。
const OFFICECLI_EXE_DEFAULT = process.env.OFFICECLI_EXE || '';
const OFFICECLI_ENV = 'DOCKIT_OFFICECLI';
const resolveOfficecliExe = () => (process.env[OFFICECLI_ENV]
  ? { exe: process.env[OFFICECLI_ENV], source: 'env ' + OFFICECLI_ENV }
  : { exe: OFFICECLI_EXE_DEFAULT, source: '配置区默认' });
// 🔴 R6（ADR-002 §三-2）：**按动词准入，不按程序准入**。实测证据是同一支 exe 的 blast radius 差一个数量级：
//   `add`/`set`/`merge`/`validate` 跑完 home 新增 0、零常驻；而 `refresh` 会把 WPS 拉起来（连插件联网下载一起触发）并**就地改写输入文件**，
//   `screenshot`/`pdf` 同理；`install`/`skills`/`mcp` 会往别人的配置目录写文件＝仓外写越界（任务书硬禁令）。
const OFFICECLI_VERB_ALLOW = ['set', 'add', 'remove', 'merge', 'validate'];
// 拒绝清单按 ADR-002 的排除项逐条写名（不是"其它都不许"那种含糊话——含糊话没法被变异打红）
const OFFICECLI_VERB_DENY = ['open', 'close', 'save', 'watch', 'unwatch', 'refresh', 'screenshot', 'install', 'skills', 'mcp', 'create', 'add-part', 'raw-set', 'import', 'plugins', 'batch', 'move', 'swap', 'dump', 'get', 'query', 'raw', 'view', 'help'];
const OFFICECLI_ISOLATION_ENV = { OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1' };
// 🔴 后端调用审计（v1.6.7）：每一次真的把子进程起来调后端，就落一行 JSONL——时间、动词、exe 解析来源、
//    隔离 env 是否带齐、后端退出码/信号、调用前后二进制的字节与 sha8、有没有换体、后端自报码。
//    为什么需要：这台机器已两次在装置外被换体（10-06 09:46、10-07 11:21）。装置的"字节前后对账"只能证明
//    **这次调用期间**没换，换体发生在装置外时它无从区分；审计行留的是"装置每次都带了 env、每次都核过字节"
//    的一手台账，出事时能回答"是不是装置干的"。内容零脱敏需求：只记路径/哈希/码，**不记文档内容、不记后端 stdout**。
const AUDIT_DIR = ROOT + '/_audit';
const AUDIT_FILE = AUDIT_DIR + '/backend-calls.jsonl';
function auditBackendCall(rec) {
  try {
    ensureDir(AUDIT_DIR);
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n');
    return { ok: true, file: AUDIT_FILE };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 120) };
  }
}
// 后端自己的码 → 装置八码族。**未登记的一律落 `failed`**（不许把后端的码面透传给调用方——两套契约混在一起判据就测不到东西，《方案》§4）
const OFFICECLI_CODE_MAP = { unsupported_type: 'unsupported-format', file_exists: 'invalid-output', file_locked: 'invalid-output', invalid_document: 'invalid-document', document_error: 'invalid-document', timeout: 'timeout' };
const DEFAULT_CHECK_BACKEND = 'zip';
// 判据要用它证明"被拒的动词根本没落到子进程"（不是只返回了一个错误对象）
let officecliSpawnCount = 0;
const officecliSpawnCountReset = () => { officecliSpawnCount = 0; return officecliSpawnCount; };

// 由 `capabilities` 实测钉住（2026-10-03）；kit 改了能力必须同步这里，selftest 会对账
const FORMAT_MATRIX = {
  word: { inputs: ['doc', 'docx', 'odt'], outputs: ['pdf', 'docx', 'odt', 'txt'] },
  sheet: { inputs: ['xls', 'xlsx', 'ods'], outputs: ['pdf', 'xlsx', 'ods', 'csv'] },
  slide: { inputs: ['ppt', 'pptx', 'odp'], outputs: ['pdf', 'pptx', 'odp'] },
};
// kit 的失败码族（实测八种会原样穿过传输层）
// 元数据探针清单（R2-a 起 scrub 与 check 共用一份；scrub 的回查条数判据**故意另写一遍**，那是防“删了几个才查几个”的独立对账）
const META_PROBE_FIELDS = ['dc:creator', 'dc:title', 'dc:subject', 'dc:description', 'cp:keywords', 'cp:lastModifiedBy', 'Company', 'Manager', 'Template', 'Application'];
// 语言白名单与字符集基线共用的扫描面（v1.6.0 R3-b 提到这里，台子 require 得到它）
// 公开树版（2026-10-15 机主裁决开源化）：清单改为**惰性求值**——内账文档（总览/日志/调用卡/登记表）不入公开面时
// 自动退出扫描；不能在模块加载期求值（fs/path 此时尚未初始化），必须等调用时再解析。
const LANG_FILES_ALL = ['README.md', '项目总览.md', '迭代日志.md', '给其它agent-调用卡.md', 'dockit.js', 'test/mutant.js', 'test/font-baseline.js', 'package.json', 'entry-points.json'];
function langFiles() { return LANG_FILES_ALL.filter((f) => fs.existsSync(path.join(ROOT, f))); } // R-D（v1.6.4）：登记表也是在册文本，纳入白名单扫描面
const KIT_ERROR_CODES = ['invalid-document', 'unsupported-format', 'input-too-large', 'output-too-large', 'invalid-output', 'timeout', 'unavailable', 'failed'];
// 全命令通用的**无副作用**开关：装置的 stdout 本来就恒是一行 JSON，`--json` 只是照习惯带、不改变任何行为。
// 它必须在这里点名而不是默默放过——R1-b 之后未知开关一律拒绝，漏了这条声明就会把 `doctor --json` 打红。
const GLOBAL_FLAGS = ['json'];
// 最近邻候选的容错（Damerau 距离，交换相邻两字符算一步）：短名字的 1 步错拼与大名字的 3 步不能共用一个门限
const CANDIDATE_TOL = (name) => (name.length <= 3 ? 1 : name.length <= 8 ? 2 : 3);
const CANDIDATE_LIMIT = 3;
// dump 的三个上限（R2-b）：形状条数、扫描体积、正文条目——超限一律自报 truncated，不静默截断
const DUMP_SHAPE_CAP = 60;
const DUMP_SCAN_MAX_BYTES = 4000000;
const DUMP_TEXT_MAX_ITEMS = 300;
// check 的结论族（R2-a）：命令面、--kind 过滤、判据三方都用这一份清单，写错名字就红在覆盖面条款上
// v2.6.0 外发风险面 +6 族：hidden-content / external-link / embedded-object / macro / custom-xml / form-field
const CHECK_KINDS = ['meta-field', 'formula-error-cache', 'missing-alt-text', 'revisions', 'comments', 'empty-sheet', 'empty-page', 'hidden-content', 'external-link', 'embedded-object', 'macro', 'custom-xml', 'form-field'];
// check 的结论清单上限（与 dump 的三个上限同族）：counts 恒权威、findings 清单封顶、超限一律自报 truncated，不静默截断
const CHECK_FINDINGS_CAP = 200;
// check 的**逐容器适用面**（v2.6.0）：报告必须自报"这一类容器实际查了哪些族"——不适用＝明说没查，不许默默算成"查过且干净"。
// 由判据 `check 逐容器适用面` 双向核：族名必须在 CHECK_KINDS 里、CHECK_KINDS 每族必须在至少一个容器里被查到。
const CHECK_APPLICABLE = {
  docx: ['meta-field', 'missing-alt-text', 'revisions', 'comments', 'empty-page', 'hidden-content', 'external-link', 'embedded-object', 'macro', 'custom-xml'],
  xlsx: ['meta-field', 'formula-error-cache', 'empty-sheet', 'hidden-content', 'external-link', 'embedded-object', 'macro', 'custom-xml'],
  pptx: ['meta-field', 'missing-alt-text', 'empty-page', 'hidden-content', 'external-link', 'embedded-object', 'macro', 'custom-xml'],
  odt: ['meta-field', 'empty-page', 'hidden-content', 'external-link', 'embedded-object', 'macro'],
  ods: ['meta-field', 'empty-sheet', 'hidden-content', 'external-link', 'embedded-object', 'macro'],
  odp: ['meta-field', 'empty-page', 'hidden-content', 'external-link', 'embedded-object', 'macro'],
  pdf: ['meta-field', 'hidden-content', 'external-link', 'embedded-object', 'macro', 'form-field'],
};
// ODF 元数据在 meta.xml（R3-a 才清；这一轮 check 先把"出域字段"点名）
// ODF 的元数据全在 meta.xml。探针清单与删除清单同源不同用：删除若漏一条，--verify 仍要能从探针里发现残留
const ODF_META_FIELDS = ['meta:initial-creator', 'dc:creator', 'dc:title', 'dc:subject', 'dc:description', 'meta:generator', 'meta:editing-duration', 'dc:date', 'meta:keyword'];
// LO 写出的 odt/ods/odp 都带这份缩略图——它渲染的就是文档第一页，属于**版面内容**，scrub 必须整条删掉（《文档操作规范》§6）
const ODF_THUMBNAIL_PARTS = ['Thumbnails/thumbnail.png'];
// ---- v1.9.0：media / batch / combine / split 四条新命令的常量与采集面 ----
// media 只收"正文里嵌入的媒体"所在目录：OOXML 三族的 media/ 与 ODF 的 Pictures/。预览件（docProps/thumbnail*、
// ODF 的 Thumbnails/*）不在采集面——它们是文档预览或版面内容，不许冒充"媒体件"。上限超了直接拒，不静默截断。
const MEDIA_PREFIXES = ['word/media/', 'ppt/media/', 'xl/media/', 'Pictures/'];
const MEDIA_MAX_FILES = 300;
// batch：目录级批量转换（逐件走 to 同一条路）。件数上限防"一次扫掉整个盘"；超限拒绝并指路。
const BATCH_DEFAULT_TO = 'pdf';
const BATCH_MAX_ITEMS = 200;
// v2.6.0：batch 逐件跑哪条命令面可选——to（默认，走引擎转换）／markdown（走 pandoc，产物恒 .md、不吃 --to）。
// 只有这两条：其它命令各有自己的位置参数形状（combine 要两件以上、split 只吃 PDF），塞进 batch 就是把"逐件"变成"逐件猜参数"。
const BATCH_DEFAULT_CMD = 'to';
const BATCH_CMDS = ['to', 'markdown'];
// v2.7.0：frommd 的默认目标族。必须在配置区声明——CONFIG_CONSTANTS 的对账表在文件头部读它，放到后面会撞 TDZ（实测 ReferenceError: Cannot access before initialization）。
const FROMMD_DEFAULT_TO = 'docx';
// v2.7.0：redline／tables／compress 三条默认值同样住在这里，供 HELP_SPEC 的 defaultFrom 对账钉来源
const REDLINE_DEFAULT_AUTHOR = 'dockit';
const TABLES_MAX_TABLES = 20;
const COMPRESS_MIN_STREAM_BYTES = 512;
// v3.1.0：redact 的 --fill 默认值（black＝画框脱敏；none＝删字留白）——同样钉来源供 CONFIG_CONSTANTS 对账
const REDACT_DEFAULT_FILL = 'black';
// v2.8.0：sheetop（xlsx 结构微编辑＋引用重写）的操作族与两条默认值；必须在配置区——CONFIG_CONSTANTS 对账表在文件头部读它们
const SHEETOP_OPS = ['row-insert', 'col-insert', 'row-move', 'col-move'];
const SHEETOP_DEFAULT_COUNT = 1;
const SHEETOP_MAX_SHIFT = 1000;
// v2.9.0 F6：本地解包路线（不起引擎、整件 readFileSync 的那一族）此前没有任何输入体积上限——kit 路线有
// --max-input-bytes／input-too-large，本地面是漏的。默认 256 MB，可用 --max-input-bytes 或 DOCKIT_MAX_INPUT_BYTES 抬。
const MAX_INPUT_BYTES_DEFAULT = 268435456;
const GC_MIN_AGE_DAYS = 7;
// gc 默认扫哪一块——同样必须住在这里：HELP_SPEC 的 default 写字面量＋defaultFrom 钉来源，改配置区不改 help 才会红
const GC_DEFAULT_DIR = 'both';
// split：单次拆分最多出多少件产物（超限拒绝并指路：合并区间或增大 --every）。
const SPLIT_MAX_OUTPUTS = 100;
// pdftext：pdftotext 默认文本编码（透传 -enc）。
const PDFTEXT_DEFAULT_ENC = 'UTF-8';
// ---- v2.3.0：markdown 命令（pandoc 后端，文档→GFM 摄取向）----
// 输入面＝pandoc 3.12 实测能读、且与本装置受众相关的族（旧库房族 .doc/.xls/.ppt 不在：pandoc 不读 OLE，
// 先 `to` 转成新族再跑本条；PDF 也不在：取字走 pdftext、扫描件走 pages＋ocr）。
const MARKDOWN_INPUT_EXTS = ['docx', 'odt', 'pptx', 'xlsx', 'csv', 'tsv', 'html', 'htm'];
// 默认 --wrap=none：不按列宽硬折行（中文长段被硬折后按行匹配会假红，机器可读优先）；要折行由调用方显式给 auto/preserve。
const MARKDOWN_DEFAULT_WRAP = 'none';
const MARKDOWN_WRAPS = ['none', 'auto', 'preserve'];
// 🔴 水印：v2.4.0 曾实现后由机主当轮裁撤（"不要水印"）——不再实现；过程记录见迭代日志 v2.4.0 条。
// 已知缺失即影响中文排版的常见族（仅用于体检提示，权威判定仍以 kit 的 missingFonts 为准）
const CJK_HINT_FAMILIES = ['宋体', 'SimSun', '微软雅黑', 'Microsoft YaHei', '楷体', '楷体_GB2312', '黑体', 'SimHei', '仿宋', '仿宋_GB2312', '等线', 'Calibri', 'Cambria'];
// 🔴 help --json 的默认值**对账表**（R1-a / 任务书 P1-4）。HELP_SPEC 里的 `default` 一律写**字面量**（不许引用常量），
// 由判据 `help 结构化命令面` 拿这张表逐条比"help 报的默认值 == 配置区常量的当前值"。
// 为什么要绕这一圈：help 若直接 `default: DEFAULT_TIMEOUT_MS`，它对配置区的引用恒真，那条判据**结构上永远红不了**
// （＝总览第四节第 18 条实名过的 `Set.length` 假牙）。写成字面量＋钉来源，改配置区不改 help 才会红。
const CONFIG_CONSTANTS = {
  DEFAULT_TIMEOUT_MS, DPI_DEFAULT, MAX_PIXEL_TILES, DEFAULT_SHEETS_METHOD, DEFAULT_TO_OUTPUT_EXT,
  DEFAULT_RECALC_OUTPUT_EXT, TESSDATA_DIR, TESSERACT_EXE, OCR_DEFAULT_LANG, VERSION, KIT_VERSION,
  DEFAULT_CHECK_BACKEND, MEDIA_MAX_FILES, BATCH_MAX_ITEMS, BATCH_DEFAULT_TO, BATCH_DEFAULT_CMD, PDFTEXT_DEFAULT_ENC, FROMMD_DEFAULT_TO,
  MARKDOWN_DEFAULT_WRAP, REDLINE_DEFAULT_AUTHOR, TABLES_MAX_TABLES, COMPRESS_MIN_STREAM_BYTES, REDACT_DEFAULT_FILL,
  SHEETOP_DEFAULT_COUNT, SHEETOP_MAX_SHIFT,
  MAX_INPUT_BYTES_DEFAULT, GC_MIN_AGE_DAYS, GC_DEFAULT_DIR,
};
//#endregion

//#region 工具函数区
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync: cpSpawnSync } = require('node:child_process');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// 🔴 v2.3.0 spawn 统一包装（本会话宿主实测修正，2026-10-10）：调用选项里没给 stdio 的，一律钉成
//   stdin=ignore、stdout/stderr=pipe（钉桩字面只在下一行代码里，本注释刻意不抄——注释里抄一份会让
//   `spawn 统一 stdio` 判据在"代码被拆掉"时假绿）。起因＝在本会话宿主里实测出**缺省 stdio 的 spawnSync
//   稳定 EBUSY**（`spawnSync <exe> EBUSY`；同一个 exe 由 bash/python 作父进程直接起都正常，只有 node
//   起子进程这一路失败；把 stdin 钉成 ignore 后就跑通了——对照实验脚本在 _tmp/repro-*.js，A/B/C 三组
//   各去掉一个候选嫌疑才收敛到 stdio）。语义零影响：本装置所有子进程都不读 stdin（全为参数驱动），
//   仓内没有任何 input: 喂数据的调用点。防回退结构＝解构改名：谁把解构改回原名形态会与本同名函数
//   声明撞出 SyntaxError（编译期即拦）；selftest 判据 `spawn 统一 stdio` 再核五个宿主文件的三件套
//   （别名解构＋同名包装＋stdin 钉桩），变异 M173/M174 各打一层。
// v3.0.1 审查轮订正：SPAWN_STDIO_PINNED → SPAWN_STDIO_DEFAULT——它是"调用方没给 stdio 时的缺省填充"，
// 调用方显式传 stdio 可覆盖（判据与变异都不依赖这个常量名，只认三件套形态；M173/M174 锚点已同步改名）。
const SPAWN_STDIO_DEFAULT = ['ignore', 'pipe', 'pipe'];
function spawnSync(exe, args, opts) {
  const o = Object.assign({}, opts || {});
  if (!o.stdio) o.stdio = SPAWN_STDIO_DEFAULT;
  return cpSpawnSync(exe, args, o);
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const abs = (p) => path.resolve(p);
const extOf = (p) => path.extname(String(p)).replace(/^\./, '').toLowerCase();
const stamp = () => new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14);
const die = (code, error, next, extra = {}) => { out({ ok: false, code, error, next, ...extra }); process.exit(1); };
const familyOf = (ext) => (Object.entries(FORMAT_MATRIX).find(([, v]) => v.inputs.includes(ext)) || [])[0] || null;

let SRC_CACHE = null;
/** 命令函数体的文本（判据用来核“宣告与实装同面”“不得起引擎”这类源码层断言）；同一份源码只读一次 */
function cmdBody(name) {
  if (SRC_CACHE === null) SRC_CACHE = fs.readFileSync(__filename, 'utf8').replace(/\r\n/g, '\n'); // AUD-2（v1.6.6）：归一化行尾——真克隆（git autocrlf）落 CRLF，`\n}\n` 函数尾锚定会全部失效
  const fn = 'function cmd' + name[0].toUpperCase() + name.slice(1) + '(';
  const i = SRC_CACHE.indexOf(fn); if (i < 0) return null;
  const j = SRC_CACHE.indexOf(String.fromCharCode(10) + '}' + String.fromCharCode(10), i);
  return j < 0 ? null : SRC_CACHE.slice(i, j + 3);
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
/** Damerau（OSA 形）编辑距离：相邻两字符交换算**一步**——`--tiemout-ms` 这类换位错拼是真人最常犯的 */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  const d = Array.from({ length: m + 1 }, (_, i) => { const row = new Array(n + 1).fill(0); row[0] = i; return row; });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
/** 错拼→最近邻候选（R1-b／任务书 P1-5）。三条规矩都有判据钉着：
 *  ① **正确名一律回空**（回候选＝把"你用对了"这件事也当成错误在报）；
 *  ② 候选只从传入的 pool 里出，且不比输入本身远过 `CANDIDATE_TOL(输入)`——差太远就宁可不给（给个不相干的开关比给空的害处大）；
 *  ③ 结果按 (距离, 名字) 稳定排序并截到 `CANDIDATE_LIMIT`，去重。 */
function nearestCandidates(name, pool, limit = CANDIDATE_LIMIT) {
  const key = String(name || '').toLowerCase();
  if (!key || pool.includes(name)) return [];
  const tol = CANDIDATE_TOL(key);
  return [...pool]
    .map((p) => ({ p, d: editDistance(key, String(p).toLowerCase()) }))
    .filter((x) => x.d <= tol)
    .sort((a, b) => a.d - b.d || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
    .slice(0, limit)
    .map((x) => x.p);
}
/** 选一个一定不存在的产物路径：base → base-2 → base-3 …（kit 遇 EEXIST 直接失败，不覆盖） */
/** F6：本地路线统一输入体积闸。超限回 input-too-large（结构化码，不 OOM、不落半成品）。
 *  🔴 v3.0.0 修（自检自修实抓）：`--max-input-bytes` 是"明示收紧/放宽"的开关，非法值**不许静默回退默认**——
 *  写在命令行上的值被当成没写，就是 R1-b"错值被当成没提这个开关"的同族（实测 `abc`／`0` 都悄悄按 256 MB 跑完）。
 *  现：提供了就必须是 ≥1 的整数，否则 invalid-output；env 通道维持旧语义（坏值回默认），它算环境不算明示参数。 */
function inputSizeGuard(rawArg, capBytes, cmd) {
  let cap;
  if (capBytes === undefined || capBytes === null) cap = maxInputBytesDefault();
  else {
    const v = Number(capBytes);
    if (!Number.isInteger(v) || v < 1) die('invalid-output', `--max-input-bytes 必须是 ≥1 的整数（字节），给了 ${JSON.stringify(String(capBytes))}`, '照 help 的默认值 268435456 给；空值/非数/小数/0 都不算有效上限——不给这个开关才等于"用默认"');
    cap = v;
  }
  if (!rawArg || String(rawArg).startsWith('--')) return cap;
  let st;
  try { st = fs.statSync(abs(String(rawArg))); } catch { return cap; }
  if (!st.isFile()) return cap;
  if (st.size > cap) die('input-too-large', `${cmd || '本命令'}：输入 ${st.size} B 超过上限 ${cap} B`, '先确认这是不是一份真件而非误指的归档；要抬限用 --max-input-bytes 或 DOCKIT_MAX_INPUT_BYTES（属放宽规则，需机主明确同意）');
  return cap;
}
function maxInputBytesDefault() {
  const v = Number(process.env.DOCKIT_MAX_INPUT_BYTES);
  return Number.isFinite(v) && v > 0 ? v : MAX_INPUT_BYTES_DEFAULT;
}

/** 只在"基础名已被占用"时才列一次目录（12,678 个条目也就一次 readdirSync），替代旧的逐号 existsSync 循环。 */
function dirNamesOf(dir) { try { return new Set(fs.readdirSync(dir)); } catch { return new Set(); } }
/** 选一个一定不存在的产物路径：base → base-2 → base-3 …（kit 遇 EEXIST 直接失败，不覆盖）
 *  🔴 v2.9.0 O3：旧实现是 `while (fs.existsSync(...))` 逐号试——测试产物沉积后同名占用可达 1,499 个，
 *  一次调用要做 1,499 次 stat（实测 92.3 ms）。现在无占用仍是一次探针，有占用才列一次目录在集合里跳号。
 *  🔴 v3.0.0 修（自检自修轮实抓的回归）：readdir 集合是**精确大小写**的，而 Windows 卷不敏感——`Case-2.pdf`
 *  已在位时候选 `case-2.pdf` 在集合里查不到、existsSync 却属实占用；只信集合会把它再发一次＝覆盖（承重 2）。
 *  ⇒ 集合只做跳号快路径，**发出去之前一律 existsSync 复核**（与老实现同一条真理口径；readdir 失败时集合为空也由此兜住）。 */
function freePath(dir, base, ext) {
  ensureDir(dir);
  const first = `${dir}/${base}.${ext}`;
  if (!fs.existsSync(first)) return first;
  const taken = dirNamesOf(dir);
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.${ext}`) && !fs.existsSync(`${dir}/${base}-${n}.${ext}`)) return `${dir}/${base}-${n}.${ext}`;
}
/** 同上，但产物是目录（kit 的 render 要一个「不存在且父级存在」的目录）；v2.9.0 同一把修法 */
function freeDir(dir, base) {
  ensureDir(dir);
  const first = `${dir}/${base}`;
  if (!fs.existsSync(first)) return first;
  const taken = dirNamesOf(dir);
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`) && !fs.existsSync(`${dir}/${base}-${n}`)) return `${dir}/${base}-${n}`;
}

/** v1.9.0：combine/split 的 PDF 依赖是纯 JS 的 pdf-lib（进 package.json dependencies）。惰性装载：
 *  缺件回结构化 unavailable（不裸抛）；真克隆态下判据靠它把相关条目逐条 SKIP 点名。 */
function loadPdfLib() {
  try { return { lib: require('pdf-lib') }; }
  catch (e) { return { error: String((e && e.code) || (e && e.message) || e).slice(0, 140) }; }
}
const PDFLIB_NEXT = '在装置目录里执行 npm install（把 pdf-lib 装上；它已进 package.json 的 dependencies）';

/** v2.5.0：pdfform 的表单字体面——pdf-lib 嵌 TTF 必须配 fontkit（@pdf-lib/fontkit，纯 JS，进 package.json 的 dependencies）。
 *  缺件回结构化 unavailable（不裸抛）；真克隆态下 pdfform 判据靠它逐条 SKIP 点名。 */
function loadFontkit() {
  try { return { lib: require('@pdf-lib/fontkit') }; }
  catch (e) { return { error: String((e && e.code) || (e && e.message) || e).slice(0, 140) }; }
}
const FONTKIT_NEXT = '在装置目录里执行 npm install（把 @pdf-lib/fontkit 装上；它已进 package.json 的 dependencies）';
// 中文字段值的候选字体（本机标准位，取第一件存在者；也可用 --font 显式指定单体 TTF）
const PDFFORM_FONT_CANDIDATES = ['C:\\Windows\\Fonts\\仿宋_GB2312.ttf', 'C:\\Windows\\Fonts\\simfang.ttf', 'C:\\Windows\\Fonts\\simhei.ttf', 'C:\\Windows\\Fonts\\simkai.ttf'];
// scrub 的 PDF 面：/Info 目标键清单（与 OOXML 的 docProps 目标清单同族——值不回显，只报键名）
const PDF_META_TARGETS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped'];

/** inspect 的 PDF 结构探针（2026-10-10 技能对照轮增量，未升版／未加命令／未加判据——见迭代日志 v2.0.0 节补记）。
 *  纯 JS、复用 combine/split 已受控的 pdf-lib、不起引擎、不回显正文与元数据值（守 inspect 的隐私姿态）。
 *  补的是 inspect 在 PDF 上一直缺的半面：页数／逐页版式与方向／加密／**字体嵌入与 CJK**——中文交付前
 *  "换机会不会变豆腐块"此前只能靠 pages 渲染＋OCR 间接猜（慢且 OCR 对数字 PDF 覆盖率低），这里给确定性结构答案。
 *  任何一步读不通都降级成 unavailable 子块，绝不让 inspect 整体炸（inspect 是形状探针，见项目总览 §八第 4 条）。 */
const PDF_PAGE_LIST_CAP = 100;                                   // 逐页几何列出上限，与渲染 100 页天花板同族
const PDF_STANDARD14 = new Set(['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats']);
// 名字族只是 CJK 的**弱提示**（CIDSystemInfo 才是权威），用于给 LibreOffice 那类把中文嵌成 WinAnsi 子集 TrueType、不带 CID 的件贴标
const PDF_CJK_NAME_RE = /(simsun|simhei|simkai|simli|simyou|nsimsun|kaiti|fangsong|dengxian|microsoftyahei|microsoftjhenghei|songti|heiti|stsong|stheiti|mingliu|pmingliu|noto[^a-z]*(cjk|sans[^a-z]*sc|serif[^a-z]*sc)|sourcehan|wenquanyi|ukai|uming)/i;
function pdfNameText(n) {
  if (!n) return null;
  if (typeof n.encodedName === 'string') return n.encodedName.replace(/^\//, '');
  if (typeof n.value === 'string') return n.value;
  if (typeof n.decodeText === 'function') { try { return n.decodeText(); } catch { /* 落到字符串化 */ } }
  return String(n);
}
function pdfStripSubset(name) { return String(name || '').replace(/^[A-Z]{6}\+/, ''); }
async function pdfStructuralProbe(buf) {
  const head = buf.subarray(0, 8).toString('latin1');
  const vm = head.match(/%PDF-(\d+\.\d+)/);
  const base = { backend: 'pdf-lib', pdfVersion: vm ? vm[1] : null };
  const pl = loadPdfLib();
  if (pl.error) return { ...base, unavailable: true, code: 'unavailable', error: `pdf-lib 不在 node_modules：${pl.error}`, next: PDFLIB_NEXT };
  const { PDFDocument, PDFName, PDFDict, PDFArray } = pl.lib;
  let doc;
  try { doc = await PDFDocument.load(buf, { updateMetadata: false, ignoreEncryption: true }); }
  catch (e) {
    const msg = String((e && e.message) || e);
    // v3.0.1 审查轮订正：unavailable 只留给"依赖缺失"（上一分支）；这一分支依赖在、是**输入有问题**，
    // 标 degraded——两个字段混用会让调用方把坏件误读成"环境不支持"（code 一直是对的，错的只是标记名）。
    return { ...base, degraded: true, code: /encrypt/i.test(msg) ? 'unsupported-format' : 'invalid-document', error: msg.slice(0, 160) };
  }
  const probe = { ...base, encrypted: !!doc.isEncrypted, pageCount: null, pages: [], pagesListed: 0, pagesTruncated: false };
  // ① 页数与逐页几何（mediabox＋旋转），列出封顶 100，pageCount 始终权威；读不通留 null＋pagesError（不炸）
  try {
    const all = doc.getPages();
    probe.pageCount = all.length;
    const cap = Math.min(all.length, PDF_PAGE_LIST_CAP);
    for (let i = 0; i < cap; i++) {
      const pg = all[i]; const sz = pg.getSize(); const rot = (pg.getRotation && pg.getRotation().angle) || 0;
      const w = Math.round(sz.width * 10) / 10, h = Math.round(sz.height * 10) / 10;
      probe.pages.push({ index: i + 1, widthPt: w, heightPt: h, widthMm: Math.round(w * 25.4 / 72), heightMm: Math.round(h * 25.4 / 72), orientation: w > h ? 'landscape' : 'portrait', rotation: rot });
    }
    probe.pagesListed = cap; probe.pagesTruncated = all.length > cap;
  } catch (e) { probe.pages = []; probe.pagesError = String((e && e.message) || e).slice(0, 120); }
  // ⑫ 交互层（AcroForm 表单）：combine/split 的 v1 刻意不保留表单/签名/批注（项目总览 §八#25），
  // 拼拆前先让 inspect 点明"这份 PDF 有表单、拼了会丢"，避免静默丢交互层。只读结构、不读字段值。
  try {
    let form = null, formFields = null;
    // pdf-lib 1.17.1：doc.catalog.dict 是内部 Map（无 lookup）；真正的 catalog PDFDict 要经 trailer Root 取
    const rootRef = doc.context && doc.context.trailerInfo && doc.context.trailerInfo.Root;
    const cat = rootRef ? doc.context.lookup(rootRef) : null;
    if (cat instanceof PDFDict) {
      const af = cat.lookup(PDFName.of('AcroForm'));
      if (af instanceof PDFDict) {
        form = 'AcroForm';
        const flds = af.lookup(PDFName.of('Fields'));
        if (flds && typeof flds.size === 'function') formFields = flds.size();
      }
    }
    probe.interactive = { form, formFields };
    probe.formAdvice = form ? `该 PDF 含 AcroForm 表单（${formFields == null ? '?' : formFields} 个字段）：combine/split 的 v1 不保留表单/签名/批注（项目总览 §八#25），拼拆会丢交互层；要保留请走专门 PDF 工具，别把拼拆件当原件交付` : undefined;
  } catch (e) { probe.interactive = { form: null, formError: String((e && e.message) || e).slice(0, 100) }; }
  // ② 字体：两遍扫，先收全部 /Type /Font 字典，再把 Type0 的 CID 子字体从"独立行"里剔除（与 pdffonts 一样一个逻辑字体一行）
  try {
    const N = (s) => PDFName.of(s);
    const fontObjs = new Map();
    for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFDict)) continue;
      const tt = o.get(N('Type'));
      if (tt && tt.encodedName === '/Font') fontObjs.set(ref.objectNumber, o);
    }
    const childNums = new Set();
    for (const o of fontObjs.values()) {
      const st = o.get(N('Subtype'));
      if (!st || st.encodedName !== '/Type0') continue;
      const df = o.lookup(N('DescendantFonts'));
      if (df instanceof PDFArray) for (let i = 0; i < df.size(); i++) { const cr = df.get(i); if (cr && cr.objectNumber) childNums.add(cr.objectNumber); }
    }
    const fonts = [];
    for (const [num, o] of fontObjs) {
      if (childNums.has(num)) continue;
      const st = o.get(N('Subtype'));
      let baseFont = pdfNameText(o.get(N('BaseFont')));
      let embedded = null, cjk = false, cjkBy = null, cidSubtype = null, cidKey = null;
      const fd0 = o.lookup(N('FontDescriptor'));
      if (fd0 instanceof PDFDict) {
        if (!baseFont) baseFont = pdfNameText(fd0.get(N('FontName')));
        embedded = !!(fd0.lookup(N('FontFile')) || fd0.lookup(N('FontFile2')) || fd0.lookup(N('FontFile3')));
      }
      const df = o.lookup(N('DescendantFonts'));
      if (df instanceof PDFArray && df.size()) {
        const cid = df.lookup(0);
        if (cid instanceof PDFDict) {
          const cs = cid.get(N('Subtype')); cidSubtype = cs ? cs.encodedName.replace(/^\//, '') : null;
          const csi = cid.lookup(N('CIDSystemInfo'));
          if (csi instanceof PDFDict) {
            const rg = csi.lookup(N('Registry')); const od = csi.lookup(N('Ordering'));
            const registry = rg ? (rg.decodeText ? rg.decodeText() : String(rg)) : '';
            const ordering = od ? (od.decodeText ? od.decodeText() : String(od)) : '';
            cidKey = (registry + ordering) || null;
            if (/GB1|CNS1|Japan1|Korea1/.test(cidKey)) { cjk = true; cjkBy = 'cid'; }
          }
          const cfd = cid.lookup(N('FontDescriptor'));
          if (cfd instanceof PDFDict) embedded = !!(cfd.lookup(N('FontFile')) || cfd.lookup(N('FontFile2')) || cfd.lookup(N('FontFile3')));
        }
      }
      const fam = pdfStripSubset(baseFont || '');
      if (!cjk && fam && PDF_CJK_NAME_RE.test(fam)) { cjk = true; cjkBy = 'name'; }
      if (embedded === null) embedded = PDF_STANDARD14.has(fam) ? 'standard' : false;
      fonts.push({ object: num, subtype: st ? st.encodedName.replace(/^\//, '') : null, baseFont, embedded, cjk, cjkBy,
        ...(cidSubtype ? { cidSubtype } : {}), ...(cidKey ? { cidSystem: cidKey } : {}) });
    }
    const cjkFonts = fonts.filter((f) => f.cjk);
    const unemb = fonts.filter((f) => f.embedded === false);
    probe.fonts = fonts;
    probe.fontSummary = {
      total: fonts.length,
      embedded: fonts.filter((f) => f.embedded === true).length,
      standard: fonts.filter((f) => f.embedded === 'standard').length,
      unembedded: unemb.length,
      unembeddedFonts: unemb.map((f) => f.baseFont),
      cjk: cjkFonts.length,
      cjkEmbedded: cjkFonts.length ? cjkFonts.every((f) => f.embedded === true) : null,
    };
    probe.fontAdvice = unemb.length
      ? `发现 ${unemb.length} 个未嵌入的非标准字体（${unemb.map((f) => f.baseFont).filter(Boolean).slice(0, 6).join('、')}）：缺字机器上可能回退或变豆腐块，中文交付尤甚。外发前在源程序勾选嵌入字体后重新导出 PDF，再用 inspect 复查 fontSummary.unembedded=0。`
      : (fonts.length ? '非标准字体全部已嵌入（standard＝阅读器自带 Base14）：换机渲染不依赖对方装字。' : undefined);
  } catch (e) { probe.fonts = []; probe.fontSummary = null; probe.fontsError = String((e && e.message) || e).slice(0, 120); }
  return probe;
}

/** v2.6.0：check 的 PDF 面——外发风险的**结构**扫描（纯 JS、复用 combine/split 已受控的 pdf-lib；不起引擎、不写盘、值一律不回显）。
 *  check 此前一律拒 PDF，"这份要出门的 PDF 里有没有作者串 / 隐藏图层 / 外链与 /Launch / 附件 / 内嵌脚本 / 表单"没有确定性答案。
 *  加密件走 ignoreEncryption 只读结构：读不全就如实报 encrypted＋warning，**绝不宣称查干净**。
 *  与 pdfStructuralProbe 各自装载（消费者不同、降级面不同：探针坏不该把体检带崩，反之亦然）。 */
const PDF_XMP_FIELD_RE = /<(dc:creator|dc:title|dc:subject|dc:description|pdf:Keywords|pdf:Producer|xmp:CreatorTool|xmp:ModifyDate|xmp:CreateDate|xmp:MetadataDate)[\s>]/g;
async function pdfRiskScan(buf) {
  const pl = loadPdfLib();
  if (pl.error) return { unavailable: true, code: 'unavailable', error: `pdf-lib 不在 node_modules：${pl.error}`, next: PDFLIB_NEXT };
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } = pl.lib;
  let doc = null;
  try { doc = await PDFDocument.load(buf, { updateMetadata: false, ignoreEncryption: true }); }
  catch (e) {
    const msg = String((e && e.message) || e);
    return { loadError: { code: /encrypt/i.test(msg) ? 'unsupported-format' : 'invalid-document', error: msg.slice(0, 160) } };
  }
  const N = (s) => PDFName.of(s);
  const nameOf = (v) => (v && typeof v.encodedName === 'string' ? v.encodedName.replace(/^\//, '') : null);
  const deref = (v) => (v instanceof PDFDict ? v : (v && v.objectNumber !== undefined ? doc.context.lookup(v) : null));
  // 🔴 "能不能读"必须由**结构自证**，不能只靠 load 不抛：实测 `%PDF-1.7\nthis is not really a pdf` 这种坏件，
  //    pdf-lib 的 load 成功返回一个连 doc.catalog 都取不到的空壳——只装不作就把坏件洗成 clean=true（假成功，比报错坏得多）。
  let rootCat = null;
  try { const rr = doc.context.trailerInfo.Root; rootCat = rr ? doc.context.lookup(rr) : null; } catch { rootCat = null; }
  if (doc.isEncrypted) return { encryptedOnly: true };
  if (!(rootCat instanceof PDFDict)) return { loadError: { code: 'invalid-document', error: 'load 没抛错但取不到 /Root 目录对象（交叉表或目录缺失）：这一面判不了，别把坏件当"查过且干净"' } };
  let pageCount = null;
  try { pageCount = doc.getPageCount(); } catch (e) { return { loadError: { code: 'invalid-document', error: '页树读不通：' + String((e && e.message) || e).slice(0, 140) } }; }
  const findings = []; const warnings = [];
  const add = (kind, part, locator, detail) => findings.push({ kind, part, locator, detail });
  const counts = { uri: 0, goToRemote: 0, launch: 0, javascript: 0, autoActions: 0, ocg: 0, ocgDefaultOff: 0, embeddedFile: 0, objectsScanned: 0 };
  // ① /Info：与 scrub 的 PDF 面同一份目标键清单（清过了这边就不该再看见）
  try {
    const infoRef = doc.context.trailerInfo.Info;
    const info = infoRef ? doc.context.lookup(infoRef) : null;
    if (info instanceof PDFDict) {
      for (const k of PDF_META_TARGETS) {
        const v = info.get(N(k)); if (!v) continue;
        let txt = '';
        try { txt = v.decodeText ? String(v.decodeText()) : String(v); } catch { txt = '(解码失败，按非空计)'; }
        if (!txt.trim()) continue;
        add('meta-field', 'trailer:/Info', k, `/Info 的 ${k} 非空（值 ${Buffer.byteLength(txt, 'utf8')} B，不回显）——外发前走 scrub 的 PDF 面`);
      }
    }
  } catch (e) { warnings.push('/Info 这一面没跑通：' + String((e && e.message) || e).slice(0, 90)); }
  // ② XMP（catalog /Metadata）：FlateDecode 的流要先解；解不通只报"在位"，不冒充读过内容
  try {
    const ms = deref(doc.catalog.get(N('Metadata')));
    if (ms instanceof PDFRawStream) {
      const filter = nameOf(ms.dict.get(N('Filter')));
      let text = null;
      try {
        const raw = Buffer.from(ms.getContents());
        text = filter === 'FlateDecode' ? zlib.inflateSync(raw).toString('latin1') : raw.toString('latin1');
      } catch { text = null; }
      if (text === null) {
        add('meta-field', 'catalog:/Metadata', 'XMP（流解不通）', `XMP 包在位但流解码失败（Filter=${filter || 'none'}）：这一面只确认"有"，没读到字段，不许当已核过`);
      } else {
        const hitNames = [...new Set([...text.matchAll(PDF_XMP_FIELD_RE)].map((m) => m[1]))].filter((n) => {
          const v2 = new RegExp('<' + n + '[^>]*>([^<]*)</' + n + '>', 'g').exec(text);
          return !!(v2 && v2[1].trim() !== '');
        });
        for (const n of hitNames) add('meta-field', 'catalog:/Metadata', n, `XMP 里 ${n} 非空（值不回显）——scrub 的 PDF 面连整段 XMP 一起摘除`);
        if (!hitNames.length) warnings.push('XMP 包在位但目标字段全为空：不算结论，要整段摘除仍走 scrub 的 PDF 面');
      }
    } else if (doc.catalog.get(N('Metadata'))) {
      warnings.push('/Metadata 引用不是可解的流对象：XMP 这一面没跑到');
    }
  } catch (e) { warnings.push('XMP 这一面没跑通：' + String((e && e.message) || e).slice(0, 90)); }
  // ③ 逐对象扫动作族（/S 在动作字典自身、或在 /A、或在 /AA 的触发位）＋图层＋附件
  //    🔴 流对象（附件、XMP、内容流）不是 PDFDict：字典在它的 .dict 上，只认 PDFDict 会把 /Type /EmbeddedFile 整族漏掉（实测）
  let ocgOffRefs = new Set();
  try {
    const rootRef = doc.context.trailerInfo.Root;
    const cat0 = rootRef ? doc.context.lookup(rootRef) : null;
    if (cat0 instanceof PDFDict) {
      const oc = deref(cat0.lookup(N('OCProperties')));
      const d0 = oc instanceof PDFDict ? deref(oc.lookup(N('D'))) : null;
      const off = d0 instanceof PDFDict ? d0.lookup(N('OFF')) : null;
      if (off instanceof PDFArray) for (let i = 0; i < off.size(); i++) { const r = off.get(i); if (r && r.objectNumber !== undefined) ocgOffRefs.add(r.objectNumber); }
    }
  } catch { /* /OCProperties 读不通就走 /VE 单尺，下面如实自曝覆盖面 */ }
  try {
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      const isDict = obj instanceof PDFDict;
      const isStream = obj instanceof PDFRawStream;
      if (!isDict && !isStream) continue;
      const dd = isDict ? obj : obj.dict;
      counts.objectsScanned++;
      const num = ref.objectNumber;
      const acts = [];
      const selfS = nameOf(dd.get(N('S')));
      if (selfS) acts.push([selfS, dd, '动作字典本体']);
      const a = deref(dd.lookup(N('A')));
      if (a instanceof PDFDict) { const s2 = nameOf(a.get(N('S'))); if (s2) acts.push([s2, a, '/A']); }
      const aa = deref(dd.lookup(N('AA')));
      if (aa instanceof PDFDict) {
        for (const [k, v] of aa.entries()) {
          const d = deref(v);
          const s3 = d instanceof PDFDict ? nameOf(d.get(N('S'))) : null;
          if (s3) { counts.autoActions++; acts.push([s3, d, '/AA ' + nameOf(k)]); }
        }
      }
      for (const [s, d, where] of acts) {
        if (s === 'URI') { counts.uri++; add('external-link', `obj ${num}`, `${where} /S /URI obj=${num}`, '指向外部的 URI 动作（目标不回显）：外发前确认收件人能不能到达，别把内网/临时地址当可点引用'); }
        else if (s === 'GoToR') { counts.goToRemote++; add('external-link', `obj ${num}`, `${where} /S /GoToR obj=${num}`, '跨文件的 /GoToR（指向**另一个文件**，目标不回显）：收件方没有那份文件时链接必断'); }
        else if (s === 'Launch') { counts.launch++; add('external-link', `obj ${num}`, `${where} /S /Launch obj=${num}`, '🔴 /Launch 动作＝在收件人机器上启动程序/文件：这是外发面最该删掉的一类，装置不解读目标路径'); }
        else if (s === 'JavaScript') { counts.javascript++; add('macro', `obj ${num}`, `${where} /S /JavaScript obj=${num}`, '内嵌 JavaScript 动作（脚本内容不回显）：阅读器会执行，外发前确认必要性与来源'); }
      }
      const tt = nameOf(dd.get(N('Type')));
      if (tt === 'OCG') {
        counts.ocg++;
        const inOffList = ocgOffRefs.has(num);
        const veOff = nameOf(dd.get(N('VE'))) === 'OFF';
        const off = inOffList || veOff;
        if (off) counts.ocgDefaultOff++;
        add('hidden-content', `obj ${num}`, `OCG obj=${num} 默认${off ? '不可见' : '未见 OFF 标记'}`, `可选内容图层（OCG）：这一层的内容在版面上看不见但仍随件出门（层名不回显）。默认可见性本面核 /VE 与 /OCProperties/D/OFF 两种形状${inOffList ? '（命中 OFF 清单）' : (veOff ? '（命中 /VE OFF）' : '')}；别的写法未覆盖，要权威判定请在源程序里删层`);
      }
      if (tt === 'EmbeddedFile') {
        counts.embeddedFile++;
        add('embedded-object', `obj ${num}`, `/Type /EmbeddedFile obj=${num}`, `PDF 里附着内嵌文件（附件名与内容都不回显，流 ${obj.getContentsSize ? obj.getContentsSize() : '?'} B）：附件是**另一份文档**，外发前逐个确认能不能带出去`);
      }
    }
  } catch (e) { warnings.push('逐对象扫描中途读不通（后面的对象没查）：' + String((e && e.message) || e).slice(0, 90)); }
  // ④ 表单层（AcroForm 字段数与 XFA）——pdfform 能受控填写寻常 AcroForm，XFA 不在支持面
  try {
    const rootRef = doc.context.trailerInfo.Root;
    const cat = rootRef ? doc.context.lookup(rootRef) : null;
    if (cat instanceof PDFDict) {
      const af = deref(cat.lookup(N('AcroForm')));
      if (af instanceof PDFDict) {
        const flds = af.lookup(N('Fields'));
        const n = flds instanceof PDFArray ? flds.size() : null;
        add('form-field', 'catalog:/AcroForm', `AcroForm Fields=${n == null ? '?' : n}`, `该 PDF 含 AcroForm 表单（${n == null ? '?' : n} 个顶层字段）：字段值里可能已有他人填写的内容，外发前先跑 pdfform --list 看清单再决定`);
        if (af.get(N('XFA'))) add('form-field', 'catalog:/AcroForm', 'XFA 在位', '🔴 含 XFA（Adobe LiveCycle 动态表单）：装置的 pdfform 明确不做 XFA，字段与值在别处；combine/split 一碰就把 XFA 静默剥掉，别拿拼拆件当原件');
      }
      const docJs = cat.get(N('JavaScript')) ? 'JavaScript' : null;
      const names = deref(cat.get(N('Names')));
      const jsTree = !docJs && names instanceof PDFDict && names.get(N('JavaScript')) ? 'Names/JavaScript' : null;
      if (docJs || jsTree) add('macro', 'catalog', `文档级脚本面：${docJs || jsTree}`, '文档级脚本面在位（打开文档就可能执行，不只在注释里）：脚本内容不回显，外发前确认必要性与来源');
    }
  } catch (e) { warnings.push('表单与文档级脚本这一面没跑通：' + String((e && e.message) || e).slice(0, 90)); }
  return { findings, warnings, counts, pageCount, objectsScanned: counts.objectsScanned };
}

/** v2.1.0：poppler 原生 CLI（pdftotext 直取文本层 / pdfimages 抽内嵌图）。与 v1.4.0 Tesseract 同族——
 *  纳管系统原生可执行文件，**不是 Python、不触 ADR-001**（装置自己不调 Python；poppler 与 doctor 早已 WARN
 *  纳管的 pdftoppm/pandoc 同族同目录）。缺了回 unavailable、doctor 只 WARN，绝不炸裂（外人克隆没装也全绿）。
 *  DOCKIT_POPPLER_BIN 指 poppler 的 bin 目录时为**权威覆盖**（与 DOCKIT_TESSERACT 同语义）：只认该目录，
 *  不再回退 PATH/兜底——这样"指一个不存在的目录"才能稳定复现 unavailable 降级（ocr 降级判据同形状）。 */
const POPPLER_BIN_DIR = process.env.DOCKIT_POPPLER_BIN || '';
function popplerTool(tool) {
  const exeName = (process.platform === 'win32' ? tool + '.exe' : tool);
  const cand = [];
  if (POPPLER_BIN_DIR) {
    cand.push(path.join(POPPLER_BIN_DIR, exeName));                       // 显式 env＝权威，唯一候选
  } else {
    try { const w = spawnSync('where.exe', ['pdftoppm'], { encoding: 'utf8' }); if (w.status === 0) cand.push(path.join(path.dirname(String(w.stdout).trim().split(/\r?\n/)[0]), exeName)); } catch { /* where 不可用走兜底 */ }
    cand.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'poppler', 'Library', 'bin', exeName));
  }
  const found = cand.find((p) => fs.existsSync(p));
  return { tool, exe: found || cand[cand.length - 1], present: !!found, source: POPPLER_BIN_DIR ? 'env:DOCKIT_POPPLER_BIN' : (found ? 'PATH/同目录推断' : '兜底默认位') };
}
function popplerNext(tool) {
  return `装全 poppler（本机随 pdftoppm 装于 %LOCALAPPDATA%\\Programs\\poppler\\Library\\bin；缺 ${tool} 就把 poppler 装全），或设环境变量 DOCKIT_POPPLER_BIN 指到含 ${tool}${process.platform === 'win32' ? '.exe' : ''} 的 bin 目录（本次解析 ${popplerTool(tool).exe}）。它是原生 CLI、不依赖 Python（ADR-001 不拦）。🔴 poppler 的 argv 按 ANSI 解码：DOCKIT_POPPLER_BIN 指到含中文的路径必 I/O Error（v3.1.0 实测），bin 目录必须全 ASCII`;
}
/** v2.3.0：pandoc（文档→GFM markdown 的摄取后端）。与 poppler/tesseract 同族——原生 CLI、不触 ADR-001，
 *  缺了回 unavailable、doctor 只 WARN，绝不炸裂（外人克隆没装也全绿）。
 *  DOCKIT_PANDOC 指 pandoc.exe 时为**权威覆盖**（与 DOCKIT_TESSERACT 同语义）：只认该 exe，
 *  不再回退 PATH/兜底——"指一个不存在的路径"才能稳定复现 unavailable 降级（markdown 降级判据同形状）。 */
function pandocTool() {
  const fromEnv = process.env.DOCKIT_PANDOC || '';
  const cand = [];
  if (fromEnv) cand.push(fromEnv);                                      // 显式 env＝权威，唯一候选
  else {
    try { const w = spawnSync('where.exe', ['pandoc'], { encoding: 'utf8' }); if (w.status === 0) cand.push(String(w.stdout).trim().split(/\r?\n/)[0]); } catch { /* where 不可用走兜底 */ }
    cand.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'pandoc', 'pandoc.exe'));
  }
  const found = cand.find((p) => fs.existsSync(p));
  return { tool: 'pandoc', exe: found || cand[cand.length - 1], present: !!found, source: fromEnv ? 'env:DOCKIT_PANDOC' : (found ? 'PATH/兜底默认位' : '兜底默认位') };
}
function pandocNext() {
  return `装 pandoc（本机装于 %LOCALAPPDATA%\\Programs\\pandoc\\pandoc.exe），或设环境变量 DOCKIT_PANDOC 指到 pandoc.exe 的完整路径（本次解析 ${pandocTool().exe}）。它是原生 CLI、不依赖 Python（ADR-001 不拦）；只想取纯文本不装它也行：用 to ... .txt`;
}
/** v2.4.0：逗号页清单（N、N-M，1 起闭区间）→ 0 基索引数组；倒序/越界/写法错一律 die invalid-output。
 *  自 cmdPageops 抽出（页码语义单一来源，两处不许漂）。totalPages 用来校上界。 */
function parsePageList(spec, totalPages) {
  const res = [];
  for (const tok of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(tok);
    if (!m) die('invalid-output', `页段 ${JSON.stringify(tok)} 读不懂`, '形状：逗号分隔的 N 或 N-M，如 1-3,5');
    const a = Number(m[1]), z = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || z < a) die('invalid-output', `页段 ${JSON.stringify(tok)} 倒序或越界`, '要求 1 ≤ a ≤ b');
    if (z > totalPages) die('invalid-output', `页段 ${JSON.stringify(tok)} 超出总页数（本件共 ${totalPages} 页）`, `把区间收进 1…${totalPages}`);
    for (let i = a; i <= z; i++) res.push(i - 1);
  }
  // 🔴 v2.4.1：空清单（--pages '' / --pages ','）＝解析后零页——静默"什么都没做却报 ok"是假成功（实测 pageops rotate 空 pages 报 ok、rotatedPages:[]）；
  //   显式拒而不是当"全页"（与 pdftext 的"空=全量"是两个命令各自的既有契约，不互相拖——在各自入口前拒，语义就地澄清）。
  if (!res.length) die('invalid-output', `页清单为空：${JSON.stringify(spec)}`, '给 N/N-M 清单（如 1-3,5），或不传 --pages 表示全页');
  return res;
}
// verify 的 --pages（all|N|N-M|N,M）展开成 pdftotext 的 [first,last] 区间列表（离散页＝多区间、多次抽取后拼接）；
// 解析不了（含倒置区间）返回 null，由调用方按 invalid-output 拒绝。null 区间＝不限制（全量）。
function verifyPagesToRanges(spec) {
  if (spec === undefined || spec === null) return [[null, null]];
  const s = String(spec).trim();
  if (s.toLowerCase() === 'all' || s === '') return [[null, null]];
  const out = [];
  for (const part of s.split(',')) {
    const t = part.trim(); if (!t) continue;
    const m = t.match(/^(\d+)-(\d+)?$/);
    if (m) { const f = Number(m[1]); const l = m[2] ? Number(m[2]) : null; if (m[2] && l < f) return null; out.push([f, l]); }
    else if (/^\d+$/.test(t)) { const n = Number(t); out.push([n, n]); }
    else return null;
  }
  return out.length ? out : [[null, null]];
}

/** 媒体件的类型判定：只按 magic 不信后缀；认不出就报 unknown（不许猜）。 */
function mediaKind(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 4 && ['49492a00', '4d4d002a'].includes(b.subarray(0, 4).toString('hex'))) return 'tiff';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.length >= 44 && b[0] === 0x01 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x00 && b.subarray(40, 44).toString('latin1') === ' EMF') return 'emf';
  if (b.length >= 4 && b.subarray(0, 4).toString('hex') === 'd7cdc69a') return 'wmf';
  if (/<svg[\s>]/.test(b.subarray(0, 300).toString('utf8'))) return 'svg';
  // v2.7.0：JBIG2/JPEG2000 的原始流（pdfimages 对这两族就是导流，不解码）——认出来比报 unknown 有用
  if (b.length >= 12 && b.subarray(0, 12).toString('hex') === '0000000c6a5020200d0a870a') return 'jp2';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0x4f) return 'j2c';
  if (b.length >= 8 && b[0] === 0x97 && b.subarray(1, 6).toString('latin1') === 'JBIG2') return 'jbig2';
  return 'unknown';
}
/** 媒体件落盘名：取部件基名、替掉 Windows 非法字符，保 CJK；目录内去重靠调用方的 used 表。 */
function sanitizeMediaName(part) {
  const base = String(part).split(/[\\/]/).pop() || 'part';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_');
  return cleaned || 'part';
}

/** v1.8.0：非对齐 OLE 的容器修复（机主 2026-10-10 批准；to/pages 专用）。背景（10-09 实测 ×5 组对照）：
 *  WPS 系写入的 .doc 可以不落在 512 字节扇区边界（末扇区不完整），引擎严格读取器据此回 invalid-document
 *  （"…truncated compound-file header…"）——内容与结构完好，缺的只是最后扇区的补位零字节。
 *  修复＝对**副本**补零到 512 整倍（原文件零改动）后重跑；三个条件同时成立才触发：引擎拒因是
 *  compound-file header、输入按 magic 是 OLE、长度 mod 512 ≠ 0。已对齐的件永不进此路径——无差别修复＝
 *  越权改语义，有独立反例判据（olealign-noop）。
 */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
function oleAlignPlan(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(OLE_MAGIC)) return null;
  const rem = buf.length % 512;
  if (rem === 0) return null; // 已对齐：不修
  return { mod512: rem, padBytes: 512 - rem };
}
function oleAlignRetryPlan(input, inExt) {
  const buf = fs.readFileSync(input);
  const plan = oleAlignPlan(buf);
  if (!plan) return null;
  const dst = freePath(OUT_DIR, `${path.basename(input, '.' + inExt)}-${stamp()}-aligned`, inExt);
  fs.writeFileSync(dst, Buffer.concat([buf, Buffer.alloc(plan.padBytes)]));
  return { dst, mod512: plan.mod512, padBytes: plan.padBytes, srcBytes: buf.length, srcSha: sha256(buf), dstBytes: buf.length + plan.padBytes, dstSha: sha256(fs.readFileSync(dst)) };
}
const oleRepairEligible = (r) => r && r.ok === false && r.code === 'invalid-document' && /compound-file header/i.test(String(r.error || ''));
const oleRepairField = (fix, input) => ({
  kind: 'ole-sector-align',
  padBytes: fix.padBytes,
  original: { path: input, bytes: fix.srcBytes, sha256: fix.srcSha },
  alignedCopy: { path: fix.dst, bytes: fix.dstBytes, sha256: fix.dstSha },
});
const oleRepairWarn = (fix) => `输入不是 512 字节扇区整倍数（${fix.srcBytes} B，余 ${fix.mod512} 字节，末扇区不完整）：引擎按「invalid or truncated compound-file header」拒绝——WPS 系 .doc 的已知完好形状（2026-10-09 实测）；已对副本补零对齐（+${fix.padBytes} B ⇒ ${fix.dstBytes} B）后完成本次操作，原文件零改动。注意：若该件实为下载/传输中断截断，尾部数据本就缺失（对齐只能补零、补不了数据），请先核对来源。`;
function oleRepair(fix, input, warnings) { warnings.push(oleRepairWarn(fix)); return oleRepairField(fix, input); }
function oleRepairFailMsg(r, r2, fix) { return `${r.error}｜已对副本补零对齐（+${fix.padBytes} B）后重试，仍失败：${r2.error}`; }
const OLE_REPAIR_NEXT = '对齐修复只补容器末尾零字节、补不了内容损坏：从来源重取或核对原文件；若来源完好而此处仍拒，把这整行回报';

/** 调 kit：统一加 --json，成功取 stdout、失败取 stderr，并量耗时。
 *  R-A（v1.6.4）：kit 不可用时返回值带 `unavailable:true`＋`dep:'kit'` 哨兵——t/ta 靠"依赖缺失探针"把
 *  现场面判据的红转成 SKIP 点名（本仓同形状连犯三次：D-1 后端族→F-1 tesseract 族→G-1 kit 族，
 *  每次只补刚被踩到的族；咽喉层统一兜住后，逐判据手插守卫的模式作废）。 */
function runKit(args) {
  const kc = resolveKitCli();
  if (!kc.present) return { ok: false, ms: 0, code: 'unavailable', unavailable: true, dep: 'kit', error: `找不到 kit CLI（解析自 ${kc.source}）：${kc.exe}` };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [kc.exe, ...args, '--json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, cwd: ROOT });
  const ms = Date.now() - t0;
  let json = null;
  const text = ((r.stdout || '') + (r.stderr || '')).trim();
  try { json = JSON.parse(text); } catch { /* 非 JSON 输出按 failed 处理 */ }
  if (r.status === 0 && json && !json.code) return { ok: true, ms, ...json };
  const code = json?.code || 'failed';
  // 🔴 v2.2.3：红因不许不带因——spawn 层面的失败（EBUSY/ENOBUFS/ETIMEDOUT…）此前被这行吞成
  //   "退出码 null（无输出）"，本会话的 stdin-EBUSY 就是先被它吞掉、多花三组对照实验才定位的。
  //   现在把 r.error / r.signal 原样带出（与 `spawn 统一 stdio` 判据同轮）。
  const why = json?.error || text
    || (r.error ? `子进程起不来（${r.error.code || 'spawn-error'}）：${String(r.error.message || r.error).replace(/\s+/g, ' ').slice(0, 200)}` : '')
    || (r.signal ? `子进程被信号终止：${r.signal}` : '')
    || `kit 退出码 ${r.status}（无输出）`;
  return { ok: false, ms, code, error: why };
}

/** R6 委托层：调 OfficeCLI。**只回结构化结论，后端的 stdout 一个字节都不回传**（ADR-002 排除项 B：
 *  实测 `get <f> /` 只有 3,443 B、0 个 CJK，却带着 `creator`/`lastModifiedBy` 原值——脱敏口径不会被后端继承，只能在这层自己实现）。
 *  三条硬边界：① 动词白名单（不在 allow 里的**不落到子进程**，且靠 officecliSpawnCount 让判据能证明这一点）；
 *  ② 隔离 env 与 TMP/TEMP 受控目录（缺 TMP 那一条，渲染产物会直接写进真实 %LOCALAPPDATA%\Temp——本轮实犯）；
 *  ③ 退码面翻译：0→ok、2→ok+warnings、1→按 OFFICECLI_CODE_MAP 进八码族，映射不到落 failed。 */
function officecliCall(verb, args, opts = {}) {
  if (!OFFICECLI_VERB_ALLOW.includes(verb)) {
    return { ok: false, ms: 0, code: 'unsupported-format', refused: true, spawnDelta: 0,
      error: `动词 ${JSON.stringify(verb)} 不在 OfficeCLI 白名单里（allow=${OFFICECLI_VERB_ALLOW.join('/')}）`,
      next: `看 docs/adr/ADR-002 §三-2 的排除理由（refresh 会拉起 WPS 并改写输入；screenshot/pdf 同理；install/skills/mcp 会往别人配置目录写文件）；装置能做的写操作只有 ${OFFICECLI_VERB_ALLOW.join('/')}` };
  }
  const resolved = resolveOfficecliExe();
  if (!fs.existsSync(resolved.exe)) {
    return { ok: false, ms: 0, code: 'unavailable', refused: false, spawnDelta: 0, backend: resolved,
      error: `找不到写后端 OfficeCLI（解析自 ${resolved.source}：${resolved.exe}）`,
      next: `装它并把绝对路径给 ${OFFICECLI_ENV}（写后端为外部依赖；边界与降级口径见 docs/adr/ADR-002）` };
  }
  const tmpDir = opts.tmpDir || TMP_DIR;
  ensureDir(tmpDir);
  const env = officecliEnv(tmpDir);
  const binaryBefore = officecliBinaryStamp(resolved.exe);
  const before = officecliSpawnCount;
  const t0 = Date.now();
  const r = spawnSync(resolved.exe, [...args, '--json'], { cwd: opts.cwd || ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS });
  const ms = Date.now() - t0;
  officecliSpawnCount += 1;
  const binaryAfter = officecliBinaryStamp(resolved.exe);
  const binaryDrift = binaryBefore.sha8 !== binaryAfter.sha8 || binaryBefore.bytes !== binaryAfter.bytes;
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  let j = null; try { j = JSON.parse(stdout); } catch { /* 非 JSON 走下面的 text */ }
  const skel = (s) => String(s).replace(/[^\x20-\x7E]/g, '▩').replace(/▩+/g, '▩').replace(/\s+/g, ' ').slice(0, 160);
  const warnings = [];
  // 后端自己的 warnings 数组必须留痕：实测 `add --prop zzz=…` 回 **退码 2 + success:true**，
  // 里面写着 `Unsupported property: zzz`——属性被静默丢弃而"成功"照报。这正是《方案》§4 说的"做完了但有保留"的真形状。
  for (const w of (j && Array.isArray(j.warnings) ? j.warnings : [])) warnings.push(`后端 warning（code=${(w && w.code) || '(无码)'}）：${w && w.message ? skel(w.message) : ''}`);
  if (binaryDrift) warnings.push(`🔴 后端在本次调用中换了自己的二进制：前 ${binaryBefore.bytes}B#${binaryBefore.sha8} → 后 ${binaryAfter.bytes}B#${binaryAfter.sha8}（钉版被打穿，本次读到的能力面不能与 ADR-002 认的版等同视之；重认领与更正见 docs/adr/ADR-002 §二⑥）`);
  if (stderr.trim()) warnings.push('后端 stderr（已脱敏为字节数与 ASCII 骨架，不含原文）：' + stderr.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').slice(0, 200));
  const base = { ok: true, ms, verb, spawnDelta: officecliSpawnCount - before, backend: { exe: resolved.exe, source: resolved.source, exitCode: r.status, binaryBefore, binaryAfter, binaryDrift }, warnings, data: j && j.success === true ? j.data : (j ? j.data : null) };
  const auditRec = {
    t: new Date().toISOString(), verb, exe: resolved.exe, exeSource: resolved.source,
    env: { OFFICECLI_SKIP_UPDATE: env.OFFICECLI_SKIP_UPDATE || null, OFFICECLI_NO_AUTO_RESIDENT: env.OFFICECLI_NO_AUTO_RESIDENT || null, TMPisDeviceDir: env.TMP === tmpDir && env.TEMP === tmpDir },
    exitCode: r.status, signal: r.signal || null, ms,
    sha8: [binaryBefore.sha8, binaryAfter.sha8], bytes: [binaryBefore.bytes, binaryAfter.bytes], drift: binaryDrift,
    backendSuccess: !!(j && j.success === true), backendCode: (j && j.error && (j.error.code || (j.error.error && j.error.error.code))) || null
  };
  const auditWrite = auditBackendCall(auditRec);
  if (!auditWrite.ok) warnings.push('后端调用审计写入失败（' + auditWrite.error + '）：审计是"换体是不是装置干的"唯一一手台账，写不进去必须在回报里看得见');
  if (r.signal) return { ...base, ok: false, code: 'timeout', error: `后端被信号 ${r.signal} 打断（超时预算 ${opts.timeoutMs || DEFAULT_TIMEOUT_MS} ms）`, next: '加 --timeout-ms 或缩小一次改动的范围' };
  if (j && j.success === true) {
    if (r.status === 2) { warnings.push('后端退码 2＝"做完了但有保留"，装置按《方案》§4 翻译成退码 0 + warnings[]'); return { ...base, exitNote: 'backend-exit-2' }; }
    if (r.status !== 0) { warnings.push(`后端退码 ${r.status} 但不是 1/2——按成功处理并留痕`); }
    return base;
  }
  const backendCode = (j && j.error && (j.error.code || (j.error.error && j.error.error.code))) || null;
  // 🔴 失败消息也走脱敏：后端的 error 原文可能夹带元素文本（schema 报错会把节点内容写进去），
  //    所以只留 ASCII 骨架并截断——"不透传"不许只在成功路径上成立（ADR-002 排除项 B）。
  const skeleton = (s) => String(s).replace(/[^\x20-\x7E]/g, '▩').replace(/▩+/g, '▩').replace(/\s+/g, ' ').slice(0, 200);
  const rawMsg = (j && j.error && (typeof j.error.error === 'string' ? j.error.error : JSON.stringify(j.error.error))) || stdout.trim() || `后端退出码 ${r.status}（无输出）`;
  const backendMsg = skeleton(rawMsg);
  const code = r.status === 1 ? (OFFICECLI_CODE_MAP[backendCode] || 'failed') : 'failed';
  return { ...base, ok: false, code, backendCode, error: `后端 ${verb} 失败（它的码 ${backendCode || '(无)'}，装置映射为 ${code}）：${backendMsg}`, next: code === 'invalid-output' ? '产物路径已存在（后端默认拒绝覆盖，装置不传 --force）：换输出路径或先确认那份要不要留' : code === 'unsupported-format' ? '换受支持的输入族或操作（`help edit` 看宣告面）' : '照 error 原文处理，别换个名字重试' };
}

/** 后端二进制的身份（字节数 + sha 前 8 位）：本轮实测**后端会自己换自己的二进制**（自更新把钉版打穿），
 *  所以每次调用都要在前后各取一次这个章，变了就在 warnings 里点名两个 sha——静默换版比不换版危险得多。 */
const officecliBinaryStamp = (exe) => { try { const b = fs.readFileSync(exe); return { bytes: b.length, sha8: sha256(b).slice(0, 8) }; } catch (e) { return { bytes: null, sha8: null, error: e.code || String(e.message).slice(0, 40) }; } };
/** 隔离 env（**所有**调后端的路径都必须带，包括只问 `--version` 的那条）：
 *  🔴 本轮实犯——`officecliVersion()` 第一版漏了这层，只用了裸 spawnSync，结果 09:46:59 后端就地自更新
 *  v1.0.153→v1.0.154（留档 `officecli-win-x64.exe.old`＝认领件逐字节一致）。"SKIP_UPDATE 关了"不等于"这条路径关了"。 */
const officecliEnv = (tmpDir) => Object.assign({}, process.env, OFFICECLI_ISOLATION_ENV, { TMP: tmpDir || TMP_DIR, TEMP: tmpDir || TMP_DIR });

/** 后端版本（懒执行一次；判据与回报都吃这个自报值） */
let OFFICECLI_VERSION = null;
const officecliVersion = () => {
  if (OFFICECLI_VERSION !== null) return OFFICECLI_VERSION;
  const resolved = resolveOfficecliExe();
  if (!fs.existsSync(resolved.exe)) { OFFICECLI_VERSION = { available: false, version: null, source: resolved.source }; return OFFICECLI_VERSION; }
  const r = spawnSync(resolved.exe, ['--version'], { encoding: 'utf8', timeout: 30000, env: officecliEnv() });
  OFFICECLI_VERSION = { available: true, version: String(r.stdout || '').trim().split(/\r?\n/)[0] || null, source: resolved.source, exitCode: r.status };
  return OFFICECLI_VERSION;
};

// ---- 手写 ZIP（标准库 zlib 足够，避免依赖 kit 的传递依赖 fflate）----
function zipRead(buf) {
  // 读不通的 ZIP 属于**输入文件坏了**，不是装置缺陷：打上分类标签，入口区据此回 invalid-document（不冤枉成 failed）。
  try { return zipReadRaw(buf); }
  catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { dockitCode: 'invalid-document' }); }
}
function zipReadRaw(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('不是 ZIP 容器（无 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const localCrc = buf.readUInt32LE(localOff + 14);
    if (localCrc !== 0 && localCrc !== crc) throw new Error(`ZIP 局部头与中央目录 CRC 打架：${name} 局部=${localCrc.toString(16)} 中央=${crc.toString(16)}`);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data = raw;
    if (method === 8) data = zlib.inflateRawSync(raw);
    else if (method !== 0) throw new Error('不支持的 ZIP 压缩方法 ' + method);
    // 🔴 验 CRC：不验就把坏包当好包（变异台 M9 教训——写出的 CRC 若没人对账，"产物能打开"根本防不住压缩包写坏）
    const got = crc32(data);
    if (got !== crc) throw new Error(`ZIP 条目 CRC 不匹配：${name} 记录=${crc.toString(16)} 实算=${got.toString(16)}`);
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return new Map(entries.map((e) => [e.name, e.data]));
}
/** 只走中央目录、不解压：给出每个条目的 name / method / 压缩前后字节 / 记录 CRC（dump 的部件清单靠它） */
function zipList(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw Object.assign(new Error('不是 ZIP 容器（无 EOCD）'), { dockitCode: 'invalid-document' });
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const rows = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20), size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    rows.push({ name: buf.subarray(off + 46, off + 46 + nameLen).toString('utf8'), method, methodLabel: method === 0 ? 'stored' : method === 8 ? 'deflate' : 'method-' + method, crc: crc.toString(16), compBytes: compSize, bytes: size, order: i });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return rows;
}
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
/**
 * 只写必要字段的最小 ZIP 生成器。**按传入顺序**逐条目写，每条可点名 method（0=stored / 8=deflate，默认 8）。
 * 🔴 旧注释写的是"Office 与 kit 都按中央目录读，顺序无关"——那句只对 **OOXML** 成立，只对了一半：
 * **ODF 规范另有硬要求——mimetype 条目必须是第一个、且必须 stored(method 0)**，严格按规范读的消费者会拒整包。
 * 所以顺序与 method 交回调用方（scrub 的 ODF 面按原包 method 回写，见 cmdScrub）。
 */
function zipWrite(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, method = 8 } of entries) {
    if (method !== 0 && method !== 8) throw new Error('zipWrite 只支持 method 0(stored)/8(deflate)，给了 ' + method);
    const nb = Buffer.from(name, 'utf8');
    const comp = method === 0 ? Buffer.from(data) : zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nb);
    offset += lh.length + nb.length + comp.length;
  }
  const cdStart = offset, cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---- 容器识别（magic bytes 优先，不看后缀——后缀会骗人）----
function detectKind(buf, ext) {
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0x04034b50) return 'ooxml-or-odf-zip';
  if (buf.slice(0, 8).equals(Buffer.from('D0CF11E0A1B11AE1', 'hex'))) {
    const s = buf.toString('latin1');
    if (s.includes('Word.Document.')) return 'ole-word';
    if (s.includes('Excel.Sheet.')) return 'ole-excel';
    if (s.includes('PowerPoint.')) return 'ole-powerpoint';
    return 'ole-unknown';
  }
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (/<html|<?xml/.test(buf.slice(0, 200).toString('utf8').trim())) return 'text-or-rtf';
  return 'unknown';
}
function zipFamily(map) {
  if (map.has('word/document.xml')) return 'docx';
  if (map.has('xl/workbook.xml')) return 'xlsx';
  if (map.has('ppt/presentation.xml')) return 'pptx';
  if (map.has('mimetype')) {
    const mt = map.get('mimetype').toString('utf8').trim();
    if (mt.includes('opendocument.text')) return 'odt';
    if (mt.includes('opendocument.spreadsheet')) return 'ods';
    if (mt.includes('opendocument.presentation')) return 'odp';
  }
  return null;
}

// ---- 体检用的形状探针：只回字段名/长度/哈希，绝不回显正文 ----
function xmlFields(xml, tagRe) {
  const res = []; let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const name = m[1], value = (m[2] || '').trim();
    res.push({ field: name, present: true, length: value.length, nonblank: value.length > 0 });
  }
  return res;
}
function xmlUnesc(s) {
  // ODF/OOXML 里字体名常被写成 `&apos;Liberation Sans&apos;`；不解实体就直接吐给调用方，
  // 任何"这个族声明了没有"的比对都会假阴性（v1.2.0 取证 engine.odp 与 cn.odt 时实测到，同一族还会以两种形态重复出现）。
  return String(s)
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
function declaredFamilies(xmls) {
  const set = new Map();
  // `+mj-lt` / `+mn-lt` 是 OOXML 的主题字体令牌（指向 theme 里的 major/minor 字体），不是族名；
  // 混进清单会让调用方以为文档声明了一个叫 "+mj-lt" 的字体（缺字自曝方向上的假阳性）。
  const add = (raw) => {
    const v = xmlUnesc(raw).trim();
    if (!v || v === 'default' || v.startsWith('+')) return;
    set.set(v, true);
  };
  for (const xml of xmls) {
    for (const m of xml.matchAll(/(?:w:(?:ascii|eastAsia|hAnsi|cs)|a:(?:latin|ea|cs)|style:font-name(?::complex)?|font-family)\s*=\s*"([^"]{1,64})"/g)) add(m[1]);
    for (const m of xml.matchAll(/<(?:w:name|dc:name|name)>\s*([^<>]{1,64})\s*<\/(?:w:name|dc:name|name)>/g)) add(m[1]);
    // 演示／主题族的字体名写在 typeface= 上（theme、slideMaster、slideLayout 都是）；
    // 表格族写在 <font><name val="…"/></font> 与共享串 runs 的 <rFont val="…"/> 上。这两处 v1.2.1 前完全不扫。
    for (const m of xml.matchAll(/typeface\s*=\s*"([^"]{1,64})"/g)) add(m[1]);
    for (const m of xml.matchAll(/<(?:name|rFont)\s+val\s*=\s*"([^"]{1,64})"/g)) add(m[1]);
  }
  return [...set.keys()].sort();
}
function installedFontFamilies() {
  const dir = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'Fonts') : 'C:/Windows/Fonts';
  if (!fs.existsSync(dir)) return { dir, readable: false, families: [] };
  const names = fs.readdirSync(dir).filter((f) => /\.(ttf|otf|ttc|TTF|OTF|TTC)$/i.test(f));
  return { dir, readable: true, count: names.length };
}

// ---- 像素自证：PNG 非白像素占比（证明"字真的画出来了"，不看回显）----
function pngDarkRatio(file) {
  const b = fs.readFileSync(file);
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  let off = 8, w = 0, h = 0, color = 0; const idat = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off), type = b.toString('latin1', off + 4, off + 8), dataStart = off + 8;
    if (type === 'IHDR') { w = b.readUInt32BE(dataStart); h = b.readUInt32BE(dataStart + 4); color = b[dataStart + 9]; }
    else if (type === 'IDAT') idat.push(b.subarray(dataStart, dataStart + len));
    else if (type === 'IEND') break;
    off = dataStart + len + 4;
  }
  const ch = color === 6 ? 4 : color === 2 ? 3 : color === 0 ? 1 : color === 4 ? 2 : 0;
  if (!w || !h || !ch) return null;
  let raw; try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * ch; let prev = Buffer.alloc(stride), pos = 0, dark = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++], line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, bb = prev[x], c = x >= ch ? prev[x - ch] : 0; let v = line[x];
      if (ft === 1) v = (v + a) & 255; else if (ft === 2) v = (v + bb) & 255;
      else if (ft === 3) v = (v + ((a + bb) >> 1)) & 255;
      else if (ft === 4) { const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255; }
      cur[x] = v;
    }
    prev = cur;
    for (let x = 0; x < w; x++) { const i = x * ch; if (cur[i] < 200 || cur[i + 1] < 200 || cur[Math.min(i + 2, stride - 1)] < 200) dark++; }
  }
  return { w, h, dark, total: w * h, ratio: +(dark / (w * h)).toFixed(5) };
}
//#endregion

// 最小可解码灰度 JPEG：8×8、灰=128（DCT 后全 0），标准 luma 量化/DC/AC 表。
// 用途：给 media 的 PDF 内嵌图测试造一个 DCTDecode 图（pdfimages -j 能抽出 .jpg）。返回偏移 0 的 Uint8Array。
function buildMinimalGrayJpeg() {
  const JPEG_DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const JPEG_DC_VAL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const JPEG_AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
  const JPEG_AC_VAL = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
    0x10, 0x00, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a,
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b,
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b,
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a,
    0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a,
    0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a,
    0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
    0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a,
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
    0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba,
    0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
    0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ];
  const ZZ = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 41, 33, 25, 18, 11,
    4, 5, 12, 19, 26, 34, 42, 49, 57, 48, 40, 35, 27, 20, 13, 6,
    7, 14, 21, 28, 36, 44, 50, 58, 59, 51, 43, 37, 29, 22, 15, 23,
    30, 38, 45, 52, 60, 61, 53, 46, 39, 31, 39, 47, 54, 62, 63, 55,
  ];
  const qzz = new Array(64);
  for (let i = 0; i < 64; i++) qzz[i] = 1;
  const parts = [
    Buffer.from([0xff, 0xd8]),
    Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.from(qzz)]),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00]),
    Buffer.concat([Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x00]), Buffer.from(JPEG_DC_BITS), Buffer.from(JPEG_DC_VAL)]),
    Buffer.concat([Buffer.from([0xff, 0xc4, 0x00, 0xb5, 0x10]), Buffer.from(JPEG_AC_BITS), Buffer.from(JPEG_AC_VAL)]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x2b]), // DC size0=00；AC EOB=1010；pad → 00101011
    Buffer.from([0xff, 0xd9]),
  ];
  return new Uint8Array(Buffer.concat(parts));
}

//#region 业务区
const HELP = {
  gc: '**测试产物回收（v2.9.0 立、v2.10.0 加 --exclude；可逆、默认 dry-run）：`gc [--dir _out|_tmp|both] [--age 天] [--base 前缀] [--exclude 前缀,前缀] [--yes]`。回收判据＝**三条装置签名指纹**：① 条目名以装置 UTC 时间戳段结尾（-20YYMMDDHHMMSS[-N]，含扩展名分支）② 写后端留在 _out 的事务残骸 `.savetmp-<32位hex>` ③ **目录形态**产物同样以时间戳段结尾——三种名字都只有机器会起、人不会这么命名 ⇒ 挡得住"人手工起的名字"；🔴 但**挡不住"真交付件转出的产物"**（那些同样带装置签名，本机 2026-10-14 在候选面里实测混着 12 件课件/作业产物）——所以防误清是两层：**默认 dry-run 把清单摊开给人看** ＋ **`--exclude 前缀,...` 把要留的圈出去**（被排除件单独记账为「被排除条数／样本」，不与"未匹配"混写）。只扫 _out/_tmp（真件面 test/fixtures、_probe、装置样本天然不在面上），且只碰 mtime 早于 --age（默认 7 天、🔴 下限 1 天——0 会把别人正在跑的那一轮自检目录一起扫走）的条目。不给 --yes 就一个文件都不动，只报 候选件数／字节／家族 top／**未匹配样本**（让人看见哪些没被圈进来）；给了 --yes 的动作是**移动到隔离区**「仓库同级的 垃圾产物」目录（取 dirname(ROOT)，🔴 必须与产物区**同卷**——搬运是 renameSync，跨卷必 EXDEV）并写 MANIFEST.md（原路径＋新相对路径＋字节＋mtime＋≤5 MB 者带 sha256），照清单 rename 回去即逐字节复原——**本命令不删除任何东西**',

  sheetop: '**xlsx 插行/插列/移行/移列＋公式引用重写**（v2.8.0，纯 ZIP＋XML、不起引擎也能跑）：`sheetop <输入.xlsx> <row-insert|col-insert|row-move|col-move> [--sheet 名] [--at N [--count k] | --from N --to M] [--timeout-ms n] [--skip-recalc] [输出文件]`。写完**重新解开产物**做引用图同构对账（非引用片段逐字不变＋每个引用的落点＝原件同一片段按轴映射的像＋格子地址双射），默认再跑一把引擎重算逐格对数值；结构化引用（Table1[列]）／三维引用（Sheet1:Sheet2!A1）／dataTable 公式／R1C1／透视／外链／保护件一律前置拒',
  doctor: '环境自证：Node 版本 / kit 与引擎在位 / capabilities 对账 / 输出根可写 / 字体目录 —— 全绿再干活',
  to: 'to <输入文件> [输出文件] [--sheet 名] [--timeout-ms n] [--max-input-bytes n] [--max-output-bytes n]：按输出后缀转换（pdf/txt/csv/xlsx/ods/docx/odt/pptx/odp）',
  pages: 'pages <输入文件> [--dir 目录] [--pages 1,3] [--dpi n] [--sheet 名 --range A1:D20] [--pixels off]：渲染 PNG + manifest + 每页非白像素占比',
  ocr: 'ocr <PNG|PDF> [--pages 1,3] [--lang eng] [--tessdata-dir 目录] [--psm 6] [--pixels off] [--timeout-ms n]：Tesseract 文字识别，逐页行数/字符数/非白像素占比自曝，并自报"本次真用的那个目录"里的语言清单（langPack/langCount/langs）；缺引擎回 unavailable 并指路（ADR-001）',
  sheets: 'sheets <表格文件> [--method auto|zip|render]：列工作表名（zip=读 OOXML，render=让引擎自报；auto 先 zip 后 render 并自报用了哪条）',
  inspect: 'inspect <输入文件> [--deep]：容器识别（按 magic 不按后缀）/ 可转换矩阵 / 声明字体族 / 元数据字段形状；PDF 另出纯 JS 结构块（页数/逐页版式与方向/加密/字体嵌入与 CJK，不起引擎、不回显正文）；--deep 附带真实转换的 missingFonts',
  recalc: 'recalc <表格文件> [输出文件] [--verify]：整簿重算公式（保留公式，不清空值）；--verify 逐格对比重算前后的缓存值',
  scrub: 'scrub <OOXML|ODF|PDF 文件> [输出文件] [--verify]：OOXML 清 docProps（作者/标题/公司/修订…）；ODF 清 meta.xml 九个目标字段并删除 Thumbnails/thumbnail.png（缩略图＝第一页渲染图，属版面内容）；PDF（v2.5.0 起）清 /Info 目标键并摘除 XMP（/Metadata），写新文件、非就地；前两族保序、逐条目沿用原包 method（mimetype 必须首位 stored）；--verify：OOXML/ODF 转 PDF 回查残留、PDF 重装载产物做结构回查＋明文令牌扫描',
  selftest: 'selftest：跑内置判据（合成正向 / 合成反向 / 真实脏样本 / 变异对照 / 版本与能力对账 / README 与 help 对账）',
  dump: 'dump <输入文件> [--part 部件名] [--text]：包的**形状**自述（部件清单+压缩方法+元素/属性计数与名字），全程不起引擎；默认不回显正文，要正文得显式 --text（那一份就不是外发件了）',
  factcheck: 'factcheck [--doc 文件,文件] [--repo 仓库根] [--upstream 名字] [--head 名字] [--refs] [--strict]：核**文档里写死的时点事实**——rev-list 左右列语义（左＝落后）、条数与文件计数、行数两种口径、否定式断言现场跑一次；--refs（v2.6.0）给 `文件:行` 型引用做体检（文件在否、行号越界否＋带出该行现值前 60 字）；默认只报判错数，--strict 才让它当闸门',
  verify: 'verify <输入文件> [--pages all|1,3] [--lang eng] [--tessdata-dir 目录] [--psm n] [--show] [--timeout-ms n]：同源**两条取字路线对账**——A=文本层直提（to txt），B=渲染层（pages→Tesseract）；报逐页匹配数、只在 A 出现的行（丢字/字形读不出）、只在 B 出现的行（幻影），默认只给计数与行号，字符串要显式 --show',
  check: 'check <输入文件> [--kind 族,族] [--backend zip|officecli]：外发前形状体检（**不起引擎、不写盘**）——ZIP 系走装置自己的包形状读，PDF（v2.6.0 起）走纯 JS 结构面；十三族含出域元数据字段、公式错误值缓存 t="e"/#REF!、缺替代文字、空表/空页、隐藏内容、外部引用、内嵌对象、宏/VBA、自定义 XML、表单字段；字段名与部件名点名，值/目标/URL/层名一律不回显；清单封顶自报 truncated；--backend officecli 另跑一次上游 OpenXML schema 校验（结果只回结论不回后端 stdout）',
  edit: 'edit <输入文件> <set|add|remove> <元素路径> [--prop k=v[,k=v]] [--type 元素类型] [--out 文件]：**写操作**（v1.6.0 R6，后端 OfficeCLI，ADR-002）。第一步复制成 _out/<名>-<UTC时间戳>-work.<ext>，后端只碰副本；原件操作前后各算一次 sha256，不一致立刻 code=failed；写完装置自己回读副本对账（不拿后端 success 当结论）',
  merge: 'merge <模板文件> <数据JSON文件> [输出文件]：把 {{key}} 填成数据值（模板零改动、产物是新文件；数据必须是 JSON 文件路径且值全是标量；输出已存在就拒，不传后端那个 --force）',
  media: 'media <输入文件> [--dir 目录] [--max-files n]：抽内嵌媒体到目录 + 清单（类型/字节/sha256）——OOXML/ODF 取 word/media、ppt/media、xl/media、Pictures（不起引擎；预览件 docProps/thumbnail*、ODF Thumbnails/* 不收）；PDF（v2.1.0）走 poppler pdfimages 抽内嵌光栅图，缺工具回 unavailable',
  batch: 'batch <目录> [--cmd to|markdown] [--ext 列表] [--to 后缀] [--recursive] [--max-items n] [--timeout-ms n]：对目录里匹配的文件逐件跑 to（默认 pdf、只扫一层）或 markdown（v2.6.0 起批量导 GFM，产物恒 .md、不吃 --to），逐件 JSON + 总账；单件失败不拖垮其余，有失败整体 ok=false',
  combine: 'combine <输入1.pdf> <输入2.pdf> [更多…] [--out 文件]：按参数顺序把多份 PDF 拼成一份新 PDF（输入只读、产物新建、永不覆盖；加密件不在支持面）',
  split: 'split <输入.pdf> [--ranges 1-3,5,7-] [--every n] [--dir 目录]：拆 PDF——按区间/每 N 页/逐页（都不给＝逐页）；产物落新目录 + 逐页页数与哈希；单次最多 100 件',
  pdfform: 'pdfform <输入.pdf> --list | --data 数据.json [--flatten] [--font 字体.ttf] [--out 文件]：AcroForm 表单受控填写（v2.5.0）——--list 列字段名/类型/选项；--data 按 JSON 填值（text/checkbox/radio/dropdown/optionlist）；--flatten 扁平化；中文字段值自动嵌字体（@pdf-lib/fontkit＋系统单体 TTF，--font 可覆盖）；输入只读、产物新建、永不覆盖；XFA 与加密件不在支持面；值不回显进回报',
  pdftext: 'pdftext <输入.pdf> [--out 文件] [--pages N-M] [--timeout-ms n]：直取 PDF 内嵌文本层（poppler pdftotext，数字 PDF 免 OCR；原生 CLI 不触 ADR-001）；文本落 txt 不回显进 JSON；扫描件无文本层告警指路 pages＋ocr；缺 pdftotext 回 unavailable',
  pageops: 'pageops <输入.pdf> <rotate|delete|order> <参数> [--pages 1-3] [--out 文件]：PDF 页级操作（pdf-lib）——rotate 90/180/270（绝对角度，可配 --pages 只转指定页）、delete 逗号页清单（删页）、order 逗号页序（重排，须为 1..N 各一次）；输入只读、产物新建；加密件不支持；解密不做',
  pipeline: 'pipeline <输入> <flow> [--lang eng] [--dpi n]：多步管线串联——flow 是**逗号步序列**（步 ∈ to/pages/ocr/pdftext，如 to,pages,ocr），旧写法 to-pages／to-pages-ocr 仍可用；输入已是 PDF 自动跳过 to；逐步子进程、单件失败即停并报 failedStep；条件分支/并行 DAG 仍挂账',
  markdown: 'markdown <输入文档> [输出.md] [--wrap none|auto|preserve] [--track-changes accept|reject|all] [--timeout-ms n]：文档→GFM Markdown（docx/odt/pptx/xlsx/csv/tsv/html/htm；pandoc 后端、原生 CLI）——默认不硬折行；--track-changes（仅 docx）三态取修订视图：accept＝接受修订的视图（默认）/reject＝拒绝修订的视图/all＝两个方向都带出（insertion/deletion 标记与 author）；正文只落 .md、不回显进 JSON（与 ocr/pdftext 同隐私口径）；缺 pandoc 回 unavailable 并指路 DOCKIT_PANDOC；.doc/.xls/.ppt 老族先 to 转新族、PDF 取字走 pdftext',
  pipeline: '**多步管线串联**（v2.2.0 立，v2.4.0 扩成**逗号步序列**，v2.7.0 再扩成 **DAG**）：flow＝逗号串联的步序列，步 ∈ `to`/`pages`/`ocr`/`pdftext`（如 `to,pages,ocr`、`to,pdftext`）；旧写法 `to-pages`／`to-pages-ocr` 仍可用；`to` 只能是第一步；`--dag flow.json` 走图执行器——节点带 `id`/`step`/`needs`（依赖）/`args`（子步参数）/`when`（条件谓词，只看上游回报过的 JSON 字段），按拓扑序确定性串行，谓词不成立的节点 skip 并传染下游；🔴 并发明确不做（读数会变成就在测负载而不是测正确性）；逐步子进程、任一步失败即停并报 failedStep',
  redline: '**docx 修订与批注写入**（v2.7.0，纯 ZIP＋XML，不依赖任何后端）：`redline <输入.docx> <insert|delete|comment|accept|reject> [--text 文本] [--match 定位串 | --para N] [--author 名] [--date ISO] [--out 文件]`。insert＝把新文字包进 `w:ins`；delete＝把定位段落的 run 包进 `w:del` 并把 `w:t` 改成 `w:delText`；comment＝写 `word/comments.xml`＋补 `[Content_Types]`/rels＋在段落两端插 `commentRangeStart/End`＋`commentReference`；accept＝保留插入文字、丢弃删除内容并清标记；reject＝丢弃插入、还原 delText 为 w:t。定位串命中多段只改第一段并 warning；🔴 **格式修订（rPrChange/pPrChange 等）**：accept 连标记一起清（＝保留当前格式），reject 只要存在就 `unsupported-format`（把旧属性表贴回来需要可靠的 OOXML 属性回写面，装置没有——硬做就是假还原）。第一步复制成 `_out/<名>-<UTC时间戳>-redlined.docx`，原件只读（前后 sha256 各测一次）；写完**装置自己重新解包对账**：数 `w:ins`/`w:del`/`w:comment`、验 --text 进没进、验 accept/reject 后该留的文字真留、该走的真走——不符就 `code:failed`',
  redact: '**PDF 真涂黑／删字留白**（v2.7.0，v3.1.0 加 --fill none；pdf-lib＋poppler，不依赖 ghostscript/Python）：`redact <输入.pdf> [--needle 串] [--needles 数据.json] [--fill black|none] [--out 文件] [--dry-run]`。三段承重：① 定位＝`pdftotext -bbox` 的词框（装置不自解字形——CID/子集字体的字形解法不是可自证的路）；② 动作＝**从页面内容流里删掉命中位置的 BT…ET 文本绘制组** ＋ 默认用 pdf-lib 画黑框（只画框不删字＝假脱敏，这一条是本命令存在的理由）；`--fill none` 时**不画框**＝删字留白——课表/报表/名单这类"把多余条目去掉"的用途，脱敏别用它；③ 验收＝产物**再用 pdftotext 抽一遍文本层，needle 必须零命中**，命中就 `code:failed` 并点名"这就是假涂黑"。needle 找不到 ⇒ `invalid-output`（找不到就不能宣称涂过）；扫描件无文本层 ⇒ `failed` 指路 pages＋ocr；加密件 ⇒ `unsupported-format`；🔴 `/Rotate≠0` 的页前置拒（v3.1.0 实测坐标失配）；输入只读、产物新写、永不覆盖；`--dry-run` 只预览（v3.2.0：报每枚 needle 的命中数/页/框数与产物会落哪，不删不画不写盘）。🔴 只删页内容流的文本组：画在 Form XObject、注释外观、附件或 XMP 里的同一串不会被删——验收会抓出来，但**别把"这串没了"推广成"这类信息都清了"**（元数据另走 scrub）',
  tables: '**PDF 表格抽取 → CSV**（v2.7.0，pdf-lib＋poppler，几何法、可自证）：`tables <输入.pdf> [--dir 目录] [--pages 1-3] [--max-tables n]`。网格来自页面内容流的**矢量线段**（实测 LibreOffice 把 docx 带边框表格画成 m/l：N 行→N+1 条横线、M 列→M+1 条竖线；`re` 也吃），单元格四边都有线才算一个格；文字来自 `pdftotext -bbox` 的词框，按词框中心落在哪个格入格。每表出一个 CSV（带 UTF-8 BOM，Excel 中文不乱码）＋清单（页/行列数/格数/字节/sha256）。🔴 **没有闭合网格就回空清单并明说**——无边框表、图片表、只有横线的表都不猜（宁可不给，不给猜的表）；要字面内容走 `pdftext`，OOXML/ODF 的表直接 `to ... .csv`（引擎导出无损）',
  frommd: '**Markdown 的生产方向**（v2.7.0，md → docx/odt/html/pdf；`markdown` 命令的反向）：`frommd <输入.md> [输出文件] [--to docx|odt|html|pdf] [--title 名] [--css 样式.css] [--timeout-ms n]`。前三者 pandoc 直出（`--sandbox` 起，不吃文件系统副作用）；pdf 走两段＝pandoc 出独立 HTML → 本机无头浏览器 `--print-to-pdf`（Chrome/Edge 任一，`DOCKIT_BROWSER` 可权威覆盖；🔴 不传 `--no-sandbox`，本机实测不需要）。中间 HTML 落**纯 ASCII 临时目录**（poppler 的 argv 中文解码坑同族风险）。写完**装置自己回读产物核对正文**：docx/odt 解包取 `w:t`／`content.xml`、html 去标签、pdf 走 `pdftotext`，样本词一个都没找到 ⇒ `code:failed`（"后端退码 0"不算结论）；找不齐但非零 ⇒ warning 点名"别宣称无损"。输入只读、产物新写、永不覆盖；缺 pandoc/缺浏览器分别 `unavailable`＋指路。pdf 的版式由浏览器定，与 `to`（LibreOffice）不同族，别互相冒充等价产物',
  compress: '**PDF 无损瘦身**（v2.7.0，纯 pdf-lib，**不依赖 ghostscript**）：`compress <输入.pdf> [输出文件] [--min-stream-bytes n]`。两件动作：① **可达性回收**——从 trailer 的 Root/Info/ID 出发做引用闭包，闭包外的间接对象整批删（实测 pdf-lib 自己不做回收，孤儿对象会原样序列化进产物）；② **未压缩流改 deflate**（level 9，压完反而涨的就留原样并计数）。🔴 "无损"不靠宣称：产物**页数相等 ＋ `pdftotext` 抽出的正文与原件逐字相等**，不等就 `code:failed` 并说"别外发"；带 AcroForm 表单/内嵌附件/JavaScript 或 /AA 的件**前置拒**（回收与重写会丢交互层——与 combine/split 同一立场，别把压完的件当原件）；加密件拒（不绕加密）；体积没降是合法结果，照实报 `ratioBytes` 并 warning"别把跑过当压小了"',
  help: 'help：命令清单',
};

// 🔴 R1-a（任务书 P1-4）：**机器可读的命令面**。`help <命令>` 与 `help --json` 出的是这张表，
// 每条开关都带 类型 / 默认值 / 默认值来源 / 会撞的失败码。三条规矩（都由判据 `help 结构化命令面` 逐条核）：
//  ① `default` 一律写**字面量**，判据拿 CONFIG_CONSTANTS 比"报的值 == 配置区当前值"——引用常量就永远对得上＝假牙；
//  ② `default: null` 必须配 `defaultNote` 说清"不传时谁定"（省略字段不算交代）；`type:'boolean'` 的默认恒为 false；
//  ③ 表里宣告的开关必须在**该命令的函数体里真被读到**，函数体里读到的也必须宣告——防"help 有、代码不吃"与"代码吃、help 没写"。
const HELP_SPEC = {
  doctor: {
    usage: 'doctor',
    positional: [],
    flags: [],
    codes: [],
    note: '失败不走 code 字段：看 ok=false 与 checks 里以 FAIL 开头的整行；WARN 项不使整轮红（tesseract 不在位、或 tessdata 里没有 chi_sim 中文包，都只 WARN）',
  },
  to: {
    usage: 'to <输入文件> [输出文件] [--sheet 名] [--timeout-ms n] [--max-input-bytes n] [--max-output-bytes n] [--max-archive-entries n] [--max-uncompressed-bytes n] [--font-directory 目录] [--initial-font-family 名] [--font-fallbacks JSON]',
    positional: [
      { name: '输入文件', required: true, note: '按 magic bytes 认容器，不看后缀；不在 FORMAT_MATRIX 输入族直接 unsupported-format' },
      { name: '输出文件', required: false, note: '省略＝落 _out/<原名>-<UTC时间戳>.pdf，冲突自动 -2/-3（永不覆盖）' },
    ],
    flags: [
      { name: 'sheet', type: 'string', default: null, defaultNote: '多表工作簿出 csv 时**必填**（先 sheets 拿准确表名，装置会前置拒绝并列出可选表名）' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS', note: '透传给 kit；超时回 code=timeout' },
      { name: 'max-input-bytes', type: 'int', default: null, defaultNote: '不传＝沿用 kit 自带上限；要抬限需调用方明确同意（《文档操作规范》：不许为通过而放宽）' },
      { name: 'max-output-bytes', type: 'int', default: null, defaultNote: '不传＝沿用 kit 自带上限；抬限同上' },
      { name: 'max-archive-entries', type: 'int', default: null, defaultNote: '不传＝沿用 kit 自带上限（ZIP 条目数）' },
      { name: 'max-uncompressed-bytes', type: 'int', default: null, defaultNote: '不传＝沿用 kit 自带上限（解压后总字节）' },
      { name: 'font-directory', type: 'string', default: null, defaultNote: '不传＝引擎按系统字体库解析（C:\\Windows\\Fonts），这是装置唯一的外部依赖面' },
      { name: 'initial-font-family', type: 'string', default: null, defaultNote: '不传＝不改文档声明的族' },
      { name: 'font-fallbacks', type: 'json', default: null, defaultNote: '二维数组 JSON（每组≥2 个非空名）；补了替换**也不许**据此宣称不缺字（missingFonts 仍自曝）' },
    ],
    codes: ['invalid-document', 'unsupported-format', 'invalid-output', 'input-too-large', 'output-too-large', 'timeout', 'unavailable', 'failed'],
  },
  pages: {
    usage: 'pages <输入文件> [--dir 目录] [--pages 1,3] [--dpi n] [--sheet 名 --range A1:D20] [--max-image-resolution n] [--pixels off] [--timeout-ms n]',
    positional: [{ name: '输入文件', required: true, note: 'PDF 也可渲染；产物是整页图像＝文档本体，别当缩略图外发' }],
    flags: [
      { name: 'dir', type: 'string', default: null, defaultNote: '省略＝落 _out/<原名>-pages-<UTC时间戳>/；给的目录必须自身不存在而父级存在（kit 不递归建目录）' },
      { name: 'pages', type: 'string', default: null, defaultNote: '不传＝全部页；只认 all 或逗号列表（1-2 这类区间写法被引擎拒）' },
      { name: 'dpi', type: 'int', default: 144, defaultFrom: 'DPI_DEFAULT', note: '装置不传时引擎按 144 走（2026-10-06 实测 tile=1224×1584＝8.5″×11″@144）' },
      { name: 'sheet', type: 'string', default: null, defaultNote: '表格族点名要渲染的那张表；对文字族用它是无效组合' },
      { name: 'range', type: 'string', default: null, defaultNote: '配 --sheet 用（如 A1:D20）；对 docx 用会被引擎拒（"worksheets"）' },
      { name: 'max-image-resolution', type: 'int', default: null, defaultNote: '不传＝沿用引擎上限（单边 8192 px、总像素 16,777,216、最多 100 页）' },
      { name: 'pixels', type: 'choice', choices: ['off'], default: null, defaultNote: '不传＝逐 tile 统计非白像素（最多 ' + MAX_PIXEL_TILES + ' 张并自报 truncated）；off 时 pixelEvidence 字段自报 "off" 而不是伪造数据' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS' },
    ],
    codes: ['invalid-document', 'unsupported-format', 'input-too-large', 'timeout', 'unavailable', 'failed'],
  },
  ocr: {
    usage: 'ocr <PNG|PDF> [--pages 1,3] [--lang eng] [--tessdata-dir 目录] [--psm n] [--pixels off] [--timeout-ms n]',
    positional: [{ name: '输入文件', required: true, note: '只吃 PNG 与 PDF（按 magic 判）；**只收一个**，给第二个路径即 invalid-output' }],
    flags: [
      { name: 'pages', type: 'string', default: null, defaultNote: '只对 PDF 有意义；对 PNG 用它是无效组合（装置拒绝）' },
      { name: 'lang', type: 'string', default: 'eng', defaultFrom: 'OCR_DEFAULT_LANG', note: '中文要 chi_sim；缺语言包时 tesseract 自身报错，装置映射为 unsupported-format 并指路' },
      { name: 'tessdata-dir', type: 'string', default: 'C:\\Program Files\\Tesseract-OCR\\tessdata', defaultFrom: 'TESSDATA_DIR', note: '可被 DOCKIT_TESSDATA 改；自报的 langCount/langs 按**本次真用的那个目录**列' },
      { name: 'psm', type: 'int', default: null, defaultNote: '不传＝tesseract 默认（3）；装置只放行 0–13，越界即 invalid-output' },
      { name: 'pixels', type: 'choice', choices: ['off'], default: null, defaultNote: '不传＝逐页给非白像素占比' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS', note: '整轮预算；单页被掐报 timeout' },
    ],
    codes: ['unavailable', 'invalid-document', 'unsupported-format', 'invalid-output', 'timeout', 'failed'],
  },
  sheets: {
    usage: 'sheets <xls|xlsx|ods> [--method auto|zip|render]',
    positional: [{ name: '表格文件', required: true, note: '非表格族即 unsupported-format' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'method', type: 'choice', choices: ['auto', 'zip', 'render'], default: 'auto', defaultFrom: 'DEFAULT_SHEETS_METHOD', note: 'auto＝先 zip（不起引擎）拿不到再 render，且 JSON 里 method/via 自报走了哪条' },
    ],
    codes: ['invalid-document', 'unsupported-format', 'input-too-large', 'timeout', 'unavailable', 'failed'],
  },
  recalc: {
    usage: 'recalc <xls|xlsx|ods> [输出文件] [--verify] [--report-errors] [--timeout-ms n]',
    positional: [
      { name: '表格文件', required: true, note: '数字类交付的铁律：先 recalc 再导出（陈旧缓存值引擎会直接用）' },
      { name: '输出文件', required: false, note: '省略＝落 _out/<原名>-recalced.xlsx；只允许 xlsx/ods' },
    ],
    flags: [
      { name: 'verify', type: 'boolean', default: false, note: '逐格对比重算前后的缓存值；**只吃 ZIP 容器**（.xls 这类 OLE 二进制前置 unsupported-format 并指路，不落产物）' },
      { name: 'report-errors', type: 'boolean', default: false, note: '重算后扫重算结果里的逐格公式错误（#REF!/#DIV/0!/#VALUE! 等），回 error_summary：分类型计数＋Sheet!Cell 清单＋total_formulas，超 cap 自报 truncated' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS' },
    ],
    codes: ['invalid-document', 'unsupported-format', 'invalid-output', 'input-too-large', 'output-too-large', 'timeout', 'unavailable', 'failed'],
  },
  scrub: {
    usage: 'scrub <OOXML|ODF|PDF 文件> [输出文件] [--verify]',
    positional: [
      { name: 'OOXML 或 ODF 文件', required: true, note: 'OOXML（docx/xlsx/pptx）清 docProps；ODF（odt/ods/odp）清 meta.xml 并删 Thumbnails/thumbnail.png；PDF（v2.5.0 起）清 /Info 目标键并摘除 XMP（/Metadata）——写新文件、非就地；OLE 前置 unsupported-format' },
      { name: '输出文件', required: false, note: '省略＝落 _out/<原名>-scrubbed.<原后缀>（PDF 面为 <原名>-scrubbed.pdf）；已存在即 invalid-output（从不覆盖）' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'verify', type: 'boolean', default: false, note: 'OOXML/ODF：转一次 PDF 后按固定探针清单回查那些串是否零残留；PDF：重装载产物做结构回查（Info 目标键 + /Metadata）并叠明文令牌扫描；漏删在这里现形，不靠"删了几个查几个"' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
  },
  inspect: {
    usage: 'inspect <输入文件> [--deep]',
    positional: [{ name: '输入文件', required: true, note: '形状探针：元数据只给字段名+长度+是否非空，**不回显正文**' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'deep', type: 'boolean', default: false, note: '附带一次真实转换拿引擎侧 missingFonts（起引擎；声明族与缺字族是两条通道，不许互推）' },
    ],
    codes: ['input-too-large', 'invalid-document', 'failed'],
  },
  selftest: {
    usage: 'selftest [--only=名子串,子串] [--keep]',
    positional: [],
    flags: [
      { name: 'only', type: 'string', default: null, defaultNote: '不传＝全量；给值时按判据名**子串**选跑（变异台逐例就靠它），自报 filtered' },
      { name: 'keep', type: 'boolean', default: false, note: '保留自检工作目录并在 JSON 里给出 workdir（默认清空并自报 cleaned）' },
    ],
    codes: ['failed'],
  },
  dump: {
    usage: 'dump <输入文件> [--part 部件名] [--text]',
    positional: [{ name: '输入文件', required: true, note: '只吃 ZIP 系容器；OLE 前置 unsupported-format，全程不起引擎' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'part', type: 'string', default: null, defaultNote: '不传＝全部部件；给了就只出那一个部件（名字不存在即 invalid-output 并回 candidates）' },
      { name: 'text', type: 'boolean', default: false, note: '显式开了才抽正文文本；元数据部件（docProps/*、meta.xml）**永远只给形状**，--text 也不给值' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'failed'],
  },
  factcheck: {
    usage: 'factcheck [--doc 文件,文件] [--repo 仓库根] [--upstream 名字] [--head 名字] [--refs] [--strict]',
    positional: [{ name: '仓库根', required: false, note: '省略＝装置所在仓；必须是 git 工作树，否则 invalid-document' }],
    flags: [
      { name: 'doc', type: 'string', default: null, defaultNote: '不传＝四份在册文档（迭代日志/项目总览/README/调用卡）；给了就只查这些（逗号分隔，相对仓库根）' },
      { name: 'repo', type: 'string', default: null, defaultNote: '不传＝装置所在仓（ROOT）' },
      { name: 'upstream', type: 'string', default: null, defaultNote: '不传＝origin/main；rev-list 的左侧，左列数＝本地落后' },
      { name: 'head', type: 'string', default: null, defaultNote: '不传＝HEAD；rev-list 的右侧，右列数＝本地领先' },
      { name: 'refs', type: 'boolean', default: false, note: 'v2.6.0 开：给文档里的 `文件:行` 型引用做体检——文件在不在、行号越不越界各判一条，并带出那一行现在的前 60 字（lineText）给人眼对。🔴 插行推漂但仍界内的这一面**判不了**，装置不宣称"引用都还对"；《迭代日志》里的引用走与条数同一支豁免（历史原样引用不判红）' },
      { name: 'strict', type: 'boolean', default: false, note: '默认只报判错数（文档是时点记录，红一片没意义）；开了以后只要有一条 mismatch 就退码 1' },
    ],
    codes: ['invalid-document', 'invalid-output', 'failed'],
  },
  verify: {
    usage: 'verify <输入文件> [--pages all|1,3] [--lang eng] [--tessdata-dir 目录] [--psm n] [--show] [--timeout-ms n]',
    positional: [{ name: '输入文件', required: true, note: '文本族（FORMAT_MATRIX 九个扩展名）走两条路线；PDF 只走渲染半条并自报 mode=render-only' }],
    flags: [
      { name: 'pages', type: 'string', default: null, defaultNote: '不传＝渲染全部页；只认 all 或逗号列表（渲染上限沿用引擎 100 页）' },
      { name: 'lang', type: 'string', default: 'eng', defaultFrom: 'OCR_DEFAULT_LANG', note: '中文要 chi_sim；语言包不在位时 tesseract 报错，装置映射为 failed 并指路' },
      { name: 'tessdata-dir', type: 'string', default: 'C:\\Program Files\\Tesseract-OCR\\tessdata', defaultFrom: 'TESSDATA_DIR', note: '与 ocr 同一份解析口径；本机 chi_sim 在 _out/tessdata-best 与 -fast（仓内，gitignore）' },
      { name: 'psm', type: 'int', default: null, defaultNote: '不传＝tesseract 默认；对账发现大片 missing 时可换 --psm 6 复跑区分"字形问题"与"识别噪声"' },
      { name: 'show', type: 'boolean', default: false, note: '默认只给计数与行号；显式开了才把行文本带进回报（那一份含正文，不是外发件）' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS', note: '两条路线共用这一份预算（引擎转换 + 渲染 + 逐页 OCR）' },
    ],
    codes: ['invalid-document', 'unsupported-format', 'invalid-output', 'input-too-large', 'output-too-large', 'timeout', 'unavailable', 'failed'],
  },
  check: {
    usage: 'check <输入文件> [--kind 族,族] [--backend zip|officecli]',
    positional: [{ name: '输入文件', required: true, note: 'ZIP 系容器（docx/xlsx/pptx/odt/ods/odp）走装置自己的 ZIP 形状体检；**PDF（v2.6.0 起）走纯 JS 结构面**（pdf-lib，仍不起引擎、不写盘）——加密件与"load 不抛但结构自证不过"的坏件一律前置拒，不许带着读不全的结构报 clean=true；OLE（.doc/.xls/.ppt）在起任何引擎之前即 unsupported-format' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'kind', type: 'string', default: null, defaultNote: '不传＝该容器适用的族全查（适用面看报告里的 kindsApplicable，不适用的族在 kindsNotApplicable 里明说）；给了就只报这些族（逗号分隔），未知族名回 invalid-output 并带 candidates；过滤状态下 clean 恒为 false' },
      { name: 'backend', type: 'string', default: 'zip', defaultFrom: 'DEFAULT_CHECK_BACKEND', note: 'zip＝装置自己的形状体检（默认，不起引擎）；officecli 另跑一次上游 OpenXML schema 校验并把结论并进报告（后端不在位时只加一条 warning，clean 与退码都不变；PDF 不走这一面，只加一条 warning）' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
    note: '十三族（v2.6.0 起）：meta-field／formula-error-cache／missing-alt-text／revisions／comments／empty-sheet／empty-page／hidden-content／external-link／embedded-object／macro／custom-xml／form-field。**外发前体检面**——字段名与部件名点名，值/目标/URL/层名/脚本内容一律不回显。findings 清单封顶 CHECK_FINDINGS_CAP 条并自报 findingsTruncated（counts 恒权威）。不写盘、不改件：要清元数据走 scrub。',
  },
  edit: {
    usage: 'edit <输入文件> <set|add|remove> <元素路径> [--prop k=v[,k=v]] [--type 元素类型] [--out 文件]',
    positional: [
      { name: '输入文件', required: true, note: 'OOXML 族（docx/xlsx/pptx）；**装置对它零写入**——第一步复制成 _out/<名>-<UTC时间戳>-work.<ext，操作前后各测一次原件 sha256，不一致立刻 code=failed' },
      { name: '操作', required: true, note: 'set|add|remove 三选一；装置可达的写动词就是这三个（ADR-002 §三-2 的白名单，refresh/screenshot/install 一类整族不可达）' },
      { name: '元素路径', required: true, note: 'docx 如 /body/p[1]；pptx 如 /slide[1]/shape[1]；xlsx 如 /Sheet1!A1。add 时这个位置是**父路径**' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'prop', type: 'string', default: null, defaultNote: '不传＝不写属性值（remove 必须不传，传了 invalid-output）；逗号分隔的 k=v 对，值原样交给后端' },
      { name: 'type', type: 'string', default: null, defaultNote: 'add 必填（要加的元素类型，如 paragraph/shape）；set/remove 不需要' },
      { name: 'out', type: 'string', default: null, defaultNote: '省略＝产物就是那份 _out 里的 -work. 副本；给了就把副本另存到该路径，**已存在则 invalid-output**（后端那个 --force 装置从不传）' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'timeout', 'failed'],
    note: '写完装置自己回读副本做三件对账：副本字节真变了、容器仍可逐条目解（CRC 记账）、--prop 写进去的值能在某个 XML 部件里自己找到。**后端 stdout 一律不透传**（实测 get / 只 3,443 B、0 个 CJK 却带出 creator/lastModifiedBy 原值）。',
  },
  merge: {
    usage: 'merge <模板文件> <数据JSON文件> [输出文件]',
    positional: [
      { name: '模板文件', required: true, note: 'OOXML 族；模板是输入 ⇒ 零改动（前后 sha256 各测一次）' },
      { name: '数据JSON文件', required: true, note: '**必须是文件路径**，不接内联 JSON（shell 引号会把值吃掉，本机这类错犯过多次）。顶层对象、值全标量；空对象直接 invalid-document——装置不假装"成功填了 0 个"' },
      { name: '输出文件', required: false, note: '省略＝落 _out/<模板名>-<UTC时间戳>-merged.<ext>；已存在就 invalid-output，不覆盖' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（模板整件读进内存前先量字节数）：超限回 input-too-large；抬限属放宽规则需机主同意，也可用 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'timeout', 'failed'],
    note: '产物由装置自己回读：逐键数"值出现了"与"{{key}} 还在不在"。后端的 `Replaced keys: N` 只当旁证；有残留就落 warnings[]，不因此判错也不假装通过。',
  },
  media: {
    usage: 'media <输入文件> [--dir 目录] [--max-files n] [--reencode jpeg]',
    positional: [{ name: '输入文件', required: true, note: 'OOXML/ODF 的 ZIP 容器（docx/xlsx/pptx/odt/ods/odp，不起引擎）；或 PDF（v2.1.0 起走 poppler pdfimages 抽内嵌光栅图，缺工具回 unavailable）；OLE 前置 unsupported-format' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'dir', type: 'string', default: null, defaultNote: '省略＝落 _out/<原名>-media-<UTC时间戳>/；给了就在该目录下自动挑不冲突的名字（永不覆盖）' },
      { name: 'max-files', type: 'int', default: 300, defaultFrom: 'MEDIA_MAX_FILES', note: '超过上限直接拒（不静默截断；PDF 在抽图落地前先 -list 数图就拒）；抬限＝调用方明确知情' },
      { name: 'reencode', type: 'string', default: null, defaultNote: '仅 PDF：jpeg ＝ pdfimages -j（JPEG 内嵌图按 .jpg 原样输出，不转码；非 JPEG 仍 PBM/PPM）；省略＝-all 原始格式；只认 jpeg，其它值 invalid-output' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'timeout', 'failed'],
  },
  batch: {
    usage: 'batch <目录> [--cmd to|markdown] [--ext 列表] [--to 后缀] [--recursive] [--max-items n] [--timeout-ms n]',
    positional: [{ name: '目录', required: true, note: '只扫这一层；--recursive 才进子目录。逐件按路径码元序升序、串行跑（确定性）' }],
    flags: [
      { name: 'cmd', type: 'string', default: 'to', defaultFrom: 'BATCH_DEFAULT_CMD', note: '逐件跑哪条命令面：to＝引擎转换（后缀由 --to 定）；markdown＝pandoc 导 GFM（产物恒 .md、不吃 --to，默认 --ext 换成 markdown 的八个输入族）。只有这两条：其余命令各有位置参数形状，塞进来就是"逐件猜参数"' },
      { name: 'ext', type: 'string', default: null, defaultNote: '不传＝按 --cmd 定：to 收九个受支持输入族，markdown 收 docx/odt/pptx/xlsx/csv/tsv/html/htm；给了就只收这些后缀（逗号分隔，可带点）' },
      { name: 'to', type: 'string', default: 'pdf', defaultFrom: 'BATCH_DEFAULT_TO', note: '目标后缀须在支持面内（pdf/docx/odt/txt/xlsx/ods/csv/pptx/odp）；写错回 invalid-output 并带候选。--cmd markdown 下传 --to 直接 invalid-output（产物恒 .md，没有第二种形状）' },
      { name: 'recursive', type: 'boolean', default: false, note: '进子目录（默认只扫一层）' },
      { name: 'max-items', type: 'int', default: 200, defaultFrom: 'BATCH_MAX_ITEMS', note: '超过上限直接拒（不静默截断）；抬限＝调用方明确知情' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS', note: '透传给每一件（单件预算，不是批总量）' },
    ],
    codes: ['invalid-document', 'unsupported-format', 'invalid-output', 'failed'],
  },
  combine: {
    usage: 'combine <输入1.pdf> <输入2.pdf> [更多…] [--out 文件]',
    positional: [
      { name: '输入1.pdf', required: true, note: '按参数顺序拼；产物次序从它起' },
      { name: '输入2.pdf', required: true, note: '至少两份（单件复制不是本命令的活）' },
      { name: '更多输入', required: false, note: '继续接在后面，按参数顺序' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'out', type: 'string', default: null, defaultNote: '省略＝落 _out/<首件名>-combined-<UTC时间戳>.pdf；给了且已存在即 invalid-output（从不覆盖）' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
    note: '输入逐件只读（哈希在 sources[]）；加密件与表单不在 v1 支持面（读取失败按加密/损坏分类报码）。',
  },
  split: {
    usage: 'split <输入.pdf> [--ranges 1-3,5,7-] [--every n] [--dir 目录]',
    positional: [{ name: '输入文件', required: true, note: 'PDF；加密件前置 unsupported-format（先解密）' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'ranges', type: 'string', default: null, defaultNote: '逗号分隔的 N、N-M、N-（1 起、闭区间、N- 到末页）；与 --every 互斥；都不给＝逐页拆' },
      { name: 'every', type: 'int', default: null, defaultNote: '每 N 页一件；与 --ranges 互斥；n 必须 ≥1' },
      { name: 'dir', type: 'string', default: null, defaultNote: '省略＝落 _out/<原名>-split-<UTC时间戳>/；给了就在该目录下自动挑不冲突的名字' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
    note: '一次最多出 ' + SPLIT_MAX_OUTPUTS + ' 件（超限拒绝并指路，不静默截断）。',
  },
  pdftext: {
    usage: 'pdftext <输入.pdf> [--out 文件] [--pages N-M] [--layout] [--enc 编码] [--timeout-ms n]',
    positional: [{ name: '输入.pdf', required: true, note: '按 magic 判 PDF（不看后缀）。数字/文本层 PDF 直取文本层；扫描件无文本层（chars=0 并带 warning）请改走 pages＋ocr；Office 文档取文本用 to ... .txt' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'out', type: 'string', default: null, defaultNote: '省略＝落 _out/<原名>-text-<UTC时间戳>.txt；给了且已存在即 invalid-output（从不覆盖）' },
      { name: 'pages', type: 'string', default: null, defaultNote: '单段连续区间 N、N-M 或 N-（到末页；1 起、闭区间，pdftotext 只吃 -f/-l）；省略＝全文；离散多页请逐段跑' },
      { name: 'layout', type: 'boolean', default: false, note: '透传 pdftotext -layout，尽量保持原版面（表格/多列排版用它）；默认按阅读顺序重排' },
      { name: 'enc', type: 'string', default: 'UTF-8', defaultFrom: 'PDFTEXT_DEFAULT_ENC', note: '透传 pdftotext -enc（文本编码，默认 UTF-8；常见 UTF-8/Latin1）；写错由 pdftotext 原样报错' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS', note: 'pdftotext 子进程预算，超时回 timeout' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'timeout', 'failed'],
    note: 'poppler pdftotext 原生 CLI（不是 Python、ADR-001 不拦）；缺工具回 unavailable 并指路 DOCKIT_POPPLER_BIN；文本只落 txt、不回显进 JSON（与 ocr 同隐私口径）。',
  },
  markdown: {
    usage: 'markdown <输入文档> [输出.md] [--wrap none|auto|preserve] [--track-changes accept|reject|all] [--timeout-ms n]',
    positional: [
      { name: '输入文档', required: true, note: `pandoc 3.12 实测能读、且与本装置受众相关的族：${'docx/odt/pptx/xlsx/csv/tsv/html/htm'}（旧族 .doc/.xls/.ppt 先 to 转新族；PDF 取字走 pdftext）` },
      { name: '输出.md', required: false, note: '省略＝落 _out/<原名>-md-<UTC时间戳>.md 并去重；给了且已存在即 invalid-output（从不覆盖）' },
    ],
    flags: [
      { name: 'wrap', type: 'string', default: 'none', defaultFrom: 'MARKDOWN_DEFAULT_WRAP', note: '透传 pandoc --wrap：none 不硬折行（默认，机器可读优先）；auto 按列宽折；preserve 保留原换行' },
      { name: 'track-changes', type: 'choice', choices: ['accept', 'reject', 'all'], default: null, defaultNote: '不传＝pandoc 默认（accept：插入保留、删除丢弃）；reject＝按拒绝修订的视图；all＝两个方向都带出（insertion/deletion 标记与 author）；只对 docx 输入有效（其它族前置 invalid-output）' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS', note: 'pandoc 子进程预算，超时回 timeout' },
    ],
    codes: ['invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'timeout', 'failed'],
    note: 'pandoc 原生 CLI（不是 Python、ADR-001 不拦）；缺工具回 unavailable 并指路 DOCKIT_PANDOC；--track-changes 只对 docx 有效（修订足迹三态）；markdown 只落 .md 文件、不回显进 JSON（与 ocr/pdftext 同隐私口径）。',
  },
  pdfform: {
    usage: 'pdfform <输入.pdf> --list|--data 数据.json [--flatten] [--font 字体.ttf] [--out 文件]',
    positional: [{ name: '输入.pdf', required: true, note: '按 magic 判 PDF（不看后缀）；只吃 AcroForm（XFA 与加密件不在支持面，签名类字段不写）' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'list', type: 'boolean', default: false, note: '列字段名/类型/选项（与 --data 互斥）；空表单回 count:0 的空列表——空结果是数据不是错误' },
      { name: 'data', type: 'string', default: null, defaultNote: '不传＝不填（只列）；填时必须给 JSON 文件路径（顶层对象、值全标量）——不接内联 JSON，值不回显' },
      { name: 'flatten', type: 'boolean', default: false, note: '填完扁平化（字段变静态内容）；扁平化后装置先自检"剩余字段=0"才落盘' },
      { name: 'font', type: 'string', default: null, defaultNote: '文本值含非 Latin-1 字符（中文等）时指定可嵌入的单体 TTF；不传＝按本机候选位取第一件（仿宋_GB2312/simfang/simhei/simkai）' },
      { name: 'out', type: 'string', default: null, defaultNote: '省略＝落 _out/<原名>-filled-<UTC时间戳>.pdf；给了且已存在即 invalid-output（从不覆盖）' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
    note: '受控填写：输入只读、产物新建；写后由装置重新装载产物逐字段回读对账（不信内存态自报）并复核原件 sha256 未变；值不回显进回报；CJK 值需 @pdf-lib/fontkit＋单体 TTF（缺件回 unavailable 并指路 npm install）。',
  },
  pageops: {
    usage: 'pageops <输入.pdf> <rotate|delete|order> <参数> [--pages 1-3] [--out 文件]',
    positional: [
      { name: '输入.pdf', required: true, note: '按 magic 判 PDF；加密件不支持（装置不绕加密）' },
      { name: '动作', required: true, note: 'rotate（旋转）/ delete（删页）/ order（重排），三选一' },
      { name: '参数', required: true, note: 'rotate＝90/180/270（绝对角度）；delete＝逗号页清单（如 2,4）；order＝逗号页序（如 3,1,2，须为 1..N 各一次的排列）' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'pages', type: 'string', default: null, defaultNote: '仅 rotate 用：逗号区间 1-3,5（1 起、闭区间）；省略＝全页转；delete/order 的页清单走位置参数' },
      { name: 'out', type: 'string', default: null, defaultNote: '省略＝落 _out/<原名>-<动作>-<UTC时间戳>.pdf；给了且已存在即 invalid-output' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
    note: 'pdf-lib 纯 JS 页级操作；输入只读、产物新建；旋转为绝对角度（不叠加原 /Rotate）；不做解密；🔴 水印机主 2026-10-11 裁不做（v2.4.0 曾实现当轮撤）。',
  },
  pipeline: {
    usage: 'pipeline <输入> [<flow>] [--lang eng] [--dpi n] [--dag flow.json]',
    positional: [
      { name: '输入', required: true, note: '起始文件；已是 PDF（按 magic）自动跳过 to 这步' },
      { name: 'flow', required: false, note: '逗号步序列，步 ∈ to/pages/ocr/pdftext（如 to,pages,ocr、to,pdftext）；旧名 to-pages／to-pages-ocr 仍可用；to 只能是第一步。🔴 用 --dag 时可以不传 flow（两者互斥：--dag 优先，flow 被忽略）' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'lang', type: 'string', default: null, defaultNote: 'ocr 步用，透传 ocr --lang（默认由 ocr 决定，中文用 chi_sim）' },
      { name: 'dpi', type: 'int', default: null, defaultNote: '渲染步透传 pages --dpi；省略用 pages 默认' },
      { name: 'dag', type: 'string', default: null, defaultNote: 'v2.7.0 开：走**图执行器**——必须是 JSON **文件路径**（内联 JSON 会被本机 shell 吃掉，这类错犯过多次）。形状 {"nodes":[{"id":"pdf","step":"to"},{"id":"png","step":"pages","needs":["pdf"],"args":{"dpi":150}},{"id":"ocr","step":"ocr","needs":["png"],"when":{"step":"pdf","field":"pageCount","op":"lte","value":3}}]}：needs＝依赖（成环直接拒）、when＝条件（只看上游那一步自己回报的 JSON 字段，op ∈ eq/ne/lt/lte/gte/exists/missing），谓词不成立就 skip 并传染下游。🔴 按拓扑序**确定性串行**——并发明确不做（并发读数由负载决定，那测的是机器不是正确性）；to 节点全图只许一个' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
    note: '逐步 spawn 子进程、解析 JSON 串接路径；任一步失败即停并报 failedStep 与上游 JSON。线性支序列（逗号）与 DAG（--dag）两条路共用同一套子命令与同一套失败口径。',
  },
  gc: {
    usage: 'gc [--dir _out|_tmp|both] [--age 天] [--base 前缀] [--yes]',
    positional: [],
    flags: [
      { name: 'dir', type: 'string', default: 'both', defaultFrom: 'GC_DEFAULT_DIR', defaultNote: '扫哪一块：_out（产物区）／_tmp（运行期临时与夹具目录）／both（默认）' },
      { name: 'age', type: 'int', default: 7, defaultFrom: 'GC_MIN_AGE_DAYS', note: '只碰 mtime 早于这个天数的条目；下限 1 天——0＝不按年龄过滤会连正在跑的自检目录一起扫走，装置不许给自己挖坑' },
      { name: 'base', type: 'string', default: null, defaultNote: '只收文件名以该前缀开头的件（默认不设界＝面上全收）；用来把本轮自己的夹具单独圈出来跑，避免连带别人的产物；给了空/纯空白直接拒（v3.0.0，静默"不过滤"会让调用方以为自己圈住了子集）' },
      { name: 'exclude', type: 'string', default: null, defaultNote: '逗号分隔的前缀清单：指纹命中、但名字以其中任一前缀开头的件**一律不收**，并在回报里单独点名（被排除条数＋样本）。🔴 装置时间戳只证明「这不是人起的名字」，**不证明「这不是真工件」**——真交付件转出的产物同样带装置签名，这一面就是给它们留的活门（默认不排除任何件）' },
      { name: 'yes', type: 'boolean', default: false, defaultNote: '不给＝dry-run，只列清单不动一个文件（默认）；给了才**移动**——本命令不删除任何东西' },
    ],
    codes: ['invalid-output', 'unavailable', 'failed'],
    note: '回收判据＝条目名带装置自己的 UTC 时间戳段（.savetmp-<32hex> 后端残骸与时间戳结尾的目录也算）：能挡住"人起的名字"，🔴 挡不住"真交付件转出的产物"（那些也带签名）⇒ 防误清两层：默认 dry-run 看清单 ＋ --exclude 前缀,...（被排除件单独记账）。只扫 _out/_tmp，真件面（test/fixtures、_probe、装置样本目录）天然不在面上。--yes 的动作是**移动到隔离区**「仓库同级 垃圾产物\\dockit-gc-<时刻>\\」（dirname(ROOT)，与产物区同卷）并写 MANIFEST.md（原路径＋新相对路径＋字节＋mtime＋≤5 MB 者带 sha256），按清单逐条 rename 回去即复原。',
  },
  sheetop: {
    usage: 'sheetop <输入.xlsx> <row-insert|col-insert|row-move|col-move> [--sheet 名] [--at N [--count k] | --from N --to M] [--timeout-ms n] [--skip-recalc] [输出文件]',
    positional: [
      { name: '输入文件', required: true, note: '只吃 xlsx（ZIP 容器＋xl/workbook.xml）；**装置对它零写入**，产物新建。.xls 先 to 转 xlsx；ods 不改结构（装置不写 ODF）' },
      { name: '操作', required: true, note: 'row-insert／col-insert＝插入空行/列（把 >=at 的既有格子整体平移；新格不 materialize，本来就是空的）；row-move／col-move＝把 --from 的那一行/列落到 --to，其余按顺序补位（--to 按**最终布局**数）' },
      { name: '输出文件', required: false, note: '省略＝落 _out/<名>-<操作>-<UTC时间戳>.xlsx 自动去重；给了但已存在 invalid-output（永不覆盖）；与输入同路径直接拒' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'sheet', type: 'string', default: null, defaultNote: '只有一张表时可省略（装置回实际表名）；多表必须点名——表名要来自枚举，猜表名不算流程' },
      { name: 'at', type: 'int', default: null, defaultNote: '插入类落点（1 基，上限＝已用范围＋1）；越界 invalid-output 并回真实范围；移动类传了直接 invalid-output' },
      { name: 'from', type: 'int', default: null, defaultNote: '移动类源下标（1 基）' },
      { name: 'to', type: 'int', default: null, defaultNote: '移动类目标下标（**最终布局**里数）；与 --from 相同＝没有移动，invalid-output' },
      { name: 'count', type: 'int', default: 1, defaultFrom: 'SHEETOP_DEFAULT_COUNT', note: '一次插几行/列（默认插 1 行/列）；上限读配置区 SHEETOP_MAX_SHIFT（当前 1000），越界 invalid-output——大批量分几次跑，每次单独对账' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS', note: '引擎尺里每次重算各自的预算' },
      { name: 'skip-recalc', type: 'boolean', default: false, defaultNote: '跳过引擎尺＝只交结构同构那把尺；跳了会在 warnings 里明写"数值等价未证"' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'failed'],
    note: '引用图对账不过就 code:failed 并**撤掉产物**（不留半成品）；改过公式的缓存值清掉、calcChain 删掉、fullCalcOnLoad 写上 ⇒ 数字交付前仍必须 recalc 再导出（《规范》§7.1）。覆盖面：本表与别表指向本表的公式、共享/数组 ref、命名域、条件格式 sqref 与规则式引用、数据验证、超链接 ref/location、自动筛选/排序状态、dimension、行 spans、分页符、表(ListObject)范围、图表系列 <c:f>、绘图锚点。',
  },
  redline: {
    usage: 'redline <输入.docx> <insert|delete|comment|accept|reject> [--text 文本] [--match 定位串 | --para N] [--author 名] [--date ISO] [--out 文件]',
    positional: [
      { name: '输入文件', required: true, note: '只吃 docx（按 magic 判 ZIP ＋ 找 word/document.xml）；**装置对它零写入**，第一步复制成 _out/<名>-<UTC时间戳>-redlined.docx，原件前后各算一次 sha256' },
      { name: '操作', required: true, note: 'insert＝新文字包进 w:ins；delete＝把定位段落的所有 run 包进 w:del 并把 w:t 改 w:delText；comment＝写 word/comments.xml＋补 [Content_Types]/rels＋插 commentRangeStart/End 与 commentReference；accept＝留插入弃删除并清标记；reject＝弃插入并还原 delText（遇到格式修订直接拒）' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'text', type: 'string', default: null, defaultNote: 'insert／comment 必填；delete 不用（它删的是既有文字）；accept／reject 传了直接 invalid-output（它们作用于全文所有修订）' },
      { name: 'match', type: 'string', default: null, defaultNote: '按段落正文子串定位；命中多段只改第一段并 warning。与 --para 二选一，都给以 --para 为准' },
      { name: 'para', type: 'int', default: null, defaultNote: '段落序号（1 起，含表格单元格里的段落）；越界 invalid-output 并回真实段落数' },
      { name: 'author', type: 'string', default: 'dockit', defaultFrom: 'REDLINE_DEFAULT_AUTHOR', note: '写进 w:author／批注作者；默认值就是这一串' },
      { name: 'date', type: 'string', default: null, defaultNote: '不传＝本次运行的 UTC 时间（Z 结尾、不带毫秒）；给了原样写进 w:date' },
      { name: 'out', type: 'string', default: null, defaultNote: '省略＝落 _out 自动去重；给了但已存在 invalid-output（永不覆盖）；与输入同路径直接拒' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'failed'],
    note: '写完由装置**重新解包回读对账**：数 w:ins／w:del／w:comment、验 --text 进没进、验 accept／reject 后"该留的文字真留、该走的真走"（对着**改前的原文**判，不拿改后的自己证明自己）。格式修订（w:rPrChange／w:pPrChange／w:sectPrChange／w:tblPrChange／w:tcPrChange／w:trPrChange／w:numberingChange／w:cellMerge）：accept＝连标记一起清（保留当前格式并 warning），reject＝只要存在就 unsupported-format（装置没有可靠的 OOXML 旧属性回写面，硬做＝假还原）。',
  },
  redact: {
    usage: 'redact <输入.pdf> [--needle 串] [--needles 数据.json] [--out 文件] [--fill black|none] [--dry-run]',
    positional: [{ name: '输入文件', required: true, note: '只吃 PDF（按 magic）；输入零写入、产物新写、永不覆盖；加密件 unsupported-format（不绕加密）' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'needle', type: 'string', default: null, defaultNote: '单枚要涂黑的文字。与 --needles 可并存（合并成一组）；一个都不给 ⇒ invalid-output——装置不做"整页抹白"这种看着安全的动作' },
      { name: 'needles', type: 'string', default: null, defaultNote: '**JSON 文件路径**（字符串数组或 {needles:[...]}）；值必须全是非空字符串。🔴 不做模糊匹配：全角／简繁／连字／跨行断词都算不同串' },
      { name: 'fill', type: 'string', default: 'black', defaultFrom: 'REDACT_DEFAULT_FILL', defaultNote: 'black（默认）＝画黑框＝脱敏（要看得见）；none＝**不画框**＝删字留白（课表/报表/名单这类"把多余条目去掉"的用途，v3.1.0 新增；复用同一套 locate+delete+verify，验收不变：needle 仍必须零命中）' },
      { name: 'out', type: 'string', default: null, defaultNote: '省略＝落 _out/<名>-<UTC时间戳>-redacted.pdf；已存在 invalid-output；与输入同路径直接拒' },
      { name: 'dry-run', type: 'boolean', default: false, note: '试运行（v3.2.0 新增）：只定位＋旋转检查，不删不画不写盘；报每枚 needle 的命中数/页/框数、会落笔的页、产物会落哪（wouldWriteTo）；needle 找不到或页带旋转只在预览里点名（wouldSucceed=false），正常跑才拒收' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
    note: '🔴 **三段承重**：定位＝poppler `pdftotext -bbox` 的词框（装置不自解字形）；动作＝删掉页面内容流里命中的 BT…ET 文本绘制组 ＋ pdf-lib 画黑框（**只画框不删字＝假脱敏**，这一条是本命令存在的理由；--fill none 时只删不画＝删字留白，脱敏别用它）；验收＝产物再抽一遍文本层，needle 必须**零命中**，命中就 code:failed 并点名"这就是假涂黑"。needle 找不到 ⇒ invalid-output（找不到就不能宣称涂过）；无文本层（扫描件）⇒ failed 指路 pages＋ocr。🔴 /Rotate≠0 的页**前置拒**（v3.1.0 实测：bbox 词框与内容流坐标差一个随旋转变化的常数，删了别的字验收还可能通过——先 pageops rotate 转正再来）。只删页内容流的文本组：Form XObject、注释外观（AP）、附件与 XMP 里的同一串不会被删——验收会抓出来，但别把"这串没了"推广成"这类信息都清了"。',
  },
  tables: {
    usage: 'tables <输入.pdf> [--dir 目录] [--pages 1-3] [--max-tables n]',
    positional: [{ name: '输入文件', required: true, note: '只吃 PDF（按 magic）；输入零写入。OOXML/ODF 的表格请走 to ... .csv（引擎导出，无损且不用猜）' }],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'dir', type: 'string', default: null, defaultNote: '省略＝落 _out/<名>-tables-<UTC时间戳>/；给了但已存在且非空 ⇒ invalid-output（不往别人的目录里丢件）' },
      { name: 'pages', type: 'string', default: null, defaultNote: '不传＝全页；逗号页清单（N 或 N-M，1 起），越界或空清单前置拒' },
      { name: 'max-tables', type: 'int', default: 20, defaultFrom: 'TABLES_MAX_TABLES', note: '一次最多出几张表；超限**停下并 warning**，不静默截断后面所有页' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
    note: '几何法、可自证：网格来自内容流的**矢量线段**（实测 LibreOffice 把 docx 带边框表格画成 m/l——N 行→N+1 条横线、M 列→M+1 条竖线；re 矩形也吃），单元格必须**四边都有线**才算一个格；文字来自 pdftotext -bbox 的词框，按词框中心落格。每表一个 CSV（UTF-8 带 BOM）。🔴 没有闭合网格就回空清单＋warning 并明说"不猜表"——无边框表、图片表、只有横线的表都不在这一面。',
  },
  frommd: {
    usage: 'frommd <输入.md> [输出文件] [--to docx|odt|html|pdf] [--title 名] [--css 样式.css] [--timeout-ms n]',
    positional: [
      { name: '输入文件', required: true, note: 'Markdown 系后缀（.md/.markdown/.mdown/.mkd/.fountain）；**装置对它零写入**（前后 sha256 各测一次）' },
      { name: '输出文件', required: false, note: '省略＝落 _out/<名>-<to>.<后缀> 自动去重；给了但已存在 invalid-output（永不覆盖）；与输入同路径直接拒' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'to', type: 'string', default: 'docx', defaultFrom: 'FROMMD_DEFAULT_TO', note: `生产方向的目标族；全部族：${'docx/odt/html/pdf'}。pdf 走两段（pandoc 出 HTML → 本机无头浏览器 print-to-pdf），版式由浏览器定，与 to（LibreOffice）不是同一路线` },
      { name: 'title', type: 'string', default: null, defaultNote: '不传＝不设文档标题；给了就作为 metadata title 交给 pandoc（进 docx 的属性与 html/pdf 的标题）' },
      { name: 'css', type: 'string', default: null, defaultNote: '仅 html/pdf：绝对路径的样式表，透传 pandoc --css；docx 传了直接 invalid-output（docx 的样式来自 reference doc，不是 CSS）' },
      { name: 'timeout-ms', type: 'int', default: 120000, defaultFrom: 'DEFAULT_TIMEOUT_MS', note: 'pandoc 与浏览器两步共用这一份单步预算' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'timeout', 'failed'],
    note: '🔴 写完装置**自己回读产物核对正文**：docx/odt 解包取 w:t／content.xml 文字、html 去标签、pdf 用 pdftotext 抽文本；样本词**一个都没找到** ⇒ code:failed（"后端退码 0"不算结论，这条与 edit／merge／pdfform 同口径）；找不齐但非零 ⇒ warning 点名"别宣称无损"。缺 pandoc ⇒ unavailable＋指路 DOCKIT_PANDOC；--to pdf 缺浏览器 ⇒ unavailable＋指路 DOCKIT_BROWSER；缺 pdftotext 时 pdf 产物**拒绝出货**（没验证过的产物不许当已核验交付）。输出路径含非 ASCII 时 pdf 面走 ASCII 临时目录中转（v3.1.0：Chromium 的 argv 链路不冒 poppler 那条 ANSI 坑的险）。',
  },
  compress: {
    usage: 'compress <输入.pdf> [输出文件] [--min-stream-bytes n]',
    positional: [
      { name: '输入文件', required: true, note: '只吃 PDF（按 magic）；**原件零写入**（前后 sha256 各测一次）；不解密、不就地改写' },
      { name: '输出文件', required: false, note: '省略＝落 _out/<名>-compressed.pdf 自动去重；给了但已存在 invalid-output；与输入同路径直接拒（PDF 永不做就地改写）' },
    ],
    flags: [
      { name: 'max-input-bytes', type: 'int', default: 268435456, defaultFrom: 'MAX_INPUT_BYTES_DEFAULT', note: '本地解包路线的输入体积闸（整件读进内存前先量字节数）：超限回 input-too-large，不落半成品；抬限属放宽规则需机主同意，也可用环境变量 DOCKIT_MAX_INPUT_BYTES；非整数/≤0 的值直接拒（invalid-output），不静默回退默认' },
      { name: 'min-stream-bytes', type: 'int', default: 512, defaultFrom: 'COMPRESS_MIN_STREAM_BYTES', note: '小于这个字节数的未压缩流不动它（deflate 有头开销，小流压了反而涨）；下限 64，越界 invalid-output' },
    ],
    codes: ['input-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'unavailable', 'failed'],
    note: '🔴 **不依赖 ghostscript／qpdf／Python**，纯 pdf-lib：① 可达性回收（从 trailer 的 Root/Info/ID 做引用闭包，闭包外的间接对象整批删——实测 pdf-lib 自己不做回收，孤儿对象会原样序列化进产物）；② 未压缩流改 deflate level 9。声称"无损"必须证：产物**页数相等 ＋ pdftotext 抽出的正文与原件逐字相等**，不等就 code:failed 并说"别外发"。带 AcroForm 表单／内嵌附件／JavaScript 或 /AA 的件**前置拒**（回收与重写会丢交互层——与 combine/split 同一立场）；pdftotext 不在位时**拒绝出货**（没核验就不叫无损）。体积没降是合法结果，照实报 ratioBytes ＋ warning。',
  },
  help: {
    usage: 'help [命令] [--json] [--brief]',
    positional: [{ name: '命令', required: false, note: '给一个命令名＝出该命令的结构化 spec；给未知名字＝带最近邻候选后失败退出（不落半成品）' }],
    flags: [
      { name: 'json', type: 'boolean', default: false, note: '装置的输出**本来就恒是一行 JSON**，这个开关只表示"按结构化 spec 出全部命令"（不传＝出命令清单）' },
      { name: 'brief', type: 'boolean', default: false, note: '首读索引（v3.1.0）：命令名＋一句话＋是否写盘（writes=true 写盘/写文件系统），每条一行；全量结构化 spec 用 --json（输出 ≈68 KB，终端只看得到尾巴）' },
    ],
    codes: ['invalid-output'],
  },
};

function cmdDoctor(args) {
  // doctor 原本一个参数都不吃，于是 `doctor --banana` 会被**静默放过**并照常跑完整轮体检（实测 2026-10-06）。
  // 未知开关的拒绝只有走 parseArgs 才成立，所以这里也过一次（返回值不吃，只取它的拒绝）。
  parseArgs(args || [], 'doctor');
  const checks = [];
  const push = (name, pass, detail, warn) => checks.push({ name, pass: !!pass, detail, warn: !!warn });
  const [maj, min] = process.versions.node.split('.').map(Number);
  push('node>=22.19.0', maj > 22 || (maj === 22 && min >= 19), process.version);
  const kcD = resolveKitCli();
  // 公开树版（v3.0.1 开源化轮）：绝对路径不进命令输出（运行时出口）——只报"在位/缺失 + 解析来源类别"。
  const shortSrc = (s) => String(s).includes('node_modules') ? 'node_modules 内' : String(s).includes('env') ? '环境变量' : String(s);
  push('kit-cli-exists', kcD.present, kcD.present ? `在位（${shortSrc(kcD.source)}）` : `缺失（来源：${shortSrc(kcD.source)}）`);
  let kitPkg = null; try { kitPkg = JSON.parse(fs.readFileSync(ROOT + '/node_modules/@deepseek-ai/libreoffice-kit/package.json', 'utf8')); } catch {}
  push(`kit-version==${KIT_VERSION}`, kitPkg?.version === KIT_VERSION, kitPkg?.version || '缺失');
  // 🔴 v1.7.1 守卫：这半句此前是裸的——`node_modules` 整棵不在位时它抛 ENOENT，被顶层兜成"装置内部异常"，
  // 于是 doctor **发不出逐条 FAIL 明细**。v1.6.3 R2-2① 想修的就是这个形状，但当时只给上面那句
  // package.json 读取套了 try/catch，这半没套。2026-10-07 19:40 引擎被清扫掉之后，调用方撞到的正是它：
  // 只拿到一句"这是装置缺陷：把本行 JSON 原样回报给调用方，不要重试"，看不出坏的是哪一项。
  let eng = []; let engWhy = '';
  try { eng = fs.readdirSync(ROOT + '/node_modules/@deepseek-ai', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (e) { engWhy = String((e && e.code) || e); }
  const want = `libreoffice-kit-${process.platform}-${process.arch}`;
  push(`engine-package(${want})`, eng.includes(want), engWhy ? `读 ROOT/node_modules/@deepseek-ai 失败 ${engWhy}（引擎整棵缺失＝装置半瘫，转换/渲染面回 unavailable，跑 npm ci）` : (eng.join(',') || '无'));
  const caps = runKit(['capabilities']);
  push('capabilities-ok', caps.ok === true, caps.ok ? `backend=${caps.runtime?.backend} runtime=${caps.runtime?.version}` : `kit capabilities 调用失败（${caps.code || '无错误码'}）`);
  if (caps.ok) {
    const m = caps.conversions || [];
    const flat = {}; for (const c of m) { const fam = c.inputs.includes('docx') ? 'word' : c.inputs.includes('xlsx') ? 'sheet' : 'slide'; flat[fam] = { inputs: c.inputs, outputs: c.outputs }; }
    push('format-matrix-matches-code', JSON.stringify(normalize(flat)) === JSON.stringify(normalize(FORMAT_MATRIX)), '对账见 selftest #cap');
  }
  ensureDir(OUT_DIR); ensureDir(TMP_DIR);
  const probe = `${TMP_DIR}/.write-${stamp()}`;
  let writable = false; try { fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); writable = true; } catch {}
  // 公开树版（v3.0.1 开源化轮）：目录绝对路径不进命令输出——只报相对名与可写性。
  push('out-and-tmp-writable', writable, writable ? '_out 与 _tmp 均可写' : '输出目录不可写');
  const f = installedFontFamilies();
  push('font-dir-readable', f.readable && f.count > 0, `系统字体目录 文件数=${f.count ?? 0}`);
  // 🔴 替身字体哨兵：装置自带引擎，但**字体走系统字体库**。这批度量兼容替身（Carlito/Caladea/Liberation/
  // DejaVu/Noto/Rubik…）当年是 LibreOffice 装进 C:\Windows\Fonts 的，卸载它会一起带走，而后果是静默的——
  // 缺字自曝会变非空、嵌入字体会换名。所以在环境里必须有一条能直接查到的判据，见 test/font-baseline.js。
  const SENTINELS = ['Carlito-Regular.ttf', 'Caladea-Regular.ttf', 'LiberationSans-Regular.ttf', 'LiberationSerif-Regular.ttf', 'DejaVuSans.ttf', 'NotoSans-Regular.ttf', 'Rubik-Regular.ttf'];
  const fdir = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'Fonts') : 'C:/Windows/Fonts';
  const absent = SENTINELS.filter((n) => !fs.existsSync(path.join(fdir, n)));
  // 🔴 v1.7.2：覆盖面由"7 个固定名"改按登记清单核**全量**。缺陷事实（2026-10-09 监工侧一手）：系统字体目录被直删掉
  // 6 个替身件，本条只点名了 1 个（NotoSans-Regular），另有 3 个（Noto Sans 的 Bold/Italic/BoldItalic）连 26 族基线
  // 都看不见；而丢掉的 `LiberationMono-Regular.ttf`/`DejaVuSerif.ttf` 造成的是**静默替换**——声明这两族的文档
  // 实测把 Regular 换成 Italic 面嵌入，`missingFonts` 全程为空（正是本文件上面那条注释说的"后果是静默的"，
  // 但旧实现连静默都只报三分之一）。清单是**这台机器**的事实，所以非标定机器一律降 WARN，不打穿"外人克隆首跑全绿"。
  const FM_PATH = process.env.DOCKIT_FONT_MANIFEST || ROOT + '/test/font-manifest.json';
  let fm = null, fmWhy = '';
  try { fm = JSON.parse(fs.readFileSync(FM_PATH, 'utf8')); } catch (e) { fmWhy = String((e && e.code) || e); }
  const hostNow = process.env.COMPUTERNAME || '';
  if (!fm || !Array.isArray(fm.files) || !fm.files.length) {
    push('substitute-fonts-present', absent.length === 0, `登记清单不可用（读取失败：${fmWhy || 'files 字段缺失'}）→ 退回核 ${SENTINELS.length} 个通用替身名：` + (absent.length ? `缺 ${absent.length}/${SENTINELS.length}: ${absent.join(', ')}（声明这些族的文档版式会变，跑 node test/font-baseline.js check 看差异）` : `${SENTINELS.length}/${SENTINELS.length} 在位`), absent.length === 0);
  } else if (fm.标定机器 && fm.标定机器 !== hostNow) {
    // 公开树版（v3.0.1 开源化轮）：机器名不进命令输出——占位符或非标定机器一律报「非标定机器」，
    // 不回显主机名本身（hostNow 是运行时出口，外人分享 doctor 输出时会带上本机名）。
    push('substitute-fonts-present', true, `清单标定于非本机（标定机器名不回显）→ 只 WARN 不判红（${fm.files.length} 件是标定机器的字体登记集，别处不该拿它当门）；本机 7 个通用替身名：${absent.length ? '缺 ' + absent.join(', ') : '全在位'}`, true);
  } else {
    let checked = 0;
    const miss = [];
    const badHash = [];
    for (const x of fm.files) {
      checked++;
      const p = path.join(fdir, x.name);
      if (!fs.existsSync(p)) { miss.push(x); continue; }
      // P0-2（发布前审查实抓）：只核在位不验哈希＝同名异容照绿。凡清单记了 sha256 的件逐件实算比对。
      if (x.sha256) {
        let h = null;
        try { h = sha256(fs.readFileSync(p)); } catch {}
        if (!h || h.toLowerCase() !== String(x.sha256).toLowerCase()) badHash.push(x.name);
      }
    }
    const hashPart = badHash.length ? `；哈希错 ${badHash.length}（同名异容，清单对不上盘上字节）：${badHash.slice(0, 8).join(', ')}${badHash.length > 8 ? ' …' : ''}（用 install-fonts --source 重装对版字体后复验）` : '';
    push('substitute-fonts-present', miss.length === 0 && badHash.length === 0, (miss.length
      ? `缺 ${miss.length}/${fm.files.length}（已核 ${checked}）: ${miss.slice(0, 8).map((x) => x.name).join(', ')}${miss.length > 8 ? ' …' : ''}（声明这些族的文档版式会变；按 README 配置字体源后复验；真实差异跑 node test/font-baseline.js check）`
      : `${fm.files.length}/${fm.files.length} 在位（已核 ${checked}）`) + hashPart);
  }
  const vcr = vcRedistPresent();
  push('msvc-v14-redist', vcr.found, vcr.found ? 'VC++ v14 运行库在位' : '未找到 VC++ v14 运行库（kit 的 Windows 原生引擎需要它，见 README 使用限制）');
  // Tesseract 哨兵（v1.4.0，ADR-001）：ocr 的外部依赖。不在位报 WARN 不 FAIL——外人克隆、没装的机器
  // doctor 与 selftest 依旧全绿，ocr 判据逐条 SKIP（降级形状由「ocr 降级」判据用环境变量假路径覆盖）。
  const tp = tesseractProbe();
  push('tesseract-ocr', true, tp.available ? `在位（langs=${tp.langCount ?? '?'}）` : '不在位（需配置 DOCKIT_TESSERACT；ocr 判据将逐条 SKIP）', !tp.available);
  // v1.7.0：中文语言包单独一条，不埋在上一行的 langs=N 计数里。起因是这份包一直躺在 gitignore 的
  // _out/tessdata-best 上，而 2026-10-07 19:40 那次清扫把同类的 _probe/ 整目录连 node_modules 一起带走了——
  // 看不见的位置就会静默失效。形状仍是 **WARN 不 FAIL**：「这台机器装没装中文包」是机器事实，
  // 做成 FAIL 会打穿「外人克隆首跑全绿」（总览第八节第 20 条同族），所以它只自报解析到的目录与清单。
  const chiSimPresent = !!(tp.available && Array.isArray(tp.langs) && tp.langs.includes('chi_sim'));
  push('ocr-lang-pack', true, chiSimPresent
    ? `chi_sim 在位（本次 langs=${tp.langs.join('/')}）`
    : `chi_sim 不在本次 tessdata 配置中（langs=${Array.isArray(tp.langs) ? (tp.langs.join('/') || '(空)') : '未读出'}）——要读中文就先装 chi_sim.traineddata 并配置 DOCKIT_TESSDATA`,
    !chiSimPresent);
  // 写后端哨兵（v1.6.0 R6，ADR-002）：同一条降级形状——不在位报 **WARN 不 FAIL**，`edit`/`merge` 回 unavailable，
  // 相关判据逐条 SKIP，没装它的机器上 doctor 与 selftest 依旧全绿。自报**解析来源**（配置区默认 vs 环境变量），
  // 只报路径不报来源的话，"指错了 env"这种状态在诊断面上是隐形的。
  const ocli = officecliVersion();
  const ores = resolveOfficecliExe();
  push('officecli-write-backend', true, ocli.available
    ? `在位（配置来源：${ores.source}；隔离 env：${Object.entries(OFFICECLI_ISOLATION_ENV).map(([k, v]) => k + '=' + v).join(' ')}；动词白名单：${OFFICECLI_VERB_ALLOW.join('/')}）`
    : `不在位（配置来源：${ores.source}）—— edit/merge 不可用（相关判据将逐条 SKIP；装法与边界见 docs/adr/ADR-002）`, !ocli.available);
  // v1.9.0：combine/split 的纯 JS 依赖（pdf-lib，已进 package.json dependencies）。缺失＝这两条命令回
  // unavailable；它是 npm 依赖类（与 kit 同层），按 FAIL 报——npm install 之后必然在位，红得起的才是真依赖。
  let pdfLibVer = null; let pdfLibWhy = '';
  try { pdfLibVer = require('pdf-lib/package.json').version; } catch (e) { pdfLibWhy = String((e && e.code) || (e && e.message) || e).slice(0, 60); }
  push('pdf-lib-in-place', !!pdfLibVer, pdfLibVer ? `v${pdfLibVer}（combine/split/pageops/pdfform/scrub-PDF 用；纯 JS、不起外部进程）` : `缺失（${pdfLibWhy}）⇒ 相关命令回 unavailable：跑 npm install（pdf-lib 已进 package.json）`);
  let fkVer = null, fkWhy = '';
  try { fkVer = require('@pdf-lib/fontkit/package.json').version; } catch (e) { fkWhy = String((e && e.code) || (e && e.message) || e).slice(0, 60); }
  push('fontkit-in-place', !!fkVer, fkVer ? `v${fkVer}（pdfform 的中文字段值嵌字体用；纯 JS、不起外部进程）` : `缺失（${fkWhy}）⇒ pdfform 的中文字段值回 unavailable：跑 npm install（@pdf-lib/fontkit 已进 package.json）`);
  // v1.9.0（只 WARN）：技能配方类的辅助 CLI（pandoc / poppler 的 pdftoppm）。它们**不是**装置依赖——
  // 装置的转换/渲染/重算都不经过它们；缺了只影响"自带技能配方"那半边的步骤。WARN 的形状照 tesseract 哨兵。
  const auxTool = (name, fallback) => {
    try { const w = spawnSync('where.exe', [name], { encoding: 'utf8' }); if (w.status === 0) return String(w.stdout).trim().split(/\r?\n/)[0]; } catch { /* 走兜底 */ }
    return fallback && fs.existsSync(fallback) ? fallback : null;
  };
  const auxPandoc = auxTool('pandoc', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'pandoc', 'pandoc.exe'));
  const auxPoppler = auxTool('pdftoppm', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'poppler', 'Library', 'bin', 'pdftoppm.exe'));
  const auxMissing = [!auxPandoc && 'pandoc', !auxPoppler && 'pdftoppm'].filter(Boolean);
  // 公开树版（v3.0.1 开源化轮）：工具路径不进命令输出——绝对路径含用户名，是运行时出口
  // （外人分享 doctor 输出时会带本机用户名）；只报"在位/缺失 + 来源类别"。
  const shortPath = (p) => p ? (String(p).includes(process.env.LOCALAPPDATA || '\u0000') ? '%LOCALAPPDATA% 下的安装位' : 'PATH 上的安装位') : '(不在位)';
  push('aux-tools(pandoc/poppler)', true, auxMissing.length
    ? `缺：${auxMissing.join(' / ')}——只影响技能配方类步骤（修订比对/PDF 转图），装置命令面按各自哨兵另核（pandoc 见 pandoc-markdown 条）；安装位 %LOCALAPPDATA%\\Programs\\pandoc 与 \\poppler`
    : `pandoc 在位（${shortPath(auxPandoc)}） ; pdftoppm 在位（${shortPath(auxPoppler)}）`, auxMissing.length > 0);
  // v2.1.0：poppler 的 pdftotext/pdfimages 现在是**装置命令面**真正会调的原生 CLI（pdftext 直取文本层、media 抽 PDF
  // 内嵌图），不再只是技能配方。形状照 tesseract 哨兵：不在位 **WARN 不 FAIL**（外人克隆没装 poppler 时 doctor 与
  // selftest 依旧全绿，相关判据逐条 SKIP），命令回 unavailable 并指路 DOCKIT_POPPLER_BIN。原生 CLI、非 Python，不触 ADR-001。
  const pTxt = popplerTool('pdftotext'); const pImg = popplerTool('pdfimages');
  const pmMissing = [!pTxt.present && 'pdftotext', !pImg.present && 'pdfimages'].filter(Boolean);
  push('poppler-pdf-text-media', true, pmMissing.length
    ? `缺：${pmMissing.join(' / ')}—— pdftext／media(PDF) 回 unavailable（相关判据 SKIP）；装全 poppler 或设 DOCKIT_POPPLER_BIN 指其 bin 目录`
    : `pdftotext 在位（${shortPath(pTxt.exe)}） ; pdfimages 在位（pdftext 直取 PDF 文本层、media 抽 PDF 内嵌图；原生 CLI 非 Python）`, pmMissing.length > 0);
  // v2.3.0：pandoc 从"技能配方类辅助"升为**命令面后端**（markdown：文档→GFM）。形状照 v2.1.0 poppler 先例：
  // 不在位 WARN 不 FAIL（外人克隆没装 pandoc 时 doctor 与 selftest 依旧全绿，相关判据逐条 SKIP），
  // 命令回 unavailable 并指路 DOCKIT_PANDOC。原生 CLI、非 Python，不触 ADR-001。
  const pdT = pandocTool();
  push('pandoc-markdown', true, pdT.present
    ? `pandoc 在位（${shortPath(pdT.exe)}；markdown 命令后端，文档→GFM）`
    : `不在位—— markdown 回 unavailable（相关判据 SKIP）；装 pandoc（%LOCALAPPDATA%\\Programs\\pandoc）或设 DOCKIT_PANDOC 指 pandoc.exe`,
    !pdT.present);
  const failed = checks.filter((c) => !c.pass);
  out({ ok: failed.length === 0, version: VERSION, kitVersion: KIT_VERSION, checks: checks.map((c) => `${c.warn ? 'WARN' : c.pass ? 'PASS' : 'FAIL'} ${c.name} :: ${c.detail}`), failed: failed.length });
  if (failed.length) process.exit(1);
}
function normalize(m) { const o = {}; for (const k of Object.keys(m).sort()) o[k] = { inputs: [...m[k].inputs].sort(), outputs: [...m[k].outputs].sort() }; return o; }
function vcRedistPresent() {
  const roots = ['C:/Windows/System32', 'C:/Windows/SysWOW64'];
  const names = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp143.dll', 'msvcp140.dll'];
  const found = [];
  for (const r of roots) { if (!fs.existsSync(r)) continue; for (const n of names) if (fs.existsSync(path.join(r, n))) found.push(`${r}/${n}`); }
  return { found: found.length > 0, detail: found.slice(0, 3).join(' , ') || '未找到 VC++ v14 运行库（kit 的 Windows 原生引擎需要它，见 README 使用限制）' };
}

function cmdTo(args) {
  const { positional, flags } = parseArgs(args, 'to');
  const input = abs(positional[0]); if (!input || !fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '先给绝对路径，或 ls 确认文件名');
  const inExt = extOf(input);
  const fam = familyOf(inExt);
  if (!fam) die('unsupported-format', `输入后缀 .${inExt} 不在 kit 的支持族内`, `支持：${Object.values(FORMAT_MATRIX).flatMap((v) => v.inputs).join('/')}`);
  let output = positional[1] ? abs(positional[1]) : null;
  if (!output) output = freePath(OUT_DIR, `${path.basename(input, '.' + inExt)}-${stamp()}`, DEFAULT_TO_OUTPUT_EXT);
  const outExt = extOf(output);
  if (!FORMAT_MATRIX[fam].outputs.includes(outExt)) die('unsupported-format', `不支持的转换：${inExt} → ${outExt}`, `.${inExt} 只能出 ${FORMAT_MATRIX[fam].outputs.join('/')}；不写输出路径时默认出 pdf`);
  if (abs(input) === abs(output)) die('invalid-output', '输入与输出是同一个文件', '装置按设计拒绝原地覆盖，请另给输出路径');
  if (positional[1] && fs.existsSync(output)) die('invalid-output', `输出已存在，绝不覆盖：${output}`, '换个输出路径，或省略让装置落 _out 自动去重');
  let noteSheetProbe = null;
  const kitArgs = ['convert', '--input', input, '--output', output];
  if (flags.sheet) kitArgs.push('--sheet', flags.sheet);
  if (outExt === 'csv' && fam === 'sheet') {
    const sh = listSheets(input, 'auto');
    if (sh.method === 'error') noteSheetProbe = sh.error;
    if (!flags.sheet && sh.method !== 'single' && sh.names.length > 1) die('invalid-output', `这是 ${sh.names.length} 个工作表的簿，kit 会拒绝出 csv（防静默只导第一张）`, `加 --sheet <名字>，可选：${sh.names.join(' | ')}（枚举方式=${sh.method}）`);
  }
  for (const k of ['timeout-ms', 'max-input-bytes', 'max-output-bytes', 'max-archive-entries', 'max-uncompressed-bytes', 'font-directory', 'initial-font-family', 'font-fallbacks']) if (flags[k] !== undefined) kitArgs.push('--' + k, String(flags[k]));
  if (flags['timeout-ms'] === undefined) kitArgs.push('--timeout-ms', String(DEFAULT_TIMEOUT_MS));
  let r = runKit(kitArgs);
  let inputRepair = null; const warnings = [];
  if (!r.ok && oleRepairEligible(r)) {
    const fix = oleAlignRetryPlan(input, inExt);
    if (fix) {
      let out2 = output; if (fs.existsSync(out2)) out2 = freePath(path.dirname(out2), path.basename(out2, '.' + outExt), outExt);
      const r2 = runKit(kitArgs.map((x) => (x === input ? fix.dst : x === output ? out2 : x)));
      if (r2.ok) { r = r2; inputRepair = oleRepair(fix, input, warnings); }
      else die(r.code, oleRepairFailMsg(r, r2, fix), OLE_REPAIR_NEXT);
    }
  }
  if (!r.ok) die(r.code, r.error, nextFor(r.code, { input, output, fam, inExt }));
  out({ ok: true, op: 'convert', ms: r.ms, backend: r.backend, sheetProbe: noteSheetProbe || undefined, input: { path: input, bytes: fs.statSync(input).size, sha256: sha256(fs.readFileSync(input)) }, output: { path: r.outputPath, bytes: fs.statSync(r.outputPath).size, sha256: sha256(fs.readFileSync(r.outputPath)) }, missingFonts: r.missingFonts, declaredFamilies: declaredFromInput(input), warnings: warnings.length ? warnings : undefined, inputRepair: inputRepair || undefined, note: r.missingFonts?.length ? 'missingFonts 非空＝文档声明了本机没有的字体族，版式可能与原件不同；PDF 再渲染不报缺字属正常' : undefined });
}

function nextFor(code, ctx) {
  switch (code) {
    case 'unavailable': return '引擎缺失或版本不匹配：先 node dockit.js doctor，必要时 npm install @deepseek-ai/libreoffice-kit@' + KIT_VERSION;
    case 'unsupported-format': return `查 capabilities 的族矩阵：.${ctx.inExt} 只能出 ${ctx.fam ? FORMAT_MATRIX[ctx.fam].outputs.join('/') : '—'}`;
    case 'invalid-document': return '多半是改后缀的伪装件（RTF/HTML/纯文本当 OOXML）或损坏；先 inspect 看容器识别结果，别绕路';
    case 'input-too-large': return '加 --max-input-bytes 提高上限（需你明确同意），或先确认文件是不是被当成输入挑错了';
    case 'output-too-large': return '加 --max-output-bytes 提高上限（需你明确同意）';
    case 'timeout': return `文档很大或引擎冷启动慢；加 --timeout-ms（当前默认 ${DEFAULT_TIMEOUT_MS}）`;
    case 'invalid-output': return '输出目录的父级必须已存在、且输出不能已存在；装置默认会自动挑不冲突的路径';
    case 'failed': return '看 error 原文；EEXIST/ENOENT 属调用方路径问题，"CSV worksheet was not found" 需先 sheets 拿准确表名';
    default: return '把 code 与 error 一并回报，不要静默重试';
  }
}
function declaredFromInput(input) {
  try {
    const buf = fs.readFileSync(input);
    if (buf.readUInt32LE(0) !== 0x04034b50) return { available: false, why: '非 ZIP 容器（OLE 二进制或 PDF），字体表由 LibreOffice 读，装置不猜' };
    const map = zipRead(buf); const fam = zipFamily(map);
    // 部件清单必须覆盖"字体名实际落在哪"：OOXML 演示文稿的正文只写 `+mj-lt` 这类主题令牌，真族名在
    // theme / slideMaster / slideLayout 里；文字件在 fontTable，表格件在 styles 与 sharedStrings。
    // v1.2.1 前少扫这些 ⇒ 真 pptx 的声明族读成 0 项（实测 `_probe/real.pptx`：pptx 侧 0 族、由它自产的 odp 侧 14 族）。
    const FONT_PART_RE = /(?:^|\/)(?:document|styles|sheet\d+|slides\/slide\d+|presentation|content|theme\d+|slideMaster\d+|slideLayout\d+|fontTable|sharedStrings)\.xml$/;
    const parts = [...map.keys()].filter((k) => FONT_PART_RE.test(k));
    return { available: true, container: fam, families: declaredFamilies(parts.map((p) => map.get(p).toString('utf8'))) };
  } catch (e) { return { available: false, why: e.message }; }
}

// v2.2.0：kit 缺失时，PDF 用 poppler pdftoppm 降级渲染（**只对 PDF**；OOXML 渲染仍必须靠 kit，不许悄悄扩大）。
// cwd + ASCII 前缀绕中文 argv 坑（同 mediaFromPdf）；返回与 kit 兼容的 manifest 形状，pdftoppm 不在位回 null（由调用方走原拒绝）。
function pagesFromPoppler(input, dir, flags) {
  const pt = popplerTool('pdftoppm');
  if (!pt.present) return null;
  ensureDir(dir);   // kit 缺失时没有进程替我们建产物目录，先自建（freeDir 只建父层）
  const t0 = Date.now();
  const dpi = Number(flags.dpi) || 150;
  if (!Number.isFinite(dpi) || dpi < 10 || dpi > 1200) die('invalid-output', `--dpi 需在 10–1200，给了 ${flags.dpi}`, '照 help pages 改');
  const pa = ['-png', '-r', String(dpi)];
  // pdftoppm 只吃单段 -f/-l；--pages 首段连续时透传，离散页在 warning 点名（不静默扩范围）
  const ranges = verifyPagesToRanges(flags.pages);
  const fbWarnings = [];
  if (ranges && ranges.length === 1 && ranges[0][0] !== null) { pa.push('-f', String(ranges[0][0])); if (ranges[0][1] !== null) pa.push('-l', String(ranges[0][1])); }
  if (ranges && ranges.length > 1) fbWarnings.push('poppler 降级只支持单段 --pages，离散多页本次按全量渲染（kit 在位时不会走到这）');
  pa.push(input, 'page');
  const rr = spawnSync(pt.exe, pa, { encoding: 'utf8', cwd: dir, timeout: DEFAULT_TIMEOUT_MS });
  if (rr.signal === 'SIGTERM') die('timeout', 'pdftoppm 降级渲染超预算', nextFor('timeout', {}));
  if (rr.status !== 0) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} die('invalid-document', `pdftoppm 降级渲染失败：${String(rr.stderr || rr.stdout).trim().slice(0, 140)}${/I\/Error/i.test(String(rr.stderr || '')) ? '（🔴 若本机 poppler 装在含中文的路径下，这是 poppler argv ANSI 解码坑：把 poppler 挪到全 ASCII 路径并用 DOCKIT_POPPLER_BIN 指过去——v3.1.0 实测）' : ''}`, '先 inspect 看容器'); }
  const numOf = (n) => Number((n.match(/(\d+)\.png$/i) || [, 0])[1]);
  const names = fs.readdirSync(dir).filter((n) => /\.png$/i.test(n) && fs.statSync(path.join(dir, n)).isFile()).sort((a, b) => numOf(a) - numOf(b));
  const images = names.map((n, i) => {
    const p = path.join(dir, n); const st = fs.statSync(p); const px = pngDarkRatio(p);
    return { index: i + 1, page: i + 1, path: p, width: px ? px.w : null, height: px ? px.h : null, byteLength: st.length };
  });
  return { ok: true, images, pageCount: images.length, backend: 'poppler(fallback)', rasterEngine: 'pdftoppm', ms: Date.now() - t0,
    sourceSha256: sha256(fs.readFileSync(input)), missingFonts: null, fallbackWarnings: fbWarnings };
}
function cmdPages(args) {
  const { positional, flags } = parseArgs(args, 'pages');
  const input = abs(positional[0]); if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const dir = freeDir(flags.dir ? abs(flags.dir) : OUT_DIR, `${path.basename(input, '.' + extOf(input))}-pages-${stamp()}`);
  const kitArgs = ['render', '--input', input, '--output-dir', dir];
  for (const k of ['pages', 'dpi', 'sheet', 'range', 'max-image-resolution', 'timeout-ms']) if (flags[k] !== undefined) kitArgs.push('--' + k, String(flags[k]));
  if (flags['timeout-ms'] === undefined) kitArgs.push('--timeout-ms', String(DEFAULT_TIMEOUT_MS));
  let r = runKit(kitArgs);
  let inputRepair = null; const warnings = [];
  if (!r.ok && oleRepairEligible(r)) {
    const fix = oleAlignRetryPlan(input, extOf(input));
    if (fix) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      const r2 = runKit(kitArgs.map((x) => (x === input ? fix.dst : x)));
      if (r2.ok) { r = r2; inputRepair = oleRepair(fix, input, warnings); }
      else { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} die(r.code, oleRepairFailMsg(r, r2, fix), OLE_REPAIR_NEXT); }
    }
  }
  // kit 缺失：PDF 且 pdftoppm 在位 ⇒ 降级渲染（只对 PDF；OOXML 不许悄悄扩大）
  if (!r.ok && r.code === 'unavailable' && r.dep === 'kit') {
    const b0 = fs.readFileSync(input);
    if (b0.slice(0, 5).toString('latin1') === '%PDF-') {
      const fb = pagesFromPoppler(input, dir, flags);
      if (fb) {
        r = fb;
        if (fb.fallbackWarnings.length) warnings.push(...fb.fallbackWarnings);
        warnings.push('kit 缺失：PDF 改用 poppler pdftoppm 降级渲染（backend=poppler(fallback)）；OOXML 渲染仍需 kit');
      }
    }
  }
  if (!r.ok) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} die(r.code, r.error, nextFor(r.code, { input, fam: familyOf(extOf(input)), inExt: extOf(input) })); }
  const tiles = r.images || [];
  const wantPixels = flags.pixels !== 'off';
  const scan = tiles.slice(0, MAX_PIXEL_TILES);
  const pixels = wantPixels ? scan.map((t) => ({ index: t.index, page: t.page ?? null, sheet: t.sheet ?? null, file: path.basename(t.path), ...pngDarkRatio(t.path) || { err: 'png-decode-failed' } })) : [];
  out({
    ok: true, op: 'render', ms: r.ms, backend: r.backend, rasterEngine: r.rasterEngine, dir, pageCount: r.pageCount,
    sheets: [...new Set(tiles.map((t) => t.sheet).filter(Boolean))], range: tiles[0]?.range ?? null,
    tiles: tiles.map((t) => ({ index: t.index, page: t.page ?? null, sheet: t.sheet ?? null, w: t.width, h: t.height, bytes: t.byteLength })),
    pixelEvidence: wantPixels ? { scanned: pixels.length, of: tiles.length, truncated: tiles.length > MAX_PIXEL_TILES, tiles: pixels } : 'off',
    sourceSha256: r.sourceSha256, missingFonts: r.missingFonts, warnings: warnings.length ? warnings : undefined, inputRepair: inputRepair || undefined,
    note: r.pageCount > 100 ? 'kit 单次 render 上限 100 页；超了按 --pages 分段' : (tiles.length && tiles.every((t) => (t.width || 0) > 8192) ? 'kit 单边上限 8192px' : undefined),
  });
}

function listSheets(input, method) {
  const buf = fs.readFileSync(input);
  if (method !== 'render' && buf.readUInt32LE(0) === 0x04034b50) {
    try {
      const map = zipRead(buf);
      const wb = map.get('xl/workbook.xml');
      if (wb) {
        const names = [...str(wb).matchAll(/<sheet[^>]*\sname="([^"]+)"/g)].map((m) => m[1]);
        if (names.length) return { names, method: names.length === 1 ? 'zip-single' : 'zip', via: '读 xl/workbook.xml，未启动引擎' };
      }
      const ct = map.get('content.xml');
      if (ct && map.get('mimetype') && str(map.get('mimetype')).includes('spreadsheet')) {
        const names = [...str(ct).matchAll(/table:table\s+table:name="([^"]+)"/g)].map((m) => m[1]);
        if (names.length) return { names, method: names.length === 1 ? 'zip-single' : 'zip', via: '读 ODF content.xml，未启动引擎' };
      }
    } catch { /* 落到 render 路线 */ }
  }
  const dir = freeDir(TMP_DIR, `sheets-${stamp()}`);
  const r = runKit(['render', '--input', abs(input), '--output-dir', dir, '--timeout-ms', String(DEFAULT_TIMEOUT_MS)]);
  const names = r.ok ? [...new Set((r.images || []).map((t) => t.sheet).filter(Boolean))] : [];
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!r.ok) return { names: [], method: 'error', via: 'render 路线失败', code: r.code, error: r.error };
  return { names, method: names.length === 1 ? 'render-single' : 'render', via: '引擎自报 manifest.images[].sheet（顺带产出的 PNG 已清理）' };
}
function cmdSheets(args) {
  const { positional, flags } = parseArgs(args, 'sheets');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'sheets'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  const input = abs(positional[0]); if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  if (!['xls', 'xlsx', 'ods'].includes(extOf(input))) die('unsupported-format', `.${extOf(input)} 不是表格族`, 'sheets 只用于 xls/xlsx/ods');
  const s = listSheets(input, flags.method || DEFAULT_SHEETS_METHOD);
  if (s.method === 'error') die(s.code, s.error, 'sheets 的 render 路线需要表格文件可加载；OLE 二进制(.xls)若失败，先 to 转成 xlsx 再 sheets');
  out({ ok: true, op: 'sheets', input, count: s.names.length, names: s.names, method: s.method, via: s.via, note: s.names.length > 1 ? '多表簿出 csv 必须 --sheet 指准确表名（kit 会拒绝静默只出第一张）' : undefined });
}

function cmdRecalc(args) {
  const { positional, flags } = parseArgs(args, 'recalc');
  const input = abs(positional[0]); if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const inExt = extOf(input);
  if (!['xls', 'xlsx', 'ods'].includes(inExt)) die('unsupported-format', `.${inExt} 不能被 recalculate`, '只有 xls/xlsx/ods 可重算');
  // v1.3.1（B 段真件 D0406C.xls 实测撞出的缺陷）：--verify 的逐格对比走装置 ZIP 读取器（cellMap），
  // OLE 二进制没有 XML 工作表可对比，异常曾被兜底层裹成 invalid-document + "装置内部异常"——
  // 输入没坏（inspect/to/pages/sheets 全绿），是这一层不支持 ⇒ 前置分流（scrub 对 ODF 的 v1.2.0 同款修法）。
  if (flags.verify) { const hb = fs.readFileSync(input); if (hb.length < 4 || hb.readUInt32LE(0) !== 0x04034b50) die('unsupported-format', 'recalc --verify 的逐格对比只支持 ZIP 容器（xlsx/ods）；.xls 这类 OLE 二进制没有可对比的 XML 工作表', '去掉 --verify 直接引擎重算（.xls 支持），或先把 .xls to 成 .xlsx 再 recalc --verify'); }
  const outExt = positional[1] ? extOf(positional[1]) : DEFAULT_RECALC_OUTPUT_EXT;
  if (positional[1] && !['xlsx', 'ods'].includes(outExt)) die('unsupported-format', `recalculate 只能出 xlsx/ods，给的是 .${outExt}`, '改输出后缀');
  const output = positional[1] ? abs(positional[1]) : freePath(OUT_DIR, `${path.basename(input, '.' + inExt)}-recalced`, outExt);
  const r = runKit(['recalculate', '--input', input, '--output', output, '--timeout-ms', String(flags['timeout-ms'] ?? DEFAULT_TIMEOUT_MS)]);
  if (!r.ok) die(r.code, r.error, nextFor(r.code, { input, output, fam: 'sheet', inExt }));
  let verify = null;
  if (flags.verify) verify = verifyRecalc(input, output);
  let errorSummary = null;
  if (flags['report-errors']) errorSummary = buildErrorSummary(r.outputPath);
  out({ ok: true, op: 'recalculate', ms: r.ms, backend: r.backend, input: { path: input, sha256: sha256(fs.readFileSync(input)) }, output: { path: r.outputPath, bytes: fs.statSync(r.outputPath).size, sha256: sha256(fs.readFileSync(r.outputPath)) }, verify, errorSummary });
}
function cellMap(file) {
  const map = zipRead(fs.readFileSync(file));
  const res = {};
  for (const [name, data] of map) {
    const m = /^xl\/worksheets\/(.+)\.xml$/.exec(name); if (!m) continue;
    const xml = str(data); const cells = {};
    for (const c of xml.matchAll(/<c\s+r="([A-Z]+\d+)"[^>]*>(.*?)<\/c>/gs)) {
      const inner = c[2];
      const f = /<f[^>]*>(.*?)<\/f>/s.test(inner);
      const v = /<v>(.*?)<\/v>/s.exec(inner)?.[1] ?? null;
      if (f || v !== null) cells[c[1]] = { formula: f, value: v };
    }
    res[m[1]] = cells;
  }
  return res;
}
function verifyRecalc(input, output) {
  const before = cellMap(input), after = cellMap(output);
  const changed = [], same = []; let formulaCount = 0;
  for (const sheet of Object.keys(before)) {
    for (const [ref, b] of Object.entries(before[sheet] || {})) {
      const a = after[sheet]?.[ref];
      if (b.formula) formulaCount++;
      if (!a) { changed.push({ sheet, ref, to: 'cell-vanished' }); continue; }
      if (b.value !== a.value) changed.push({ sheet, ref, before: b.value, after: a.value });
      else same.push({ sheet, ref, value: a.value });
      if (b.formula && !a.formula) changed.push({ sheet, ref, to: 'formula-flattened(不应发生)' });
    }
  }
  return { sheetsBefore: Object.keys(before), formulaCellsSeen: formulaCount, changedCells: changed.filter((c) => 'before' in c || 'to' in c).length, changed: changed.slice(0, 50), unchangedWithCache: same.length, note: 'kit 会整簿重存（补样式与维度声明），不是逐格最小改动；比对只看数值与公式在否' };
}

// v2.2.0（任务书-I 计划5）：重算后扫"重算结果"里的逐格公式错误。错误格＝t="e" 或 <v> 是 # 错误串。
// 只报重算**之后**真正算出来的错误（区别于 check 的"陈旧错误缓存"）；不写回、不修公式，修仍归技能侧。
const RECALC_ERR_TYPES = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NULL!', '#NUM!'];
const RECALC_ERR_LIST_CAP = 200;
function recalcErrorMap(file) {
  const map = zipRead(fs.readFileSync(file));
  const errors = []; let totalFormulas = 0;
  for (const [name, data] of map) {
    const m = /^xl\/worksheets\/(.+)\.xml$/.exec(name); if (!m) continue;
    const sheet = m[1];
    for (const c of str(data).matchAll(/<c\s+r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = c[1], attrs = c[2], inner = c[3];
      if (/<f(?:\s[^>]*)?>/.test(inner)) totalFormulas++;
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [, null])[1];
      const isErr = /\st="e"/.test(attrs) || (typeof v === 'string' && /^#[A-Z0-9/?!]+!?$/.test(v.trim()));
      if (isErr) errors.push({ cell: `${sheet}!${ref}`, error: v });
    }
  }
  return { errors, totalFormulas };
}
function buildErrorSummary(file) {
  const { errors, totalFormulas } = recalcErrorMap(file);
  const byType = {};
  for (const e of errors) { const k = RECALC_ERR_TYPES.includes(e.error) ? e.error : (e.error || '(空)'); byType[k] = (byType[k] || 0) + 1; }
  return {
    totalErrorCells: errors.length, byType, totalFormulas,
    list: errors.slice(0, RECALC_ERR_LIST_CAP).map((e) => e.cell),
    listCap: RECALC_ERR_LIST_CAP, truncated: errors.length > RECALC_ERR_LIST_CAP,
    note: 'cell 用「工作表部件名!格」（如 sheet1!A1）；本表只报重算之后算出的错误，不修公式（修归技能侧）',
  };
}

/** v2.5.0：scrub 的 PDF 面——清 /Info 目标键（PDF_META_TARGETS）并摘除 XMP（catalog /Metadata），**写新文件**。
 *  PDF 永不做就地改写；产物写后**重装载**做结构回查（Info 目标键全无 + /Metadata 不在），并叠一层明文令牌扫描
 *  （xpacket 等：仅对未压缩的 XMP 有效，压缩流以结构为准——两把尺都摆在回报里，不互相冒充）。 */
async function scrubPdf(input, buf, positional, flags) {
  const t0 = Date.now();
  const pl = loadPdfLib();
  if (pl.error) die('unavailable', `pdf-lib 不在 node_modules：${pl.error}`, PDFLIB_NEXT);
  const { PDFDocument, PDFName, PDFDict } = pl.lib;
  let doc = null;
  try { doc = await PDFDocument.load(buf, { updateMetadata: false }); }
  catch (e) {
    const msg = String((e && e.message) || e);
    const enc = /encrypt/i.test(msg);
    die(enc ? 'unsupported-format' : 'invalid-document', enc ? `加密 PDF 不在支持面：${input}` : `读不通这份 PDF（${msg.slice(0, 160)}）`, enc ? '先解密再清；装置不绕加密' : '结构读不通（可能损坏）：换来源或先 inspect');
  }
  const probeFields = [];
  const removed = [];
  const infoRef = doc.context.trailerInfo.Info;
  if (infoRef) {
    const info = doc.context.lookup(infoRef);
    if (info instanceof PDFDict) {
      for (const k of PDF_META_TARGETS) { const key = PDFName.of(k); if (info.get(key)) { probeFields.push('Info:' + k); info.delete(key); removed.push('Info:' + k); } }
    }
  }
  const metaRef = doc.catalog.get(PDFName.of('Metadata'));
  const hadXmp = !!metaRef;
  if (hadXmp) {
    probeFields.push('XMP:/Metadata');
    doc.catalog.delete(PDFName.of('Metadata'));
    // 🔴 v2.5.0 实测两坑（首版各踩一个）：① 只摘 catalog 引用不够——pdf-lib 不做可达性回收，未删对象仍被序列化进产物
    //（XMP 原文会整段躺在输出文件里）；② 对 Uint8Array（save 的返回类型）调 toString('latin1') 会走 TypedArray 的 join——
    // 令牌扫描因此恒空。修法：删引用＋删对象，扫描走 Buffer.from。两把尺（结构/字节）互为对照面，M183 钉这层。
    if (metaRef && metaRef.constructor && metaRef.constructor.name === 'PDFRef') doc.context.delete(metaRef);
    removed.push('XMP:/Metadata');
  }
  if (!removed.length) die('invalid-output', '没有可清的元数据字段（/Info 没有目标键，也没有 XMP）', '确认它没被清过；或先 inspect 看元数据形状');
  const output = positional[1] ? abs(positional[1]) : freePath(OUT_DIR, `${path.basename(input, '.' + extOf(input))}-scrubbed`, 'pdf');
  if (positional[1] && fs.existsSync(output)) die('invalid-output', `输出已存在，绝不覆盖：${output}`, '换个输出路径，或省略让装置落 _out 自动去重');
  ensureDir(path.dirname(output));
  let bytesOut = null;
  try { bytesOut = await doc.save({ updateMetadata: false }); }
  catch (e) { die('failed', `保存失败：${String((e && e.message) || e).slice(0, 160)}`, '把本行 JSON 原样回报给调用方，不要重试'); }
  fs.writeFileSync(output, bytesOut);
  let back = null;
  try { back = await PDFDocument.load(fs.readFileSync(output), { updateMetadata: false }); }
  catch (e) { die('failed', `产物回读装载失败（别用这份产物）：${String((e && e.message) || e).slice(0, 140)}`, '把本条当装置缺陷报出来，不要换个输出名重试'); }
  const lat = Buffer.from(bytesOut).toString('latin1');
  const tokens = ['xpacket', 'x:xmpmeta', 'adobe:ns:meta', 'dc:creator'].filter((t) => lat.includes(t));
  const res = {
    ok: true, op: 'scrub', ms: Date.now() - t0, input, output, container: 'pdf',
    bytes: bytesOut.length, sha256: sha256(bytesOut),
    removedFields: removed, probeFields,
    roundTrip: { reloaded: true },
    tokenScan: { tokens, hit: tokens.length },
    note: 'PDF 面：清 /Info 目标键 + 摘除 XMP（/Metadata），写新文件（不改原件、不就地改写）；令牌扫描只覆盖明文残留，压缩流以结构回读为准',
  };
  if (flags.verify) {
    const residual = [];
    const i2 = back.context.trailerInfo.Info ? back.context.lookup(back.context.trailerInfo.Info) : null;
    if (i2 instanceof PDFDict) for (const k of PDF_META_TARGETS) if (i2.get(PDFName.of(k))) residual.push('Info:' + k);
    if (back.catalog.get(PDFName.of('Metadata'))) residual.push('XMP:/Metadata');
    for (const t of tokens) residual.push('token:' + t);
    res.verify = { checked: 'Info 目标键 + XMP 结构引用 + 明文令牌', residual: residual.length, residualFields: residual.slice(0, 20), note: '判据：重装载产物做结构回查（Info 目标键、/Metadata 引用），叠一层明文令牌扫描；漏删会在这里现形' };
  }
  out(res);
}

function cmdScrub(args) {
  const { positional, flags } = parseArgs(args, 'scrub');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'scrub'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  const input = abs(positional[0]); if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const buf = fs.readFileSync(input);
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return scrubPdf(input, buf, positional, flags);   // v2.5.0：PDF 面——仅此分支返回 promise，ZIP 面保持同步（入口兜底照旧）
  if (buf.readUInt32LE(0) !== 0x04034b50) die('unsupported-format', 'scrub 吃 OOXML/ODF 的 ZIP 容器与 PDF（v2.5.0 起）；输入按 magic 判两者都不是', 'OLE 二进制（.doc/.xls/.ppt）先 to 成新族再清；PDF 走本命令的 PDF 面（写新文件、非就地）');
  const map = zipRead(buf);
  // 上面那道守卫测的是"是不是 ZIP"。ODF 也是 ZIP：v1.2.0 之前它会一路穿到"没有可清的字段"那一支，把"本装置不支持"
  // 报成"你的文件没东西可清"。R3-a 起 ODF 是**支持**的一条路（清 meta.xml + 删 Thumbnails），所以这里只挡两族都不是。
  const scrubFam = zipFamily(map);
  const isOOXMLFam = ['docx', 'xlsx', 'pptx'].includes(scrubFam);
  const isODFFam = ['odt', 'ods', 'odp'].includes(scrubFam);
  if (!isOOXMLFam && !isODFFam) die('unsupported-format', `scrub 只支持 OOXML（docx/xlsx/pptx）与 ODF（odt/ods/odp），输入按容器识别为 ${scrubFam || '未知'}——ZIP 里没有任一族的标志部件`, '先 inspect 看容器识别结果（裸 ZIP 与伪装件都在这红）；已生成的 PDF 不许就地改字节');
  // 探针清单与删除清单**分开**：探针固定覆盖全部目标字段，删除若漏掉某个字段，--verify 仍能发现残留
  // （变异台 M3 教训：值清单若从"已删掉的"里取，漏删 = 连要回查的串都不登记 = 自证过度）
  const probeValues = [];
  const removed = [];
  const removedEntries = [];
  const collect = (part, fields) => {
    const d = map.get(part); if (!d) return;
    for (const f of fields) {
      for (const m of str(d).matchAll(new RegExp('<' + f + '(?:\\s[^>]*)?>([^<]*)</' + f + '>', 'g'))) {
        if (m[1].trim()) probeValues.push({ part, field: f, bytes: Buffer.from(m[1].trim(), 'utf8') });
      }
    }
  };
  const cleanPart = (name, re, keep) => {
    const data = map.get(name); if (!data) return;
    const xml = str(data); let hits = 0;
    for (const m of xml.matchAll(re)) { hits++; if (m[2] && m[2].trim()) removed.push(`${name}:${m[1]}`); }
    if (!hits) return;
    map.set(name, Buffer.from(xml.replace(re, keep ?? ''), 'utf8'));
  };
  if (isOOXMLFam) {
    for (const part of ['docProps/core.xml', 'docProps/app.xml']) collect(part, META_PROBE_FIELDS);
    const CORE_RE = /<(dc:creator|dc:title|dc:subject|dc:description|cp:keywords|cp:lastModifiedBy|dc:date|dcterms:created|dcterms:modified|cp:revision)>([\s\S]*?)<\/\1>/g;
    cleanPart('docProps/core.xml', CORE_RE, '');
    cleanPart('docProps/app.xml', /<(Company|Manager|Template|Application|AppVersion|TotalTime|Pages|Words|Characters|Lines|Paragraphs)(>[^<]*<\/\1>)?/g, '');
    cleanPart('docProps/app.xml', /<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/g, '');
  } else {
    // ODF：元数据全在 meta.xml；删除用一张与探针同宽的 alternation 正则，漏一条就等 --verify 抓残留
    collect('meta.xml', ODF_META_FIELDS);
    const ODF_META_RE = new RegExp('<(' + ODF_META_FIELDS.join('|') + ')(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>', 'g');
    cleanPart('meta.xml', ODF_META_RE, '');
    // 🔴 缩略图就是文档第一页的渲染图，属于**版面内容**：LO 写出的 odt/ods/odp 都带它，不删就是把内容跟着外发件一起出去
    for (const t of ODF_THUMBNAIL_PARTS) if (map.has(t)) { map.delete(t); removedEntries.push(t); }
  }
  if (!removed.length && !probeValues.length && !removedEntries.length) die('invalid-output', `没有可清的元数据字段（${isODFFam ? 'meta.xml 里没有目标项，包里也没有缩略图条目' : 'docProps 里没有目标项'}）`, '确认输入的容器族，或它已经被清过');
  // 保序 + 逐条目保 method：OOXML 沿用原包；ODF 必须让 mimetype 待在**首位且 stored**（规范硬要求，见 zipWrite 的注释）
  const methOf = {};
  for (const r of zipList(buf)) methOf[r.name] = r.method;
  const entries = [...map.entries()].map(([name, data]) => ({ name, data, method: methOf[name] === 0 ? 0 : 8 }));
  const output = positional[1] ? abs(positional[1]) : freePath(OUT_DIR, `${path.basename(input, '.' + extOf(input))}-scrubbed`, extOf(input));
  if (positional[1] && fs.existsSync(output)) die('invalid-output', `输出已存在，绝不覆盖：${output}`, '换个输出路径，或省略让装置落 _out 自动去重');
  ensureDir(path.dirname(output));
  fs.writeFileSync(output, zipWrite(entries));
  // 写坏当场抓：回读逐条目对字节（zipRead 内已对每条 CRC 记账），不等到"能打开"当结论
  let back;
  try { back = zipRead(fs.readFileSync(output)); }
  catch (e) { die('invalid-output', `scrub 写出的压缩包回读失败：${e.message}`, '这是装置缺陷（自写容器没过 CRC/字节对账），别用这个产物，把它当回归报出来'); }
  const bytesMatch = back.size === entries.length && entries.every((e) => Buffer.compare(back.get(e.name), e.data) === 0);
  if (!bytesMatch) die('invalid-output', 'scrub 写出的压缩包回读对不上（条目数或字节不一致）', '别用这个产物；把本条当装置缺陷报出来，不要换个输出名重试');
  const first = entries[0] || null;
  const res = {
    ok: true, op: 'scrub', input, output, container: scrubFam, bytes: fs.statSync(output).size, sha256: sha256(fs.readFileSync(output)),
    removedFields: removed, removedEntries, probeFields: probeValues.map((v) => `${v.part}:${v.field}`),
    roundTrip: { entries: entries.length, bytesMatch: true, crcPerEntry: true },
    shape: { firstEntry: first ? first.name : null, firstMethod: first ? (first.method === 0 ? 'stored' : 'deflate') : null, storedEntries: entries.filter((e) => e.method === 0).length },
    note: isODFFam ? 'ODF 面：meta.xml 目标字段清空 + Thumbnails 条目删除，顺序与逐条目 method 沿用原包（mimetype 必须首位 stored）' : 'OOXML 面：docProps 目标字段删除，其余条目逐字节原样回写',
  };
  if (flags.verify) {
    const pdf = freePath(TMP_DIR, `scrubcheck-${stamp()}`, 'pdf');
    const r = runKit(['convert', '--input', output, '--output', pdf, '--timeout-ms', String(DEFAULT_TIMEOUT_MS)]);
    const lat = r.ok ? fs.readFileSync(pdf).toString('latin1') : '';
    const residual = probeValues.filter((v) => lat.includes(v.bytes.toString('latin1')));
    res.verify = {
      converted: r.ok, checkedStrings: probeValues.length, residual: residual.length,
      residualFields: residual.map((v) => `${v.part}:${v.field}`),
      note: '判据：按**固定探针清单**从源文件取非空值（与删除动作无关），逐个在产物 PDF 明文字节（含 XMP）里回查；漏删会在这里现形，不会自证过度',
    };
    try { fs.rmSync(pdf, { force: true }); } catch {}
    if (!r.ok) res.verify.error = r.error;
  }
  out(res);
}
function tesseractLangs(exe, dir) {
  // v1.5.0：语言清单的解析抽成函数，因为"哪个目录"有两个 caller——doctor 要默认/env 目录（描述这台机器），
  // ocr 要**本次真用的那个目录**（描述这一次调用）。此前只有 probe 一份、恒读默认目录，ocr 借它自曝就是说别的目录。
  // R2-1（v1.6.3）：spawnSync 必须带 timeout——`DOCKIT_TESSERACT` 被配成不退出的程序（实测 GUI 的 notepad.exe）时，
  // 旧版在这里无限挂死（>6 min 无任何输出，连 JSON 都没有）。15s 预算与 officecliVersion 的探针口径对齐，
  // 超时走下面的 r.error 失败分支 → langCount:null / available:false，装置照常输出结构化 JSON。
  const r = spawnSync(exe, ['--list-langs', '--tessdata-dir', dir], { encoding: 'utf8', timeout: 15000 });
  const lines = (`${r.stdout}\n${r.stderr}`).split(/\r?\n/).map((x) => x.trim());
  const hi = lines.findIndex((l) => /^List of available languages in .* \(\d+\)/.test(l));
  if (r.error || r.status !== 0 || hi < 0) return { langCount: null, langs: null, langsNote: `--list-langs 在 ${dir} 没读成：${String(r.error || lines.find(Boolean) || '(空输出)').slice(0, 120)}` };
  return { langCount: Number((lines[hi].match(/\((\d+)\)/) || [])[1]), langs: lines.slice(hi + 1).filter((l) => /^[A-Za-z][A-Za-z0-9_]*$/.test(l)) };
}
function tesseractProbe() {
  // v1.4.0（ADR-001）：ocr 的外部依赖探针。tesseract 把 --version/--list-langs 都写 stderr，两路都收。
  if (!fs.existsSync(TESSERACT_EXE)) return { available: false, why: `tesseract.exe 不在位（本次解析：${TESSERACT_EXE}）` };
  const v = spawnSync(TESSERACT_EXE, ['--version'], { encoding: 'utf8', timeout: 15000 }); // R2-1（v1.6.3）：同 tesseractLangs，探针也不许挂死
  if (v.error || v.status !== 0) return { available: false, why: `tesseract --version 调用失败：${String(v.error || v.stderr || v.stdout).slice(0, 160)}` };
  const verLine = (`${v.stdout}\n${v.stderr}`).split(/\r?\n/).map((l) => l.trim()).find((l) => /^tesseract v/i.test(l)) || 'tesseract（版本行未解析）';
  const lg = tesseractLangs(TESSERACT_EXE, TESSDATA_DIR);
  return { available: true, version: verLine, langCount: lg.langCount, langs: lg.langs, langPack: path.basename(TESSDATA_DIR), tessdataDir: TESSDATA_DIR, exe: TESSERACT_EXE };
}
const ocrNextUnavailable = () => `装 Tesseract（UB-Mannheim 构建），或设环境变量：DOCKIT_TESSERACT 指 tesseract.exe（当前解析 ${TESSERACT_EXE}）、DOCKIT_TESSDATA 指 tessdata 目录（当前解析 ${TESSDATA_DIR}）`;
function cmdOcr(args) {
  const { positional, flags } = parseArgs(args, 'ocr');
  const input = abs(positional[0]); if (!input || !fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  if (positional.length > 1) die('invalid-output', 'ocr 只收一个输入', '逐页识别文本落输出文件/目录（自报路径），不收第二个路径');
  const b = fs.readFileSync(input);
  const kind = (b[0] === 0x89 && b.slice(1, 4).toString('latin1') === 'PNG') ? 'png' : b.slice(0, 5).toString('latin1') === '%PDF-' ? 'pdf' : null;
  if (!kind) die('unsupported-format', 'ocr 只吃 PNG（pages 产物）与 PDF（按 magic 判，不看后缀）', '其它格式先 to 转 PDF、pages 出 PNG，再 ocr');
  if (kind === 'png' && flags.pages !== undefined) die('invalid-output', '--pages 只对 PDF 输入有意义（PNG 单图）', '去掉 --pages，或对多页 PDF 用 all／逗号列表');
  const lang = flags.lang || OCR_DEFAULT_LANG;
  const tessdataDir = flags['tessdata-dir'] ? abs(flags['tessdata-dir']) : TESSDATA_DIR;
  const timeoutMs = Number(flags['timeout-ms'] ?? DEFAULT_TIMEOUT_MS);
  const wantPixels = flags.pixels !== 'off';
  const started = Date.now();
  const probe = tesseractProbe();
  if (!probe.available) die('unavailable', probe.why, ocrNextUnavailable());
  const runTess = (img, outBase) => {
    if (Date.now() - started >= timeoutMs) die('timeout', `OCR 超预算（--timeout-ms=${timeoutMs}，已用 ${Date.now() - started}ms）`, nextFor('timeout', {}));
    const tessArgs = [img, outBase, '-l', lang, '--tessdata-dir', tessdataDir];
    if (flags.psm !== undefined) { if (!/^\d+$/.test(String(flags.psm)) || Number(flags.psm) > 13) die('invalid-output', `--psm 要 0–13 的整数，给了 ${flags.psm}`, 'PSM 是 tesseract 的版面模式：3=默认自动（stock），6=单一文本块，7=单行；C3 对照基线全部走默认'); tessArgs.push('--psm', String(flags.psm)); }
    const r = spawnSync(TESSERACT_EXE, tessArgs, { encoding: 'utf8', timeout: Math.max(1000, timeoutMs - (Date.now() - started)) });
    if (r.signal === 'SIGTERM') die('timeout', `单页 OCR 超时被掐（预算 ${timeoutMs}ms）`, nextFor('timeout', {}));
    if (r.error) die('failed', `tesseract 进程调用失败：${String(r.error).slice(0, 160)}`, 'ENOENT 多半是引擎路径/环境变量指错；其它看 error 原文');
    if (r.status !== 0) {
      const err = String(r.stderr || r.stdout).trim();
      if (/Failed loading language|Error opening data file/i.test(err)) die('unsupported-format', `语言包缺失：-l ${lang} 在 ${tessdataDir} 读不到`, '把对应 .traineddata 放进该目录，或 --lang 换已装语言、--tessdata-dir 指向含该语言的目录');
      die('invalid-document', `tesseract 读不了这张图：${err.slice(0, 160)}`, '坏图或非图内容都会在这红；先 inspect 看容器');
    }
  };
  const pageList = [];
  let renderDir = null;
  if (kind === 'png') pageList.push({ label: path.basename(input, path.extname(input)), img: input });
  else {
    renderDir = freeDir(OUT_DIR, `${path.basename(input, path.extname(input))}-ocr-${stamp()}`);
    const kitArgs = ['render', '--input', input, '--output-dir', renderDir];
    if (flags.pages !== undefined) kitArgs.push('--pages', String(flags.pages));
    kitArgs.push('--timeout-ms', String(Math.max(1000, timeoutMs - (Date.now() - started))));
    let r = runKit(kitArgs);
    if (!r.ok && r.code === 'unavailable' && r.dep === 'kit') {
      // kit 缺失：PDF 改走 poppler pdftoppm 降级渲染（与 pages 同一路），再逐页 OCR
      const fb = pagesFromPoppler(input, renderDir, { pages: flags.pages });
      if (fb) r = fb;
    }
    if (!r.ok) { try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch {} die(r.code, r.error, nextFor(r.code, { input, inExt: 'pdf' })); }
    for (const t of r.images || []) pageList.push({ label: `page-${String(t.index).padStart(4, '0')}`, img: t.path });
  }
  const results = pageList.map((p) => {
    const outBase = kind === 'png' ? freePath(OUT_DIR, `${p.label}-ocr`, 'txt') : path.join(renderDir, `ocr-${p.label}`);
    const t0 = Date.now();
    runTess(p.img, outBase);
    const txtPath = `${outBase}.txt`;
    const txt = fs.existsSync(txtPath) ? str(fs.readFileSync(txtPath)) : '';
    const lines = txt.split(/\r?\n/).filter((l) => l.trim() !== '');
    return { label: p.label, file: txtPath, chars: lines.reduce((a, l) => a + l.length, 0), lines: lines.length, pixelEvidence: wantPixels ? (pngDarkRatio(p.img) || { err: 'png-decode-failed' }) : 'off', ms: Date.now() - t0 };
  });
  const eff = tesseractLangs(TESSERACT_EXE, tessdataDir);
  out({ ok: true, op: 'ocr', backend: probe.version, lang, langPack: path.basename(tessdataDir), langCount: eff.langCount, langs: eff.langs, langsNote: eff.langsNote, tessdataDir, tesseractExe: probe.exe, pageCount: results.length, dir: renderDir || undefined, pages: results, ms: Date.now() - started, note: '空结果是数据不是错误（空白页 0 行 0 字属正常）；识别文本只落 txt 文件，不回显进 JSON' });
}
function cmdInspect(args) {
  const { positional, flags } = parseArgs(args, 'inspect');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'inspect'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  const input = abs(positional[0]); if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const buf = fs.readFileSync(input);
  const ext = extOf(input);
  const kind = detectKind(buf, ext);
  const container = kind === 'ooxml-or-odf-zip' ? zipFamily(zipRead(buf)) : null;
  const declared = declaredFromInput(input);
  const meta = [];
  if (container && ['docx', 'xlsx', 'pptx'].includes(container)) {
    const map = zipRead(buf);
    for (const part of ['docProps/core.xml', 'docProps/app.xml']) {
      const d = map.get(part); if (!d) continue;
      for (const f of xmlFields(str(d), /<(dc:creator|dc:title|dc:subject|dc:description|cp:keywords|cp:lastModifiedBy|cp:revision|Company|Manager|Template|Application)(?:\s[^>]*)?>([^<]*)<\/\1>/g)) meta.push({ part, ...f });
    }
  }
  if (container === null && kind === 'pdf') {
    const lat = buf.toString('latin1');
    for (const k of ['Author', 'Title', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
      const m = lat.match(new RegExp('/' + k + '\\s*(\\(|<)([^)>]{0,200})[)>\u0000]', ''));
      meta.push({ part: '/Info', field: k, present: !!m, length: m ? m[2].length : 0, nonblank: !!m && m[2].trim().length > 0 });
    }
    const xmp = [...lat.matchAll(/<(dc:creator|dc:title|dc:description|dc:subject|pdf:Producer|xmp:CreatorTool|xmp:ModifyDate)>/g)].map((m) => m[1]);
    meta.push({ part: 'XMP', field: 'packets', present: lat.includes('xpacket'), length: xmp.length, nonblank: xmp.length > 0, names: [...new Set(xmp)] });
  }
  const fam = familyOf(ext);
  const fonts = installedFontFamilies();
  const declaredCJK = (declared.families || []).filter((f) => CJK_HINT_FAMILIES.includes(f));
  const r = {
    ok: true, op: 'inspect', input, bytes: buf.length, sha256: sha256(buf), extension: ext, kind, container,
    containerVsExtension: container ? (container === ext ? 'match' : `不一致：内容是 ${container}，后缀写的是 ${ext}（kit 按内容判，按后缀挑转换会踩空）`) : '无法用 ZIP 判定（OLE/PDF/文本）',
    convertible: fam ? { family: fam, outputs: FORMAT_MATRIX[fam].outputs } : { family: null, outputs: [] },
    declaredFontFamilies: declared.available ? declared.families : null, declaredWhy: declared.available ? undefined : declared.why,
    cjkDeclared: declaredCJK,
    fontDir: fonts,
    metadataFields: meta,
    metaAdvice: meta.some((m) => m.nonblank) ? '元数据非空：外发或转公开前按《文档操作规范》元数据族处置（scrub 清源，或转换后回查 XMP）' : undefined,
  };
  // 收尾：--deep 起引擎是同步 spawnSync，out 出 JSON。抽成函数，因为 PDF 结构探针是 inspect 唯一异步段
  // （pdf-lib 加载）。只让 PDF 分支返回 promise，ZIP/OLE/文本分支保持同步——这样入口的同步兜底 catch
  // （变异 M16）仍守得住"坏 ZIP 走 inspect 不许吐裸栈"，PDF 探针的拒绝则由入口 .catch(asyncFailPayload) 守。
  const finish = () => {
    if (flags.deep) {
      const pdf = freePath(TMP_DIR, `deep-${stamp()}`, 'pdf');
      const conv = runKit(['convert', '--input', input, '--output', pdf, '--timeout-ms', String(DEFAULT_TIMEOUT_MS)]);
      r.deep = conv.ok ? { backend: conv.backend, missingFonts: conv.missingFonts, pdfBytes: fs.statSync(pdf).size, pdfSha256: sha256(fs.readFileSync(pdf)) } : { code: conv.code, error: conv.error };
      try { fs.rmSync(pdf, { force: true }); } catch {}
    }
    out(r);
  };
  // PDF 结构探针（纯 JS pdf-lib，不起引擎）：页数/逐页版式/旋转/加密/字体嵌入与 CJK/AcroForm；读不通只在 pdf 子块降级，不拖垮 inspect
  if (kind === 'pdf') {
    return pdfStructuralProbe(buf)
      .then((pdf) => { r.pdf = pdf; finish(); })
      .catch((e) => { r.pdf = { backend: 'pdf-lib', degraded: true, code: 'failed', error: String((e && e.message) || e).slice(0, 120) }; finish(); });
  }
  finish();
}

function cmdDump(args) {
  const { positional, flags } = parseArgs(args, 'dump');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'dump'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  const input = abs(positional[0]); if (!input || !fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  if (positional.length > 1) die('invalid-output', `dump 只收一个输入，给了 ${positional.length} 个`, '用法：dump <输入文件> [--part 部件名] [--text]');
  const wantText = flags.text === true;
  const buf = fs.readFileSync(input);
  if (buf.readUInt32LE(0) !== 0x04034b50) die('unsupported-format', 'dump 只吃 ZIP 系容器（docx/xlsx/pptx/odt/ods/odp），全程不起引擎；输入按 magic 判不是 ZIP', 'OLE 二进制（.doc/.xls/.ppt）没有部件清单可 dump——先 to 成 OOXML 再 dump');
  let list;
  try { list = zipList(buf); }
  catch (e) { die('invalid-document', `ZIP 中央目录读不通：${e.message}`, '中央目录坏掉的包没法 dump 形状：别外发，从来源重取'); }
  let map;
  try { map = zipRead(buf); }
  catch (e) { die('invalid-document', `ZIP 读不通：${e.message}`, '条目 CRC 不匹配、压缩流被改过 ⇒ 输入文件坏了：别外发、别当已核验（这一层与 check 共用装置的逐条实算）'); }
  const container = zipFamily(map);
  if (!container) die('invalid-document', 'ZIP 里找不到 OOXML/ODF 的标志部件，认不出容器', '先 inspect 看容器识别结果');
  const onlyPart = flags.part === undefined ? null : String(flags.part);
  if (onlyPart !== null && !map.has(onlyPart)) {
    const cand = nearestCandidates(onlyPart, [...map.keys()]);
    die('invalid-output', `没有这个部件：${onlyPart}`, `最接近的部件：${cand.join(' | ') || '(无)'}；本包共 ${map.size} 个部件（不带 --part 跑一次就看清单）`, { candidates: cand });
  }
  const META_PARTS = ['docProps/core.xml', 'docProps/app.xml', 'meta.xml'];
  const TEXT_PART_RE = { docx: /^word\/(document|header\d*|footer\d*)\.xml$/, xlsx: /^xl\/sharedStrings\.xml$/, pptx: /^ppt\/slides\/slide\d+\.xml$/, odt: /^content\.xml$/, ods: /^content\.xml$/, odp: /^content\.xml$/ }[container];
  const TEXT_INNER = { docx: /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, xlsx: /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, pptx: /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, odt: /<text:(p|h)(?:\s[^>]*)?>([\s\S]*?)<\/text:\1>/g, ods: /<text:p(?:\s[^>]*)?>([\s\S]*?)<\/text:p>/g, odp: /<text:p(?:\s[^>]*)?>([\s\S]*?)<\/text:p>/g }[container];
  const parts = [], shapes = [];
  let truncated = false;
  for (const r of list) {
    if (onlyPart && r.name !== onlyPart) continue;
    parts.push({ order: r.order, name: r.name, method: r.methodLabel, bytes: r.bytes, compBytes: r.compBytes, crc: r.crc });
    if (!/\.xml$/i.test(r.name)) continue;
    const data = map.get(r.name); if (!data) continue;
    if (data.length > DUMP_SCAN_MAX_BYTES) { shapes.push({ part: r.name, skipped: `未扫：解压后 ${data.length} B 超过 ${DUMP_SCAN_MAX_BYTES} B 上限` }); truncated = true; continue; }
    const xml = str(data);
    const tags = new Map(), attrs = new Map();
    for (const m of xml.matchAll(/<([A-Za-z_][\w.:-]*)(?=[\s/>])/g)) tags.set(m[1], (tags.get(m[1]) || 0) + 1);
    for (const m of xml.matchAll(/<([A-Za-z_][\w.:-]*)\b([^>]*)>/g)) {
      if (m[2].endsWith('/')) { /* 自闭合也算属性 */ }
      for (const a of m[2].matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"/g)) attrs.set(a[1], (attrs.get(a[1]) || 0) + 1);
    }
    const top = (mp) => { const e = [...mp.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)); if (e.length > DUMP_SHAPE_CAP) truncated = true; return e.slice(0, DUMP_SHAPE_CAP).map(([k, v]) => k + '=' + v); };
    shapes.push({ part: r.name, isMetaPart: META_PARTS.includes(r.name), elementKinds: tags.size, elementTop: top(tags), attributeKinds: attrs.size, attributeTop: top(attrs) });
  }
  const entries = [];
  let textTruncated = false;
  if (wantText) {
    for (const r of list) {
      if (onlyPart && r.name !== onlyPart) continue;
      // 元数据部件不需要在这里再排除一次：上面的 TEXT_PART_RE 本来就不含 docProps/* 与 meta.xml，两条路不相交。
      if (!TEXT_PART_RE.test(r.name)) continue;
      const xml = str(map.get(r.name));
      TEXT_INNER.lastIndex = 0;
      for (const m of xml.matchAll(new RegExp(TEXT_INNER.source, 'g'))) {
        const t = m[container === 'odt' || container === 'ods' || container === 'odp' ? 2 : 1].replace(/<[^>]*>/g, '');
        if (!t.trim()) continue;
        if (entries.length >= DUMP_TEXT_MAX_ITEMS) { textTruncated = true; break; }
        entries.push({ part: r.name, text: xmlUnesc(t) });
      }
    }
  }
  const warnings = [];
  if (wantText) warnings.push('本次带 --text：产物里就是文档正文，**它不是外发件**——别贴进回报、别放进交付目录、别上传（《文档操作规范》§1.2 禁令 1）');
  warnings.push('元数据部件（docProps/core.xml、docProps/app.xml、meta.xml）**不在正文抽取的部件白名单里**，所以即使 --text 也只给形状；要看字段值请自己解包');
  if (container !== 'docx') warnings.push(`正文抽取路线按容器=${container} 的部件与标签来；本装置没覆盖的正文位置（如批注、页眉脚以外的件）不会出现在 entries 里`);
  out({
    ok: true, op: 'dump', engine: false, input, bytes: buf.length, sha256: sha256(buf), container,
    partCount: list.length, partsShown: parts.length, parts, shapes,
    text: { requested: wantText, items: entries.length, ...(wantText ? { entries } : {}), ...(textTruncated ? { truncated: true, cap: DUMP_TEXT_MAX_ITEMS } : {}) },
    truncated,
    caps: { shapeCap: DUMP_SHAPE_CAP, scanMaxBytes: DUMP_SCAN_MAX_BYTES, textMaxItems: DUMP_TEXT_MAX_ITEMS },
    warnings,
    note: '默认只出形状（部件清单 + 元素/属性计数与名字）——这是一份**可以安全贴进回报**的包体结构自述；正文必须显式 --text 才给',
  });
}

/** verify（R4-a／任务书 P2-1）：同源两条取字路线对账。A=文本层（kit 直转 txt），B=渲染层（pages 出 PNG → Tesseract）。
 *  它回答的是"渲染出来的这页**读不读得出**文档里写着的东西"——像素证据只证明有墨，这条证明字形。
 *  🔴 默认只出**计数与行号**，字符串本身要显式 --show 才给（承重 2/3：体检类命令不回显正文）。 */
/** factcheck（R4-b／任务书 P5-1）：核**文档里写死的时点事实**。
 *  起因就是本轮反复踩到的两件事：① `rev-list --left-right --count` 的左右列被写反（左＝在 origin 那边＝落后）；
 *  ② 文档里的条数/文件数/提交号都是**时点数**，复述一次就可能错一次。这条命令不"读文档的意思"，
 *  只做三件机械事：取现场真值 → 从文档里抠出可核对的断言 → 逐条判 对 / 错 / 口径不唯一 / 无从核对。 */
function cmdFactcheck(args) {
  const { positional, flags } = parseArgs(args, 'factcheck');
  const repo = abs(flags.repo || positional[0] || ROOT);
  if (!fs.existsSync(path.join(repo, '.git'))) die('invalid-document', `不是一棵 git 工作树：${repo}`, 'factcheck 的现值全从 git 取；--repo 给仓库根，或先 cd 进去');
  const git = (a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  const live = {};
  // 上游引用名探测：不传 --upstream 时按 origin/<当前分支> → origin/main → origin/master 顺序取第一个在 remote 上的，
  // 全都不在（如全新孤儿仓、尚未 push）时报 unverifiable 而不是红——"没远端"是机器事实，不是语义错误。
  let upstream = flags.upstream || null;
  if (!upstream) {
    const heads = git(['ls-remote', '--heads', 'origin']);
    const curBranch = (() => { const b = git(['rev-parse', '--abbrev-ref', 'HEAD']); return b.status === 0 ? String(b.stdout).trim() : ''; })();
    const wanted = [curBranch && 'origin/' + curBranch, 'origin/main', 'origin/master'].filter(Boolean);
    const have = new Set(String(heads.stdout || '').split('\n').filter(Boolean).map((l) => (l.split('\t')[1] || '').replace(/^refs\/heads\//, '')));
    upstream = wanted.find((w) => have.has(w.replace(/^origin\//, ''))) || (heads.status === 0 && have.size ? 'origin/' + [...have][0] : null);
    if (!upstream) live.upstreamMissing = true;
  }
  const rl = upstream ? git(['rev-list', '--left-right', '--count', upstream + '...' + (flags.head || 'HEAD')]) : { status: 128, stderr: 'no upstream' };
  if (rl.status === 0) {
    const m = String(rl.stdout).trim().split(/\s+/).map(Number);
    // 🔴 语义钉死：--left-right 的**左列是"只在左侧（upstream）有的提交"＝本地落后**，右列才是本地领先。
    live.upstream = upstream;
    live.revListRaw = String(rl.stdout).trim().replace(/\t/g, '  ');
    live.behind = m[0]; live.ahead = m[1];
    // 🔴 单向 range 各测一次，作为"列没被互换"的**第二把独立尺**：`A..B`＝只在 HEAD 侧＝领先，`B..A`＝只在 upstream 侧＝落后。
    // 只拿 --left-right 那一行自证是假牙——两列相等时（本轮实测过 `0 0`）把左右互换，raw 上什么都看不出来。
    const ahR = upstream ? git(['rev-list', '--count', upstream + '..' + (flags.head || 'HEAD')]) : { status: 128 };
    const bhR = upstream ? git(['rev-list', '--count', (flags.head || 'HEAD') + '..' + upstream]) : { status: 128 };
    live.aheadViaRange = ahR.status === 0 ? Number(String(ahR.stdout).trim()) : null;
    live.behindViaRange = bhR.status === 0 ? Number(String(bhR.stdout).trim()) : null;
    live.columnMeaning = 'rev-list --left-right --count A...B ⇒ 左列＝只在 A(upstream) 有的提交＝本地落后；右列＝只在 B(HEAD) 有的提交＝本地领先';
  } else {
    // 上游缺失（全新孤儿仓）：列义说明仍要给——它是命令语义的钉子，与有没有远端无关。
    live.columnMeaning = 'rev-list --left-right --count A...B ⇒ 左列＝只在 A(upstream) 有的提交＝本地落后；右列＝只在 B(HEAD) 有的提交＝本地领先';
    live.revListError = `git rev-list 退码 ${rl.status}：${String(rl.stderr).trim().slice(0, 120)}`;
    live.behind = null; live.ahead = null;
  }
  const st = git(['status', '--porcelain']);
  live.dirtyFiles = st.status === 0 ? String(st.stdout).split(/\r?\n/).filter((x) => x.trim() !== '').length : null;
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  live.untrackedFiles = untracked.status === 0 ? String(untracked.stdout).split(/\r?\n/).filter((x) => x.trim() !== '').length : null;
  const head = git(['rev-parse', '--short', 'HEAD']);
  live.head = head.status === 0 ? String(head.stdout).trim() : null;

  // 时点事实的**探针登记**：文档里能写成"某名 = 某数"的量都住在这张表里，新增一类就加一行（不许在散文里发明口径）
  const dk = (a) => spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', cwd: repo });
  const docPath = (rel) => (path.isAbsolute(rel) ? rel : path.join(repo, rel));   // --doc 允许绝对路径（判据的夹具写在自检目录里）
  const srcOf = (rel) => { try { return fs.readFileSync(docPath(rel), 'utf8'); } catch { return ''; } };
  const hasDevice = fs.existsSync(path.join(repo, 'dockit.js'));   // 去别的仓核查时，装置自身的条数类现值不适用——不适用＝不给探针，不是给 0（给 0 会把别人的文档全判错）
  const dockitSrc = hasDevice ? srcOf('dockit.js') : '';
  const probes = {
    '判据条数': hasDevice ? (dockitSrc.match(/^[ \t]*(?:await[ \t]+)?(?:ta|t)\(\s*'[^']+'/gm) || []).length : null,
    '变异例数': hasDevice ? (srcOf('test/mutant.js').match(/\{ id: '(M\d+)'/g) || []).length : null,
    '未提交文件数': live.dirtyFiles,
    '孤儿文件数': live.untrackedFiles,
    '落后提交数': live.behind,
    '领先提交数': live.ahead,
    '工作树干净': live.dirtyFiles,
  };
  const targets = (flags.doc ? String(flags.doc).split(',') : ['迭代日志.md', '项目总览.md', 'README.md', '给其它agent-调用卡.md']).filter((rel) => fs.existsSync(docPath(rel)));
  // v2.6.0：--refs 才跑行号引用体检。默认不开是有原因的——历史日志里成片的旧引用属**数据**，一开就把每写一条历史都判红；
  // 开了以后它们走与条数同一支豁免（迭代日志里不判错），其余文档真判。
  const refsOn = flags.refs === true;
  const findings = [];
  let claims = 0;
  for (const rel of targets) {
    const txt = srcOf(rel);
    txt.split(/\r?\n/).forEach((line, idx) => {
      const where = `${rel}:${idx + 1}`;
      const note = (t) => String(t).replace(/\s+/g, ' ').slice(0, 80);
      // ① rev-list 左右列语义：谁要说"左列＝领先"就是写反
      if (/左列[^。｜|]{0,6}(领先|在前)/.test(line)) { claims++; findings.push({ kind: 'rev-list 列义', where, verdict: 'mismatch', claim: note(line), truth: live.columnMeaning }); }
      else if (/左列[^。｜|]{0,6}落后/.test(line)) { claims++; findings.push({ kind: 'rev-list 列义', where, verdict: 'ok', claim: note(line) }); }
      // ② 现测读数 `a\tb` 或 `a b` 紧跟 rev-list 提及：核对是否被当成 "落后=第一个数"
      const pair = line.match(/rev-list[^0-9]{0,40}(\d+)[\s、,／/]{1,3}(\d+)/i) || line.match(/(\d+)[\s]{1,2}(\d+)\s*(?:个?\s*(?:领先|落后))/i);
      if (pair && /rev-list|领先|落后/.test(line)) {
        claims++;
        const a = Number(pair[1]), b = Number(pair[2]);
        // 句子里若把"领先/落后"直接贴着某个数，就按贴法核对；左列＝落后、右列＝领先
        const leadNum = (line.match(/领先[^0-9\n]{0,3}(\d+)/) || [])[1];
        const behindNum = (line.match(/落后[^0-9\n]{0,3}(\d+)/) || [])[1];
        const wrong = (leadNum !== undefined && Number(leadNum) === a && b !== a) || (behindNum !== undefined && Number(behindNum) === b && a !== b);
        findings.push({ kind: 'rev-list 读数顺序', where, verdict: wrong ? 'mismatch' : (leadNum === undefined && behindNum === undefined ? 'ambiguous' : 'ok'), claim: note(line), live: [live.behind, live.ahead], pair: [a, b], note: wrong ? '句子里"领先/落后"配到了反方向的列' : (leadNum === undefined && behindNum === undefined ? '只给了两个数没给列名 ⇒ 口径不唯一，建议照 "落后 X ｜ 领先 Y" 重写' : '列名与数字对得上') });
      }
      // ③ 条数/例数/计数类："名字 = 数字" 或 "数字 + 个名字"
      for (const [name, val] of Object.entries(probes)) {
        if (val === null || val === undefined) continue;
        const eq = line.match(new RegExp(name + '[^0-9\\n]{0,12}(\\d{1,5})'));
        if (eq) {
          claims++;
          const v = Number(eq[1]);
          findings.push({ kind: '时点计数', where, name, claimed: v, live: val, verdict: v === val ? 'ok' : 'mismatch', claim: note(line) });
        }
      }
      // ④ 否定式断言现场跑一次：说"没有/为 0/未纳入"某物，就真去数一遍
      const neg = line.match(/(没有|不存在|为\s*0|零个|未纳入|命中\s*0)[^。；]{0,24}(孤儿文件|未跟踪文件|未提交文件|entry-points[^。；]{0,8}null|判据)/);
      if (neg) {
        claims++;
        const what = neg[2];
        const got = /孤儿/.test(what) ? live.untrackedFiles : /未跟踪/.test(what) ? live.untrackedFiles : /未提交/.test(what) ? live.dirtyFiles : null;
        findings.push({ kind: '否定式断言', where, verdict: got === null ? 'unverifiable' : (got === 0 ? 'ok' : 'mismatch'), claim: note(line), live: got, note: got === null ? '这一类没有登记现场探针，不许当已核过' : '现场数了一遍' });
      }
      // ⑥ 行号引用体检（v2.6.0，--refs 才跑）：`文件:行` 这种引用会因插行被**静默推漂**（只有落到空行/越界的那类才会红），
      //    所以本面能给的是三件确定事实——文件在不在、行号在不在界内、那一行现在是什么（lineText 给人眼对）。
      //    🔴 装置不宣称"引用都还指着原来那段话"：语义漂移这一面判不了，如实写在 note 里。
      if (refsOn) {
        const refRe = /([\w./\\-]+\.(?:md|js|json|txt|csv|bat|py|ps1|ts|tsx))[:：](\d{1,6})(?:\s*[-–]\s*(\d{1,6}))?/g;
        for (const m of line.matchAll(refRe)) {
          claims++;
          const rel2 = m[1].replace(/^[`'"]+|[`'",（(]+/g, '');
          const cand = [path.join(path.dirname(docPath(rel)), rel2), docPath(rel2)];
          const p2 = cand.find((x) => fs.existsSync(x));
          const want1 = Number(m[2]); const want2 = m[3] ? Number(m[3]) : null;
          if (!p2) { findings.push({ kind: '行号引用', where, verdict: 'unverifiable', claim: note(line), ref: m[1] + ':' + m[2], note: '点名的文件既不在该文档同目录也不在仓库根——引用要么写错了，要么指的就是别的仓的文件' }); continue; }
          const txt2 = p2 ? fs.readFileSync(p2, 'utf8') : '';
          const lines2 = txt2.split('\n');
          const nl2 = (txt2.match(/\n/g) || []).length;
          const over = want1 > nl2 || (want2 !== null && want2 > nl2);
          const lo = Math.max(1, want1);
          const text = String(lines2[lo - 1] || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          findings.push({
            kind: '行号引用', where, verdict: over ? 'mismatch' : 'ok', claimed: want2 === null ? want1 : want1 + '-' + want2,
            lineCount: nl2, ref: path.relative(repo, p2).replace(/\\/g, '/'), lineText: text, claim: note(line),
            note: over ? `行号越界（该文件现在 ${nl2} 行）：这条引用一定指错了` : '界内；**这一行现在的内容见 lineText**——越界能判、被插行推漂但仍在界内判不了，要人对一眼',
          });
        }
      }
      // ⑤ 行数口径："N 行" 紧跟文件名时，把两种口径都算出来
      const ln = line.match(/([\w./\\-]+\.(?:js|md|json|txt))[^0-9\n]{0,8}(\d{1,6})\s*行/);
      if (ln) {
        claims++;
        const rel2 = ln[1].replace(/^[`'"]+|[`'"],$/g, '');
        // 先在**这份文档自己的目录**里找，再按仓库根找（判据的夹具文档写在自检目录里，引用的是同目录的文件名）
        const cand = [path.join(path.dirname(docPath(rel)), rel2), docPath(rel2)];
        const p = cand.find((x) => fs.existsSync(x)) || cand[1];
        if (!fs.existsSync(p)) findings.push({ kind: '行数口径', where, verdict: 'unverifiable', claim: note(line), note: '点名的文件找不到（既不在该文档同目录也不在仓库根）：' + rel2 });
        else {
          const b = fs.readFileSync(p);
          const nl = (b.toString('utf8').match(/\n/g) || []).length;
          const editor = nl + (b.length && b[b.length - 1] !== 0x0a ? 1 : 0);
          const want = Number(ln[2]);
          findings.push({ kind: '行数口径', where, verdict: want === nl && want === editor ? 'ok' : (want === nl || want === editor ? 'ambiguous' : 'mismatch'), claimed: want, wcLineCount: nl, editorLineCount: editor, claim: note(line), note: want === nl && want === editor ? '两口径同一值' : '两种口径不同（' + nl + ' vs ' + editor + '），要写明是哪个' });
        }
      }
    });
  }
  // 🔴 与 `doc 卫生` 同一把尺：《迭代日志》是**时点记录**，必须能原样引用旧数字（条数、行数与行号引用一类不参与判错）。
  //    这条豁免不是新发明——v1.1.3 立"条数断言"时先被自己的日志条目判红、v1.1.4 改成豁免后又踩第二次，
  //    最后定成"断言用机器形状、引用用散文"。语义类（rev-list 左列＝落后）不豁免：写反了在哪儿都是错的。
  for (const f of findings) {
    if (!/迭代日志/.test(String(f.where))) continue;
    if (f.kind !== '时点计数' && f.kind !== '行数口径' && f.kind !== '行号引用') continue;
    if (f.verdict === 'mismatch' || f.verdict === 'ambiguous') f.verdict = 'historical';
  }
  const bad = findings.filter((f) => f.verdict === 'mismatch');
  const hist = findings.filter((f) => f.verdict === 'historical');
  const amb = findings.filter((f) => f.verdict === 'ambiguous' || f.verdict === 'unverifiable');
  const strict = flags.strict === true;
  const refsF = findings.filter((f) => f.kind === '行号引用');
  out({
    ok: strict ? bad.length === 0 : true, op: 'factcheck', repo, strict, live,
    refs: { on: refsOn, 命中: refsF.length, 越界判错: refsF.filter((x) => x.verdict === 'mismatch').length, 文件不在: refsF.filter((x) => x.verdict === 'unverifiable').length, 界内待人眼对: refsF.filter((x) => x.verdict === 'ok').length },
    文档面: targets, 核对数: claims, 判错: bad.length, 口径不唯一或无从核对: amb.length, 历史时点记录豁免数: hist.length,
    findings,
    clean: claims > 0 && bad.length === 0 && amb.length === 0,
    cleanMeaning: 'clean=true 需要"抠出了断言、且没有一条判错、也没有一条口径不唯一"；抠不到断言不算通过',
    warnings: [
      '时点事实天然会漂：这条命令只在**跑的那一刻**有效，复述它的读数要连同日期与 HEAD 一起写',
      '本命令只回引用每处断言的前 80 字（文档面），不把正文整段读进上下文',
      refsOn ? '--refs 开着：行号引用只判"文件在不在、行号越不越界"，被插行推漂但仍界内的这一面判不了（每条带 lineText 前 60 字给人眼对）' : '没开 --refs：`文件:行` 这类引用不做体检（要查就显式开；历史日志里的旧引用走与条数同一支豁免）',
      live.revListError ? 'rev-list 取不到现值：' + live.revListError : null,
    ].filter(Boolean),
  });
}

function cmdVerify(args) {
  const { positional, flags } = parseArgs(args, 'verify');
  const input = abs(positional[0]); if (!input || !fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  if (positional.length > 1) die('invalid-output', `verify 只收一个输入，给了 ${positional.length} 个`, '用法：verify <输入文件> [--pages all|1,3] [--lang eng] [--show]');
  const buf = fs.readFileSync(input);
  const ext = extOf(input);
  const isPdf = buf.slice(0, 5).toString('latin1') === '%PDF-';
  const fam = familyOf(ext);
  if (!fam && !isPdf) die('unsupported-format', `verify 吃不进 .${ext}：它要么走文本层直提（FORMAT_MATRIX 的九个输入扩展名），要么走渲染层`, 'PDF 走 poppler 文本层＋渲染半条；OLE 与 ODF 之外的格式先 to 成受支持族');
  // PDF 文本层走 poppler pdftotext（v2.2.0）；在位才开双条，缺工具退回 render-only。OOXML 文本层走 kit。
  const pdfTextPt = isPdf ? popplerTool('pdftotext') : null;
  let mode = fam ? 'both' : (isPdf && pdfTextPt.present ? 'both' : 'render-only');
  const lang = flags.lang || OCR_DEFAULT_LANG;
  const tessdataDir = flags['tessdata-dir'] ? abs(flags['tessdata-dir']) : TESSDATA_DIR;
  const timeoutMs = Number(flags['timeout-ms'] ?? DEFAULT_TIMEOUT_MS);
  const show = flags.show === true;
  const started = Date.now();
  const norm = (t) => String(t).replace(/^\uFEFF/, '').replace(/[\s\u3000]+/g, '').replace(/[\u2018\u2019\u201c\u201d]/g, '').toLowerCase();
  // 🔴 分行必须同时吃 CR 与 LF 并剥 BOM：kit 的 txt 实测用**裸 CR** 分隔段落（"...12345\rBRAVO..."）且开头带 U+FEFF，
  //    只按 \n 切会把整本并成一行——正向夹具当场抓到（aLines 报 1 而不是 3）。
  const linesOf = (t) => String(t).replace(/^\uFEFF/, '').split(/[\r\n\u2028\u2029]/).map((x) => x.trim()).filter((x) => x !== '');

  // A 路线：文本层直提。OOXML 走 kit convert→txt；PDF 走 poppler pdftotext（v2.2.0）。
  let aLines = [];
  let aNote = null;
  const txtPath = freePath(TMP_DIR, `verify-txt-${stamp()}`, 'txt');
  if (mode === 'both' && fam) {
    const a = runKit(['convert', '--input', input, '--output', txtPath, '--timeout-ms', String(timeoutMs)]);
    if (!a.ok) { try { fs.rmSync(txtPath, { force: true }); } catch {} die(a.code, `verify 的文本层路线失败：${a.error}`, nextFor(a.code, { input, fam, inExt: ext })); }
    aLines = linesOf(str(fs.readFileSync(txtPath)));
  } else if (mode === 'both' && isPdf) {
    // PDF：按 --pages 展开区间，离散页多次抽取后拼接（pdftotext 只吃单段 -f/-l）
    const ranges = verifyPagesToRanges(flags.pages);
    if (ranges === null) { try { fs.rmSync(txtPath, { force: true }); } catch {} die('invalid-output', `PDF 文本层只支持 --pages all|N|N-M|N,M，给了 ${JSON.stringify(flags.pages)}`, '改用受支持的页规格'); }
    const tmpP = freePath(TMP_DIR, `verify-p-${stamp()}`, 'txt');
    let combined = '';
    for (const [f, l] of ranges) {
      const pa = ['-enc', 'UTF-8'];
      if (f !== null) pa.push('-f', String(f));
      if (l !== null) pa.push('-l', String(l));
      pa.push(input, tmpP);
      const ar = spawnSync(pdfTextPt.exe, pa, { encoding: 'utf8', timeout: timeoutMs });
      if (ar.signal === 'SIGTERM') { try { fs.rmSync(tmpP, { force: true }); } catch {} die('timeout', `pdftotext 超预算（--timeout-ms=${timeoutMs}）`, nextFor('timeout', {})); }
      if (ar.status !== 0) {
        const err = String(ar.stderr || ar.stdout).trim();
        try { fs.rmSync(tmpP, { force: true }); } catch {}
        if (/password|encrypt/i.test(err)) die('unsupported-format', `PDF 加密，pdftotext 读不了：${err.slice(0, 100)}`, '先解密；装置不绕加密');
        die('invalid-document', `verify 的 PDF 文本层路线失败：${err.slice(0, 140)}`, '先 inspect 看容器');
      }
      if (fs.existsSync(tmpP)) { combined += str(fs.readFileSync(tmpP)); try { fs.rmSync(tmpP, { force: true }); } catch {} }
    }
    fs.writeFileSync(txtPath, combined);
    aLines = linesOf(combined);
    // 扫描件：PDF 文本层为空 ⇒ 退回 render-only 并自报（不能把空文本当"验过了"）
    if (aLines.length === 0) {
      mode = 'render-only';
      aNote = 'PDF 文本层为空（扫描件/纯图片）⇒ 退回 render-only：本条只跑渲染半条，不能据此宣称文本层已验';
    }
  } else if (isPdf) {
    aNote = 'pdftotext 不在位 ⇒ PDF 取不到文本层，本条只跑渲染半条（unavailable 降级；不许据此宣称任意 PDF 可验）';
  } else {
    aNote = '没有文本层可比对，本条只跑渲染半条（**不许据此宣称任意 PDF 可验**）';
  }

  // B 路线：渲染 PNG → Tesseract 逐页
  const dir = freeDir(TMP_DIR, `verify-pages-${stamp()}`);
  const kitArgs = ['render', '--input', input, '--output-dir', dir];
  if (flags.pages !== undefined) kitArgs.push('--pages', String(flags.pages));
  const probe = tesseractProbe();
  if (!probe.available) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} die('unavailable', probe.why, ocrNextUnavailable()); }
  const rr = runKit([...kitArgs, '--timeout-ms', String(Math.max(1000, timeoutMs - (Date.now() - started)))]);
  if (!rr.ok) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} die(rr.code, `verify 的渲染路线失败：${rr.error}`, nextFor(rr.code, { input, fam, inExt: ext })); }
  const aBlob = aLines.map(norm).filter(Boolean);
  const joinedList = [];   // 每页 OCR 文本的归一合并串，只做内部包含判定，绝不进输出（承重 2/3）
  const pages = (rr.images || []).map((t) => {
    const base = path.join(dir, `ocr-${String(t.index).padStart(4, '0')}`);
    const tessArgs = [t.path, base, '-l', lang, '--tessdata-dir', tessdataDir];
    if (flags.psm !== undefined) tessArgs.push('--psm', String(flags.psm));
    const tr = spawnSync(TESSERACT_EXE, tessArgs, { encoding: 'utf8', timeout: Math.max(1000, timeoutMs - (Date.now() - started)) });
    if (tr.error || tr.status !== 0) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} die('failed', `第 ${t.index} 页 OCR 失败：${String(tr.error || tr.stderr || tr.stdout).slice(0, 200)}`, '语言包缺失时 tesseract 自己会报错：换 --lang 或 --tessdata-dir 指到含该语言的目录'); }
    const txt = fs.existsSync(`${base}.txt`) ? str(fs.readFileSync(`${base}.txt`)) : '';
    const bLines = linesOf(txt);
    const bNorm = bLines.map(norm).filter(Boolean);
    const joined = bNorm.join('');
    const matchedInA = bNorm.filter((x) => (mode === 'both' ? aBlob.some((y) => y.includes(x)) : true));
    const px = pngDarkRatio(t.path);
    joinedList.push(joined);
    return { page: t.page ?? t.index, image: path.basename(t.path), ocrLines: bNorm.length, ocrChars: bNorm.reduce((n, x) => n + x.length, 0), matchedInA: matchedInA.length, phantom: bNorm.length - matchedInA.length, ...(show ? { phantomLines: bLines.filter((x, ii) => !matchedInA.includes(bNorm[ii])) } : {}), darkRatio: px ? px.ratio : null };
  });
  try { fs.rmSync(txtPath, { force: true }); } catch {}

  // 只在 A 出现的行（丢字／豆腐块／渲染层读不出的那一路）
  const bAll = joinedList.join('');   // 归一后拼接：空白与大小写差异不参与比较
  // 贪心子序列比例：把 A 的一行按顺序往 B 的整篇里贴，贴上的字数 / 该行字数。对"OCR 把一段拆成几行"不敏感，
  // 只对"这个字没出现"与"顺序不对"敏感 ⇒ 缺字/豆腐块/字形替换会掉比例，换行切分不会。
  const subseqRatio = (needle, hay) => {
    if (!needle.length) return 1;
    let i = 0;
    for (let k = 0; k < hay.length && i < needle.length; k++) if (hay[k] === needle[i]) i++;
    return +(i / needle.length).toFixed(5);
  };
  const missingIdx = []; const missingRatio = []; const aNonEmpty = aLines.map(norm).filter(Boolean);
  aLines.forEach((l, i) => {
    const n = norm(l); if (!n) return;
    const r = subseqRatio(n, bAll);
    if (r < 1) { missingIdx.push(i + 1); missingRatio.push(r); }
  });
  const aTotal = aNonEmpty.length;
  const coverage = mode === 'both' ? (aTotal ? +((aTotal - missingIdx.length) / aTotal).toFixed(5) : 1) : null;
  const ratioAvg = aTotal ? +(missingRatio.reduce((a, x) => a + x, 0) + (aTotal - missingRatio.length)).toFixed(5) / aTotal : null;
  const phantomTotal = pages.reduce((n, p) => n + p.phantom, 0);
  out({
    ok: true, op: 'verify', mode, engine: true, input, bytes: buf.length, sha256: sha256(buf), extension: ext, isPdf,
    textRoute: mode === 'both' ? (fam ? 'to txt（kit 文本层直提）' : 'pdftotext（poppler 文本层直提）') : (isPdf ? 'unavailable（pdftotext 不在位或文本层为空）' : 'unavailable（无文本层路线）'),
    renderRoute: `pages → tesseract（${probe.version} / lang=${lang} / tessdataDir=${tessdataDir}）`,
    pageRoute: { pageCount: pages.length, dir },
    aLines: aTotal, bLines: pages.reduce((n, p) => n + p.ocrLines, 0),
    coverage, ratioAvg, metric: 'A 侧每行按贪心子序列往 B 全文里贴，ratio<1 记一行未全出（对换行切分不敏感，只对缺字与顺序敏感）',
    missingInB: { count: mode === 'both' ? missingIdx.length : null, lineIndexes: missingIdx.slice(0, 40), ratios: missingRatio.slice(0, 40), ...(show ? { lines: missingIdx.map((i) => aLines[i - 1]) } : {}) },
    phantomInB: { count: phantomTotal, note: 'OCR 读出来但文本层没有的行（幻影/识别噪声）；mode=render-only 时无对照，全部记 0' },
    pages,
    clean: mode === 'both' ? (missingIdx.length === 0 && phantomTotal === 0) : null,
    cleanMeaning: mode === 'both' ? 'clean=true 需要"文本层每一行都在渲染层读出来"且"渲染层没有多余行"' : 'render-only 没有可比对的另一条路线 ⇒ clean=null，不许当"验过了"',
    ...(aNote ? { note: aNote } : {}),
    ms: Date.now() - started,
    caveat: 'OCR 有自身错误率（本机基线见 OCR选型报告-2026-10-04.md：正文页 precision 0.9850），所以 missingInB/phantomInB 非零**先怀疑两处**：① 字形（缺字/豆腐块/语言包不对），② 识别噪声。要分清就同一页改 --psm 或换 --lang 复跑，别直接判文档坏了',
  });
}

/** v2.6.0：check 的 PDF 分支——把 pdfRiskScan 的结构扫描套上 --kind 过滤、族适用面与清单封顶，报告形状与 ZIP 面同构。
 *  命令面口径不变：这一面**不起引擎、不写盘**（只用已受控的 pdf-lib 在内存里读结构），值一律不回显。 */
async function checkPdf(input, buf, filter, want, backendName) {
  const t0 = Date.now();
  const scan = await pdfRiskScan(buf);
  if (scan.unavailable) die(scan.code, scan.error, scan.next);
  if (scan.encryptedOnly) die('unsupported-format', '该 PDF 带加密字典：结构读不全的体检等于没体检，这一面不接加密件', '先解密再 check（装置不绕加密——与 pdfform／scrub／combine／split 同一立场）；只想要字面内容就用 pages＋ocr 走渲染那条路');
  if (scan.loadError) die(scan.loadError.code, `读不通这份 PDF：${scan.loadError.error}`, '结构自证没过（坏件／交叉表或目录缺失）：先 inspect 看容器识别；读不通的件别当"已体检"外发');
  const kept = scan.findings.filter((f) => want(f.kind));
  const counts = {};
  for (const f of kept) counts[f.kind] = (counts[f.kind] || 0) + 1;
  const totalConclusions = kept.length;
  const clean = totalConclusions === 0 && !filter;   // 与 ZIP 面同一条规矩：过滤态的 0 项不等于干净
  const applicable = CHECK_APPLICABLE.pdf;
  const listed = kept.slice(0, CHECK_FINDINGS_CAP);
  const warnings = [...scan.warnings];
  if (backendName === 'officecli') warnings.push('--backend officecli 在 PDF 上没跑：上游那条 schema 校验只覆盖 OOXML，PDF 不在它的面内（这是适用面到此为止，不是降级也不是红）');
  out({
    ok: true, op: 'check', engine: false, input, bytes: buf.length, sha256: sha256(buf), container: 'pdf',
    kindsLookedAt: CHECK_KINDS, kindsApplicable: applicable, kindsNotApplicable: CHECK_KINDS.filter((k) => !applicable.includes(k)),
    filter: filter || 'all', counts, totalConclusions, findings: listed, findingsCap: CHECK_FINDINGS_CAP, findingsTruncated: totalConclusions > CHECK_FINDINGS_CAP, clean,
    pdfRisk: {
      pageCount: scan.pageCount, objectsScanned: scan.counts.objectsScanned,
      actions: { uri: scan.counts.uri, goToRemote: scan.counts.goToRemote, launch: scan.counts.launch, javascript: scan.counts.javascript, autoActions: scan.counts.autoActions },
      layers: { ocg: scan.counts.ocg, defaultOff: scan.counts.ocgDefaultOff },
      embeddedFiles: scan.counts.embeddedFile,
    },
    backend: backendName,
    schema: { backend: backendName, requested: backendName === 'officecli', available: backendName !== 'officecli', valid: null, note: 'PDF 不走 OpenXML schema 校验（那是 OOXML 的面）；本命令这一面＝装置自己的纯 JS 结构扫描' },
    cleanMeaning: filter ? 'filter 生效中：clean=false 只说明这次被过滤的族没有结论，不代表整份 PDF 干净' : 'clean=true 表示 PDF 适用的族（kindsApplicable）全查过且零结论；前提是**结构自证过了**——坏件与加密件在本支直接被拒，不会带着读不全的结构给你一个 true',
    ms: Date.now() - t0,
    ...(warnings.length ? { warnings } : {}),
    note: 'v2.6.0 的 PDF 面：/Info＋XMP 元数据、隐藏图层（OCG）、外部引用（/URI、/GoToR、/Launch）、内嵌附件、宏与 JavaScript、表单字段（AcroForm/XFA）；纯 JS 结构扫描，不起引擎、不写盘、任何值都不回显。字体嵌入/版式/页数走 inspect，正文走 pdftext 与 verify',
  });
}

function cmdCheck(args) {
  const { positional, flags } = parseArgs(args, 'check');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'check'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  const input = abs(positional[0]); if (!input || !fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  if (positional.length > 1) die('invalid-output', `check 只收一个输入，给了 ${positional.length} 个（${positional.join(' , ')}）`, '用法：check <输入文件> [--kind 族,族]');
  const filter = flags.kind === undefined ? null : String(flags.kind).split(',').map((x) => x.trim()).filter(Boolean);
  if (filter && filter.length) {
    const unknown = filter.filter((k) => !CHECK_KINDS.includes(k));
    if (unknown.length) {
      const cand = nearestCandidates(unknown[0], CHECK_KINDS);
      die('invalid-output', `未知结论族：${unknown.join(' , ')}`, `最接近的族：${cand.join(' | ') || '(无)'}；全部族：${CHECK_KINDS.join(' | ')}`, { candidates: cand });
    }
  }
  const want = (kind) => !filter || filter.includes(kind);
  const buf = fs.readFileSync(input);
  // v2.6.0：PDF 面——纯 JS 结构扫描（pdfRiskScan 走 pdf-lib），**仍然不起引擎、不写盘**；OLE 照旧在起任何引擎之前被拒。
  const backendName = flags.backend === undefined ? DEFAULT_CHECK_BACKEND : String(flags.backend);
  if (!['zip', 'officecli'].includes(backendName)) die('invalid-output', `--backend 只认 zip|officecli，给了 ${JSON.stringify(backendName)}`, '`help check` 的 backend 那行写着两条路线的差别');
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return checkPdf(input, buf, filter, want, backendName);
  // 🔴 全程不起引擎（《方案》P1-2 的"纯 ZIP"）：OLE 在这一层就被拒，也不落任何产物
  if (buf.readUInt32LE(0) !== 0x04034b50) die('unsupported-format', 'check 吃 ZIP 系容器（docx/xlsx/pptx/odt/ods/odp）与 PDF（v2.6.0 起走纯 JS 结构面），且全程不起引擎；输入按 magic 判两者都不是', 'OLE 二进制（.doc/.xls/.ppt）先 to 成 OOXML 再 check；PDF 交给本命令的 PDF 面；要核正文内容走 verify 的渲染半条');
  let map;
  try { map = zipRead(buf); }
  catch (e) { die('invalid-document', `ZIP 读不通：${e.message}`, '条目 CRC 不匹配、压缩流被改过或压根不是 ZIP ⇒ 输入文件坏了：别外发、别当已核验，从来源重取（这一层复用装置既有的逐条 CRC 实算，不另写一套）'); }
  const container = zipFamily(map);
  if (!container) die('invalid-document', 'ZIP 里找不到 OOXML/ODF 的标志部件，认不出容器', '先 inspect 看容器识别结果；纯文本改后缀的伪装件会在这里红');
  const findings = [];
  const warnings = [];
  const add = (kind, part, locator, detail) => { if (want(kind)) findings.push({ kind, part, locator, detail }); };
  const isOOXML = ['docx', 'xlsx', 'pptx'].includes(container);
  const isODF = ['odt', 'ods', 'odp'].includes(container);
  const ERR_TOKEN = '#(?:REF!|DIV/0!|VALUE!|NAME[?]|N/A|NUM!|NULL!)';
  const idOf = (txt) => ((/id="(\d+)"/.exec(txt) || ['', '?'])[1]);
  // ① 出域元数据字段——**只给字段名 + 字节长度，值一律不回显**（承重 3，与 inspect 的三串口径同族）
  if (isOOXML) {
    for (const part of ['docProps/core.xml', 'docProps/app.xml']) {
      const d = map.get(part); if (!d) continue;
      for (const f of META_PROBE_FIELDS) {
        for (const m of str(d).matchAll(new RegExp('<' + f + '(?:\\s[^>]*)?>([^<]*)</' + f + '>', 'g'))) {
          if (m[1].trim()) add('meta-field', part, f, `非空元数据字段 ${f}（值 ${Buffer.byteLength(m[1].trim(), 'utf8')} B，不回显）——外发前走 scrub --verify`);
        }
      }
    }
  }
  if (isODF && map.get('meta.xml')) {
    for (const f of ODF_META_FIELDS) {
      for (const m of str(map.get('meta.xml')).matchAll(new RegExp('<' + f + '(?:\\s[^>]*)?>([^<]*)</' + f + '>', 'g'))) {
        if (m[1].trim()) add('meta-field', 'meta.xml', f, `非空 ODF 元数据字段 ${f}（值 ${Buffer.byteLength(m[1].trim(), 'utf8')} B，不回显）`);
      }
    }
  }
  // ② 公式错误值的陈旧缓存：t="e" 或缓存串本身是标准错误码（引擎带缓存就直接用，不重算——承重 4 那一族）
  if (container === 'xlsx') {
    for (const [name, data] of map) {
      if (!/^xl\/worksheets\/.+\.xml$/.test(name)) continue;
      for (const c of str(data).matchAll(/<c\s[^>]*?r="([A-Z]+[0-9]+)"[^>]*>([\s\S]*?)<\/c>/g)) {
        const inner = c[2];
        const cached = (inner.match(/<v>([^<]*)<\/v>/) || [])[1] || '';
        const isErrType = /\st="e"/.test(c[0]);
        const isErrValue = new RegExp('^' + ERR_TOKEN + '$').test(cached);
        if (!isErrType && !isErrValue) continue;
        const safe = new RegExp('^' + ERR_TOKEN + '$').test(cached) ? cached : '(缓存值不是标准错误码，不回显)';
        add('formula-error-cache', name, c[1], `单元格 ${c[1]} 带错误值缓存（t="e"=${isErrType}，缓存=${safe}）——先 recalc --verify 再导出，别把这格当数`);
      }
    }
  }
  // ③ 缺替代文字：docx 的 wp:docPr / pptx 图片的 p:cNvPr 必须带非空 descr
  if (container === 'docx') {
    const d = map.get('word/document.xml');
    if (d) for (const m of str(d).matchAll(/<(?:wp|pic):docPr\b([^>]*)\/?>/g)) {
      const dm = /descr="([^"]*)"/.exec(m[1]);
      if (!(dm && dm[1].trim())) add('missing-alt-text', 'word/document.xml', `docPr id=${idOf(m[1])}`, '图/对象的 wp:docPr 没有非空 descr（读屏软件拿不到说明）');
    }
  }
  // ③-b 修订/批注（只检测、不写入；修订的接受/写入仍归各 agent 技能，见《技能与装置分工表》）：
  //   revisions＝document.xml 里未接受的 w:ins/w:del 开标签（逐条、w:id 定位）；
  //   comments＝word/comments.xml 里 w:comment 条数。含其一即给外发提示。
  if (container === 'docx') {
    const d = map.get('word/document.xml');
    if (d) {
      let revSeen = 0;
      for (const m of str(d).matchAll(/<w:(ins|del)\b([^>]*?)>/g)) {
        const rid = (/\bw:id="(-?\d+)"/.exec(m[2]) || [, '?'])[1];
        add('revisions', 'word/document.xml', `w:${m[1]} w:id=${rid}`, `未接受的${m[1] === 'ins' ? '插入' : '删除'}修订（w:${m[1]} w:id=${rid}）：外发前在源程序接受/拒绝修订，别把带痕迹的件当干净件交付`);
        revSeen++;
      }
      if (revSeen) warnings.push('该 docx 含未接受修订（w:ins/w:del）：外发前先全部接受或拒绝修订；格式修订（w:rPrChange/w:pPrChange 等）本族未计，需另查');
    }
    const cpart = map.get('word/comments.xml');
    if (cpart) {
      let cSeen = 0;
      for (const m of str(cpart).matchAll(/<w:comment\b([^>]*?)>/g)) {
        const cid = (/\bw:id="(-?\d+)"/.exec(m[1]) || [, '?'])[1];
        add('comments', 'word/comments.xml', `w:comment w:id=${cid}`, `批注（w:comment w:id=${cid}）：外发前删批注或确认可随件发出，别把内部批注当正式件交付`);
        cSeen++;
      }
      if (cSeen) warnings.push('该 docx 含批注（word/comments.xml）：外发前删除批注或确认可随件发出');
    }
  }
  if (container === 'pptx') {
    let sawPic = false;
    for (const [name, data] of map) {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
      for (const pic of str(data).matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)) {
        sawPic = true;
        const cnv = /<p:cNvPr\b[^>]*\/?>/.exec(pic[0]);
        if (!cnv || !(/descr="([^"]*)"/.exec(cnv[0]) || [, ""])[1].trim()) add('missing-alt-text', name, `p:pic cNvPr id=${cnv ? idOf(cnv[0]) : '?'}`, '这一页的图片 p:cNvPr 没有非空 descr');
      }
    }
    if (sawPic) warnings.push('pptx 只查了图片（p:pic 的 cNvPr），形状 p:sp 的替代文字面未覆盖');
  }
  if (container === 'xlsx') warnings.push('xlsx 的图片替代文字面未覆盖（装置只核 docx 的 wp:docPr 与 pptx 的 p:cNvPr）');
  // ④ 空表 / 空页
  if (container === 'xlsx') {
    for (const [name, data] of map) {
      if (!/^xl\/worksheets\/.+\.xml$/.test(name)) continue;
      if (!/<c\s/.test(str(data))) add('empty-sheet', name, path.basename(name, '.xml'), '这张工作表一个单元格都没有');
    }
  }
  if (container === 'pptx') {
    for (const [name, data] of map) {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
      if (!/<p:(sp|pic|graphicFrame|cxnSp|grpSp)\b/.test(str(data))) add('empty-page', name, `slide-${(/slide(\d+)\.xml/.exec(name) || ['', '?'])[1]}`, '这一页没有任何形状');
    }
  }
  if (container === 'docx') {
    const d = map.get('word/document.xml');
    if (d) {
      const wt = [...str(d).matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
      if (!wt.some((m) => m[1].replace(/<[^>]*>/g, '').trim() !== '')) add('empty-page', 'word/document.xml', 'document', '正文里没有一个非空白文本节点');
    }
  }
  if (isODF) {
    const c = map.get('content.xml');
    if (c) {
      const xml = str(c);
      if (container === 'ods') {
        for (const t of xml.matchAll(/<table:table\s[^>]*table:name="([^"]+)"[\s\S]*?<\/table:table>/g)) {
          if (!/<table:table-cell/.test(t[0])) add('empty-sheet', 'content.xml', t[1], '这张 ODF 表里一个单元格都没有');
        }
      }
      if (container === 'odp') {
        for (const p of xml.matchAll(/<draw:page\s[^>]*name="([^"]*)"[\s\S]*?<\/draw:page>/g)) {
          if (!/<draw:(frame|image|control)|<text:|<presentation:/.test(p[0])) add('empty-page', 'content.xml', p[1] || '(无名页)', '这一 ODF 页没有内容框也没有文本');
        }
      }
      if (container === 'odt') {
        // 真件里正文包在 text:span 内（text:p 里再套一层才是字），只看"标签后紧跟非空白"会把有字的 odt 误判成空页
        const paras = [...xml.matchAll(/<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:\1>/g)];
        if (!paras.some((p) => p[2].replace(/<[^>]*>/g, '').trim() !== '')) add('empty-page', 'content.xml', 'body', '这份 ODF 正文里没有非空白文本');
      }
      warnings.push('ODF 的空页/空表是整块粗判（按 draw:page / table:table 块里有没有正文元素），粒度比 OOXML 粗');
    }
  }
  // ⑤–⑨ v2.6.0 外发风险面（只检测、只点名，一律不回显值）：隐藏内容 / 外部引用 / 内嵌对象 / 宏 / 自定义 XML
  if (container === 'docx') {
    const d = map.get('word/document.xml');
    if (d) for (const m of str(d).matchAll(/<w:(vanish|webHidden)(?:\s[^>]*?)?\/?>/g)) {
      if (/\sw:val="(0|false|off|never)"/.test(m[0])) continue;   // 显式把"隐藏"关掉的标记不算隐藏（否则干净件也会被点名）
      add('hidden-content', 'word/document.xml', `w:${m[1]}`, '正文里有隐藏文本（w:vanish/w:webHidden）：肉眼看不见，复制·检索·转格式却拿得到——外发前在源程序里删掉或改回可见');
    }
  }
  if (container === 'xlsx') {
    const wb = map.get('xl/workbook.xml');
    if (wb) for (const m of str(wb).matchAll(/<sheet\b[^>]*?\sstate="(veryHidden|hidden)"[^>]*>/g)) {
      const nm = (/\bname="([^"]*)"/.exec(m[0]) || [, ''])[1];
      add('hidden-content', 'xl/workbook.xml', `sheet:${nm || '(无名表)'}`, `工作表${nm ? '「' + nm + '」' : ''}是 ${m[1]} 态：里面的数随件出门${m[1] === 'veryHidden' ? '（veryHidden 在界面里删不掉，只能解包）' : ''}`);
    }
    for (const [name, data] of map) {
      if (!/^xl\/worksheets\/.+\.xml$/.test(name)) continue;
      for (const m of str(data).matchAll(/<row\b[^>]*?\shidden="(1|true)"[^>]*>/g)) {
        add('hidden-content', name, `row r=${(/\br="([^"]*)"/.exec(m[0]) || [, '?'])[1]}`, '这一行被隐藏（row @hidden）：单元格的值仍在，筛选/排序会带着走');
      }
      for (const m of str(data).matchAll(/<col\b[^>]*?\shidden="(1|true)"[^>]*>/g)) {
        add('hidden-content', name, `col min=${(/\bmin="([^"]*)"/.exec(m[0]) || [, '?'])[1]} max=${(/\bmax="([^"]*)"/.exec(m[0]) || [, '?'])[1]}`, '这一段列被隐藏（col @hidden）');
      }
    }
  }
  if (container === 'pptx') {
    for (const [name, data] of map) {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
      const root = /<p:sld\b[^>]*>/.exec(str(data));
      if (root && /\sshow="0"/.test(root[0])) add('hidden-content', name, `slide-${(/slide(\d+)\.xml/.exec(name) || ['', '?'])[1]} p:sld@show="0"`, '这一页是隐藏页（p:sld 根元素 show="0"）：放映不出现，内容随件出门');
    }
    const pres = map.get('ppt/presentation.xml');
    if (pres) for (const m of str(pres).matchAll(/<p:sldId\b[^>]*?\sshow="0"[^>]*>/g)) {
      add('hidden-content', 'ppt/presentation.xml', `p:sldId id=${(/\bid="([^"]*)"/.exec(m[0]) || [, '?'])[1]}`, '放映列表这一项标了 show="0"（与 p:sld 根写法并存的另一种形状）');
    }
    warnings.push('pptx 隐藏页两种形状都扫了（slide 根的 p:sld@show、presentation 里的 p:sldId@show）：真件 PowerPoint 落哪一种本机**未取证**，本面只按字面标记点名');
  }
  if (isODF) {
    const c = map.get('content.xml');
    if (c) for (const m of str(c).matchAll(/<(table:table-cell|table:table-row|table:table-column)\b[^>]*?\stable:visibility="hidden"/g)) {
      add('hidden-content', 'content.xml', `${m[1]} @table:visibility="hidden"`, 'ODF 里有隐藏的单元格/行/列（table:visibility）：看不见不等于不在件里');
    }
    const st = map.get('styles.xml');
    if (st) for (const m of str(st).matchAll(/<style:style\b[^>]*?\sstyle:family="table"[^>]*>(?:(?!<\/style:style>)[\s\S])*?<style:table-properties\b[^>]*?\stable:display="false"/g)) {
      add('hidden-content', 'styles.xml', `表样式 ${(/\bstyle:name="([^"]*)"/.exec(m[0]) || [, '?'])[1]}`, 'ODF 里这张表被设为不显示（表样式 table:display="false"；ODF 的表名与表样式同名，所以定位到的是表名）');
    }
  }
  // ⑥ 外部引用：OOXML 的 TargetMode="External" 关系与 xlsx 的外部工作簿；ODF 的绝对 xlink:href。目标一律不回显（地址本身可能带用户名/内网主机名）
  if (isOOXML) {
    for (const [name, data] of map) {
      if (!/\.rels$/.test(name)) continue;
      for (const m of str(data).matchAll(/<Relationship\b[^>]*?\sTargetMode="External"[^>]*>/g)) {
        add('external-link', name, `Relationship Id=${(/\bId="([^"]*)"/.exec(m[0]) || [, '?'])[1]}`, '包里有 TargetMode="External" 的关系（超链接/外部资源）：外发前逐条确认收件方能不能到达；**目标不回显**，要看内容请在源程序里查');
      }
    }
    for (const [name] of map) {
      if (/^xl\/externalLinks\/externalLink\d+\.xml$/.test(name)) add('external-link', name, path.basename(name), '工作簿引用了**另一个工作簿**：显示的值来自那份文件的缓存，收件方没有它就是陈旧值或 #REF!——先断开链接或把值粘成静态');
    }
  }
  if (isODF) {
    const c = map.get('content.xml');
    if (c) for (const m of str(c).matchAll(/<([a-z]+:(?:image|frame|object|link|a))\b[^>]*?xlink:href="((?:https?|ftp|file|mailto):[^"]*|\\\\[^"]*)"/g)) {
      add('external-link', 'content.xml', `${m[1]} @xlink:href（绝对地址，不回显）`, 'ODF 正文引了外部绝对地址（http/https/ftp/file/mailto/UNC）：收件方打不开就是空图或断链');
    }
  }
  // ⑦ 内嵌对象：这是"另一份文档"，不是本文档的版面
  if (isOOXML) {
    for (const [name, data] of map) {
      if (!/^(?:word|ppt|xl)\/embeddings\//.test(name)) continue;
      add('embedded-object', name, path.basename(name), `包内嵌对象（OLE/嵌入文件，${data.length} B）：装置不解二进制内容，外发前逐个确认这份可不可带出`);
    }
  }
  if (isODF) {
    for (const [name, data] of map) {
      if (!/^Objects\//.test(name)) continue;
      add('embedded-object', name, path.basename(name), `ODF 的 Objects/ 下有一份 OLE 子文档（${data.length} B）：它自己是完整文档，可能也带元数据`);
    }
  }
  // ⑧ 宏／可执行载体
  if (isOOXML) {
    for (const [name, data] of map) {
      if (!/^(?:word|ppt|xl)\/vbaProject\.bin$/.test(name)) continue;
      add('macro', name, path.basename(name), `🔴 包内含 VBA 工程（${data.length} B）＝**可执行代码**：收件方打开会被提示启用宏，装置不分析代码；确需外发请转存为不含宏的族（docx/xlsx/pptx）`);
    }
    const ct = map.get('[Content_Types].xml');
    if (ct && /macroEnabled/.test(str(ct))) add('macro', '[Content_Types].xml', 'ContentType 含 macroEnabled', '内容类型声明这是 macro-enabled 包：即便本次没扫到 vbaProject.bin，收件端也会当宏文件处理');
  }
  if (isODF) {
    for (const [name] of map) {
      if (!/^(?:Scripts|Basic|Dialogs|ObjectScript)\//.test(name)) continue;
      add('macro', name, path.basename(name), 'ODF 包带脚本目录（Scripts/Basic/Dialogs/ObjectScript）＝可执行代码面：装置不读脚本内容，外发前确认必要性与来源');
    }
  }
  // ⑨ 自定义 XML／自定义属性：正文之外的任意结构化数据，最容易整段漏出门
  if (isOOXML) {
    for (const [name] of map) {
      if (!/^customXml\/(?:item|itemProps)\d*\.xml$/.test(name)) continue;
      add('custom-xml', name, path.basename(name), '包带自定义 XML 部件（customXml/）：内容可以是任意结构化数据（含个人信息），**本命令不读它的内容**——外发前逐项确认可否带出');
    }
    const cust = map.get('docProps/custom.xml');
    if (cust) for (const m of str(cust).matchAll(/<property\b([^>]*)>([\s\S]*?)<\/property>/g)) {
      const nm = (/\bname="([^"]*)"/.exec(m[1]) || [, '(无名)'])[1];
      const v = (/<vt:[\w]+>([\s\S]*?)<\/vt:[\w]+>/.exec(m[2]) || [, ''])[1];
      if (!v.trim()) continue;
      add('custom-xml', 'docProps/custom.xml', `property ${nm}`, `自定义属性「${nm}」有值（值 ${Buffer.byteLength(v, 'utf8')} B，不回显）：这一族 scrub 的 docProps 面不覆盖，要在源程序里删`);
    }
  }
  const counts = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] || 0) + 1;
  const totalConclusions = findings.length;
  const clean = totalConclusions === 0 && !filter;   // 🔴 带 --kind 过滤时不许自称"干净"（过滤后的 0 项≠全查的 0 项）
  // R6：`--backend officecli` 另跑一次上游 OpenXML schema 校验。**只回结论，后端 stdout 一律不透传**（ADR-002 排除项 B）。
  // 后端不在位 ⇒ 一条 warning + schema.available=false，`clean` 与退码都不变：没装写后端的那台机器上，一次好体检不许被降级成坏消息。
  let schema = null;
  if (backendName === 'officecli') {
    const rr = officecliCall('validate', ['validate', input]);
    schema = {
      backend: 'officecli', requested: true, available: rr.code !== 'unavailable',
      valid: rr.ok ? true : null, exitCode: rr.backend && rr.backend.exitCode !== undefined ? rr.backend.exitCode : null,
      ms: rr.ms, code: rr.ok ? null : rr.code,
      note: rr.ok ? '上游 schema 校验通过（这一条只覆盖 OpenXML schema 合法性，不等于"版式没问题"，也不覆盖 ODF）' : (rr.code === 'unavailable' ? '后端不在位：这一面没跑，报告的其它族结论不受影响' : `schema 校验没通过或未跑（装置映射码 ${rr.code}；后端自报码 ${rr.backendCode || '(无)'}）`),
    };
    if (rr.code === 'unavailable') warnings.push(`check --backend officecli 没跑：${rr.error}`);
    if (!rr.ok && rr.code !== 'unavailable') warnings.push(`schema 结论来自后端映射：${rr.code}`);
  } else {
    schema = { backend: DEFAULT_CHECK_BACKEND, requested: false, available: true, valid: null, note: '默认路线：装置自己的 ZIP 形状体检，不调后端' };
  }
  const applicable = CHECK_APPLICABLE[container] || [];
  const listed = findings.slice(0, CHECK_FINDINGS_CAP);
  out({
    ok: true, op: 'check', engine: false, input, bytes: buf.length, sha256: sha256(buf), container,
    kindsLookedAt: CHECK_KINDS, kindsApplicable: applicable, kindsNotApplicable: CHECK_KINDS.filter((k) => !applicable.includes(k)),
    filter: filter || 'all', counts, totalConclusions, findings: listed, findingsCap: CHECK_FINDINGS_CAP, findingsTruncated: totalConclusions > CHECK_FINDINGS_CAP, clean,
    backend: backendName, schema,
    cleanMeaning: filter ? 'filter 生效中：clean=false 只说明这次被过滤的族没有结论，不代表整份文档干净' : 'clean=true 表示**这一类容器适用的族（kindsApplicable）全查过且零结论**；不适用的族在 kindsNotApplicable 里明说，不冒充查过',
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
    note: '纯 ZIP 的形状体检，不起引擎也不写盘：缺字、版式、渲染结果都不在这一面（那些走 inspect --deep / pages / verify）；PDF 走本命令的 PDF 面（纯 JS 结构扫描）',
  });
}

function cmdHelp(args) {
  const { positional, flags } = parseArgs(args, 'help');
  if (positional.length > 1) die('invalid-output', `help 只收一个命令名，给了 ${positional.length} 个（${positional.join(' , ')}）`, '用法：help [命令] [--json]；不带名字＝列全部命令');
  const name = positional[0];
  if (name !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(HELP_SPEC, name)) {
      const cand = nearestCandidates(name, Object.keys(COMMANDS));
      die('invalid-output', `help 里没有这条命令：${name}`, (cand.length ? `最接近的命令：${cand.join(' | ')}；` : '') + `可用命令：${Object.keys(COMMANDS).join(' | ')}`, { candidates: cand });
    }
    const sp = HELP_SPEC[name];
    out({ ok: true, op: 'help', mode: 'command', version: VERSION, kitVersion: KIT_VERSION, command: name, summary: HELP[name], usage: sp.usage, positional: sp.positional, flags: sp.flags, codes: sp.codes, globalFlags: GLOBAL_FLAGS, note: sp.note });
    return;
  }
  if (flags.brief === true) {
    // v3.1.0：首读索引——命令名＋一句话＋是否写盘（writes），每条一行、≈4.5 KB。
    // 写盘清单 = 第一时间决定"产物落哪"的最小集合（redact/edit/gc 这类"写错不可见"的命令一眼可辨）。
    // 值 true＝落产物；字符串＝有写盘动作但须点名的例外（writes 仍 false，另出 writesNote）——
    // inspect 的 --deep 经临时 PDF 中转（用完即删，不落产物），它与 verify 的 TMP 中转同族：
    // 中转不算写盘，但调用方有权知道这一半。
    const WRITES = { to: true, pages: true, ocr: true, recalc: true, scrub: true, inspect: '--deep 经临时 PDF 中转（用完即删，不落产物）', edit: true, merge: true, media: true, batch: true, combine: true, split: true, pdftext: true, pageops: true, pipeline: true, markdown: true, pdfform: true, redline: true, redact: true, tables: true, frommd: true, compress: true, sheetop: true, gc: true };
    out({ ok: true, op: 'help', mode: 'brief', version: VERSION, kitVersion: KIT_VERSION, entry: path.relative(ROOT, __filename), commands: Object.keys(HELP_SPEC).map((k) => ({ command: k, summary: HELP[k].split('。')[0].split('：')[0].slice(0, 70), writes: WRITES[k] === true, ...(typeof WRITES[k] === 'string' ? { writesNote: WRITES[k] } : {}), detail: `help ${k}` })) });
    return;
  }
  if (flags.json === true) {
    out({ ok: true, op: 'help', mode: 'all-structured', version: VERSION, kitVersion: KIT_VERSION, entry: path.relative(ROOT, __filename), globalFlags: GLOBAL_FLAGS, commands: Object.keys(HELP_SPEC).map((k) => ({ command: k, summary: HELP[k], usage: HELP_SPEC[k].usage, positional: HELP_SPEC[k].positional, flags: HELP_SPEC[k].flags, codes: HELP_SPEC[k].codes, note: HELP_SPEC[k].note })) });
    return;
  }
  out({ ok: true, version: VERSION, kitVersion: KIT_VERSION, entry: path.relative(ROOT, __filename), commands: Object.keys(HELP).map((k) => `${k}  ${HELP[k]}`) });
}

/** R6 写能力（ADR-002 §三-3）：承重 1"原件只读"的守法形状——
 *  第一步必须是 **copyfile 到 _out/<名>-<UTC时间戳>-work.<ext>**，后端只碰副本；
 *  操作前后各测一次**原件** sha256，不一致立刻 `code:'failed'`（这条对账不能只信后端自报，判据自己也会重算一次）。 */
function cmdEdit(args) {
  const { positional, flags } = parseArgs(args, 'edit');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'edit'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  const input = positional[0] ? abs(positional[0]) : null;
  const op = positional[1];
  const target = positional[2];
  if (!input || !fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0] || '(空)'}`, '给绝对路径');
  if (!['set', 'add', 'remove'].includes(op)) die('invalid-output', `edit 的操作只认 set/add/remove，给了 ${JSON.stringify(op ?? '(空)')}`, '用法：edit <输入> <set|add|remove> <路径> [--prop k=v[,k=v]] [--type 元素类型] [--out 文件]');
  if (!target) die('invalid-output', `${op} 缺元素路径`, '`help edit` 看路径形状（docx 用 /body/p[N]，pptx 用 /slide[N]，xlsx 用 /<表名>!<单元格>）');
  if (positional.length > 3) die('invalid-output', `edit 只收三个位置参数，给了 ${positional.length} 个`, '输出路径请用 --out，别当第四个位置参数传');
  const ext = extOf(input);
  if (!['docx', 'xlsx', 'pptx'].includes(ext)) die('unsupported-format', `edit 只吃 OOXML（docx/xlsx/pptx），输入是 .${ext}`, '先 to 成 OOXML 族；ODF 与 OLE 没有可达的后端路线（ADR-002 §二）');
  if (op === 'add' && !flags.type) die('invalid-output', 'add 必须带 --type（要加的元素类型）', '`help edit` 的 note 里有各族常用类型；不确定就先 dump 看现有部件形状');
  const props = {};
  if (flags.prop) {
    for (const kv of String(flags.prop).split(',')) {
      const i = kv.indexOf('=');
      if (i <= 0) die('invalid-output', `--prop 要 k=v 形式（多个用逗号分隔），这段解析不出键：${JSON.stringify(kv)}`, '例：--prop text=HELLO,bold=true');
      props[kv.slice(0, i).trim()] = kv.slice(i + 1);
    }
  }
  if (op === 'remove' && Object.keys(props).length) die('invalid-output', 'remove 不吃 --prop（它只删不写值）', '要去改属性请用 set');
  if (op !== 'remove' && !Object.keys(props).length) die('invalid-output', `${op} 没带任何 --prop——这一次改不会写进任何值`, '装置不做"空写"（成功的结论里没有内容，等于没做）：给 --prop k=v[,k=v]，或删除用 remove');
  // 🔴 顺序是承重的：先探后端，**再**复制。反过来做的话，"后端不在位 ⇒ _out 零新增落点"这条降级断言当场就是红的
  const probe = { verb: op, allowed: OFFICECLI_VERB_ALLOW.includes(op) };
  if (!probe.allowed) die('unsupported-format', `动词 ${op} 不在白名单里`, `docs/adr/ADR-002 §三-2；装置可达的写动词只有 ${OFFICECLI_VERB_ALLOW.join('/')}`);
  const resolved = resolveOfficecliExe();
  if (!fs.existsSync(resolved.exe)) die('unavailable', `找不到写后端（解析自 ${resolved.source}：${resolved.exe}）`, `装 OfficeCLI 或用 ${OFFICECLI_ENV} 指路；本轮**没有**在 _out 落任何半成品`);
  const originalShaBefore = sha256(fs.readFileSync(input));
  const originalBytesBefore = fs.statSync(input).size;
  const base = path.basename(input, '.' + ext);
  const work = freePath(OUT_DIR, `${base}-${stamp()}-work`, ext);
  fs.copyFileSync(input, work);
  const workShaPre = sha256(fs.readFileSync(work));
  // 🔴 一律传**绝对路径**给后端。上一版传 `path.basename(...)` 再配 `cwd: OUT_DIR`，
  //  于是"输出路径在 _out 之外"的 merge 会把产物落进 _out/<同名>，而回报里写的是用户给的那个路径——
  //  装置对着一个不存在的文件报 ok:true（09:57 自查抓到：`_out\m.docx` 实际生成、`_probe\r6out\m.docx` 不存在）。
  const backendArgs = [op, work, target];
  if (op === 'add') backendArgs.push('--type', String(flags.type));
  // 后端实测语法是 `--prop key=value`（09:20 那 11 例就是这条形状跑通的），一对一个开关，可重复
  const propPairs = Object.entries(props);
  for (const [k, v] of propPairs) backendArgs.push('--prop', `${k}=${v}`);
  const r = officecliCall(op, backendArgs, { cwd: OUT_DIR, tmpDir: TMP_DIR });
  const originalShaAfter = sha256(fs.readFileSync(input));
  if (originalShaAfter !== originalShaBefore) {
    die('failed', `🔴 原件被改动了：${input} 操作前 ${originalShaBefore.slice(0, 16)}…（${originalBytesBefore} B）／操作后 ${originalShaAfter.slice(0, 16)}…（${fs.statSync(input).size} B）——违反承重 1，立刻停手`, '别用这次产物；这是装置缺陷（复制优先或"后端只碰副本"其中一条被打穿了），按回归报出来，不要换个路径重试');
  }
  if (!r.ok) {
    out({ ok: false, code: r.code, error: r.error, next: r.next, op: 'edit', input, workCopy: work, backend: r.backend, warnings: r.warnings || [], spawnDelta: r.spawnDelta });
    process.exit(1);
  }
  const workBuf = fs.readFileSync(work);
  const workShaAfter = sha256(workBuf);
  // 写后回读对账（变异台 M48 的靶）：三件独立事实——副本字节真变了、容器仍可解（CRC 逐条对账）、
  // 写进去的值在**某个 XML 部件里能自己找到**（针由装置自己从 --prop 取，不吃后端的自报）
  let entries = null, zipErr = null;
  try { entries = zipRead(workBuf); } catch (e) { zipErr = e.message; }
  // 🔴 写后回读对账：针＝**所有属性值**，但布尔/纯数字值例外（`bold=true` 被后端写成标签 `<w:b/>`、`size=14` 写成半点整数，
  //  拿字面值当针必然假阴）。例外那一部分不许静默跳过——列进 verify.notValueChecked 自报"这一面没测"。
  // 未知属性名（如 zzz=NOTAPROP_888）的值属于"要找的那一类"，找不到 ⇒ 后端把它**静默丢弃**了（实测它回 退码 2 + success:true），
  //  装置因此必须报 failed，不许交付一份什么都没改的副本（M48 的靶）。
  const SCALAR_LITERAL = /^(true|false|yes|no|on|off|\d+(\.\d+)?)$/i;
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
  const texts = entries ? [...entries].map(([n, d]) => [n, unesc(str(d))]) : [];
  const pairs = Object.entries(props).map(([k, v]) => [k.trim(), String(v)]);
  const textNeedles = pairs.filter(([, v]) => !SCALAR_LITERAL.test(v)).map(([, v]) => v);
  const skippedKeys = pairs.filter(([, v]) => SCALAR_LITERAL.test(v)).map(([k, v]) => k);
  const perNeedle = textNeedles.map((v) => texts.filter(([, t]) => t.includes(v)).map(([n]) => n));
  const allFound = perNeedle.length > 0 && perNeedle.every((p) => p.length > 0);
  if (entries && perNeedle.length && !allFound) {
    const missed = textNeedles.filter((_, i) => perNeedle[i].length === 0);
    die('failed', `后端报了 ${op} 成功，但写后回读在副本的 XML 部件里找不到这 ${missed.length} 个值（按长度登记：${missed.map((v) => v.length + 'B').join('/')}）——最可能是属性名不被支持、被后端静默丢弃（它自己的 warnings 里那句 Unsupported property 就是这件事）`, '换一个后端支持的属性名（`help edit` 的 note 里写了这一面怎么验），或删除用 remove；别把这份副本当已改好', { op: 'edit', input, workCopy: work, backend: { ...r.backend, version: officecliVersion().version }, verify: { needleFound: false, checked: textNeedles.length, notValueChecked: skippedKeys.length ? skippedKeys.map((k) => `${k}=标量字面值（写成标签/属性，不做值对账）`) : null }, warnings: r.warnings || [] });
  }
  const foundIn = perNeedle.length ? [...new Set(perNeedle.flat())] : [];
  const res = {
    ok: true, op: 'edit', verb: op, input, workCopy: work, container: ext,
    original: { sha256Before: originalShaBefore, sha256After: originalShaAfter, bytesBefore: originalBytesBefore, bytesAfter: fs.statSync(input).size, unchanged: true },
    work: { bytes: workBuf.length, sha256Before: workShaPre, sha256After: workShaAfter, changed: workShaPre !== workShaAfter },
    verify: {
      entries: entries ? entries.size : null, containerReadable: !!entries, containerError: zipErr,
      needles: textNeedles.map((v) => v.length), needleParts: foundIn, needleFound: perNeedle.length ? allFound : null,
      notValueChecked: skippedKeys.length ? skippedKeys.map((k) => `${k}=标量字面值（写成标签/属性，不做值对账）`) : null,
      note: perNeedle.length
        ? '判据：装置自己从 --prop 取值当针，在**解开实体后**的副本 XML 部件里找；找不到就 code=failed 停手（后端 success 不算数——M48 打的就是"把这段硬编码成 true"）'
        : '本次没有可对账的文本值（全是非文本属性，或 remove），只报"副本字节变了"与"容器仍可解"',
    },
    backend: { ...r.backend, version: officecliVersion().version, ms: r.ms, spawnDelta: r.spawnDelta },
    warnings: r.warnings || [],
    note: `后端只碰了副本 ${path.basename(work)}；原件零改动（sha 前后全等）。产物就是这份副本——要覆盖回任何原件，装置不做`,
  };
  if (flags.out) {
    const dest = abs(flags.out);
    if (fs.existsSync(dest)) die('invalid-output', `--out 指向的文件已存在：${dest}`, '装置的"永不覆盖"不许用 --force 绕过（后端那个开关装置从不传）：换个新名字，或先由人裁那份的去留');
    fs.copyFileSync(work, dest);
    res.delivered = { path: dest, bytes: fs.statSync(dest).size, sha256: sha256(fs.readFileSync(dest)) };
  }
  out(res);
}

/** R6 模板填充：`{{key}}` → 数据值。模板是输入 ⇒ 同样零改动；产物是**新文件**。 */
function cmdMerge(args) {
  const { positional, flags } = parseArgs(args, 'merge');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'merge'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  inputSizeGuard(positional[1], flags['max-input-bytes'], 'merge 的数据件'); // 🔴 F6 补口：数据 JSON 也是整件读进内存的输入（第三个位置参数是输出，不在闸面）
  const template = positional[0] ? abs(positional[0]) : null;
  const dataArg = positional[1] ? abs(positional[1]) : null;
  if (!template || !fs.existsSync(template)) die('invalid-document', `模板不存在：${positional[0] || '(空)'}`, '给绝对路径');
  if (!dataArg || !fs.existsSync(dataArg)) die('invalid-document', `数据文件不存在：${positional[1] || '(空)'}`, 'merge 的数据必须是**JSON 文件路径**（不接内联 JSON，避免 shell 引号把值吃掉——本机这类错已犯过多次）');
  if (positional.length > 3) die('invalid-output', `merge 只收 <模板> <数据> [输出]，给了 ${positional.length} 个位置参数`, '输出路径当第三个位置参数给，或直接省略落 _out/');
  const ext = extOf(template);
  if (!['docx', 'xlsx', 'pptx'].includes(ext)) die('unsupported-format', `merge 只吃 OOXML 模板（docx/xlsx/pptx），模板是 .${ext}`, '先 to 成 OOXML 族再填');
  let data;
  try { data = JSON.parse(str(fs.readFileSync(dataArg))); } catch (e) { die('invalid-document', `数据文件不是合法 JSON：${e.message}`, '给一个 {"键":"值"} 的扁平对象'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) die('invalid-document', '数据 JSON 的顶层必须是对象（{"键":"值"}）', '数组与标量都不吃');
  const keys = Object.keys(data);
  if (!keys.length) die('invalid-document', '数据 JSON 是空对象——那这次 merge 什么也不会填', '要么给键，要么别调 merge（装置不假装"成功填了 0 个"）');
  for (const k of keys) if (typeof data[k] !== 'string' && typeof data[k] !== 'number' && typeof data[k] !== 'boolean') die('invalid-document', `键 ${JSON.stringify(k)} 的值不是标量`, '后端按文本替换 {{key}}，数组/对象一律拒（不猜它怎么序列化）');
  const probe = resolveOfficecliExe();
  if (!fs.existsSync(probe.exe)) die('unavailable', `找不到写后端（解析自 ${probe.source}：${probe.exe}）`, `装 OfficeCLI 或用 ${OFFICECLI_ENV} 指路；本轮没有落任何产物`);
  const tplShaBefore = sha256(fs.readFileSync(template));
  const work = freePath(OUT_DIR, `${path.basename(template, '.' + ext)}-${stamp()}-work`, ext);
  fs.copyFileSync(template, work);
  const dataFile = freePath(TMP_DIR, `merge-data-${stamp()}`, 'json');
  fs.writeFileSync(dataFile, JSON.stringify(data));
  const outDefault = freePath(OUT_DIR, `${path.basename(template, '.' + ext)}-${stamp()}-merged`, ext);
  const dest = positional[2] ? abs(positional[2]) : outDefault;
  if (fs.existsSync(dest)) die('invalid-output', `输出已存在：${dest}`, '装置的"永不覆盖"不许绕过（后端那个 --force 装置从不传）：换名字或先由人裁那份的去留');
  const r = officecliCall('merge', ['merge', work, dest, '--data', dataFile], { cwd: OUT_DIR, tmpDir: TMP_DIR });
  const tplShaAfter = sha256(fs.readFileSync(template));
  try { fs.rmSync(dataFile, { force: true }); } catch {}
  if (tplShaAfter !== tplShaBefore) {
    die('failed', `🔴 模板被改动了：${template} 前 ${tplShaBefore.slice(0, 16)}…／后 ${tplShaAfter.slice(0, 16)}…——违反承重 1`, '别用这次产物；按装置缺陷报出来，不要重试');
  }
  if (!r.ok) {
    out({ ok: false, code: r.code, error: r.error, next: r.next, op: 'merge', template, workCopy: work, backend: r.backend, warnings: r.warnings || [], spawnDelta: r.spawnDelta });
    process.exit(1);
  }
  let entries = null, zipErr = null, outBuf = null;
  // 🔴 先确认"装置报的那个输出路径"真的存在，再去解它。上一版在这句话之前就写回报，
  //  于是出现过"output 报用户给的路径、文件其实在 _out/<同名>"的谎报（09:57 自查抓到）。
  const strayIn = path.join(OUT_DIR, path.basename(dest));
  const extraWarnings = [];
  if (!fs.existsSync(dest)) {
    die('invalid-output', `后端报成功，但装置报的输出路径不存在：${dest}${fs.existsSync(strayIn) && path.resolve(strayIn) !== path.resolve(dest) ? `；产物落在了 ${strayIn}（落点与回报不一致——这次结论不可用）` : ''}`, '别用这次结论；把这条当装置缺陷报出来（落点核对没通过），不要换个路径重试');
  }
  if (path.resolve(strayIn) !== path.resolve(dest) && fs.existsSync(strayIn)) {
    extraWarnings.push(`🔴 同一个文件名在 _out 里也有一份（${strayIn}）——本次写同时落了两处，只有报出的那个是结论`);
  }
  try { outBuf = fs.readFileSync(dest); entries = zipRead(outBuf); } catch (e) { zipErr = e.message; }
  const all = entries ? [...entries.values()].map((d) => str(d)).join('') : '';
  const filled = keys.filter((k) => all.includes(String(data[k]))).length;
  const leftovers = keys.filter((k) => all.includes('{{' + k + '}}'));
  const res = {
    ok: true, op: 'merge', template, output: dest, workCopy: work, container: ext,
    templateSha: { before: tplShaBefore, after: tplShaAfter, unchanged: true },
    data: { keys: keys.length, keyNames: keys.map((k) => `${k}:${String(data[k]).length}`) },
    verify: {
      outputReadable: !!entries, containerError: zipErr, outputBytes: outBuf ? outBuf.length : null,
      outputSha256: outBuf ? sha256(outBuf) : null, filledKeys: filled, leftoverPlaceholders: leftovers,
      note: '判据：装置自己在产物的 XML 部件里数"值出现了"与"占位符还在不在"——后端的 `Replaced keys: N` 只是旁证，不是结论（M48 打的就是拿旁证当结论）',
    },
    backend: { ...r.backend, version: officecliVersion().version, ms: r.ms, spawnDelta: r.spawnDelta },
    warnings: [...(r.warnings || []), ...extraWarnings],
  };
  if (entries && (filled !== keys.length || leftovers.length)) {
    res.ok = true;
    res.warnings.push(`🔴 有键没填上：filled=${filled}/${keys.length}，残留占位符 ${leftovers.length ? leftovers.join('/') : '(无)'}——产物照样交出（后端报了成功），但这不是"全部填好"`);
  }
  out(res);
  if (leftovers.length || filled !== keys.length) return;
}

/** v1.9.0 media：把包里嵌入的媒体件抽到目录 + 清单（类型/字节/sha256）。全程不起引擎，只读输入。 */
/** v2.1.0 pdftext：直取 PDF 内嵌**文本层**（poppler pdftotext，原生 CLI、免 OCR、不触 ADR-001）。
 *  补的是装置自己登记的缺口：数字/文本层 PDF 此前只能 pages 渲染＋ocr（中文 OCR 覆盖率约 0.33、约 21 秒/报告）。
 *  隐私口径与 ocr 一致：文本只落 txt 文件，JSON 报路径/字数/行数/换页数，**不回显正文**；扫描件无文本层给 warning 指路 ocr。 */
function cmdPdftext(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'pdftext');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'pdftext'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入 PDF', '用法：pdftext <输入.pdf> [--out 文件] [--pages N-M] [--timeout-ms n]（help pdftext 看全）');
  if (positional.length > 1) die('invalid-output', 'pdftext 只收一个输入', '一次抽一件；多件请逐次调用或用 batch');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const buf = fs.readFileSync(input);
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', 'pdftext 只吃 PDF（按 magic 判，不看后缀）', '数字/文本层 PDF 用本条直取；扫描件无文本层改走 pages＋ocr；Office 文档取文本用 to ... .txt');
  // --pages 只接**单段连续区间**（pdftotext 只吃 -f/-l）：N、N-M、N-（到末页）。这些是纯参数校验，先于外部依赖，缺 poppler 也照样拒。
  let firstPage = null, lastPage = null;
  if (flags.pages !== undefined && flags.pages !== null) {
    const s = String(flags.pages).trim();
    let m = s.match(/^(\d+)-(\d+)?$/);
    if (m) { firstPage = Number(m[1]); lastPage = m[2] ? Number(m[2]) : null; if (m[2] && lastPage < firstPage) die('invalid-output', `--pages 区间倒置：${s}（起页不得大于止页）`, '写成 N-M 且 N≤M，或 N- 表示到末页'); if (firstPage < 1) die('invalid-output', `页码从 1 起，给了 ${s}`, 'PDF 没有第 0 页'); }
    else if (/^\d+$/.test(s)) { firstPage = lastPage = Number(s); if (firstPage < 1) die('invalid-output', `页码从 1 起，给了 ${s}`, 'PDF 没有第 0 页'); }
    else die('invalid-output', `--pages 只接单段 N、N-M 或 N-（到末页），给了 ${JSON.stringify(s)}`, 'pdftotext 只支持连续区间；离散多页请逐段跑');
  }
  const timeoutMs = Number(flags['timeout-ms'] ?? DEFAULT_TIMEOUT_MS);
  let outPath;
  if (flags.out) { outPath = abs(flags.out); if (fs.existsSync(outPath)) die('invalid-output', `输出已存在，绝不覆盖：${outPath}`, '换个 --out，或省略让装置落 _out 自动去重'); ensureDir(path.dirname(outPath)); }
  else outPath = freePath(OUT_DIR, `${path.basename(input, '.' + extOf(input))}-text-${stamp()}`, 'txt');
  const tl = popplerTool('pdftotext');
  if (!tl.present) die('unavailable', `pdftotext 不在位（${tl.source} 解析：${tl.exe}）`, popplerNext('pdftotext'));
  // v3.1.0：--out 的输出路径全 ASCII 才交给 poppler（argv 按 ANSI 解码，含中文必 I/O Error 退码 2）。
  // poppler 是唯一吃 --out 直通路径的命令面后端（combine/split 等 PDF 写面走 pdf-lib 的 Buffer，不经 argv）。
  // 兜底形态：把 ASCII 临时文件让 poppler 写，装置再搬回调用方要的落点（搬移是同卷 rename 或 copy+verify，输入零写入不变）。
  let popplerOut = outPath;
  if (!/^[\x21-\x7E]+$/.test(outPath)) {
    const tmpO = asciiTmpDir('ptx');
    popplerOut = path.join(tmpO, 'out.txt');
    void tmpO; // tmpO 只活在闭包内；搬回逻辑在 spawn 之后按 popplerOut !== outPath 判
  }
  const enc = flags.enc !== undefined && flags.enc !== null ? String(flags.enc) : 'UTF-8';
  const pargs = ['-enc', enc];
  if (flags.layout) pargs.push('-layout');
  if (firstPage !== null) pargs.push('-f', String(firstPage));
  if (lastPage !== null) pargs.push('-l', String(lastPage));
  pargs.push(input, popplerOut);
  const r = spawnSync(tl.exe, pargs, { encoding: 'utf8', timeout: timeoutMs });
  if (r.signal === 'SIGTERM') die('timeout', `pdftotext 超预算（--timeout-ms=${timeoutMs}）`, nextFor('timeout', {}));
  if (r.error) die('failed', `pdftotext 进程调用失败：${String(r.error).slice(0, 160)}`, 'ENOENT 多半是 DOCKIT_POPPLER_BIN 指错；其它看 error 原文');
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout).trim();
    if (/password|encrypt/i.test(err)) die('unsupported-format', `PDF 加密，pdftotext 读不了：${err.slice(0, 120)}`, '先解密再取文本层；装置不绕加密');
    die('invalid-document', `pdftotext 读不了这份 PDF：${err.slice(0, 160)}`, '坏件或非标准 PDF；先 inspect 看容器');
  }
  if (popplerOut !== outPath) { try { fs.copyFileSync(popplerOut, outPath); try { fs.rmSync(path.dirname(popplerOut), { recursive: true, force: true }); } catch { } } catch (e) { die('failed', `ASCII 中转失败（poppler 已写出、装置搬回时错）：${String(e.message).slice(0, 120)}`, '把本行 JSON 原样回报；中间件在系统 Temp 的 dockit-ptx-* 目录'); } }
  const txt = fs.existsSync(outPath) ? str(fs.readFileSync(outPath)) : '';
  const lines = txt.split(/\r?\n/).filter((x) => x.trim() !== '');
  const chars = lines.reduce((a, x) => a + x.length, 0);
  const pageBreaks = (txt.match(/\f/g) || []).length;
  const warnings = [];
  if (chars === 0) warnings.push('文本层为空：这份 PDF 很可能是扫描件/纯图片（没有可提取的文字层）。请改走 pages 渲染＋ocr，别把空 txt 当成"文档无字"');
  out({ ok: true, op: 'pdftext', backend: 'poppler/pdftotext', tool: tl.exe, toolSource: tl.source, input: { path: input, bytes: buf.length, sha256: sha256(buf) }, file: outPath, requestedPages: flags.pages !== undefined && flags.pages !== null ? String(flags.pages) : 'all', firstPage, lastPage, chars, lines: lines.length, pageBreaks, ...(popplerOut !== outPath ? { asciiTmpReroute: true } : {}), ms: Date.now() - t0, warnings: warnings.length ? warnings : undefined, note: '提取的是 PDF 内嵌文本层（数字 PDF 直取、免 OCR）；文本只落 txt 文件、不回显进 JSON（与 ocr 同一隐私口径）；--out 给非 ASCII 路径时走 ASCII 临时目录中转（poppler argv ANSI 坑，v3.1.0）。空文本层是数据不是错误，按 warnings 改走 OCR' });
}

/** v2.1.0 media 的 PDF 半边：poppler pdfimages -all 按原始格式抽内嵌光栅图（不重编码）。
 *  先 -list 数图、超 --max-files 在落地前就拒（不静默截断、不先落一堆再报错）；缺 pdfimages 回 unavailable。 */
// media 落点统一在此：显式 --dir（调用方在命令体里读出 flags['dir'] 后传入，满足 help 结构化命令面
// 的"宣告开关必须在命令体真读"静态对账）用它，否则 _out/<基名>-media-<时间戳>；freeDir 负责同名去重（永不覆盖）。
// ZIP（OOXML/ODF）与 PDF（pdfimages）两支共用同一个去重点位，避免两处各写一份表达式（变异 M134 单点守它）。
function mediaOutDir(input, dirFlag) {
  return ensureDir(freeDir(dirFlag ? abs(dirFlag) : OUT_DIR, `${path.basename(input, '.' + extOf(input))}-media-${stamp()}`));
}

function mediaFromPdf(input, buf, flags, t0) {
  const pi = popplerTool('pdfimages');
  if (!pi.present) die('unavailable', `pdfimages 不在位（${pi.source} 解析：${pi.exe}）`, popplerNext('pdfimages'));
  const cap = flags['max-files'] !== undefined ? Number(flags['max-files']) : MEDIA_MAX_FILES;
  if (!Number.isInteger(cap) || cap < 1) die('invalid-output', `--max-files 必须是不小于 1 的整数，给了 ${JSON.stringify(flags['max-files'])}`, '照 help media 的用法改');
  const lr = spawnSync(pi.exe, ['-list', input], { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS });
  if (lr.signal === 'SIGTERM') die('timeout', `pdfimages -list 超预算（预算 ${DEFAULT_TIMEOUT_MS}ms）`, nextFor('timeout', {}));
  if (lr.error) die('failed', `pdfimages 进程调用失败：${String(lr.error).slice(0, 160)}`, 'ENOENT 多半是 DOCKIT_POPPLER_BIN 指错');
  if (lr.status !== 0) {
    const err = String(lr.stderr || lr.stdout).trim();
    if (/password|encrypt/i.test(err)) die('unsupported-format', `PDF 加密，pdfimages 读不了：${err.slice(0, 120)}`, '先解密；装置不绕加密');
    die('invalid-document', `pdfimages 读不了这份 PDF：${err.slice(0, 160)}`, '坏件先 inspect');
  }
  const imgRows = String(lr.stdout || '').split(/\r?\n/).filter((ln) => /^\s*\d+\s+\d+\s+/.test(ln));
  const imgCount = imgRows.length;
  // v2.7.0：`-list` 逐行留结构化读数（含 **enc 编码名**）。2026-10-14 用 /JBIG2Decode 与 /JPXDecode 手搓件实测：
  //   -list 正常报 jbig2 / jpx，`-all` 把它们按**原始流**导成 img-000.jb2e 与 img-001.jp2（不是可直接显示的位图），
  //   并往 stderr 吐 "Unable to read header / Expected a SOC marker" 这类解码噪声但退码仍为 0。
  //   所以这一面必须把"导出的是原始流"说清楚，否则调用方会以为拿到了图。
  const MEDIA_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s*$/;
  const images = [];
  for (const ln of imgRows) {
    const m = MEDIA_ROW_RE.exec(ln);
    if (!m) { images.push({ page: null, num: null, type: '(行形状未识别)', enc: '(未解析)', raw: ln.trim().slice(0, 120) }); continue; }
    images.push({ page: +m[1], num: +m[2], type: m[3], width: +m[4], height: +m[5], color: m[6], components: +m[7], bpc: +m[8], enc: m[9], interpolated: m[10], objectId: m[11] + ' ' + m[12], xPpi: +m[13], yPpi: +m[14], listedSize: m[15], ratio: m[16] });
  }
  const encodings = {};
  for (const r2 of images) encodings[r2.enc] = (encodings[r2.enc] || 0) + 1;
  const RAW_STREAM_ENCS = ['jbig2', 'jpx', 'ccitt', 'raw', 'unparsed'];
  const rawStream = images.filter((r2) => RAW_STREAM_ENCS.includes(String(r2.enc).toLowerCase())).map((r2) => `${r2.type}#${r2.num}:${r2.enc}`);
  if (imgCount > cap) die('invalid-output', `PDF 内嵌图 ${imgCount} 张，超过上限 ${cap}（不静默截断、不批量外放过）`, `确要全抽显式加 --max-files ${imgCount}（放宽需调用方知情）；或先 pdfimages -list 看清单`);
  const dir = mediaOutDir(input, flags['dir']);
  // --reencode：只认 jpeg（pdfimages -j，JPEG 流按 .jpg 原样输出）；省略走 -all 原始格式
  const reencode = flags.reencode !== undefined && flags.reencode !== null ? String(flags.reencode).toLowerCase() : null;
  if (reencode !== null && reencode !== 'jpeg') die('invalid-output', `--reencode 只认 jpeg（pdfimages -j），给了 ${JSON.stringify(flags.reencode)}`, '省略则按原始格式 -all 抽，或写 --reencode jpeg');
  const modeArg = reencode === 'jpeg' ? '-j' : '-all';
  // 输出前缀只给 ASCII 的 'img'、产物目录走 spawn 的 cwd（CreateProcess 宽字符，不经子进程 argv 解码）：
  // 实测 poppler 的 pdfimages 把含中文的**输出前缀 argv** 按 ANSI 解成乱码（I/O Error: Couldn't open image file
  // 'D:\<非ASCII路径>…\img-000.png'），而 -list 读中文输入正常。cwd 宽字符 + ASCII 前缀绕开这个 argv 解码坑。
  const er = spawnSync(pi.exe, [modeArg, input, 'img'], { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, cwd: dir });
  if (er.signal === 'SIGTERM') die('timeout', `pdfimages 抽图超预算（预算 ${DEFAULT_TIMEOUT_MS}ms）`, nextFor('timeout', {}));
  if (er.error) die('failed', `pdfimages 抽图进程失败：${String(er.error).slice(0, 160)}`, '看 error 原文');
  if (er.status !== 0) {
    const err = String(er.stderr || er.stdout).trim();
    if (/password|encrypt/i.test(err)) die('unsupported-format', `PDF 加密，pdfimages 抽不了：${err.slice(0, 120)}`, '先解密；装置不绕加密');
    die('invalid-document', `pdfimages 抽图失败：${err.slice(0, 160)}`, '坏件先 inspect');
  }
  const files = []; let totalBytes = 0;
  for (const name of fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort()) {
    const data = fs.readFileSync(path.join(dir, name));
    files.push({ part: name, file: name, bytes: data.length, sha256: sha256(data), type: mediaKind(data) });
    totalBytes += data.length;
  }
  const warnings = [];
  if (!files.length) warnings.push('pdfimages 没抽出内嵌光栅图（矢量绘制/纯文字/仅裁剪复用的 PDF 可为 0；空结果是数据不是错误）');
  if (files.length < imgCount) warnings.push(`-list 报了 ${imgCount} 张、实际落地 ${files.length} 件——差额是 pdfimages 自己没导出的（掩膜/复用/解码失败都会这样，它退码仍可能为 0）。别把 count 当"这份 PDF 的图数"`);
  if (rawStream.length) warnings.push(`🔴 这些件按**原始流**导出（不是可直接显示的位图）：${rawStream.join(' , ')}。JBIG2 常见于扫描件、JPEG2000 常见于拍照件与档案扫描——要拿到**文字**请走 pages＋ocr（渲染后识别），要拿到**像素**请用能解码这两族的查看器；装置不解 JBIG2/JPX 码流（本机没有解码器，硬解＝自证不了的假图）`);
  out({ ok: true, op: 'media', ms: Date.now() - t0, container: 'pdf', backend: 'poppler/pdfimages', tool: pi.exe, input: { path: input, bytes: buf.length, sha256: sha256(buf) }, listedImages: imgCount, encodings, images, rawStreamExports: rawStream, dir, count: files.length, totalBytes, files, warnings: warnings.length ? warnings : undefined, note: 'PDF 内嵌图经 pdfimages -all 按原始格式抽取（不重编码、不解码 JBIG2/JPEG2000）；外发前先过脱敏闸门；超 --max-files 在落地前拒绝' });
}

function cmdMedia(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'media');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'media'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入文件', '用法：media <输入文件> [--dir 目录] [--max-files n]（help media 看全）');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '先给绝对路径，或 ls 确认文件名');
  const buf = fs.readFileSync(input);
  const isZip = buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
  const isPdf = buf.slice(0, 5).toString('latin1') === '%PDF-';
  if (!isZip && !isPdf) die('unsupported-format', 'media 吃 OOXML/ODF 的 ZIP 容器（docx/xlsx/pptx/odt/ods/odp）与 PDF（v2.1.0 起抽内嵌图）', 'OLE 二进制没有可抽取的媒体面：先 inspect 看容器识别，不绕路');
  if (isPdf) {
    const reencode = flags['reencode'];   // 命令体真读（满足 ghost-flag 静态对账），随 flags 传入 helper
    return mediaFromPdf(input, buf, { ...flags, reencode }, t0);
  }
  let map = null;
  try { map = zipRead(buf); } catch (e) { die('invalid-document', `按 ZIP 读不通：${e.message}`, '别外发、别当已核验；从来源重取或先 inspect'); }
  const fam = zipFamily(map);
  if (!fam) die('invalid-document', 'ZIP 里找不到 OOXML/ODF 的标志部件，认不出容器', '先 inspect 看容器识别结果；纯文本/伪装件不许绕路');
  const cap = flags['max-files'] !== undefined ? Number(flags['max-files']) : MEDIA_MAX_FILES;
  if (!Number.isInteger(cap) || cap < 1) die('invalid-output', `--max-files 必须是不小于 1 的整数，给了 ${JSON.stringify(flags['max-files'])}`, '照 help media 的用法改');
  const picked = [...map.entries()].filter(([name]) => MEDIA_PREFIXES.some((p) => name.startsWith(p)));
  if (picked.length > cap) die('invalid-output', `媒体条目 ${picked.length} 件，超过上限 ${cap}（不静默截断、不批量外放过）`, `确要一次抽出就显式加 --max-files ${picked.length}（放宽需调用方知情）；或先 dump 看部件清单再决定`);
  const dir = mediaOutDir(input, flags['dir']);
  const used = new Set();
  const files = []; let totalBytes = 0;
  for (const [part, data] of picked) {
    let name = sanitizeMediaName(part);
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
      let n = 2; while (used.has(`${stem}-${n}${ext}`.toLowerCase())) n += 1;
      name = `${stem}-${n}${ext}`;
    }
    used.add(name.toLowerCase());
    fs.writeFileSync(path.join(dir, name), data);
    files.push({ part, file: name, bytes: data.length, sha256: sha256(data), type: mediaKind(data) });
    totalBytes += data.length;
  }
  const warnings = [];
  if (files.length === 0) warnings.push('包内没有 word/media、ppt/media、xl/media、Pictures 底下的条目（空结果是数据不是错误）；预览件（docProps/thumbnail*、ODF Thumbnails/*）按设计不在采集面');
  out({ ok: true, op: 'media', ms: Date.now() - t0, container: fam, input: { path: input, bytes: buf.length, sha256: sha256(buf) }, dir, count: files.length, totalBytes, files, warnings: warnings.length ? warnings : undefined, note: '提取的媒体件是文档本体：外发前先过脱敏闸门；文件名取自部件基名，目录内去重（-2/-3）' });
}

/** v1.9.0 batch：目录级批量转换——逐件走 to 同一条路（单件失败不拖垮其余，逐件 JSON + 总账）。 */
function cmdBatch(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'batch');
  if (!positional[0]) die('invalid-document', '缺目录参数', '用法：batch <目录> [--ext 列表] [--to 后缀] [--recursive] [--max-items n]（help batch 看全）');
  const dir = abs(positional[0]);
  if (!fs.existsSync(dir)) die('invalid-document', `目录不存在：${positional[0]}`, '给一个存在的目录绝对路径');
  if (!fs.statSync(dir).isDirectory()) die('invalid-document', `不是目录：${dir}`, 'batch 只吃目录；单件转换用 to');
  const ALL_OUT = [...new Set(Object.values(FORMAT_MATRIX).flatMap((v) => v.outputs))];
  // v2.6.0：--cmd 决定"逐件跑哪条命令面"。只有 to 与 markdown 两条——其余命令各有自己的位置参数形状
  //（combine 要两件以上、split 只吃 PDF、pageops 要动词），塞进 batch 就是把"逐件"变成"逐件猜参数"。
  const cmdName = String(flags.cmd !== undefined ? flags.cmd : BATCH_DEFAULT_CMD).toLowerCase();
  if (!BATCH_CMDS.includes(cmdName)) {
    const cand = nearestCandidates(cmdName, BATCH_CMDS);
    die('invalid-output', `--cmd 只认 ${BATCH_CMDS.join(' | ')}，给了 ${JSON.stringify(String(flags.cmd))}`, (cand.length ? `最接近的：${cand.map((c) => '--cmd ' + c).join(' | ')}；` : '') + 'to＝走引擎转换（后缀由 --to 定）；markdown＝走 pandoc（产物恒 .md、不吃 --to）', { candidates: cand });
  }
  if (cmdName === 'markdown' && flags.to !== undefined) die('invalid-output', '--cmd markdown 的产物恒 .md，--to 在这一支没有意义', '去掉 --to（要别的后缀就 --cmd to），markdown 没有第二种输出格式');
  const toExt = cmdName === 'markdown' ? 'md' : String(flags['to'] !== undefined ? flags['to'] : BATCH_DEFAULT_TO).replace(/^\./, '').toLowerCase();
  if (cmdName !== 'markdown' && !ALL_OUT.includes(toExt)) {
    const cand = nearestCandidates(toExt, ALL_OUT);
    die('invalid-output', `--to 目标后缀 ${JSON.stringify(String(flags['to']))} 不在支持面内`, (cand.length ? `最接近的：${cand.map((c) => '--to ' + c).join(' | ')}；` : '') + `支持：${ALL_OUT.join('/')}`, { candidates: cand });
  }
  const extList = flags['ext'] !== undefined ? String(flags['ext']).split(',').map((x) => x.trim().replace(/^\./, '').toLowerCase()).filter(Boolean) : (cmdName === 'markdown' ? MARKDOWN_INPUT_EXTS : Object.values(FORMAT_MATRIX).flatMap((v) => v.inputs));
  if (!extList.length) die('invalid-output', '--ext 是空清单', '去掉 --ext（默认九个受支持输入族全收），或给逗号分隔的后缀如 .doc,.docx');
  const recursive = flags['recursive'] === true;
  const maxItems = flags['max-items'] !== undefined ? Number(flags['max-items']) : BATCH_MAX_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems < 1) die('invalid-output', `--max-items 必须是不小于 1 的整数，给了 ${JSON.stringify(flags['max-items'])}`, '照 help batch 的用法改');
  const timeoutMs = flags['timeout-ms'] !== undefined ? Number(flags['timeout-ms']) : DEFAULT_TIMEOUT_MS;
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive) walk(p); continue; }
      if (e.isFile() && extList.includes(extOf(e.name))) found.push(p);
    }
  };
  walk(dir);
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (found.length > maxItems) die('invalid-output', `匹配到 ${found.length} 件，超过上限 ${maxItems}（不静默截断）`, `缩小 --ext 范围或分批跑；确要一次跑就加 --max-items ${found.length}（放宽需调用方知情）`);
  const warnings = [];
  const items = [];
  let okCount = 0, failed = 0;
  for (const f of found) {
    const x = extOf(f);
    if (cmdName === 'markdown') {
      // 逐件走 markdown 命令面（pandoc）。输入族在前头挡掉：不为一件注定失败的件起子进程（批量面省的是启动成本）
      if (!MARKDOWN_INPUT_EXTS.includes(x)) {
        failed += 1;
        items.push({ input: f, ok: false, code: 'unsupported-format', error: `.${x} 不在 markdown 的输入族（${MARKDOWN_INPUT_EXTS.join('/')}）`, next: ['doc', 'xls', 'ppt'].includes(x) ? '老族先 to 转成新族再批量导 md' : (x === 'pdf' ? 'PDF 取字走 pdftext（数字 PDF 免 OCR、保版面）' : '把这件从 --ext 里去掉') });
        continue;
      }
      const out3 = freePath(OUT_DIR, `${path.basename(f, '.' + x)}-md-${stamp()}`, 'md');
      const r3 = spawnSync(process.execPath, [__filename, 'markdown', f, out3, '--timeout-ms', String(timeoutMs)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      let j3 = null; try { j3 = JSON.parse(String(r3.stdout).trim()); } catch { /* 非 JSON 走 failed 支 */ }
      if (j3 && j3.ok === true) {
        okCount += 1;
        items.push({ input: f, ok: true, ms: j3.ms, output: j3.output && j3.output.path, bytes: j3.output && j3.output.bytes, chars: j3.chars, warnings: j3.warnings });
      } else {
        failed += 1;
        items.push({ input: f, ok: false, code: (j3 && j3.code) || 'failed', error: (j3 && j3.error) || String(r3.stderr || r3.stdout || '(子进程无输出)').replace(/\s+/g, ' ').slice(0, 200), next: j3 ? j3.next : undefined });
      }
      continue;
    }
    const famF = familyOf(x);
    if (!famF || !FORMAT_MATRIX[famF].outputs.includes(toExt)) {
      failed += 1;
      items.push({ input: f, ok: false, code: 'unsupported-format', error: famF ? `.${x} 只能出 ${FORMAT_MATRIX[famF].outputs.join('/')}，请求了 .${toExt}` : `.${x} 不在 kit 的支持族内` });
      continue;
    }
    const out2 = freePath(OUT_DIR, `${path.basename(f, '.' + x)}-${stamp()}`, toExt);
    const r = spawnSync(process.execPath, [__filename, 'to', f, out2, '--timeout-ms', String(timeoutMs)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(String(r.stdout).trim()); } catch { /* 非 JSON 走 failed 支 */ }
    if (j && j.ok === true) {
      okCount += 1;
      items.push({ input: f, ok: true, ms: j.ms, output: j.output, inputRepair: j.inputRepair, warnings: j.warnings });
    } else {
      failed += 1;
      items.push({ input: f, ok: false, code: (j && j.code) || 'failed', error: (j && j.error) || String(r.stderr || r.stdout || '(子进程无输出)').replace(/\s+/g, ' ').slice(0, 200), next: j ? j.next : undefined });
    }
  }
  if (found.length === 0) warnings.push(`目录里没有匹配 --ext（${extList.join('/')}）的文件${recursive ? '（含子目录）' : '（不含子目录；要含子目录用 --recursive）'}——空结果是数据不是错误`);
  const res = { ok: failed === 0, op: 'batch', dir, cmd: cmdName, filter: { cmd: cmdName, ext: extList, to: toExt, recursive }, summary: { total: found.length, ok: okCount, failed }, ms: Date.now() - t0, items, warnings: warnings.length ? warnings : undefined };
  if (failed) { res.code = 'failed'; res.error = `${failed}/${found.length} 件转换失败（逐件看 items[]）`; res.next = '逐件看 items[].code/items[].error 与 items[].next；单件复跑用 to 同参数'; }
  out(res);
  if (failed) process.exit(1);
}

/** v1.9.0 combine：按参数顺序把多份 PDF 拼成一份新 PDF（输入只读、产物新建、永不覆盖）。 */
async function cmdCombine(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'combine');
  if (positional.length < 2) die('invalid-output', `combine 至少要两个输入（给了 ${positional.length} 个）`, '用法：combine <输入1.pdf> <输入2.pdf> [更多…] [--out 文件]；单件复制不是本命令的活');
  // 🔴 F6 补口（2026-10-14 自查）：combine 收 2..N 份，只拦第一路等于漏拦——第 2 份起照样整件 readFileSync 进内存。
  // 先数完位置参数再逐路量，文案里点名是第几路（调用方才知道要挪哪一份）。
  for (let gi = 0; gi < positional.length; gi += 1) inputSizeGuard(positional[gi], flags['max-input-bytes'], `combine 第 ${gi + 1} 路输入`);
  const inputs = positional.map((p) => abs(p));
  for (const p of inputs) if (!fs.existsSync(p)) die('invalid-document', `输入不存在：${p}`, '先给绝对路径，或 ls 确认文件名');
  const pl = loadPdfLib();
  if (pl.error) die('unavailable', `pdf-lib 不在 node_modules（combine/split 的依赖）：${pl.error}`, PDFLIB_NEXT);
  const { PDFDocument } = pl.lib;
  const sources = []; const docs = [];
  for (const p of inputs) {
    const b = fs.readFileSync(p);
    if (b.slice(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', `不是 PDF（按 magic 判）：${p}`, 'combine/split 只吃 PDF；其它格式先 to 成 pdf 再拼');
    let d = null; let pgN = 0;
    try { d = await PDFDocument.load(b); pgN = d.getPageCount(); }   // 触树：pdf-lib 对"只有头 + 垃圾"是宽容的，结构坏要在这一层分野
    catch (e) {
      const msg = String((e && e.message) || e);
      const enc = /encrypt/i.test(msg);
      die(enc ? 'unsupported-format' : 'invalid-document', enc ? `加密 PDF 不在支持面：${p}` : `读不通这份 PDF：${p}（${msg.slice(0, 160)}）`, enc ? '先解密再拼；装置不碰加密件——不接受"忽略加密"一类绕法' : '这份 PDF 结构读不通（可能损坏）：换来源或先 inspect');
    }
    sources.push({ path: p, bytes: b.length, sha256: sha256(b), pages: pgN });
    docs.push(d);
  }
  const firstBase = path.basename(inputs[0], '.' + extOf(inputs[0]));
  const outPath = flags['out'] ? abs(flags['out']) : freePath(OUT_DIR, `${firstBase}-combined-${stamp()}`, 'pdf');
  if (flags['out'] && fs.existsSync(outPath)) die('invalid-output', `输出已存在：${outPath}`, '装置从不覆盖：换输出路径，或先确认那份要不要留');
  const merged = await PDFDocument.create();
  for (let i = 0; i < docs.length; i++) {
    let pages = null;
    try { pages = await merged.copyPages(docs[i], docs[i].getPageIndices()); }
    catch (e) { die('invalid-document', `复制页时读不通第 ${i + 1} 份 PDF（${sources[i].path}）：${String((e && e.message) || e).slice(0, 140)}`, '这份 PDF 结构读不通：换来源或先 inspect'); }
    for (const pg of pages) merged.addPage(pg);
  }
  let bytes = null;
  try { bytes = await merged.save(); fs.writeFileSync(outPath, bytes); }
  catch (e) { die('invalid-output', `产物写不进去：${outPath}（${String((e && e.message) || e).slice(0, 140)}）`, '父目录必须已存在；换个输出路径再试'); }
  out({ ok: true, op: 'combine', ms: Date.now() - t0, out: { path: outPath, bytes: bytes.length, sha256: sha256(bytes) }, pages: merged.getPageCount(), sources, note: '输入逐件只读（哈希在 sources[]）；产物是新文件，从不覆盖已有文件；加密件与表单不在 v1 支持面' });
}

/** v1.9.0 split：按区间/每 N 页/逐页把一份 PDF 拆进新目录（输入只读、产物新建）。 */
async function cmdSplit(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'split');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'split'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入文件', '用法：split <输入.pdf> [--ranges 1-3,5,7-] [--every n] [--dir 目录]（都不给＝逐页拆）');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '先给绝对路径，或 ls 确认文件名');
  const hasRanges = flags['ranges'] !== undefined, hasEvery = flags['every'] !== undefined;
  if (hasRanges && hasEvery) die('invalid-output', '--ranges 与 --every 互斥（一次只能选一种拆法）', '按区间拆用 --ranges；每 N 页一片用 --every；都不给＝逐页拆');
  const b = fs.readFileSync(input);
  if (b.slice(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', `不是 PDF（按 magic 判）：${input}`, 'split 只吃 PDF');
  const pl = loadPdfLib();
  if (pl.error) die('unavailable', `pdf-lib 不在 node_modules：${pl.error}`, PDFLIB_NEXT);
  const { PDFDocument } = pl.lib;
  let src = null; let n = 0;
  try { src = await PDFDocument.load(b); n = src.getPageCount(); }   // 触树：pdf-lib 对"只有头 + 垃圾"是宽容的，结构坏要在这一层分野
  catch (e) {
    const msg = String((e && e.message) || e);
    const enc = /encrypt/i.test(msg);
    die(enc ? 'unsupported-format' : 'invalid-document', enc ? `加密 PDF 不在支持面：${input}` : `读不通这份 PDF（${msg.slice(0, 160)}）`, enc ? '先解密再拆；装置不碰加密件——不接受"忽略加密"一类绕法' : '结构读不通（可能损坏）：换来源或先 inspect');
  }
  let mode = null; const ranges = [];
  if (hasRanges) {
    mode = 'ranges';
    for (const tok of String(flags['ranges']).split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^(\d+)(?:-(\d*))?$/.exec(tok);
      if (!m) die('invalid-output', `--ranges 段 ${JSON.stringify(tok)} 读不懂`, '形状：逗号分隔的 N、N-M、N-（1 起、闭区间、N- 到末页），如 1-3,5,7-');
      const a = Number(m[1]);
      const bEnd = m[2] === undefined ? a : (m[2] === '' ? n : Number(m[2]));
      if (a < 1 || bEnd < a) die('invalid-output', `--ranges 段 ${JSON.stringify(tok)} 越界或倒序（要求 1 ≤ a ≤ b）`, `本件共 ${n} 页；形状如 1-3,5,7-，序号从 1 起`);
      if (bEnd > n) die('invalid-output', `--ranges 段 ${JSON.stringify(tok)} 超出总页数（本件共 ${n} 页）`, `把区间收进 1…${n}，或先确认文件是不是拿错了`);
      ranges.push([a, bEnd]);
    }
    if (!ranges.length) die('invalid-output', '--ranges 是空清单', '给逗号分隔的段，如 1-3,5');
  } else if (hasEvery) {
    mode = 'every';
    const k = Number(flags['every']);
    if (!Number.isInteger(k) || k < 1) die('invalid-output', `--every 必须是不小于 1 的整数，给了 ${JSON.stringify(flags['every'])}`, '--every 2 表示每 2 页一件');
    for (let s = 1; s <= n; s += k) ranges.push([s, Math.min(s + k - 1, n)]);
  } else {
    mode = 'per-page';
    for (let s = 1; s <= n; s += 1) ranges.push([s, s]);
  }
  if (ranges.length > SPLIT_MAX_OUTPUTS) die('invalid-output', `按这种拆法会出 ${ranges.length} 件，超过上限 ${SPLIT_MAX_OUTPUTS}（不静默截断）`, `用 --ranges 合并成更少的段或增大 --every 让每件多装几页（本件共 ${n} 页）`);
  const dir = ensureDir(freeDir(flags['dir'] ? abs(flags['dir']) : OUT_DIR, `${path.basename(input, '.' + extOf(input))}-split-${stamp()}`));
  const base = path.basename(input, '.' + extOf(input));
  const outputs = [];
  for (const [a, bEnd] of ranges) {
    const d = await PDFDocument.create();
    const idx = []; for (let i = a; i <= bEnd; i++) idx.push(i - 1);
    const pages = await d.copyPages(src, idx);
    for (const pg of pages) d.addPage(pg);
    const file = `${base}-p${a}${bEnd === a ? '' : '-' + bEnd}.pdf`;
    const bytes = await d.save();
    fs.writeFileSync(path.join(dir, file), bytes);
    outputs.push({ file, path: path.join(dir, file), bytes: bytes.length, sha256: sha256(bytes), pages: bEnd - a + 1, range: [a, bEnd] });
  }
  out({ ok: true, op: 'split', ms: Date.now() - t0, mode, source: { path: input, bytes: b.length, sha256: sha256(b), pages: n }, dir, outputs, note: '输入只读；产物是新文件、落新目录（永不覆盖）；一次最多 ' + SPLIT_MAX_OUTPUTS + ' 件' });
}

/** v2.2.0 pageops：PDF 旋转/删页/重排（pdf-lib，输入只读、产物新建；不碰加密、不做解密；水印机主裁不做）。 */
async function cmdPageops(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'pageops');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'pageops'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入文件', '用法：pageops <输入.pdf> <rotate|delete|order> <参数> [--pages 1-3] [--out 文件]');
  const action = positional[1];
  if (!['rotate', 'delete', 'order'].includes(action)) die('invalid-output', `动作须是 rotate/delete/order，给了 ${JSON.stringify(action)}`, 'rotate 旋转 / delete 删页 / order 重排');
  if (positional[2] === undefined) die('invalid-output', `缺 ${action} 的参数`, 'rotate 给 90/180/270；delete 给逗号页清单；order 给逗号页序');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '先给绝对路径，或 ls 确认文件名');
  const b = fs.readFileSync(input);
  if (b.slice(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', `不是 PDF（按 magic 判）：${input}`, 'pageops 只吃 PDF');
  const pl = loadPdfLib();
  if (pl.error) die('unavailable', `pdf-lib 不在 node_modules：${pl.error}`, PDFLIB_NEXT);
  const { PDFDocument } = pl.lib;
  let src = null; let n = 0;
  try { src = await PDFDocument.load(b); n = src.getPageCount(); }
  catch (e) {
    const msg = String((e && e.message) || e);
    const enc = /encrypt/i.test(msg);
    die(enc ? 'unsupported-format' : 'invalid-document', enc ? `加密 PDF 不在支持面：${input}` : `读不通这份 PDF（${msg.slice(0, 160)}）`, enc ? '先解密再操作；装置不碰加密件——不接受绕加密' : '结构读不通（可能损坏）：换来源或先 inspect');
  }
  // 解析逗号页清单（N、N-M，1 起）→ 0 基索引数组（v2.4.0 抽公共 parsePageList，页码语义单一来源）
  const parsePages = (spec) => parsePageList(spec, n);
  const base = path.basename(input, '.' + extOf(input));
  const outPath = flags['out'] ? abs(flags['out']) : freePath(OUT_DIR, `${base}-${action}-${stamp()}`, 'pdf');
  if (flags['out'] && fs.existsSync(outPath)) die('invalid-output', `输出已存在：${outPath}`, '装置从不覆盖：换输出路径');
  let result = null;
  if (action === 'rotate') {
    const deg = Number(positional[2]);
    if (![90, 180, 270].includes(deg)) die('invalid-output', `rotate 角度须为 90/180/270，给了 ${JSON.stringify(positional[2])}`, '只支持 90 的整数倍（绝对角度，不叠加原 /Rotate）');
    const all = src.getPages();
    const targets = flags['pages'] !== undefined ? parsePages(flags['pages']) : src.getPageIndices();
    const before = {};
    for (const i of targets) { before[i + 1] = all[i].getRotation().angle; all[i].setRotation({ type: 'degrees', angle: deg }); }
    const bytes = await src.save();
    fs.writeFileSync(outPath, bytes);
    result = { op: 'rotate', out: { path: outPath, bytes: bytes.length, sha256: sha256(bytes) }, pages: n, rotatedPages: targets.map((i) => i + 1), angle: deg, before };
  } else {
    let seq = null;
    if (action === 'delete') {
      const del = new Set(parsePages(positional[2]));
      if (del.size === n) die('invalid-output', '不能删光全部页（产物至少留 1 页）', 'delete 至少保留 1 页');
      seq = src.getPageIndices().filter((i) => !del.has(i));
    } else {
      const given = parsePages(positional[2]);
      const seen = new Set(given);
      if (given.length !== n || seen.size !== n) die('invalid-output', `order 须给出全部 ${n} 页且不重复（给了 ${given.length} 页、去重 ${seen.size}）`, '重排要列出 1..N 各一次，如 3,1,2');
      seq = given;
    }
    const d = await PDFDocument.create();
    const copied = await d.copyPages(src, seq);
    for (const pg of copied) d.addPage(pg);
    const bytes = await d.save();
    fs.writeFileSync(outPath, bytes);
    result = { op: action, out: { path: outPath, bytes: bytes.length, sha256: sha256(bytes) }, pages: d.getPageCount(), pageOrder: seq.map((i) => i + 1) };
  }
  out({ ok: true, ms: Date.now() - t0, ...result, source: { path: input, bytes: b.length, sha256: sha256(b), pages: n }, note: '输入只读、产物新建（永不覆盖）；加密件不支持；不做解密；🔴 水印机主 2026-10-11 裁不做（v2.4.0 曾实现当轮撤）' });
}


/** v2.2.0 pipeline：多步串联；v2.4.0 起扩成**逗号步序列**（步 ∈ to/pages/ocr/pdftext），
 *  旧名 to-pages／to-pages-ocr 保留为别名。逐步 spawn 子进程、串接路径；任一步失败即停并报 failedStep。
 *  通用条件分支/并行 DAG 仍挂账（本条只把"固定两个 flow"放开为"可组合的线性步序列"）。 */
/** v2.7.0：pipeline 的 **DAG 执行器**（`--dag flow.json`）——节点带 id／step／needs（依赖）／args（该步子参数）／when（条件）。
 *  语义与线性支序列一致：逐步子进程、任一节点失败即停并出一行 JSON＋退码 1、输入只读、中间产物落 workDir。
 *  🔴 两点说破：① **不做并发**——按拓扑序确定性串行执行（并发会把"读数"变成负载的函数，那测的是机器不是正确性）；
 *  ② `when` 只看**上游那一步自己回报的 JSON 字段**，装置不猜文件内容；谓词不成立 ⇒ 该节点 skip 并**传染给下游**（记 status:skipped，不冒充跑过）。
 *  只允许一个 `to` 节点（多入口＝多个源文件，那是多跑几次 pipeline，不是这张图该管的）。 */
function pipelineDag({ input, workDir, flags, runStep, PIPE_STEPS, t0 }) {
  const df = abs(String(flags.dag));
  if (!fs.existsSync(df)) die('invalid-document', `--dag 的文件不存在：${df}`, '必须是 **JSON 文件路径**（本机 shell 引号会吃掉内联 JSON）');
  let spec = null;
  try { spec = JSON.parse(str(fs.readFileSync(df))); } catch (e) { die('invalid-document', `--dag 不是合法 JSON：${String(e.message).slice(0, 140)}`, '形状：{"nodes":[{"id":"pdf","step":"to"},{"id":"png","step":"pages","needs":["pdf"]}]}'); }
  if (!spec || !Array.isArray(spec.nodes) || !spec.nodes.length) die('invalid-output', '--dag 的 JSON 必须有非空的 nodes 数组', '至少一个节点：{"nodes":[{"id":"a","step":"to"}]}');
  const ids = new Set(); const nodes = [];
  for (const [i, n] of spec.nodes.entries()) {
    if (!n || typeof n !== 'object') die('invalid-output', `nodes[${i}] 不是对象`, '每个节点要 {id, step}，可带 needs/args/when');
    if (typeof n.id !== 'string' || !n.id.trim()) die('invalid-output', `nodes[${i}] 缺 id（字符串）`, 'id 是 needs／when 引用它的键');
    if (ids.has(n.id)) die('invalid-output', `节点 id 重复：${n.id}`, 'id 必须唯一');
    if (typeof n.step !== 'string' || !PIPE_STEPS.includes(n.step)) die('invalid-output', `节点 ${n.id} 的 step ${JSON.stringify(n.step)} 不在可用步里`, `可用步：${PIPE_STEPS.join('/')}`);
    if (n.needs !== undefined && !Array.isArray(n.needs)) die('invalid-output', `节点 ${n.id} 的 needs 必须是数组`, '如 "needs":["pdf"]');
    ids.add(n.id); nodes.push(n);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) for (const d of (n.needs || [])) if (!byId.has(d)) die('invalid-output', `节点 ${n.id} 依赖了不存在的 id ${JSON.stringify(d)}`, 'needs 只能引用本图里的节点 id');
  if (nodes.filter((n) => n.step === 'to').length > 1) die('invalid-output', '这张图里有多个 to 节点', 'to 吃源文件，一个图只放一个；多份文件就分别跑多次 pipeline');
  // 拓扑排序（Kahn）＋同层按 id 码元序——顺序必须唯一可预测，否则同一张图两次跑出不同 steps[]
  const indeg = new Map(nodes.map((n) => [n.id, (n.needs || []).length]));
  const children = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of (n.needs || [])) children.get(d).push(n.id);
  const order = [];
  let ready = [...indeg.entries()].filter(([, v]) => v === 0).map(([k]) => k).sort();
  while (ready.length) {
    const id = ready.shift(); order.push(byId.get(id));
    for (const c of children.get(id)) { indeg.set(c, indeg.get(c) - 1); if (indeg.get(c) === 0) ready.push(c); }
    ready.sort();
  }
  if (order.length !== nodes.length) die('invalid-output', 'needs 里有环，拓扑排序跑不完', `已排出的节点：${order.map((n) => n.id).join('→')}；把循环依赖拆开（DAG 不许成环）`);
  const WHEN_OPS = ['eq', 'ne', 'lt', 'lte', 'gte', 'exists', 'missing'];
  const whenOk = (w, resOf) => {
    if (!w) return true;
    if (typeof w !== 'object') die('invalid-output', 'when 必须是对象 {step, field, op, value}', '例：{"step":"pdf","field":"pageCount","op":"lte","value":3}');
    if (typeof w.step !== 'string' || !byId.has(w.step)) die('invalid-output', `when.step ${JSON.stringify(w.step)} 不是本图里的节点 id`, '只能引用同一张图里的节点');
    if (!WHEN_OPS.includes(w.op)) die('invalid-output', `when.op ${JSON.stringify(w.op)} 不认识`, `可用谓词：${WHEN_OPS.join('/')}`);
    const src = resOf.get(w.step);
    if (src === undefined) die('invalid-output', `when 引用的节点 ${w.step} 这次没跑出结果（它被跳过或失败）`, 'when 只能看已执行节点回报的 JSON 字段');
    const got = w.field === undefined ? undefined : src[w.field];
    if (w.op === 'exists') return got !== undefined && got !== null;
    if (w.op === 'missing') return got === undefined || got === null;
    if (typeof w.value !== typeof got && typeof got !== 'number') die('invalid-output', `when 的 ${w.step}.${w.field} 类型（${typeof got}）与 value（${typeof w.value}）比不了`, '同类型才比：数字对数字、字符串对字符串');
    if (w.op === 'eq') return got === w.value;
    if (w.op === 'ne') return got !== w.value;
    if (w.op === 'lt') return got < w.value; if (w.op === 'lte') return got <= w.value;
    if (w.op === 'gte') return got >= w.value;
    return false;
  };
  const isPdf = inputIsPdf(input);
  const resOf = new Map(); const skippedIds = new Set(); const nodesOut = [];
  let mid = input; let pageCount = null;
  for (const n of order) {
    const blocked = (n.needs || []).some((d) => skippedIds.has(d));
    if (blocked) { skippedIds.add(n.id); nodesOut.push({ id: n.id, step: n.step, status: 'skipped', reason: `依赖的节点被跳过：${(n.needs || []).filter((d) => skippedIds.has(d)).join(',')}` }); continue; }
    if (!whenOk(n.when, resOf)) { skippedIds.add(n.id); nodesOut.push({ id: n.id, step: n.step, status: 'skipped', reason: 'when 谓词不成立', when: n.when || null }); continue; }
    if (n.step === 'to') {
      if (isPdf) { skippedIds.add(n.id); nodesOut.push({ id: n.id, step: 'to', status: 'skipped', reason: '输入已是 PDF（与线性支路的 to 跳过同语义）' }); continue; }
      const a = n.args && n.args.out ? String(n.args.out) : path.join(workDir, `${n.id}.pdf`);
      const j = runStep(n.id, ['to', input, a]);
      mid = j.output.path;
      resOf.set(n.id, j); nodesOut.push({ id: n.id, step: 'to', status: 'ok', out: j.output.path, bytes: j.output.bytes, missingFonts: j.missingFonts || [] });
      continue;
    }
    const j0 = (() => {
      if (n.step === 'pages') { const arg = ['pages', mid]; if (n.args && n.args.dpi !== undefined) arg.push('--dpi', String(n.args.dpi)); else if (flags.dpi !== undefined) arg.push('--dpi', String(flags.dpi)); return runStep(n.id, arg); }
      if (n.step === 'ocr') { const arg = ['ocr', mid]; if (n.args && n.args.lang !== undefined) arg.push('--lang', String(n.args.lang)); else if (flags.lang !== undefined) arg.push('--lang', String(flags.lang)); return runStep(n.id, arg); }
      if (n.step === 'pdftext') return runStep(n.id, ['pdftext', mid, '--out', path.join(workDir, `${n.id}.txt`)]);
      return null;
    })();
    if (n.step === 'pages') pageCount = j0.pageCount;
    resOf.set(n.id, j0);
    nodesOut.push({ id: n.id, step: n.step, status: 'ok', ...(n.step === 'pages' ? { pageCount: j0.pageCount, dir: j0.dir } : {}), ...(n.step === 'ocr' ? { backend: j0.backend, pages: (j0.pages || []).map((p) => ({ lines: p.lines, chars: p.chars })) } : {}), ...(n.step === 'pdftext' ? { file: j0.file, chars: j0.chars, lines: j0.lines } : {}) });
  }
  const skipped = nodesOut.filter((x) => x.status === 'skipped').length;
  out({
    ok: true, op: 'pipeline', mode: 'dag', ms: Date.now() - t0, dag: df, input, skippedTo: isPdf,
    nodes: nodesOut, order: nodesOut.map((x) => x.id), steps: nodesOut.filter((x) => x.status === 'ok').map((x) => ({ step: x.step, ...x })),
    workDir, pageCount, skippedCount: skipped,
    note: 'DAG 执行器：needs 定依赖、when 定条件分支（看上游自己回报的 JSON 字段），按拓扑序**确定性串行**执行——并发明确不做（读数会变成就在测负载而不是测正确性）；任一节点失败即停报 failedStep',
  });
}
function cmdPipeline(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'pipeline');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'pipeline'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入文件', '用法：pipeline <输入> <flow> [--lang eng] [--dpi n]；条件分支与依赖用 pipeline <输入> --dag flow.json');
  const FLOW_ALIAS = { 'to-pages': ['to', 'pages'], 'to-pages-ocr': ['to', 'pages', 'ocr'] };
  const PIPE_STEPS = ['to', 'pages', 'ocr', 'pdftext'];
  const flow = positional[1];
  let flowSteps = null;
  if (flags.dag === undefined) {
    if (!flow) die('invalid-output', '缺 flow（步序列）', `可用步：${PIPE_STEPS.join('/')}（逗号串联，如 to,pages,ocr）；旧写法 to-pages／to-pages-ocr 仍可用；要条件分支与依赖就 --dag flow.json`);
    if (FLOW_ALIAS[flow]) flowSteps = FLOW_ALIAS[flow];
    else {
      flowSteps = String(flow).split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of flowSteps) if (!PIPE_STEPS.includes(s)) die('invalid-output', `flow 里有未知步 ${JSON.stringify(s)}`, `可用步：${PIPE_STEPS.join('/')}（逗号串联）；旧写法 to-pages／to-pages-ocr 仍可用；条件分支与依赖走 --dag flow.json`);
      if (!flowSteps.length) die('invalid-output', 'flow 为空', `可用步：${PIPE_STEPS.join('/')}（逗号串联）`);
    }
  }
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '先给绝对路径，或 ls 确认文件名');
  const workDir = ensureDir(freeDir(OUT_DIR, `pipeline-${stamp()}`));
  const steps = [];
  const runStep = (label, stepArgs) => {
    const p = spawnSync(process.execPath, [__filename, ...stepArgs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ }
    if (!j || j.ok !== true) {
      out({ ok: false, op: 'pipeline', flow, steps, workDir, failedStep: label, code: j ? j.code : 'failed', error: j ? j.error : `子步非 JSON：${String(p.stderr).slice(0, 140)}`, next: j ? j.next : '把本行 JSON 原样回报；上游步骤产物在 steps[]' });
      process.exit(1);   // 失败即停：只出一行、退码 1
    }
    return j;
  };
  // ---- v2.7.0：--dag 走图执行器（条件分支＋依赖），线性支路照旧留在上面那条路 ----
  if (flags.dag !== undefined) return pipelineDag({ input, workDir, flags, runStep, PIPE_STEPS, t0 });
  // 输入是否已是 PDF（只读前 5 字节）
  const isPdf = inputIsPdf(input);
  let mid = input;            // 当前 PDF 中间件（to 会换它；其余步吃它不换）
  let pageCount = null;
  let state = isPdf ? 'pdf' : 'source';
  for (let si = 0; si < flowSteps.length; si++) {
    const stepName = flowSteps[si];
    if (stepName === 'to') {
      if (si !== 0) die('invalid-output', 'to 只能是 flow 的第一步（它吃 Office 文档；pages/ocr/pdftext 都吃 PDF）', `把 to 放最前，如 to,${flowSteps.filter((s) => s !== 'to').join(',') || 'pages'}`);
      if (state === 'pdf') { continue; }   // 输入已是 PDF：跳过 to（steps 里不出现 to——v2.2.x 的 steps 契约，跳过信息走顶层 skippedTo）
      const s1 = runStep('to', ['to', input, path.join(workDir, 'step1.pdf')]);
      mid = s1.output.path; state = 'pdf';
      steps.push({ step: 'to', out: s1.output.path, bytes: s1.output.bytes, missingFonts: s1.missingFonts || [] });
      continue;
    }
    if (state !== 'pdf') die('invalid-output', `${stepName} 步需要 PDF：这份输入不是 PDF 且 flow 里没有 to 步`, `在前面加 to，如 to,${flowSteps.join(',')}`);
    if (stepName === 'pages') {
      const pagesArgs = ['pages', mid]; if (flags.dpi !== undefined) pagesArgs.push('--dpi', String(flags.dpi));
      const sp = runStep('pages', pagesArgs);
      pageCount = sp.pageCount;
      steps.push({ step: 'pages', pageCount: sp.pageCount, dir: sp.dir, missingFonts: sp.missingFonts || [] });
    } else if (stepName === 'ocr') {
      const ocrArgs = ['ocr', mid]; if (flags.lang !== undefined) ocrArgs.push('--lang', String(flags.lang));
      const so = runStep('ocr', ocrArgs);
      steps.push({ step: 'ocr', backend: so.backend, pages: (so.pages || []).map((p) => ({ lines: p.lines, chars: p.chars })) });
    } else if (stepName === 'pdftext') {
      const pt = runStep('pdftext', ['pdftext', mid, '--out', path.join(workDir, 'pdftext.txt')]);
      steps.push({ step: 'pdftext', file: pt.file, chars: pt.chars, lines: pt.lines });
    }
  }
  out({ ok: true, op: 'pipeline', ms: Date.now() - t0, flow, skippedTo: isPdf, steps, workDir, pageCount, note: '逐步子进程串联（步序列见 steps）；任一步失败即停并报 failedStep；输入只读、中间产物落 workDir；通用条件分支/并行 DAG 仍挂账' });
}

/** v2.3.0：markdown——文档 → GFM Markdown（摄取向：把结伴格式取成 LLM/笔记友好的文本）。
 *  后端 pandoc（原生 CLI、不触 ADR-001）；与 pdftext/ocr 同隐私口径：产物只落 .md 文件、正文不回显进 JSON。
 *  输入只读、产物新建永不覆盖；缺 pandoc 回 unavailable＋指路 DOCKIT_PANDOC；PDF 输入指路 pdftext。 */
function cmdMarkdown(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'markdown');
  if (!positional[0]) die('invalid-document', '缺输入文档', '用法：markdown <输入文档> [输出.md] [--wrap none|auto|preserve]（help markdown 看全）');
  if (positional.length > 2) die('invalid-output', 'markdown 最多收"输入 [输出]"两个位置参数', '一次转一件；多件请逐次调用');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const inExt = extOf(input);
  const famExts = ['docx', 'odt', 'pptx', 'xlsx'];
  if (!MARKDOWN_INPUT_EXTS.includes(inExt)) {
    const hint = inExt === 'pdf' ? 'PDF 取字走 pdftext（文本层直取、免 OCR）；扫描件无文本层走 pages＋ocr'
      : (inExt === 'doc' || inExt === 'xls' || inExt === 'ppt') ? 'OLE 老格式 pandoc 不读：先 `to` 转成新族（docx/xlsx/pptx）再跑本条'
        : '支持面见 help markdown；纯文本无需转换，直接读原文件';
    die('unsupported-format', `markdown 不吃 .${inExt}（支持：${MARKDOWN_INPUT_EXTS.join('/')}）`, hint);
  }
  const inBuf = fs.readFileSync(input);
  if (famExts.includes(inExt) && (inBuf.length < 4 || inBuf.readUInt32LE(0) !== 0x04034b50)) {
    die('invalid-document', `.${inExt} 但按 ZIP 读不通（magic 不符：伪装件或坏件）`, '先 dump/inspect 看容器形状；坏件从来源重取');
  }
  const wrap = flags.wrap !== undefined && flags.wrap !== null ? String(flags.wrap) : MARKDOWN_DEFAULT_WRAP;
  if (!MARKDOWN_WRAPS.includes(wrap)) die('invalid-output', `--wrap 只认 ${MARKDOWN_WRAPS.join('/')}，给了 ${JSON.stringify(flags.wrap)}`, '--wrap none 不硬折行（默认）；auto 按列宽折；preserve 保留原换行');
  // v2.5.0：修订足迹三态（透传 pandoc --track-changes；只对 docx 输入有效）
  const trackChanges = flags['track-changes'] !== undefined && flags['track-changes'] !== null ? String(flags['track-changes']).toLowerCase() : null;
  if (trackChanges !== null && !['accept', 'reject', 'all'].includes(trackChanges)) die('invalid-output', `--track-changes 只认 accept/reject/all，给了 ${JSON.stringify(flags['track-changes'])}`, 'accept＝接受修订后的视图（与不传等价）；reject＝按拒绝修订的视图；all＝两个方向都带出（含 insertion/deletion 标记与 author）');
  if (trackChanges !== null && inExt !== 'docx') die('invalid-output', `--track-changes 只对 .docx 输入有意义（pandoc 的修订面只在 Word 族），当前输入是 .${inExt}`, '去掉 --track-changes；旧族 .doc 先 to 转 docx 再来');
  const timeoutMs = Number(flags['timeout-ms'] ?? DEFAULT_TIMEOUT_MS);
  let outPath;
  if (positional[1]) { outPath = abs(positional[1]); if (fs.existsSync(outPath)) die('invalid-output', `输出已存在，绝不覆盖：${outPath}`, '换个输出路径，或省略让装置落 _out 自动去重'); ensureDir(path.dirname(outPath)); }
  else outPath = freePath(OUT_DIR, `${path.basename(input, '.' + inExt)}-md-${stamp()}`, 'md');
  if (abs(input) === abs(outPath)) die('invalid-output', '输入与输出是同一个文件', '装置按设计拒绝原地覆盖，请另给输出路径');
  const pd = requirePandoc();
  const pargs = [input, '-t', 'gfm', '--wrap=' + wrap];
  if (trackChanges !== null) pargs.push('--track-changes=' + trackChanges);
  pargs.push('-o', outPath);
  const r = spawnSync(pd.exe, pargs, { encoding: 'utf8', timeout: timeoutMs });
  if (r.signal === 'SIGTERM') die('timeout', `pandoc 超预算（--timeout-ms=${timeoutMs}）`, nextFor('timeout', {}));
  if (r.error) die('failed', `pandoc 进程调用失败：${String(r.error).slice(0, 160)}`, 'ENOENT 多半是 DOCKIT_PANDOC 指错；其它看 error 原文');
  if (r.status !== 0) {
    // pandoc 的失败文案（英文）原样带出但压行截断；产物可能半存在——不改动它，红在明处
    const err = String(r.stderr || r.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    die('invalid-document', `pandoc 读不了这份文档（退码 ${r.status}）：${err || '(无输出)'}`, '坏件或非标准容器：先 dump/inspect 看形状，必要时从来源重取');
  }
  // 产物回读由装置自己做（不信子进程自报）：退码 0 但没产物同样红
  if (!fs.existsSync(outPath)) die('failed', `pandoc 退码 ${r.status} 但产物没落盘：${outPath}`, '把本行 JSON 原样回报给调用方，不要重试');
  const md = str(fs.readFileSync(outPath));
  const nonEmpty = md.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  const warnings = [];
  if (nonEmpty === 0) warnings.push('产物为空：pandoc 没读出任何内容（空文档或容器里没有正文）。空是数据不是错误，但别把它当成"文档无字"的结论');
  out({ ok: true, op: 'markdown', backend: 'pandoc', tool: pd.exe, toolSource: pd.source, input: { path: input, bytes: inBuf.length, sha256: sha256(inBuf) }, output: { path: outPath, bytes: fs.statSync(outPath).size, sha256: sha256(fs.readFileSync(outPath)) }, chars: md.length, lines: nonEmpty, wrap, trackChanges: trackChanges === null ? 'accept(default)' : trackChanges, ms: Date.now() - t0, warnings: warnings.length ? warnings : undefined, note: '文档→GFM markdown（摄取向；pandoc 原生 CLI、不触 ADR-001）。正文只落 .md 文件、不回显进 JSON（与 ocr/pdftext 同一隐私口径）；输入只读、产物新建；.doc/.xls/.ppt 老族先走 to 转新族、PDF 取字走 pdftext' });
}

/** v2.5.0 pdfform：PDF AcroForm 表单的**受控填写**——--list 列字段；--data 按 JSON 填值（text/checkbox/radio/dropdown/optionlist），
 *  可选 --flatten 扁平化。定盘语义与 merge 同族：输入只读、产物新建、绝不覆盖；写后由装置**重新装载产物逐字段回读对账**
 *  （不信内存态自报）。只吃 AcroForm（XFA/加密拒绝）；签名类字段不支持（命中即整单拒绝）。值不回显进回报。
 *  CJK 值走嵌入字体：@pdf-lib/fontkit + 单体 TTF（候选位见 PDFFORM_FONT_CANDIDATES，--font 可覆盖）。 */
async function cmdPdfform(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'pdfform');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'pdfform'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入 PDF', '用法：pdfform <输入.pdf> --list | --data 数据.json [--flatten] [--font 字体.ttf] [--out 文件]（help pdfform 看全）');
  if (positional.length > 1) die('invalid-output', 'pdfform 只收一个输入', '一次填一件；多件请逐次调用');
  const wantList = flags.list === true;
  const dataPath = flags.data !== undefined && flags.data !== null ? abs(String(flags.data)) : null;
  if (wantList === !!dataPath) die('invalid-output', wantList ? '--list 与 --data 互斥（列字段和填值是两件事）' : '要么 --list 列字段、要么 --data 填值（二选一）', '先 --list 看字段名与类型，再按它写数据文件');
  if (wantList && (flags.flatten || flags.font || flags.out)) die('invalid-output', '--list 只列字段、不写文件：--flatten/--font/--out 都只在填值时有意义', '去掉多余开关；填值用 --data 路线');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const buf = fs.readFileSync(input);
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', 'pdfform 只吃 PDF（按 magic 判，不看后缀）', 'OOXML 模板填充走 merge；这份不是 PDF：先 inspect 看容器识别');
  const pl = loadPdfLib();
  if (pl.error) die('unavailable', `pdf-lib 不在 node_modules：${pl.error}`, PDFLIB_NEXT);
  const { PDFDocument, PDFName, PDFDict } = pl.lib;
  let doc = null;
  try { doc = await PDFDocument.load(buf, { updateMetadata: false }); }
  catch (e) {
    const msg = String((e && e.message) || e);
    const enc = /encrypt/i.test(msg);
    die(enc ? 'unsupported-format' : 'invalid-document', enc ? `加密 PDF 不在支持面：${input}` : `读不通这份 PDF（${msg.slice(0, 160)}）`, enc ? '先解密再填；装置不绕加密' : '结构读不通（可能损坏）：换来源或先 inspect');
  }
  const acroRef = doc.catalog.get(PDFName.of('AcroForm'));
  const af = acroRef ? doc.catalog.lookup(PDFName.of('AcroForm')) : null;
  // 🔴 v2.5.0 实测：pdf-lib 会在 **getForm() 被调用时**静默剥掉 XFA（控制台打警告）——所以这道守卫必须跑在任何 getForm() 之前
  //（本命令顺序即如此：先查 XFA、再 getForm 列字段）。守卫若失效，XFA 件会被"先剥壳再填写"，产出静默残废的表单。变异 M180 钉这层。
  if (af instanceof PDFDict && af.get(PDFName.of('XFA'))) die('unsupported-format', 'XFA 动态表单不在支持面', '用 Acrobat/WPS 把表单导出为静态或展平后再来；装置只填 AcroForm');
  const form = acroRef ? doc.getForm() : null;
  const fields = form ? form.getFields() : [];
  const typeOf = (f) => { const c = (f.constructor && f.constructor.name) || ''; return c === 'PDFTextField' ? 'text' : c === 'PDFCheckBox' ? 'checkbox' : c === 'PDFRadioGroup' ? 'radio' : c === 'PDFDropdown' ? 'dropdown' : c === 'PDFOptionList' ? 'optionlist' : 'other:' + c; };
  const optionsOf = (f) => { try { return typeof f.getOptions === 'function' ? f.getOptions() : null; } catch { return null; } };
  if (wantList) {
    if (!fields.length) { out({ ok: true, op: 'pdfform', mode: 'list', ms: Date.now() - t0, input: { path: input, bytes: buf.length, sha256: sha256(buf) }, count: 0, fields: [], warnings: ['这份 PDF 没有 AcroForm 表单（interactive.form=null）——空结果是数据不是错误'], note: '只列字段名与类型（值不回显）' }); return; }
    const list = fields.map((f) => { const o = optionsOf(f); return Object.assign({ name: f.getName(), type: typeOf(f) }, o && o.length ? { options: o.slice(0, 60) } : {}); });
    out({ ok: true, op: 'pdfform', mode: 'list', ms: Date.now() - t0, input: { path: input, bytes: buf.length, sha256: sha256(buf) }, count: list.length, fields: list, note: '只列字段名与类型与选项（值不回显）；把要填的键写进 JSON 文件、用 --data 再跑' });
    return;
  }
  if (!fields.length) die('invalid-document', '这份 PDF 没有 AcroForm 表单（无处可填）', '先 inspect 看 interactive.form；扫描件/打印件不是表单；表格类需求走 xlsx/docx 路线');
  if (!fs.existsSync(dataPath)) die('invalid-document', `数据文件不存在：${String(flags.data)}`, '数据必须是 JSON 文件路径（不接内联 JSON）');
  let data = null;
  try { data = JSON.parse(str(fs.readFileSync(dataPath))); } catch (e) { die('invalid-document', `数据不是合法 JSON：${String((e && e.message) || e).slice(0, 120)}`, '修 JSON 或换文件'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) die('invalid-document', '数据必须是顶层对象（{"字段名": 值}）', '值只接字符串/数字/布尔');
  const keys = Object.keys(data);
  if (!keys.length) die('invalid-document', '数据是空对象：不假装“填了 0 个”', '把要填的字段名与值写进去');
  const byName = new Map(fields.map((f) => [f.getName(), f]));
  const unknown = keys.filter((k) => !byName.has(k));
  if (unknown.length) {
    const cand = nearestCandidates(unknown[0], fields.map((f) => f.getName()));
    die('invalid-output', `字段名不认识：${unknown.slice(0, 6).join('、')}`, `先 --list 看字段名单；${cand.length ? '最接近的：' + cand.join(' / ') + '；' : ''}可用字段（前 12）：${fields.map((f) => f.getName()).slice(0, 12).join('、')}`);
  }
  const plan = [];
  for (const k of keys) {
    const f = byName.get(k);
    const t = typeOf(f);
    const v = data[k];
    if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) die('invalid-document', `字段 ${k} 的值不是标量（只接字符串/数字/布尔）`, '复杂结构先拆平；嵌套对象与数组都会被拒');
    if (t === 'checkbox') { if (typeof v !== 'boolean') die('invalid-output', `字段 ${k} 是勾选框，值必须是 true/false（给了 ${typeof v}）`, 'true=勾上、false=取消'); plan.push({ k, f, t, v }); }
    else if (t === 'text') { plan.push({ k, f, t, v: String(v) }); }
    else if (t === 'radio' || t === 'dropdown' || t === 'optionlist') {
      const opts = optionsOf(f) || [];
      const sv = String(v);
      if (!opts.includes(sv)) die('invalid-output', `字段 ${k}（${t}）的选项里没有 ${JSON.stringify(sv)}`, `可选值：${opts.slice(0, 12).join('、')}${opts.length > 12 ? ' …' : ''}`);
      plan.push({ k, f, t, v: sv });
    } else die('invalid-output', `字段 ${k} 的类型 ${t} 不在支持面（text/checkbox/radio/dropdown/optionlist）`, '签名等字段装置不写；把它从数据里去掉再跑');
  }
  const needCjk = plan.some((p) => p.t === 'text' && /[^\x00-\xFF]/.test(p.v));
  let cjkFont = null, usedFontPath = null;
  if (needCjk) {
    const fk = loadFontkit();
    if (fk.error) die('unavailable', `中文字段值需要可嵌入字体，但 @pdf-lib/fontkit 不在 node_modules：${fk.error}`, FONTKIT_NEXT);
    usedFontPath = flags.font ? abs(String(flags.font)) : (PDFFORM_FONT_CANDIDATES.find((p) => fs.existsSync(p)) || null);
    if (!usedFontPath || !fs.existsSync(usedFontPath)) die('unavailable', '中文字段值需要一个可嵌入的单体 TTF：候选字体不在位', '用 --font 指一个中文 TTF（如 C:\\Windows\\Fonts\\仿宋_GB2312.ttf），或把候选位装好再跑');
    doc.registerFontkit(fk.lib);
    try { cjkFont = await doc.embedFont(fs.readFileSync(usedFontPath), { subset: true }); }
    catch (e) { die('failed', `嵌入字体失败（${usedFontPath}）：${String((e && e.message) || e).slice(0, 140)}`, '换一个单体 .ttf 再试（.ttc 集合不保证能嵌）'); }
  }
  const filled = [];
  for (const p of plan) {
    try {
      if (p.t === 'text') { p.f.setText(p.v); if (cjkFont && /[^\x00-\xFF]/.test(p.v)) p.f.updateAppearances(cjkFont); }
      else if (p.t === 'checkbox') { p.v ? p.f.check() : p.f.uncheck(); }
      else p.f.select(p.v);
      filled.push({ name: p.k, type: p.t });
    } catch (e) { die('failed', `字段 ${p.k} 写入失败：${String((e && e.message) || e).slice(0, 140)}`, '把本行 JSON 原样回报给调用方，不要换个字段名重试'); }
  }
  let outPath = null;
  if (flags.out) { outPath = abs(String(flags.out)); if (fs.existsSync(outPath)) die('invalid-output', `输出已存在，绝不覆盖：${outPath}`, '换个 --out，或省略让装置落 _out 自动去重'); ensureDir(path.dirname(outPath)); }
  else outPath = freePath(OUT_DIR, `${path.basename(input, '.' + extOf(input))}-filled-${stamp()}`, 'pdf');
  let bytesOut = null;
  try { bytesOut = await doc.save({ updateMetadata: false }); }
  catch (e) { die('failed', `保存失败：${String((e && e.message) || e).slice(0, 160)}`, '把本行 JSON 原样回报，不要重试'); }
  let back = null;
  try { back = await PDFDocument.load(bytesOut, { updateMetadata: false }); }
  catch (e) { die('failed', `产物回读装载失败：${String((e && e.message) || e).slice(0, 140)}`, '别用这份产物；把本条当装置缺陷报出来'); }
  {
    const bform = back.getForm();
    const bmap = new Map(bform.getFields().map((f) => [f.getName(), f]));
    const bads = [];
    for (const p of plan) {
      try {
        const f2 = bmap.get(p.k);
        if (!f2) { bads.push(p.k + '（回读找不到该字段）'); continue; }
        if (p.t === 'text') { if (String(f2.getText()) !== p.v) bads.push(p.k + '（文本不符）'); }
        else if (p.t === 'checkbox') { if (!!f2.isChecked() !== !!p.v) bads.push(p.k + '（勾选不符）'); }
        else { if (String(f2.getSelected()) !== p.v) bads.push(p.k + '（选中不符）'); }
      } catch (e) { bads.push(p.k + '（回读异常）'); }
    }
    if (bads.length) die('failed', `写后回读对账不符：${bads.slice(0, 6).join('、')}`, '别把这份产物当已填件外发；把本行 JSON 原样回报给调用方');
  }
  let flattened = false;
  if (flags.flatten) {
    try { back.getForm().flatten(); } catch (e) { die('failed', `扁平化失败：${String((e && e.message) || e).slice(0, 140)}`, '去掉 --flatten 重跑，或把本行 JSON 回报'); }
    try { bytesOut = await back.save({ updateMetadata: false }); } catch (e) { die('failed', `扁平化后保存失败：${String((e && e.message) || e).slice(0, 140)}`, '把本行 JSON 原样回报'); }
    flattened = true;
    let left = null;
    try { const chk = await PDFDocument.load(bytesOut, { updateMetadata: false }); const cform = chk.catalog.get(PDFName.of('AcroForm')) ? chk.getForm() : null; left = cform ? cform.getFields().length : 0; }
    catch (e) { left = '回读失败'; }
    if (left !== 0) die('failed', `扁平化自检不过（剩余字段 ${left}）`, '别用这份产物；把本条当装置缺陷报出来');
  }
  fs.writeFileSync(outPath, bytesOut);
  if (sha256(fs.readFileSync(input)) !== sha256(buf)) die('failed', '原件在填写期间出现变化（不该发生）', '把本条当装置缺陷报出来，不要换输出重试');
  out({
    ok: true, op: 'pdfform', mode: 'fill', ms: Date.now() - t0,
    input: { path: input, bytes: buf.length, sha256: sha256(buf) },
    output: { path: outPath, bytes: fs.statSync(outPath).size, sha256: sha256(fs.readFileSync(outPath)) },
    filledCount: filled.length, filled: filled.map((x) => x.name), untouchedFields: fields.length - filled.length,
    flattened, fontEmbedded: !!cjkFont, fontPath: cjkFont ? usedFontPath : undefined,
    note: '受控填写：只吃 AcroForm（XFA 拒绝）、签名类字段不写；输入只读、产物新建、永不覆盖；写后已重新装载产物逐字段回读对账；值不回显进回报',
  });
}

const COMMANDS = { doctor: cmdDoctor, to: cmdTo, pages: cmdPages, sheets: cmdSheets, recalc: cmdRecalc, scrub: cmdScrub, ocr: cmdOcr, inspect: cmdInspect, dump: cmdDump, factcheck: cmdFactcheck, verify: cmdVerify, check: cmdCheck, edit: cmdEdit, merge: cmdMerge, media: cmdMedia, batch: cmdBatch, combine: cmdCombine, split: cmdSplit, pdftext: cmdPdftext, pageops: cmdPageops, pipeline: cmdPipeline, markdown: cmdMarkdown, pdfform: cmdPdfform, selftest: cmdSelftest, help: cmdHelp, redline: cmdRedline, redact: cmdRedact, tables: cmdTables, frommd: cmdFrommd, compress: cmdCompress, sheetop: cmdSheetop, gc: cmdGc };

function parseArgs(args, cmd) {
  const positional = [], flags = {};
  // 🔴 开关的**类型来自 HELP_SPEC**（R1-a）。此前这里写死了一份 `['verify','all-lines','quiet']` 布尔名单，
  // 于是文档里当开关用的 `--deep` 放到最后一个位置就必死（实测 2026-10-06：`inspect 文件 --deep` 回
  // `invalid-output / "--deep 缺值"`）——调用方照《调用卡》的写法办事反而失败，就是命令面与实装漂移。
  const spec = specOf(cmd);
  const bools = new Set(spec ? spec.flags.filter((f) => f.type === 'boolean').map((f) => f.name) : []);
  for (const g of GLOBAL_FLAGS) bools.add(g);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      let key = a.slice(2);
      const eq = key.indexOf('=');
      const inline = eq >= 0 ? key.slice(eq + 1) : null;
      if (eq >= 0) key = key.slice(0, eq);
      // 🔴 R1-b（任务书 P1-5）：未知开关**必须拒绝并给最近邻候选**。实测的静默形状（2026-10-06，改前）：
      //    `to _probe/cn.docx --tiemout-ms 5` 回 **ok:true**、按默认 120000ms 跑完了——调用方以为设了 5ms。
      //    错拼不该被当成"没提这个开关"，更不该被当成"提了但没用"。
      if (spec && !spec.flags.some((f) => f.name === key) && !GLOBAL_FLAGS.includes(key)) {
        const pool = spec.flags.map((f) => f.name);
        const cand = nearestCandidates(key, pool);
        die('invalid-output', `未知开关 --${key}（${cmd} 不认它）`,
          (cand.length ? `最接近的开关：${cand.map((c) => '--' + c).join(' | ')}；` : '') + `该命令的开关全在此列：${pool.map((x) => '--' + x).join(' ') || '(这条命令没有开关)'}；用法 ${spec.usage}（全命令通用的只有 --json）`,
          { candidates: cand });
      }
      if (bools.has(key)) { flags[key] = inline === null ? true : inline !== 'false'; continue; }
      let v = inline;
      if (v === null) {
        const nx = args[i + 1];
        if (nx === undefined || nx.startsWith('--')) die('invalid-output', `--${key} 缺值`, `用法：${spec ? spec.usage : '命令 位置参数 开关'}；开关要么跟一个值，要么写成 --${key}=值`);
        v = nx; i++;
      }
      flags[key] = v;
    } else positional.push(a);
  }
  return { positional, flags };
}
/** 命令名 → HELP_SPEC 条目（未知名字回 null；用 hasOwnProperty 挡 Object.prototype 上的成员） */
const specOf = (cmd) => (cmd && Object.prototype.hasOwnProperty.call(HELP_SPEC, cmd) ? HELP_SPEC[cmd] : null);
//#endregion

//#region v2.7.0 生产与瘦身面：frommd / compress
/** v2.7.0：poppler 的中间件一律落**纯 ASCII 临时目录**（os.tmpdir()）并用 ASCII 文件名。
 *  实测：pdftotext 的 -bbox 输出参数给中文绝对路径时，argv 被按 ANSI 解成乱码 ⇒ "I/O Error: Couldn't open text file
 *  'D:/<非ASCII路径>…'"、退码 2；而 pdfimages 的输出前缀同族（media 里已用 cwd+ASCII 前缀绕开）。
 *  输入侧的中文路径实测正常，所以只挪"输出"这一半。系统的 Temp 目录一般是纯 ASCII（中文绝对路径在输出侧才出坑）。 */
function asciiTmpDir(tag) { return ensureDir(path.join(require('node:os').tmpdir(), 'dockit-' + tag + '-' + stamp() + '-' + process.pid)); }
/** v2.7.0：无头浏览器（HTML→PDF 的排版引擎）。与 poppler/pandoc/tesseract 同族——纳管本机原生可执行文件，
 *  不是 Python（ADR-001 不拦）、不是在线服务、不是 GUI 自动化（headless 不起窗口也不驱动界面）。
 *  DOCKIT_BROWSER 指 exe 时为**权威覆盖**（只认该路径，不回退——这样"指一个不存在的路径"才能稳定复现 unavailable）。
 *  🔴 不传 --no-sandbox：本机实测不带它也能出 PDF，装置不必为省一步而关掉浏览器自己的沙箱。 */
function browserTool() {
  const fromEnv = process.env.DOCKIT_BROWSER || '';
  const cand = [];
  if (fromEnv) cand.push({ exe: fromEnv, source: 'env:DOCKIT_BROWSER' });
  else {
    for (const nm of ['chrome', 'msedge']) {
      try { const w = spawnSync('where.exe', [nm], { encoding: 'utf8' }); if (w.status === 0) { const p = String(w.stdout).trim().split(/\r?\n/)[0]; if (p) cand.push({ exe: p, source: 'PATH/where.exe' }); } } catch { /* where 不可用走兜底 */ }
    }
    cand.push({ exe: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), source: '兜底默认位' });
    cand.push({ exe: path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), source: '兜底默认位' });
  }
  const hit = cand.find((c) => c.exe && fs.existsSync(c.exe));
  return hit || { exe: cand[cand.length - 1].exe, source: cand[cand.length - 1].source, missing: true };
}
/** v2.8.0 收口：pipeline 的两条支路（线性与 DAG）原先各抄一份"读前 5 字节判 PDF"，
 *  于是变异 M168 的锚命中 2 处、台子按自己的规矩拒跑（ANCHOR-AMBIGUOUS）。收成一处，判位只有这一个落点。 */
function inputIsPdf(input) {
  const fd = fs.openSync(input, 'r'); const b5 = Buffer.alloc(5); fs.readSync(fd, b5, 0, 5, 0); fs.closeSync(fd);
  return b5.toString('latin1') === '%PDF-';
}

/** v2.8.0 收口：pandoc 在位守卫同上（markdown 与 frommd 共用），M175 打的就是这一处。 */
function requirePandoc() {
  const pd = pandocTool();
  if (!pd.present) die('unavailable', `pandoc 不在位（${pd.source} 解析：${pd.exe}）`, pandocNext());
  return pd;
}
function browserNext() { const b = browserTool(); return `装任一 Chromium 系浏览器（本机 Chrome／Edge 皆可），或设环境变量 DOCKIT_BROWSER 指到 exe 完整路径（本次解析 ${b.exe}）。它是原生 CLI、headless 不起界面；只要 docx/odt/html 不装它也行：--to docx|odt|html。🔴 该 exe 的解析路径必须全 ASCII（v3.1.0 登记：装置把 --print-to-pdf 的产物路径恒落全 ASCII 的 _out 或 --out；但 exe 本体若在含中文的目录下，浏览器自己的宽字符链路没有装置兜底，先把它挪到 ASCII 路径再指过来）`; }
/** v2.7.0：Markdown 的**生产方向**（md → docx/odt/html/pdf），与 `markdown`（摄取向）互为反向。
 *  前三者 pandoc 直出；pdf 走两段（pandoc 出独立 HTML → 本机无头浏览器 print-to-pdf）。
 *  🔴 承重：写完装置**自己回读产物核对正文样本词**——"后端退码 0"不算结论（edit／merge／pdfform／scrub 同口径）。 */
const FROMMD_OUTPUTS = ['docx', 'odt', 'html', 'pdf'];
const FROMMD_INPUT_EXTS = ['md', 'markdown', 'mdown', 'mkd', 'fountain'];
function mdSampleTokens(src) {
  let s = String(src).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s*[-=#*+_]{2,}\s*$/gm, ' ');
  const toks = [];
  for (const m of s.matchAll(/[A-Za-z0-9一-鿿]{3,}/g)) if (!toks.includes(m[0])) toks.push(m[0]);
  return toks.slice(0, 12);
}
function textOfProduct(file, kind) {
  if (kind === 'html') return str(fs.readFileSync(file)).replace(/<[^>]*>/g, ' ');
  const map = zipRead(fs.readFileSync(file));
  let t = '';
  for (const [name, data] of map) {
    if (name === 'content.xml') { t += ' ' + str(data).replace(/<[^>]*>/g, ' '); continue; }
    if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)) continue;
    for (const m of str(data).matchAll(/<(?:w:t|a:t)\b[^>]*>([\s\S]*?)<\/(?:w:t|a:t)>/g)) t += ' ' + m[1];
  }
  return t;
}
function cleanupTmp(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ } }
function frommdFail(h, t0) { out({ ok: false, code: h.code || 'failed', error: h.error, next: h.next || nextFor(h.code || 'failed', {}), ms: Date.now() - t0 }); process.exit(1); }
function finishFrommd(to, input, output, buf, inSha, tokens, backText, warnings, t0, br, pd) {
  const norm = (x) => String(x).replace(/\s+/g, '');
  const hay = norm(backText);
  const missing = tokens.filter((t) => !hay.includes(norm(t)));
  if (sha256(buf) !== inSha) { out({ ok: false, code: 'failed', error: '输入被动了（本命令对 md 零写入）', next: '这是装置缺陷：把本行 JSON 原样回报，不要重试', input: { path: input, sha256Before: inSha, sha256After: sha256(buf) } }); process.exit(1); }
  const verify = { sample: tokens.length, found: tokens.length - missing.length, missing: missing.slice(0, 12), method: to === 'pdf' ? 'pdftotext 回读产物' : '装置自己解包取正文' };
  if (verify.sample > 0 && verify.found === 0) { out({ ok: false, code: 'failed', error: `产物里一个正文样本词都没找到（${verify.method}）——后端退码 0 不算结论`, next: '别拿这份产物交付；换 --to html 看中间件，或把本行 JSON 原样回报', verify, output: { path: output } }); process.exit(1); }
  if (missing.length) warnings.push(`有 ${missing.length} 个正文样本词在产物里找不齐（${missing.slice(0, 6).join(' , ')}）：可能是排版换行插了软连字符，也可能是内容被吞——**别宣称无损**`);
  const ob = fs.readFileSync(output);
  out({
    ok: true, op: 'frommd', direction: 'md→' + to, backend: 'pandoc' + (to === 'pdf' ? '+headless-browser' : ''), tool: pd.exe, browser: br ? br.exe : null,
    input: { path: input, bytes: buf.length, sha256: inSha, unchanged: true },
    output: { path: output, bytes: ob.length, sha256: sha256(ob) },
    produced: to, verify, ms: Date.now() - t0,
    warnings: warnings.length ? warnings : undefined,
    note: 'Markdown 的**生产方向**（与 markdown 的摄取向互为反向）。产物由装置回读核对正文样本词；pdf 走浏览器排版，分页与 to（LibreOffice）不同族，别互相冒充等价产物',
  });
}
function cmdFrommd(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'frommd');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'frommd'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入文件', '用法：frommd <输入.md> [输出文件] [--to docx|odt|html|pdf] [--title 名] [--css 样式.css] [--timeout-ms n]（help frommd 看全）');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径；Markdown 是**输入**，本命令对它零写入');
  const ext = extOf(input);
  if (!FROMMD_INPUT_EXTS.includes(ext)) die('unsupported-format', `.${ext} 不是 markdown 的输入后缀`, '本命令只吃 Markdown 系（.md/.markdown/.mdown/.mkd/.fountain）；要"文档→md"走 markdown 命令，要别的族互转走 to');
  const buf = fs.readFileSync(input);
  const inSha = sha256(buf);
  const to = String(flags.to !== undefined ? flags.to : FROMMD_DEFAULT_TO).replace(/^\./, '').toLowerCase();
  if (!FROMMD_OUTPUTS.includes(to)) { const cand = nearestCandidates(to, FROMMD_OUTPUTS); die('invalid-output', `--to 只认 ${FROMMD_OUTPUTS.join(' | ')}，给了 ${JSON.stringify(String(flags.to))}`, (cand.length ? `最接近的：${cand.map((c) => '--to ' + c).join(' | ')}` : '写全后缀'), { candidates: cand }); }
  const timeoutMs = flags['timeout-ms'] !== undefined ? Number(flags['timeout-ms']) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) die('invalid-output', `--timeout-ms 必须是正整数，给了 ${JSON.stringify(flags['timeout-ms'])}`, '照 help frommd 的用法改');
  const pd = requirePandoc();
  const warnings = [];
  const title = flags.title !== undefined ? String(flags.title) : null;
  const css = flags.css !== undefined ? abs(String(flags.css)) : null;
  if (css && !fs.existsSync(css)) die('invalid-document', `--css 指向的文件不存在：${css}`, '给绝对路径，或去掉 --css（用默认排版）');
  if (css && to === 'docx') die('invalid-output', '--css 只对 html/pdf 有意义（docx 的样式来自 pandoc 的默认 reference doc）', '去掉 --css，或 --to html|pdf');
  const wantExt = to === 'html' ? 'html' : to;
  const output = positional[1] ? abs(positional[1]) : freePath(OUT_DIR, `${path.basename(input, '.' + ext)}-${to}`, wantExt);
  if (positional[1] && fs.existsSync(output)) die('invalid-output', `输出已存在，绝不覆盖：${output}`, '换个输出路径，或省略让装置落 _out 自动去重');
  if (output === input) die('invalid-output', '输入与输出是同一个文件', '产物必须是新路径——本命令对输入零写入');
  ensureDir(path.dirname(output));
  const base = ['--from', 'markdown+raw_html', '--quiet', '--sandbox'];
  if (title) base.push('--metadata', 'title=' + title);
  const stepP = (extraArgs, outPath) => {
    const r = spawnSync(pd.exe, [input, '--output', outPath, ...base, ...extraArgs], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    if (r.signal === 'SIGTERM') return { ok: false, code: 'timeout', error: `pandoc 超预算（预算 ${timeoutMs}ms）`, next: nextFor('timeout', {}) };
    if (r.error) return { ok: false, code: 'failed', error: `pandoc 进程调用失败：${String(r.error).slice(0, 160)}`, next: '看 error 原文；ENOENT 多半是 DOCKIT_PANDOC 指错' };
    if (r.status !== 0) return { ok: false, code: 'invalid-document', error: `pandoc 读不了这份 markdown（退码 ${r.status}）：${String(r.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 200)}`, next: '先确认文件是 UTF-8 纯文本；坏件从来源重取' };
    return { ok: true };
  };
  if (to === 'pdf') {
    const br = browserTool();
    if (br.missing) die('unavailable', `无头浏览器不在位（${br.source} 解析：${br.exe}）——pdf 走两段（pandoc 出 HTML → 浏览器印 PDF）`, browserNext());
    // v3.1.0：--print-to-pdf 的产物路径走 ASCII 中转（Chromium 的宽字符 argv 链路本机未测过含中文目的路径，
    // 与 poppler 的 ANSI 坑同族风险——中转后搬回调用方要的落点，与 pdftext 的 asciiTmpReroute 同一形状）。
    let browserOut = output;
    if (!/^[\x21-\x7E]+$/.test(output)) browserOut = path.join(ensureDir(path.join(require('node:os').tmpdir(), 'dockit-frommd-' + stamp() + '-' + process.pid + '-b')), 'out.pdf');
    const tmpDir = ensureDir(path.join(require('node:os').tmpdir(), 'dockit-frommd-' + stamp() + '-' + process.pid));
    const htmlStage = path.join(tmpDir, 'doc.html');
    const h = stepP(['--standalone', ...(css ? ['--css', css] : [])], htmlStage);
    if (!h.ok) { cleanupTmp(tmpDir); return frommdFail(h, t0); }
    const bargs = ['--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--disable-crash-reporter', '--no-pdf-header-footer',
      '--user-data-dir=' + path.join(tmpDir, 'profile'), '--print-to-pdf=' + browserOut, require('node:url').pathToFileURL(htmlStage).href];
    const rb = spawnSync(br.exe, bargs, { encoding: 'utf8', timeout: timeoutMs });
    if (rb.signal === 'SIGTERM' || (rb.error && /ETIMEDOUT/i.test(String(rb.error)))) { cleanupTmp(tmpDir); return frommdFail({ ok: false, code: 'timeout', error: `浏览器印 PDF 超预算（预算 ${timeoutMs}ms）`, next: nextFor('timeout', {}) }, t0); }
    if (rb.error) { cleanupTmp(tmpDir); return frommdFail({ ok: false, code: 'failed', error: `浏览器进程失败：${String(rb.error).slice(0, 160)}`, next: '看 error 原文；ENOENT＝DOCKIT_BROWSER 指错' }, t0); }
    if (rb.status !== 0 || !fs.existsSync(browserOut)) { cleanupTmp(tmpDir); return frommdFail({ ok: false, code: 'failed', error: `浏览器没产出 PDF（退码 ${rb.status}，产物在否=${fs.existsSync(browserOut)}）：${String(rb.stderr || '').replace(/\s+/g, ' ').slice(0, 200)}`, next: '换 --to html 拿中间件自己印；或设 DOCKIT_BROWSER 指另一个浏览器 exe' }, t0); }
    if (browserOut !== output) { try { fs.copyFileSync(browserOut, output); try { fs.rmSync(path.dirname(browserOut), { recursive: true, force: true }); } catch { } } catch (e) { cleanupTmp(tmpDir); return frommdFail({ ok: false, code: 'failed', error: `ASCII 中转失败（浏览器已印出、装置搬回时错）：${String(e.message).slice(0, 120)}`, next: '把本行 JSON 原样回报；中间件在系统 Temp 的 dockit-frommd-*-b 目录' }, t0); } }
    const pp = popplerTool('pdftotext');
    if (!pp.present) { cleanupTmp(tmpDir); return frommdFail({ ok: false, code: 'unavailable', error: '产物回读要 pdftotext，但它不在位：PDF 已生成却**没验证过正文**', next: popplerNext('pdftotext') + '；没验证的产物不许当已核验交付' }, t0); }
    const txt = path.join(tmpDir, 'back.txt');
    const rt = spawnSync(pp.exe, [output, txt], { encoding: 'utf8', timeout: timeoutMs });
    if (rt.status !== 0 || !fs.existsSync(txt)) { cleanupTmp(tmpDir); return frommdFail({ ok: false, code: 'failed', error: `产物回读失败（退码 ${rt.status}）：PDF 生成了但读不出文本`, next: '别用这份产物外发；先 inspect 看结构' }, t0); }
    const back = str(fs.readFileSync(txt));
    cleanupTmp(tmpDir);
    warnings.push(`pdf 走两段（pandoc → 浏览器 ${br.exe}）：版式与分页由浏览器定，与 to（LibreOffice）不是同一路线，别互相冒充等价产物`);
    return finishFrommd(to, input, output, buf, inSha, mdSampleTokens(str(buf)), back, warnings, t0, br, pd);
  }
  const r1 = stepP(to === 'html' ? ['--standalone', ...(css ? ['--css', css] : [])] : [], output);
  if (!r1.ok) return frommdFail(r1, t0);
  if (!fs.existsSync(output)) return frommdFail({ ok: false, code: 'failed', error: 'pandoc 退码 0 却没落产物（谎报落点）', next: '不许重试到成功为止；把本行 JSON 原样回报' }, t0);
  finishFrommd(to, input, output, buf, inSha, mdSampleTokens(str(buf)), textOfProduct(output, to), warnings, t0, null, pd);
}

/** v2.7.0：PDF 无损瘦身（**不依赖 ghostscript**，纯 pdf-lib）：可达性回收＋未压缩流改 deflate。
 *  🔴 三条硬口径：① 带表单/附件/脚本的件前置拒（回收与重写会丢交互层，与 combine/split 同一立场）；
 *  ② 声称"无损"必须证——产物页数相等**且** pdftotext 抽出的正文与原件逐字相等，否则 code=failed；
 *  ③ 加密件拒（不绕加密）。体积没变小是合法结果，照实报。 */
function pdfReachableRefs(doc, lib) {
  const { PDFRef, PDFDict, PDFArray, PDFRawStream } = lib;
  const seen = new Set(); const queue = [];
  const push = (v) => { if (v instanceof PDFRef && !seen.has(v.objectNumber)) { seen.add(v.objectNumber); queue.push(v); } };
  const walk = (o) => {
    if (o instanceof PDFDict) { for (const [, v] of o.entries()) { if (v instanceof PDFRef) push(v); else walk(v); } }
    else if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i); if (v instanceof PDFRef) push(v); else walk(v); } }
    else if (o instanceof PDFRawStream) walk(o.dict);
  };
  const ti = doc.context.trailerInfo;
  for (const k of ['Root', 'Info', 'ID']) push(ti[k]);
  for (const k of ['Root', 'Info']) { const r = ti[k]; if (r) { const o = doc.context.lookup(r); if (o) walk(o); } }
  while (queue.length) { const ref = queue.shift(); const o = doc.context.lookup(ref); if (o) walk(o); }
  return seen;
}
async function compressPdf(input, buf, output, minBytes, t0) {
  const pl = loadPdfLib();
  if (pl.error) die('unavailable', `pdf-lib 不在 node_modules：${pl.error}`, PDFLIB_NEXT);
  const { PDFDocument, PDFName, PDFRawStream } = pl.lib;
  const inSha = sha256(buf);
  let doc = null;
  try { doc = await PDFDocument.load(buf, { updateMetadata: false, ignoreEncryption: true }); }
  catch (e) { const msg = String((e && e.message) || e); die(/encrypt/i.test(msg) ? 'unsupported-format' : 'invalid-document', /encrypt/i.test(msg) ? '加密 PDF 不在支持面：' + input : `读不通这份 PDF：${msg.slice(0, 160)}`, /encrypt/i.test(msg) ? '先解密再压；装置不绕加密' : '结构读不通：先 inspect'); }
  if (doc.isEncrypted) die('unsupported-format', `加密 PDF 不在支持面：${input}`, '先解密再压；装置不绕加密（与 pdfform／scrub／combine／split 同一立场）');
  const scan = await pdfRiskScan(buf);
  if (scan.loadError) die(scan.loadError.code, `读不通这份 PDF：${scan.loadError.error}`, '先 inspect 看容器识别');
  const blockers = [];
  if (scan.counts.embeddedFile) blockers.push(`内嵌附件 ${scan.counts.embeddedFile} 个`);
  if (scan.counts.javascript || scan.counts.autoActions) blockers.push(`脚本面（/JavaScript ${scan.counts.javascript}、/AA ${scan.counts.autoActions}）`);
  if ((scan.findings || []).some((f) => f.kind === 'form-field')) blockers.push('AcroForm 表单');
  if (blockers.length) die('unsupported-format', `这份 PDF 带${blockers.join('、')}：回收未引用对象会丢交互层/附件/脚本，装置不做"边压边丢"`, '要压这种件请在源程序里另存；装置的拼拆／压缩都明确不保留交互层——别把压完的件当原件交付');
  const reachable = pdfReachableRefs(doc, pl.lib);
  let orphanRemoved = 0;
  for (const [ref] of [...doc.context.enumerateIndirectObjects()]) if (!reachable.has(ref.objectNumber)) { doc.context.delete(ref); orphanRemoved++; }
  let deflated = 0, kept = 0;
  for (const [ref, o] of [...doc.context.enumerateIndirectObjects()]) {
    if (!(o instanceof PDFRawStream)) continue;
    if (o.dict.get(PDFName.of('Filter'))) continue;
    const raw = Buffer.from(o.getContents());
    if (raw.length < minBytes) continue;
    let z = null; try { z = zlib.deflateSync(raw, { level: 9 }); } catch { z = null; }
    if (!z || z.length >= raw.length) { kept++; continue; }
    o.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    doc.context.assign(ref, PDFRawStream.of(o.dict, new Uint8Array(z)));
    deflated++;
  }
  const pagesBefore = doc.getPageCount();
  let bytesOut;
  try { bytesOut = Buffer.from(await doc.save({ updateMetadata: false })); }
  catch (e) { die('failed', `保存失败：${String((e && e.message) || e).slice(0, 160)}`, '把本行 JSON 原样回报，不要重试'); }
  fs.writeFileSync(output, bytesOut);
  if (sha256(buf) !== inSha) { out({ ok: false, code: 'failed', error: '原件被动过（compress 对输入零写入）', next: '这是装置缺陷：原样回报，不要重试', input: { path: input, sha256Before: inSha, sha256After: sha256(buf) } }); process.exit(1); }
  let pagesAfter = null;
  try { pagesAfter = (await PDFDocument.load(bytesOut, { updateMetadata: false })).getPageCount(); }
  catch (e) { die('failed', `产物回读装载失败：${String((e && e.message) || e).slice(0, 140)}`, '别用这份产物——这是装置缺陷，原样回报'); }
  const pp = popplerTool('pdftotext');
  if (!pp.present) die('unavailable', `pdftotext 不在位（${pp.source}）：产物已写出但**没做正文等值核验**，装置不许宣称无损`, popplerNext('pdftotext') + '；没核验的产物别当已压好交付');
  const cmpTmp = asciiTmpDir('cmp');
  const tmpA = path.join(cmpTmp, 'a.txt'), tmpB = path.join(cmpTmp, 'b.txt');
  let textBefore = null, textAfter = null;
  try {
    const ra = spawnSync(pp.exe, [input, tmpA], { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS });
    const rb = spawnSync(pp.exe, [output, tmpB], { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS });
    if (ra.status !== 0 || rb.status !== 0 || !fs.existsSync(tmpA) || !fs.existsSync(tmpB)) die('failed', `正文等值核验跑不了（原件退码 ${ra.status}／产物退码 ${rb.status}）`, '核验不过就不算压好：别外发这份产物；原件本身先 inspect');
    textBefore = str(fs.readFileSync(tmpA)); textAfter = str(fs.readFileSync(tmpB));
  } finally { try { fs.rmSync(cmpTmp, { recursive: true, force: true }); } catch { } }
  const warnings = [];
  if (textBefore !== textAfter) { out({ ok: false, code: 'failed', error: `产物正文与原件**不等**（原件 ${textBefore.length} 字／产物 ${textAfter.length} 字）：回收或重压改掉了内容`, next: '别用这份产物外发——这是装置缺陷，把本行 JSON 原样回报，不要重试', verify: { pagesBefore, pagesAfter, textEqual: false }, input: { path: input, sha256: inSha }, output: { path: output, bytes: bytesOut.length } }); process.exit(1); }
  if (bytesOut.length >= buf.length) warnings.push(`体积没降（${buf.length} → ${bytesOut.length} B）：原件已无未引用对象、也没有可压的明文流——这是合法结果，别把"跑过"当"压小了"`);
  out({
    ok: true, op: 'compress', backend: 'pdf-lib', engine: false, input: { path: input, bytes: buf.length, sha256: inSha, unchanged: true },
    output: { path: output, bytes: bytesOut.length, sha256: sha256(bytesOut) },
    ratioBytes: +(bytesOut.length / buf.length).toFixed(4), savedBytes: buf.length - bytesOut.length,
    orphanObjectsRemoved: orphanRemoved, streamsDeflated: deflated, streamsLeftAlone: kept,
    verify: { pagesBefore, pagesAfter, textEqual: true, textMethod: 'poppler pdftotext 前后逐字对比', reloaded: true },
    ms: Date.now() - t0, warnings: warnings.length ? warnings : undefined,
    note: '无损＝页数相等 ＋ 正文逐字相等（装置自己证的，不是宣称）。带表单/附件/脚本的件前置拒；不解密、不就地改写、不覆盖',
  });
}
function cmdCompress(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'compress');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'compress'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入文件', '用法：compress <输入.pdf> [输出文件] [--min-stream-bytes n]（help compress 看全）');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const buf = fs.readFileSync(input);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', 'compress 只吃 PDF（输入按 magic 判不是 %PDF-）', 'OOXML/ODF 没有"无损瘦身"的语义（一改结构就重排版面）：要交源文件本身；别的族可先 to 成 PDF 再压');
  const minBytes = flags['min-stream-bytes'] !== undefined ? Number(flags['min-stream-bytes']) : COMPRESS_MIN_STREAM_BYTES;
  if (!Number.isInteger(minBytes) || minBytes < 64) die('invalid-output', `--min-stream-bytes 必须是不小于 64 的整数，给了 ${JSON.stringify(flags['min-stream-bytes'])}`, '照 help compress 的用法改（太小的流压了反而涨）');
  const output = positional[1] ? abs(positional[1]) : freePath(OUT_DIR, `${path.basename(input, '.pdf')}-compressed`, 'pdf');
  if (positional[1] && fs.existsSync(output)) die('invalid-output', `输出已存在，绝不覆盖：${output}`, '换个输出路径，或省略让装置落 _out 自动去重');
  if (output === input) die('invalid-output', '输入与输出是同一个文件（PDF 永不做就地改写）', '产物必须是新路径');
  ensureDir(path.dirname(output));
  return compressPdf(input, buf, output, minBytes, t0);
}
//#endregion

//#region v2.7.0 写面与抽取面：redline / redact / tables
/** v2.7.0：docx 的**修订与批注写入**（机主 2026-10-14 撤销"双轨归技能"的旧边界，落地到装置侧）。
 *  🔴 口径：① 只吃 OOXML wordprocessingml 的 docx；② **复制优先**（输入零写入、产物新写永不覆盖）；
 *  ③ 写完由装置**自己重新解包对账**（数 w:ins／w:del／w:comment、看文本在不在了），后端式"我写了"不算结论；
 *  ④ **格式修订（rPrChange／pPrChange／sectPrChange／tblPrChange）不做还原**——accept 时连同标记一起清掉（＝接受当前格式），
 *  reject 时只要存在就**前置拒**（拒绝格式修订要把旧属性表贴回来，装置没有可靠的 OOXML 属性回写面，硬做＝假还原）。 */
const REDLINE_OPS = ['insert', 'delete', 'comment', 'accept', 'reject'];
const REDLINE_FORMAT_RE = /<w:(rPrChange|pPrChange|sectPrChange|tblPrChange|tcPrChange|trPrChange|numberingChange|cellMerge)\b/g;
function rlParas(xml) { const out2 = []; const re = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g; let m; while ((m = re.exec(xml))) out2.push({ start: m.index, end: m.index + m[0].length, xml: m[0] }); return out2; }
function rlParaText(pXml) { let t = ''; for (const m of pXml.matchAll(/<(?:w:t|w:delText)\b[^>]*>([\s\S]*?)<\/(?:w:t|w:delText)>/g)) t += m[1]; return t; }
function rlMaxId(xml) { let n = 0; for (const m of xml.matchAll(/\bw:id="(-?\d+)"/g)) n = Math.max(n, Number(m[1])); return n; }
function rlXmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function cmdRedline(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'redline');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'redline'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入文件', '用法：redline <输入.docx> <insert|delete|comment|accept|reject> [--text 文本] [--match 定位串 | --para N] [--author 名] [--out 文件]（help redline 看全）');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const op = positional[1];
  if (!op || !REDLINE_OPS.includes(op)) { const cand = op ? nearestCandidates(op, REDLINE_OPS) : []; die('invalid-output', `操作只认 ${REDLINE_OPS.join(' | ')}${op ? '，给了 ' + JSON.stringify(op) : '（没给）'}`, (cand.length ? `最接近的：${cand.join(' | ')}；` : '') + 'insert=插入带修订的文本；delete=把既有文字标成删除修订；comment=加批注；accept／reject=接受／拒绝全部修订', { candidates: cand }); }
  if (positional.length > 2) die('invalid-output', `redline 只收「输入 操作」两个位置参数，给了 ${positional.length} 个`, '文本用 --text，定位用 --match 或 --para');
  const buf = fs.readFileSync(input);
  const inSha = sha256(buf);
  if (buf.readUInt32LE(0) !== 0x04034b50) die('unsupported-format', 'redline 只吃 docx（输入按 magic 判不是 ZIP）', 'OLE 的 .doc 先 to 成 docx；ODF/PDF 没有 WordprocessingML 的修订面');
  let map; try { map = zipRead(buf); } catch (e) { die('invalid-document', `ZIP 读不通：${e.message}`, '别当已核验，从来源重取'); }
  if (zipFamily(map) !== 'docx') die('unsupported-format', `这份 ZIP 的容器是 ${zipFamily(map) || '(认不出)'}，redline 只吃 docx`, 'xlsx/pptx 没有 WordprocessingML 修订模型；换工具或先转族');
  const docPart = 'word/document.xml';
  if (!map.get(docPart)) die('invalid-document', '包里缺 word/document.xml', '这不是完整的 docx：从来源重取');
  const text = flags.text !== undefined ? String(flags.text) : null;
  if ((op === 'insert' || op === 'comment') && (text === null || text.trim() === '')) die('invalid-output', `${op} 必须给 --text（不能是空串）`, '批注与插入修订都要有内容；空串会让产物带一条看不见的修订。delete 不吃 --text——它标的是既有文字');
  if ((op === 'accept' || op === 'reject') && text !== null) die('invalid-output', `${op} 不吃 --text（它作用于全文所有修订）`, '去掉 --text');
  const author = flags.author !== undefined ? String(flags.author) : REDLINE_DEFAULT_AUTHOR;
  const date = flags.date !== undefined ? String(flags.date) : new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (op === 'reject') { const fmt = [...str(map.get(docPart)).matchAll(REDLINE_FORMAT_RE)]; if (fmt.length) die('unsupported-format', `这份 docx 带 ${fmt.length} 处**格式修订**（rPrChange/pPrChange 一类）：拒绝格式修订要把旧属性表原样贴回，装置没有可靠的 OOXML 属性回写面——硬做＝假还原`, '在 Word 里拒绝修订；装置的 reject 只做内容修订（插入/删除），这一条是明说的能力边界'); }
  const match = flags.match !== undefined ? String(flags.match) : null;
  const paraNo = flags.para !== undefined ? Number(flags.para) : null;
  if (paraNo !== null && (!Number.isInteger(paraNo) || paraNo < 1)) die('invalid-output', `--para 必须是 1 起的整数，给了 ${JSON.stringify(flags.para)}`, '段落序号从 1 开始数（含表格单元格里的段落）');
  let xml = str(map.get(docPart));
  const xmlOrig = xml;   // 原文留一份：accept/reject 的"哪段文字该留、哪段该走"必须对着原件判，不能拿改后的自己证明自己
  const entries = [...map.entries()].map(([name, data]) => ({ name, data, method: 8 }));
  const changed = { ins: 0, del: 0, comments: 0 };
  let warnings = [];
  let target = null;
  if (op === 'insert' || op === 'delete' || op === 'comment') {
    const paras = rlParas(xml);
    if (paraNo !== null) { if (paraNo > paras.length) die('invalid-output', `--para ${paraNo} 越界：这份 docx 一共 ${paras.length} 个段落`, '照 parasTotal 里的数改，或改用 --match 定位'); target = paras[paraNo - 1]; }
    else {
      if (!match) die('invalid-output', '必须给 --match 定位串或 --para N', '例如 --match "第三章"；两者都给以 --para 为准');
      const hits = paras.filter((p) => rlParaText(p.xml).includes(match));
      if (!hits.length) die('invalid-output', `--match ${JSON.stringify(match)} 在任何段落正文里都没命中`, '先看 dump --text 或 to ... .txt 核对原文（注意本命令默认不回显正文）；也可能它跨了两个 run');
      if (hits.length > 1) { warnings = [`--match ${JSON.stringify(match)} 命中 ${hits.length} 个段落，只改第一个（要精确就加 --para N）`]; }
      target = hits[0];
    }
  }
  const targetPlain = target ? rlParaText(target.xml).replace(/\s+/g, '').trim() : '';
  let id = rlMaxId(xml);
  if (op === 'insert') {
    id += 1;
    const run = `<w:r><w:t xml:space="preserve">${rlXmlEsc(text)}</w:t></w:r>`;
    const insBlock = `<w:ins w:id="${id}" w:author="${rlXmlEsc(author)}" w:date="${date}">${run}</w:ins>`;
    const newPara = target.xml.includes('</w:p>') ? target.xml.replace(/<\/w:p>$/, `${insBlock}</w:p>`) : null;
    if (newPara === null) die('failed', '段落形状不认识（没有 </w:p> 收尾）', '这是装置缺陷：原样回报，不要重试');
    xml = xml.slice(0, target.start) + newPara + xml.slice(target.end);
    changed.ins = 1;
  } else if (op === 'delete') {
    id += 1;
    const runs = [...target.xml.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)];
    if (!runs.length) die('invalid-output', '定位到的段落里没有任何 run，没有可标删除的文字', '改用 --match 定位到有文字的段落');
    let inner = target.xml;
    for (const r of [...runs].reverse()) {
      const body = r[0].replace(/<w:t(\b[^>]*)>/g, '<w:delText$1>').replace(/<\/w:t>/g, '</w:delText>');
      inner = inner.slice(0, r.index) + `<w:del w:id="${id}" w:author="${rlXmlEsc(author)}" w:date="${date}">${body}</w:del>` + inner.slice(r.index + r[0].length);
    }
    xml = xml.slice(0, target.start) + inner + xml.slice(target.end);
    changed.del = 1;
  } else if (op === 'comment') {
    id += 1;
    const start = `<w:commentRangeStart w:id="${id}"/>`;
    const endRef = `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;
    const run0 = /<w:r\b[\s\S]*?<\/w:r>/.exec(target.xml);
    let inner = target.xml;
    if (run0) inner = inner.slice(0, run0.index) + start + inner.slice(run0.index);
    else inner = inner.replace(/(<w:p\b[^>]*>)/, `$1${start}`);
    inner = inner.replace(/<\/w:p>$/, `${endRef}</w:p>`);
    xml = xml.slice(0, target.start) + inner + xml.slice(target.end);
    const cpart = map.get('word/comments.xml');
    const cbody = cpart ? str(cpart) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${S_NS_W()}><w:comment w:id="${id}" w:author="${rlXmlEsc(author)}" w:date="${date}" w:initials="d"><w:p><w:r><w:t xml:space="preserve">${rlXmlEsc(text)}</w:t></w:r></w:p></w:comment></w:comments>`;
    const existing = cpart ? cbody.replace('</w:comments>', `<w:comment w:id="${id}" w:author="${rlXmlEsc(author)}" w:date="${date}" w:initials="d"><w:p><w:r><w:t xml:space="preserve">${rlXmlEsc(text)}</w:t></w:r></w:p></w:comment></w:comments>`) : cbody;
    putEntry(entries, 'word/comments.xml', Buffer.from(existing, 'utf8'));
    putEntry(entries, 'word/document.xml', Buffer.from(xml, 'utf8'));
    const relsName = 'word/_rels/document.xml.rels';
    const REL_ONE = '<Relationship Id="rIdDockitComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>';
    if (map.get(relsName)) {
      const r = str(map.get(relsName));
      if (!/comments/.test(r)) {
        const r2 = xmlAppendChild(r, 'Relationships', REL_ONE);
        if (r2 === null) die('failed', 'rels 部件形状不认识（既没有 </Relationships> 也不是自闭合根标签）', '别交付这份产物——登记做不上的批注部件会让 Word 报文件损坏');
        putEntry(entries, relsName, Buffer.from(r2, 'utf8'));
      }
    } else putEntry(entries, relsName, Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + REL_ONE + '</Relationships>', 'utf8'));
    const ctName = '[Content_Types].xml';
    const CT_ONE = '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>';
    const ct = str(map.get(ctName) || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    if (!/comments\.xml/.test(ct)) {
      const ct2 = xmlAppendChild(ct, 'Types', CT_ONE);
      if (ct2 === null) die('failed', '[Content_Types].xml 形状不认识（没有 </Types> 也不是自闭合根标签）', '别交付这份产物：装配表没登记的部件在 Word 里等于坏件');
      putEntry(entries, ctName, Buffer.from(ct2, 'utf8'));
    }
    changed.comments = 1;
  } else {
    const fmt = [...xml.matchAll(REDLINE_FORMAT_RE)].length;
    if (op === 'accept') {
      xml = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '').replace(/<\/?w:ins\b[^>]*>/g, '').replace(/<w:(rPrChange|pPrChange|sectPrChange|tblPrChange|tcPrChange|trPrChange|numberingChange|cellMerge)\b[\s\S]*?(<\/w:\1>|\/>)/g, '');
      if (fmt) warnings.push(`清掉了 ${fmt} 处格式修订标记（accept＝保留当前格式）。装置**不做**"把旧格式贴回来"，这类还原归源程序`);
    } else {
      xml = xml.replace(/<w:ins\b[\s\S]*?<\/w:ins>/g, '').replace(/<\/?w:del\b[^>]*>/g, '').replace(/<w:delText(\b[^>]*)>/g, '<w:t$1>').replace(/<\/w:delText>/g, '</w:t>');
    }
    putEntry(entries, 'word/document.xml', Buffer.from(xml, 'utf8'));
  }
  // insert/delete 两支只动了 xml，必须在这里落回部件表（漏掉就会写出"看着成功其实正文没变"的产物——回读对账那步会抓到它）
  if (op === 'insert' || op === 'delete') putEntry(entries, 'word/document.xml', Buffer.from(xml, 'utf8'));
  const output = flags.out !== undefined ? abs(String(flags.out)) : freePath(OUT_DIR, `${path.basename(input, '.docx')}-redlined`, 'docx');
  if (flags.out !== undefined && fs.existsSync(output)) die('invalid-output', `输出已存在，绝不覆盖：${output}`, '换个输出路径，或省略让装置落 _out 自动去重');
  if (output === input) die('invalid-output', '输入与输出是同一个文件', '修订写入必须产出新件');
  ensureDir(path.dirname(output));
  fs.writeFileSync(output, zipWrite(entries.map((e) => ({ name: e.name, data: e.data, method: e.method }))));
  // 🔴 回读对账：装置自己重新解包，数修订标记、看文本在不在了——写完"报成功"不等于写对了
  const back = zipRead(fs.readFileSync(output));
  const bx = str(back.get('word/document.xml'));
  const bc = back.get('word/comments.xml') ? str(back.get('word/comments.xml')) : '';
  const insN = (bx.match(/<w:ins\b/g) || []).length, delN = (bx.match(/<w:del\b/g) || []).length, cmtN = (bc.match(/<w:comment\b/g) || []).length;
  const esc = rlXmlEsc(text === null ? '' : text);
  const delTexts = [...bx.matchAll(/<w:delText\b[^>]*>([\s\S]*?)<\/w:delText>/g)].map((m) => m[1]).join('').replace(/\s+/g, '');
  const verify = { op, ins: insN, del: delN, comments: cmtN, textPresent: text !== null && (bx.includes(esc) || bc.includes(esc)), delTextPresent: op === 'delete' ? (targetPlain.length > 0 && delTexts.includes(targetPlain)) : null };
  const bads = [];
  if (op === 'insert' && (insN < 1 || !bx.includes(esc))) bads.push('没写进 w:ins，或 --text 没进产物');
  if (op === 'delete' && delN < 1) bads.push('没写进 w:del');
  if (op === 'delete' && verify.delTextPresent !== true) bads.push('包了 w:del 但被删的文字没进 w:delText（Word 会显示成"空删除"，等于没标）');
  if (op === 'comment' && (cmtN < 1 || !bc.includes(esc))) bads.push('comments.xml 里没有这条批注，或批注内容没写进去');
  if (op === 'comment') {
    // 🔴 新部件必须"包认得"：rels 指得到它、[Content_Types] 声明它——缺任一条 Word 打开就报损坏文件，而 check 这类只看部件的读者照样看得见（假干净）
    const backRels = str(back.get('word/_rels/document.xml.rels') || Buffer.alloc(0));
    const backCt = str(back.get('[Content_Types].xml') || Buffer.alloc(0));
    if (!/comments\.xml/.test(backRels)) bads.push('批注部件没有 rels 指向它（包里有零件、装配表不认）');
    if (!/word\/comments\.xml/.test(backCt)) bads.push('批注部件没有写进 [Content_Types].xml（同上）');
  }
  if (op === 'accept' || op === 'reject') {
    if (insN !== 0 || delN !== 0) bads.push(`还有未清完的修订标记（ins=${insN} del=${delN}）`);
    const origIns = [...xmlOrig.matchAll(/<w:ins\b[\s\S]*?<\/w:ins>/g)].map((m) => rlParaText(m[0])).join('').trim();
    const origDel = [...xmlOrig.matchAll(/<w:del\b[\s\S]*?<\/w:del>/g)].map((m) => rlParaText(m[0])).join('').trim();
    const now = rlParaTextFromAll(bx).replace(/\s+/g, '');
    const head = (s) => s.slice(0, 8);
    if (head(origIns)) {
      const present = now.includes(head(origIns).replace(/\s+/g, ''));
      if (op === 'accept' && !present) bads.push('接受后**插入的文字应当留下**，产物里却找不到');
      if (op === 'reject' && present) bads.push('拒绝后**插入的文字应当消失**，产物里却还在');
    }
    if (head(origDel)) {
      const present = now.includes(head(origDel).replace(/\s+/g, ''));
      if (op === 'accept' && present) bads.push('接受后被删的文字应当消失，产物里却还在（删除修订没真丢弃）');
      if (op === 'reject' && !present) bads.push('拒绝后被删的文字应当回来，产物里却找不到（delText 没还原成 w:t）');
    }
    if (!head(origIns) && !head(origDel)) warnings.push('原件里本来就没有内容修订（w:ins/w:del）——本命令按"无修订可处理"照做，但别把跑过当成"我处理过修订"');
  }
  if (sha256(buf) !== inSha) bads.push('原件被动了（redline 对输入零写入）');
  if (bads.length) { out({ ok: false, code: 'failed', error: `写后回读对账不符：${bads.join('；')}`, next: '别用这份产物交付，也不要重试——这是装置缺陷，把本行 JSON 原样回报', verify, input: { path: input, sha256: inSha }, output: { path: output } }); process.exit(1); }
  const ob = fs.readFileSync(output);
  out({
    ok: true, op: 'redline', container: 'docx', action: op, input: { path: input, bytes: buf.length, sha256: inSha, unchanged: sha256(buf) === inSha },
    output: { path: output, bytes: ob.length, sha256: sha256(ob) },
    revisionId: (op === 'insert' || op === 'delete' || op === 'comment') ? id : null, author, date,
    locatedParagraph: target ? { index: rlParas(str(map.get(docPart))).indexOf(target) + 1, textChars: rlParaText(target.xml).length } : null,
    parasTotal: rlParas(str(map.get(docPart))).length,
    verify, ms: Date.now() - t0, warnings: warnings.length ? warnings : undefined,
    note: '修订/批注**写入**（自 v2.7.0 起在装置侧，v2.6.0 之前归技能双轨）。回读对账由装置重新解包完成，"我写了"不算结论。格式修订：accept＝清标记保留当前格式，reject 遇到格式修订直接拒（不做假还原）',
  });
}
function S_NS_W() { return 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'; }
function putEntry(entries, name, data) { const i = entries.findIndex((e) => e.name === name); if (i >= 0) entries[i] = { name, data, method: 8 }; else entries.push({ name, data, method: 8 }); }
function xmlAppendChild(xmlText, rootTag, payload) {
  const close = '</' + rootTag + '>';
  const i = xmlText.lastIndexOf(close);
  if (i >= 0) return xmlText.slice(0, i) + payload + xmlText.slice(i);
  const j = xmlText.lastIndexOf('/>');
  if (j < 0) return null;
  const k = xmlText.lastIndexOf('<', j);
  if (k < 0 || xmlText.slice(k + 1, j).indexOf(rootTag) !== 0) return null;
  return xmlText.slice(0, j) + '>' + payload + xmlText.slice(j + 2) + close;
}
function rlParaTextFromAll(xml) { let t = ''; for (const m of xml.matchAll(/<(?:w:t|w:delText)\b[^>]*>([\s\S]*?)<\/(?:w:t|w:delText)>/g)) t += m[1]; return t; }

/** v2.7.0：PDF **真涂黑**（redact）。机主 2026-10-14 撤销旧边界，条件是"必须可证伪"：
 *  定位＝poppler `pdftotext -bbox` 的词框（装置自己不解码字形）；动作＝**从内容流里删掉命中位置的文本绘制算子** ＋ 画黑框；
 *  验收＝产物再用 pdftotext 抽一遍，**needle 必须查不到**——查不到就 `code:failed`，绝不交付"看着涂了其实还在"的假脱敏。 */
function parseBboxXml(xmlText) {
  const pages = [];
  for (const pm of xmlText.matchAll(/<page[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g)) {
    const words = [];
    for (const wm of pm[3].matchAll(/<word[^>]*xMin="([\d.-]+)"[^>]*yMin="([\d.-]+)"[^>]*xMax="([\d.-]+)"[^>]*yMax="([\d.-]+)"[^>]*>([\s\S]*?)<\/word>/g)) {
      words.push({ xMin: +wm[1], yMin: +wm[2], xMax: +wm[3], yMax: +wm[4], text: wm[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#10;/g, '\n') });
    }
    pages.push({ width: +pm[1], height: +pm[2], words });
  }
  return pages;
}
/** v3.1.0（本会话实测撞出的 v2.7.0 老缺陷）：/BT[\s\S]*?ET/g 非贪婪在字符串字面量 'TARGET' 的 'ET' 处截断——
 *  内容流含 TARGET/SET/GET 这类字面量的文本会让删块边界完全失配（轻则删不动、重则删错块）。
 *  修法＝括号感知切分：跟踪字符串字面量 (…) 开合与 \ 转义，只在字面量外认 BT/ET 算子（ET 后必须是空白/行尾）。
 *  返回 [start, end] 区间（不是切片）——调用方按区间替换，块间字符（换行/空白）原样保留（map+join 会把它们全丢，v3.1.0 实测）。 */
function findTextBlocks(s) {
  const spans = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('BT', i) && (i + 2 >= s.length || /\s/.test(s[i + 2]))) {
      let j = i + 2, depth = 0, out = null;
      while (j < s.length) {
        const c = s[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '(') depth += 1;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0 && c === 'E' && s.startsWith('ET', j) && (j + 2 >= s.length || /\s/.test(s[j + 2]))) { out = j; break; }
        j += 1;
      }
      if (out === null) break;
      spans.push([i, out + 2]);
      i = out + 2;
      continue;
    }
    i += 1;
  }
  return spans;
}
function locateNeedle(pages, needle) {  const hits = [];
  const nz = String(needle).replace(/\s+/g, '');
  if (!nz) return hits;
  pages.forEach((pg, pi) => {
    let cat = ''; const owner = [];
    for (const w of pg.words) { const t = w.text.replace(/\s+/g, ''); for (let i = 0; i < t.length; i++) owner.push(w); cat += t; }
    let from = 0;
    while (true) {
      const at = cat.indexOf(nz, from);
      if (at < 0) break;
      const box = owner.slice(at, at + nz.length).reduce((a, w) => w ? { xMin: Math.min(a.xMin, w.xMin), yMin: Math.min(a.yMin, w.yMin), xMax: Math.max(a.xMax, w.xMax), yMax: Math.max(a.yMax, w.yMax) } : a, { xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity });
      hits.push({ page: pi + 1, box, pageWidth: pg.width, pageHeight: pg.height });
      from = at + nz.length;
    }
  });
  return hits;
}
function cmdRedact(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'redact');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'redact'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入文件', '用法：redact <输入.pdf> [--needle 串] [--needles 数据.json] [--fill black|none] [--out 文件]（help redact 看全）');
  // v3.1.0：--fill black（默认）＝脱敏（画框）；none＝删字留白（不画框）。复用同一套 locate+delete+verify。
  const fill = flags.fill !== undefined && flags.fill !== null ? String(flags.fill).toLowerCase() : 'black';
  if (fill !== 'black' && fill !== 'none') die('invalid-output', `--fill 只认 black|none，给了 ${JSON.stringify(String(flags.fill))}`, 'black＝画黑框（脱敏，默认）；none＝删字留白（把多余条目去掉，黑框反而是错的）');
  const dryRun = flags['dry-run'] === true; // v3.2.0 试运行：只定位＋旋转检查，不删不画不写盘（M266 守这条分支）
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const buf = fs.readFileSync(input);
  const inSha = sha256(buf);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', 'redact 只吃 PDF（输入按 magic 判不是 %PDF-）', '涂黑要在容器内删内容流：OOXML/ODF 请直接删源文再导出');
  const needles = [];
  if (flags.needle !== undefined) needles.push(String(flags.needle));
  if (flags.needles !== undefined) {
    const f = abs(String(flags.needles));
    if (!fs.existsSync(f)) die('invalid-document', `--needles 的文件不存在：${f}`, '必须是 **JSON 文件路径**（本机 shell 引号会吃掉内联 JSON，这类错犯过多次）');
    let data = null; try { data = JSON.parse(str(fs.readFileSync(f))); } catch (e) { die('invalid-document', `--needles 不是合法 JSON：${String(e.message).slice(0, 120)}`, '数组，或 {needles:[...]}'); }
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.needles) ? data.needles : null);
    if (!arr) die('invalid-output', '--needles 的 JSON 必须是数组或 {needles:[...]}', '值必须全是字符串；不接对象/数字（与 pdfform 的标量口径同族）');
    for (const x of arr) { if (typeof x !== 'string' || !x.trim()) die('invalid-output', `--needles 里有非字符串或空串：${JSON.stringify(x).slice(0, 40)}`, '只接非空字符串'); needles.push(x); }
  }
  if (!needles.length) die('invalid-output', '没给 --needle 也没给 --needles', '涂黑必须指明目标；装置不做"整页抹白"这种看着安全的动作');
  const pl = loadPdfLib();
  if (pl.error) die('unavailable', `pdf-lib 不在 node_modules：${pl.error}`, PDFLIB_NEXT);
  const pp = popplerTool('pdftotext');
  if (!pp.present) die('unavailable', `pdftotext 不在位（${pp.source}）：定位与验收都要它，缺它就只剩"画黑框"＝假涂黑`, popplerNext('pdftotext'));
  const output = flags.out !== undefined ? abs(String(flags.out)) : freePath(OUT_DIR, `${path.basename(input, '.pdf')}-redacted`, 'pdf');
  if (flags.out !== undefined && fs.existsSync(output)) die('invalid-output', `输出已存在，绝不覆盖：${output}`, '换个输出路径，或省略让装置落 _out 自动去重');
  if (output === input) die('invalid-output', '输入与输出是同一个文件（PDF 永不做就地改写）', '产物必须是新路径');
  if (!dryRun) ensureDir(path.dirname(output)); // v3.2.0：试运行连父目录都不建（零写入）
  const { PDFDocument, PDFName, PDFRawStream, PDFDict } = pl.lib;
  (async () => {
    let doc = null;
    try { doc = await PDFDocument.load(buf, { updateMetadata: false, ignoreEncryption: true }); }
    catch (e) { const msg = String((e && e.message) || e); die(/encrypt/i.test(msg) ? 'unsupported-format' : 'invalid-document', /encrypt/i.test(msg) ? '加密 PDF 不在支持面：' + input : `读不通这份 PDF：${msg.slice(0, 160)}`, /encrypt/i.test(msg) ? '先解密再涂黑；装置不绕加密' : '先 inspect 看容器识别'); }
    if (doc.isEncrypted) die('unsupported-format', `加密 PDF 不在支持面：${input}`, '先解密再涂黑；装置不绕加密');
    // 🔴 v3.1.0 实测（本会话 /Rotate 90 夹具复现）：/Rotate≠0 的页上 bbox 词框坐标与内容流坐标差一个随旋转
    // 变化的常数（本例 ~588，不是 842−y），pdfRects 映射全错——轻则 needle 命中不了、报 failed 指向错方向，
    // 重则框落到别处、删了别的 BT/ET 组、验收还可能通过。装置不猜旋转矩阵 ⇒ 前置拒，指路 pageops rotate 转正。
    const rotatedPages = [];
    doc.getPages().forEach((p, i) => { if ((p.getRotation().angle % 360) !== 0) rotatedPages.push(i + 1); });
    if (rotatedPages.length && !dryRun) die('unsupported-format', `这些页带 /Rotate ≠ 0（第 ${rotatedPages.join('、')} 页）：bbox 词框坐标与内容流坐标的映射随旋转变化，装置不猜旋转矩阵——v3.1.0 实测在本类件上会删错字或删不动（验收还可能通过）`, `先 pageops rotate 转正（rotate 0 不在支持面：用 rotate 90/180/270 里的对应角转回 0 视角）再来涂黑；或手工转正后重跑`);
    const rdTmp = asciiTmpDir('rd');
    const bboxTxt = path.join(rdTmp, 'bbox.xml');
    const rb = spawnSync(pp.exe, ['-bbox', input, bboxTxt], { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS });
    if (!fs.existsSync(bboxTxt)) die('failed', `pdftotext -bbox 没出定位数据（退码 ${rb.status}）：这份 PDF 可能没有文本层（扫描件）`, '扫描件的涂黑要先 OCR 定坐标——装置不做那条路线：本面只处理**有文本层**的 PDF');
    const pages = parseBboxXml(str(fs.readFileSync(bboxTxt)));
    try { fs.unlinkSync(bboxTxt); } catch { }
    if (!pages.length) die('failed', 'pdftotext -bbox 没解析出任何页', '别当已涂黑：把本行 JSON 原样回报');
    const jobs = [];
    for (const n of needles) {
      const hits = locateNeedle(pages, n);
      jobs.push({ needle: n, hits: hits.length, pages: [...new Set(hits.map((h) => h.page))], rects: hits.map((h) => ({ page: h.page, x0: h.box.xMin, x1: h.box.xMax, yTop: h.box.yMin, yBottom: h.box.yMax, pageHeight: h.pageHeight })) });
    }
    const notFound = jobs.filter((j) => j.hits === 0).map((j) => j.needle);
    if (notFound.length && !dryRun) die('invalid-output', `这些 needle 在文本层里一个都没找到：${notFound.map((x) => JSON.stringify(x).slice(0, 30)).join(' , ')}`, '找不到就**不能宣称涂黑过**：先确认字形（全角／简繁／连字／跨行断词）与是否本就没有这段文字；本命令不做模糊匹配');
    // v3.2.0 --dry-run 试运行：只定位＋旋转检查，不删不画不写盘（rdTmp 中转目录在这里收掉，无产物落盘；M266 守这条分支）。
    if (dryRun) {
      try { fs.rmSync(rdTmp, { recursive: true, force: true }); } catch { }
      const touchPages = [...new Set(jobs.flatMap((j) => j.pages))].sort((a, b) => a - b);
      const wouldFail = [];
      if (notFound.length) wouldFail.push(`这些 needle 在文本层里一个都没找到：${notFound.map((x) => JSON.stringify(x).slice(0, 30)).join(' , ')}（正常跑会 invalid-output 拒收）`);
      if (rotatedPages.length) wouldFail.push(`这些页带 /Rotate ≠ 0（第 ${rotatedPages.join('、')} 页）：正常跑会 unsupported-format 前置拒，先 pageops rotate 转正再来`);
      out({
        ok: true, op: 'redact', dryRun: true, fill,
        input: { path: input, bytes: buf.length, sha256: inSha, unchanged: true },
        wouldWriteTo: output,
        needles: jobs.map((j) => ({ needleChars: j.needle.length, located: j.hits, pages: j.pages, rects: j.rects.length })),
        wouldTouchPages: touchPages,
        rotationRefusedPages: rotatedPages,
        notFoundNeedles: notFound,
        wouldSucceed: wouldFail.length === 0,
        wouldFailReasons: wouldFail.length ? wouldFail : undefined,
        warnings: ['🔴 只删**页内容流**里的 BT/ET 文本组：画在 Form XObject、注释外观（AP）、文档附件或另一份 XMP 里的同一串不会被删——正常跑的验收那一步会把它抓出来并判 failed，但**别把"这串没了"推广成"这类信息都清了"**（元数据另走 scrub）'],
        note: '试运行（--dry-run）：只跑定位＋旋转检查，不删内容流、不画框、不落产物（会落哪见 wouldWriteTo）。拒收只在预览里点名（wouldSucceed=false＋wouldFailReasons），正常跑才生效。',
      });
      return;
    }
    const byPage = new Map();
    for (const j of jobs) for (const r of j.rects) { if (!byPage.has(r.page)) byPage.set(r.page, []); byPage.get(r.page).push(r); }
    const warnings = [];
    let opsRemoved = 0; const inlineStreams = [];
    const crossOps = [];   // v3.1.0：删掉的整段块里"框外还有文字算子"的记录（删除粒度粗于框时的删多预警）
    for (const [pageNum, rects] of byPage) {
      const page = doc.getPage(pageNum - 1);
      const ph = page.getSize().height;
      const pdfRects = rects.map((r) => ({ x0: Math.max(0, r.x0 - 1), x1: r.x1 + 1, y0: Math.max(0, ph - r.yBottom - 1), y1: ph - r.yTop + 1 }));
      const cRef = page.node.get(PDFName.of('Contents'));
      const items = cRef instanceof pl.lib.PDFRef ? [cRef] : (page.node.lookup(PDFName.of('Contents')) instanceof pl.lib.PDFArray ? [...Array({ length: page.node.lookup(PDFName.of('Contents')).size() }).keys()].map((i) => page.node.lookup(PDFName.of('Contents')).get(i)) : []);
      for (const it of items) {
        if (!(it instanceof pl.lib.PDFRef)) { inlineStreams.push(pageNum); continue; }   // 内联流（不是间接对象）本面不改写——如实登记，由验收那步兜住
        const o = doc.context.lookup(it);
        if (!(o instanceof PDFRawStream)) continue;
        let bytes = Buffer.from(o.getContents());
        const isFlate = String(o.dict.get(PDFName.of('Filter')) || '').includes('FlateDecode');
        if (isFlate) { try { bytes = zlib.inflateSync(bytes); } catch { warnings.push(`第 ${pageNum} 页内容流解不开（FlateDecode 坏流）：这一页没改写`); continue; } }
        let s = bytes.toString('latin1');
        // v3.1.0：按区间替换（不 map+join——块间换行会全丢）；每删一块统计框外算子（删多预警）
        for (const [bs, be] of findTextBlocks(s).reverse()) {
          const blk = s.slice(bs, be);
          const pts = [...blk.matchAll(/(-?[\d.]+) (-?[\d.]+)\s+(Td|Tm)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
          const inside = pts.length > 0 && pts.some((p) => pdfRects.some((r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1));
          if (!inside) continue;
          opsRemoved++;
          // 🔴 v3.1.0（审查报告"验收只防删漏、不防删多"）：粒度是整段 BT…ET——块里若有 Td/Tm 落在框内就整块删，
          // 一段块跨多格时会静默多删。统计"块内框外"的文字算子：有就 warning 点名（不拒收——先删下来说清楚）。
          const outsidePts = pts.filter((p) => !pdfRects.some((r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1));
          if (outsidePts.length) crossOps.push({ page: pageNum, outsidePts: outsidePts.length });
          s = s.slice(0, bs) + s.slice(be);
        }
        const payload = zlib.deflateSync(Buffer.from(s, 'latin1'), { level: 9 });
        o.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        o.dict.set(PDFName.of('Length'), pl.lib.PDFNumber.of(payload.length));
        doc.context.assign(it, PDFRawStream.of(o.dict, new Uint8Array(payload)));
      }
      // 黑框交给 pdf-lib 自己的写入器（追加到该页内容流末尾＝盖在剩余文字之上）；--fill none 时跳过画框＝删字留白
      if (fill === 'black') for (const r of pdfRects) page.drawRectangle({ x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 /* 不传 color：pdf-lib 的 drawRectangle 默认就是黑色（lib 里没有导出的 PDFColor 名字，实测踩过） */ });
    }
    const bytesOut = Buffer.from(await doc.save({ updateMetadata: false }));
    fs.writeFileSync(output, bytesOut);
    // 🔴 验收：产物再抽一遍文本，needle 必须彻底查不到；查到了就是假涂黑，直接判 failed
    const chk = path.join(rdTmp, 'check.txt');
    const rc = spawnSync(pp.exe, [output, chk], { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS });
    let residual = [];
    try {
      const after = str(fs.readFileSync(chk));
      const flat = after.replace(/\s+/g, '');
      for (const n of needles) if (flat.includes(String(n).replace(/\s+/g, ''))) residual.push(n);
    } catch { /* 读不出＝failed，下面兜 */ }
    try { fs.rmSync(rdTmp, { recursive: true, force: true }); } catch { }
    if (sha256(buf) !== inSha) { out({ ok: false, code: 'failed', error: '原件被动过（redact 对输入零写入）', next: '装置缺陷：原样回报，不要重试' }); process.exit(1); }
    if (rc.status !== 0) { out({ ok: false, code: 'failed', error: `产物验收跑不了（pdftotext 退码 ${rc.status}）：没法证明涂黑成功`, next: '别用这份产物外发——**未经验证的脱敏等于没脱敏**', jobs, output: { path: output } }); process.exit(1); }
    if (residual.length) { out({ ok: false, code: 'failed', error: `🔴 产物文本层里**仍能找到** ${residual.length} 个 needle：${residual.map((x) => JSON.stringify(x).slice(0, 30)).join(' , ')}`, next: '这就是假涂黑（黑框盖住但文字还在）。别外发这份产物；常见原因是文字画在 Form XObject 或注释外观里——本面只删页内容流的 BT/ET 组，做不到的部分必须由装置说破', verify: { needles: needles.length, residual: residual.length, residualNeedles: residual }, input: { path: input, sha256: inSha }, output: { path: output, bytes: bytesOut.length } }); process.exit(1); }
    const afterPages = (await PDFDocument.load(bytesOut, { updateMetadata: false })).getPageCount();
    const crossWarn = crossOps.length ? `🔴 有 ${crossOps.length} 个被删的整段块里**框外还有文字算子**（${crossOps.slice(0, 6).map((c) => `第 ${c.page} 页 ${c.outsidePts} 个`).join('；')}）：删除粒度是整段 BT…ET，块内任意一个 Td/Tm 落在框内就整块删——同段块跨多格/多行时**相邻文字会被顺手删掉**。核对产物：确认多删的那些正是要去的条目，否则换更细粒度的定位（每行一个 needle）` : null;
    const baseWarnings = [
      '🔴 只删了**页内容流**里的 BT/ET 文本组：画在 Form XObject、注释外观（AP）、文档附件或另一份 XMP 里的同一串不会被删——验收那一步会把它抓出来并判 failed，但**别把"这串没了"推广成"这类信息都清了"**（元数据另走 scrub）',
      fill === 'black' ? '黑框是画上去的遮盖，真删的是文本算子；验收＝产物文本层零命中，不是"看着黑了"' : '--fill none＝只删不画（删字留白）：真删的是文本算子，验收＝产物文本层零命中；脱敏用途别用 none（黑框是脱敏的看得见的形状）',
    ];
    if (crossWarn) baseWarnings.push(crossWarn);
    out({
      ok: true, op: 'redact', backend: 'pdf-lib+poppler', input: { path: input, bytes: buf.length, sha256: inSha, unchanged: true },
      output: { path: output, bytes: bytesOut.length, sha256: sha256(bytesOut) },
      pages: doc.getPageCount(), pagesAfter: afterPages, fill,
      needles: jobs.map((j) => ({ needleChars: j.needle.length, located: j.hits, pages: j.pages })),
      textOpsRemoved: opsRemoved,
      blocksWithOutsideText: crossOps.length || 0,
      verify: { method: '产物再用 pdftotext 抽文本层，needle 必须零命中', residual: 0, pagesEqual: afterPages === doc.getPageCount(), fill },
      ms: Date.now() - t0,
      warnings: baseWarnings,
      note: fill === 'black' ? '真涂黑＝删算子＋画遮盖＋**回读证明查不到**。找不到 needle 直接拒（不宣称涂过）；扫描件无文本层拒（不做模糊匹配）；加密件拒' : '删字留白（--fill none）＝删算子＋**回读证明查不到**，不画任何框。找不到 needle 直接拒；扫描件无文本层拒；加密件拒；同段块跨格时的删多预警走 warnings（blocksWithOutsideText>0 时先核对产物）',
    });
  })().catch((e) => { const p = asyncFailPayload(e); die(p.code, p.error, p.next); });
}

/** v2.7.0：PDF 表格抽取（几何法，**可自证**）。网格来自内容流的矢量线段（实测 LibreOffice 把 docx 带边框表格画成
 *  m/l 线段：N 行→N+1 条横线、M 列→M+1 条竖线），文字来自 `pdftotext -bbox` 的词框，按"词框中心落在哪个单元格"入格。
 *  🔴 没有网格就不硬凑：非网格件回 tables=[]＋warning＋指路 pdftext——宁可不给，不给猜的表。 */
function pdfSegments(page, doc) {
  const { PDFName, PDFRawStream, PDFArray } = require('pdf-lib');
  const cNode = page.node.lookup(PDFName.of('Contents'));
  const items = cNode instanceof PDFArray ? [...Array({ length: cNode.size() }).keys()].map((i) => cNode.get(i)) : [cNode];
  const segs = [];
  for (const it of items) {
    const o = it instanceof PDFRawStream ? it : doc.context.lookup(it);
    if (!(o instanceof PDFRawStream)) continue;
    let bytes = Buffer.from(o.getContents());
    if (String(o.dict.get(PDFName.of('Filter')) || '').includes('FlateDecode')) { try { bytes = zlib.inflateSync(bytes); } catch { continue; } }
    const s = bytes.toString('latin1');
    const num = (t) => { const v = Number(t); return Number.isFinite(v) ? v : null; };
    let cx = 0, cy = 0, sx = 0, sy = 0;
    const tok = /(-?[\d.]+)(?:\s+(-?[\d.]+))?(?:\s+(-?[\d.]+))?(?:\s+(-?[\d.]+))?\s+(m|l|re|f|S|n|W\*?|W)\b/g;
    for (const m of s.matchAll(tok)) {
      const a = num(m[1]), b = num(m[2]), c = num(m[3]), d = num(m[4]), op = m[5];
      if (op === 'm' && a !== null && b !== null) { cx = a; cy = b; sx = a; sy = b; }
      else if (op === 'l' && a !== null && b !== null) { segs.push({ x1: cx, y1: cy, x2: a, y2: b }); cx = a; cy = b; }
      else if (op === 're' && a !== null && b !== null && c !== null && d !== null) {
        const x0 = a, y0 = b, x1 = a + c, y1 = b + d;
        segs.push({ x1: x0, y1: y0, x2: x1, y2: y0 }, { x1: x1, y1: y0, x2: x1, y2: y1 }, { x1: x1, y1: y1, x2: x0, y2: y1 }, { x1: x0, y1: y1, x2: x0, y2: y0 });
        cx = x0; cy = y0; sx = x0; sy = y0;
      } else if (op === 'f' || op === 'S' || op === 'n' || op === 'W' || op === 'W*') { /* 闭合/描边算子不影响取线 */ }
    }
  }
  return segs;
}
function cluster(vals, tol) {
  const v = [...vals].sort((a, b) => a - b); const out2 = [];
  for (const x of v) { if (!out2.length || Math.abs(x - out2[out2.length - 1].at) > tol) out2.push({ at: x, n: 1 }); else { const g = out2[out2.length - 1]; g.at = (g.at * g.n + x) / (g.n + 1); g.n++; } }
  return out2.map((g) => g.at);
}
function gridFromSegs(segs) {
  const TOL = 1.2, GAP = 0.6;
  const hs = segs.filter((s) => Math.abs(s.y1 - s.y2) <= TOL && Math.abs(s.x1 - s.x2) > 3);
  const vs = segs.filter((s) => Math.abs(s.x1 - s.x2) <= TOL && Math.abs(s.y1 - s.y2) > 3);
  if (hs.length < 2 || vs.length < 2) return null;
  const ys = cluster(hs.map((s) => (s.y1 + s.y2) / 2), TOL);
  const xs = cluster(vs.map((s) => (s.x1 + s.x2) / 2), TOL);
  if (xs.length < 2 || ys.length < 2) return null;
  const covered = (x0, x1, y, rows) => hs.some((s) => Math.abs((s.y1 + s.y2) / 2 - y) <= TOL && Math.min(s.x1, s.x2) <= x0 + GAP && Math.max(s.x1, s.x2) >= x1 - GAP);
  const vcovered = (y0, y1, x) => vs.some((s) => Math.abs((s.x1 + s.x2) / 2 - x) <= TOL && Math.min(s.y1, s.y2) <= y0 + GAP && Math.max(s.y1, s.y2) >= y1 - GAP);
  const bands = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    const x0 = xs[i], x1 = xs[i + 1], yTop = ys[j + 1], yBot = ys[j];
    if (covered(x0, x1, ys[j]) && covered(x0, x1, ys[j + 1]) && vcovered(yBot, yTop, x0) && vcovered(yBot, yTop, x1)) bands.push({ x0, x1, y0: yBot, y1: yTop });
  }
  if (bands.length < 2) return null;
  const colEdges = [...new Set(bands.flatMap((b) => [b.x0, b.x1]))].sort((a, b) => a - b);
  const rowEdges = [...new Set(bands.flatMap((b) => [b.y0, b.y1]))].sort((a, b) => b - a);
  const cellOf = (px, py) => {
    const ci = colEdges.findIndex((e, k) => k < colEdges.length - 1 && px >= colEdges[k] - GAP && px <= colEdges[k + 1] + GAP);
    const ri = rowEdges.findIndex((e, k) => k < rowEdges.length - 1 && py <= e + GAP && py >= rowEdges[k + 1] - GAP);
    if (ci < 0 || ri < 0) return null;
    const b = bands.find((bb) => Math.abs(bb.x0 - colEdges[ci]) <= TOL * 2 && Math.abs(bb.y1 - rowEdges[ri]) <= TOL * 2);
    return b ? { row: ri, col: ci } : null;
  };
  return { bands, colEdges, rowEdges, cellOf, cellCount: bands.length };
}
function cmdTables(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'tables');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'tables'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  if (!positional[0]) die('invalid-document', '缺输入文件', '用法：tables <输入.pdf> [--dir 目录] [--pages 1-3] [--max-tables n]（help tables 看全）');
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const buf = fs.readFileSync(input);
  const inSha = sha256(buf);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', 'tables 只吃 PDF（输入按 magic 判不是 %PDF-）', 'OOXML/ODF 表格直接走 to ... .csv（引擎导出，无损且不用猜）；本命令是给"只有 PDF"的场合');
  const pl = loadPdfLib();
  if (pl.error) die('unavailable', `pdf-lib 不在 node_modules：${pl.error}`, PDFLIB_NEXT);
  const pp = popplerTool('pdftotext');
  if (!pp.present) die('unavailable', `pdftotext 不在位（${pp.source}）：词框要靠它`, popplerNext('pdftotext'));
  const maxTables = flags['max-tables'] !== undefined ? Number(flags['max-tables']) : TABLES_MAX_TABLES;
  if (!Number.isInteger(maxTables) || maxTables < 1) die('invalid-output', `--max-tables 必须是正整数，给了 ${JSON.stringify(flags['max-tables'])}`, '照 help tables 的用法改');
  const dir = flags.dir !== undefined ? abs(String(flags.dir)) : freeDir(OUT_DIR, `${path.basename(input, '.pdf')}-tables`);
  if (flags.dir !== undefined && fs.existsSync(dir) && fs.readdirSync(dir).length) die('invalid-output', `--dir 已存在且非空：${dir}`, '给个空目录，或省略让装置落 _out 自动去重');
  ensureDir(dir);
  const { PDFDocument, PDFName, PDFArray } = pl.lib;
  (async () => {
    let doc = null;
    try { doc = await PDFDocument.load(buf, { updateMetadata: false, ignoreEncryption: true }); }
    catch (e) { const msg = String((e && e.message) || e); die(/encrypt/i.test(msg) ? 'unsupported-format' : 'invalid-document', /encrypt/i.test(msg) ? '加密 PDF 不在支持面：' + input : `读不通这份 PDF：${msg.slice(0, 160)}`, /encrypt/i.test(msg) ? '先解密；装置不绕加密' : '先 inspect 看容器识别'); }
    if (doc.isEncrypted) die('unsupported-format', `加密 PDF 不在支持面：${input}`, '先解密；装置不绕加密');
    const tbTmp = asciiTmpDir('tb');
    const bbox = path.join(tbTmp, 'bbox.xml');
    const rb = spawnSync(pp.exe, ['-bbox', input, bbox], { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS });
    if (!fs.existsSync(bbox)) die('failed', `pdftotext -bbox 没出数据（退码 ${rb.status}）`, '扫描件/无文本层的 PDF 抽不出表：那是图像，走 pages＋ocr');
    const pages = parseBboxXml(str(fs.readFileSync(bbox)));
    try { fs.rmSync(tbTmp, { recursive: true, force: true }); } catch { }
    const want0 = flags.pages !== undefined ? parsePageList(String(flags.pages), doc.getPageCount()) : doc.getPages().map((_, i) => i);
    const tables = []; const warnings = []; let fileSeq = 0;
    for (const pageIdx of want0) {
      const pageNum = pageIdx + 1;
      const page = doc.getPage(pageIdx);
      const ph = page.getSize().height;
      const segs = pdfSegments(page, doc);
      const g = gridFromSegs(segs);
      const words = (pages[pageNum - 1] || { words: [] }).words.map((w) => ({ ...w, pdfYTop: ph - w.yMin, pdfYBot: ph - w.yMax, cx: (w.xMin + w.xMax) / 2, cy: ph - (w.yMin + w.yMax) / 2 }));
      if (!g) { if (segs.length >= 2) warnings.push(`第 ${pageNum} 页有 ${segs.length} 段线但没成网格（缺四边闭合的单元格）——不猜表`); continue; }
      if (tables.length >= maxTables) { warnings.push(`已达 --max-tables ${maxTables}，后面的页没再扫（不静默截断）`); break; }
      const cells = {};
      for (const w of words) { const c = g.cellOf(w.cx, w.cy); if (!c) continue; const k = c.row + ',' + c.col; (cells[k] = cells[k] || []).push(w.text); }
      const rows = g.rowEdges.length, cols = g.colEdges.length;
      const grid = Array.from({ length: rows - 1 }, () => Array.from({ length: cols - 1 }, () => ''));
      let filled = 0;
      for (const [k, arr] of Object.entries(cells)) { const [r, c] = k.split(',').map(Number); if (grid[r] && grid[r][c] !== undefined) { grid[r][c] = arr.join(''); filled++; } }
      const csv = grid.map((r) => r.map((v) => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
      fileSeq += 1;
      const file = path.join(dir, `table-p${String(pageNum).padStart(3, '0')}-${fileSeq}.csv`);
      fs.writeFileSync(file, '﻿' + csv + '\n', 'utf8');
      tables.push({ page: pageNum, index: fileSeq, rows: rows - 1, cols: cols - 1, cells: g.cellCount, filledWords: filled, file, bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) });
    }
    if (sha256(buf) !== inSha) { out({ ok: false, code: 'failed', error: '原件被动过（tables 对输入零写入）', next: '装置缺陷：原样回报，不要重试' }); process.exit(1); }
    if (!tables.length) warnings.push('没抽到任何表（PDF 里没有闭合网格线）。这不是"这份文档没有表"的结论：无边框表格、图片表格、只有横线的表都不在这一面——要字面内容走 pdftext，要结构就走源文件的 to ... .csv');
    out({
      ok: true, op: 'tables', backend: 'pdf-lib+poppler', engine: false, input: { path: input, bytes: buf.length, sha256: inSha, unchanged: true },
      pagesScanned: want0.length, dir, count: tables.length, tables,
      ms: Date.now() - t0, warnings: warnings.length ? warnings : undefined,
      note: '几何法：内容流的**矢量网格线**定单元格＋pdftotext -bbox 的词框入格。只在有闭合网格时出表，没网格就明说并回空清单（宁可不给，不给猜的表）。CSV 带 UTF-8 BOM（Excel 中文不乱码）',
    });
  })().catch((e) => { const p = asyncFailPayload(e); die(p.code, p.error, p.next); });
}
//#endregion

//#region 自检区（判据必须有牙）
function str(buf) { return buf.toString('utf8'); }
function asyncFailPayload(e) {
  // 异步命令（目前只有 selftest）的失败出口形状。库函数不退进程（第四节承重 10），由入口决定要不要 die。
  // 文案里刻意不出现"读那条通道"的指示：装置把成功与失败都收成**一份 JSON 打到 stdout**（v1.1.1 订正，
  // 《文档操作规范》§8）——旧文案写"看 stderr"，方向正好相反，会把调用方引到一个恒空的地方。
  const raw = (e && e.message) || (typeof e === 'string' ? e : (safeJson(e) || '')) || '未知失败';
  const msg = String(raw).replace(/\s+/g, ' ').slice(0, 300);
  // 与入口同步兜底同一把尺（见入口区 catch）：ZIP/CRC/inflate 类是"输入容器读不通"，归 invalid-document，
  // 不许因命令改成 async（inspect 现为 async）就把损坏容器误报成"装置缺陷类 failed"（2026-10-10 技能对照轮实测回归）。
  const zipish = e && e.dockitCode ? e.dockitCode === 'invalid-document' : /CRC|ZIP|EOCD|inflate|zlib|code lengths|incorrect header|invalid distance/i.test(msg);
  if (zipish) return { code: 'invalid-document', error: `读不通这个容器（已兜住，不吐裸栈）：${msg}`, next: '这个文件按 ZIP 读不通（条目 CRC 不匹配、压缩流坏了或不是 ZIP 容器）。先怀疑文件本身损坏：别外发、别当已核验，必要时从来源重取' };
  return { code: 'failed', error: `异步命令失败（装置缺陷类）：${msg}`, next: '把本行 JSON 原样回报给调用方，不要重试；装置的成功与失败都是 stdout 上的一份 JSON，判成败只看 ok 字段与退出码' };
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return ''; } }

/** 列字母 ↔ 1 基下标（A1 引用语义的地基）。sheetop 是装置第一个要按地址摆格子的命令，此前没有这对换算。 */
function colToIdx(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function idxToCol(n) {
  let s = '', x = n;
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

/* ================= v2.8.0 sheetop：xlsx 结构微编辑（插行/插列/移行/移列）＋公式引用重写 =================
 * 撤销《技能与装置分工表》§3 那条"不落地"。它的原话是"回读只能证值进去了、证不了引用图没被改坏"——
 * 本命令把验收换成**引用图同构对账**：写完**重新解开产物**，逐条公式重新切词，断言
 *   ① 非引用片段逐字不变；② 每个引用的落点＝原件同一片段按轴映射的像；③ 格子地址集合＝原集合在映射下的像（双射）。
 * 再补一把引擎尺（kit 在位默认跑）：原件与产物各重算一次，逐格取值数沿映射相等、#REF! 不许变多。
 */

const SO_REF_RE = /(?:(?:'((?:[^']|'')+)'|([^\s'"!]+))!)?(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6}))?/y;
const SO_REF_CHUNK_RE = /^(?:(?:'((?:[^']|'')+)'|([^\s'"!]+))!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?$/;
const IDMAP = (i) => i;
IDMAP.specials = []; // 恒等轴没有断点，包围盒就是两端点

function soEsc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** 公式切词。🔴 遇到 `[`／`]`（结构化引用）或切不进引用片段的冒号（三维引用 Sheet1:Sheet2!A1）一律抛——
 *     那两类要表定义与跨表区间语义，装置不猜（上层转成 unsupported-format）。 */
function soSplitFormula(text) {
  const out = [];
  let i = 0, txt = '';
  const flush = () => { if (txt) { out.push({ t: 'txt', raw: txt }); txt = ''; } };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const e = text.indexOf('"', i + 1);
      if (e < 0) throw new Error('公式里的字符串字面量没闭合');
      txt += text.slice(i, e + 1); i = e + 1; continue;
    }
    if (ch === '[' || ch === ']') throw new Error('公式里有结构化引用（Table1[列] 一类），引用重写不猜表语义');
    SO_REF_RE.lastIndex = i;
    const m = SO_REF_RE.exec(text);
    if (m && m[0].length) {
      const prev = i > 0 ? text[i - 1] : '';
      const nextAt = i + m[0].length;
      const next = nextAt < text.length ? text[nextAt] : '';
      if (!/[A-Za-z0-9_.$!']/.test(prev) && !/[A-Za-z0-9_([]/.test(next)) {
        flush();
        out.push({
          t: 'ref', raw: m[0],
          sheet: m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : null),
          quoted: m[1] !== undefined,
          absCol: m[3] === '$', col: m[4], absRow: m[5] === '$', row: +m[6],
          rng: m[8] !== undefined ? { absCol: m[7] === '$', col: m[8], absRow: m[9] === '$', row: +m[10] } : null,
        });
        i = nextAt; continue;
      }
    }
    if (ch === '!') throw new Error('公式里有认不出的表限定名（有 ! 却没接上引用片段），不猜');
    if (ch === ':') throw new Error('公式里有切不进引用片段的冒号（三维引用一类），不做猜的');
    txt += ch; i += 1;
  }
  flush();
  return out;
}

/** 一个引用片段的像。只有"指向 editedSheet 的引用"才动：不限名时看这条公式 own 是不是被编辑的表，
 *  限名时看限名是不是那张表。限名指向一个工作簿里不存在的表 ⇒ 抛（无从判断落点）。 */
function soMapRef(refObj, mapRow, mapCol, ownSheet, editedSheet, allNames) {
  if (refObj.sheet !== null) {
    if (!allNames.some((x) => String(x).toLowerCase() === String(refObj.sheet).toLowerCase())) throw new Error('引用了工作簿里没有的表名：' + refObj.sheet);
    if (String(refObj.sheet).toLowerCase() !== String(editedSheet).toLowerCase()) return refObj.raw;
  } else if (String(ownSheet).toLowerCase() !== String(editedSheet).toLowerCase()) return refObj.raw;
  const mk = (p) => `${p.absCol ? '$' : ''}${idxToCol(mapCol(colToIdx(p.col)))}${p.absRow ? '$' : ''}${mapRow(p.row)}`;
  const head = refObj.sheet === null ? '' : (refObj.quoted ? `'${refObj.sheet}'!` : `${refObj.sheet}!`);
  if (!refObj.rng) return head + mk(refObj);
  // 🔴 区间要映射"整段的像"而不是"两个角的像"：移列是把一列插到别处，段内的列序会被重新排布，
  //    只算两角会得到 A1:C7 → A1:B7 这种**少一列**的坏值。轴映射是分段单位斜率的，断点只有 from/to，
  //    所以取 {两端点 ∪ 断点} 的像再取 min/max 就是精确包围盒。
  const hull = (mapFn, i1, i2) => {
    const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
    const sp = [];
    for (const q of mapFn.specials || []) sp.push(q - 1, q, q + 1); // 断点两侧的格子落在不同的分段里，只取断点本身会漏掉段内的极值
    const cand = [lo, hi].concat(sp).filter((v) => v >= lo && v <= hi);
    let mn = Infinity, mx = -Infinity;
    for (const v of cand) { const m = mapFn(v); if (m < mn) mn = m; if (m > mx) mx = m; }
    return [mn, mx];
  };
  const [cMin, cMax] = hull(mapCol, colToIdx(refObj.col), colToIdx(refObj.rng.col));
  const [rMin, rMax] = hull(mapRow, refObj.row, refObj.rng.row);
  const firstLeft = colToIdx(refObj.col) <= colToIdx(refObj.rng.col);
  const firstTop = refObj.row <= refObj.rng.row;
  const acL = (firstLeft ? refObj.absCol : refObj.rng.absCol) ? '$' : '';
  const acR = (firstLeft ? refObj.rng.absCol : refObj.absCol) ? '$' : '';
  const arT = (firstTop ? refObj.absRow : refObj.rng.absRow) ? '$' : '';
  const arB = (firstTop ? refObj.rng.absRow : refObj.absRow) ? '$' : '';
  return `${head}${acL}${idxToCol(cMin)}${arT}${rMin}:${acR}${idxToCol(cMax)}${arB}${rMax}`;
}

function soRewriteFormula(text, ownSheet, editedSheet, mapRow, mapCol, allNames) {
  const parts = soSplitFormula(text);
  let changed = 0;
  const out = parts.map((x) => {
    if (x.t !== 'ref') return x.raw;
    const mapped = soMapRef(x, mapRow, mapCol, ownSheet, editedSheet, allNames);
    if (mapped !== x.raw) changed += 1;
    return mapped;
  }).join('');
  return { text: out, changed };
}

/** 重写一处/一串纯引用位（mergeCell、sqref、dimension、table ref、definedName、图表 <c:f>…）。
 *  映射后把矩形两角**归一**（否则移列会把 A1:C7 写成 B1:A7 —— Excel 只认前者）。 */
function soRewriteRefList(text, ownSheet, editedSheet, mapRow, mapCol, allNames) {
  let changed = 0;
  const out = String(text).trim().split(/\s+/).map((chunk) => {
    const mm = SO_REF_CHUNK_RE.exec(chunk);
    if (!mm) throw new Error('引用串形状不认识：' + chunk);
    const one = {
      sheet: mm[1] !== undefined ? mm[1] : (mm[2] !== undefined ? mm[2] : null),
      quoted: mm[1] !== undefined,
      absCol: mm[3] === '$', col: mm[4], absRow: mm[5] === '$', row: +mm[6],
      rng: mm[8] !== undefined ? { absCol: mm[7] === '$', col: mm[8], absRow: mm[9] === '$', row: +mm[10] } : null,
    };
    const mapped = soMapRef(one, mapRow, mapCol, ownSheet, editedSheet, allNames);
    if (mapped !== chunk) changed += 1;
    return mapped;
  }).join(' ');
  return { text: out, changed };
}

function soMapCell(addr, mapRow, mapCol) {
  const m = /^([A-Za-z]{1,3})(\d+)$/.exec(addr);
  if (!m) throw new Error('单元格地址形状不认识：' + addr);
  return idxToCol(mapCol(colToIdx(m[1]))) + String(mapRow(+m[2]));
}

/** 轴映射：insert＝from 起整体平移；move＝把 from 落到 to（to 是**最终布局**里的下标，1 基）。 */
function soAxisMap(kind, from, to, count) {
  if (kind === 'insert') return (i) => (i >= from ? i + count : i);
  if (from === to) return (i) => i;
  if (from < to) return (i) => (i === from ? to : (i > from && i <= to ? i - 1 : i));
  return (i) => (i === from ? to : (i >= to && i < from ? i + 1 : i));
}

function soExtent(xml) {
  let maxRow = 0, maxCol = 0;
  for (const m of xml.matchAll(/<c\b[^>]*\br="([A-Za-z]{1,3})(\d+)"/g)) { maxCol = Math.max(maxCol, colToIdx(m[1])); maxRow = Math.max(maxRow, +m[2]); }
  for (const m of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) maxRow = Math.max(maxRow, +m[1]);
  for (const m of xml.matchAll(/<dimension\b[^>]*\bref="([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?"/g)) {
    maxCol = Math.max(maxCol, colToIdx(m[1]), m[3] ? colToIdx(m[3]) : 0);
    maxRow = Math.max(maxRow, +m[2], m[4] ? +m[4] : 0);
  }
  return { maxRow, maxCol };
}

/** 解开 xlsx，建工作簿模型（表名 → 部件路径、命名域、calcPr 形状）。 */
function soWorkbookModel(parts) {
  const wb = str(parts.get('xl/workbook.xml'));
  const rels = parts.has('xl/_rels/workbook.xml.rels') ? str(parts.get('xl/_rels/workbook.xml.rels')) : '';
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0]), tg = /\bTarget="([^"]+)"/.exec(m[0]);
    if (id && tg) relMap[id[1]] = tg[1];
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/>/g)) {
    const at = (k) => { const r = new RegExp(`\\b${k}="([^"]*)"`).exec(m[0]); return r ? r[1] : null; };
    const name = at('name');
    if (!name) throw new Error('workbook.xml 里有 <sheet> 没有 name');
    const rid = at('r:id');
    let t = rid ? relMap[rid] : null;
    if (!t) throw new Error(`表「${name}」的关系目标解析不出来（r:id=${rid || '(无)'}）`);
    t = t.replace(/^\//, '').replace(/^\.\//, '');
    if (!t.startsWith('xl/')) t = 'xl/' + t;
    sheets.push({ name, part: t, rid, state: at('state') });
  }
  if (!sheets.length) throw new Error('工作簿里没有工作表');
  const definedNames = [];
  for (const m of wb.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const nm = /\bname="([^"]*)"/.exec(m[1]);
    definedNames.push({ name: nm ? nm[1] : '', text: xmlUnesc(m[2]) });
  }
  return { sheets, definedNames, r1c1: /<calcPr\b[^>]*refMode="r1c1"/i.test(wb) };
}

/** 这张表挂着的 drawing／table 部件（别的表的部件一律不碰）。 */
function soSheetSideParts(parts, sheetPart) {
  const out = { drawings: [], tables: [] };
  const relName = sheetPart.replace(/^xl\/worksheets\//, 'xl/worksheets/_rels/') + '.rels';
  if (!parts.has(relName)) return out;
  for (const m of str(parts.get(relName)).matchAll(/<Relationship\b[^>]*>/g)) {
    const tg = /\bTarget="([^"]+)"/.exec(m[0]); if (!tg) continue;
    let t = tg[1].replace(/^\//, '');
    if (t.startsWith('../')) t = 'xl/' + t.slice(3);
    else if (!t.startsWith('xl/')) t = 'xl/' + t;
    if (parts.has(t) && /\/drawings\/[^/]+\.xml$/.test(t)) out.drawings.push(t);
    if (parts.has(t) && /\/tables\/table\d*\.xml$/.test(t)) out.tables.push(t);
  }
  return out;
}

/** 收集一张表里所有"会被引用重写触碰的位置"——审计读盘上的产物时用同一份枚举。 */
function soCollectSheet(xml) {
  const cells = [];
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const addr = (/\br="([A-Za-z]{1,3}\d+)"/.exec(m[1]) || [])[1] || null;
    const inner = m[2] || '';
    const f = /<f\b([^>]*?)(\/>|>([\s\S]*?)<\/f>)/.exec(inner);
    cells.push({ addr, fAttrs: f ? f[1] : null, fText: f ? (f[3] === undefined ? '' : xmlUnesc(f[3])) : null, hasCache: /<v>[\s\S]*?<\/v>/.test(inner) });
  }
  const attrs = [];
  for (const m of xml.matchAll(/<(?:(?:[A-Za-z0-9]+):)?(dimension|mergeCell|autoFilter|sortState|sortCondition|conditionalFormatting|dataValidation|hyperlink|ignoredError|pane|selection)\b([^>]*)>/g)) {
    for (const a of m[2].matchAll(/\b(ref|sqref|location|activeCell)="([^"]*)"/g)) attrs.push({ tag: m[1], attr: a[1], value: a[2] });
  }
  const breaks = [];
  for (const m of xml.matchAll(/<(rowBreaks|colBreaks)\b[\s\S]*?<\/\1>/g)) for (const b of m[0].matchAll(/<brk\b[^>]*\bid="(\d+)"/g)) breaks.push({ kind: m[1], id: +b[1] });
  const spans = [...xml.matchAll(/<row\b[^>]*\bspans="(\d+):(\d+)"/g)].map((m) => [+m[1], +m[2]]);
  const blockFormulas = [];
  for (const m of xml.matchAll(/<(?:(?:[A-Za-z0-9]+):)?(?:conditionalFormatting|dataValidations)\b[\s\S]*?<\/(?:conditionalFormatting|dataValidations)>/g)) {
    for (const f of m[0].matchAll(/<((?:[A-Za-z0-9]+:)?formula\d?)>([\s\S]*?)<\/\1>/g)) blockFormulas.push(xmlUnesc(f[2]));
  }
  return { cells, attrs, breaks, spans, blockFormulas };
}

/** 改一张表。cellMap* 只管"格子自己的地址"（被编辑的表用真映射，别的表用恒等）；
 *  refMap* 管"引用落点"（所有表都用真映射，但只有指向 edited 那张表的引用会动）。 */
function soRewriteSheet(xml, own, edited, cellMapRow, cellMapCol, refMapRow, refMapCol, allNames, st) {
  let s = xml;
  s = s.replace(/<((?:[A-Za-z0-9]+:)?row)\b([^>]*?)>/g, (m0, name, at) => {
    const r = /\br="(\d+)"/.exec(at);
    if (!r) throw new Error('有 <row> 没有 r 属性（位置即下标，装置不猜）');
    let na = at.replace(/\br="\d+"/, () => `r="${cellMapRow(+r[1])}"`);
    const sp = /\bspans="(\d+):(\d+)"/.exec(at);
    if (sp) { const a2 = cellMapCol(+sp[1]), b2 = cellMapCol(+sp[2]); na = na.replace(/\bspans="\d+:\d+"/, () => `spans="${a2}:${b2}"`); }
    return '<' + name + na + '>';
  });
  s = s.replace(/<((?:[A-Za-z0-9]+:)?c)\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?c>)/g, (m0, name, at, close, innerRaw) => {
    const r = /\br="([A-Za-z]{1,3})(\d+)"/.exec(at);
    if (!r) throw new Error('有 <c> 没有 r 属性（位置即下标，装置不猜）');
    const na = at.replace(/\br="[A-Za-z]{1,3}\d+"/, () => `r="${soMapCell(r[1] + r[2], cellMapRow, cellMapCol)}"`);
    if (close === '/>') return '<' + name + na + '/>';
    let inner = innerRaw || '';
    const fm = /<((?:[A-Za-z0-9]+:)?f)\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?f>)/.exec(inner);
    if (!fm) return '<' + name + na + '>' + inner + '</' + name + '>';
    const tt = /\bt="([^"]*)"/.exec(fm[2]);
    if (tt && tt[1] === 'dataTable') throw new Error('公式是 dataTable 型（数据表公式），装置不改');
    const fText = fm[4] === undefined ? '' : xmlUnesc(fm[4]);
    const rw = soRewriteFormula(fText, own, edited, refMapRow, refMapCol, allNames);
    st.refs += rw.changed;
    let nf = fm[2];
    const fr = /\bref="([^"]*)"/.exec(fm[2]);
    if (fr) { const mr = soRewriteRefList(fr[1], own, edited, refMapRow, refMapCol, allNames); nf = nf.replace(/\bref="[^"]*"/, () => `ref="${mr.text}"`); st.refs += mr.changed; }
    const newF = fm[3] === '/>' ? `<${fm[1]}${nf}/>` : `<${fm[1]}${nf}>${soEsc(rw.text)}</${fm[1]}>`;
    inner = inner.replace(fm[0], () => newF);
    if (rw.changed && fm[3] !== '/>' && /<v>[\s\S]*?<\/v>/.test(inner)) { inner = inner.replace(/<v>[\s\S]*?<\/v>/g, ''); st.cacheCleared += 1; }
    return '<' + name + na + '>' + inner + '</' + name + '>';
  });
  const SITE = [['dimension', ['ref']], ['mergeCell', ['ref']], ['autoFilter', ['ref']], ['sortState', ['ref']], ['sortCondition', ['ref']],
    ['conditionalFormatting', ['sqref']], ['dataValidation', ['sqref']], ['hyperlink', ['ref', 'location']], ['ignoredError', ['sqref']], ['pane', ['activeCell', 'sqref']], ['selection', ['activeCell', 'sqref']]];
  for (const [tag, list] of SITE) {
    s = s.replace(new RegExp(`<((?:[A-Za-z0-9]+:)?${tag})\\b([^>]*?)/?>`, 'g'), (m0, name, at) => {
      const selfClose = m0.endsWith('/>');
      let na = at;
      for (const a of list) {
        const r = new RegExp(`\\b${a}="([^"]*)"`).exec(at);
        if (!r) continue;
        const rw = soRewriteRefList(r[1], own, edited, refMapRow, refMapCol, allNames);
        st.refs += rw.changed;
        na = na.replace(new RegExp(`\\b${a}="[^"]*"`), () => `${a}="${rw.text}"`);
      }
      return '<' + name + na + (selfClose ? '/>' : '>');
    });
  }
  // 条件格式与数据验证的规则式引用：OOXML 用的是 <formula>／<formula1>／<formula2>，不是 <f>
  s = s.replace(/<((?:[A-Za-z0-9]+:)?(?:conditionalFormatting|dataValidations))\b([\s\S]*?)<\/\1>/g, (m0, name, body) => {
    const nb = body.replace(/<((?:[A-Za-z0-9]+:)?formula\d?)>([\s\S]*?)<\/\1>/g, (mm, tag, txtRaw) => {
      let rw;
      try { rw = soRewriteFormula(xmlUnesc(txtRaw), own, edited, refMapRow, refMapCol, allNames); } catch { return mm; }
      st.refs += rw.changed;
      return rw.changed ? `<${tag}>${soEsc(rw.text)}</${tag}>` : mm;
    });
    return '<' + name + nb + '</' + name + '>';
  });
  s = s.replace(/<(rowBreaks|colBreaks)\b([\s\S]*?)<\/\1>/g, (m0, name, body) => {
    const nb = body.replace(/(<brk\b[^>]*?\bid=")(\d+)(")/g, (mm, pre, idv, post) => {
      const n = name === 'rowBreaks' ? cellMapRow(+idv) : cellMapCol(+idv);
      if (n !== +idv) st.refs += 1;
      return pre + n + post;
    });
    return '<' + name + nb + '</' + name + '>';
  });
  return s;
}

/** workbook.xml：命名域按"指向被编辑表的那部分"重写；calcPr 补 fullCalcOnLoad（读方必须重算，别拿陈旧缓存当数）。 */
function soRewriteWorkbook(wbXml, edited, mapRow, mapCol, allNames, st) {
  const mapName = (txt) => {
    if (!/[A-Za-z]/.test(txt) || !/!/.test(txt) || /#(REF|NAME|VALUE|DIV\/0|NULL|NUM)!(?![A-Za-z])/.test(txt)) return { text: txt, changed: 0 };
    return soRewriteRefList(txt, null, edited, mapRow, mapCol, allNames);
  };
  let s = wbXml.replace(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g, (m0, at, body) => {
    const rw = mapName(xmlUnesc(body));
    st.refs += rw.changed;
    return rw.changed ? `<definedName${at}>${soEsc(rw.text)}</definedName>` : m0;
  });
  const addFlag = (m0, at) => (/\bfullCalcOnLoad="/.test(at) ? m0 : `<calcPr${at} fullCalcOnLoad="1"`);
  if (/<calcPr\b[^>]*?\/>/.test(s)) s = s.replace(/<calcPr\b([^>]*?)\/>/, (m0, at) => addFlag(m0, at).replace(/(\sfullCalcOnLoad="1")$/, '$1/>'));
  else if (/<calcPr\b/.test(s)) s = s.replace(/<calcPr\b([^>]*?)>/, (m0, at) => addFlag(m0, at) + '>');
  else s = s.replace(/<\/workbook>/, '<calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>');
  return s;
}

function cmdSheetop(args) {
  const t0 = Date.now();
  const { positional, flags } = parseArgs(args, 'sheetop');
  inputSizeGuard(positional[0], flags['max-input-bytes'], 'sheetop'); // F6：本地解包路线的输入体积闸（默认 256 MB；--max-input-bytes／DOCKIT_MAX_INPUT_BYTES 可抬，属放宽规则）
  const input = abs(positional[0]);
  if (!fs.existsSync(input)) die('invalid-document', `输入不存在：${positional[0]}`, '给绝对路径');
  const op = positional[1];
  if (!op) die('invalid-output', '缺操作', `只认 ${SHEETOP_OPS.join(' | ')}：sheetop <输入.xlsx> <操作> [--sheet 名] [--at N | --from N --to M]`);
  if (!SHEETOP_OPS.includes(op)) { die('invalid-output', `操作不认识：${JSON.stringify(op)}`, `只认 ${SHEETOP_OPS.join(' | ')}`, { candidates: nearestCandidates(op, SHEETOP_OPS) }); }
  const buf = fs.readFileSync(input); const inSha = sha256(buf);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) die('unsupported-format', 'sheetop 只吃 xlsx（ZIP 容器＋xl/workbook.xml）', 'OLE 的 .xls 先 to 转 xlsx；ODF 的 ods 装置不改结构');
  let parts;
  try { parts = zipRead(buf); } catch (e) { die('invalid-document', `xlsx 解包失败：${String(e && e.message || e).slice(0, 140)}`, '输入坏了，从来源重取'); }
  if (!parts.has('xl/workbook.xml')) die('unsupported-format', '是 ZIP 但不是 xlsx（没有 xl/workbook.xml）', '给真正的 .xlsx');
  const risky = [...parts.keys()].filter((n) => /pivot|externalLink|vmlDrawing|activeX|\/oleObject|slicer|timeline|\/dialogsheet|vbaProject|macros?\.bin/i.test(n));
  if (risky.length) die('unsupported-format', `件里有装置不改的结构件：${risky.slice(0, 4).join(' , ')}`, '插行移列要连带刷新透视缓存／外链缓存／旧绘图层，做不到的那半装置不硬做——请在源程序里改');
  let model;
  try { model = soWorkbookModel(parts); } catch (e) { die('invalid-document', `工作簿结构读不出来：${String(e && e.message || e).slice(0, 160)}`, '原样回报，别改件'); }
  if (model.r1c1) die('unsupported-format', '工作簿是 R1C1 引用模式', '装置只按 A1 语义重写引用');
  const wbRaw = str(parts.get('xl/workbook.xml'));
  if (/<workbookProtection\b|<fileSharing\b/.test(wbRaw)) die('unsupported-format', '工作簿带保护或共享设置', '先解除保护再来（装置不碰保护位，也不假装它不在）');
  const names = model.sheets.map((x) => x.name);
  const sheetArg = flags.sheet !== undefined ? String(flags.sheet) : null;
  let target;
  if (sheetArg) { target = model.sheets.find((x) => x.name === sheetArg); if (!target) die('invalid-output', `表名不认识：${JSON.stringify(sheetArg)}`, `表名必须来自枚举，本件实有：${names.join(' | ')}`); }
  else if (names.length === 1) target = model.sheets[0];
  else die('invalid-output', '多表工作簿必须 --sheet 点名', `本件表名：${names.join(' | ')}（猜表名不算流程，《规范》§7.2）`);
  if (!parts.has(target.part)) die('invalid-document', `表「${target.name}」的部件不在包里：${target.part}`, '件坏了，从来源重取');
  const sheetXmlOrig = str(parts.get(target.part));
  if (/<(?:[A-Za-z0-9]+:)?sheetProtection\b/.test(sheetXmlOrig)) die('unsupported-format', `表「${target.name}」带工作表保护`, '先撤销保护再来（装置不改保护位，也不假装它不在）');
  const axis = op.startsWith('row') ? 'row' : 'col';
  const kind = op.endsWith('insert') ? 'insert' : 'move';
  const ext = soExtent(sheetXmlOrig);
  const extent = axis === 'row' ? ext.maxRow : ext.maxCol;
  if (!extent) die('invalid-document', `表「${target.name}」读不到任何行列下标`, '空表没什么可移；要用别的路径建表');
  const count = flags.count !== undefined ? Number(flags.count) : SHEETOP_DEFAULT_COUNT;
  if (!Number.isInteger(count) || count < 1 || count > SHEETOP_MAX_SHIFT) die('invalid-output', `--count 必须是 1..${SHEETOP_MAX_SHIFT} 的整数，给了 ${JSON.stringify(flags.count)}`, '大批量分几次跑，每次都单独对账');
  let at = null, to = null;
  if (kind === 'insert') {
    at = flags.at !== undefined ? Number(flags.at) : NaN;
    if (!Number.isInteger(at) || at < 1 || at > extent + 1) die('invalid-output', `--at 必须在 1..${extent + 1}（本表已用到第 ${extent} ${axis === 'row' ? '行' : '列'}），给了 ${JSON.stringify(flags.at)}`, '按真实已用范围给落点');
    if (flags.from !== undefined || flags.to !== undefined) die('invalid-output', `${op} 用 --at（可带 --count），不接受 --from／--to`, '移动用 row-move／col-move：--from N --to M');
  } else {
    at = flags.from !== undefined ? Number(flags.from) : NaN;
    to = flags.to !== undefined ? Number(flags.to) : NaN;
    if (!Number.isInteger(at) || at < 1 || at > extent) die('invalid-output', `--from 必须在 1..${extent}，给了 ${JSON.stringify(flags.from)}`, '先按已用范围给下标');
    if (!Number.isInteger(to) || to < 1 || to > extent) die('invalid-output', `--to 必须在 1..${extent}（最终布局里数），给了 ${JSON.stringify(flags.to)}`, '先按已用范围给下标');
    if (at === to) die('invalid-output', `--from 与 --to 相同（${at}）＝没有移动`, '不给 no-op：换个落点，或别跑这条');
    if (flags.at !== undefined || flags.count !== undefined) die('invalid-output', `${op} 用 --from／--to，不接受 --at／--count`, '插入用 row-insert／col-insert：--at N [--count k]');
  }
  const mapAxis = soAxisMap(kind, at, to === null ? at : to, count);
  mapAxis.specials = kind === 'move' ? [at, to] : [at]; // 包围盒归一要用：分段单位斜率映射的断点只有这两三个
  const mapRow = axis === 'row' ? mapAxis : IDMAP;
  const mapCol = axis === 'col' ? mapAxis : IDMAP;
  const outPath = positional[2] ? abs(positional[2]) : freePath(OUT_DIR, `${path.basename(input, '.' + extOf(input))}-${op}-${stamp()}`, 'xlsx');
  if (positional[2] && fs.existsSync(outPath)) die('invalid-output', `输出已存在，绝不覆盖：${outPath}`, '换个输出路径，或省掉参数让装置落 _out');
  if (abs(input) === abs(outPath)) die('invalid-output', '输入与输出是同一个文件', '装置按设计拒绝原地改结构');

  const timeoutMs = flags['timeout-ms'] !== undefined ? Number(flags['timeout-ms']) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) die('invalid-output', `--timeout-ms 必须是正整数，给了 ${JSON.stringify(flags['timeout-ms'])}`, '照 help 的默认值 120000 给，或去掉这个开关');
  const skipRecalc = Boolean(flags['skip-recalc']); // 在这里读一次：开关是宣告面的一部分，读它的必须是被宣告的那条命令本体
  const st = { refs: 0, cacheCleared: 0, partsRewritten: [] };
  const sideOfTarget = soSheetSideParts(parts, target.part);
  let calcChainDropped = false;
  const rewritten = new Set();
  const list = [];
  const handle = (name, data) => {
    if (name === 'xl/calcChain.xml') { calcChainDropped = true; return null; }
    if (name === '[Content_Types].xml') { const x = str(data).replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ''); if (x !== str(data)) rewritten.add(name); return x === str(data) ? data : Buffer.from(x, 'utf8'); }
    if (name === 'xl/_rels/workbook.xml.rels') { const x = str(data).replace(/<Relationship\b[^>]*Target="(?:\/?xl\/)?calcChain\.xml"[^>]*\/>/g, ''); if (x !== str(data)) rewritten.add(name); return x === str(data) ? data : Buffer.from(x, 'utf8'); }
    if (name === 'xl/workbook.xml') { rewritten.add(name); const x = soRewriteWorkbook(str(data), target.name, mapRow, mapCol, names, st); return Buffer.from(x, 'utf8'); }
    const sh = model.sheets.find((x) => x.part === name);
    if (sh) {
      rewritten.add(name);
      const isTarget = sh.name === target.name;
      const x = soRewriteSheet(str(data), sh.name, target.name, isTarget ? mapRow : IDMAP, isTarget ? mapCol : IDMAP, mapRow, mapCol, names, st);
      return Buffer.from(x, 'utf8');
    }
    if (/^xl\/charts\/[^/]+\.xml$/.test(name)) {
      rewritten.add(name);
      const x = str(data).replace(/<c:f>([\s\S]*?)<\/c:f>/g, (m0, body) => {
        const txt = xmlUnesc(body);
        let rw; try { rw = soRewriteRefList(txt, null, target.name, mapRow, mapCol, names); } catch { return m0; }
        st.refs += rw.changed;
        return rw.changed ? `<c:f>${soEsc(rw.text)}</c:f>` : m0;
      });
      return Buffer.from(x, 'utf8');
    }
    if (sideOfTarget.drawings.includes(name)) {
      rewritten.add(name);
      const x = str(data).replace(/<xdr:(?:from|to)\b[\s\S]*?<\/xdr:(?:from|to)>/g, (m0) => {
        let nb = m0;
        const cm = /<xdr:col>(\d+)<\/xdr:col>/.exec(nb);
        const rm = /<xdr:row>(\d+)<\/xdr:row>/.exec(nb);
        if (cm) { const n = mapCol(+cm[1] + 1) - 1; if (n !== +cm[1]) { nb = nb.replace(/<xdr:col>\d+<\/xdr:col>/, () => `<xdr:col>${n}</xdr:col>`); st.refs += 1; } }
        if (rm) { const n = mapRow(+rm[1] + 1) - 1; if (n !== +rm[1]) { nb = nb.replace(/<xdr:row>\d+<\/xdr:row>/, () => `<xdr:row>${n}</xdr:row>`); st.refs += 1; } }
        return nb;
      });
      return Buffer.from(x, 'utf8');
    }
    if (sideOfTarget.tables.includes(name)) {
      rewritten.add(name);
      let x = str(data);
      for (const m0 of [...x.matchAll(/<(table|autoFilter|sortState)\b([^>]*?)>/g)]) {
        const r = /\bref="([^"]*)"/.exec(m0[2]); if (!r) continue;
        const rw = soRewriteRefList(r[1], target.name, target.name, mapRow, mapCol, names);
        st.refs += rw.changed;
        if (rw.changed) x = x.replace(m0[0], () => `<${m0[1]}${m0[2].replace(/\bref="[^"]*"/, () => `ref="${rw.text}"`)}>`);
      }
      return Buffer.from(x, 'utf8');
    }
    return data;
  };
  let payload;
  try {
    for (const [name, data] of parts) { const nd = handle(name, data); if (nd !== null) list.push({ name, data: nd, method: 8 }); }
    payload = zipWrite(list);
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 220);
    die(/不猜|形状不认识|没有 r 属性|表名|dataTable/.test(msg) ? 'unsupported-format' : 'failed', `引用重写被拒：${msg}`, '结构化引用／三维引用／透视／外链／保护件／缺 r 属性这一类装置不硬做——请在源程序里改');
  }
  fs.writeFileSync(outPath, payload);
  if (sha256(fs.readFileSync(input)) !== inSha) die('failed', '原件被动过（sheetop 对输入零写入）', '装置缺陷：原样回报，不要重试');
  return soAuditAndReport({ input, outPath, op, axis, kind, at, to, count, target, names, model, st, inSha, flags, buf, t0, parts, mapRow, mapCol, sideOfTarget, calcChainDropped, rewritten, timeoutMs, skipRecalc });
}

/** 读一份 xlsx 的逐格取值（t="s" 先经 sharedStrings 解回文字——引擎尺比的是**文档里的值**，不是串表下标）。 */
function soValues(file) {
  const map = zipRead(fs.readFileSync(file));
  const sst = [];
  if (map.has('xl/sharedStrings.xml')) for (const m of str(map.get('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)) sst.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlUnesc(x[1])).join(''));
  const res = {};
  for (const [name, data] of map) {
    const m = /^xl\/worksheets\/(.+)\.xml$/.exec(name); if (!m) continue;
    const cells = {};
    for (const c of str(data).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const addr = (/\br="([A-Za-z]+\d+)"/.exec(c[1]) || [])[1]; if (!addr) continue;
      const inner = c[2] || "";
      const t = ((/\bt="([^"]*)"/.exec(c[1]) || [])[1]) || "";
      const vv = /<v>([\s\S]*?)<\/v>/.exec(inner);
      let val = vv ? xmlUnesc(vv[1]) : null;
      if (t === "s" && val !== null) { const ix = Number(val); val = Number.isInteger(ix) && sst[ix] !== undefined ? sst[ix] : val; }
      cells[addr] = { formula: /<f\b/.test(inner), value: val };
    }
    res[m[1]] = cells;
  }
  return res;
}
/** 盘上产物的引用图同构对账（与写它的那串 replace 不是同一条路径）＋可选引擎尺。 */
function soAuditFormula(bad, beforeText, afterText, label, own, edited, mapRow, mapCol, allNames) {
  let a, b;
  try { a = soSplitFormula(beforeText); b = soSplitFormula(afterText); } catch (e) { bad.push(`${label}：切词失败 ${e.message}`); return 0; }
  if (a.length !== b.length) { bad.push(`${label}：切词段数 ${a.length}→${b.length}（非引用片段被改动或引用被吞）`); return 0; }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].t !== b[i].t) { bad.push(`${label}：第 ${i + 1} 段类型变了`); continue; }
    if (a[i].t === 'txt') { if (a[i].raw !== b[i].raw) bad.push(`${label}：第 ${i + 1} 段非引用文本被改动：${JSON.stringify(a[i].raw)}→${JSON.stringify(b[i].raw)}`); continue; }
    let want;
    try { want = soMapRef(a[i], mapRow, mapCol, own, edited, allNames); } catch (e) { bad.push(`${label}：${e.message}`); continue; }
    if (want !== b[i].raw) bad.push(`${label}：引用没跟着映射（应 ${JSON.stringify(want)}，实 ${JSON.stringify(b[i].raw)}）`);
  }
  return a.length;
}

function soAuditAndReport(ctx) {
  const { input, outPath, op, axis, kind, at, to, count, target, names, model, st, inSha, flags, buf, t0, parts, mapRow, mapCol, sideOfTarget, calcChainDropped, rewritten, timeoutMs, skipRecalc } = ctx;
  const bad = [];
  const warnings = [];
  const prodBytes = fs.readFileSync(outPath);
  let prodParts;
  try { prodParts = zipRead(prodBytes); } catch (e) { die('failed', `产物解包失败（${String(e && e.message || e).slice(0, 120)}）：这份 xlsx 自己就不合法`, '装置缺陷：原样回报，不要重试'); }
  let sites = 0, cellMoved = 0;
  let prodModel;
  try { prodModel = soWorkbookModel(prodParts); } catch (e) { die('failed', `产物的工作簿读不出来：${String(e && e.message || e).slice(0, 140)}`, '装置缺陷：原样回报，不要重试'); }

  for (const sh of model.sheets) {
    const own = sh.name, isTarget = own === target.name;
    const cR = isTarget ? mapRow : IDMAP, cC = isTarget ? mapCol : IDMAP;
    if (!parts.has(sh.part) || !prodParts.has(sh.part)) { bad.push(`${own}：部件在原件或产物里缺失`); continue; }
    const b = soCollectSheet(str(parts.get(sh.part)));
    const a = soCollectSheet(str(prodParts.get(sh.part)));
    const wantAddrs = b.cells.filter((c) => c.addr).map((c) => soMapCell(c.addr, cR, cC)).sort();
    const gotAddrs = a.cells.filter((c) => c.addr).map((c) => c.addr).sort();
    if (wantAddrs.length !== gotAddrs.length) bad.push(`${own}：格子条数 ${wantAddrs.length}→${gotAddrs.length}（双射破了）`);
    else for (let i = 0; i < wantAddrs.length; i += 1) if (wantAddrs[i] !== gotAddrs[i]) { bad.push(`${own}：地址集合不是原集合在映射下的像（第 ${i + 1} 处应 ${wantAddrs[i]} 实 ${gotAddrs[i]}）`); break; }
    if (isTarget) cellMoved += b.cells.filter((c) => c.addr && soMapCell(c.addr, mapRow, mapCol) !== c.addr).length;
    for (const c of b.cells) {
      if (!c.addr || c.fText === null) continue;
      const tgtAddr = soMapCell(c.addr, cR, cC);
      const pair = a.cells.find((x) => x.addr === tgtAddr);
      if (!pair) { bad.push(`${own}!${c.addr}：产物里找不到对应格子`); continue; }
      sites += soAuditFormula(bad, c.fText, pair.fText, `${own}!${c.addr}`, own, target.name, mapRow, mapCol, names) || 1;
      const exp = soRewriteFormula(c.fText, own, target.name, mapRow, mapCol, names);
      if (exp.changed && pair.hasCache) bad.push(`${own}!${c.addr}：公式被改但缓存值没清（陈旧数会直接进 CSV／PDF，《规范》§7.1）`);
      if (c.fAttrs && /\bref="([^"]*)"/.test(c.fAttrs)) {
        const fr = /\bref="([^"]*)"/.exec(c.fAttrs)[1];
        const want2 = soRewriteRefList(fr, own, target.name, mapRow, mapCol, names).text;
        const got2 = pair.fAttrs ? ((/\bref="([^"]*)"/.exec(pair.fAttrs) || [null, ''])[1]) : '';
        if (want2 !== got2) bad.push(`${own}!${c.addr}：共享／数组公式的 ref 区没跟着映射（应 ${want2} 实 ${got2}）`);
      }
    }
    if (b.attrs.length !== a.attrs.length) bad.push(`${own}：引用位条数 ${b.attrs.length}→${a.attrs.length}`);
    else for (let i = 0; i < b.attrs.length; i += 1) {
      const bb = b.attrs[i], aa = a.attrs[i];
      if (bb.tag !== aa.tag || bb.attr !== aa.attr) { bad.push(`${own}：第 ${i + 1} 个引用位的标签或属性名变了`); continue; }
      const want3 = soRewriteRefList(bb.value, own, target.name, mapRow, mapCol, names).text;
      sites += 1;
      if (want3 !== aa.value) bad.push(`${own}：第 ${i + 1} 个 ${bb.tag}@${bb.attr} 应=${JSON.stringify(want3)} 实=${JSON.stringify(aa.value)}`);
    }
    if (b.spans.length !== a.spans.length) bad.push(`${own}：spans 条数变了`);
    else b.spans.forEach((sp, i) => { const want4 = [cC(sp[0]), cC(sp[1])]; if (want4[0] !== a.spans[i][0] || want4[1] !== a.spans[i][1]) bad.push(`${own}：第 ${i + 1} 处 spans 应 ${want4.join(':')} 实 ${a.spans[i].join(':')}`); });
    if (b.breaks.length !== a.breaks.length) bad.push(`${own}：分页符条数变了`);
    else b.breaks.forEach((br, i) => { const want5 = br.kind === 'rowBreaks' ? cR(br.id) : cC(br.id); if (want5 !== a.breaks[i].id) bad.push(`${own}：第 ${i + 1} 个 ${br.kind} 应 ${want5} 实 ${a.breaks[i].id}`); });
    if (b.blockFormulas.length !== a.blockFormulas.length) bad.push(`${own}：条件格式／数据验证的规则式引用条数变了`);
    else b.blockFormulas.forEach((f, i) => {
      let exp2;
      try { exp2 = soRewriteFormula(f, own, target.name, mapRow, mapCol, names).text; } catch { return; }
      sites += 1;
      if (exp2 !== a.blockFormulas[i]) bad.push(`${own}：第 ${i + 1} 条规则式引用应=${JSON.stringify(exp2)} 实=${JSON.stringify(a.blockFormulas[i])}`);
    });
  }

  for (const dn of model.definedNames) {
    const pn = prodModel.definedNames.find((x) => x.name === dn.name);
    if (!pn) { bad.push(`命名域「${dn.name}」在产物里没了`); continue; }
    const mapName = (txt) => {
      if (!/[A-Za-z]/.test(txt) || !/!/.test(txt) || /#(REF|NAME|VALUE|DIV\/0|NULL|NUM)!(?![A-Za-z])/.test(txt)) return txt;
      return soRewriteRefList(txt, null, target.name, mapRow, mapCol, names).text;
    };
    const want6 = mapName(dn.text);
    sites += 1;
    if (want6 !== pn.text) bad.push(`命名域「${dn.name}」应=${JSON.stringify(want6)} 实=${JSON.stringify(pn.text)}`);
  }
  for (const [name, data] of parts) {
    if (!/^xl\/charts\/[^/]+\.xml$/.test(name)) continue;
    if (!prodParts.has(name)) { bad.push(`${name}：图表部件在产物里没了`); continue; }
    const bR = [...str(data).matchAll(/<c:f>([\s\S]*?)<\/c:f>/g)].map((m) => xmlUnesc(m[1]));
    const aR = [...str(prodParts.get(name)).matchAll(/<c:f>([\s\S]*?)<\/c:f>/g)].map((m) => xmlUnesc(m[1]));
    if (bR.length !== aR.length) { bad.push(`${name}：图表引用条数 ${bR.length}→${aR.length}`); continue; }
    bR.forEach((r, i) => {
      let want7 = r;
      try { if (/[A-Za-z]/.test(r)) want7 = soRewriteRefList(r, null, target.name, mapRow, mapCol, names).text; } catch (e) { bad.push(`${name}：${e.message}`); return; }
      sites += 1;
      if (want7 !== aR[i]) bad.push(`${name}：第 ${i + 1} 个图表系列引用没跟着映射（应 ${want7} 实 ${aR[i]}）`);
    });
  }
  for (const name of sideOfTarget.drawings) {
    if (!prodParts.has(name)) { bad.push(`${name}：绘图部件在产物里没了`); continue; }
    const pick = (src) => [...src.matchAll(/<xdr:(?:from|to)\b[\s\S]*?<\/xdr:(?:from|to)>/g)].map((m) => [+/<xdr:col>(\d+)</.exec(m[0])?.[1] ?? -1, +/<xdr:row>(\d+)</.exec(m[0])?.[1] ?? -1]);
    const bA = pick(str(parts.get(name))), aA = pick(str(prodParts.get(name)));
    if (bA.length !== aA.length) { bad.push(`${name}：锚点条数 ${bA.length}→${aA.length}`); continue; }
    bA.forEach((p, i) => {
      const ec = p[0] < 0 ? p[0] : mapCol(p[0] + 1) - 1, er = p[1] < 0 ? p[1] : mapRow(p[1] + 1) - 1;
      sites += 1;
      if (ec !== aA[i][0] || er !== aA[i][1]) bad.push(`${name}：第 ${i + 1} 个锚点应 (col ${ec}, row ${er}) 实 (col ${aA[i][0]}, row ${aA[i][1]})`);
    });
  }
  for (const name of sideOfTarget.tables) {
    if (!prodParts.has(name)) { bad.push(`${name}：表部件在产物里没了`); continue; }
    const bR = /\bref="([^"]*)"/.exec(str(parts.get(name))), aR = /\bref="([^"]*)"/.exec(str(prodParts.get(name)));
    if (!bR || !aR) { bad.push(`${name}：表的 ref 读不到`); continue; }
    const want8 = soRewriteRefList(bR[1], target.name, target.name, mapRow, mapCol, names).text;
    sites += 1;
    if (want8 !== aR[1]) bad.push(`${name}：表范围没跟着映射（应 ${want8} 实 ${aR[1]}）`);
    const rowOfEnd = +/\d+$/.exec(bR[1].split(':')[1] || '')[0];
    const colOfEnd = colToIdx(/([A-Za-z]+)/.exec((bR[1].split(':')[1] || '').replace(/^\$/, ''))?.[1] || 'A');
    if (kind === 'insert' && ((axis === 'row' && rowOfEnd >= at) || (axis === 'col' && colOfEnd >= at))) warnings.push(`插点落进表部件 ${path.basename(name)} 的范围之内：Excel 会把表扩张，装置只映射地址、不改表语义（要"表自动长一行"请在源程序里确认）`);
  }
  if (prodParts.has('xl/calcChain.xml')) bad.push('🔴 产物仍带 xl/calcChain.xml：地址变了而计算链没变，按旧序重算就是错数');
  if (calcChainDropped && /\/xl\/calcChain\.xml/.test(str(prodParts.get('[Content_Types].xml')))) bad.push('calcChain 部件删了但 [Content_Types].xml 还登记着它');
  if (calcChainDropped && /Target="(?:\/?xl\/)?calcChain\.xml"/.test(str(prodParts.get('xl/_rels/workbook.xml.rels')))) bad.push('calcChain 部件删了但 workbook 的关系还指着它');
  if (!/fullCalcOnLoad="1"/.test(str(prodParts.get('xl/workbook.xml')))) bad.push('产物没写 fullCalcOnLoad="1"：读方不会强制重算，陈旧缓存照用');
  let untouchedSame = 0;
  for (const [name, data] of parts) {
    if (name === 'xl/calcChain.xml') continue;
    if (!prodParts.has(name)) { if (!rewritten.has(name)) bad.push(`${name}：既不在改动清单里，产物里却又没了`); continue; }
    if (rewritten.has(name)) continue;
    if (!prodParts.get(name).equals(data)) bad.push(`${name}：不在本次要改的部件清单里，却被改了`);
    else untouchedSame += 1;
  }

  let recalc = { ran: false, reason: null, mismatches: [], cellsCompared: 0, formulaCellsExcludedForMove: 0, refErrorsBefore: null, refErrorsAfter: null };
  if (skipRecalc) recalc.reason = 'skip-recalc-flag';
  else if (!resolveKitCli().present) { recalc.reason = 'kit-unavailable'; warnings.push('🔴 没跑引擎尺（kit 不在位）：引用图只过了结构同构，**数值等价未证**，别宣称"改了也一样"'); }
  else {
    const base = path.basename(input, '.' + extOf(input));
    const a1 = freePath(OUT_DIR, `${base}-sheetop-origRecalc`, 'xlsx');
    const a2 = freePath(OUT_DIR, `${base}-sheetop-prodRecalc`, 'xlsx');
    const r1 = runKit(['recalculate', '--input', input, '--output', a1, '--timeout-ms', String(timeoutMs)]);
    const r2 = runKit(['recalculate', '--input', outPath, '--output', a2, '--timeout-ms', String(timeoutMs)]);
    if (!r1.ok || !r2.ok) { recalc.reason = 'engine-' + String(r1.code || r2.code || 'unknown'); warnings.push('🔴 引擎尺没跑成 ⇒ 数值等价未证（结构同构仍成立）'); }
    else {
      const m1 = soValues(a1), m2 = soValues(a2);
      const countRefErr = (mm) => Object.values(mm).reduce((s, cells) => s + Object.values(cells).filter((c) => /#REF!|#NAME\?/.test(String(c.value))).length, 0);
      recalc.ran = true; recalc.refErrorsBefore = countRefErr(m1); recalc.refErrorsAfter = countRefErr(m2);
      for (const [key, cells] of Object.entries(m1)) {
        const sh = model.sheets.find((x) => path.posix.basename(x.part).replace(/\.xml$/, '') === key);
        if (!sh) continue;
        const isTarget = sh.name === target.name;
        const cR = isTarget ? mapRow : IDMAP, cC = isTarget ? mapCol : IDMAP;
        const other = m2[key] || {};
        const skipFormulaCells = kind === 'move'; // 移行/移列会把格子移进或移出引用区间，区间成员变了数值就该变（与 Excel 一致）——那一半不由引擎尺判
        for (const [addr, info] of Object.entries(cells)) {
          const tgtAddr = soMapCell(addr, cR, cC);
          const got = other[tgtAddr];
          if (skipFormulaCells && info.formula) { recalc.formulaCellsExcludedForMove += 1; continue; }
          recalc.cellsCompared += 1;
          const v1 = info.value === null ? '' : String(info.value);
          const v2 = !got || got.value === null ? '' : String(got.value);
          if (v1 !== v2 && recalc.mismatches.length < 5) recalc.mismatches.push({ sheet: sh.name, addr, mapsTo: tgtAddr, before: v1, after: v2 });
        }
      }
      // 🔴 比到 0 格＝这把尺根本没量到东西，不许报"过了"（2026-10-14 实犯：basename 留着 .xml 比不中，recalc.ran=true 而 cellsCompared=0）
      if (recalc.ran && recalc.cellsCompared + recalc.formulaCellsExcludedForMove === 0) bad.push('引擎尺比到 0 格：原件没有任何格子配上产物侧的对应表——数值等价未证，别当通过');
      if (recalc.mismatches.length) bad.push(`🔴 引擎重算后 ${recalc.mismatches.length} 格数值沿映射不等（前 5 条：${recalc.mismatches.map((x) => `${x.sheet}!${x.addr}→${x.mapsTo}：${x.before} vs ${x.after}`).join(' ; ')})）`);
      if (recalc.refErrorsAfter > recalc.refErrorsBefore) bad.push(`#REF!/#NAME? 由 ${recalc.refErrorsBefore} 涨到 ${recalc.refErrorsAfter}：引用被改断了`);
    }
  }

  if (bad.length) {
    try { fs.rmSync(outPath, { force: true }); } catch { }
    die('failed', `引用图对账不过（产物已撤，不留半成品）：${bad.slice(0, 4).join(' | ')}`, '这是装置缺陷：原样回报，不要重试，也别把这份当"改好了"');
  }
  out({
    ok: true, op: 'sheetop', action: op, axis, kind, sheet: target.name,
    input: { path: input, bytes: buf.length, sha256: inSha, unchanged: true },
    output: { path: outPath, bytes: prodBytes.length, sha256: sha256(prodBytes) },
    shift: kind === 'insert' ? { at, count } : { from: at, to },
    extentUsed: axis === 'row' ? soExtent(sheetXmlOf(parts, target)).maxRow : soExtent(sheetXmlOf(parts, target)).maxCol,
    cellsMoved: cellMoved, refsRewritten: st.refs, cacheCleared: st.cacheCleared,
    partsRewritten: [...rewritten], partsUnchangedByteIdentical: untouchedSame, calcChainRemoved: calcChainDropped,
    verify: { method: '重新解开产物逐条对账：非引用片段逐字不变＋引用落点＝原件同一片段按轴映射的像＋格子地址双射', sitesChecked: sites, refGraph: 'isomorphic', cellBijection: 'exact', recalc },
    ms: Date.now() - t0,
    warnings: warnings.length ? warnings : undefined,
    note: '改完的数字交付仍必须 recalc 再导出（《规范》§7.1）。引擎尺口径：插入类逐格（含公式格）对数值；移动类只对**数据格**逐格对数值——把行/列移进引用区间会改变区间成员，公式格的数值本来就该变（与 Excel 一致），那一半由引用图同构那把尺管',
  });
}
function sheetXmlOf(parts, target) { return str(parts.get(target.part)); }

/* ================= v2.9.0 O2：gc（测试产物回收；默认 dry-run，执行态是"移动"不是删除） =================
 * 指纹为什么用装置时间戳而不是家族名清单：装置落的每一件产物都带自己的 UTC 段（freePath 生成 <base>-<stamp>[-n].ext），
 * 人自己起的名字不带 ⇒ "这是装置落的"是可判的客观形状。家族清单会漏（夹具一改就漏），而漏的方向不可控；
 * 时间戳这一条只可能"漏清"（安全），不可能"误清人件"（危险）。
 * 🔴 v2.10.0 订正上面这最后一句：签名只证明"这不是人起的名字"，**不证明"这不是真工件"**——真交付件（课件/作业）
 *    经装置转出来的产物同样带 UTC 段。本机 2026-10-14 在 --age 1 的候选面里实测混着 12 件这种产物。
 *    所以防误清是两层，不是一层：① 默认 dry-run 把清单摊开给人看；② `--exclude 前缀,...` 把要留的圈出去，
 *    且被排除件**单独记账**（不混进 missed），让"我没收"与"我故意留"是两种看得出的形状。
 * 另外两条边界：只扫 _out/_tmp（真件在 test/fixtures、_probe、D:\...\装置样本，天然不在面上）；
 *               只碰 mtime 早于 --age 天的件（默认 7 天），本轮刚落的产物一律不动。
 */
const GC_STAMP_FILE_RE = /-20\d{12}(?:-\d+)?(\.[A-Za-z0-9]{1,8})?$/;
// 第二条指纹：写后端（OfficeCLI，外部件）留在 _out 的事务残骸 `.savetmp-<32位hex>`——这种后缀只有机器会起，
// 人不会给文件这么命名；它不由装置产生（装置源码里没有 savetmp 字样），所以单列一条，并同样受 --age 与"只扫 _out/_tmp"约束。
// 实测本机 2026-10-14：_out 顶层里这一族只有 10 件（我先前把一条 grep 读数看成了 9,468，那是"不含 savetmp 的条目数"，已按实数订正）。
const GC_BACKEND_TMP_RE = /\.savetmp-[0-9a-f]{32}$/;
// 第三条指纹：**目录形态**的产物（pages 渲染、media 抽图、ocr 语言包等一件一个目录），目录名同样以装置时间戳段结尾；
// 不递归进去数单个文件，整只目录一次搬走（隔离区内保留相对路径，可整只搬回）。
const GC_STAMP_DIR_RE = /-20\d{12}(?:-\d+)?$/;
const GC_TMP_NAME_RE = /^(selftest|probe|audit)-20\d{12}/;
// 🔴 隔离区必须与产物区**同卷**：取「仓库同级」而不是写死绝对路径。实犯形状（真克隆门 dep-set check 抓到）：
//    写死绝对路径常量时，把本仓 clone 到别的卷的临时目录再跑 gc 判据，renameSync 跨卷直接失败（EXDEV/EPERM），
//    主树永远看不见——因为主树与隔离区恰好同卷。取 dirname(ROOT) 后：主树与隔离区保持同级（对外口径不变），
//    而任何克隆态都落在它自己的同级目录里——同卷、搬得动、也才谈得上可逆。
const GC_QUARANTINE_ROOT = path.dirname(ROOT) + '/垃圾产物';

function gcDirBytes(p) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) total += gcDirBytes(q);
      else { try { total += fs.statSync(q).size; } catch { } }
    }
  } catch { }
  return total;
}

function gcScan(dir, opts) {
  const { includeDirs, ageMs, now, base, exclude } = opts;
  const hit = [], missed = [], excluded = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return { hit, missed, absent: true }; }
  for (const name of names) {
    let st;
    try { st = fs.lstatSync(path.join(dir, name)); } catch { continue; }
    const isDir = st.isDirectory();
    const fp = isDir ? (includeDirs && (GC_TMP_NAME_RE.test(name) || GC_STAMP_DIR_RE.test(name))) : (!isDir && (GC_STAMP_FILE_RE.test(name) || GC_BACKEND_TMP_RE.test(name)));
    if (!fp) { if (!isDir) missed.push(name); continue; }
    if (opts.base && !name.startsWith(opts.base)) { missed.push(name); continue; }
    // 🔴 --exclude：指纹命中、但名字以这些前缀开头的一律不收，并**单独记账**（不混进 missed——"没被圈进来"与"故意不收"是两种形状，
    //    糊在一起后人就看不出自己到底漏没漏）。立这一面的理由：装置时间戳只证明「这不是人起的名字」，
    //    **不证明「这不是真工件」**——真交付件（如课件/作业转出的 PDF）同样带装置签名，2026-10-14 实测候选面里就混着 9 件。
    if (exclude && exclude.length && exclude.some((pre) => name.startsWith(pre))) { excluded.push(name); continue; }
    const bytes = isDir ? gcDirBytes(path.join(dir, name)) : st.size;
    if (st.mtimeMs > now - ageMs) { hit.push({ name, bytes, isDir, skippedYoung: true }); continue; }
    hit.push({ name, bytes, isDir, skippedYoung: false, mtimeMs: st.mtimeMs });
  }
  return { hit, missed, excluded, absent: false };
}

function cmdGc(args) {
  const t0 = Date.now();
  const { flags } = parseArgs(args, 'gc');
  const which = flags.dir !== undefined ? String(flags.dir) : GC_DEFAULT_DIR;
  if (!['_out', '_tmp', 'both'].includes(which)) die('invalid-output', `--dir 只认 _out | _tmp | both，给了 ${JSON.stringify(flags.dir)}`, '照 help 给');
  const age = flags.age !== undefined ? Number(flags.age) : GC_MIN_AGE_DAYS;
  // 下限 1 天是**装置自我保护**：_tmp 里的 selftest-/probe- 目录同样带装置时间戳，若允许 age=0，
  // 一次 gc 就能把**正在跑的**那一轮自检工作目录（含 DOCKIT_OUT_DIR 重定向后的产物区）整只搬进隔离区，
  // 表现是别人那一轮莫名变红、却查不出谁动了它的件。要真收当天新件请显式给 --age 1，那已是这台装置允许的最紧边界。
  if (!Number.isInteger(age) || age < 1) die('invalid-output', `--age 必须是 ≥1 的整数（天），给了 ${JSON.stringify(flags.age)}`, '不许 0：0＝不按年龄过滤，会连正在跑的自检目录一起扫走（装置不给自己挖坑）');
  const go = Boolean(flags.yes);
  const now = Date.now();
  const ageMs = age * 86400000;
  // --base：给了就必须是非空前缀——空串/纯空白静默"不过滤"会让调用方以为自己圈住了子集（与 --exclude 空清单同族，v3.0.0 补）。
  if (flags.base !== undefined && !String(flags.base).trim()) die('invalid-output', `--base 给了却没有一个非空前缀（${JSON.stringify(String(flags.base))}）`, '要过滤就给一个非空前缀（如 --base gcfixture-）；不给 --base 才等于不过滤');
  const base = flags.base !== undefined ? String(flags.base).trim() : null;
  // --exclude：逗号分隔的前缀清单。给了却一个非空前缀都没有 ⇒ 直接拒（静默"不排除任何件"会让调用方以为圈住了）。
  const exclude = flags.exclude !== undefined ? String(flags.exclude).split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (flags.exclude !== undefined && !exclude.length) die('invalid-output', `--exclude 给了却没有一个非空前缀（${JSON.stringify(String(flags.exclude))}）`, '逗号分隔的前缀清单，例如 --exclude 实验报告,学号；空串或纯逗号不算有效排除面');
  const targets = [];
  if (which !== '_tmp') targets.push({ label: '_out', dir: ROOT + '/_out', includeDirs: true }); // 扫真正的 _out，不受 DOCKIT_OUT_DIR 重定向影响
  if (which !== '_out') targets.push({ label: '_tmp', dir: TMP_DIR, includeDirs: true });
  const dirs = [];
  const victims = [];
  for (const t of targets) {
    const r = gcScan(t.dir, { includeDirs: t.includeDirs, ageMs, now, base, exclude });
    const ok = r.hit.filter((x) => !x.skippedYoung);
    dirs.push({ dir: t.label, 可清: ok.length, 因太新跳过: r.hit.length - ok.length, 未匹配条数: r.missed.length, 未匹配样本: r.missed.slice(0, 10), 被排除条数: (r.excluded || []).length, 被排除样本: (r.excluded || []).slice(0, 10), 目录不存在: r.absent });
    for (const h of ok) victims.push({ ...h, dir: t.dir, label: t.label });
  }
  const bytesTotal = victims.reduce((n, x) => n + (x.bytes || 0), 0);
  const byFamily = {};
  for (const x of victims) {
    const m = /^(.+?)-(?:20\d{12})/.exec(x.name) || /^(.+?)-20\d{12}/.exec(x.name);
    const fam = (m ? m[1] : x.name.replace(GC_STAMP_FILE_RE, '').replace(GC_TMP_NAME_RE, '$1')) || '(无名族)';
    byFamily[fam] = (byFamily[fam] || 0) + 1;
  }
  const topFamilies = Object.entries(byFamily).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + '-*=' + v);

  if (!go) {
    out({
      ok: true, op: 'gc', dryRun: true, moved: 0,
      candidates: victims.length, bytesTotal, topFamilies, ageDays: age, dirs,
      note: '默认 dry-run：**一个文件都没动**。要真收请加 --yes——--yes 也不删除，是把件移进隔离区（' + GC_QUARANTINE_ROOT + '\\dockit-gc-<时刻>\\，带 MANIFEST.md 可逐条搬回）',
      next: victims.length ? `确认后跑：gc --yes --age ${age}` + (which !== 'both' ? ' --dir ' + which : '') : '没有可回收的产物（只有带装置时间戳、且比 --age 老的 _out/_tmp 件才在面上）',
      ms: Date.now() - t0,
    });
    return;
  }

  const stampNow = stamp();
  const dest = path.posix.join(GC_QUARANTINE_ROOT, 'dockit-gc-' + stampNow).replace(/\//g, path.sep);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) die('invalid-output', `隔离区目标已存在且非空：${dest}`, '同秒撞车（极少见）；换一次时刻重跑——装置不覆盖别人的隔离批次');
  try { ensureDir(dest); } catch (e) { die('unavailable', `建不出隔离区 ${dest}：${String((e && e.message) || e).slice(0, 140)}`, '先确认 ' + GC_QUARANTINE_ROOT + ' 可写；本命令只搬移、不删除'); }
  const moved = [];
  const errors = [];
  const rows = [];
  for (const x of victims) {
    const srcPath = path.join(x.dir, x.name);
    const dstPath = path.join(dest, x.label, x.name);
    try {
      ensureDir(path.dirname(dstPath));
      fs.renameSync(srcPath, dstPath);
      let sha = '（大件或目录未算，按路径＋字节＋mtime 认领）';
      if (!x.isDir && x.bytes <= 5 * 1024 * 1024) { try { sha = sha256(fs.readFileSync(dstPath)); } catch { sha = '读不到'; } }
      rows.push('| ' + srcPath + ' | ' + x.label + '/' + x.name + ' | ' + x.bytes + ' | ' + new Date(x.mtimeMs || Date.now()).toISOString() + ' | ' + sha + ' |');
      moved.push({ from: srcPath, to: dstPath, bytes: x.bytes });
    } catch (e) {
      errors.push(srcPath + ' :: ' + String((e && e.message) || e).slice(0, 140));
      break;
    }
  }
  const head = [
    '# dockit gc 隔离批次（可逆回收，不是删除）',
    '',
    '- 时刻（UTC）：' + stampNow + ' ｜ 装置版本：v' + VERSION + ' ｜ 机器：本机',
    '- 触发命令行：`node dockit.js gc ' + args.join(' ') + '`',
    '- 规则：只收「带装置时间戳 `-20YYMMDDHHMMSS`」且 mtime 早于 --age ' + age + ' 天的 _out/_tmp 条目；不碰真件目录（test/fixtures、_probe、装置样本）',
    '- 搬运成功 **' + moved.length + '** 件／出错 **' + errors.length + '** 件（出错即停，未搬的仍在原位）；合计 ' + moved.reduce((n, m) => n + m.bytes, 0) + ' B',
    '- 复原：把「新相对路径」列的件 `rename` 回「原路径」即逐字节还原（sha256 列可核对）',
    '',
    '| 原路径 | 新相对路径 | 字节 | 原 mtime | sha256（≤5 MB 才算） |',
    '|---|---|---|---|---|',
    '',
  ].join('\n');
  try { fs.writeFileSync(path.join(dest, 'MANIFEST.md'), head + rows.join('\n') + '\n', 'utf8'); } catch (e) { errors.push('MANIFEST 写失败 :: ' + String((e && e.message) || e).slice(0, 140)); }
  out({
    ok: errors.length === 0, op: 'gc', dryRun: false, moved: moved.length,
    bytesMoved: moved.reduce((n, x) => n + x.bytes, 0),
    quarantine: dest, manifest: path.join(dest, 'MANIFEST.md'),
    candidates: victims.length, dirs,
    errors: errors.length ? errors.slice(0, 5) : undefined,
    note: '可逆回收：件都在隔离区，按 MANIFEST.md 逐条搬回即复原；装置不删任何东西。',
    ms: Date.now() - t0,
  });
  if (errors.length) process.exit(1);
}

async function cmdSelftest(args) {
  // 开关也走 HELP_SPEC 这一套（不再自己摸 process.argv）：这样 selftest 的 --only/--keep 与别的命令一样有宣告、有类型
  const { flags } = parseArgs(args || [], 'selftest');
  // 🔴 v1.7.2：目录名必须带 process.pid。旧命名只到秒，而覆盖率闸会 spawn 一发"缺失态子 selftest"——父子常常
  // 落在同一秒里算出**同一个 S**，谁先收尾谁就把 `_tmp/selftest-<秒>` 删掉，另一边后半程判据成片抛 ENOENT。
  // 我加了裸树/语言包几发 doctor 子进程之后时间对齐变了，2026-10-09 实犯：子 selftest failed=17，
  // 红因清一色是同一个 S 路径的 copyfile/open 失败（不是判据集合不对）。
  const S = ensureDir(TMP_DIR + '/selftest-' + stamp() + '-' + process.pid);
  // v2.9.0 O1：本次测试的所有产物改落 `<S>/out`——父进程直接改 OUT_DIR，判据里 spawn 出去的子装置进程靠 env 继承；
  // 收尾既有的 rmSync(S,{recursive:true}) 会把这一带一起带走，`--keep` 时随工作目录整目录保留供复盘。
  OUT_DIR = path.join(S, 'out');
  ensureDir(OUT_DIR);
  process.env.DOCKIT_OUT_DIR = OUT_DIR;
  const only = String(flags.only || '').split(',').map((x) => x.trim()).filter(Boolean);
  let filtered = 0;
  const checks = []; let passed = 0, failed = 0, skipped = 0;
  // R-A（v1.6.4）：依赖缺失 ⇒ 红转 SKIP 点名。本仓同形状连犯三次（D-1 后端族→F-1 tesseract 族→G-1 kit 族），
  // 每次只补刚被踩到的族——现在由**咽喉层统一兜住**：kit 不可用（探针 existsSync=false）时，任何判据的红
  // （直调 runKit 的、经子进程间接吃 kit 的、乃至静态判据的）一律转 SKIP 并点名：缺哪个依赖、探针返回值、
  // 属于依赖集合、以及🔴"若另有与 kit 无关的缺陷会被此 SKIP 掩盖"的如实声明（在位态全量与覆盖率闸兜底）。
  // 不许整条消失、不许静默通过：SKIP 计数进 skipped，集合由「依赖覆盖率闸」钉死。
  const kitPresent = () => resolveKitCli().present;
  // AUD-1 修复（v1.6.6，A 案逐条声明）：wrapT 只洗**带依赖声明**的判据——t/ta 第三参 `{needs:'kit'}`。
  // 旧形状（v1.6.4-v1.6.5）是"事后洗白"：kit 不在位时任何判据的红一律转 SKIP——无 .git 副本里 factcheck 被
  // 洗白、真克隆里页眉漂移的静态判据 v1 被洗成 SKIP（监工 AUD-1 两条一手证据），缺失态判据大面积哑火。
  // A 案语义：① 声明 `{needs:'kit'}` ＝ "本条真的需要 kit，缺失时允许 SKIP"；② 未声明的判据在缺失态**必须红**
  // （红因与 kit 无关的缺陷不许被洗）；③ 抛异常同理区分——声明了 ⇒ "因缺依赖而抛"转 SKIP，未声明 ⇒ "代码坏而抛"FAIL。
  // 为什么选 A 案不选 B 案（归因探针）：B 案要把"碰过缺失依赖"的置位传导进 doctor/公开命令等包装层与 3+ 个
  // 局部 spawn helper，链路长、漏一个 helper 就漏归因；A 案的声明是显式清单、机械可枚举（缺失态实测逐条补），
  // 且第四臂（无声明+缺失态必红 ⇒ 必须 FAIL）天然成立。声明本身由「真克隆态注册表＋覆盖率闸」守住不腐烂。
  const depSkipNote = (why) => { const kc = resolveKitCli(); return `skip（外部依赖不可用：LibreOffice kit（探针：KIT_CLI 解析自 ${kc.source} = ${kc.exe}，existsSync=${kc.present}）——本条声明了 {needs:'kit'}（缺失态允许 SKIP）；红因（${String(why).slice(0, 70)}）；集合由「依赖覆盖率闸」与 test/dep-set.js 真克隆注册表钉死）`; };
  const wrapT = (r, name, threw, needs) => { if (r === true) return ['pass', 'PASS ' + name]; if (r === 'skip' || (typeof r === 'string' && r.startsWith('skip'))) return ['skip', 'SKIP ' + name + ' :: ' + r]; if (needs && needs.needs === 'kit' && !kitPresent()) return ['skip', 'SKIP ' + name + ' :: ' + depSkipNote(threw ? 'threw ' + r.message : (typeof r === 'string' ? r : '(非字符串失败)'))]; return ['fail', 'FAIL ' + name + (typeof r === 'string' ? ' :: ' + r : '') + (threw ? ' :: threw ' + r.message : '')]; };
  const t = (name, fn, needs) => { if (only.length && !only.some((o) => name.includes(o))) { filtered++; return; } try { const r = fn(); const v = wrapT(r, name, false, needs); if (v[0] === 'pass') { passed++; checks.push(v[1]); } else if (v[0] === 'skip') { skipped++; checks.push(v[1]); } else { failed++; checks.push(v[1]); } } catch (e) { const v = wrapT(e, name, true, needs); if (v[0] === 'pass') { passed++; checks.push(v[1]); } else if (v[0] === 'skip') { skipped++; checks.push(v[1]); } else { failed++; checks.push('FAIL ' + name + ' :: threw ' + e.message); } } };
  const ta = async (name, fn, needs) => { if (only.length && !only.some((o) => name.includes(o))) { filtered++; return; } try { const r = await fn(); const v = wrapT(r, name, false, needs); if (v[0] === 'pass') { passed++; checks.push(v[1]); } else if (v[0] === 'skip') { skipped++; checks.push(v[1]); } else { failed++; checks.push(v[1]); } } catch (e) { const v = wrapT(e, name, true, needs); if (v[0] === 'pass') { passed++; checks.push(v[1]); } else if (v[0] === 'skip') { skipped++; checks.push(v[1]); } else { failed++; checks.push('FAIL ' + name + ' :: threw ' + e.message); } } };
  // 昂贵前置（起引擎）一律惰性：变异台按 --only 选跑哪几条时，不能被没选中的前置拖到超时
  const memo = {}; const once = (k, f) => (k in memo ? memo[k] : (memo[k] = f()));
  // 子进程（装置自己）失败时，把它的 code+error 提出来写进 FAIL 行：不这样，红只会是 "Unexpected end of JSON input"，
  // 变异台分不清"判据抓到了坏"和"夹具压根没写成"——红必须能归因（总览第八节第 11 条）。
  const kidErr = (txt) => {
    const s = String(txt || '').trim();
    const line = s.split('\n').filter(Boolean).pop() || '';
    try { const j = JSON.parse(line); return `${j.code || '?'} ${String(j.error || '').slice(0, 220)}`; } catch { /* 非 JSON：原样给，别装作读懂了 */ }
    return s.replace(/\s+/g, ' ').slice(0, 220) || '(子进程无 stderr)';
  };

  // ---- 夹具（自带，外人克隆也能跑）----
  const CN = '文档装置取证专用汉字串柒捌玖零', BOGUS = 'NoSuchFamilySelftestZZZ', AUTHOR = '自检夹具作者串';
  const S_ = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const DOCRELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${AUTHOR}</dc:creator><dc:title>自检夹具标题</dc:title></cp:coreProperties>`;
  const docx = (body) => zipWrite([{ name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: '_rels/.rels', data: Buffer.from(RELS) }, { name: 'docProps/core.xml', data: Buffer.from(CORE) }, { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCRELS) }, { name: 'word/document.xml', data: Buffer.from(body) }]);
  const cnPath = `${S}/cn.docx`, blankPath = `${S}/blank.docx`;
  fs.writeFileSync(cnPath, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="${BOGUS}" w:eastAsia="${BOGUS}" w:hAnsi="${BOGUS}"/></w:rPr><w:t>${CN}</w:t></w:r></w:p></w:body></w:document>`));
  fs.writeFileSync(blankPath, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t> </w:t></w:r></w:p></w:body></w:document>`));
  // 双表 + 含公式（C1 故意留错缓存值 999）
  const XLS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const xCT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const xRELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const xWBRELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
  const IS = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const sh1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${XLS}><dimension ref="A1:B2"/><sheetData><row r="1">${IS('A1', '自检表一表头')}${IS('B1', '第二列')}</row><row r="2"><c r="A2"><v>7</v></c></row></sheetData></worksheet>`;
  const sh2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${XLS}><dimension ref="A1"/><sheetData><row r="1">${IS('A1', '自检表二表头')}</row></sheetData></worksheet>`;
  const wb2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${XLS}><sheets><sheet name="自检第一页" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><sheet name="自检第二页" sheetId="2" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`;
  const xlsx = (workbook, s1, s2) => zipWrite([{ name: '[Content_Types].xml', data: Buffer.from(xCT) }, { name: '_rels/.rels', data: Buffer.from(xRELS) }, { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(xWBRELS) }, { name: 'xl/workbook.xml', data: Buffer.from(workbook) }, { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(s1) }, { name: 'xl/worksheets/sheet2.xml', data: Buffer.from(s2 || s1) }]);
  const twoPath = `${S}/two.xlsx`, fPath = `${S}/formula.xlsx`;
  fs.writeFileSync(twoPath, xlsx(wb2, sh1, sh2));
  const wf = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${XLS}><sheets><sheet name="算式" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`;
  const shF = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${XLS}><dimension ref="A1:C1"/><sheetData><row r="1"><c r="A1"><v>3</v></c><c r="B1"><f>A1*2</f></c><c r="C1"><f>SUM(A1:B1)</f><v>999</v></c></row></sheetData></worksheet>`;
  fs.writeFileSync(fPath, xlsx(wf, shF));

  // ---- 版本与能力对账
  t('v1 版本号五处一致（package.json / 本文件 / 项目总览 / README / 调用卡）', () => {
    const pkg = JSON.parse(str(fs.readFileSync(ROOT + '/package.json'))).version;
    const rd = fs.existsSync(ROOT + '/README.md') ? str(fs.readFileSync(ROOT + '/README.md')) : null;
    const card = fs.existsSync(ROOT + '/给其它agent-调用卡.md') ? str(fs.readFileSync(ROOT + '/给其它agent-调用卡.md')) : null;
    if (rd === null || card === null) return 'skip（README 或调用卡未建）';
    // F-2（v1.6.2）：五项全部改「行首锚（文本位）＋命中数必须 =1」。旧形状用 .test()（存在性语义），
    // README 一项连 ^ 都没有——正文任意位置一行同形串就能顶住页眉漂移（Z5 变异实测假绿）。
    // 命中数 =1 还能抓"页眉没改但别处补了一行"的顶包形状（M101 就是打这个）；调用卡的形状在行首引述符后，锚「**版本**：v」计数。
    const V = VERSION.replace(/\./g, '\\.');
    const hit1 = (re, txt) => (txt.match(new RegExp(re, 'gm')) || []).length === 1;
    const bad = [['package.json', pkg === VERSION], ['本文件 VERSION', hit1(`^ \\* 版本：v${V}`, str(fs.readFileSync(__filename)))], ['项目总览', hit1(`^版本 v${V} ｜`, str(fs.readFileSync(ROOT + '/项目总览.md')))], ['README', hit1(`^版本 v${V} ｜`, rd)], ['调用卡', hit1(`\\*\\*版本\\*\\*：v${V}`, card)]];
    const miss = bad.filter((x) => !x[1]).map((x) => x[0]);
    return miss.length === 0 ? true : '版本位漂移或同形串顶包（每处必须恰命中 1 次）: ' + miss.join(',');
  });
  t('v3 版本迭代位规则未被违反：大版本为机主批准的 3（机主 2026-10-14 令「版本号升 3.0.0」；AI 不得自升 X）', () => VERSION.startsWith('3.'));
  t('cap 能力矩阵与 kit 实测对账', () => {
    const c = runKit(['capabilities']); if (!c.ok) return 'capabilities 调用失败：' + c.error;
    const flat = {};
    for (const cv of c.conversions) { const fam = cv.inputs.includes('docx') ? 'word' : cv.inputs.includes('xlsx') ? 'sheet' : 'slide'; flat[fam] = { inputs: cv.inputs, outputs: cv.outputs }; }
    return JSON.stringify(normalize(flat)) === JSON.stringify(normalize(FORMAT_MATRIX)) ? true : `实测=${JSON.stringify(normalize(flat))}`;
  }, {needs:'kit'});
  t('help README 命令清单与 help() 一致（不被执行就删掉）', () => {
    if (!fs.existsSync(ROOT + '/README.md')) return 'skip（README 未建）';
    const rd = str(fs.readFileSync(ROOT + '/README.md'));
    const miss = Object.keys(HELP).filter((k) => !new RegExp(`(^|[^\\w-])${k}([^\\w-]|$)`).test(rd));
    return miss.length ? `README 缺命令说明：${miss.join(',')}` : true;
  });
  t('help Qoder skill 与调用卡都覆盖命令面（漂移=别的 agent 学到旧用法）', () => {
    const card = ROOT + '/给其它agent-调用卡.md';
    const skillPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.qoder-cn/skills/agent-doc-ops/SKILL.md');
    if (!fs.existsSync(card)) return 'skip（调用卡未建）';
    const texts = [['调用卡', str(fs.readFileSync(card))]];
    if (fs.existsSync(skillPath)) texts.push(['SKILL.md', str(fs.readFileSync(skillPath))]);
    else texts.push(['SKILL.md', null]);
    const out = [];
    for (const [label, txt] of texts) {
      if (txt === null) { out.push(`${label} 不在位`); continue; }
      const miss = Object.keys(HELP).filter((k) => !new RegExp(`(^|[^\\w-])${k}([^\\w-]|$)`).test(txt));
      if (miss.length) out.push(`${label} 缺：${miss.join(',')}`);
    }
    const hard = out.filter((x) => !x.startsWith('SKILL.md 不在位'));
    if (hard.length) return hard.join(' ; ');
    // skill 在位时还要它对得上当前版本（哨兵：漏改 SKILL.md 就在这儿红，不是靠人记）
    if (fs.existsSync(skillPath) && !str(fs.readFileSync(skillPath)).includes(`**v${VERSION}**`)) return `SKILL.md 未标 **v${VERSION}**`;
    return out.length > hard.length ? 'skip（这台机器没有 Qoder skill 文件，调用卡已单独通过——外人跑必走这支）' : true;
  });
  // v1.9.1：入口指路卡面哨兵（机主「全部 agent 通用且完整功能」）。在位的五家指路卡必须三件齐：指母本（给其它agent-调用卡.md）／
  // doctor 幂等前置（dockit.js doctor）／命令面现跑 help（dockit.js help）。带注入对照（一份"什么都没指向"的假卡必须被抓出 3 条），
  // 缺层即红；本机五家都不在位时 SKIP（外人克隆的常态，不冒充通过）。攻击：M147/M148/M149 各拆一层（靠注入对照计数现形）。
  t('入口指路卡面：在位的各家指路卡必须指母本＋带 doctor 前置＋写明命令面现跑 help（含注入对照）', () => {
    const cardCheck = (txt, label) => {
      const bad = [];
      if (!txt.includes('给其它agent-调用卡.md')) bad.push(`${label}: 未指母本（缺 给其它agent-调用卡.md）`);
      if (!txt.includes('dockit.js doctor')) bad.push(`${label}: 缺 doctor 幂等前置（缺 dockit.js doctor）`);
      if (!txt.includes('dockit.js help')) bad.push(`${label}: 缺"命令面现跑 help"句（缺 dockit.js help）`);
      return bad;
    };
    const ctrl = cardCheck('按本卡的说法去干活就行', '注入样本');
    if (ctrl.length !== 3) return `注入对照没被完整抓住（应 3 条、实 ${ctrl.length} 条）——检查函数没牙，不许当通过`;
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const cards = [
      ['Codex', path.join(home, '.codex/skills/agent-doc-ops/SKILL.md')],
      ['Cursor', path.join(home, '.cursor/skills-cursor/agent-doc-ops/SKILL.md')],
      ['TRAE', path.join(home, '.trae-cn/builtin_skills/agent-doc-ops/SKILL.md')],
      ['Qwen', path.join(home, '.qwenworkcn/commands/doc-ops.md')],
      ['LobsterAI', path.join(process.env.APPDATA || '', 'LobsterAI/SKILLs/agent-doc-ops/SKILL.md')],
    ];
    const present = cards.filter(([, p]) => p && fs.existsSync(p));
    if (!present.length) return 'skip（本机没有指路卡在位——外人克隆的常态；注入对照已验过检查函数有牙）';
    const bad = [];
    for (const [label, p] of present) for (const b of cardCheck(str(fs.readFileSync(p)), label)) bad.push(b);
    if (bad.length) return `核过 ${present.length} 家（${present.map(([l]) => l).join('/')}）⇒ ` + bad.slice(0, 8).join(' | ');
    return true;
  });

  // ---- R1-a（任务书 P1-4）：机器可读的命令面。三层各有各的独立攻击（规范 §4.4 第 ⑦ 条：多层防线不许搭便车）：
  //      默认值对账＝M42，default 写成引用常量＝M49，宣告与实装的覆盖面＝M50/M51，出口形状与原型链漏判走下一条判据（M52/M53）。
  t('help 结构化命令面：spec 三面同名、默认值等于配置区常量、宣告的开关被该命令真读、失败码都有处置文案', () => {
    // 过去的补丁脚本曾破坏反斜杠转义；本条覆盖控制字符和公开入口示例。
    const src = str(fs.readFileSync(__filename));
    const bodyOf = cmdBody;
    const bad = [];
    const specKeys = Object.keys(HELP_SPEC), cmdKeys = Object.keys(COMMANDS), helpKeys = Object.keys(HELP);
    const sym = (a, b) => [...a.filter((k) => !b.includes(k)), ...b.filter((k) => !a.includes(k))];
    const d1 = sym(specKeys, cmdKeys); if (d1.length) bad.push(`HELP_SPEC 与 COMMANDS 不同名：${d1.join(',')}`);
    const d2 = sym(helpKeys, cmdKeys); if (d2.length) bad.push(`HELP 与 COMMANDS 不同名：${d2.join(',')}`);
    const TYPES = ['string', 'int', 'json', 'boolean', 'choice'];
    for (const [k, sp] of Object.entries(HELP_SPEC)) {
      if (typeof sp.usage !== 'string' || !sp.usage.startsWith(k)) bad.push(`${k}: usage 缺失或不以命令名开头`);
      if (!Array.isArray(sp.positional) || !Array.isArray(sp.flags) || !Array.isArray(sp.codes)) bad.push(`${k}: positional/flags/codes 必须都是数组`);
      for (const f of sp.flags) {
        if (!f.name || !TYPES.includes(f.type) || !('default' in f)) bad.push(`${k}.--${f.name || '(无名开关)'}: name/type(∈${TYPES.join('|')})/default 三件必写，default 不许省略`);
        if (f.type === 'choice' && (!Array.isArray(f.choices) || !f.choices.length)) bad.push(`${k}.--${f.name}: choice 类型必须列出可选值`);
      }
      let sawOptional = false;
      for (const ps of sp.positional) {
        if (!ps.name || typeof ps.required !== 'boolean' || !ps.note) bad.push(`${k} 的位置参数 ${ps.name || '(无名)'}: required 与 note 必写`);
        if (ps.required && sawOptional) bad.push(`${k}: 可选位置参数后面又跟了必填的（parseArgs 按位置吃参，这种宣告没人能满足）`);
        if (!ps.required) sawOptional = true;
      }
      if (!sp.codes.length && k !== 'doctor') bad.push(`${k}: codes 为空（除 doctor 外每条命令都可能失败，必须宣告会撞的码）`);
      for (const c of sp.codes) {
        if (!KIT_ERROR_CODES.includes(c)) bad.push(`${k}: 宣告的失败码 ${c} 不在 kit 八码族里（写错码＝调用方照 next 走不到任何处置）`);
        else if (nextFor(c, { input: 'i', output: 'o', fam: 'word', inExt: 'docx' }).length < 6) bad.push(`${k}: 失败码 ${c} 在 nextFor 里没有处置文案`);
      }
    }
    // ③ 源码层面钉"default 必须是字面量"——写成 `default: 某常量` 时下面那条对账恒真＝假牙（总览第四节第 18 条的 Set.length 同款病）
    const hs = src.indexOf('const HELP_SPEC = {');
    const specText = hs < 0 ? '' : src.slice(hs, src.indexOf('\n};', hs));
    if (!specText.includes('const HELP_SPEC')) return 'HELP_SPEC 块定位失败——判据自己坏了，不许当通过';
    for (const dm of specText.matchAll(/default:\s*([^\n,]*)/g)) {
      const v = dm[1].trim();
      if (!/^(-?\d+|'[^']*'|true|false|null)$/.test(v)) bad.push(`spec 里有非字面量的 default：${JSON.stringify(v)}（引用常量会让默认值对账恒真）`);
    }
    for (const [k, sp] of Object.entries(HELP_SPEC)) for (const f of sp.flags) {
      if (f.default === null) {
        if (f.defaultFrom) bad.push(`${k}.--${f.name}: default 为 null 却钉了 defaultFrom`);
        if (!f.defaultNote) bad.push(`${k}.--${f.name}: default 为 null 却不写 defaultNote（"不传时谁定"必须交代，省略字段不算交代）`);
        continue;
      }
      if (f.type === 'boolean') { if (f.default !== false) bad.push(`${k}.--${f.name}: 开关的默认必须是 false（装置的开关全是"不传即关"）`); continue; }
      if (!f.defaultFrom) { bad.push(`${k}.--${f.name}: 报了默认值却没钉来源 defaultFrom`); continue; }
      if (!Object.prototype.hasOwnProperty.call(CONFIG_CONSTANTS, f.defaultFrom)) bad.push(`${k}.--${f.name}: defaultFrom 指向配置区没有的常量 ${f.defaultFrom}`);
      else if (CONFIG_CONSTANTS[f.defaultFrom] !== f.default) bad.push(`${k}.--${f.name}: help 报 ${JSON.stringify(f.default)}，配置区 ${f.defaultFrom} 实为 ${JSON.stringify(CONFIG_CONSTANTS[f.defaultFrom])}（改了默认值没同步 help）`);
    }
    // ⑤ 宣告的开关必须被该命令真读到；该命令读到的开关必须在宣告里
    for (const [k, sp] of Object.entries(HELP_SPEC)) {
      const body = bodyOf(k);
      if (body === null) { bad.push(`${k}: 找不到命令函数体（覆盖面无从可核）`); continue; }
      const used = new Set();
      // 只认**独立变量** flags 的取用（前面不许有 `.`）：selftest 自己的函数体里就有 `sp.flags.map(...)`，
      // 不加这道边界会把 `map` 当成"命令读了的开关"，制造一条永远红的假判据。
      for (const x of body.matchAll(/(?:^|[^.\w])flags\[\s*'([^']+)'\s*\]/g)) used.add(x[1]);
      for (const x of body.matchAll(/(?:^|[^.\w])flags\.([A-Za-z_]\w*)/g)) used.add(x[1]);
      // 透传型开关是从"循环一个字符串清单、再用循环变量去 flags 里取值"那种写法吃的。只认循环变量真被这样读过的清单
      // ——否则形如 `for (const part of [一份部件名清单])` 的循环会被当成开关清单，判据假红（本条注释自己就踩过一次）。
      for (const x of body.matchAll(/for \(const (\w+) of \[([^\]]*)\]/g)) {
        if (!new RegExp('flags\\[' + x[1] + '\\]').test(body)) continue;
        for (const q of x[2].matchAll(/'([^']+)'/g)) used.add(q[1]);
      }
      const advertised = sp.flags.map((f) => f.name);
      const ghost = advertised.filter((n) => !used.has(n));
      const unmapped = [...used].filter((n) => !advertised.includes(n) && !body.includes(`'--${n}'`));
      if (ghost.length) bad.push(`${k}: spec 宣告了代码里没读的开关 ${ghost.join(',')}`);
      if (unmapped.length) bad.push(`${k}: 代码读了 spec 没宣告的开关 ${unmapped.join(',')}（help --json 照实装列不全）`);
    }
    return bad.length ? bad.slice(0, 8).join(' | ') : true;
  });

  t('help 单命令详询走 CLI：结构化 spec 出口、布尔开关末位可用、非命令名不许静默退 0', () => {
    // 走调用方真跑的那条路（CLI），不是直接读 HELP_SPEC：spec 写得漂亮而 help 命令没接线，同样是零。
    const CLI = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const bad = [];
    const h = CLI(['help']);
    if (!h.j || h.j.ok !== true || !Array.isArray(h.j.commands) || h.j.commands.length !== Object.keys(COMMANDS).length) bad.push(`help 清单条数与 COMMANDS(${Object.keys(COMMANDS).length}) 不符：${h.j ? h.j.commands.length : '非 JSON'}`);
    const one = CLI(['help', 'ocr']);
    if (!one.j || one.j.ok !== true || one.j.op !== 'help' || one.j.mode !== 'command' || one.j.command !== 'ocr') bad.push('help ocr 的出口形状不对：' + JSON.stringify(one.j && { op: one.j.op, mode: one.j.mode, command: one.j.command }));
    else {
      const f = one.j.flags || [];
      for (const need of ['name', 'type', 'default']) if (!f.every((x) => need in x)) bad.push(`help ocr 的 flags 里有元素缺 ${need} 字段`);
      const tm = f.find((x) => x.name === 'timeout-ms');
      if (!tm || tm.default !== CONFIG_CONSTANTS.DEFAULT_TIMEOUT_MS) bad.push('help ocr 报的 timeout-ms 默认值不等于配置区当前值：' + JSON.stringify(tm));
      if (!one.j.usage || !(one.j.codes || []).length) bad.push('help ocr 缺 usage 或 codes');
    }
    const allj = CLI(['help', '--json']);
    if (!allj.j || allj.j.mode !== 'all-structured' || (allj.j.commands || []).length !== Object.keys(HELP_SPEC).length) bad.push(`help --json 没出全量结构化 spec（应 ${Object.keys(HELP_SPEC).length} 条）：实为 ${JSON.stringify(allj.j && { mode: allj.j.mode, n: (allj.j.commands || []).length })}`);
    else if (!allj.j.commands.every((c) => Array.isArray(c.flags) && Array.isArray(c.codes) && typeof c.usage === 'string')) bad.push('help --json 里有命令没带 flags/codes/usage');
    const bc = CLI(['help', 'nosuchcommand']);
    if (bc.p.status !== 1 || !bc.j || bc.j.ok !== false || bc.j.code !== 'invalid-output') bad.push(`help 未知命令未按失败契约退（应退码 1 + invalid-output）：status=${bc.p.status} stdout=${String(bc.p.stdout).replace(/\s+/g, ' ').slice(0, 70) || '(空)'}`);
    // ② 布尔开关放到**末位**必须可用。R1-a 的起因就是这条：2026-10-06 实测 `inspect 文件 --deep` 回
    //    invalid-output / "--deep 缺值"，而 README 与调用卡都把它写成开关用法——文档教的做法必然失败。
    const boolLast = CLI(['inspect', `${S}/no-such-file-for-bool-switch.docx`, '--deep']);
    if (boolLast.j && /缺值/.test(String(boolLast.j.error))) bad.push('布尔开关放到末位仍被判"缺值"（--deep 的老毛病没修掉）：' + boolLast.j.error);
    if (!boolLast.j || boolLast.j.code !== 'invalid-document') bad.push('inspect --deep 应先过开关解析、再按"输入不存在"回 invalid-document，实为 ' + JSON.stringify(boolLast.j && boolLast.j.code));
    // ③ `--key=值` 与 `--key 值` 等价（变异台与别的 agent 都按前者传 --only=）
    const eq = CLI(['sheets', twoPath, '--method=zip']);
    if (!eq.j || eq.j.ok !== true || !/^zip/.test(String(eq.j.method))) bad.push('--method=zip 没走通：' + JSON.stringify(eq.j && { ok: eq.j.ok, code: eq.j.code, method: eq.j.method }));
    // ④ 命令名撞上 Object.prototype 的成员必须失败退出。实测（2026-10-06，修前）：`node dockit.js toString`
    //    与 `hasOwnProperty` 都**不出 JSON 且退码 0**——COMMANDS['toString'] 从原型链继承而来是 truthy。
    for (const proto of ['toString', 'hasOwnProperty']) {
      const p = CLI([proto]);
      if (p.j && p.j.ok === true) bad.push(`${proto} 被当成命令执行了（原型链漏判）`);
      if (p.p.status !== 1 || !p.j || p.j.ok !== false) bad.push(`${proto}: 应退码 1 + 结构化失败（装置任何路径只出一份 JSON），实测 status=${p.p.status} stdout=${String(p.p.stdout).slice(0, 60) || '(空)'}`);
    }
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  // ---- R1-b（任务书 P1-5）：错拼要给最近邻。函数层与 CLI 层分开钉，各配独立变异（M43/M56 打函数，M57/M58/M59 打接线）
  t('最近邻候选：已知错拼必须回出正确名、正确名与差太远的名字必须回空', () => {
    const CMD = Object.keys(COMMANDS);
    const bad = [];
    const cases = [
      ['hepl', CMD, 'help'], ['recal', CMD, 'recalc'], ['scrb', CMD, 'scrub'], ['nspect', CMD, 'inspect'], ['selftset', CMD, 'selftest'],
      ['tiemout-ms', ['timeout-ms', 'sheet', 'pixels'], 'timeout-ms'],
      ['verfiy', ['verify', 'deep'], 'verify'],
      ['max-ipnut-bytes', ['max-input-bytes', 'max-output-bytes'], 'max-input-bytes'],
      ['lng', ['lang', 'pages', 'psm'], 'lang'],
    ];
    for (const [input, pool, want] of cases) {
      const got = nearestCandidates(input, pool);
      if (!got.length) bad.push(`错拼 ${input} 没回任何候选（pool=${pool.join(',')}）`);
      else if (got[0] !== want) bad.push(`错拼 ${input} 的首候选应为 ${want}，实为 ${got.join(',')}`);
      if (got.some((x) => !pool.includes(x))) bad.push(`错拼 ${input} 的候选跳出 pool：${got.join(',')}`);
      if (got.length > CANDIDATE_LIMIT) bad.push(`错拼 ${input} 的候选超出 ${CANDIDATE_LIMIT} 条`);
      if (new Set(got).size !== got.length) bad.push(`错拼 ${input} 的候选有重复项：${got.join(',')}`);
      if (got.includes(input)) bad.push(`候选里出现了输入自己：${input}`);
    }
    // 🔴 正确名不许回候选：回了就等于把"你用对了"也报成一次错误，调用方学会忽略这个字段
    for (const exact of [...CMD, 'timeout-ms', 'verify', 'max-input-bytes']) {
      const got = nearestCandidates(exact, [...CMD, 'timeout-ms', 'verify', 'max-input-bytes']);
      if (got.length) bad.push(`正确名 ${exact} 竟回了候选 ${got.join(',')}`);
    }
    for (const far of ['banana', 'zzzzzzzzzz', 'qq']) {
      const got = nearestCandidates(far, CMD);
      if (got.length) bad.push(`差太远的 ${far} 不该硬凑候选：${got.join(',')}`);
    }
    if (editDistance('ab', 'ba') !== 1) bad.push(`相邻换位必须算一步：ab↔ba 实测 ${editDistance('ab', 'ba')}`);
    if (editDistance('abc', 'abc') !== 0) bad.push('同串距离应为 0');
    if (editDistance('kitten', 'sitting') !== 3) bad.push(`kitten↔sitting 应为 3，实测 ${editDistance('kitten', 'sitting')}`);
    if (nearestCandidates('', CMD).length) bad.push('空名字不该有候选');
    // 通用开关与逐命令开关的分工：全局名单里的名字若被某条命令自己宣告，必须是布尔型（否则带它就要跟一个假值）
    for (const [k, sp] of Object.entries(HELP_SPEC)) for (const f of sp.flags) {
      if (GLOBAL_FLAGS.includes(f.name) && f.type !== 'boolean') bad.push(`${k}.--${f.name}: 通用开关必须是布尔型，实为 ${f.type}`);
    }
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('未知开关与未知命令走 CLI 必须失败并带 candidates 字段，正确调用不许带该字段', () => {
    // 实测的静默形状（2026-10-06，改前）：`to _probe/cn.docx --tiemout-ms 5` 回 **ok:true** 并按默认 120000ms 跑完。
    // 这条判据钉的就是"错拼绝不能被执行成一次成功"，所以必须走 CLI，函数级测试看不见入口接线。
    const CLI = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const bad = [];
    const typo = CLI(['to', cnPath, '--tiemout-ms', '5']);
    if (typo.j && typo.j.ok === true) bad.push(`错拼开关被执行成成功（静默吃掉的老毛病）：ms=${typo.j.ms}`);
    if (typo.p.status !== 1) bad.push(`错拼开关应退码 1，实测 ${typo.p.status}`);
    if (!typo.j || typo.j.code !== 'invalid-output') bad.push('错拼开关的码应为 invalid-output，实为 ' + JSON.stringify(typo.j && typo.j.code));
    if (!Array.isArray(typo.j && typo.j.candidates) || typo.j.candidates[0] !== 'timeout-ms') bad.push('错拼开关的 candidates 首项应为 timeout-ms，实为 ' + JSON.stringify(typo.j && typo.j.candidates));
    if (!/未知开关 --tiemout-ms/.test(String(typo.j && typo.j.error))) bad.push('error 没点名是哪个开关：' + String(typo.j && typo.j.error).slice(0, 60));
    if (!/--timeout-ms/.test(String(typo.j && typo.j.next))) bad.push('next 没把候选写成可直接照抄的 --开关 形式：' + String(typo.j && typo.j.next).slice(0, 80));
    const cmdTypo = CLI(['hepl']);
    if (!cmdTypo.j || cmdTypo.j.ok !== false || (cmdTypo.j.candidates || [])[0] !== 'help') bad.push('命令名错拼 hepl 应回候选 help，实为 ' + JSON.stringify(cmdTypo.j && cmdTypo.j.candidates));
    const helpTypo = CLI(['help', 'recal']);
    if (!helpTypo.j || !(helpTypo.j.candidates || []).includes('recalc')) bad.push('help 的未知命令名应回候选 recalc，实为 ' + JSON.stringify(helpTypo.j && helpTypo.j.candidates));
    const noSwitch = CLI(['doctor', '--banana']);
    if (!noSwitch.j || noSwitch.j.ok !== false || !Array.isArray(noSwitch.j.candidates)) bad.push('doctor 的未知开关应失败且带 candidates 数组：' + JSON.stringify(noSwitch.j && { ok: noSwitch.j.ok, code: noSwitch.j.code, candidates: noSwitch.j.candidates }));
    if (!/没有开关|--/.test(String(noSwitch.j && noSwitch.j.next))) bad.push('无开关可荐时 next 仍要指路：' + String(noSwitch.j && noSwitch.j.next).slice(0, 80));
    const farFlag = CLI(['pages', cnPath, '--banana', '1']);
    if (!farFlag.j || farFlag.j.ok !== false) bad.push('pages 的远名开关应被拒（不许静默放过）');
    if (farFlag.j && (farFlag.j.candidates || []).some((x) => !['dir', 'pages', 'dpi', 'sheet', 'range', 'max-image-resolution', 'pixels', 'timeout-ms'].includes(x))) bad.push('远名开关荐出了 pool 之外的名字：' + JSON.stringify(farFlag.j.candidates));
    // 正确调用：执行成功且**不带** candidates 字段
    const ok = CLI(['sheets', twoPath, '--method', 'zip']);
    if (!ok.j || ok.j.ok !== true) bad.push('正确开关组合被执行失败：' + JSON.stringify(ok.j && { code: ok.j.code, error: String(ok.j.error).slice(0, 60) }));
    if (ok.j && 'candidates' in ok.j) bad.push('正确调用竟带了 candidates 字段：' + JSON.stringify(ok.j.candidates));
    // 通用 --json 必须每命令可带（装置的输出本来就恒是 JSON），且不许因此改变行为
    const gj = CLI(['selftest', '--only=NOJUDGMENTMATCHESXYZ', '--json']);
    if (!gj.j || gj.j.ok !== true) bad.push('selftest 带 --json 被拒（通用开关没接上）：' + JSON.stringify(gj.j && { code: gj.j.code, error: String(gj.j.error).slice(0, 80) }));
    if (gj.j && gj.j.total !== 0) bad.push(`--only 的选跑令牌没生效（total=${gj.j.total}，本例不许真跑判据以免递归）`);
    const gh = CLI(['help', 'ocr', '--json']);
    if (!gh.j || gh.j.ok !== true || gh.j.mode !== 'command') bad.push('help <命令> --json 应出该命令 spec，实为 ' + JSON.stringify(gh.j && { ok: gh.j.ok, mode: gh.j.mode }));
    if (gh.j && !Array.isArray(gh.j.globalFlags)) bad.push('help 出口没宣告通用开关 globalFlags（静默放过通用开关是要能查到的）');
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });
  t('doc 卫生：文档里的在册绝对路径必须存在、不得含控制字符、SKILL 写的判据数要等于实际条数', () => {
    // 这条判据锁住公开文档的控制字符与路径入口示例，避免转义损坏或入口断链。
    // 这类缺陷只在"文档也是产物"这一层才看得见，所以把它变成判据，而不是写进注意事项。
    const src = str(fs.readFileSync(__filename));
    const actual = [...src.matchAll(/^[ \t]*(?:await[ \t]+)?(?:ta|t)\(\s*'([^']+)'/gm)].length;   // 判据条数按定义点数自算，不靠人记
    const skillPath = path.join(ROOT, 'skills', 'agent-doc-ops', 'SKILL.md');
    // 公开树版（2026-10-15 机主裁决开源化）：内账文档（总览/日志/调用卡/分工表）不入公开面，
    // 存在性改为"有就核、没有不算缺陷"——对账逻辑保持一致，清单随公开面收敛。
    const files = [['README', ROOT + '/README.md'], ['总览', ROOT + '/项目总览.md'], ['日志', ROOT + '/迭代日志.md'], ['调用卡', ROOT + '/给其它agent-调用卡.md'], ['分工表', ROOT + '/技能与装置分工表.md'], ['SKILL', skillPath], ['ADR-001', ROOT + '/docs/adr/ADR-001-tesseract-ocr-外部依赖.md']]
      .filter(([, p]) => fs.existsSync(p));
    // 存在性只对"文档当成现役资源"的路径族设禁令（备份目录、装置根目录、系统字体库）；
    // 历史记录里"某个路径已被我删掉"是正当写法，不许被这条判红——迭代日志/总览第 9 条就是这么写的。
    // 再加"上层目录必须存在"这一层，换机器（没有 D: 盘）时整族自动跳过，不制造不可携带的红。
    // 上一版按完整名字白名单判，结果 M18（目录名末位写错一号）压根没进断言 ⇒ 改成按**族**匹配，名字写错照样在族内。
    const live = /^C:[\\/](?:WINDOWS|Windows)[\\/]Fonts/i;
    const bad = []; let pathChecked = 0;
    // 台子例数也从源码自算（v1.2.0）：与 test/mutant.js 的 JC 同一把尺，README 里那个数不许靠人记
    const muts = [...str(fs.readFileSync(ROOT + '/test/mutant.js')).matchAll(/\{ id: '(M\d+)'/g)].length;
    for (const [label, p] of files) {
      if (!fs.existsSync(p)) { if (label === 'SKILL') continue; bad.push(`${label} 文件不在`); continue; }
      const t0 = str(fs.readFileSync(p));
      if (label === 'README' && !t0.includes('node <REPO>\\dockit.js <命令> [参数...]')) bad.push('README 缺少仓库路径占位调用示例');
      const ctrl = [...new Set([...t0].filter((ch) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(ch)).map((ch) => 'U+' + ch.codePointAt(0).toString(16)))];
      if (ctrl.length) bad.push(`${label} 含控制字符/替换符 ${ctrl.join(',')}（反斜杠转义被脚本吞掉的形状）`);
      for (const m of t0.matchAll(/`([A-Za-z]:[\\/][^`|]*)`/g)) {
        const target = m[1].replace(/[\\/]+$/, '');
        if (!live.test(target)) continue;
        const parent = path.dirname(target.replace(/[\\/]+/g, path.sep));
        if (!fs.existsSync(parent)) continue;                       // 这台机器根本没有这个盘/上层目录 ⇒ 不算文档缺陷
        pathChecked++;
        if (!fs.existsSync(target)) bad.push(`${label} 里的现役路径不存在（上层在、叶子不在）：${JSON.stringify(m[1])}`);
      }
      // 条数条款只认**机器形状** `判据条数=<N>`（v1.1.4 改，见总览第八节第 13 条）。原因：按"内置判据 N 条"这个
      // 散文短语扫，必然把"引用旧数字"当成"断言当前数字"——v1.1.3 立判据当轮被自己的日志条目判红
      // （selftest 61/1/62），我 v1.1.4 改成"豁免《迭代日志》"又在总览第 13 条的红字说明里踩第二次。
      // 断言与引用因此在形状上分开：要机器核的写 `判据条数=62`，要讲历史的照散文写。《迭代日志》整份豁免。
      if (label !== '日志') {
        const nums = [...t0.matchAll(/判据条数=(\d+)/g)].map((x) => Number(x[1]));
        if ((label === 'README' || label === 'SKILL') && !nums.length) bad.push(`${label} 缺"判据条数=<N>"断言（缺了这条判据对它形同虚设，不许用散文糊过去）`);
        for (const v of nums) if (v !== actual) bad.push(`${label} 写"判据条数=${v}"，实际定义 ${actual} 条`);
      }
      // 台子例数同理（v1.2.0 补）：README 必须写机器形状 `变异例数=<N>`，值等于 test/mutant.js 里的条数。
      if (label === 'README') {
        const mc = [...t0.matchAll(/变异例数=(\d+)/g)].map((x) => Number(x[1]));
        if (!mc.length) bad.push('README 缺"变异例数=<N>"断言（这个数靠人记一定烂：实测 README 写 M1–M17 时台子已有 19 例）');
        for (const v of mc) if (v !== muts) bad.push(`README 写"变异例数=${v}"，test/mutant.js 实际 ${muts} 例`);
      }
    }
    return bad.length === 0 ? true : `核过现役路径 ${pathChecked} 条 / 实际判据 ${actual} 条 / 台子 ${muts} 例 ⇒ ` + bad.slice(0, 5).join(' | ');
  });

  // ---- R1-c（任务书 Q-04=②）：ADR-001 触发项 ③ 的 Python 事实订正句。`doc 卫生` 的扫描面这一轮扩到了 docs/adr/
  //      （控制字符与现役路径那层在那边红，M63 就是往 ADR 注一个 0x07），这条只管三件事：页眉修订位（M64）、
  //      订正句的定性短语齐（M60）、记的数字必须还能现算（M61 版本／M62 字节——**不硬编码机器读数**，所以改记数只在活查这层红）。
  t('doc ADR-001 订正句：页眉修订位在位、触发项③ 的定性短语齐、记的 Python 版本与字节必须还能现算', () => {
    const ADR = ROOT + '/docs/adr/ADR-001-tesseract-ocr-外部依赖.md';
    if (!fs.existsSync(ADR)) return 'skip（本机没有 ADR-001 这份文件——文档条款与活查都不判，不冒充通过）';
    const txt = str(fs.readFileSync(ADR));
    const bad = [];
    if (!/^- 修订：v\d+\.\d+\.\d+（\d{4}-\d{2}-\d{2}）/m.test(txt)) bad.push('页眉缺 `- 修订：v<版本>（<日期>）` 这一行（订正不落页眉就没人知道这份 ADR 被改过）');
    for (const need of ['2026-10-06 订正', '%LOCALAPPDATA%\\Python\\bin\\python.exe', '退码 **49**', '不算本轮引入', '维持不重跑 C3 对照', '当"已重跑"的证据']) if (!txt.includes(need)) bad.push(`触发项 ③ 的订正句缺 ${JSON.stringify(need)}`);
    if (!/\*\*D\. Python 系 OCR/.test(txt)) bad.push('§二 的 D 候选行被抹掉了（订正事实不许把被否项写成不存在）');
    const recVer = (txt.match(/Python (3\.\d+\.\d+)/) || [])[1];
    const recBytes = Number(((txt.match(/文件 ([\d,]+) B/) || [])[1] || '').replace(/,/g, ''));
    if (!recVer) bad.push('订正句没留下可解析的 `Python 3.x.y`，活查无从对账');
    if (!(recBytes > 0)) bad.push('订正句没留下可解析的 `文件 <数字> B`，活查无从对账');
    if (bad.length) return bad.slice(0, 6).join(' | ');
    const py = path.join(process.env.LOCALAPPDATA || '', 'Python', 'bin', 'python.exe');
    if (!fs.existsSync(py)) return 'skip（这台机器的 LOCALAPPDATA 下没有那份 python.exe；ADR 记的是决策机器的时点事实，文档条款已全核过——外人跑必走这支）';
    const st = fs.statSync(py);
    const v = spawnSync(py, ['--version'], { encoding: 'utf8' });
    const act = (`${v.stdout || ''}${v.stderr || ''}`).match(/Python (\d+\.\d+\.\d+)/);
    if (!act) return `本机 python.exe 在位但 --version 读不出版本（退码 ${v.status}）——ADR 记的 ${recVer} 无从对账`;
    if (act[1] !== recVer) return `ADR 记 Python ${recVer}，现算 ${act[1]}：机器变了要回改 ADR，而不是让这条一直红着`;
    if (st.size !== recBytes) return `ADR 记 文件 ${recBytes} B，python.exe 实为 ${st.size} B`;
    const d0 = st.mtime.toISOString().slice(0, 10);
    if (!txt.includes(d0)) return `ADR 没写 python.exe 的当前文件日期 ${d0}`;
    return true;
  });

  // R0-b（v1.6.0）：ADR-002 是"自批即生效施工"的决策件（任务书 H §0 把"机主过目"降级成"监工事后复核"），
  // 所以它必须**能被机器重认**，否则无人值守场景里就只剩一句"我相信我写的 ADR"。三条各配独立变异（M91/M92/M93）：
  // ① 四段齐备且**行首锚定**（"全文出现过一遍"是假对账，v1.1.4 的教训）；② 排除项 A/B 必须**在同一行里点名被排除的东西**；
  // ③ 钉在文档里的那枚 sha256 必须等于盘上 exe 的实算值——**指路型文案要有存在性判据**，钉版本号的文档与二进制对不上就是空话。
  t('doc ADR-002 在册：四段行首齐、排除项同行点名、钉住的 exe sha256 与盘上实算一致', () => {
    const dir = ROOT + '/docs/adr';
    if (!fs.existsSync(dir)) return 'skip（没有 docs/adr 目录）';
    const file = fs.readdirSync(dir).filter((f) => /^ADR-002-.*\.md$/.test(f)).sort();
    if (!file.length) return 'ADR-002 不在位——R0-b 的交付物就是这份决策件，缺了等于没做';
    const ADR = path.join(dir, file[0]);
    const txt = str(fs.readFileSync(ADR));
    const bad = [];
    for (const sec of ['一、背景', '二、候选', '三、决策', '四、后果']) {
      const re = new RegExp('^## ' + sec, 'm');
      if (!re.test(txt)) bad.push(`缺行首标题 "## ${sec}"（四段式缺一就不是 ADR；R6 的准入条件写在第三段）`);
    }
    if (!/^- 版本：v\d+\.\d+\.\d+ R0-b（\d{4}-\d{2}-\d{2}）/m.test(txt)) bad.push('页眉缺 `- 版本：v<版本> R0-b（<日期>）` 位');
    // 排除项要"同一行点名被排除的东西"，不许只在文末含糊提一句
    const exclA = (txt.match(/^.*排除项 A.*$/m) || [])[0];
    if (!exclA) bad.push('缺"排除项 A"那一行');
    else if (!exclA.includes('refresh')) bad.push(`排除项 A 那行没点名 refresh（现文本：${exclA.slice(0, 40)}…）`);
    const exclB = (txt.match(/^.*排除项 B.*$/m) || [])[0];
    if (!exclB) bad.push('缺"排除项 B"那一行');
    else if (!/stdout|透传/.test(exclB)) bad.push(`排除项 B 那行没点名"stdout 不透传"（现文本：${exclB.slice(0, 40)}…）`);
    for (const need of ['OFFICECLI_SKIP_UPDATE=1', 'OFFICECLI_NO_AUTO_RESIDENT=1', 'TMP', '`edit`', '`merge`']) if (!txt.includes(need)) bad.push(`决策段缺 ${JSON.stringify(need)}（隔离三件套与两个透出命令是 R6 的准入条件，掉了就等于没钉）`);
    // sha256 现认：盘上实算必须等于**文档里已登记的某一枚**（ADR-002 §二⑥：本轮实测后端会自更新，
    // 钉版会被自然事件打穿；红的是"冒出没登记的第三枚"，不是"上游发了新版"）。未登记的替换照样红（M92）。
    // 公开树版（2026-10-15 机主裁决开源化）：登记枚集改为前 16 位短哈希——完整 64 位哈希本身不构成泄露风险，
    // 但公开树把登记表收敛为短哈希以减少可拼接指纹；闸门同步改口径，M92 的牙不变（改错一号照样红）。
    const declaredFull = [...txt.matchAll(/`([0-9a-f]{64})`/g)].map((m) => m[1]);
    const declaredShort = [...txt.matchAll(/`([0-9a-f]{16})…`/g)].map((m) => m[1]);
    const declared = [...declaredFull, ...declaredShort];
    if (!declared.length) bad.push('文档里没有可解析的 sha256 登记位（不能拿"见 evidence"糊过去——那正是会漂的引用）');
    for (const pin of ['05dd712595690672ea1c220a516c0996a27f7c3e7f870a270c19d538e9fc04f3', '50a57626ff7c5b11', '66757c7a3ac4e8b1', '70b4e26695cf3197', 'bd64eba587e56cc7']) {
      const found = pin.length === 64 ? declaredFull.includes(pin) || declaredShort.includes(pin.slice(0, 16)) : declaredShort.includes(pin) || declaredFull.some((h) => h.startsWith(pin));
      if (!found) bad.push(`后端二进制登记枚丢失：${pin.slice(0, 16)}…（登记丢了就等于认领丢了）`);
    }
    // 🔴 解析器必须真吃环境变量：把 DOCKIT_OFFICECLI 指到一个不存在的路径上，看它是否按指的路走。
    // 不这么测的话，"env 可覆盖"这句话永远没人覆盖过、也就永远没人知道它坏没坏（ADR-002 §三-4 的隔离三件套之一）。
    {
      const saved = process.env[OFFICECLI_ENV];
      try {
        const fake = 'Z:\\__no_such_dir_for_judgment__\\officecli.exe';
        process.env[OFFICECLI_ENV] = fake;
        const probe = resolveOfficecliExe();
        if (probe.source !== 'env ' + OFFICECLI_ENV || probe.exe !== fake) bad.push(`环境变量覆盖没生效：解析器在 env 指 ${fake} 时回了 ${JSON.stringify(probe)}（"可覆盖"是 ADR 钉的边界，不是装饰）`);
      } finally {
        if (saved === undefined) delete process.env[OFFICECLI_ENV]; else process.env[OFFICECLI_ENV] = saved;
      }
    }
    // 🔴 隔离 env 必须覆盖**每一次**调用后端的 spawnSync（本轮实犯：只问 `--version` 的懒探针漏了 env，后端就地自更新）
    const selfSrc = str(fs.readFileSync(__filename));
    const spawns = [...selfSrc.matchAll(/spawnSync\(resolved\.exe[^\n]*/g)].map((m) => m[0]);
    // 认 `env:` 也认简写 `env,`（`officecliCall` 用的是先算好 env 变量再简写传参的形状）
    const envless = spawns.filter((s) => !/\benv:|\benv[,)]/.test(s));
    if (envless.length) bad.push(`有 ${envless.length} 处调后端没带隔离 env：${envless[0].slice(0, 90)}…（OFFICECLI_SKIP_UPDATE 与 TMP 都随 env 走，漏一处＝那条路径没关自更新）`);
    if (bad.length) return bad.slice(0, 7).join(' | ');
    const resolved = resolveOfficecliExe();
    if (!fs.existsSync(resolved.exe)) return `skip（这台机器没有后端 exe（解析到 ${resolved.source} 的 ${resolved.exe}），sha 对账无从谈起；文档条款与 env 覆盖已全核过，登记了 ${declared.length} 枚——外人克隆必走这支）`;
    const actual = crypto.createHash('sha256').update(fs.readFileSync(resolved.exe)).digest('hex');
    if (!declared.includes(actual)) return `盘上后端不在 ADR-002 的登记清单里：实算 ${actual.slice(0, 16)}… ／ 已登记 ${declared.map((d) => d.slice(0, 16) + '…').join(' / ')}（要么这是未认领的替换件——停手回报，别用；要么就是一次没留痕的版本变化，按 §二⑥ 补登记并重跑 R6 的 11 例）`;
    return true;
  });


  // R6 的四条判据共用一套形状：**跑调用方真跑的那条路**（CLI 子进程，不是函数内调），
  // 每条都有"已知错样本"（不传不存在的文件、写不落的值、覆盖已有产物），后端不在位时逐条 SKIP 点名（外人克隆全绿）。
  const ocliAvailable = () => fs.existsSync(resolveOfficecliExe().exe);
  const CLI2 = (a, env) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000, env: Object.assign({}, process.env, env || {}) }); let j = null; try { j = JSON.parse(p.stdout); } catch {} if (j) { for (const q of [j.workCopy, j.output, j.delivered && j.delivered.path]) if (q) r6Made.push(String(q).split(String.fromCharCode(92)).join('/')); } return { p, j }; };
  // 🔴 v2.3.0：OfficeCLI 后端的**偶发静默丢弃**（2026-10-10 压测实录：30 次 add 里 1 次"报 success 但值没进副本"，
  // selftest 身形下 20 次里 2 次——综合约 3–5%）。装置的回读闸门**每次都正确拒绝**（code=failed＋"写后回读…找不到值"），
  // 所以这是**后端缺陷被装置守住**，不是装置缺陷。判据的使命是验装置的守法形状、不替下游后端的稳定性背书：
  // **期望成功**的调用点遇这一形状**重试一次**（第二次通常即好；连拒两次照红不误——真缺陷 0.1% 也藏不住）。
  // 只认这一个形状；其它失败（任何非 failed 码、或 failed 但非该文案）一律不重试。变异台各例不依赖本口径
  //（M47/M48 用确定性夹具触发，与偶发无关）。
  const isDropFlake = (jj) => !!(jj && jj.ok === false && jj.code === 'failed' && /写后回读/.test(String(jj.error || '')));
  const tryOnce = (args) => { let x = CLI2(args); if (isDropFlake(x.j)) x = CLI2(args); return x; };
  const r6Made = [];
  const r6T0 = Date.now();
  const r6OutListing = () => { try { return new Set(fs.readdirSync(OUT_DIR)); } catch { return new Set(); } };
  const r6Base = r6OutListing();
  // 🔴 判据自己造的件必须自己清掉，且**只清自己造的那批**：`edit`/`merge` 的产物按设计落 _out/，
  //  一次 selftest 造十几个（现测 _out 从 922 起每跑一遍净增 8–10）——不清就是每跑一次判据往交付目录倒一次垃圾。
  // 两道闸：① 只碰本判据开跑之后**新出现**的名字（与开跑前的清单做差集，既有文件永不进差集）；
  // ② 只碰本判据自己夹具用的前缀（fixture- / g-），这样即便别人同时在 _out 放东西也不会被误删。
  const r6Prefixes = ['fixture-', 'g-'];
  const r6Sweep = () => {
    let n = 0;
    for (const p of r6Made) { try { fs.rmSync(p, { force: true }); n++; } catch {} }
    r6Made.length = 0;
    for (const f of r6OutListing()) {
      if (r6Base.has(f) || !r6Prefixes.some((p) => f.startsWith(p))) continue;
      try { if (fs.statSync(path.join(OUT_DIR, f)).mtimeMs >= r6T0 - 1500) { fs.rmSync(path.join(OUT_DIR, f), { force: true }); n++; } } catch {}
    }
    return n;
  };

  const r6Fixtures = (S) => {
    const doc = path.join(S, 'fixture.docx');
    // AUD-2（v1.6.6）：夹具**自造**——旧版 copy `_probe/blank.docx`（gitignore 资源），真克隆态 ENOENT 抛异常，
    // 5 条后端族判据被误归因为依赖缺失。docx() maker 生成的空白 OOXML 与 _probe 件等价（合法 OOXML，后端可读）。
    fs.writeFileSync(doc, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t> </w:t></w:r></w:p></w:body></w:document>`));
    return { doc };
  };

  // R6（v1.6.0）：后端二进制身份必须**每次调用都自曝前后两枚章**。
  // 起因是本 ADR 判据抓到的那次自更新（§二⑥）——"我们钉了版本"这句话，在后端会换自己二进制的现实面前必须是可观测的，不是承诺。
  // ---- WP-B（v1.6.7，台账 DK-ARCHIVE-GATE）：**实算后端留档件字节**。缺陷事实：10-07 11:21 后端第二次自更新
  //      把 .old 里 153 的逐字节留档覆盖掉，全仓没有一条判据发现——因为 dockit.js:2203 只核"ADR 文档里
  //      有没有那枚 sha **字符串**"。本判据：真读 'bin/archive/officecli-win-x64-<版本>.exe' 字节做 sha256，
  //      与 ADR-002 的版本↔认领值映射逐字比对；字符串只当**清单**（该核哪些版本），字节才是断言。
  //      目录只读：本判据不向 OfficeCLI本地化\ 写任何东西（含临时文件）。覆盖口 DOCKIT_OFFICECLI_ARCHIVE_DIR
  //      供变异台注入坏副本（M111）——它被不吃才是坏的：M111 的红就是"env 真被吃"的运行时证明（M94 教训）。
  t('后端留档件实算：bin/archive/officecli-win-x64-<版本>.exe 的 sha256 必须逐字等于登记枚集', () => {
    const ARCHIVE_DIR = process.env.DOCKIT_OFFICECLI_ARCHIVE_DIR || '';
    if (!fs.existsSync(ARCHIVE_DIR)) return 'skip（后端留档目录不在位（解析 ' + ARCHIVE_DIR + '）——外人克隆必走这支；在位机器缺目录属配置缺失，不冒充通过）';
    const adr = fs.readdirSync(ROOT + '/docs/adr').filter((f) => /^ADR-002-/.test(f));
    if (!adr.length) return 'ADR-002 文件不存在——判据失去登记清单来源';
    const adrText = str(fs.readFileSync(ROOT + '/docs/adr/' + adr[0]));
    // 枚集：行内反引号里的 64 位 hex（去重、小写）
    const enumShas = [...new Set([...adrText.matchAll(/[`']([0-9a-f]{64})[`']/g)].map((m) => m[1].toLowerCase()))];
    if (!enumShas.length) return 'ADR-002 里没解析到任何 64 位 hex 认领值（解析坏了，别当通过）';
    // 版本↔sha 映射：同一行里既有 1.0.<V> 又有 64 位 hex ⇒ (V, sha)
    const verMap = {};
    for (const line of adrText.split(/\r?\n/)) {
      const v = /1\\?\.0\\?\.(\d+)/.exec(line);
      const sha = /([0-9a-f]{64})/.exec(line);
      if (v && sha) verMap['1.0.' + v[1]] = sha[1].toLowerCase();
    }
    const files = fs.readdirSync(ARCHIVE_DIR).filter((f) => /^officecli-win-x64-(\d+\.\d+\.\d+)\.exe$/.test(f));
    if (!files.length) return 'skip（后端留档目录在位但没有任何归档件——外装机尚未归档；缺失自报，不算 PASS）';
    const bad = [];
    const verified = [];
    for (const f of files) {
      const ver = /^officecli-win-x64-(\d+\.\d+\.\d+)\.exe$/.exec(f)[1];
      const expected = verMap[ver];
      if (!expected) { bad.push('归档件 ' + f + ' 的版本 ' + ver + ' 在 ADR-002 里没有"版本↔认领值"映射（登记缺行）'); continue; }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(ARCHIVE_DIR, f))).digest('hex');
      if (actual !== expected) bad.push('归档件 ' + f + ' 字节与登记不符——登记 ' + expected.slice(0, 16) + '… ／ 实算 ' + actual.slice(0, 16) + '…（要么被换体要么登记错，停手回报别扩登记）');
      else verified.push(ver + '=' + actual.slice(0, 12) + '…');
    }
    // 枚集覆盖率：ADR 登记了认领值但 archive 没有对应件的版本，自报缺失（不许算 PASS，也不冒充红——缺失与换体是两回事）
    const missingVers = Object.keys(verMap).filter((v) => !files.includes('officecli-win-x64-' + v + '.exe'));
    if (bad.length) return bad.slice(0, 6).join(' | ');
    if (missingVers.length) return 'skip（后端留档件实算：在位 ' + verified.length + ' 枚已核逐字相等 [' + verified.join(' / ') + ']；版本 ' + missingVers.join('/') + ' 的归档件不在位——缺失自报，绝不冒充通过）';
    return true;
  });

  // ---- WP-A 存在性判据（v1.6.7）：zipWrite 与 dump 两判据已**夹具自产**（mkOdt），函数体内不得再出现
  //      `_probe/cn.odt` 读路径——旧 SKIP 出口若被人改回来（"本机没有就 SKIP"），这里当场红。
  //      运行时对照由 test/dep-set.js check 的真克隆夹具承担（无 _probe 的 clone 里这两条必须 PASS 非 SKIP）。
  t('WP-A 存在性：四条判据不得再引用 gitignore 的 _probe 夹具（自产的要夹具自产、真件的要已入仓——旧 SKIP 出口不许复辟）', () => {
    const src = str(fs.readFileSync(__filename));
    const bad = [];
    for (const [name, needle] of [['zipWrite 逐条目 method 与顺序', '_probe/cn.odt'], ['dump 默认只出形状', '_probe/cn.odt'], ['后端调用审计', '_probe/blank.docx'], ['scrub 的 ODF 面', '_probe/cn.odt']]) {
      const i = src.indexOf("t('" + name);
      if (i < 0) { bad.push(name + '：判据定义找不到（判据自己坏了）'); continue; }
      const j = src.indexOf(String.fromCharCode(10) + "  t('", i + 10);
      const body = src.slice(i, j < 0 ? undefined : j);
      const code = body.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      if (code.includes(needle)) bad.push(name + `：函数体里又出现了 ${needle}（旧"本机没有就 SKIP"出口复辟——夹具自产/入仓的成果被回退）`);
    }
    // v1.7.2 第二条靶：惰性 ODT 夹具的写入点必须**自建父目录**。缺陷事实：`once('mk-odt')` 首次访问可能落在
    // 套件收尾删掉 `_tmp/selftest-*` 之后（kit 缺失态尤其容易），旧版直接抛 ENOENT → 顶层兜成 die 信封 →
    // **整轮 selftest 的 JSON 被顶掉**，覆盖率闸只看到 failed=undefined。这条是静态形状，M125 单独打红它。
    {
      // 🔴 锚点必须**拼接构造**：本判据自己的注释里就写着 once('mk-odt')，直接写字面量会先命中自己
      //（本仓记名的坑："扫描器命中自己源码"，M29/语言白名单同源）。
      const key = 'const odtFixturePath = ' + "once(" + "'mk-odt'" + ", () => {";
      const i = src.indexOf(key);
      if (i < 0) bad.push('读不到惰性 ODT 夹具的定义行（写入点被挪走，本条无从可验——先修判据）');
      else {
        const blk = src.slice(i, i + 1600);
        const need = 'mkdi' + 'rSync(' + 'path.dirname(p)';
        if (!blk.includes(need)) bad.push('惰性 ODT 夹具的写入点没有自建父目录（异步尾巴落在 _tmp/selftest-* 被清之后就是 ENOENT→die 信封，整轮 JSON 会被顶掉）');
      }
    }
    // v1.7.2 第三条靶：selftest 的临时根必须**按进程命名**。缺陷事实：覆盖率闸 spawn 的缺失态子 selftest 与父进程
    // 常落在同一秒 ⇒ 旧命名只到秒，父子共用同一个 `_tmp/selftest-<秒>`，先收尾的一方把它删掉，另一方后半程判据
    // 成片 ENOENT（2026-10-09 实犯，子轮 failed=17）。M126 单独打红这一条。
    {
      const key = 'const S = ensureDir(' + "TMP_DIR + '/selftest-'";
      const i = src.indexOf(key);
      if (i < 0) bad.push('读不到 selftest 临时根 S 的定义行（命名被挪走，本条无从可验——先修判据）');
      else {
        const line = src.slice(i, src.indexOf(String.fromCharCode(10), i));
        if (!line.includes('process.' + 'pid')) bad.push('selftest 临时根 S 没带进程号（父子同秒共用同一目录，一方收尾即删掉另一方的夹具根 ⇒ 后半程成片 ENOENT）');
      }
    }
    return bad.length ? bad.join(' | ') : true;
  });

  t('后端二进制与隔离 env 自曝：调用前后各取一次身份章，换了就在 warnings 里点名；回报里不回传后端 stdout', () => {
    const body = cmdBody('Edit');
    if (!body) return 'skip（取不到 cmdEdit 函数体）';
    const bad = [];
    // F-4（v1.6.2）：静态半段必须报**实跑条数**。旧版 SKIP 文案硬编码"静态面已核——身份章五处形状…都在"，
    // 静态断言本身失效（被短路/数组被清空）时文案照说——自报与执行状态脱钩（Z2 变异实测）。
    // 现在：实跑条数 <5 直接红（任何 env），SKIP 文案引用计数器，不许再写死结论。
    let staticChecks = 0;
    for (const need of ['officecliEnv(', 'officecliBinaryStamp(', 'binaryBefore', 'binaryAfter', 'binaryDrift']) { staticChecks++; if (!body.includes(need) && !str(fs.readFileSync(__filename)).includes(need)) bad.push(`源码里找不到 ${need}`); }
    if (staticChecks < 5) bad.push(`静态断言实跑条数=${staticChecks}，少于预期 5——静态面失效时不得宣称"已核"`);
    // 后端 stdout 不透传：cmdEdit/cmdMerge 的回报不许出现 r.data / r.stdout 原文
    for (const fn of ['Edit', 'Merge']) {
      const b = cmdBody(fn); if (!b) continue;
      if (/\bres\.[a-zA-Z]*\s*=\s*r\.data\b/.test(b) || /rawStdout|backendStdout/.test(b)) bad.push(`cmd${fn} 把后端原始输出接进了回报（ADR-002 排除项 B）`);
    }
    // 现场半段前置守卫（v1.6.1 修 D-1）：缺后端时**静态面照跑**，只把现场面如实 skip。
    // 漏守卫的后果是本轮实测抓出来的：`edit` 在缺后端时回 `unavailable` 载荷、没有 `binaryBefore` 字段，
    // 而下面 2252 那行无条件读它 ⇒ 整条判据抛异常 ⇒ `selftest` 出 FAIL、退码 1，
    // 打穿 ADR-001 的"没装后端的机器/外人克隆必须依旧全绿"。同文件另外三条（ADR-002 认领、edit/merge 承重）都有这道守卫，只这一条漏装。
    if (!ocliAvailable()) {
      r6Sweep();
      return bad.length ? bad.slice(0, 6).join(' | ')
        : `skip（这台机器没有写后端（解析自 ${resolveOfficecliExe().source}）：静态面实跑 ${staticChecks} 条断言零缺陷（预期 5，含"后端 stdout 不透传"两层）；最小写的现场面未测，不冒充通过）`;
    }
    // 现场跑一次最小写：拿 _probe 的 blank.docx 复制件，确认回报里 binaryBefore/After 都是"字节数#sha8"形状且相等，且 warnings 为空
    const S = path.join(TMP_DIR, `r6guard-${stamp()}`);
    fs.mkdirSync(S, { recursive: true });
    try {
      const doc = path.join(S, 'g.docx');
      // AUD-2（v1.6.6）：同 r6Fixtures——夹具自造，不依赖 gitignore 的 _probe 资源（真克隆态 ENOENT 形状消除）
      fs.writeFileSync(doc, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t> </w:t></w:r></w:p></w:body></w:document>`));
      const before = officecliBinaryStamp(resolveOfficecliExe().exe);
      // v2.3.0：期望成功的调用点走 tryOnce（后端偶发静默丢弃重试一次；口径见 isDropFlake 注释）
      const r = tryOnce(['edit', doc, 'add', '/body', '--type', 'paragraph', '--prop', 'text=GUARD_SENTINEL']);
      const j = r.j;
      if (!j) return `跑不出 JSON：${String(r.p.stdout || r.p.stderr).slice(0, 120)}`;
      if (j.ok !== true) bad.push(`最小写用例没成功（code=${j.code}）：${String(j.error).slice(0, 120)}`);
      const bb = j.backend || {};
      if (!bb.binaryBefore || !bb.binaryAfter) bad.push('回报里没有 backend.binaryBefore/binaryAfter 两枚身份章');
      else if (bb.binaryBefore.sha8 !== before.sha8 || bb.binaryBefore.bytes !== before.bytes) bad.push(`binaryBefore 与判据自己算的章不一致：报 ${JSON.stringify(bb.binaryBefore)} ／ 算 ${JSON.stringify(before)}`);
      if (bb.binaryBefore && bb.binaryAfter && bb.binaryDrift !== (bb.binaryBefore.sha8 !== bb.binaryAfter.sha8)) bad.push('binaryDrift 不是由前后两枚章推出来的（自曝字段互不矛盾）');
      if (j.verify && j.verify.needleFound !== true) bad.push('写进去的值没在副本里被装置自己找到（verify.needleFound=' + JSON.stringify(j.verify && j.verify.needleFound) + '）');
      if (j.original && j.original.unchanged !== true) bad.push('原件 sha 对账没报 unchanged=true');
      if (/GUARD_SENTINEL/.test(JSON.stringify(j.backend) + JSON.stringify(j.warnings || []))) bad.push('哨兵值出现在 backend 段或 warnings 里（说明后端原始输出被接进了回报）');
    } finally {
      r6Sweep();
      try { fs.rmSync(S, { recursive: true, force: true }); } catch {}
    }
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('edit 承重形状：产物名是 -work.、原件 sha 前后全等、判据独立回读副本、--out 撞车即拒、族外与缺 --type 都拒', () => {
    if (!ocliAvailable()) return `skip（这台机器没有写后端（解析自 ${resolveOfficecliExe().source}），edit 的四条形状一条也测不了——不冒充通过）`;
    const S = path.join(TMP_DIR, `r6edit-${stamp()}`); fs.mkdirSync(S, { recursive: true });
    try {
      const { doc } = r6Fixtures(S);
      const shaBefore = sha256(fs.readFileSync(doc)), sizeBefore = fs.statSync(doc).size;
      const bad = [];
      const r = tryOnce(['edit', doc, 'add', '/body', '--type', 'paragraph', '--prop', 'text=R6_ED_77A1']);
      if (!r.j) return 'edit 没出 JSON：' + String(r.p.stdout || r.p.stderr).slice(0, 140);
      if (r.j.ok !== true) bad.push(`正向 edit 失败（code=${r.j.code}）：${String(r.j.error).slice(0, 140)}`);
      const shaAfter = sha256(fs.readFileSync(doc));
      if (shaAfter !== shaBefore || fs.statSync(doc).size !== sizeBefore) bad.push(`🔴 输入文件被改动了：sha ${shaBefore.slice(0, 12)}→${shaAfter.slice(0, 12)}，字节 ${sizeBefore}→${fs.statSync(doc).size}（承重 1 破了；装置的 original 段自报=${JSON.stringify(r.j.original)}）`);
      const wc = String(r.j.workCopy || '');
      // 🔴 落点契约写的是"产物根"而不是字面量 `_out`：v2.9.0 O1 之后 selftest 态的产物根是本轮工作目录下的 out/，
      //    拿 `_out[/\\]` 去比会把"重定向生效"当成"命名违约"（2026-10-14 实犯：本轮这两条一起红）。
      const rootN = String(OUT_DIR).replace(/\\/g, '/');
      const wcN = wc.replace(/\\/g, '/');
      if (!(wcN.startsWith(rootN + '/') && /[^/]+-\d{14}-work\.docx$/.test(wcN))) bad.push(`副本没落在产物根 ${rootN}/ 下、或命名不是 <名>-<14位UTC>-work.<ext>：${wc}`);
      if (!wc.startsWith(OUT_DIR.replace(/\\/g, '/')) && !wc.startsWith(OUT_DIR)) bad.push('副本不在 _out 里：' + wc);
      if (r.j.verify && r.j.verify.needleFound !== true) bad.push('哨兵没在副本里找到：' + JSON.stringify(r.j.verify));
      // 判据**自己**再解一次 ZIP（不吃装置 verify 的结论），这是"冗余防线每层能单独打红"那一层
      const wPath = wc.replace(/\\/g, '/');
      if (fs.existsSync(wPath)) {
        const m = zipRead(fs.readFileSync(wPath));
        const has = [...m.values()].some((d) => str(d).includes('R6_ED_77A1'));
        if (!has) bad.push('判据独立解副本的 XML 部件后**找不到**哨兵（装置的 needleFound 是谎）');
        if (r.j.verify && r.j.verify.needleFound === true && !has) bad.push('自报与独立回读矛盾');
      } else bad.push('副本路径不存在：' + wPath);
      // --out 撞车必须拒（不覆盖）
      const o1 = path.join(S, 'delivered.docx');
      const a1 = tryOnce(['edit', doc, 'add', '/body', '--type', 'paragraph', '--prop', 'text=R6_ED_ONE', '--out', o1]);
      // 🔴 v2.3.0：前置不成立即停 + 现场带出——本轮的偶发 ENOENT 就是在这条"a1 失败后仍硬读 o1"上
      // 被吞掉红因的（判据 threw ENOENT，a1 自己的 code/error 全部丢失，多花一轮定位）。整修两份证据。
      if (!a1.j || a1.j.ok !== true) return `带 --out 的首次交付失败（后续断言无从谈起；a1 现场：status=${a1.p.status} stdout=${String(a1.p.stdout || '').slice(0, 220)} stderr=${String(a1.p.stderr || '').slice(0, 120)}）`;
      if (!fs.existsSync(o1)) return `🔴 带 --out 的交付报了 ok 但产物不在（谎报落点复辟）：${o1}（a1.output=${JSON.stringify(a1.j.output)} delivered=${JSON.stringify(a1.j.delivered)}）`;
      const shaO1 = sha256(fs.readFileSync(o1));
      const a2 = tryOnce(['edit', doc, 'add', '/body', '--type', 'paragraph', '--prop', 'text=R6_ED_TWO', '--out', o1]);
      if (a2.j && a2.j.ok === true) bad.push('--out 指向已存在文件却写成功了（"永不覆盖"被打穿）');
      if (!a2.j || a2.j.code !== 'invalid-output') bad.push('--out 撞车的码应为 invalid-output，实为 ' + JSON.stringify(a2.j && a2.j.code));
      if (sha256(fs.readFileSync(o1)) !== shaO1) bad.push('被拒的那次仍然改了 --out 文件');
      // 🔴 值被后端**静默丢弃**这一类必须报失败：实测 `add --prop zzz=NOTAPROP_888` 回 **退码 2 ＋ success:true**，
      //    只在后端自己的 warnings 里写 `Unsupported property: zzz`——装置若拿 success 当结论，就交付一份什么都没改的副本（M48 的靶）。
      const drop = CLI2(['edit', doc, 'add', '/body', '--type', 'paragraph', '--prop', 'zzz=NOTAPROP_888']);
      if (drop.j && drop.j.ok === true) bad.push('属性被后端丢弃（副本里找不到那个值）却交付了成功结论——写后回读对账没有闸门');
      if (drop.j && drop.j.code !== 'failed') bad.push('属性丢弃案的码应为 failed，实为 ' + JSON.stringify(drop.j && drop.j.code));
      if (drop.j && drop.j.verify && drop.j.verify.needleFound !== false) bad.push('丢弃案里 needleFound 竞不是 false：' + JSON.stringify(drop.j.verify));
      // 非文本属性（bold/italic 一类）不做值对账，但必须自报"这一面没测"，不许静默跳过
      const nb = CLI2(['edit', doc, 'set', '/body/p[1]', '--prop', 'bold=true']);
      if (nb.j && nb.j.ok === true && !(nb.j.verify && Array.isArray(nb.j.verify.notValueChecked) && nb.j.verify.notValueChecked.length)) bad.push('bold 这类非文本属性没在 verify.notValueChecked 里自报（静默分支必须留痕）');
      // 族外、缺 --type、remove 带 --prop、set 空写、操作名未知：各种形状都得拒且退码 1
      const odtCopy = path.join(S, 'x.odt');
      // AUD-2（v1.6.6）：族外用例只测扩展名拒绝（edit 在 ZIP 解析前就 die unsupported-format），自造占位文件即可——
      // 旧版 copy _probe/cn.odt（gitignore 资源），真克隆态 ENOENT 抛异常。
      fs.writeFileSync(odtCopy, 'odf-placeholder-for-extname-rejection');
      for (const [args, want, label] of [
        [['edit', odtCopy, 'set', '/body/p[1]', '--prop', 'text=a'], 'unsupported-format', '族外输入（ODF 没有可达的后端路线）'],
        [['edit', doc, 'add', '/body', '--prop', 'text=a'], 'invalid-output', 'add 缺 --type'],
        [['edit', doc, 'remove', '/body/p[1]', '--prop', 'text=a'], 'invalid-output', 'remove 带 --prop'],
        [['edit', doc, 'refresh', '/body/p[1]'], 'invalid-output', '操作名不在 set/add/remove'],
        [['edit', doc, 'set'], 'invalid-output', 'set 缺元素路径'],
        [['edit', doc, 'set', '/body/p[1]'], 'invalid-output', 'set 不给 --prop（空写）'],
      ]) {
        const x = CLI2(args);
        if (!x.j || x.j.code !== want || x.p.status !== 1) bad.push(`${label}：期望 ${want}+退码1，实得 ${JSON.stringify(x.j && x.j.code)}+${x.p.status}`);
      }
      return bad.length ? bad.slice(0, 6).join(' | ') : true;
    } finally { r6Sweep(); try { fs.rmSync(S, { recursive: true, force: true }); } catch {} }
  });

  t('后端调用审计：每一次真起子进程调后端都必须落一行自报 env 与二进制前后哈希的审计，没起子进程的路径一行都不许多写', () => {
    const bad = [];
    const srcAll = str(fs.readFileSync(__filename));
    // 静态层：审计必须真的接在调用点上。只写函数不接调用点＝第二道瞎网（本轮 M107 的同族教训：防线得能单独打红）。
    for (const need of ['function auditBackendCall(', 'const auditWrite = auditBackendCall(auditRec);', 'drift: binaryDrift', 'TMPisDeviceDir']) {
      if (!srcAll.includes(need)) bad.push(`源码里找不到 ${JSON.stringify(need.slice(0, 44))}——审计通道断了`);
    }
    if (!ocliAvailable()) {
      return bad.length ? bad.slice(0, 4).join(' | ')
        : `skip（这台机器没有写后端（解析自 ${resolveOfficecliExe().source}）：静态层已核，现场层未测，不冒充通过）`;
    }
    const count = () => { try { return str(fs.readFileSync(AUDIT_FILE)).split(String.fromCharCode(10)).filter(Boolean).length; } catch { return 0; } };
    const S = path.join(TMP_DIR, `audit-${stamp()}`);
    fs.mkdirSync(S, { recursive: true });
    // 独立腿（不信自报）：审计里的 env 是装置自己写的，所以这里直接问 `officecliEnv()` 要真值——
    // 它要是把 TMP/TEMP 漏了，审计那句"自报 TMP 指向装置目录"就是自证，必须当场红（M115 打这条）。
    const ev = officecliEnv(S);
    if (ev.TMP !== S || ev.TEMP !== S) bad.push('officecliEnv 没把 TMP/TEMP 指到传入目录——审计里的 env 自报就成了自证（10-06 实犯的第三条漏项）');
    if (ev.OFFICECLI_SKIP_UPDATE !== '1' || ev.OFFICECLI_NO_AUTO_RESIDENT !== '1') bad.push('officecliEnv 少了隔离旗标（SKIP_UPDATE / NO_AUTO_RESIDENT）');
    // v1.7.0：夹具**自造**（AUD-2 同形）。v1.6.6 刚把这类 gitignore 依赖自产化，v1.6.7 的 WP-C 又把
    // 「_probe 里取一份 blank.docx，没有就 SKIP」写了回来。`_probe/` 不入库（.gitignore:4），缺件时本条
    // 自报的 SKIP 又不在 DEP_SKIP_REGISTRY 里（本条并不吃 kit）⇒ 覆盖率闸判成「新吃 kit 却没登记」并红。
    // 10-07 19:40 那次清扫删掉整棵 _probe/ 后，主树首跑就复现了：注册 48 条／实测 49 条。
    const { doc: work } = r6Fixtures(S);
    const n0 = count();
    // v2.3.0：期望成功的调用点带偶发重试（isDropFlake 口径）；重试＝真调后端两次 ⇒ 审计就该多 2 行，一一对应不破
    const ARGS_AUDIT = ['edit', work, 'add', '/body', '--type', 'paragraph', '--prop', 'text=AUDIT_SENTINEL', '--out', path.join(S, 'a-out.docx')];
    let p = spawnSync(process.execPath, [__filename, ...ARGS_AUDIT], { encoding: 'utf8', timeout: 240000 });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    let auditRetried = false;
    if (isDropFlake(j)) { auditRetried = true; p = spawnSync(process.execPath, [__filename, ...ARGS_AUDIT], { encoding: 'utf8', timeout: 240000 }); j = null; try { j = JSON.parse(p.stdout); } catch {} }
    const n1 = count();
    if (!j || j.ok !== true) return `最小写本身没成功（code=${j && j.code}），审计现场无从对账：` + String(p.stdout || p.stderr).slice(0, 150);
    if (n1 !== n0 + (auditRetried ? 2 : 1)) return `一次真调后端应当多 ${auditRetried ? 2 : 1} 行审计（偶发重试${auditRetried ? '已' : '未'}发生），实际多 ${n1 - n0} 行（台账 ${AUDIT_FILE}）`;
    const lines = str(fs.readFileSync(AUDIT_FILE)).split(String.fromCharCode(10)).filter(Boolean);
    let rec = null; try { rec = JSON.parse(lines[lines.length - 1]); } catch (e) { return '审计最后一行不是合法 JSON：' + String(e.message).slice(0, 80); }
    if (!rec.env || rec.env.OFFICECLI_SKIP_UPDATE !== '1') bad.push(`审计行没自报 SKIP_UPDATE=1（实为 ${JSON.stringify(rec.env && rec.env.OFFICECLI_SKIP_UPDATE)}）——"每次调用都带隔离 env"这句话今天没人记账`);
    if (!rec.env || rec.env.OFFICECLI_NO_AUTO_RESIDENT !== '1') bad.push('审计行没自报 NO_AUTO_RESIDENT=1');
    if (!rec.env || rec.env.TMPisDeviceDir !== true) bad.push('审计行没自报 TMP/TEMP 指向装置目录（10-06 实犯的第三条漏项）');
    if (!Array.isArray(rec.sha8) || rec.sha8.length !== 2 || !rec.sha8[0] || !rec.sha8[1]) bad.push('审计行缺前后两枚 sha8');
    if (typeof rec.drift !== 'boolean') bad.push('审计行缺 drift 布尔（前后不等必须显式落这个字段）');
    if (rec.verb !== 'add') bad.push(`审计行的动词应为 add，实为 ${JSON.stringify(rec.verb)}`);
    if (typeof rec.exitCode !== 'number') bad.push('审计行缺后端 exitCode（不许只记装置的结论，换体排查要看子进程自己返回什么）');
    // 第二条腿：装置在读包阶段就拒的路径**没起过子进程** ⇒ 审计必须一行都不许多写。
    // 这条腿存在的理由：审计与 spawn 若不一一对应，事后归因会被假台账带偏（"装置调过后端"的伪证据）。
    const n2 = count();
    const p2 = spawnSync(process.execPath, [__filename, 'edit', path.join(S, 'no-such.docx'), 'add', '/body', '--type', 'paragraph', '--prop', 'text=X', '--out', path.join(S, 'x.docx')], { encoding: 'utf8', timeout: 240000 });
    let j2 = null; try { j2 = JSON.parse(p2.stdout); } catch {}
    const n3 = count();
    if (j2 && j2.ok === true) bad.push('不存在的输入居然成功了（承重 1 破了）');
    if (n3 !== n2) bad.push(`没起子进程的路径多写了 ${n3 - n2} 行审计——审计必须与 spawn 一一对应`);
    r6Sweep();   // 本条自己造的 _out 副产物按同一把尺自清（在册待办 G 项说的是改造前那批判据，不是新写的）
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('merge 承重形状：模板零改动、值真填进去且占位符不残留、空对象与非标量拒、输出撞车拒且不传后端 --force', () => {
    if (!ocliAvailable()) return 'skip（这台机器没有写后端，merge 的一条也测不了）';
    const S = path.join(TMP_DIR, `r6merge-${stamp()}`); fs.mkdirSync(S, { recursive: true });
    try {
      const bad = [];
      const { doc } = r6Fixtures(S);
      const t1 = tryOnce(['edit', doc, 'add', '/body', '--type', 'paragraph', '--prop', 'text={{R6K}}-tail']);
      if (!t1.j || t1.j.ok !== true) return '夹具模板没做出来（edit add 占位符失败）：' + JSON.stringify(t1.j && t1.j.code);
      const tpl = t1.j.workCopy.replace(/\\/g, '/');
      const tplSha = sha256(fs.readFileSync(tpl));
      const data = path.join(S, 'd.json');
      fs.writeFileSync(data, JSON.stringify({ R6K: 'R6_MERGED_5' }));
      const m = CLI2(['merge', tpl, data]);
      if (!m.j) return 'merge 没出 JSON：' + String(m.p.stdout || m.p.stderr).slice(0, 140);
      // v2.3.0：后端偶发面在 merge 动词上的同族形态＝报成功但产物里没填上（isDropFlake 的姊妹口径）；
      // 同把尺重试一次（第一次的空产物由 r6Made/r6Sweep 照常清理）
      if (m.j.ok === true) {
        const oq = String(m.j.output || '').replace(/\\/g, '/');
        let filled = false;
        if (oq && fs.existsSync(oq)) { try { filled = [...zipRead(fs.readFileSync(oq)).values()].map((d) => str(d)).join('').includes('R6_MERGED_5'); } catch { /* 坏产物照原样进后续断言 */ } }
        if (!filled) { const m2 = CLI2(['merge', tpl, data]); if (m2.j) { m.p = m2.p; m.j = m2.j; } }
      }
      if (m.j.ok !== true) bad.push(`正向 merge 失败（code=${m.j.code}）：${String(m.j.error).slice(0, 140)}`);
      if (sha256(fs.readFileSync(tpl)) !== tplSha) bad.push('🔴 模板被改动了（承重 1）');
      if (m.j.templateSha && m.j.templateSha.unchanged !== true) bad.push('templateSha.unchanged 不是 true');
      const oPath = String(m.j.output || '').replace(/\\/g, '/');
      if (!fs.existsSync(oPath)) bad.push('产物不存在：' + oPath);
      else {
        const mm = zipRead(fs.readFileSync(oPath));
        const all = [...mm.values()].map((d) => str(d)).join('');
        if (!all.includes('R6_MERGED_5')) bad.push('产物里找不到填进去的值（装置的 filledKeys=' + JSON.stringify(m.j.verify && m.j.verify.filledKeys) + '）');
        if (all.includes('{{R6K}}')) bad.push('产物里占位符还在（没填上却报了成功）');
      }
      if (m.j.verify && (m.j.verify.filledKeys !== 1 || (m.j.verify.leftoverPlaceholders || []).length)) bad.push('自报计数与独立回读不符：' + JSON.stringify(m.j.verify));
      const again = CLI2(['merge', tpl, data, oPath]);
      if (again.j && again.j.ok === true) bad.push('输出已存在却写成功（永不覆盖被打穿）');
      if (!again.j || again.j.code !== 'invalid-output') bad.push('输出撞车的码应为 invalid-output，实为 ' + JSON.stringify(again.j && again.j.code));
      // 🔴 落点核对：输出路径**在 _out 之外**时，装置报的那个路径必须真的存在。
      // 上一版把命令按 `basename + cwd:OUT_DIR` 拼给后端，用户给外部路径时产物落进 _out/<同名>、
      // 回报里却是用户那个不存在的路径——09:57 自查抓到（`_out\m.docx` 生成、`_probe\r6out\m.docx` 不存在）。
      const farDir = path.join(S, 'elsewhere'); fs.mkdirSync(farDir, { recursive: true });
      const far = path.join(farDir, 'm-out.docx');
      const fm = CLI2(['merge', tpl, data, far]);
      if (!fm.j) bad.push('输出在 _out 之外时 merge 没出 JSON');
      else if (fm.j.ok === true && !fs.existsSync(far)) bad.push(`谎报落点：output 报 ${far} 但该文件不存在（产物有没有落在别处：_out 同名=${fs.existsSync(path.join(OUT_DIR, path.basename(far))) ? '有' : '无'}）`);
      else if (fm.j.ok === true && fs.existsSync(path.join(OUT_DIR, path.basename(far)))) bad.push('输出在 _out 之外却同时在 _out 落了同名件：' + path.join(OUT_DIR, path.basename(far)));
      // 数据形状三条 + 族外一条 + 源码层"永不传 --force"
      fs.writeFileSync(path.join(S, 'empty.json'), '{}');
      const e1 = CLI2(['merge', tpl, path.join(S, 'empty.json')]);
      if (!e1.j || e1.j.code !== 'invalid-document') bad.push('空对象数据应 invalid-document，实为 ' + JSON.stringify(e1.j && e1.j.code));
      fs.writeFileSync(path.join(S, 'nested.json'), JSON.stringify({ R6K: { a: 1 } }));
      const e2 = CLI2(['merge', tpl, path.join(S, 'nested.json')]);
      if (!e2.j || e2.j.code !== 'invalid-document') bad.push('非标量值应 invalid-document，实为 ' + JSON.stringify(e2.j && e2.j.code));
      const e3 = CLI2(['merge', tpl, path.join(S, 'no-such.json')]);
      if (!e3.j || e3.j.code !== 'invalid-document') bad.push('数据文件不存在应 invalid-document，实为 ' + JSON.stringify(e3.j && e3.j.code));
      const srcOfWrite = (cmdBody('Edit') || '') + (cmdBody('Merge') || '');
      // 只拦"当参数传给后端"的那个形状（引号里的 --force）；说明文字里提到这个词是**应该的**（写明"装置从不传"）
      if (/['"]--force['"]/.test(srcOfWrite)) bad.push('cmdEdit/cmdMerge 把 --force 当参数传给了后端（覆盖开关必须永不透出去）');
      return bad.length ? bad.slice(0, 6).join(' | ') : true;
    } finally { r6Sweep(); try { fs.rmSync(S, { recursive: true, force: true }); } catch {} }
  });

  t('OfficeCLI 降级与动词白名单：缺后端 unavailable+指路+_out 零新增落点；被禁动词不落到子进程；禁清单与 ADR 排除项一一对应', () => {
    const bad = [];
    const fake = 'Z:\\__no_such_dir_for_judgment__\\officecli.exe';
    const S = path.join(TMP_DIR, `r6degrade-${stamp()}`); fs.mkdirSync(S, { recursive: true });
    try {
      const { doc } = r6Fixtures(S);
      fs.writeFileSync(path.join(S, 'd.json'), JSON.stringify({ R6K: 'V' }));
      const outBefore = fs.readdirSync(OUT_DIR).length;
      const e = CLI2(['edit', doc, 'set', '/body/p[1]', '--prop', 'text=NOPE'], { DOCKIT_OFFICECLI: fake });
      const m = CLI2(['merge', doc, path.join(S, 'd.json')], { DOCKIT_OFFICECLI: fake });
      if (e.p.status !== 1 || !e.j || e.j.code !== 'unavailable') bad.push(`缺后端时 edit 应退码1+unavailable，实得 ${e.p.status}/${JSON.stringify(e.j && e.j.code)}`);
      if (e.j && !new RegExp(OFFICECLI_ENV).test(String(e.j.next))) bad.push('edit 的 next 没指环境变量路：' + String(e.j && e.j.next).slice(0, 80));
      if (e.j && e.j.workCopy) bad.push('缺后端时竟然已经复制了副本：' + e.j.workCopy + '（顺序错了——探测必须在 copyfile 之前，否则每次失败都在 _out 留一个垃圾）');
      if (m.p.status !== 1 || !m.j || m.j.code !== 'unavailable') bad.push(`缺后端时 merge 应退码1+unavailable，实得 ${m.p.status}/${JSON.stringify(m.j && m.j.code)}`);
      const outAfter = fs.readdirSync(OUT_DIR).length;
      if (outAfter !== outBefore) bad.push(`🔴 降级路径在 _out 留了 ${outAfter - outBefore} 个落点（应当为 0——"命令返回了但什么都没做成"不许伪装成做事）`);
      // 动词白名单：被禁动词必须**不落到子进程**。这段用假路径包住——闸门若在，根本不会 spawn；
      // 闸门被拆掉时（M96）它会先撞上"后端不在位"而返回 unavailable ⇒ 判据照样红，但**绝不会真去 spawn 一个 install/refresh**。
      const savedEnv = process.env[OFFICECLI_ENV];
      try {
        process.env[OFFICECLI_ENV] = 'Z:\\__no_such_dir_for_judgment__\\officecli.exe';
        for (const verb of ['refresh', 'install', 'open', 'screenshot', 'get', 'dump']) {
          const res = officecliCall(verb, [verb]);
          if (res.refused !== true || res.code !== 'unsupported-format') bad.push(`动词 ${verb} 竞没被拒（refused=${res.refused} code=${res.code}）——白名单成了解释而不是闸门`);
          if (res.spawnDelta !== 0) bad.push(`被拒的动词 ${verb} 还是起了子进程（spawnDelta=${res.spawnDelta}）`);
        }
      } finally {
        if (savedEnv === undefined) delete process.env[OFFICECLI_ENV]; else process.env[OFFICECLI_ENV] = savedEnv;
      }
      // 禁清单要真覆盖 ADR 的排除项，且与允许清单不相交
      for (const must of ['refresh', 'install', 'skills', 'mcp', 'open', 'close', 'save', 'watch', 'unwatch']) if (!OFFICECLI_VERB_DENY.includes(must)) bad.push(`OFFICECLI_VERB_DENY 缺 ${must}`);
      const both = OFFICECLI_VERB_ALLOW.filter((v) => OFFICECLI_VERB_DENY.includes(v));
      if (both.length) bad.push('同一动词既允许又禁止：' + both.join('/'));
      return bad.length ? bad.slice(0, 7).join(' | ') : true;
    } finally { r6Sweep(); try { fs.rmSync(S, { recursive: true, force: true }); } catch {} }
  });

  t('check --backend 两条路线：zip 是默认且不起引擎，officecli 只回 schema 结论；缺后端不改 clean 也不红；未知值拒', () => {
    const bad = [];
    const S = path.join(TMP_DIR, `r6check-${stamp()}`); fs.mkdirSync(S, { recursive: true });
    try {
      const { doc } = r6Fixtures(S);
      const d = CLI2(['check', doc]);
      if (!d.j || d.j.ok !== true) bad.push('默认 check 失败：' + JSON.stringify(d.j && d.j.code));
      if (d.j && d.j.backend !== DEFAULT_CHECK_BACKEND) bad.push('默认 backend 应为 ' + DEFAULT_CHECK_BACKEND + '，实为 ' + JSON.stringify(d.j && d.j.backend));
      if (d.j && d.j.engine !== false) bad.push('默认 check 的 engine 自曝不是 false');
      if (!ocliAvailable()) {
        bad.length = 0;
        return `skip（这台机器没有写后端：--backend officecli 的正向面测不了。只核了默认路线与形状，后端缺失的降级形状由下一条断言）`;
      }
      const o = CLI2(['check', doc, '--backend', 'officecli']);
      if (!o.j || o.j.ok !== true) bad.push('带后端的 check 失败：' + JSON.stringify(o.j && o.j.code));
      if (o.j && (!o.j.schema || o.j.schema.requested !== true || o.j.schema.available !== true)) bad.push('schema 段没自报 requested/available：' + JSON.stringify(o.j && o.j.schema));
      if (o.j && o.j.schema && o.j.schema.valid !== true) bad.push('干净夹具的 schema.valid 应为 true，实为 ' + JSON.stringify(o.j.schema.valid));
      if (o.j && o.j.engine !== false) bad.push('加了 --backend officecli 也不该起 kit 引擎');
      const fake = 'Z:\\__no_such_dir_for_judgment__\\officecli.exe';
      const f1 = CLI2(['check', doc], { });
      const f2 = CLI2(['check', doc, '--backend', 'officecli'], { DOCKIT_OFFICECLI: fake });
      if (!f2.j || f2.j.ok !== true) bad.push('缺后端时 check 不该整体失败（降级不许变成红）：' + JSON.stringify(f2.j && f2.j.code));
      if (f2.j && f2.j.schema && (f2.j.schema.available !== false || f2.j.schema.code !== 'unavailable')) bad.push('缺后端时 schema 段应自报 available=false+unavailable：' + JSON.stringify(f2.j && f2.j.schema));
      if (f2.j && f2.j.clean !== f1.j.clean) bad.push(`缺后端把 clean 从 ${f1.j.clean} 改成 ${f2.j.clean} 了——后端缺席不该改变其它族的结论`);
      if (!(f2.j.warnings || []).length) bad.push('缺后端却没落 warnings（静默分支必须自报留痕）');
      const u = CLI2(['check', doc, '--backend', 'banana']);
      if (!u.j || u.j.code !== 'invalid-output' || u.p.status !== 1) bad.push('未知 --backend 值应 invalid-output+退码1，实得 ' + JSON.stringify(u.j && u.j.code) + '/' + u.p.status);
      return bad.length ? bad.slice(0, 6).join(' | ') : true;
    } finally { r6Sweep(); try { fs.rmSync(S, { recursive: true, force: true }); } catch {} }
  });
  // 只核登记表里**非空**的 入口文件绝对路径（落盘了的入口）；null（未落盘）行是族外状态，不核，
  // 不制造不可携带的红（与总览第八节第 11 条同族）。攻击：M29 把 Qoder CN 那条路径末位写错一号 ⇒ 只红这一条。
  t('入口数字与源对账：文档写的「非空入口数=<N>」必须等于 entry-points.json 现算的非空路径条数（数字靠人记一定烂）', () => {
    const p = ROOT + '/entry-points.json';
    if (!fs.existsSync(p)) return 'skip（登记表未建）';
    let j = null; try { j = JSON.parse(str(fs.readFileSync(p))); } catch (e) { return '登记表不是合法 JSON：' + e.message; }
    const rows = Array.isArray(j) ? j : j['入口'];
    if (!Array.isArray(rows) || !rows.length) return '登记表缺少非空的 入口 数组';
    // 尺子＝"非空入口文件绝对路径"的行数（与  那条同一把尺，两处不许各数一遍）
    const nonEmpty = rows.filter((r) => r && typeof r['入口文件绝对路径'] === 'string' && r['入口文件绝对路径'].trim()).length;
    const files = [['README', ROOT + '/README.md'], ['调用卡', ROOT + '/给其它agent-调用卡.md'], ['总览', ROOT + '/项目总览.md']];
    const bad = [];
    let asserted = 0;
    for (const [label, f] of files) {
      if (!fs.existsSync(f)) continue;
      const t0 = str(fs.readFileSync(f));
      const nums = [...t0.matchAll(/非空入口数=(\d+)/g)].map((x) => Number(x[1]));
      if (!nums.length) { if (label !== '总览') bad.push(`${label} 缺"非空入口数=<N>"断言（缺了这条判据对它形同虚设，不许用散文糊过去）`); continue; }
      for (const v of nums) { asserted++; if (v !== nonEmpty) bad.push(`${label} 写"非空入口数=${v}"，登记表现算 ${nonEmpty} 条（共 ${rows.length} 行）`); }
    }
    if (!asserted) return `skip（三份文档都没写机器形状"非空入口数=<N>"：现算 ${nonEmpty} 条无从对账——这本身就是 Q-13 要防的"散文里报数"）`;
    return bad.length ? bad.slice(0, 5).join(' | ') : true;
  });
  t('entry 登记表：entry-points.json 里每个非空的入口文件绝对路径必须存在', () => {
    const p = ROOT + '/entry-points.json';
    if (!fs.existsSync(p)) return 'skip（登记表未建）';
    let j; try { j = JSON.parse(str(fs.readFileSync(p))); } catch (e) { return '登记表不是合法 JSON：' + e.message; }
    const rows = Array.isArray(j) ? j : j['入口'];
    if (!Array.isArray(rows) || !rows.length) return '登记表缺少非空的 入口 数组';
    // 🔴 机器门（v1.6.7 监工侧补，机主裁 Q-13 时实测到的洞）：这张表记的是**某一台机器**上的绝对路径，
    // 换一台机器（含外人克隆）这些路径本就不存在，旧写法会把它们全判成 FAIL ⇒ 打穿 ADR-001 的「克隆首跑依旧全绿」。
    // 与 §8-20 同一类错误（把机器特定数据当普适断言）。口径＝不在标定机器上就 SKIP 并自报，既不算绿也不算红。
    const here = (process.env.USERPROFILE || process.env.HOME || '') + '|' + (process.env.COMPUTERNAME || '');
    const calibrated = j['标定机器'] || null;
    if (calibrated && calibrated !== here) return `skip（登记表记的是 ${calibrated} 那台机器的入口路径，本机是 ${here || '(读不到)'}：存在性核过 0 条——不冒充通过，也不冒充红）`;
    const bad = []; let checked = 0;
    for (const r of rows) {
      const ep = r && r['入口文件绝对路径'];
      if (!ep) continue;
      checked++;
      if (!fs.existsSync(ep)) bad.push(`${r['客户端名'] || '(无名行)'} 的入口路径不存在：${ep}`);
    }
    if (!checked) return 'skip（登记表里没有已落盘的入口路径）';
    return bad.length ? `核过 ${checked} 条 ⇒ ` + bad.join(' | ') : true;
  });

  // R5（v1.6.0）：登记表是**给别的 agent 读的数据文件**，一行里 入口文件绝对路径／状态／是否已活体验证 三个字段在说同一件事。
  // 上一条只核路径存在，看不见"路径已落、状态还写着未落盘"这种自己打自己——本轮改登记表时就真的差一点写成那样（四家的状态原文全是"未落盘（仓外写未获本轮放行）"）。
  // 所以这里断的是**字段之间的关系**，逐个核非空没有意义（规范 §4.4 第 8 条）。
  t('登记表字段互不矛盾：状态称已落盘/已活验的行必须有非空入口路径，路径非空的行状态不许写"未落盘"', () => {
    const p = ROOT + '/entry-points.json';
    if (!fs.existsSync(p)) return 'skip（登记表未建）';
    let j; try { j = JSON.parse(str(fs.readFileSync(p))); } catch (e) { return '登记表不是合法 JSON：' + e.message; }
    const rows = Array.isArray(j) ? j : j['入口'];
    if (!Array.isArray(rows) || !rows.length) return '登记表缺少非空的 入口 数组';
    const bad = []; let checked = 0;
    for (const r of rows) {
      checked++;
      const st = String(r['状态'] || '');
      const ep = r['入口文件绝对路径'];
      const landed = Boolean(ep);
      if (/^未落盘/.test(st) && landed) bad.push(`${r['客户端名']}：状态写"${st.slice(0, 14)}"却登记着路径 ${ep}`);
      if (/已落盘|已活验/.test(st) && !landed) bad.push(`${r['客户端名']}：状态称"${st.slice(0, 14)}"但入口路径为空`);
      if (r['是否已活体验证'] === true && !landed) bad.push(`${r['客户端名']}：是否已活体验证=true 但入口路径为空——没落盘的东西不可能活验过`);
    }
    return bad.length ? `核过 ${checked} 行 ⇒ ` + bad.join(' | ') : true;
  });

  // LANG_FILES 已提到配置区（R3-b）：字符集基线台子与这条判据必须是同一份清单，两处各写一份一定会漂
  t('lang 语言白名单：本仓文本不得出现假名／谚文／私有区／替换符／扩展平面表意文字（总纲第二节：仅简中与英文）', () => {
    // 总纲第二节把语言白名单写成"只用简体中文与英文"，但这条一直靠人眼。`doc 卫生` 的控制字符条款管不到它——
    // 假名与谚文都是**合法字符**，只是不该出现在这个仓里。按码点区间拦，不按词表拦（词表一定漏）。
    const bad = [];
    for (const rel of langFiles()) {
      const p = ROOT + '/' + rel;
      if (!fs.existsSync(p)) continue;
      str(fs.readFileSync(p)).split('\n').forEach((line, i) => {
        for (const ch of line) {
          const cp = ch.codePointAt(0);
          const why =
            (cp >= 0x3041 && cp <= 0x30ff) ? '日文假名'
              : (cp >= 0x3130 && cp <= 0x318f) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) ? '韩文谚文'
                : (cp >= 0xff61 && cp <= 0xff9f) ? '半角假名'
                  : (cp >= 0xe000 && cp <= 0xf8ff) ? '私有区'
                    : cp === 0xfffd ? '替换符 U+FFFD（编码层写坏的形状）'
                      : cp >= 0x20000 ? '扩展平面表意文字' : null;
          if (why) bad.push(`${rel}:${i + 1} 出现 ${JSON.stringify(ch)} U+${cp.toString(16)} ＝ ${why}`);
        }
      });
    }
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  // ---- R3-b（任务书 P5-2／Q-05）：字符集基线台子。这条判据不重复实现台子的逻辑，而是**从外面验它的牙**：
  //      ① check 的三个数必须满足算术关系（实算 = 基线 + 新增 − 消失）；② 台子的正面控制（注入基线外汉字必须红）
  //      必须真的绿且注入码点确实不在基线内；③ save 在没有机主同意的环境变量时必须拒绝；
  //      ④ explain 的"在不在基线内"两向都要对；⑤ 台子扫的文件集必须覆盖装置的 LANG_FILES（两处一把尺，各写一份一定漂）。
  t('字符集基线台子：check 的三个数自洽、注入对照必须真被抓、save 无同意必须拒绝、扫描面覆盖 LANG_FILES', () => {
    const TOOL = ROOT + '/test/char-baseline.js';
    const BL = ROOT + '/test/baseline-chars.json';
    if (!fs.existsSync(TOOL)) return 'skip（这台机器上没有 test/char-baseline.js）';
    if (!fs.existsSync(BL)) return '台子在了但基线文件缺：跑 node test/char-baseline.js init（首次创建）或请机主同意 save';
    const RUN = (args) => { const p = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd: ROOT }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const bad = [];
    const base = new Set(JSON.parse(str(fs.readFileSync(BL))).codepoints || []);
    // ① check 的算术自洽 + 与独立重数一致
    const c = RUN(['check']);
    if (!c.j || c.j.ok !== true || c.p.status !== 0) bad.push('check 没退 0：' + JSON.stringify(c.j && { ok: c.j.ok, why: c.j.why }) + ' status=' + c.p.status);
    else {
      const 基线 = c.j['基线码点数'], 实算 = c.j['实算码点数'], 新增 = c.j['新增码点数'], 消失 = c.j['消失码点数'];
      if (实算 !== 基线 + 新增 - 消失) bad.push(`三个数不自洽：实算 ${实算} ≠ 基线 ${基线} + 新增 ${新增} − 消失 ${消失}（差集至少有一边算错）`);
      if (基线 !== base.size) bad.push(`check 报的基线码点数 ${基线} ≠ 基线文件里的 ${base.size}`);
      const own = new Set();
      for (const rel of langFiles()) { const p = ROOT + '/' + rel; if (!fs.existsSync(p)) continue; for (const ch of str(fs.readFileSync(p))) { const cp = ch.codePointAt(0); if (cp >= 0x80 && !(cp <= 8 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || cp === 0x7f || cp === 0xfffd)) own.add(cp); } }
      if (实算 < own.size) bad.push(`台子实算 ${实算} 个码点，比装置自己按 LANG_FILES 独立数的 ${own.size} 个还少 ⇒ 台子漏扫了文件`);
      if (c.j.扫描文件 < langFiles().length) bad.push(`台子只扫了 ${c.j.扫描文件} 份，装置的 LANG_FILES 有 ${langFiles().length} 份 ⇒ 两处一把尺没做到`);
      // 🔴 ①零消失闸（v2.10.0，F2 那条流程行的机械化版本）：基线里有过、现在全仓扫不到的码点**必须为零**。
      //    新增汉字是常态（每轮写新散文），所以"新增"只报不红；但"消失"意味着**有文本连字一起没了**，
      //    那是回归形状，不许静默通过。确有意的改写（换词）由人确认后跑 `save`（需 DOCKIT_BASELINE_CONSENT=1）刷基线。
      if (消失 !== 0) bad.push(`基线里有 ${消失} 个码点在当前语料中扫不到（消失清单：${JSON.stringify(c.j.消失码点)}）＝有文本连字一起丢了；确有意的改写请人工过目后跑 node test/char-baseline.js save（需 consent）`);
      // 🔴 ②给上面那条装牙：基线与语料相同时真实消失恒为 0，"消失算坏了"的实现**在这份数据上永远抓不到**。
      //    所以必须能造一个已知消失出来量——--at 指一份"基线 ∪ 一个不在基线内的码点"的临时件，消失必须恰好 1 且点名。
      const INJ = [0x5470, 0x5639, 0x9fcc, 0x58b3, 0x6c57].find((cp) => !base.has(cp));
      if (INJ === undefined) bad.push('五个注入候选全在基线内 ⇒ 这一面没有牙，人工把混进基线的生僻字清出去（需 consent 跑 save）');
      else {
        const tmp = path.join(S, 'bl-inject.json');
        const data = JSON.parse(str(fs.readFileSync(ROOT + '/test/baseline-chars.json')));
        data.codepoints = [...data.codepoints, INJ].sort((x, y) => x - y);
        data.codepointCount = data.codepoints.length;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 0) + '\n');
        const inj = RUN(['check', '--at', path.relative(ROOT, tmp)]);
        if (!inj.j || inj.j.ok !== true) bad.push('--at 对照另一份基线跑不通（零消失闸因此无从自证）：' + JSON.stringify(inj.j && { why: inj.j.why }));
        else {
          if (inj.j['消失码点数'] !== 1) bad.push(`临时基线多加了一个语料里绝不存在的码点（U+${INJ.toString(16)}），台子却报消失 ${inj.j['消失码点数']}＝"消失"这一面是坏的（①那条零因此说不出任何事）`);
          if (!(Array.isArray(inj.j.消失码点) && inj.j.消失码点.some((x) => String(x).includes('U+' + INJ.toString(16))))) bad.push('消失清单没点名被注入的那个码点＝只报数不报字，人工过目那一关形同虚设');
          if (inj.j['实算码点数'] !== inj.j['基线码点数'] + inj.j['新增码点数'] - inj.j['消失码点数']) bad.push('--at 态三数不自洽：' + JSON.stringify({ 实算: inj.j['实算码点数'], 基线: inj.j['基线码点数'], 新增: inj.j['新增码点数'], 消失: inj.j['消失码点数'] }));
          if (!inj.j.对照基线 || !String(inj.j.对照基线).includes('bl-inject')) bad.push('--at 没自报对照的是哪份基线（读数会与原基线混淆）：' + JSON.stringify(inj.j.对照基线));
        }
        try { fs.rmSync(tmp, { force: true }); } catch { }
      }
    }
    // 🔴 v3.0.0（自检自修实抓）：`--at` 给了却不给值／后面直接跟另一个开关——不许被静默忽略（静默会照跑原基线，
    //    让"对照另一份基线"变成一句谎）；与 v2.4.1"空页清单假成功"同族。两种形状各量一次（红因要求含"缺值"，
    //    否则攻击把"缺值"变成"路径不存在"也能蒙混过关）。
    const noVal = RUN(['check', '--at']);
    if (!noVal.j || noVal.j.ok !== false || !/缺值/.test(String(noVal.j.why))) bad.push('--at 缺值没被拒（静默当没这回事、照跑原基线）：' + JSON.stringify(noVal.j && { ok: noVal.j.ok, why: String(noVal.j.why).slice(0, 80) }));
    const noVal2 = RUN(['check', '--at', '--strict']);
    if (!noVal2.j || noVal2.j.ok !== false || !/缺值/.test(String(noVal2.j.why))) bad.push('--at 后面跟另一个开关没被拒（被当成路径又报"文件不在"，方向不清）：' + JSON.stringify(noVal2.j && { ok: noVal2.j.ok, why: String(noVal2.j.why).slice(0, 80) }));
    // ② 台子的正面控制必须绿，且它用的注入码点**确实不在基线内**（防止台子挑了一个已收录的字自证通过）
    const st = RUN(['selftest']);
    if (!st.j || st.j.ok !== true || st.p.status !== 0) bad.push('selftest（注入对照）没通过——错字形状抓不住就不收这条：' + JSON.stringify(st.j && { why: st.j.why, 失败: st.j.失败 }).slice(0, 220));
    else {
      const cp = Number('0x' + String(st.j.注入用码点 || '').replace(/^U\+/i, ''));
      if (!Number.isFinite(cp) || cp <= 0) bad.push('selftest 没自报注入了哪个码点：' + JSON.stringify(st.j.注入用码点));
      else if (base.has(cp)) bad.push('注入用的码点 U+' + cp.toString(16) + ' 竟已在基线内 ⇒ 对照是空的');
      if (!(st.j.对照集大小 > 0)) bad.push('对照组为空，注入检查可能在空转');
    }
    // ③ save 无同意必须拒绝（机主之外的任何人把它跑成"重写基线"都是把闸门拆掉）
    // save 的反向测试指向**真基线的一份副本**：这样"现有基线规模"可比对，而万一同意闸门被拆（M78），被覆盖的也只是副本，不会毁掉仓里那份
    const svCopy = `${S}/cb-save-probe.json`;
    fs.copyFileSync(BL, svCopy);
    const svCopyBefore = sha256(fs.readFileSync(svCopy));
    const sv = (() => { const p = spawnSync(process.execPath, [TOOL, 'save'], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, DOCKIT_CHAR_BASELINE_PATH: svCopy } }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; })();
    if (fs.existsSync(BL) === false) bad.push('探针跑完仓里的真基线文件反而不在了（写错了地方）');
    if (sha256(fs.readFileSync(BL)) !== sha256(fs.readFileSync(svCopy)) || sha256(fs.readFileSync(svCopy)) !== svCopyBefore) bad.push('save 被拒之后副本仍被改写了（拒绝必须什么都不写）');
    if (sv.p.status !== 1 || !sv.j || sv.j.ok !== false || sv.j.refused !== true) bad.push('save 在没有 DOCKIT_BASELINE_CONSENT 时竟然没拒绝：status=' + sv.p.status + ' ' + JSON.stringify(sv.j && { ok: sv.j.ok, refused: sv.j.refused }));
    if (sv.j && sv.j.现有基线 !== base.size) bad.push('拒绝时没把现有基线规模报出来（要让人看见它会覆盖什么）：' + JSON.stringify(sv.j && sv.j.现有基线));
    if (sv.p.status !== 1) bad.push('save 无同意时退码应为 1，实测 ' + sv.p.status);
    if (sv.j && sv.j.ok === true) bad.push('save 未经同意就写成功了——覆盖基线等于为了让台子绿而扩允许集');
    // ④ explain 两向都对
    const inCp = [...base][0];
    const ex1 = RUN(['explain', String.fromCodePoint(inCp)]);
    if (!ex1.j || ex1.j.ok !== true || ex1.j['在基线内'] !== true || !(ex1.j.出现的文件 || []).length) bad.push('explain 对一个基线内码点报了不在：' + JSON.stringify(ex1.j && { 在基线内: ex1.j['在基线内'], 出现的文件: (ex1.j.出现的文件 || []).length }));
    const out2 = [0x5470, 0x5639, 0x9FCC, 0x58B3, 0x6C57, 0x9F9D, 0x2E80].find((cp) => !base.has(cp));
    if (out2 === undefined) bad.push('找不到基线外码点可做反向对照 ⇒ 基线把什么都收进去了，这条没牙');
    else {
      const ex2 = RUN(['explain', String.fromCodePoint(out2)]);
      if (!ex2.j || ex2.j['在基线内'] !== false) bad.push('explain 对基线外码点 U+' + out2.toString(16) + ' 报成在基线内 ⇒ 成员判定坏了');
    }
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('cli 异步出口：异步命令失败要回结构化 JSON，且 next 不许把人支去 stderr（装置的失败走 stdout）', () => {
    // v1.1.1 已把"失败走 stderr"这句从规范里订正掉，但入口区那条 `r.catch(...)` 的 next 文案还写着"看 stderr"，
    // 而且整条出口一直没有判据、也没有变异覆盖（v1.1.1《已知局限》第一条）。这里补判据，M23 专打它。
    const p = asyncFailPayload(new Error('注入的异步失败 XYZ123'));
    const bad = [];
    if (!p || p.code !== 'failed') bad.push(`code 应为 failed（装置缺陷类），实为 ${JSON.stringify(p && p.code)}`);
    if (!String(p && p.error).includes('XYZ123')) bad.push(`error 必须带上原始 message 原文（红必须带因），实为 ${JSON.stringify(p && p.error)}`);
    const next = String((p && p.next) || '');
    if (!next) bad.push('next 为空（不许裸抛退出码，总纲第八节）');
    if (/stderr/i.test(next)) bad.push(`next 把人支去 stderr，与装置输出契约相反：${JSON.stringify(next)}`);
    const p2 = asyncFailPayload({ notAnError: true });
    if (!p2 || !String(p2.error).length || p2.error === '装置内部异常（已兜住，不吐裸栈）：undefined') bad.push('非 Error 对象拒绝时必须仍能给出可读 error');
    return bad.length ? bad.join(' | ') : true;
  });

  // v2.3.0：本会话宿主实测修正的防回退哨兵（stdin-EBUSY 的来历见工具函数区 SPAWN_STDIO_DEFAULT 注释）。
  // 五个 spawn 宿主文件必须是同一形态的三件套：① 别名解构引入（改名后原名形态会与同名包装函数编译期撞车，
  // 谁想绕过包装就得先撞 SyntaxError）；② 同名包装函数在（stdin 钉桩的落点）；③ 包装内含 stdio 钉桩字面。
  // 断言直接扫**全文**（不剥注释——天真剥注释会被行注释里的"路径+通配"写法触发块注释级联误吃一大段代码，
  // 本仓本轮实测咬过整整七万字符）。代价＝"注释里抄同款字面"会假绿：所以 5 个文件的说明注释一律写描述式
  // （不落完整字面），且变异 M173/M174 会把假绿当场揭穿（删代码后字面仍只在注释里 ⇒ 判据不红 ⇒ 台子 BAD）。
  t('spawn 统一 stdio：五个 spawn 宿主文件必须带别名解构＋同名包装＋stdin 钉桩（本会话 EBUSY 实测修正的防回退哨兵）', () => {
    const files = ['dockit.js', 'test/mutant.js', 'test/dep-set.js', 'test/char-baseline.js', 'test/font-baseline.js'];
    const bad = [];
    for (const rel of files) {
      const p = ROOT + '/' + rel;
      if (!fs.existsSync(p)) { bad.push(`${rel}: 文件不在（覆盖面缺口）`); continue; }
      const code = str(fs.readFileSync(p));
      if (!/require\(\s*['"](node:)?child_process['"]\s*\)/.test(code)) { bad.push(`${rel}: 找不到 child_process 引入`); continue; }
      if (!/\{\s*spawnSync\s*:\s*[A-Za-z_$][\w$]*\s*\}/.test(code)) bad.push(`${rel}: 引入不是别名解构（原名直挂＝可绕过同名包装）`);
      if (/\{\s*spawnSync\s*\}/.test(code)) bad.push(`${rel}: 仍存在原名形态的列式解构（与包装函数撞车或绕过包装的入口）`);
      if (!/function\s+spawnSync\s*\(/.test(code)) bad.push(`${rel}: 没有同名包装函数（stdin 钉桩没有落点）`);
      if (!/['"]ignore['"]\s*,\s*['"]pipe['"]\s*,\s*['"]pipe['"]/.test(code)) bad.push(`${rel}: 包装里找不到 stdin 钉桩字面`);
    }
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('inspect 声明字体族必须已解 XML 实体（不许把 &apos; 原样吐给调用方）', () => {
    // v1.2.0 ODF 取证抓到：ODF 常把字体名写成 `&apos;Liberation Sans&apos;`，不解实体直接吐给调用方，
    // 任何"这个族声明了没有"的比对都假阴性，而且同一族会以两种形态重复出现在清单里。
    const got = declaredFamilies([
      '<style:font-face style:name="LiberationSans" svg:font-family="&apos;Liberation Sans&apos;"/>',
      '<w:docDefaults><w:rFonts w:ascii="&quot;Times New Roman&quot;" w:eastAsia="宋体"/></w:docDefaults>',
      '<w:name>&amp;Arial</w:name>'
    ]);
    const bad = [];
    if (got.some((f) => /&(apos|quot|lt|gt|amp|#)/.test(f))) bad.push('仍有未解实体：' + JSON.stringify(got.filter((f) => /&/.test(f))));
    if (!got.includes("'Liberation Sans'")) bad.push('&apos; 未解成单引号，实为 ' + JSON.stringify(got));
    if (!got.includes('"Times New Roman"')) bad.push('&quot; 未解成双引号');
    if (!got.includes('&Arial')) bad.push('&amp; 未解或解的顺序错（&amp; 必须最后解）');
    // 原来这里还有一条"清单不许有重复项"——删了：got 来自 Map 的 keys()，结构上不可能重复，
    // 那条断言永远红不了＝假牙，只会虚增判据数并让人误以为去重被核过（判据不许有打不红的clause）。
    return bad.length ? bad.join(' | ') : true;
  });

  t('inspect OOXML 字体族采集面：theme/slideLayout/表格 name val 都要吃到，主题令牌与属性名不许当族名', () => {
    // v1.2.1 立。真 pptx 的声明族此前读成 **0 项**（族名只在 theme 的 `typeface=` 上，正文写 `+mj-lt` 令牌），
    // 而同一个文件由引擎自产出的 odp 能读到 14 项 ⇒ "这个族声明了没有"在两侧结论相反（实测 `_probe/real.pptx`）。
    // 走 CLI 而不是直接调 declaredFamilies：调用方拿到的是 inspect 的 declaredFontFamilies 字段。
    const CTp = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
    const P = 'http://schemas.openxmlformats.org/presentationml/2006/main', A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const pptxPath = `${S}/fam.pptx`, xlsPath = `${S}/fam.xlsx`, emptyPath = `${S}/fam-empty.pptx`;
    fs.writeFileSync(pptxPath, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTp) },
      { name: 'ppt/presentation.xml', data: Buffer.from(`<?xml version="1.0"?><p:presentation xmlns:p="${P}"/>`) },
      { name: 'ppt/theme/theme1.xml', data: Buffer.from(`<a:theme xmlns:a="${A}"><a:themeElements><a:majorFont><a:latin typeface="NoSuchThemeFontZZZ"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="+mn-lt"/></a:minorFont></a:themeElements></a:theme>`) },
      { name: 'ppt/slideLayouts/slideLayout1.xml', data: Buffer.from(`<p:sldLayout xmlns:a="${A}"><a:latin typeface="NoSuchLayoutFontZZZ"/></p:sldLayout>`) },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(`<p:sld xmlns:a="${A}"><a:latin typeface="+mj-lt"/><a:latin typeface="NoSuchSlideFontZZZ"/></p:sld>`) }
    ]));
    fs.writeFileSync(xlsPath, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTp) },
      { name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0"?><workbook xmlns="${X}"/>`) },
      { name: 'xl/styles.xml', data: Buffer.from(`<styleSheet xmlns="${X}"><fonts count="1"><font><name val="NoSuchSheetFontZZZ"/><charset val="134"/></font></fonts></styleSheet>`) },
      { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst xmlns="${X}"><si><r><rPr><rFont val="NoSuchRunFontZZZ"/></rPr><t>x</t></r></si></sst>`) }
    ]));
    fs.writeFileSync(emptyPath, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTp) },
      { name: 'ppt/presentation.xml', data: Buffer.from(`<?xml version="1.0"?><p:presentation xmlns:p="${P}"><p:sldMasterIdLst/></p:presentation>`) }
    ]));
    const fams = (f) => {
      const p = spawnSync(process.execPath, [__filename, 'inspect', f], { encoding: 'utf8' });
      let j = null; try { j = JSON.parse(p.stdout); } catch { return { err: kidErr(p.stdout) === '(子进程无 stderr)' ? kidErr(p.stderr) : kidErr(p.stdout) }; }
      if (!j || j.ok !== true) return { err: `${j ? j.code : 'no-json'} ${String(j && j.error).slice(0, 120)}` };
      return { got: j.declaredFontFamilies || [] };
    };
    const bad = [];
    for (const [label, file, want] of [['pptx', pptxPath, ['NoSuchThemeFontZZZ', 'NoSuchLayoutFontZZZ', 'NoSuchSlideFontZZZ']], ['xlsx', xlsPath, ['NoSuchSheetFontZZZ', 'NoSuchRunFontZZZ']]]) {
      const r = fams(file);
      if (r.err) { bad.push(`${label} inspect 失败：${r.err}`); continue; }
      for (const w of want) if (!r.got.includes(w)) bad.push(`${label} 未吃到 ${w}（采集面漏件），实为 ${JSON.stringify(r.got)}`);
      for (const tok of ['+mj-lt', '+mn-lt']) if (r.got.includes(tok)) bad.push(`${label} 把主题令牌 ${tok} 当成了族名`);
      for (const junk of ['charset', 'val', '134']) if (r.got.includes(junk)) bad.push(`${label} 把属性名/属性值当成了族名：${junk}`);
    }
    const e = fams(emptyPath);
    if (e.err) bad.push(`空白对照 inspect 失败：${e.err}`);
    else if (e.got.length) bad.push(`空白对照（只有 presentation.xml）应读到 0 族，实为 ${JSON.stringify(e.got)}`);
    return bad.length ? bad.join(' | ') : true;
  });

  t('scrub 的容器分流：ODF 走清理、认不出一族才报 unsupported-format、真没得可人才报"没有可清"', () => {
    // 三条方向各钉一次（v1.2.0 那条"把不支持说成没东西可清"的病不能因为 R3-a 加了 ODF 就失守）：
    //  ① 有目标字段的 ODF ⇒ 必须**成功**并清掉（旧行为是拒绝，本轮翻案，所以这条断言方向反过来）
    //  ② 两族标志部件都没有的裸 ZIP ⇒ unsupported-format，不许落到"没有可清"
    //  ③ ODF 但 meta.xml 确实没有目标字段、也没有缩略图 ⇒ invalid-output 说"没东西可清"——这一次它是真话
    const mkOdt = (file, metaXml) => { fs.writeFileSync(file, zipWrite([
      { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text', 'utf8'), method: 0 },
      { name: 'content.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><office:document-content><text:p>分流夹具正文串</text:p></office:document-content>', 'utf8') },
      { name: 'meta.xml', data: Buffer.from(metaXml, 'utf8') },
      { name: 'META-INF/manifest.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>', 'utf8') },
    ])); };
    const META_DIRTY = '<?xml version="1.0" encoding="UTF-8"?><office:document-meta><office:meta><meta:initial-creator>作者名不该被清</meta:initial-creator><meta:generator>UnitTest/1.0</meta:generator><meta:editing-duration>PT10S</meta:editing-duration></office:meta></office:document-meta>';
    const META_NOTHING = '<?xml version="1.0" encoding="UTF-8"?><office:document-meta><office:meta><meta:document-statistic meta:word-count="3"/></office:meta></office:document-meta>';
    const bad = [];
    const odtDirty = `${S}/hygiene.odt`, odtNothing = `${S}/hygiene-nothing.odt`, bareZip = `${S}/hygiene-bare.zip`;
    fs.writeFileSync(bareZip, zipWrite([{ name: 'readme.txt', data: Buffer.from('裸 ZIP：两族标志部件都没有') }]));
    mkOdt(odtDirty, META_DIRTY);
    const p1 = spawnSync(process.execPath, [__filename, 'scrub', odtDirty, `${S}/hygiene-scrubbed.odt`], { encoding: 'utf8' });
    let j1 = null; try { j1 = JSON.parse(p1.stdout); } catch {}
    if (!j1 || j1.ok !== true) bad.push('带目标字段的 ODF 竟然没清成功（R3-a 之后 ODF 是支持的一条路）：' + JSON.stringify(j1 && { code: j1.code, error: String(j1.error).slice(0, 90) }));
    else {
      const om = zipRead(fs.readFileSync(`${S}/hygiene-scrubbed.odt`));
      const meta = str(om.get('meta.xml') || Buffer.from(''));
      for (const f of ['meta:initial-creator', 'meta:generator', 'meta:editing-duration']) if (new RegExp('<' + f + '(?:\\s[^>]*)?>[^<]').test(meta)) bad.push(f + ' 没被清掉');
      if (j1.container !== 'odt') bad.push('容器没自报 odt：' + j1.container);
      if (!j1.removedFields || !j1.removedFields.length) bad.push('removedFields 空着却报成功（自证过度）');
      const rb = zipList(fs.readFileSync(`${S}/hygiene-scrubbed.odt`));
      if (rb[0].name !== 'mimetype' || rb[0].method !== 0) bad.push('合成 ODF 回写后首条目应为 stored 的 mimetype，实为 ' + JSON.stringify(rb[0]));
    }
    const bp = spawnSync(process.execPath, [__filename, 'scrub', bareZip, `${S}/bare-scrubbed.zip`], { encoding: 'utf8' });
    let bj = null; try { bj = JSON.parse(bp.stdout); } catch {}
    if (!bj || bj.ok !== false || bj.code !== 'unsupported-format') bad.push('裸 ZIP 应回 unsupported-format（认不出族＝不支持），实为 ' + JSON.stringify(bj && { code: bj.code, error: String(bj.error).slice(0, 80) }));
    else if (/没有可清/.test(String(bj.error))) bad.push('又在把"不支持"报成"没东西可清"（v1.2.0 那个方向错误复发）：' + String(bj.error).slice(0, 90));
    if (fs.existsSync(`${S}/bare-scrubbed.zip`)) bad.push('前置拒绝却落了产物');
    mkOdt(odtNothing, META_NOTHING);
    const pn = spawnSync(process.execPath, [__filename, 'scrub', odtNothing, `${S}/hygiene-nothing-out.odt`], { encoding: 'utf8' });
    let nj = null; try { nj = JSON.parse(pn.stdout); } catch {}
    if (!nj || nj.ok !== false || nj.code !== 'invalid-output' || !/没有可清/.test(String(nj.error))) bad.push('真没得可清时应回 invalid-output＋"没有可清"，实为 ' + JSON.stringify(nj && { code: nj.code, error: String(nj.error).slice(0, 90) }));
    else if (!/meta\.xml/.test(String(nj.error) + String(nj.next))) bad.push('"没东西可清"的文案没点明是 ODF 的 meta.xml：' + String(nj.error).slice(0, 90));
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });
  // ---- R3-a（任务书 P1-3）：zipWrite 的 per-entry method + scrub 的 ODF 面。
  //      🔴 《方案》写"把 mimetype 写成 deflate ⇒ 引擎必须拒"——本机实测**不拒**（kit 0.1.5 自带 LO：同一个真件 ODT 按
  //      stored 与全 deflate 两种回写，转出 PDF 都是 23,321 B、missingFonts 都是同一族，见迭代日志取证）。
  //      所以这一族的判据钉的是**规范形状**（mimetype 必须首位 + stored），不是引擎报错；差异如实记在回报第③段。
  // WP-A（v1.6.7）：ODF 夹具**自产**——用装置自己的 zipWrite 造最小合法 ODT（mimetype 首位且 stored，恰是被测语义），
  // 落 _tmp（gitignore、每跑自清、S 目录进程内唯一），**不再依赖 gitignore 的 _probe/cn.odt**——外人装好 kit 的克隆
  // 里这两条判据照样真跑（"本机没有 _probe/cn.odt 就 SKIP"的出口已删，见下两条判据）。
  const odtFixturePath = once('mk-odt', () => {
    const p = `${S}/odt-fixture-${stamp()}.odt`;
    // 🔴 v1.7.2：`once` 是惰性的——这个写入点可能在套件收尾删掉 `S` 之后才被首次访问（kit 缺失态下尤其容易撞上，
    // 因为多数吃 kit 的判据被洗成 SKIP、首次访问被推到很后面）。旧版此时抛 ENOENT，被顶层兜成
    // "装置内部异常"的 die 信封，**整轮 selftest 的 JSON 被顶掉**，覆盖率闸于是只看到 `failed=undefined`，
    // 把"子进程崩了"报成像是判据集合不对。写入前自建父目录，让这条异步尾巴无论何时被要都能成立。
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const MIN_MANIFEST = '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>';
    const MIN_CONTENT = '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text><text:p>ZC-ODF 自产夹具正文行（WP-A）</text:p><text:p>第二行 STANDALONE-FIXTURE-TAIL</text:p></office:text></office:body></office:document-content>';
    const MIN_STYLES = '<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>';
    const MIN_META = '<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2"><office:meta><dc:creator>ZC 自产夹具作者串</dc:creator><dc:title>ZC 自产夹具标题</dc:title></office:meta></office:document-meta>';
    fs.writeFileSync(p, zipWrite([
      { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text'), method: 0 },
      { name: 'META-INF/manifest.xml', data: Buffer.from(MIN_MANIFEST), method: 8 },
      { name: 'content.xml', data: Buffer.from(MIN_CONTENT), method: 8 },
      { name: 'styles.xml', data: Buffer.from(MIN_STYLES), method: 8 },
      { name: 'meta.xml', data: Buffer.from(MIN_META), method: 8 },
    ]));
    return p;
  });

  t('zipWrite 逐条目 method 与顺序：点名 stored 就真 stored、点名非法 method 必须抛，ODF 回写必须 mimetype 首位 stored', () => {
    const bad = [];
    const names = ['mimetype', 'a.xml', 'b.xml'];
    const z = zipWrite([{ name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text', 'utf8'), method: 0 }, { name: 'a.xml', data: Buffer.from('<a/>') }, { name: 'b.xml', data: Buffer.from('<b/>') }]);
    const rows = zipList(z);
    if (rows.map((r) => r.name).join(',') !== names.join(',')) bad.push('条目顺序被打乱：' + rows.map((r) => r.name).join(','));
    if (rows[0].method !== 0) bad.push('点名 method 0 却写成 ' + rows[0].method + '（per-entry method 没生效）');
    if (rows[1].method !== 8) bad.push('未点名 method 的条目应默认 deflate，实为 ' + rows[1].method);
    if (rows[0].compBytes !== rows[0].bytes) bad.push('stored 条目的压缩前后字节应当相等');
    // 回读必须仍逐条 CRC 对得上（stored 那条是"能读回"最容易出错的一路）
    let back = null; try { back = zipRead(z); } catch (e) { bad.push('stored+deflate 混写的包回读失败：' + e.message); }
    if (back && str(back.get('mimetype')) !== 'application/vnd.oasis.opendocument.text') bad.push('stored 条目回读内容不一致');
    // 非法 method 必须抛（静默按 deflate 写就是把调用方的点名吃掉）
    let threw = '';
    try { zipWrite([{ name: 'x', data: Buffer.from('x'), method: 9 }]); } catch (e) { threw = e.message; }
    if (!/只支持 method 0/.test(threw)) bad.push('method 9 没被拒（抛出的不是那条错：' + JSON.stringify(threw.slice(0, 60)) + '）');
    // 真件回环（WP-A v1.6.7）：夹具**自产**（mkOdt，zipWrite 造的 ODF 最小包），旧版"本机没有 _probe/cn.odt 就 SKIP"的出口已删——
    // 断言强度不变：重打包后 mimetype 仍首位且 stored、stored 条目数不因回写而变。
    const odtReal = odtFixturePath;
    const src = fs.readFileSync(odtReal);
    const methOf = {}; for (const r of zipList(src)) methOf[r.name] = r.method;
    const rebuilt = zipWrite([...zipRead(src).entries()].map(([name, data]) => ({ name, data, method: methOf[name] === 0 ? 0 : 8 })));
    const rb = zipList(rebuilt);
    if (rb[0].name !== 'mimetype' || rb[0].method !== 0) bad.push(`回写后的真件：首条目=${rb[0].name} method=${rb[0].method}（应为 mimetype + 0=stored）`);
    if (rb.filter((r) => r.method === 0).length !== Object.values(methOf).filter((m) => m === 0).length) bad.push('stored 条目数在回写中变了（Configurations2/ 这类目录条目被悄悄 deflate）');
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('scrub 的 ODF 面：meta.xml 九个目标字段全清、Thumbnails 条目删除、产物可开且四件套与原件一致', () => {
    // v1.7.1：真件夹具**入仓**（`test/fixtures/cn.odt`）。v3.0.1 开源化轮（2026-10-15 机主令）：
    // 夹具元数据已 scrub 清洗重生成（initial-creator/dc:title/generator 三字段清零，7,263 B／sha256 50b9d13d4b1b…759d）——
    // 原版 10,480 B／9646288d38ae…c673 带着装置自产样本的 creator/title 值，公开仓按总览第八节"仓外/入仓取证件"那条换成零残留版。
    // 判据逻辑不变：对**清洗后的夹具**跑 scrub 回环，期望"非空目标字段数=0 的反向闸"由 ①那层正向清零覆盖；
    // ④的 indepNonBlank 在清洗后夹具上为 0 ⇒ 判据按"夹具状态变了"红——这是**预期形状**：夹具本就应零元数据，
    // 若将来有人往夹具里塞回元数据，这条当场红。
    const odtReal = ROOT + '/test/fixtures/cn.odt';
    if (!fs.existsSync(odtReal)) return 'skip（真件夹具 ' + odtReal + ' 不在位——它已入仓，缺件只可能是部分检出或该文件被改；这条靠真件取证，不拿合成包冒充通过）';
    const bad = [];
    // 🔴 期望字段清单**故意在判据里另写一遍**（与 scrub 的删除清单同源不同用）：
    //    统一成引用的话，"从共享清单里删一项"这种漏字段就永远红不了——M39 专打这一层。
    const EXPECT = ['meta:initial-creator', 'dc:creator', 'dc:title', 'dc:subject', 'dc:description', 'meta:generator', 'meta:editing-duration', 'dc:date', 'meta:keyword'];
    const srcSha0 = sha256(fs.readFileSync(odtReal));
    // 公开树版（v3.0.1 开源化轮）：夹具已零元数据 ⇒ scrub 正确地拒（"没有可清"）。
    // 判据改为**自产正向样本**：把夹具复制成临时件、注入已知元数据（M39 同源的另写一遍字段），再对它跑 scrub 回环——
    // 这样"九字段全清＋缩略图删除＋mimetype 形状＋四件套"全部有对象可测，且不依赖夹具带个人数据。
    const odtSeed = `${S}/r3a-seed.odt`;
    fs.copyFileSync(odtReal, odtSeed);
    {
      const zip = zipRead(fs.readFileSync(odtSeed));
      const meta0 = str(zip.get('meta.xml') || '');
      const seedValues = ['SEED_INITIAL_CREATOR', 'SEED_CREATOR', 'SEED_TITLE', 'SEED_SUBJECT', 'SEED_DESCRIPTION', 'SEED_GENERATOR', 'PT10S', '2026-01-01T00:00:00Z', 'SEED_KEYWORD'];
      const seedFields = EXPECT.map((f, i) => `<${f}>${seedValues[i]}</${f}>`).join('');
      const seeded = meta0.replace(/<office:meta>/, '<office:meta>' + seedFields);
      const methods = new Map(zipList(fs.readFileSync(odtSeed)).map((r) => [r.name, r.method]));
      const parts = [];
      for (const [name, data] of zip) parts.push({ name, data: name === 'meta.xml' ? Buffer.from(seeded, 'utf8') : data, method: methods.get(name) ?? 8 });
      if (!zip.has('Thumbnails/thumbnail.png')) parts.push({ name: 'Thumbnails/thumbnail.png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), method: 8 });
      fs.writeFileSync(odtSeed, zipWrite(parts));
    }
    const out1 = `${S}/r3a-scrub.odt`;
    const p = spawnSync(process.execPath, [__filename, 'scrub', odtSeed, out1], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    if (!j || j.ok !== true) return '种子件 ODT scrub 失败：' + (j ? j.code + ' ' + String(j.error).slice(0, 140) : String(p.stdout).slice(0, 140));
    if (j.container !== 'odt') bad.push('容器应自报 odt，实为 ' + j.container);
    if (!Array.isArray(j.removedFields) || !j.removedFields.some((f) => /initial-creator/.test(f)) || !j.removedFields.some((f) => /dc:title/.test(f))) bad.push('注入的种子字段没被自报清除：' + JSON.stringify(j.removedFields));
    // ① 产物里目标字段必须**带值的实例一个都不剩**
    const om = zipRead(fs.readFileSync(out1));
    const meta = om.has('meta.xml') ? str(om.get('meta.xml')) : '';
    if (!meta) bad.push('产物里没有 meta.xml（scrub 不该删整个部件，只该清字段）');
    const left = EXPECT.filter((f) => new RegExp('<' + f + '(?:\\s[^>]*)?>[^<]', '').test(meta));
    if (left.length) bad.push('meta.xml 里仍留有值的目标字段：' + left.join(','));
    // ② 缩略图条目必须不存在，且删了什么要自报
    //    种子件显式加入一张 PNG，确保删除行为与 removedEntries 自报都能实测。
    if (om.has('Thumbnails/thumbnail.png')) bad.push('产物里还有 Thumbnails/thumbnail.png（缩略图＝第一页的渲染图，属版面内容出域）');
    if (!Array.isArray(j.removedEntries) || !j.removedEntries.includes('Thumbnails/thumbnail.png')) bad.push('删掉的缩略图没自报进 removedEntries：' + JSON.stringify(j.removedEntries));
    // ③ 规范形状
    if (!j.shape || j.shape.firstEntry !== 'mimetype' || j.shape.firstMethod !== 'stored') bad.push('产物的 mimetype 形状不是"首位+stored"：' + JSON.stringify(j.shape));
    // ④ 探针条数 = 独立再数一遍的源里非空目标字段数（两条路必须对上，防自证过度）
    //    公开树版（v3.0.1 开源化轮）：夹具已零元数据 ⇒ indepNonBlank=0 是**预期值**，
    //    scrub 在零元数据件上应报"没有可清"或空探针——判据按清洗后夹具的现实重锚：
    //    探针条数仍必须等于独立数（对账逻辑不变），但"必须非 0"的反向闸改为正向闸：
    //    夹具若被人塞回元数据，由 scrub 的 removedFields 自报出来，不靠这条拦。
    // ④ 探针条数 = 种子件里非空目标字段数（九字段都注入，与 scrub 自报的 probeFields 对账）
    const srcMap = zipRead(fs.readFileSync(odtSeed));
    const srcMeta = str(srcMap.get('meta.xml'));
    const indepNonBlank = EXPECT.filter((f) => new RegExp('<' + f + '(?:\\s[^>]*)?>([^<]*[^<\\s])</' + f + '>').test(srcMeta)).length;
    if (indepNonBlank !== EXPECT.length) bad.push(`种子件注入失败：独立数到的非空目标字段为 ${indepNonBlank}（应为 ${EXPECT.length}）`);
    if (!Array.isArray(j.probeFields) || j.probeFields.length !== indepNonBlank) bad.push(`探针条数=${(j.probeFields || []).length}，独立数一遍是 ${indepNonBlank}（对不上就是有一边漏了）`);
    // ⑤ 产物可被引擎打开；**四件套**与未清原件一致（不许拿 sha256 当"没变化"，见第四节第 14 条）
    const quad = (file) => {
      const pdf = freePath(TMP_DIR, `r3a-${path.basename(file, path.extname(file))}`, 'pdf');
      const r = runKit(['convert', '--input', file, '--output', pdf, '--timeout-ms', '120000']);
      if (!r.ok) return { err: r.code + ' ' + String(r.error).slice(0, 120) };
      const bytes = fs.statSync(pdf).size;
      const dir = freeDir(TMP_DIR, `r3aq-${path.basename(file, path.extname(file))}`);
      const rr = runKit(['render', '--input', pdf, '--output-dir', dir, '--timeout-ms', '120000']);
      const ratios = rr.ok ? (rr.images || []).map((t) => pngDarkRatio(t.path)?.ratio ?? null) : ['render 失败'];
      const lat = fs.readFileSync(pdf).toString('latin1');
      const fonts = [...new Set([...lat.matchAll(/BaseFont\s*\/([A-Za-z0-9+\-,.]+)/g)].map((m) => m[1]))].sort();
      try { fs.rmSync(pdf, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return { bytes, pageCount: rr.ok ? rr.pageCount : 'render 失败', ratios, fonts };
    };
    const q0 = quad(out1), q1 = quad(odtSeed);
    if (q0.err) bad.push('清过的 ODT 引擎打不开（改包改坏了）：' + q0.err);
    if (q1.err) bad.push('种子件引擎打不开（改包改坏了）：' + q1.err);
    if (!q0.err && !q1.err) {
      if (q0.pageCount !== q1.pageCount) bad.push(`页数漂了：清过 ${q0.pageCount} vs 原件 ${q1.pageCount}`);
      if (JSON.stringify(q0.ratios) !== JSON.stringify(q1.ratios)) bad.push('逐页非白像素占比不一致（清理动了版面）：' + JSON.stringify(q0.ratios) + ' vs ' + JSON.stringify(q1.ratios));
      if (JSON.stringify(q0.fonts) !== JSON.stringify(q1.fonts)) bad.push('嵌入字体集合不一致：' + JSON.stringify(q0.fonts) + ' vs ' + JSON.stringify(q1.fonts));
      // 🔴 《方案》写的"scrub → to pdf 四件套与未清原件一致"里，**字节数那一件本机实测不成立**：清掉的就是要进 PDF 元数据包的串。
      //    真件 _probe/cn.odt 实测：清后产物转出的 PDF 22,729 B，原件 23,321 B（差 592 B）。所以这一族只对**版面三件**设门；
      //    "清理真起作用"由两条直接证据守着：① 产物 meta.xml 里目标字段实例清零，⑥ --verify 在 PDF 明文字节里回查零残留。
      if (typeof q0.bytes !== 'number' || typeof q1.bytes !== 'number') bad.push('字节数没报成数字，差额无从自曝');
    }
    // ⑥ --verify 零残留，且回查条数与探针条数同源
    const out2 = `${S}/r3a-scrub-v.odt`;
    const p2 = spawnSync(process.execPath, [__filename, 'scrub', odtSeed, out2, '--verify'], { encoding: 'utf8' });
    let j2 = null; try { j2 = JSON.parse(p2.stdout); } catch {}
    if (!j2 || j2.ok !== true) bad.push('--verify 这次跑失败：' + JSON.stringify(j2 && { code: j2.code, error: String(j2.error).slice(0, 100) }));
    else if (j2.verify?.converted !== true || j2.verify.residual !== 0 || j2.verify.checkedStrings !== indepNonBlank) bad.push('--verify 口径不对：' + JSON.stringify(j2.verify));
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  }, {needs:'kit'});
  // ---- 环境
  // R2-2①（v1.6.3）：doctor 走 die 分支时（如 kit 缺失）输出没有 checks 字段——旧版 j.checks.filter 直接抛异常，
  // 45 条 FAIL 里混进一条"红不带因"（kit 缺失实测 threw reading 'filter'）。现在：非 JSON / 无 checks 都红得带因。
  t('env doctor 全绿', () => {
    const r = spawnSync(process.execPath, [__filename, 'doctor'], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(r.stdout); } catch { return 'doctor 输出不是 JSON：' + String(r.stdout || r.stderr || '(空)').replace(/\s+/g, ' ').slice(0, 140); }
    // v1.7.0 加的一段：语言包哨兵的**形状**（本判据本来就带 needs:'kit'——doctor 在没有 node_modules 的树上
    // 会整只崩在引擎扫描那行，红因是 ENOENT 而不是 FAIL 明细）。断的是字段之间的关系，不是"本机装了包"：
    // 把 DOCKIT_TESSDATA 指到一个空目录，`ocr-lang-pack` 必须出现且为 WARN，
    // 且 doctor 的 ok 不许因为它变 false——装没装中文包是机器事实，做成红就打穿「外人克隆首跑全绿」。
    const emptyDir = path.join(TMP_DIR, 'no-lang-' + stamp());
    fs.mkdirSync(emptyDir, { recursive: true });
    const rd = spawnSync(process.execPath, [__filename, 'doctor'], { encoding: 'utf8', env: Object.assign({}, process.env, { DOCKIT_TESSDATA: emptyDir }) });
    let jd = null; try { jd = JSON.parse(rd.stdout); } catch {}
    const langBad = [];
    if (!jd) langBad.push('语言包态的 doctor 没出 JSON（红因不许不带因）：' + String(rd.stdout || rd.stderr || '(空)').slice(0, 120));
    else {
      const hit = (jd.checks || []).filter((c) => c.includes(' ocr-lang-pack :: '));
      if (hit.length !== 1) langBad.push('doctor 里 ocr-lang-pack 应当恰好一条，实为 ' + hit.length + ' 条');
      else if (!hit[0].startsWith('WARN ')) langBad.push('缺包态必须是 WARN（不许 FAIL、不许静默），实为：' + hit[0].slice(0, 90));
      else if (hit[0].includes(emptyDir) || hit[0].includes(path.basename(emptyDir))) langBad.push('WARN 行回显了本机 tessdata 路径或目录名：' + hit[0].slice(0, 140));
      if (jd.ok !== true) langBad.push('语言包缺失把 doctor 整轮判红了（WARN 不使整轮红这条口径被打穿）：failed=' + jd.failed);
    }
    fs.rmSync(emptyDir, { recursive: true, force: true });
    if (j.ok && !langBad.length) return true;
    if (langBad.length) return langBad.slice(0, 4).join(' | ');
    const rows = Array.isArray(j.checks) ? j.checks.filter((c) => c.startsWith('FAIL')) : null;
    return rows && rows.length ? 'FAIL: ' + rows.join(' ; ')
      : 'doctor 报失败但没有 FAIL 明细（checks 字段缺失＝走了 die 分支）：' + String(j.error || JSON.stringify(j)).slice(0, 140);
  }, {needs:'kit'});

  // v1.7.1：裸树自证——**不需要真的把 node_modules 删掉**就能测到"引擎整棵缺失"那一态。
  // 把本文件复制进一个空目录（ROOT 由 __filename 推出，所以那份副本天然没有 node_modules），
  // 在那儿跑 doctor。修前的形状：顶层兜异常、只回一句"装置内部异常"，`checks` 字段整个不见；
  // 修后的形状：ok=false + 逐条 FAIL，engine-package 那条点名读取失败与恢复口径。
  t('env doctor 在裸树（无 node_modules）里必须发得出逐条 FAIL 明细，不许用"装置内部异常"顶掉诊断', () => {
    const bare = path.join(TMP_DIR, `bare-tree-${stamp()}`);
    fs.mkdirSync(bare, { recursive: true });
    fs.copyFileSync(__filename, path.join(bare, 'dockit.js'));
    const pb = spawnSync(process.execPath, [path.join(bare, 'dockit.js'), 'doctor'], { encoding: 'utf8', cwd: bare, timeout: 180000 });
    let jb = null; try { jb = JSON.parse(pb.stdout); } catch {}
    const bad = [];
    if (!jb) bad.push('裸树 doctor 没出 JSON（红因不许不带因）：' + String(pb.stdout || pb.stderr || '(空)').replace(/\s+/g, ' ').slice(0, 140));
    else if (jb.ok === true) bad.push('裸树 doctor 宣称环境通过（引擎与 kit 都不在位）——它读的是副本自己的 ROOT，不可能在位');
    else if (!Array.isArray(jb.checks)) bad.push('裸树 doctor 走了 die 分支、没有 checks 数组（诊断被"装置内部异常"整只顶掉）：' + String(jb.error || '').slice(0, 130));
    else {
      const fr = jb.checks.filter((c) => c.startsWith('FAIL'));
      if (!fr.length) bad.push('ok=false 但一条 FAIL 明细都没有');
      const engRow = fr.find((c) => /^FAIL engine-package\(libreoffice-kit-/.test(c));
      if (!engRow) bad.push('engine-package 那条没有以 FAIL 出现（裸树里它必须红）：' + fr.slice(0, 3).join(' ; ').slice(0, 160));
      else if (!/ENOENT|读 ROOT/.test(engRow)) bad.push('engine-package 的 FAIL 没点名读取失败与原因：' + engRow.slice(0, 160));
      if (fr.some((c) => /ocr-lang-pack/.test(c))) bad.push('语言包哨兵在裸树里升成了 FAIL（它永远只许 WARN）：' + fr.filter((c) => /ocr-lang-pack/.test(c)).join(' ; ').slice(0, 120));
    }
    fs.rmSync(bare, { recursive: true, force: true });
    return bad.length ? bad.slice(0, 4).join(' | ') : true;
  });

  // v1.7.2：替身字体哨兵的覆盖面与降级面。缺陷事实：旧实现只核 7 个固定文件名，而系统字体目录
  // 被直删了 6 个替身件，它只报出 1 个——覆盖面不足；同时清单是**机器特定**数据，不能对别的机器判红。
  // 所以三条各配一手：① 现态结论必须等于"独立实算"（装置说在位就真要在位，缺几个就报几个）；
  // ② 清单不在位 ⇒ WARN 且不回显路径（不许崩、不许冒充 PASS）；③ 清单标定在别的机器 ⇒ WARN（绝不允许 FAIL，
  // 否则就打穿"外人克隆首跑全绿"）。②③都靠 `DOCKIT_FONT_MANIFEST` 覆盖口造态，不动仓内清单一个字节。
  t('substitute-fonts 哨兵按登记清单核全量：现态必须等于独立实算，清单缺失与非标定机器都只 WARN', () => {
    const DOC = (env) => { const p = spawnSync(process.execPath, [__filename, 'doctor'], { encoding: 'utf8', cwd: ROOT, timeout: 180000, env: env ? Object.assign({}, process.env, env) : process.env }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const lineOf = (j) => ((j && j.checks) || []).filter((c) => c.includes('substitute-fonts-present')).join(' || ');
    const bad = [];
    // ① 独立实算：自己读清单、自己数缺件，再和装置的结论对表（不采信它自报的数字）
    const FMP = ROOT + '/test/font-manifest.json';
    let man = null; try { man = JSON.parse(fs.readFileSync(FMP, 'utf8')); } catch (e) { return '清单本体读不到（判据没有清单就没法验覆盖面）：' + String(e.message || e).slice(0, 120); }
    if (!man || !Array.isArray(man.files) || !man.files.length) return '清单里没有 files 条目，本判据结构上红不了（先修清单）';
    const fdir = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'Fonts') : 'C:/Windows/Fonts';
    const missReal = man.files.filter((x) => !fs.existsSync(path.join(fdir, x.name)));
    const d0 = DOC(null);
    if (!d0.j) return '现态 doctor 没出 JSON（红因不许不带因）：' + String(d0.p.stdout || d0.p.stderr || '(空)').replace(/\s+/g, ' ').slice(0, 140);
    const row0 = lineOf(d0.j);
    // 公开树版（v3.0.1 开源化轮）：清单的「标定机器」已泛化为 <MACHINE-A> 占位 ⇒ 本机名永远对不上 ⇒
    // 装置按设计降 WARN（"非标定机器只 WARN 不打穿首跑全绿"是哨兵自己的口径）。占位清单不绑定任何机器：
    // 在位缺件都只 WARN（无字体的 CI runner 必走这支）；在位与哈希的硬断言由下面的合成标定态覆盖。
    // WARN 分支不带"已核 N"字样（那是 PASS 分支的自报形状）。
    const placeholder = man['标定机器'] && /^<.+>$/.test(man['标定机器']);
    if (placeholder) {
      if (!/^WARN /.test(row0)) bad.push(`清单标定机器是占位符（${man['标定机器']}）、本机永远对不上 ⇒ 应降 WARN，实报：${row0.slice(0, 140)}`);
    } else if (missReal.length === 0) {
      if (!/^PASS /.test(row0)) bad.push(`清单说全在位、装置却报非 PASS：${row0.slice(0, 140)}`);
      if (!row0.includes('已核 ' + man.files.length)) bad.push(`覆盖面自报的"已核条目数"不等于清单件数 ${man.files.length}（只核少数几个就是 2026-10-09 那次"丢 6 报 1"的形状）：${row0.slice(0, 200)}`);
    } else {
      if (!/^FAIL /.test(row0)) bad.push(`实算缺 ${missReal.length} 件而装置不判红：${row0.slice(0, 160)}`);
      if (!row0.includes('缺 ' + missReal.length + '/' + man.files.length)) bad.push(`FAIL 行没按实算报缺件数（应含"缺 ${missReal.length}/${man.files.length}"）：${row0.slice(0, 200)}`);
      if (!row0.includes('已核 ' + man.files.length)) bad.push('FAIL 行的"已核条目数"也不许少报：' + row0.slice(0, 200));
    }
    // 合成标定机器态：与占位与否、在位缺件与否无关，独立覆盖在位与哈希的硬断言。
    {
      const calibratedName = 'MUTANT-CALIBRATION';
      const calibratedPath = path.join(S, 'font-manifest-calibrated.json');
      fs.writeFileSync(calibratedPath, JSON.stringify(Object.assign({}, man, { 标定机器: calibratedName })), 'utf8');
      const dc = DOC({ DOCKIT_FONT_MANIFEST: calibratedPath, COMPUTERNAME: calibratedName });
      const rowc = lineOf(dc.j);
      if (!dc.j) bad.push('合成标定机器态的 doctor 没出 JSON：' + String(dc.p.stdout || dc.p.stderr || '(空)').slice(0, 120));
      else {
        const expected = missReal.length ? /^FAIL / : /^PASS /;
        if (!expected.test(rowc)) bad.push(`合成标定机器态应为 ${missReal.length ? 'FAIL' : 'PASS'}，实为：${rowc.slice(0, 140)}`);
        if (!rowc.includes('已核 ' + man.files.length)) bad.push(`合成标定机器态的已核数不等于清单件数 ${man.files.length}：${rowc.slice(0, 180)}`);
        if (missReal.length && !rowc.includes('缺 ' + missReal.length + '/' + man.files.length)) bad.push(`合成标定机器态缺件数不等于独立实算 ${missReal.length}/${man.files.length}：${rowc.slice(0, 180)}`);
      }
    }
    // ② 清单不在位：必须 WARN、不回显解析路径，且不许把整轮 doctor 判红成"崩"
    const d1 = DOC({ DOCKIT_FONT_MANIFEST: path.join(TMP_DIR, 'no-such-font-manifest.json') });
    const row1 = lineOf(d1.j);
    if (!d1.j) bad.push('清单缺失态的 doctor 没出 JSON：' + String(d1.p.stdout || d1.p.stderr || '(空)').slice(0, 120));
    else if (!/^WARN /.test(row1)) bad.push('清单缺失必须是 WARN（既不 FAIL 也不静默 PASS），实为：' + row1.slice(0, 150));
    else if (/no-such-font-manifest\.json|[A-Za-z]:[\\/]/.test(row1)) bad.push('WARN 行回显了本机清单路径：' + row1.slice(0, 150));
    // ③ 非标定机器：造一份"标定在别处"的清单副本，必须 WARN，绝不允许 FAIL
    //    公开树版（v3.0.1 开源化轮）：机器名不进命令输出（运行时出口），WARN 行改为报「非本机」
    //    而不带具体主机名——"机器不对"与"清单不对"由「清单标定于非本机」这个短语区分。
    const fake = path.join(S, 'font-manifest-foreign.json');
    fs.writeFileSync(fake, JSON.stringify(Object.assign({}, man, { 标定机器: 'ZZZ-NOT-THIS-HOST' })), 'utf8');
    const d2 = DOC({ DOCKIT_FONT_MANIFEST: fake });
    const row2 = lineOf(d2.j);
    if (!d2.j) bad.push('非标定机器态的 doctor 没出 JSON：' + String(d2.p.stdout || d2.p.stderr || '(空)').slice(0, 120));
    else if (/^FAIL /.test(row2)) bad.push('🔴 清单标定的机器不是本机却判红了（机器特定数据当普适断言——第八节第 20 条同族）：' + row2.slice(0, 160));
    else if (!/^WARN /.test(row2)) bad.push('非标定机器必须 WARN，实为：' + row2.slice(0, 140));
    else if (!/非本机/.test(row2)) bad.push('WARN 行没自报「非本机」（看不出是"机器不对"还是"清单不对"）：' + row2.slice(0, 160));
    // ④ 同名异容：清单 sha256 被改掉一位 → 必须 FAIL 并点名文件（只核在位不验哈希＝"核全量"是空话；P0-2）。
    //    单一条目合成清单指着必定在位的 arial.ttf，不依赖 146 件在目标机器齐。
    const arial = path.join(fdir, 'arial.ttf');
    if (!fs.existsSync(arial)) bad.push('连 arial.ttf 都不在系统字体目录——本机不适合跑哈希面（Windows 必带件缺失，先修环境）');
    else {
      const poisonPath = path.join(S, 'font-manifest-poison.json');
      fs.writeFileSync(poisonPath, JSON.stringify({ 标定机器: process.env.COMPUTERNAME || '', files: [{ name: 'arial.ttf', sha256: '00' }] }), 'utf8');
      const dp = DOC({ DOCKIT_FONT_MANIFEST: poisonPath });
      const rowp = lineOf(dp.j);
      if (!dp.j) bad.push('同名异容态的 doctor 没出 JSON：' + String(dp.p.stdout || dp.p.stderr || '(空)').slice(0, 120));
      else if (!/^FAIL /.test(rowp)) bad.push('同名异容没判红（只核在位不验哈希）：' + rowp.slice(0, 160));
      else if (!/哈希错/.test(rowp) || !rowp.includes('arial.ttf')) bad.push('同名异容没点名文件（"核全量"须报到件）：' + rowp.slice(0, 160));
    }
    return bad.length ? bad.slice(0, 4).join(' | ') : true;
  });

  t('doctor 输出不回显绝对路径', () => {
    const marker = `doctor-private-path-${stamp()}`;
    const base = path.join(TMP_DIR, marker);
    const r = spawnSync(process.execPath, [__filename, 'doctor'], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        DOCKIT_KIT_CLI: path.join(base, 'kit', 'cli.js'),
        DOCKIT_FONT_MANIFEST: path.join(base, 'font-manifest.json'),
        DOCKIT_TESSERACT: path.join(base, 'tesseract.exe'),
        DOCKIT_TESSDATA: path.join(base, 'tessdata'),
        DOCKIT_OFFICECLI: path.join(base, 'officecli.exe'),
        DOCKIT_POPPLER_BIN: path.join(base, 'poppler'),
        DOCKIT_PANDOC: path.join(base, 'pandoc.exe'),
      }),
      timeout: 180000,
    });
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    if (!j || !Array.isArray(j.checks)) return 'doctor 没有返回带 checks 的 JSON：' + String(r.stdout || r.stderr || '(空)').replace(/\s+/g, ' ').slice(0, 160);
    const text = JSON.stringify(j);
    const absolutePath = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s"'(])\/(?:home|Users|tmp|var|opt|etc|usr|mnt|root)\/)/;
    if (text.includes(marker) || absolutePath.test(text)) return 'doctor 输出包含注入的本机路径或其它绝对路径';
    return true;
  });

  t('安装器与基线台输出不回显绝对路径（粘贴到公开 issue 不泄用户名）', () => {
    // 与 doctor 那条同尺：注入 marker 路径，看四处输出里有没有绝对路径形状；占位符（%USERPROFILE% 等）允许。
    const marker = `installer-private-path-${stamp()}`;
    const home = path.join(TMP_DIR, marker, 'home');
    fs.mkdirSync(path.join(home, '.codex', 'skills'), { recursive: true });
    const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home });
    const RUN = (script, args) => { const p = spawnSync(process.execPath, [ROOT + script, ...args], { encoding: 'utf8', cwd: ROOT, env, timeout: 60000 }); return String(p.stdout || '') + '\n' + String(p.stderr || ''); };
    const outs = [
      RUN('/install-skill.js', ['--list']),
      RUN('/setup.js', ['--list']),
      RUN('/test/char-baseline.js', ['check']),
      RUN('/install-system-deps.js', ['--list']),
    ];
    const text = outs.join('\n');
    const absolutePath = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s"'(])\/(?:home|Users|tmp|var|opt|etc|usr|mnt|root)\/)/;
    if (text.includes(marker) || absolutePath.test(text)) return '安装器/基线输出包含注入的本机路径或其它绝对路径';
    if (!text.includes('%USERPROFILE%') && !text.includes('<REPO>')) return '占位符丢了（输出里既无绝对路径也无占位，疑似输出被掏空）';
    return true;
  });

  t('install-fonts --check 对缺件和哈希错误返回失败，--list 保持探测成功', () => {
    const base = path.join(S, 'install-fonts-check');
    const systemRoot = path.join(base, 'system');
    const fonts = path.join(systemRoot, 'Fonts');
    fs.mkdirSync(fonts, { recursive: true });
    const source = Buffer.from('font-check-fixture');
    const manifestPath = path.join(base, 'font-manifest.json');
    const manifest = { files: [{ name: 'probe.ttf', bytes: source.length, sha256: crypto.createHash('sha256').update(source).digest('hex') }] };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const run = (args) => {
      const script = path.join(ROOT, 'install-fonts.js');
      const loader = [
        `process.env.SystemRoot = ${JSON.stringify(systemRoot)};`,
        `process.env.DOCKIT_FONT_MANIFEST = ${JSON.stringify(manifestPath)};`,
        "process.env.DOCKIT_FONT_SOURCE = '';",
        `process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(args)}];`,
        `require(${JSON.stringify(script)});`,
      ].join('\n');
      const p = spawnSync(process.execPath, ['-e', loader], {
        encoding: 'utf8',
        timeout: 30000,
      });
      let j = null; try { j = JSON.parse(p.stdout); } catch {}
      return { exit: p.status, j, output: p.stdout || p.stderr || '' };
    };
    const missing = run(['--check']);
    const list = run(['--list']);
    fs.writeFileSync(path.join(fonts, 'probe.ttf'), Buffer.from('different-font-content'));
    const mismatch = run(['--check']);
    if (!missing.j || missing.j.ok !== false || missing.exit !== 1 || missing.j.missing !== 1) return `缺件态未失败：${missing.output.slice(0, 220)}`;
    if (!list.j || list.j.ok !== true || list.exit !== 0 || list.j.missing !== 1) return `--list 探测态行为改变：${list.output.slice(0, 220)}`;
    if (!mismatch.j || mismatch.j.ok !== false || mismatch.exit !== 1 || mismatch.j.hashMismatch !== 1) return `哈希错误态未失败：${mismatch.output.slice(0, 220)}`;
    return true;
  });

  // ---- 合成正向：缺字族必须自曝。昂贵前置全部惰性（once 记忆），--only 选跑时不起没必要的引擎
  const cnPdf = () => once('c:cn.pdf', () => runKit(['convert', '--input', cnPath, '--output', `${S}/cn.pdf`, '--timeout-ms', '60000']));
  const cnTxt = () => once('c:cn.txt', () => runKit(['convert', '--input', cnPath, '--output', `${S}/cn.txt`, '--timeout-ms', '60000']));
  const cnRender = () => once('r:cn', () => runKit(['render', '--input', cnPath, '--output-dir', `${S}/rcn`, '--pages', '1', '--timeout-ms', '60000']));
  const blankRender = () => once('r:blank', () => runKit(['render', '--input', blankPath, '--output-dir', `${S}/rblank`, '--pages', '1', '--timeout-ms', '60000']));
  const pdfRender = () => once('r:pdf', () => { cnPdf(); return runKit(['render', '--input', `${S}/cn.pdf`, '--output-dir', `${S}/rpdf`, '--timeout-ms', '60000']); });
  const dk = (f) => pngDarkRatio(f)?.dark ?? -1;
  t('syn-font-positive 故意声明的族被 missingFonts 报出', () => { const a = cnPdf(); return a.ok && a.missingFonts?.includes(BOGUS) ? true : `json=${JSON.stringify(a)}`; }, {needs:'kit'});
  t('syn-content 转 txt 后已知中文串逐字在位', () => { const at = cnTxt(); return at.ok && str(fs.readFileSync(`${S}/cn.txt`)).includes(CN); }, {needs:'kit'});
  t('syn-content-no-replacement 转出的文本无替换符', () => { cnTxt(); return !str(fs.readFileSync(`${S}/cn.txt`)).includes('\ufffd'); }, {needs:'kit'});
  // ---- 合成反向：PDF 再渲染必不报缺字（口径：missingFonts 只对源文档声明有意义）
  t('syn-font-negative PDF 侧 missingFonts 为空（反向用例）', () => { const ap = pdfRender(); return ap.ok && Array.isArray(ap.missingFonts) && ap.missingFonts.length === 0; }, {needs:'kit'});
  t('syn-pdf-pagecount 渲染给回页数=1', () => pdfRender().pageCount === 1, {needs:'kit'});
  // ---- 像素证据 + 空白对照（判据自己会红）
  t('pix 有字页非白像素 > 0', () => { const ag = cnRender(); return ag.ok && dk(`${S}/rcn/page-0001.png`) > 0; }, {needs:'kit'});
  t('pix 空白对照页非白像素 = 0（这条红了说明像素判据本身坏了）', () => { const ab = blankRender(); return ab.ok && dk(`${S}/rblank/page-0001.png`) === 0; }, {needs:'kit'});
  // ---- 不覆盖 / 原地写 / 目录形状
  t('guard 同一输出再跑必须失败（不覆盖）', () => { cnPdf(); const r = runKit(['convert', '--input', cnPath, '--output', `${S}/cn.pdf`, '--timeout-ms', '60000']); return r.ok === false && /EEXIST/.test(r.error || ''); }, {needs:'kit'});
  t('guard 输入=输出被拒', () => { const r = runKit(['convert', '--input', cnPath, '--output', cnPath, '--timeout-ms', '60000']); return r.ok === false && /must differ/.test(r.error || ''); }, {needs:'kit'});
  t('guard 输出目录父级不存在时报 ENOENT（装置负责建父级）', () => { const r = runKit(['render', '--input', cnPath, '--output-dir', `${S}/no-parent/deep`, '--pages', '1', '--timeout-ms', '60000']); return r.ok === false && /ENOENT/.test(r.error || ''); }, {needs:'kit'});
  t('freePath 去重：已存在 x.pdf 时依次选到 x-2.pdf / x-3.pdf（绝不覆盖）', () => { const d = ensureDir(`${S}/free`); fs.writeFileSync(`${d}/x.pdf`, '1'); const p1 = freePath(d, 'x', 'pdf'); fs.writeFileSync(p1, '2'); const p2 = freePath(d, 'x', 'pdf'); return p1.endsWith('x-2.pdf') && p2.endsWith('x-3.pdf') ? true : `p1=${p1} p2=${p2}`; });
  t('装置 to 默认输出落 _out 不碰原件', () => { const before = sha256(fs.readFileSync(cnPath)); const r = spawnSync(process.execPath, [__filename, 'to', cnPath], { encoding: 'utf8' }); return JSON.parse(r.stdout).ok === true && sha256(fs.readFileSync(cnPath)) === before; }, {needs:'kit'});
  // ---- 失败码族逐个有对应处置文案
  t('code 伪装件 → invalid-document', () => { fs.writeFileSync(`${S}/fake.docx`, '纯文本改后缀'); const r = runKit(['convert', '--input', `${S}/fake.docx`, '--output', `${S}/fake.pdf`, '--timeout-ms', '60000']); return r.code === 'invalid-document'; }, {needs:'kit'});
  t('code 族外转换 → unsupported-format', () => { const r = runKit(['convert', '--input', cnPath, '--output', `${S}/o.doc`, '--timeout-ms', '60000']); return r.code === 'unsupported-format'; }, {needs:'kit'});
  t('code 输入超限 → input-too-large', () => { const r = runKit(['convert', '--input', cnPath, '--output', `${S}/lim.pdf`, '--max-input-bytes', '10', '--timeout-ms', '60000']); return r.code === 'input-too-large'; }, {needs:'kit'});
  t('code 输出超限 → output-too-large', () => { const r = runKit(['convert', '--input', cnPath, '--output', `${S}/tiny.pdf`, '--max-output-bytes', '10', '--timeout-ms', '60000']); return r.code === 'output-too-large'; }, {needs:'kit'});
  t('code 超时 → timeout', () => { const r = runKit(['convert', '--input', cnPath, '--output', `${S}/slow.pdf`, '--timeout-ms', '1']); return r.code === 'timeout'; }, {needs:'kit'});
  t('code 页码越界被拒且文案带真实页数', () => { const r = runKit(['render', '--input', cnPath, '--output-dir', `${S}/over`, '--pages', '999', '--timeout-ms', '60000']); return r.ok === false && /1-page/.test(r.error || ''); }, {needs:'kit'});
  t('code pages 区间写法被拒（只认 all 或逗号列表）', () => { const r = runKit(['render', '--input', cnPath, '--output-dir', `${S}/rng`, '--pages', '1-2', '--timeout-ms', '60000']); return r.ok === false && /comma-separated/.test(r.error || ''); }, {needs:'kit'});
  t('code 对 docx 用 --range 被拒', () => { const r = runKit(['render', '--input', cnPath, '--output-dir', `${S}/badrg`, '--range', 'A1:B2', '--timeout-ms', '60000']); return r.ok === false && /worksheets/.test(r.error || ''); }, {needs:'kit'});
  t('code 缺输入文件 → ENOENT 原样透出', () => { const r = runKit(['convert', '--input', `${S}/nope.docx`, '--output', `${S}/nope.pdf`, '--timeout-ms', '60000']); return r.ok === false && /ENOENT/.test(r.error || ''); }, {needs:'kit'});
  t('codes 八种码族在装置里有处置文案', () => KIT_ERROR_CODES.every((c) => nextFor(c, { input: 'i', output: 'o', fam: 'word', inExt: 'docx' }).length > 5));
  // ---- v1.8.0：非对齐 OLE 的副本对齐修复（机主 2026-10-10 批准）。三条边界各配独立攻击面：
  //      修复成功（to/pages 各一条）、已对齐件永不进修复路径（无差别修复＝越权、有反例）、
  //      真坏件修复后仍失败且零改动（不许吞错）。夹具＝WPS 安装目录自带空白模板（真件入仓
  //      test/fixtures/wps-newfile.doc，9,216 B，无个人信息字段）；变体在判据内现造：
  //      非对齐＝+100 B；头坏但对齐＝字节序字段改 0x0000；坏件＝目录项起始扇区改坏。
  const WNF = () => fs.readFileSync(ROOT + '/test/fixtures/wps-newfile.doc');
  const misalignedWnf = (p) => { const buf = Buffer.concat([WNF(), Buffer.alloc(100)]); fs.writeFileSync(p, buf); return buf; };
  t('olealign-to 非对齐 OLE：to 自动副本对齐修复并自报（原文件零改动）', () => {
    const varPath = `${S}/oleal-to.doc`; const src = misalignedWnf(varPath);
    const raw = runKit(['convert', '--input', varPath, '--output', `${S}/oleal-raw.pdf`, '--timeout-ms', '60000']);
    if (raw.ok) return '前置不成立：引擎直转非对齐件竟然成功（形状已变，判据需重标定）';
    if (!/compound-file header/.test(String(raw.error || ''))) return '前置不成立：拒因不是 truncated compound-file header：' + raw.error;
    const outPath = `${S}/oleal-out.pdf`;
    const p = spawnSync(process.execPath, [__filename, 'to', varPath, outPath], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    if (!j || j.ok !== true) return '修复后转换未成功：' + kidErr(p.stdout);
    const rep = j.inputRepair;
    if (!rep || rep.kind !== 'ole-sector-align') return '缺 inputRepair（ole-sector-align）自报';
    if (rep.padBytes !== 412) return `padBytes 应为 412，实测 ${rep.padBytes}`;
    if (rep.alignedCopy.bytes !== 9728) return `对齐副本字节数应为 9728，实测 ${rep.alignedCopy.bytes}`;
    const expectSha = sha256(src);
    if (rep.original.bytes !== src.length || rep.original.sha256 !== expectSha) return 'original 自报与输入不符';
    if (sha256(fs.readFileSync(varPath)) !== expectSha) return '原文件被改动（零改动被打破）';
    if (!fs.existsSync(rep.alignedCopy.path) || sha256(fs.readFileSync(rep.alignedCopy.path)) !== rep.alignedCopy.sha256) return '对齐副本自报路径/哈希与盘上不符';
    if (!(Array.isArray(j.warnings) && j.warnings.some((w) => /512/.test(w)))) return '修复必须带 warnings 通告（缺 512 对齐说明）';
    if (!fs.existsSync(outPath)) return '产物没落盘';
    return true;
  }, {needs:'kit'});
  t('olealign-pages 非对齐 OLE：pages 同走副本对齐修复并自报', () => {
    const varPath = `${S}/oleal-pg.doc`; const src = misalignedWnf(varPath);
    const p = spawnSync(process.execPath, [__filename, 'pages', varPath, '--dir', `${S}/oleal-pg-out`], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    if (!j || j.ok !== true) return '渲染未成功：' + kidErr(p.stdout);
    if (!(j.pageCount >= 1)) return 'pageCount 异常：' + j.pageCount;
    const rep = j.inputRepair;
    if (!rep || rep.kind !== 'ole-sector-align') return '缺 inputRepair 自报';
    if (rep.padBytes !== 412) return `padBytes 应为 412，实测 ${rep.padBytes}`;
    if (rep.alignedCopy.bytes !== 9728) return `对齐副本字节数应为 9728，实测 ${rep.alignedCopy.bytes}`;
    const expectSha = sha256(src);
    if (rep.original.sha256 !== expectSha) return 'original 自报与输入不符';
    if (sha256(fs.readFileSync(varPath)) !== expectSha) return '原文件被改动（零改动被打破）';
    if (!(Array.isArray(j.warnings) && j.warnings.length)) return '修复必须带 warnings 通告';
    return true;
  }, {needs:'kit'});
  t('olealign-noop 已对齐 OLE 不许走修复（无差别修复＝越权）', () => {
    const b = Buffer.from(WNF()); b.writeUInt16LE(0x0000, 28); // 字节序字段改坏：引擎以同一短语拒，但长度保持对齐
    const hdrPath = `${S}/oleal-hdr.doc`; fs.writeFileSync(hdrPath, b);
    const p = spawnSync(process.execPath, [__filename, 'to', hdrPath, `${S}/oleal-hdr.pdf`], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    if (!j || j.ok !== false) return '对齐但头坏件竟被接受/非 JSON：' + kidErr(p.stdout);
    if (j.code !== 'invalid-document') return `码应为 invalid-document，实测 ${j.code}`;
    if (/补零对齐/.test(j.error || '')) return '对齐件走了修复尝试（无差别修复＝越权）：' + j.error;
    if (!/compound-file header/.test(j.error || '')) return '拒因文案异常：' + String(j.error || '').slice(0, 160);
    return true;
  }, {needs:'kit'});
  t('olealign-broken 非对齐且内容真坏：修复尝试后仍失败（勿吞错）', () => {
    const b = Buffer.from(WNF());
    const nameOff = b.indexOf(Buffer.from('WordDocument', 'utf16le'));
    b.writeUInt32LE(0x00000063, nameOff + 116);   // 目录项起始扇区改坏：容器修复后引擎仍读不出
    const varPath = `${S}/oleal-broken.doc`;
    fs.writeFileSync(varPath, Buffer.concat([b, Buffer.alloc(100)]));
    const before = sha256(fs.readFileSync(varPath));
    const p = spawnSync(process.execPath, [__filename, 'to', varPath, `${S}/oleal-broken.pdf`], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    if (!j || j.ok !== false) return '坏件竟报成功/非 JSON（吞错）：' + kidErr(p.stdout);
    if (j.code !== 'invalid-document') return `码应保持 invalid-document，实测 ${j.code}`;
    if (!/补零对齐/.test(j.error || '')) return '修复尝试未被如实报告（缺重试说明）：' + String(j.error || '').slice(0, 160);
    if (sha256(fs.readFileSync(varPath)) !== before) return '修复期间原文件被改动（零改动被打破）';
    if (fs.existsSync(`${S}/oleal-broken.pdf`)) return '失败路径落了半成品产物';
    return true;
  }, {needs:'kit'});
  // ---- font-fallbacks 形状（实测：JSON 二维数组，每组至少两个非空名）
  t('flag font-fallbacks 单名必须被拒', () => { const r = runKit(['convert', '--input', cnPath, '--output', `${S}/fb1.pdf`, '--font-fallbacks', '["宋体"]', '--timeout-ms', '60000']); return r.ok === false && /at least two/.test(r.error || ''); }, {needs:'kit'});
  t('flag font-fallbacks 二维数组可用', () => { const r = runKit(['convert', '--input', cnPath, '--output', `${S}/fb2.pdf`, '--font-fallbacks', JSON.stringify([[BOGUS, '宋体']]), '--timeout-ms', '60000']); return r.ok === true; }, {needs:'kit'});
  t('flag font-fallbacks 不改变缺字自曝（补了替换也不能宣称不缺字）', () => { const r = runKit(['convert', '--input', cnPath, '--output', `${S}/fb3.pdf`, '--font-fallbacks', JSON.stringify([[BOGUS, '宋体']]), '--timeout-ms', '60000']); return r.missingFonts?.includes(BOGUS) === true; }, {needs:'kit'});
  // ---- 多表与重算
  t('sheet 双表出 csv 不给 --sheet 必须被拒（防静默只导第一张）', () => { const r = runKit(['convert', '--input', twoPath, '--output', `${S}/t1.csv`, '--timeout-ms', '60000']); return r.ok === false && /multi-sheet/.test(r.error || ''); }, {needs:'kit'});
  t('sheet 双表指定表名出 csv 内容对得上那张表', () => { const r = runKit(['convert', '--input', twoPath, '--output', `${S}/t2.csv`, '--sheet', '自检第二页', '--timeout-ms', '60000']); return r.ok && str(fs.readFileSync(`${S}/t2.csv`)).includes('自检表二表头'); }, {needs:'kit'});
  t('sheet zip 路线枚举名与 render 路线一致', () => {
    const z = listSheets(twoPath, 'zip'), rr = listSheets(twoPath, 'render');
    // render 路线要起引擎：它这次起不来（负载/超时）时判 SKIP 并点名原因，不算判据红——见总览第八节
    if (rr.method === 'error') return 'skip（render 路线这次起不来：' + rr.code + ' ' + rr.error + '）';
    return JSON.stringify(z.names) === JSON.stringify(rr.names) && z.names.length === 2 ? true : 'zip=' + JSON.stringify(z.names) + ' render=' + JSON.stringify(rr.names);
  });
  t('装置 sheets 会自报用了哪条枚举路线', () => { const r = spawnSync(process.execPath, [__filename, 'sheets', twoPath], { encoding: 'utf8' }); const j = JSON.parse(r.stdout); return j.ok && /zip/.test(j.method); });
  t('装置 to 多表出 csv 时前置拒绝，next 里给出准确表名，且不落半成品文件', () => {
    // R-A（v1.6.4）缺失态假绿修复：kit 缺失时 to 也会拒绝（unavailable），"拒绝"断言会因错误原因成立——
    // 前置显式守卫，缺失态该 SKIP 就 SKIP，不许拿依赖缺失的拒绝冒充多表守卫在位。
    if (!resolveKitCli().present) return `skip（外部依赖不可用：LibreOffice kit（探针 existsSync=false）——本条断言的是多表前置守卫在位时的拒绝语义，kit 缺失时拒绝会因错误原因发生，不冒充通过）`;
    const p = `${S}/dev1.csv`;
    const r = spawnSync(process.execPath, [__filename, 'to', twoPath, p], { encoding: 'utf8' });
    const j = JSON.parse(r.stdout);
    return r.status === 1 && j.ok === false && /自检第一页/.test(j.next || '') && fs.existsSync(p) === false ? true : JSON.stringify(j);
  });
  const recXlsx = () => once('recxlsx', () => { const r = runKit(['recalculate', '--input', fPath, '--output', `${S}/rec.xlsx`, '--timeout-ms', '60000']); if (!r.ok) throw new Error('recalculate 失败：' + r.error); return str(cellRaw(`${S}/rec.xlsx`)); });
  t('recalc 无缓存公式被算出（B1=A1*2 → 6）', () => /<v>6<\/v>/.test(recXlsx()), {needs:'kit'});
  t('recalc 把故意留错的缓存值 999 纠正为 9（真实脏样本）', () => { const x = recXlsx(); return /<v>9<\/v>/.test(x) && !/<v>999<\/v>/.test(x); }, {needs:'kit'});
  t('recalc 公式未被拍平（<f 仍在）', () => /<f[ >]/.test(recXlsx()), {needs:'kit'});
  t('recalc 前直接导 csv 会带出陈旧值（这条红了=陈旧值风险判据坏了）', () => { const r = runKit(['convert', '--input', fPath, '--output', `${S}/stale.csv`, '--timeout-ms', '60000']); return r.ok && str(fs.readFileSync(`${S}/stale.csv`)).includes('999'); }, {needs:'kit'});
  t('recalc 不碰原件（原件哈希不变）', () => { // R-A（v1.6.4）缺失态假绿修复：kit 缺失时 recalc 压根没跑，"原件没变"会因错误原因成立
    if (!resolveKitCli().present) return `skip（外部依赖不可用：LibreOffice kit（探针 existsSync=false）——本条断言的是 recalc 引擎真跑过之后原件仍零改动，kit 缺失时不冒充通过）`;
    const b4 = sha256(fs.readFileSync(fPath)); runKit(['recalculate', '--input', fPath, '--output', `${S}/rec2.xlsx`, '--timeout-ms', '60000']); return sha256(fs.readFileSync(fPath)) === b4; });
  t('recalc --verify 对非 ZIP 表格容器（OLE .xls）要前置 unsupported-format，不许 invalid-document 说装置内部异常', () => {
    // v1.3.0 B 段真件 D0406C.xls 实测：引擎直算成功，--verify 的 cellMap 走装置 ZIP 读取器，OLE 无 EOCD，
    // 异常被兜底层裹成 invalid-document + "装置内部异常"——输入没坏，是这一层不支持 ⇒ 码与方向都错
    // （与 scrub 对 ODF 同病，v1.2.0 修过那半个）。夹具用"magic 对、结构烂"的最小 OLE，守卫必须在引擎之前拦住。
    const fakeXls = `${S}/fake-ole.xls`;
    fs.writeFileSync(fakeXls, Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(600, 0)]));
    const p = spawnSync(process.execPath, [__filename, 'recalc', fakeXls, `${S}/fake-recalc.xlsx`, '--verify'], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    if (!j || j.ok !== false) return '假 OLE 输入竟然 ok 或非 JSON：' + String(p.stdout).slice(0, 120);
    if (p.status !== 1) return `退码应为 1，实测 ${p.status}`;
    if (j.code !== 'unsupported-format') return `码应为 unsupported-format（输入没坏，是 --verify 层不支持 OLE），实测 ${j.code}：${j.error}`;
    if (/装置内部异常|invalid-document/.test(j.error || '')) return '文案仍在说"装置内部异常/invalid-document"：' + j.error;
    if (fs.existsSync(`${S}/fake-recalc.xlsx`)) return '前置拒绝却落了产物（守卫必须在引擎之前）';
    return true;
  });
  t('recalc --report-errors 逐格公式错误地图：#DIV/0!/#NAME? 分类型计数、Sheet!Cell 清单、total_formulas，正文不回显', () => {
    const ePath = `${S}/err.xlsx`;
    const wbE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${XLS}><sheets><sheet name="算式" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`;
    const shE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${XLS}><dimension ref="A1:E1"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>0</v></c><c r="C1"><f>A1/B1</f></c><c r="D1"><f>NOSUCHNAME</f></c><c r="E1"><f>1/0</f></c></row></sheetData></worksheet>`;
    fs.writeFileSync(ePath, xlsx(wbE, shE));
    const p = spawnSync(process.execPath, [__filename, 'recalc', ePath, `${S}/err-out.xlsx`, '--report-errors', '--timeout-ms', '60000'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    if (!j || j.ok !== true) return '错误夹具跑不起来：' + String(p.stdout).replace(/\s+/g, ' ').slice(0, 180);
    const es = j.errorSummary;
    if (!es) return '没回 errorSummary';
    const bad = [];
    if (es.totalErrorCells !== 3) bad.push('应有 3 个错误格，实为 ' + es.totalErrorCells);
    if (es.byType['#DIV/0!'] !== 2) bad.push('#DIV/0! 应 2 个，实为 ' + es.byType['#DIV/0!']);
    if (es.byType['#NAME?'] !== 1) bad.push('#NAME? 应 1 个，实为 ' + es.byType['#NAME?']);
    if (es.totalFormulas !== 3) bad.push('total_formulas 应 3，实为 ' + es.totalFormulas);
    if (!es.list.includes('sheet1!C1') || !es.list.includes('sheet1!D1') || !es.list.includes('sheet1!E1')) bad.push('清单缺格：' + JSON.stringify(es.list));
    if (es.truncated !== false) bad.push('不应 truncated');
    if (/NOSUCHNAME|A1\/B1/.test(p.stdout)) bad.push('公式正文/错误串回显进 JSON');
    return bad.length ? bad.join(' | ') : true;
  }, {needs:'kit'});
  // ---- 元数据面
  const INSP = () => once('insp', () => { const p = spawnSync(process.execPath, [__filename, 'inspect', cnPath], { encoding: 'utf8' }); if (!String(p.stdout).trim()) throw new Error('inspect 子进程失败（status=' + p.status + '）：' + kidErr(p.stderr)); return JSON.parse(p.stdout); });
  t('inspect 元数据只给字段名+长度，不回显正文（含"不许出现值类键"与三个夹具串）', () => {
    const s = JSON.stringify(INSP());
    const secrets = [CN, AUTHOR, '自检夹具标题'];
    const leaked = secrets.filter((x) => s.includes(x));
    const valueLikeKeys = [...s.matchAll(/"(value|raw|text|content|leak|body)"\s*:/g)].map((m) => m[1]);
    return leaked.length === 0 && valueLikeKeys.length === 0 && INSP().metadataFields.some((m) => m.field === 'dc:creator' && m.nonblank === true && typeof m.length === 'number' && !('value' in m))
      ? true : `leaked=${leaked.length} valueLikeKeys=${valueLikeKeys.join(',')}`;
  });
  t('inspect 声明字体族里能看到故意族', () => (INSP().declaredFontFamilies || []).includes(BOGUS));
  t('inspect 容器按 magic 判，伪装后缀会被标不一致', () => { const j = JSON.parse(spawnSync(process.execPath, [__filename, 'inspect', `${S}/fake.docx`], { encoding: 'utf8' }).stdout); return j.kind !== 'ooxml-or-odf-zip' && /无法|不一致/.test(j.containerVsExtension || '无法用 ZIP 判定'); });
  const LAT = () => once('lat', () => { cnPdf(); return str0(fs.readFileSync(`${S}/cn.pdf`)); });
  t('meta 转出的 PDF 里作者串真的在（这族泄漏面成立）', () => LAT().includes(Buffer.from(AUTHOR, 'utf8').toString('latin1')) || LAT().includes(AUTHOR), {needs:'kit'});
  t('meta PDF 含 XMP 包（元数据面不止 /Info）', () => LAT().includes('xpacket') && LAT().includes('dc:creator'), {needs:'kit'});
  const scrubbed = `${S}/cn-scrub.docx`;
  // 子进程失败必须把**它的**错误原文带进 FAIL 行：只 JSON.parse(stdout) 会把红因写成 "Unexpected end of JSON input"，
  // 变异台就分不清"中央 CRC 被抓到了"和"夹具压根没写成"——红要能归因，见总览第八节第 11 条。
  const SR = () => once('sr', () => {
    const p = spawnSync(process.execPath, [__filename, 'scrub', cnPath, scrubbed, '--verify'], { encoding: 'utf8' });
    if (!String(p.stdout).trim()) throw new Error('scrub 子进程失败（status=' + p.status + '）：' + kidErr(p.stderr));
    const j = JSON.parse(p.stdout);
    if (j.ok !== true) throw new Error('scrub 子进程自报失败：' + kidErr(p.stdout));
    return j;
  });
  t('scrub 产物可被 kit 正常打开（改过 ZIP 不算坏文件）', () => { SR(); const r = runKit(['convert', '--input', scrubbed, '--output', `${S}/sc.pdf`, '--timeout-ms', '60000']); return r.ok === true; }, {needs:'kit'});
  t('scrub --verify 转 PDF 后作者串零残留（含检查条数>0，防空对空）', () => SR().ok === true && SR().verify?.converted === true && SR().verify.checkedStrings > 0 && SR().verify.residual === 0, {needs:'kit'});
  t('scrub --verify 的回查条数=源文件里非空目标字段数（独立数一遍，防"删了几个才查几个"）', () => {
    const PROBE = ['dc:creator', 'dc:title', 'dc:subject', 'dc:description', 'cp:keywords', 'cp:lastModifiedBy', 'Company', 'Manager', 'Template', 'Application'];
    const map = zipRead(fs.readFileSync(cnPath));
    let n = 0;
    for (const part of ['docProps/core.xml', 'docProps/app.xml']) {
      const d = map.get(part); if (!d) continue;
      for (const f of PROBE) for (const m of str(d).matchAll(new RegExp('<' + f + '(?:\\s[^>]*)?>([^<]*)</' + f + '>', 'g'))) if (m[1].trim()) n++;
    }
    return SR().verify.checkedStrings === n && n > 0 ? true : `checkedStrings=${SR().verify.checkedStrings} 独立计数=${n}`;
  });
  t('scrub 双向自证：未清的产物含作者串、清过的不含', () => {
    SR(); const p1 = `${S}/v-orig.pdf`, p2 = `${S}/v-scrub.pdf`, MB = Buffer.from(AUTHOR, 'utf8').toString('latin1');
    const r1 = runKit(['convert', '--input', cnPath, '--output', p1, '--timeout-ms', '60000']);
    const r2 = runKit(['convert', '--input', scrubbed, '--output', p2, '--timeout-ms', '60000']);
    return r1.ok && r2.ok && str0(fs.readFileSync(p1)).includes(MB) && !str0(fs.readFileSync(p2)).includes(MB);
  }, {needs:'kit'});
  t('zip 自写包坏在明处会被抓：局部头 CRC 打架必须抛错', () => { SR();
    SR(); const b = Buffer.from(fs.readFileSync(scrubbed)); b.writeUInt32LE(0xdeadbeef, 14);
    try { zipRead(b); return '没抛错——CRC 对账形同虚设'; } catch (e) { return /CRC/.test(e.message) ? true : '抛了但不是 CRC：' + e.message; }
  });
  // 🔴 两层 CRC 对账要各有各的攻击：只把中央 CRC 抹成 0 时，"局部 vs 中央打架"那层先响，逐条重算那层根本没被走到（v1.1.1 复盘 M9 发现）。
  // 这条把**两处 CRC 字段改成同一个假值**：打架层看不见，只有"实算 vs 记录"能响。对应变异＝M17。
  t('zip 自写包坏在明处会被抓：局部+中央 CRC 同一个假值时逐条重算必须抛错', () => {
    const b = Buffer.from(fs.readFileSync(cnPath));
    const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cd = b.readUInt32LE(eocd + 16);
    b.writeUInt32LE(0xdeadbeef, 14); b.writeUInt32LE(0xdeadbeef, cd + 16);
    try { zipRead(b); return '没抛错——逐条重算 CRC 那层形同虚设'; }
    catch (e) { return /不匹配/.test(e.message) ? true : '抛了但不是重算层：' + e.message; }
  });
  t('zip 自写包坏在明处会被抓：中央目录 CRC 被抹必须抛错（zipRead 逐条实算）', () => {
    SR(); const b = Buffer.from(fs.readFileSync(scrubbed));
    const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cd = b.readUInt32LE(eocd + 16);
    b.writeUInt32LE(0, cd + 16);
    try { zipRead(b); return '没抛错——中央 CRC 没人对'; } catch (e) { return /CRC/.test(e.message) ? true : '抛了但不是 CRC：' + e.message; }
  });
  t('scrub 的 roundTrip 自证在位（条目数与逐条字节都对上）', () => SR().roundTrip && SR().roundTrip.bytesMatch === true && SR().roundTrip.entries > 0 ? true : JSON.stringify(SR().roundTrip));
  t('scrub 原件零改动（core.xml 里作者串仍在原文件）', () => { SR(); return str(zipRead(fs.readFileSync(cnPath)).get('docProps/core.xml')).includes(AUTHOR) && !str(zipRead(fs.readFileSync(scrubbed)).get('docProps/core.xml')).includes(AUTHOR); });
  t('cli 兜异常：ZIP 内部坏掉的文件走 inspect 要回结构化 JSON，不许吐裸栈', () => {
    const b = Buffer.from(fs.readFileSync(cnPath));
    const nl = b.readUInt16LE(26), el = b.readUInt16LE(28);          // 第一条目的局部头：名字长 + 扩展长 = 数据起点
    b[30 + nl + el + 1] ^= 0xff;                                      // 改一个压缩流字节：签名/EOCD 仍在，读它必炸
    const bp = `${S}/broken.docx`; fs.writeFileSync(bp, b);
    const p = spawnSync(process.execPath, [__filename, 'inspect', bp], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(String(p.stdout)); } catch { /* 下面按"没读懂"报红 */ }
    return p.status === 1 && j && j.ok === false && j.code === 'invalid-document' && typeof j.error === 'string' && typeof j.next === 'string' && !/\n\s+at\s/.test(String(p.stderr))
      ? true : `status=${p.status} stdout=${String(p.stdout).replace(/\s+/g, ' ').slice(0, 140)} stderr栈=${/\n\s+at\s/.test(String(p.stderr)) ? '有（裸栈！）' : '无'}`;
  });
  // ---- R2-a（任务书 P1-2）：check 纯 ZIP 体检。干净/脏夹具各一份，七族各自点名（判据自己造夹具，不吃 _probe 里的真件，
  //      这样"红在哪一族"能归因到具体规则，而不是"某个真件这次没结论"）。
  t('check 体检：干净夹具零结论、脏夹具各族各自点名，且元数据值与错误码之外的文字不回显', () => {
    const CTc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
    const CORE_EMPTY = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator></dc:creator><dc:title></dc:title></cp:coreProperties>';
    const mkDoc = (core, body) => zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTc) },
      { name: '_rels/.rels', data: Buffer.from(RELS) },
      { name: 'docProps/core.xml', data: Buffer.from(core) },
      { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCRELS) },
      { name: 'word/document.xml', data: Buffer.from(body) },
    ]);
    const TXT = '体检夹具占位串CHKNOISE';
    const bodyClean = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>${TXT}</w:t></w:r></w:p></w:body></w:document>`;
    const bodyDirty = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>${TXT}</w:t></w:r><w:r><w:drawing><wp:inline><wp:docPr id="2" name="Picture 1"/><wp:cNvGraphicFramePr/></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:docPr id="3" descr="   "/></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`;
    const cleanDoc = `${S}/chk-clean.docx`, dirtyDoc = `${S}/chk-dirty.docx`, dirtyXlsx = `${S}/chk-dirty.xlsx`, dirtyPptx = `${S}/chk-dirty.pptx`, oleDoc = `${S}/chk-ole.doc`, crcBadDoc = `${S}/chk-crc.docx`;
    fs.writeFileSync(cleanDoc, mkDoc(CORE_EMPTY, bodyClean));
    fs.writeFileSync(dirtyDoc, mkDoc(CORE, bodyDirty));
    const wb1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${XLS}><sheets><sheet name="错误格" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><sheet name="空表" sheetId="2" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`;
    const shErr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${XLS}><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1"><v>7</v></c><c r="B1" t="e"><f>A1/0</f><v>#DIV/0!</v></c></row><row r="2"><c r="A2" t="e"><v>#REF!</v></c></row></sheetData></worksheet>`;
    const shEmpty = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${XLS}><dimension ref="A1"/><sheetData></sheetData></worksheet>`;
    fs.writeFileSync(dirtyXlsx, xlsx(wb1, shErr, shEmpty));
    const CTp = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
    const Pp = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    fs.writeFileSync(dirtyPptx, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTp) },
      { name: 'ppt/presentation.xml', data: Buffer.from(`<?xml version="1.0"?><p:presentation xmlns:p="${Pp}"/>`) },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(`<?xml version="1.0"?><p:sld xmlns:p="${Pp}"><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 1"/><p:cNvPicPr/></p:nvPicPr><p:blipFill/></p:pic></p:spTree></p:cSld></p:sld>`) },
      { name: 'ppt/slides/slide2.xml', data: Buffer.from(`<?xml version="1.0"?><p:sld xmlns:p="${Pp}"><p:cSld><p:spTree/></p:cSld></p:sld>`) },
    ]));
    fs.writeFileSync(oleDoc, Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(600, 0)]));
    const CK = (f, extra) => { const p = spawnSync(process.execPath, [__filename, 'check', f, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };

    const bad = [];
    // ① 干净夹具必须 0 项且自报 clean=true
    const c0 = CK(cleanDoc);
    if (!c0.j || c0.j.ok !== true) bad.push(`干净夹具应当通过：${JSON.stringify(c0.j && { code: c0.j.code, error: c0.j.error }).slice(0, 120)}`);
    else {
      if (c0.j.findings.length !== 0 || c0.j.clean !== true) bad.push(`干净夹具出了 ${c0.j.findings.length} 项（findings 必须为空且 clean=true）：${JSON.stringify(c0.j.findings).slice(0, 200)}`);
      if (c0.j.engine !== false) bad.push('check 必须自报 engine=false');
      if (JSON.stringify(c0.j).includes(TXT)) bad.push('check 把正文文本回显出来了（承重 3）');
    }
    // ② 脏夹具逐族点名：docx 出 meta 两条 + 缺替代文字两条（含 descr 只写空格那一例）
    const d0 = CK(dirtyDoc);
    if (!d0.j || d0.j.ok !== true) bad.push('脏 docx 应当可读：' + JSON.stringify(d0.j && { code: d0.j.code, error: String(d0.j.error).slice(0, 120) }));
    else {
      const cc = d0.j.counts;
      if (cc['meta-field'] !== 2) bad.push(`脏 docx 的 meta-field 应为 2（creator+title），实为 ${JSON.stringify(cc)}`);
      if (cc['missing-alt-text'] !== 2) bad.push(`脏 docx 的 missing-alt-text 应为 2（无 descr + descr 只有空格），实为 ${cc['missing-alt-text']}`);
      const locs = d0.j.findings.filter((f) => f.kind === 'meta-field').map((f) => f.locator).sort();
      if (locs.join(',') !== 'dc:creator,dc:title') bad.push('meta-field 没点名到具体字段：' + locs.join(','));
      if (!d0.j.findings.some((f) => f.kind === 'missing-alt-text' && /id=3/.test(f.locator))) bad.push('descr 只写空格的图被放过了（等于"有 docPr 就算过"）');
      const blob = JSON.stringify(d0.j);
      for (const secret of [CN, AUTHOR, '自检夹具标题']) if (blob.includes(secret)) bad.push(`回报里出现了夹具秘密串 ${JSON.stringify(secret)}（值不回显这条破了）`);
      if (d0.j.clean !== false) bad.push('有结论却自报 clean=true');
      if (d0.j.filter !== 'all') bad.push('未过滤时 filter 应自报 all，实为 ' + JSON.stringify(d0.j.filter));
    }
    // ③ xlsx：错误值缓存两种入口（t="e" 与缓存串本身就是错误码）+ 空表
    const x0 = CK(dirtyXlsx);
    if (!x0.j || x0.j.ok !== true) bad.push('脏 xlsx 应当可读：' + JSON.stringify(x0.j && { code: x0.j.code, error: String(x0.j.error).slice(0, 120) }));
    else {
      if (x0.j.counts['formula-error-cache'] !== 2) bad.push(`formula-error-cache 应为 2（#DIV/0! 走 t="e"、#REF! 走缓存值），实为 ${JSON.stringify(x0.j.counts)}`);
      if (x0.j.counts['empty-sheet'] !== 1) bad.push('空表应点名 1 张，实为 ' + JSON.stringify(x0.j.counts));
      const refs = x0.j.findings.filter((f) => f.kind === 'formula-error-cache').map((f) => f.locator).sort().join(',');
      if (refs !== 'A2,B1') bad.push('错误值缓存没点到单元格：' + refs);
      if (!/sheet1/.test(JSON.stringify(x0.j.findings.filter((f) => f.kind === 'formula-error-cache')))) bad.push('formula 结论没带部件名');
      if (!x0.j.warnings || !x0.j.warnings.some((w) => /xlsx 的图片替代文字面未覆盖/.test(w))) bad.push('xlsx 的 alt-text 覆盖面缺口没自曝进 warnings（静默分支禁令）');
      const esLoc = x0.j.findings.filter((f2) => f2.kind === 'empty-sheet').map((f2) => f2.locator).join(',');
      if (esLoc !== 'sheet2') bad.push('空表点名的应当是那张真空的 sheet2，实为 ' + esLoc);
    }
    // ④ pptx：图片缺 descr + 空页
    const p0 = CK(dirtyPptx);
    if (!p0.j || p0.j.ok !== true) bad.push('脏 pptx 应当可读：' + JSON.stringify(p0.j && { code: p0.j.code, error: String(p0.j.error).slice(0, 120) }));
    else {
      if (p0.j.counts['missing-alt-text'] !== 1) bad.push(`pptx 的 p:pic 缺 descr 应点名 1 处，实为 ${JSON.stringify(p0.j.counts)}`);
      if (p0.j.counts['empty-page'] !== 1) bad.push('pptx 的空页应点名 1 页（slide2），实为 ' + JSON.stringify(p0.j.counts));
      if (!p0.j.findings.some((f) => f.kind === 'empty-page' && /slide-2/.test(f.locator))) bad.push('空页 locator 没带上页号：' + JSON.stringify(p0.j.findings));
      if (!p0.j.warnings || !p0.j.warnings.some((w) => /p:sp/.test(w))) bad.push('pptx 只查图片没自曝进 warnings');
    }
    // ⑤ --kind 过滤：过滤态即使 0 项也不许自称干净；未知族名走候选
    const f0 = CK(dirtyDoc, ['--kind', 'empty-page']);
    if (!f0.j || f0.j.ok !== true) bad.push('--kind 过滤调用失败：' + JSON.stringify(f0.j && { code: f0.j.code }));
    else {
      if (f0.j.findings.length !== 0) bad.push('过滤到 empty-page 时不该有结论，实为 ' + JSON.stringify(f0.j.findings).slice(0, 160));
      if (f0.j.clean !== false) bad.push('过滤态自报 clean=true：被过滤后的 0 项不等于全查干净（字段之间的关系错了）');
      if (!Array.isArray(f0.j.filter) || f0.j.filter.join(',') !== 'empty-page') bad.push('filter 字段没自报本次过滤了什么（要原样回显本次族名）：' + JSON.stringify(f0.j.filter));
    }
    const f1 = CK(dirtyDoc, ['--kind', 'meta-fields']);
    if (!f1.j || f1.j.ok !== false || f1.j.code !== 'invalid-output') bad.push('未知结论族应按 invalid-output 失败，实为 ' + JSON.stringify(f1.j && { ok: f1.j.ok, code: f1.j.code }));
    else if (!Array.isArray(f1.j.candidates) || !f1.j.candidates.includes('meta-field')) bad.push('未知结论族没回候选：' + JSON.stringify(f1.j.candidates));
    // ⑥ CRC 打架复用既有那一层：不另写一套
    const bb = Buffer.from(fs.readFileSync(cleanDoc));
    const nl = bb.readUInt16LE(26), el = bb.readUInt16LE(28);
    bb[30 + nl + el + 1] ^= 0xff;
    fs.writeFileSync(crcBadDoc, bb);
    const z0 = CK(crcBadDoc);
    if (!z0.j || z0.j.ok !== false || z0.j.code !== 'invalid-document') bad.push('读不通的 ZIP 应回 invalid-document，实为 ' + JSON.stringify(z0.j && { code: z0.j.code, error: String(z0.j.error).slice(0, 100) }));
    else if (!/CRC|压缩流|不是 ZIP/.test(String(z0.j.error) + String(z0.j.next))) bad.push('失败文案没说是哪一层抓到的：' + String(z0.j.error).slice(0, 120));
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });

  t('check docx 修订/批注：含 w:ins/w:del 与 comments.xml 时分别点名、正文不回显；干净件零结论', () => {
    const CTrc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>';
    const RCRELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>';
    const INS_TXT = '修订插入密串REVINS', DEL_TXT = '修订删除密串REVDEL', CMT_TXT = '批注密串CMTBODY';
    const bodyRc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>正文</w:t></w:r><w:ins w:id="1" w:author="甲"><w:r><w:t>${INS_TXT}</w:t></w:r></w:ins><w:del w:id="2" w:author="乙"><w:r><w:delText>${DEL_TXT}</w:delText></w:r></w:del></w:p></w:body></w:document>`;
    const commentsRc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${S_}><w:comment w:id="0" w:author="审"><w:p><w:r><w:t>${CMT_TXT}</w:t></w:r></w:p></w:comment></w:comments>`;
    const rcDoc = `${S}/chk-rc.docx`, rcClean = `${S}/chk-rc-clean.docx`;
    fs.writeFileSync(rcDoc, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTrc) },
      { name: '_rels/.rels', data: Buffer.from(RCRELS) },
      { name: 'word/document.xml', data: Buffer.from(bodyRc) },
      { name: 'word/comments.xml', data: Buffer.from(commentsRc) },
    ]));
    const emptyComments = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${S_}/>`;
    const bodyRcClean = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>`;
    fs.writeFileSync(rcClean, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTrc) },
      { name: '_rels/.rels', data: Buffer.from(RCRELS) },
      { name: 'word/document.xml', data: Buffer.from(bodyRcClean) },
      { name: 'word/comments.xml', data: Buffer.from(emptyComments) },
    ]));
    const CK = (f, extra) => { const p = spawnSync(process.execPath, [__filename, 'check', f, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const bad = [];
    const a = CK(rcDoc);
    if (!a.j || a.j.ok !== true) bad.push('修订件应可读：' + JSON.stringify(a.j && { code: a.j.code, error: String(a.j.error).slice(0, 100) }));
    else {
      if (a.j.counts.revisions !== 2) bad.push(`revisions 应为 2（ins+del；delText 不得另计），实为 ${a.j.counts.revisions}`);
      if (a.j.counts.comments !== 1) bad.push(`comments 应为 1，实为 ${a.j.counts.comments}`);
      const locs = a.j.findings.map((f) => f.locator).sort().join(',');
      if (!/w:ins w:id=1/.test(locs) || !/w:del w:id=2/.test(locs) || !/w:comment w:id=0/.test(locs)) bad.push('没点名到 w:id：' + locs);
      const blob = JSON.stringify(a.j);
      for (const s of [INS_TXT, DEL_TXT, CMT_TXT]) if (blob.includes(s)) bad.push(`修订/批注正文被回显：${s}`);
      if (!a.j.warnings || !a.j.warnings.some((w) => /未接受修订/.test(w)) || !a.j.warnings.some((w) => /含批注/.test(w))) bad.push('外发提示没进 warnings');
      if (a.j.clean !== false) bad.push('含修订却 clean=true');
    }
    const b = CK(rcClean);
    if (!b.j || b.j.ok !== true) bad.push('干净件应可读');
    else if ((b.j.counts.revisions || 0) !== 0 || (b.j.counts.comments || 0) !== 0) bad.push('无修订件却报结论：' + JSON.stringify(b.j.counts));
    const c = CK(rcDoc, ['--kind', 'revisions']);
    if (!c.j || c.j.ok !== true) bad.push('--kind revisions 应可读');
    else if ((c.j.counts.comments || 0) !== 0 || (c.j.counts.revisions || 0) !== 2) bad.push('过滤族没生效：' + JSON.stringify(c.j.counts));
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });

  t('check 不起引擎也不写盘：OLE 输入前置 unsupported-format，命令体内不得出现引擎调用或写文件', () => {
    const bad = [];
    const body = cmdBody('check');
    if (body === null) return '找不到 cmdCheck 函数体（判据自己坏了，别当通过）';
    for (const banned of ['runKit(', 'spawnSync(', 'writeFileSync', 'freePath(', 'freeDir(']) {
      if (body.includes(banned)) bad.push(`命令体里出现了 ${banned}——check 的卖点是纯 ZIP 不起引擎也不写盘，加了就是把"体检"变成"转换"`);
    }
    // F-3（v1.6.2）：字面黑名单防不住行为等价的写法族（实测 `fs.appendFileSync` 写盘成功而旧判据 PASS——Z1 变异）。
    // 加严改成**结构断言**：cmdCheck 函数体里出现的每个 `fs.<方法>` 必须落在只读白名单内，白名单外一律算写面（加严不是放宽）。
    // 已知边界（如实登记）：`fs['write'+'FileSync']` 这类动态属性拼接不受字面匹配覆盖——那是刻意自 obscuring 的写法，
    // 这一层防的是"等价写法无意/顺手混入"，不是防混淆攻击；运行时面另有 --only 全量与台子。
    const READONLY_FS = new Set(['existsSync', 'readFileSync', 'statSync', 'readdirSync', 'lstatSync', 'accessSync', 'realpathSync', 'constants']);
    const usedFs = [...new Set([...body.matchAll(/\bfs\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1]))];
    const rw = usedFs.filter((n) => !READONLY_FS.has(n));
    if (rw.length) bad.push(`命令体里用了只读白名单之外的 fs 方法（${rw.join('/')}）——写面方法族（write*/appendFile*/copyFile*/createWriteStream/…）与未知方法一律红`);
    if (!usedFs.includes('readFileSync')) bad.push('命令体里连 fs.readFileSync 都没有（白名单断言自己在空转）');
    if (!body.includes('zipRead(')) bad.push('命令体里没有 zipRead（那它靠什么读包？）');
    const ole = `${S}/chk-ole-guard.doc`;
    fs.writeFileSync(ole, Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(600, 0)]));
    const p = spawnSync(process.execPath, [__filename, 'check', ole], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    if (!j || j.ok !== false) return 'OLE 输入竟然没失败：' + String(p.stdout).replace(/\s+/g, ' ').slice(0, 120);
    if (p.status !== 1) bad.push(`退码应为 1，实测 ${p.status}`);
    if (j.code !== 'unsupported-format') bad.push(`码应为 unsupported-format（输入没坏，是这一族不在纯 ZIP 面里），实为 ${j.code}：${String(j.error).slice(0, 80)}`);
    if (/装置内部异常|invalid-document/.test(String(j.error))) bad.push('文案仍在说装置内部异常/invalid-document（把不支持报成坏文件，v1.2.0 的老方向错误）：' + String(j.error).slice(0, 90));
    if (!/先 to 成 OOXML|verify/.test(String(j.next))) bad.push('next 没指路（OLE 先转、PDF 走 verify 半条）：' + String(j.next).slice(0, 90));
    // v2.6.0：PDF 面加进来以后，"不起引擎、不写盘"这条承诺必须**一起罩住新增的两段实现**——
    // 只核 cmdCheck 的话，把写盘与起引擎塞进 checkPdf/pdfRiskScan 就绕过这道门了（覆盖面缺口，不是放宽）。
    {
      const src = fs.readFileSync(__filename, 'utf8').replace(/\r\n/g, '\n');
      const NLBRACE = String.fromCharCode(10) + '}' + String.fromCharCode(10);
      const fnBody = (sig) => { const i = src.indexOf(sig); if (i < 0) return null; const k = src.indexOf(NLBRACE, i); return k < 0 ? null : src.slice(i, k + 3); };
      const pdfBody = fnBody('async function checkPdf(');
      const riskBody = fnBody('async function pdfRiskScan(');
      if (!pdfBody) bad.push('找不到 checkPdf 函数体（PDF 分支被改名或拆走：这道门就空转了）');
      if (!riskBody) bad.push('找不到 pdfRiskScan 函数体（同上）');
      for (const [nm, b] of [['checkPdf', pdfBody], ['pdfRiskScan', riskBody]]) {
        if (!b) continue;
        for (const banned of ['runKit(', 'spawnSync(', 'spawn(', 'writeFileSync', 'appendFile', 'copyFile', 'freePath(', 'freeDir(', 'mkdir']) {
          if (b.includes(banned)) bad.push(`${nm} 里出现了 ${banned}——check 的 PDF 面同样承诺不起引擎、不写盘`);
        }
        const used = [...new Set([...b.matchAll(/\bfs\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1]))];
        const wr = used.filter((n) => !READONLY_FS.has(n));
        if (wr.length) bad.push(`${nm} 用了只读白名单外的 fs 方法（${wr.join('/')}）`);
      }
      if (body && !body.includes("'%PDF-'")) bad.push('cmdCheck 里不再有 %PDF- 的 magic 分流（PDF 又被挡回 unsupported-format 了？那 help 与报告口径全都漂了）');
      if (riskBody && !riskBody.includes('PDFRawStream')) bad.push('pdfRiskScan 不再看流对象（PDFRawStream）——附件与 XMP 都是流，只认 PDFDict 会把 /Type /EmbeddedFile 整族漏掉（v2.6.0 实测踩过）');
    }
    return bad.length ? bad.join(' | ') : true;
  });

  // ---- v2.6.0：check 的外发风险面（隐藏内容 / 外部引用 / 内嵌对象 / 宏 / 自定义 XML）
  //      隐私口径与 meta-field 同族：字段名·部件名点名，**值·URL·层名·脚本内容一律不回显**——所以每个秘密串都必须抓不到。
  t('check 外发风险五族：隐藏内容/外部引用/内嵌对象/宏/自定义 XML 各自点名、值与目标不回显；干净件零结论', () => {
    const bad = [];
    const SEC = { vanish: '隐藏文本密串HIDDENTXT', off: '显式关掉隐藏的串HIDDENOFF', url: 'https://intranet.example.invalid/SECRETURL.png', custom: '自定义属性密值SECRETCUSTOM', attach: '嵌入对象内容密串ATTACHBODY', odfCell: 'ODF隐藏单元格密串ODFHID', odfUrl: 'http://outside.example.invalid/SECRETODFURL.png', proj: '放映列表隐藏页密串PROJHID' };
    const CTr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.12"/><Override PartName="/customXml/item1.xml" ContentType="application/xml"/></Types>`;
    const RISKRELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${SEC.url}" TargetMode="External"/></Relationships>`;
    const riskBody = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${SEC.vanish}</w:t></w:r><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>${SEC.off}</w:t></w:r><w:r><w:rPr><w:webHidden/></w:rPr><w:t>x</w:t></w:r></w:p></w:body></w:document>`;
    const CUSTOM = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-9E01-4BDD-9A0F-1D4D93E5D419}" pid="2" name="内部代号"><vt:lpwstr>${SEC.custom}</vt:lpwstr></property><property fmtid="{D5CDD505-9E01-4BDD-9A0F-1D4D93E5D419}" pid="3" name="空属性"><vt:lpwstr></vt:lpwstr></property></Properties>`;
    const riskDocx = `${S}/risk-external.docx`, riskClean = `${S}/risk-clean.docx`, riskOds = `${S}/risk-external.ods`, riskOdt = `${S}/risk-clean.odt`, riskPptx = `${S}/risk-hidden.pptx`;
    fs.writeFileSync(riskDocx, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTr) },
      { name: '_rels/.rels', data: Buffer.from(RELS) },
      { name: 'word/_rels/document.xml.rels', data: Buffer.from(RISKRELS) },
      { name: 'word/document.xml', data: Buffer.from(riskBody) },
      { name: 'word/embeddings/oleObject1.bin', data: Buffer.from(SEC.attach, 'utf8') },
      { name: 'word/vbaProject.bin', data: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]) },
      { name: 'customXml/item1.xml', data: Buffer.from('<?xml version="1.0"?><root/>') },
      { name: 'docProps/custom.xml', data: Buffer.from(CUSTOM) },
    ]));
    fs.writeFileSync(riskClean, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTr.replace('application/vnd.ms-word.document.macroEnabled.12', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) },
      { name: '_rels/.rels', data: Buffer.from(RELS) },
      { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCRELS) },
      { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>正常正文</w:t></w:r></w:p></w:body></w:document>`) },
    ]));
    // pptx：隐藏页两种形状各来一枚（slide 根的 p:sld@show 与 presentation 里的 p:sldId@show）
    const Pp2 = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    fs.writeFileSync(riskPptx, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
      { name: 'ppt/presentation.xml', data: Buffer.from(`<?xml version="1.0"?><p:presentation xmlns:p="${Pp2}" xmlns:r="${'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}"><p:sldIdLst><p:sldId id="256" r:id="rId1" show="0"/></p:sldIdLst></p:presentation>`) },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(`<?xml version="1.0"?><p:sld xmlns:p="${Pp2}" show="0"><p:cSld><p:spTree><p:sp><p:txBody><a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${SEC.proj}</a:t></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`) },
    ]));
    const ODFNS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"';
    const odsContent = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODFNS}><office:body><office:spreadsheet><table:table table:name="带隐藏"><table:table-row><table:table-cell table:visibility="hidden"><text:p>${SEC.odfCell}</text:p></table:table-cell></table:table-row><table:table-cell><text:p>正常格</text:p></table:table-cell></office:spreadsheet></office:body></office:document-content>`;
    const odsContent2 = odsContent.replace('<table:table-cell><text:p>正常格</text:p></table:table-cell></office:spreadsheet>', '<draw:image xlink:href="' + SEC.odfUrl + '" xlink:type="simple"/></table:table></office:spreadsheet>');
    const odsStyles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ODFNS}><office:styles><style:style style:name="隐藏表" style:family="table"><style:table-properties table:display="false"/></style:style></office:styles></office:document-styles>`;
    fs.writeFileSync(riskOds, zipWrite([
      { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.spreadsheet'), method: 0 },
      { name: 'content.xml', data: Buffer.from(odsContent2) },
      { name: 'styles.xml', data: Buffer.from(odsStyles) },
      { name: 'Objects/oledata.mso', data: Buffer.from('ODF 的 OLE 子文档') },
      { name: 'Scripts/Python/module1.py', data: Buffer.from('print("macro")') },
    ]));
    fs.writeFileSync(riskOdt, zipWrite([
      { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text'), method: 0 },
      { name: 'content.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODFNS}><office:body><office:text><text:p>正文只有这一句</text:p></office:text></office:body></office:document-content>`) },
    ]));
    const CK = (f, extra) => { const p = spawnSync(process.execPath, [__filename, 'check', f, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const a = CK(riskDocx);
    if (!a.j || a.j.ok !== true) return '风险 docx 读不通：' + JSON.stringify(a.j && { code: a.j.code, error: String(a.j.error).slice(0, 140) });
    const cc = a.j.counts;
    // 期望值就是这一族的全部牙：w:vanish（真隐藏）＋w:webHidden＝2；空值属性与 w:val="0" 都不许算进去
    if (cc['hidden-content'] !== 2) bad.push(`hidden-content 应为 2（w:vanish＋w:webHidden；w:val="0" 那枚显式关掉的必须不算），实为 ${cc['hidden-content']}`);
    if (cc['external-link'] !== 1) bad.push('external-link 应为 1（TargetMode="External"），实为 ' + JSON.stringify(cc));
    if (cc['embedded-object'] !== 1) bad.push('embedded-object 应为 1（word/embeddings/），实为 ' + cc['embedded-object']);
    if (cc['macro'] !== 2) bad.push('macro 应为 2（vbaProject.bin ＋ ContentType 里的 macroEnabled），实为 ' + cc['macro']);
    if (cc['custom-xml'] !== 2) bad.push(`custom-xml 应为 2（customXml/item1.xml ＋ 有值的 docProps/custom.xml 属性；空值那条不许算），实为 ${cc['custom-xml']}`);
    const blob = JSON.stringify(a.j);
    for (const s of [SEC.vanish, SEC.off, SEC.url, SEC.custom, SEC.attach]) if (blob.includes(s)) bad.push(`回报里出现了夹具秘密串 ${s.slice(0, 18)}（值/URL/内容不回显这条破了）`);
    if (a.j.clean !== false) bad.push('有风险形状却 clean=true');
    const b = CK(riskClean);
    if (!b.j || b.j.ok !== true) bad.push('干净件读不通');
    else for (const k of ['hidden-content', 'external-link', 'embedded-object', 'macro', 'custom-xml']) if (b.j.counts[k]) bad.push(`干净件被 ${k} 误点名（过度报告会把人训成忽略结论）：` + JSON.stringify(b.j.counts));
    const c = CK(riskOds);
    if (!c.j || c.j.ok !== true) bad.push('风险 ODS 读不通：' + JSON.stringify(c.j && { code: c.j.code, error: String(c.j.error).slice(0, 140) }));
    else {
      if ((c.j.counts['hidden-content'] || 0) !== 2) bad.push('ODF 的 hidden-content 应为 2（隐藏单元格 table:visibility ＋ 表样式 table:display="false"），实为 ' + JSON.stringify(c.j.counts));
      if ((c.j.counts['external-link'] || 0) !== 1) bad.push('ODF 的绝对 xlink:href 没被点名，实为 ' + c.j.counts['external-link']);
      if ((c.j.counts['embedded-object'] || 0) !== 1) bad.push('ODF 的 Objects/ 子文档没被点名，实为 ' + c.j.counts['embedded-object']);
      if ((c.j.counts['macro'] || 0) !== 1) bad.push('ODF 的 Scripts/ 目录没被点名，实为 ' + c.j.counts['macro']);
      if (JSON.stringify(c.j).includes(SEC.odfUrl) || JSON.stringify(c.j).includes('SECRETODFURL')) bad.push('ODF 的外部地址被回显了');
      if (JSON.stringify(c.j).includes(SEC.odfCell)) bad.push('ODF 隐藏单元格正文被回显了');
    }
    const d = CK(riskOdt);
    if (!d.j || d.j.ok !== true) bad.push('干净 ODT 读不通');
    else for (const k of ['hidden-content', 'external-link', 'embedded-object', 'macro']) if (d.j.counts[k]) bad.push(`干净 ODT 被 ${k} 误点名：` + JSON.stringify(d.j.counts));
    const e = CK(riskPptx);
    if (!e.j || e.j.ok !== true) bad.push('隐藏页 pptx 读不通');
    else {
      if ((e.j.counts['hidden-content'] || 0) !== 2) bad.push('pptx 隐藏页两种形状应各点名一次（p:sld@show 与 p:sldId@show），实为 ' + JSON.stringify(e.j.counts));
      if (JSON.stringify(e.j).includes(SEC.proj)) bad.push('隐藏页正文被回显了');
      if (!e.j.warnings || !e.j.warnings.some((w) => /未取证/.test(w))) bad.push('pptx 隐藏页真件形状未取证这条缺口没自曝进 warnings');
    }
    const f0 = CK(riskDocx, ['--kind', 'macro']);
    if (!f0.j || f0.j.ok !== true) bad.push('--kind macro 调用失败');
    else {
      if (Object.keys(f0.j.counts).join(',') !== 'macro') bad.push('过滤态还带着别的族计数：' + JSON.stringify(f0.j.counts));
      if (f0.j.clean !== false) bad.push('过滤态自称干净');
    }
    return bad.length ? bad.slice(0, 8).join(' | ') : true;
  });

  // ---- v2.6.0：check 的 PDF 面。夹具是**手搓的最小 PDF**（pdf-lib 造不出这些形状：它会给 /Info 打自己的章、
  //      也不会写出 OCG/Launch/XFA）。三件必须核到的东西：各族真点名、值与名与目标真不回显、缺 pdf-lib 真降级。
  t('check PDF 面：外发风险六族在手搓件上各自点名、值与层名与目标不回显；无元数据件 clean=true', () => {
    if (loadPdfLib().error) return 'skip（这台机器没有 pdf-lib：check 的 PDF 面跑不了，属外部依赖缺失不是缺陷——真克隆态由注册表逐名钉住）';
    const bad = [];
    const SEC = { info: '风险夹具作者串INFOAUTH', xmp: '风险夹具作者串RISKPDF', kw: '风险关键词RISKKW', url: 'intranet.example.invalid', launch: 'setup.exe', js: 'app.alert', field: 'fldValueRISKVAL', attach: '附件内容串RISKATTACH', layer: 'layerHidden', layer2: 'layerVisible' };
    const zlib2 = require('node:zlib');
    const assemble = (objs, trailerExtra) => {
      const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
      let pos = parts[0].length; const offs = [];
      objs.forEach((body, i) => {
        offs.push(pos);
        const b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
        parts.push(b); pos += b.length;
      });
      const xrefAt = pos;
      let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
      for (const o of offs) x += String(o).padStart(10, '0') + ' 00000 n \n';
      x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
      parts.push(Buffer.from(x, 'latin1'));
      return Buffer.concat(parts);
    };
    const strm = (dict, dataBuf, filter) => dict.replace('/Length 0', '/Length ' + dataBuf.length + (filter ? ' /Filter /FlateDecode' : '')) + '\nstream\n' + dataBuf.toString('latin1') + '\nendstream';
    const XMP = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><dc:creator>${SEC.xmp}</dc:creator><dc:title>风险夹具标题RISKPDF</dc:title><pdf:Producer>风险夹具生产者RISKPDF</pdf:Producer></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const xmpZ = zlib2.deflateSync(Buffer.from(XMP, 'utf8'));      // 压缩流这一支：不 inflate 就读不到字段（M 打的就是这层）
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R /AcroForm 12 0 R /Metadata 11 0 R /OCProperties << /OCGs [9 0 R 10 0 R] /D << /OFF [10 0 R] >> >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Annots [4 0 R 5 0 R 6 0 R 7 0 R] /Contents 14 0 R >>',
      `<< /Type /Annot /Subtype /Link /Rect [10 10 60 24] /A << /S /URI /URI (https://${SEC.url}/secret) >> >>`,
      '<< /Type /Annot /Subtype /Link /Rect [10 30 60 44] /A 16 0 R >>',
      '<< /Type /Annot /Subtype /Link /Rect [10 50 60 64] /A << /S /GoToR /F (other-report.pdf) /D [1 /Fit] >> >>',
      `<< /Type /Annot /Subtype /Widget /Rect [10 70 60 84] /T (fldName) /V (${SEC.field}) /AA << /O 17 0 R >> >>`,
      `<< /Author (${SEC.info}) /Title (风险夹具标题INFO) /Producer (RiskFixture) /Keywords (${SEC.kw}) >>`,
      `<< /Type /OCG /Name (${SEC.layer2}) >>`,
      `<< /Type /OCG /Name (${SEC.layer}) /VE /OFF >>`,
      strm('<< /Type /Metadata /Subtype /XML /Length 0 >>', xmpZ, true),
      '<< /Fields [7 0 R] /DA (/F1 0 Tf 0 g) /XFA [(data) 18 0 R] >>',
      strm('<< /Type /EmbeddedFile /Length 0 >>', Buffer.from(SEC.attach, 'utf8')),
      strm('<< /Length 0 >>', Buffer.from('BT ET', 'latin1')),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /S /Launch /F (${SEC.launch}) >>`,
      `<< /S /JavaScript /JS (${SEC.js}(1)) >>`,
      strm('<< /Length 0 >>', Buffer.from('<xfa/>', 'latin1')),
    ];
    const riskPdf = `${S}/chk-risk.pdf`;
    fs.writeFileSync(riskPdf, assemble(objs, ' /Info 8 0 R'));
    const benignPdf = `${S}/chk-benign.pdf`;
    fs.writeFileSync(benignPdf, assemble([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>',
    ], ''));
    const CK = (f, extra) => { const p = spawnSync(process.execPath, [__filename, 'check', f, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const a = CK(riskPdf);
    if (!a.j || a.j.ok !== true) return '风险 PDF 读不通：' + JSON.stringify(a.j && { code: a.j.code, error: String(a.j.error).slice(0, 150) });
    if (a.j.container !== 'pdf') bad.push('container 没自报 pdf：' + a.j.container);
    if (a.j.engine !== false) bad.push('PDF 面必须自报 engine=false（这一面的卖点就是不起引擎）');
    const cc = a.j.counts;
    if (cc['meta-field'] !== 7) bad.push(`meta-field 应为 7（/Info 四键＋FlateDecode XMP 里三个非空字段；不 inflate 就只剩 4），实为 ${JSON.stringify(cc)}）`);
    if (cc['external-link'] !== 4) bad.push(`external-link 应为 4（/URI、/GoToR、/Launch 两处：注释内联动作与间接动作对象），实为 ${cc['external-link']}`);
    if (cc['macro'] !== 2) bad.push('macro 应为 2（/AA 触发的 JavaScript 与动作对象本体），实为 ' + cc['macro']);
    if (cc['hidden-content'] !== 2) bad.push('hidden-content 应为 2（两枚 OCG），实为 ' + cc['hidden-content']);
    if (cc['embedded-object'] !== 1) bad.push(`embedded-object 应为 1（/Type /EmbeddedFile 是**流对象**，只扫 PDFDict 就漏了——实测踩过），实为 ${cc['embedded-object']}`);
    if (cc['form-field'] !== 2) bad.push('form-field 应为 2（AcroForm 字段数 ＋ XFA 在位），实为 ' + cc['form-field']);
    if (!a.j.pdfRisk || a.j.pdfRisk.embeddedFiles !== 1 || a.j.pdfRisk.layers.defaultOff !== 1) bad.push('pdfRisk 计数不对：' + JSON.stringify(a.j.pdfRisk));
    if (a.j.pdfRisk.actions.launch !== 2 || a.j.pdfRisk.actions.goToRemote !== 1) bad.push('动作族计数不对：' + JSON.stringify(a.j.pdfRisk.actions));
    const blob = JSON.stringify(a.j);
    for (const s of [SEC.info, SEC.xmp, SEC.kw, SEC.url, SEC.launch, SEC.js, SEC.field, SEC.attach, SEC.layer, SEC.layer2]) if (blob.includes(s)) bad.push(`PDF 回报里出现了夹具秘密串 ${s.slice(0, 16)}（值/层名/目标/脚本内容都不许回显）`);
    if (a.j.clean !== false) bad.push('风险 PDF 却 clean=true');
    const b = CK(benignPdf);
    if (!b.j || b.j.ok !== true) bad.push('无元数据的最小 PDF 读不通：' + JSON.stringify(b.j && { code: b.j.code, error: String(b.j.error).slice(0, 120) }));
    else {
      if (b.j.clean !== true) bad.push('干净 PDF 应 clean=true，实报 ' + JSON.stringify(b.j.counts) + '（每一族都得在"没有该形状"时保持沉默）');
      if (b.j.pdfRisk.objectsScanned !== 3) bad.push('干净件的对象扫描数应为 3，实为 ' + JSON.stringify(b.j.pdfRisk));
    }
    const f0 = CK(riskPdf, ['--kind', 'hidden-content']);
    if (!f0.j || f0.j.ok !== true) bad.push('--kind 在 PDF 上失败');
    else if (Object.keys(f0.j.counts).join(',') !== 'hidden-content') bad.push('PDF 过滤态还带着别的族：' + JSON.stringify(f0.j.counts));
    else if (f0.j.clean !== false) bad.push('PDF 过滤态自称干净（滤出来的 0 项不等于全查干净——这一条与 ZIP 面同规矩）');
    // 伪装/坏件：字节以 %PDF- 开头但不是可读结构。🔴 夹具沿用 combine 那条已证伪的样本——
    // 实测 pdf-lib 的 load 对它**不抛错**（返回连 catalog 都取不到的空壳），所以本面必须有"结构自证"这一层：
    // 少了它，坏件会被洗成 ok＋clean=true（假成功），M194 打的正是这层自证。
    const fake = `${S}/chk-fake-again.pdf`;
    fs.writeFileSync(fake, '%PDF-1.7\nthis is not really a pdf');
    const g = CK(fake);
    if (!g.j || g.j.ok !== false) bad.push('坏 PDF 竟然报通过（结构自证那层没拦住假成功）：' + JSON.stringify(g.j && { ok: g.j.ok, clean: g.j.clean, counts: g.j.counts }));
    else if (g.j.code !== 'invalid-document') bad.push('坏件应回 invalid-document（输入真的坏，不是这一族不支持），实为 ' + g.j.code);
    else if (!/Root|结构|页树/.test(String(g.j.error))) bad.push('失败文案没说清是哪一层拦下的：' + String(g.j.error).slice(0, 90));
    // 加密件：不绕加密，且**不许带着读不全的结构报 clean**——直接 unsupported-format＋指解密
    const encF = ROOT + '/test/fixtures/encrypted.pdf';
    if (!fs.existsSync(encF)) bad.push('在册夹具 test/fixtures/encrypted.pdf 不在位（已入仓的件，缺件是检出/仓库问题，不许静默跳过这一臂）');
    else {
      const ge = CK(encF);
      if (!ge.j || ge.j.ok !== false || ge.j.code !== 'unsupported-format') bad.push('加密 PDF 应 unsupported-format，实为 ' + JSON.stringify(ge.j && { ok: ge.j.ok, code: ge.j.code, clean: ge.j.clean }));
      else if (!/解密/.test(String(ge.j.next))) bad.push('加密件没指解密：' + String(ge.j.next).slice(0, 90));
    }
    if (a.j.pdfRisk.pageCount !== 1 || b.j.pdfRisk.pageCount !== 1) bad.push('pageCount 没自证（结构自证那层的副产品）：' + a.j.pdfRisk.pageCount + '/' + b.j.pdfRisk.pageCount);
    return bad.length ? bad.slice(0, 8).join(' | ') : true;
  });

  // ---- v2.6.0：check 的**覆盖面自述**必须可信——族适用面（哪些族对这一类容器有意义）与清单封顶（超限不静默截断）。
  //      这两件事都属"报告字段之间的关系"，散文写多少遍都不算数，只能机械核。
  t('check 覆盖面自述：逐容器适用面双向对账、超限只截清单不动 counts', () => {
    const bad = [];
    // ① 静态：CHECK_APPLICABLE 的每一族必须在 CHECK_KINDS 里；CHECK_KINDS 的每一族必须至少在一种容器上被查过
    for (const [cont, ks] of Object.entries(CHECK_APPLICABLE)) {
      for (const k of ks) if (!CHECK_KINDS.includes(k)) bad.push(`${cont} 的适用族 ${k} 不在 CHECK_KINDS 里（--kind 会把它拒掉）`);
      if (!['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'pdf'].includes(cont)) bad.push('CHECK_APPLICABLE 里冒出了一个不属于任何容器名的键：' + cont);
    }
    for (const k of CHECK_KINDS) if (!Object.values(CHECK_APPLICABLE).some((ks) => ks.includes(k))) bad.push(`族 ${k} 宣告在命令面上却没有任何容器会查它＝假族名`);
    if (Object.keys(CHECK_APPLICABLE).length !== 7) bad.push('适用面表应有七类容器（OOXML 三＋ODF 三＋PDF），实为 ' + Object.keys(CHECK_APPLICABLE).length);
    // ② 运行时：两字段互斥、并起来等于全族
    const a = JSON.parse(spawnSync(process.execPath, [__filename, 'check', `${S}/risk-clean.docx`], { encoding: 'utf8' }).stdout || '{}');
    if (a.ok !== true) bad.push('适用面自述的载体件读不通（前一条判据的夹具没写成？）');
    else {
      const inter = a.kindsApplicable.filter((k) => a.kindsNotApplicable.includes(k));
      if (inter.length) bad.push('kindsApplicable 与 kindsNotApplicable 有交集：' + inter.join(','));
      if (a.kindsApplicable.length + a.kindsNotApplicable.length !== CHECK_KINDS.length) bad.push(`两半加起来 ${a.kindsApplicable.length + a.kindsNotApplicable.length} ≠ 全族 ${CHECK_KINDS.length}`);
      if (a.kindsApplicable.join(',') !== CHECK_APPLICABLE.docx.join(',')) bad.push('docx 的适用面自述与表不一致：' + a.kindsApplicable.join(','));
    }
    // ③ 封顶：造 250 枚隐藏行，counts 必须仍是 250、findings 被截到上限、truncated 自报
    const many = `${S}/chk-cap.xlsx`;
    const rows = Array.from({ length: 250 }, (_, i) => `<row r="${i + 1}" hidden="1"/>`).join('');
    fs.writeFileSync(many, xlsx(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${XLS}><sheets><sheet name="多" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${XLS}><dimension ref="A1"/><sheetData>${rows}<row r="251"><c r="A251"><v>1</v></c></row></sheetData></worksheet>`,
      // 第二张表必须是**另一份内容**：xlsx() 夹具不传 s2 时两张表用同一个字符串，隐藏行会数成 500（实测踩过，counts 就不权威了）
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${XLS}><dimension ref="A1"/><sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData></worksheet>`));
    const j = JSON.parse(spawnSync(process.execPath, [__filename, 'check', many], { encoding: 'utf8' }).stdout || '{}');
    if (j.ok !== true) bad.push('封顶夹具读不通：' + String(j.code || '') + ' ' + String(j.error || '').slice(0, 120));
    else {
      if (j.counts['hidden-content'] !== 250) bad.push('counts 应权威＝250（截断不许动 counts），实为 ' + j.counts['hidden-content']);
      if (j.findings.length !== CHECK_FINDINGS_CAP) bad.push(`findings 应被截到上限 ${CHECK_FINDINGS_CAP}，实为 ${j.findings.length}`);
      if (j.findingsTruncated !== true) bad.push('超限没自报 findingsTruncated（静默截断＝把"还有更多"藏起来）');
      if (j.totalConclusions !== 250) bad.push('totalConclusions 应为 250，实为 ' + j.totalConclusions);
      if (j.findingsCap !== CHECK_FINDINGS_CAP) bad.push('findingsCap 没自报本次上限');
    }
    const few = JSON.parse(spawnSync(process.execPath, [__filename, 'check', `${S}/risk-external.docx`], { encoding: 'utf8' }).stdout || '{}');
    if (few.ok === true && few.findingsTruncated !== false) bad.push('没超限却自报 truncated');
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });

  // ---- v2.6.0：factcheck --refs。行号引用会因插行**静默推漂**（越界那类才会红），所以本面只判三件确定事实：
  //      文件在不在、行号越不越界、那一行现在是什么。判不了的语义漂移必须在 note 里明说，不许冒充"引用都还对"。
  t('factcheck --refs：越界与缺文件必点、界内带出 lineText；不开这一面不查；日志豁免扩到行号引用但不扩列义', () => {
    const bad = [];
    const tgt = `${S}/fc-ref-target.txt`;
    fs.writeFileSync(tgt, '第一行AAA' + String.fromCharCode(10) + '第二行BBB' + String.fromCharCode(10) + '第三行CCC' + String.fromCharCode(10));
    const okDoc = `${S}/fc-ref-ok.md`;
    fs.writeFileSync(okDoc, '见 fc-ref-target.txt:2。' + String.fromCharCode(10));
    const overDoc = `${S}/fc-ref-over.md`;
    fs.writeFileSync(overDoc, '见 fc-ref-target.txt:99。' + String.fromCharCode(10));
    const missDoc = `${S}/fc-ref-miss.md`;
    fs.writeFileSync(missDoc, '见 no-such-file-xyz.md:3。' + String.fromCharCode(10));
    const rangeDoc = `${S}/fc-ref-range.md`;
    fs.writeFileSync(rangeDoc, '见 fc-ref-target.txt:2-3。' + String.fromCharCode(10));
    const logish = `${S}/迭代日志-fake-refs.md`;
    fs.writeFileSync(logish, '历史条目原样引用：见 fc-ref-target.txt:99。' + String.fromCharCode(10) + '这段仍须判错：rev-list 左列＝领先。' + String.fromCharCode(10));
    const FC = (doc, extra) => { const p = spawnSync(process.execPath, [__filename, 'factcheck', '--doc', doc, ...(extra || [])], { encoding: 'utf8', cwd: ROOT }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const pick = (f) => (((f.j || {}).findings) || []).filter((x) => x.kind === '行号引用');
    const n0 = FC(okDoc);
    if (!n0.j || n0.j.ok !== true) return 'factcheck 跑不起来：' + String((n0.j && n0.j.error) || n0.p.stdout).slice(0, 140);
    if (n0.j.refs.on !== false || pick(n0).length !== 0) bad.push('不开 --refs 却查了行号引用（默认面变了，历史文档会被成片点名）');
    if (!n0.j.warnings.some((w) => /没开 --refs/.test(w))) bad.push('没开这一面却没自曝（调用方会以为 refs 是默认行为）');
    const n1 = FC(okDoc, ['--refs']);
    if (!n1.j || n1.j.ok !== true) bad.push('--refs 调用失败');
    else {
      const r = pick(n1);
      if (r.length !== 1) bad.push('--refs 应抠到 1 条引用，实为 ' + r.length + '：' + JSON.stringify(r.map((x) => x.ref)));
      else if (r[0].verdict !== 'ok') bad.push('界内引用被判错：' + JSON.stringify(r[0]).slice(0, 160));
      else if (!/第二行BBB/.test(String(r[0].lineText))) bad.push('界内却没带出那一行的现值（lineText 是给人眼对的，缺它这条判据只是数字）：' + JSON.stringify(r[0].lineText));
      if (n1.j.refs.on !== true) bad.push('开了 --refs 却自报 on=false');
    }
    const n2 = FC(overDoc, ['--refs']);
    if (!pick(n2).some((x) => x.verdict === 'mismatch')) bad.push('行号越界（99 行指在 3 行的文件上）没判错——这就是 M 的靶：' + JSON.stringify(pick(n2)));
    const n3 = FC(missDoc, ['--refs']);
    if (!pick(n3).some((x) => x.verdict === 'unverifiable')) bad.push('点名的文件不存在却被放过（负命题不许默认成立）');
    const n4 = FC(rangeDoc, ['--refs']);
    if (!pick(n4).some((x) => x.verdict === 'ok' && /2-3/.test(String(x.claimed)))) bad.push('区间引用没被当成一条核：' + JSON.stringify(pick(n4).map((x) => [x.claimed, x.verdict])));
    const n5 = FC(logish, ['--refs']);
    const f5 = ((n5.j || {}).findings) || [];
    if (!f5.some((x) => x.kind === '行号引用' && x.verdict === 'historical')) bad.push('迭代日志里越界的旧引用被当成缺陷判红了（历史原样引用必须豁免）：' + JSON.stringify(f5.map((x) => [x.kind, x.verdict])));
    if (!f5.some((x) => x.kind === 'rev-list 列义' && x.verdict === 'mismatch')) bad.push('豁免扩大到语义了——日志里把列义写反必须仍判错');
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });

  // ---- v2.6.0：batch --cmd markdown。批量面第一次有了第二条命令通道，隐私与降级口径都必须与单件一致。
  t('batch --cmd markdown：批量导 md 计数与产物对账、原件零改动、族外件不起子进程、--cmd 与 --to 的互斥都拒', () => {
    if (!pandocTool().present) return 'skip（这台机器没有 pandoc：batch 的 markdown 支跑不了，属外部依赖缺失不是缺陷——与 markdown 降级判据同口径）';
    const bad = [];
    const dir = ensureDir(`${S}/batch-md`);
    const before = {};
    for (const [nm, body] of [['甲.docx', docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>批量甲文串BATCHMDA</w:t></w:r></w:p></w:body></w:document>`)], ['乙.docx', docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>批量乙文串BATCHMDB</w:t></w:r></w:p></w:body></w:document>`)]]) {
      const p = path.join(dir, nm); fs.writeFileSync(p, body); before[p] = sha256(fs.readFileSync(p));
    }
    const pdfish = path.join(dir, '丙.pdf'); fs.writeFileSync(pdfish, Buffer.from('%PDF-1.4\n不是真件\n', 'latin1'));
    const run = (extra) => { const p = spawnSync(process.execPath, [__filename, 'batch', dir, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const a = run(['--cmd', 'markdown']);
    if (!a.j) return 'batch --cmd markdown 无 JSON 输出：' + String(a.p.stdout || a.p.stderr).slice(0, 140);
    if (a.j.cmd !== 'markdown') bad.push('没自报本次走的是 markdown 面：cmd=' + JSON.stringify(a.j.cmd));
    const s = a.j.summary || {};
    if (s.total !== 2) bad.push(`默认 --ext 应换成 markdown 的八个输入族（.pdf 不该被收进清单），实为 total=${s.total}`);
    if (s.ok !== 2 || s.failed !== 0) bad.push('两件 docx 应都成，实为 ' + JSON.stringify(s) + '：' + JSON.stringify((a.j.items || []).filter((x) => !x.ok)));
    for (const it of a.j.items || []) {
      if (!it.ok) continue;
      if (!it.output || !/\.md$/.test(String(it.output))) bad.push('产物不是 .md：' + JSON.stringify(it));
      else if (!fs.existsSync(it.output)) bad.push('报了的落点不在盘上：' + it.output);
      else if (!/BATCHMD/.test(fs.readFileSync(it.output, 'utf8'))) bad.push('产物里没有正文（导通了但没内容）：' + it.output);
      if (JSON.stringify(it).includes('批量甲文串') || JSON.stringify(it).includes('批量乙文串')) bad.push('批报里回显了正文串（与单件 markdown 同隐私口径）');
    }
    for (const [p, h] of Object.entries(before)) if (sha256(fs.readFileSync(p)) !== h) bad.push('批量导 md 改了原件：' + p);
    const b = run(['--cmd', 'markdown', '--ext', 'pdf']);
    if (!b.j || b.j.ok !== false) bad.push('显式收 .pdf 时该逐件判负而不是整体成功');
    else {
      const it = (b.j.items || [])[0] || {};
      if (it.code !== 'unsupported-format') bad.push('族外件的码应为 unsupported-format，实为 ' + it.code);
      if (!/pdftext/.test(String(it.next))) bad.push('族外件没指路（PDF 取字走 pdftext）：' + String(it.next).slice(0, 90));
      if ((b.j.summary || {}).total !== 1) bad.push('--ext pdf 应只收到 1 件');
    }
    const c = run(['--cmd', 'markdown', '--to', 'txt']);
    if (!c.j || c.j.ok !== false || c.j.code !== 'invalid-output') bad.push('--cmd markdown 还吃 --to＝两支命令面混在一起，必须前置拒：' + JSON.stringify(c.j && { ok: c.j.ok, code: c.j.code }));
    const d = run(['--cmd', 'markdownx']);
    if (!d.j || d.j.ok !== false || d.j.code !== 'invalid-output') bad.push('错拼的 --cmd 没被拒：' + JSON.stringify(d.j && { code: d.j.code }));
    else if (!Array.isArray(d.j.candidates) || !d.j.candidates.includes('markdown')) bad.push('错拼的 --cmd 没回最近邻候选：' + JSON.stringify(d.j.candidates));
    const d2 = run(['--cmd', 'drawio']);
    if (!d2.j || d2.j.ok !== false || d2.j.code !== 'invalid-output') bad.push('差太远的 --cmd 也必须拒：' + JSON.stringify(d2.j && { code: d2.j.code }));
    else if (d2.j.candidates && d2.j.candidates.length) bad.push('差太远的名字宁可不给候选（给个不相干的开关比给空的害处大）：' + JSON.stringify(d2.j.candidates));
    // 默认面必须还是 to（旧调用方不许被改行为）。🔴 用"没有匹配件"的目录验——这条判据不许去吃引擎，
    // 否则它就得进两张依赖注册表（真克隆态多一条 SKIP），而默认支的转换本身已由 `batch 批量转换` 钉住。
    const dir2 = ensureDir(`${S}/batch-default-none`);
    fs.writeFileSync(path.join(dir2, 'readme.md'), '# 不在 to 的输入族里');
    const e0 = spawnSync(process.execPath, [__filename, 'batch', dir2], { encoding: 'utf8' });
    let e = null; try { e = JSON.parse(String(e0.stdout).trim()); } catch {}
    if (!e || e.ok !== true || e.cmd !== 'to' || (e.summary || {}).total !== 0) bad.push('不传 --cmd 时默认面必须还是 to：' + JSON.stringify(e && { cmd: e.cmd, ok: e.ok, summary: e.summary }));
    const e2 = run(['--cmd', 'markdown', '--ext', 'md']);
    if (!e2.j || e2.j.ok !== true || e2.j.cmd !== 'markdown' || (e2.j.summary || {}).total !== 0) bad.push('显式 --ext 到 markdown 输入族外时应收到 0 件且不失败：' + JSON.stringify(e2.j && { ok: e2.j.ok, summary: e2.j.summary }));
    if (e2.j && e2.j.filter && e2.j.filter.to !== 'md') bad.push('--cmd markdown 时 filter.to 必须自报 md（产物恒这一种后缀）：' + JSON.stringify(e2.j.filter));
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });

  // ---- R2-b（任务书 P1-1）：dump 默认只出形状。三串口径复用 inspect 那一条（夹具秘密串 = CN / AUTHOR / 自检夹具标题），
  //      并额外钉一条**字段之间的关系**：带 --text 只许带出正文那一路，元数据部件的值永远不许出现。
  t('dump 默认只出形状：不带 --text 时三个夹具秘密串都不许出现，--text 只带正文不带元数据值', () => {
    const DP = (f, extra) => { const p = spawnSync(process.execPath, [__filename, 'dump', f, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const bad = [];
    const SECRETS = [CN, AUTHOR, '自检夹具标题'];
    const d0 = DP(cnPath);
    if (!d0.j || d0.j.ok !== true) return 'dump 干净跑不起来：' + String(d0.p.stdout).replace(/\s+/g, ' ').slice(0, 140);
    const blob0 = JSON.stringify(d0.j);
    for (const sec of SECRETS) if (blob0.includes(sec)) bad.push(`不带 --text 的回报里出现了 ${JSON.stringify(sec)}（默认就该只出形状）`);
    if (d0.j.engine !== false) bad.push('dump 必须自报 engine=false');
    if (!Array.isArray(d0.j.parts) || d0.j.parts.length < 5) bad.push('parts 清单少于 5 条（夹具包有 5 个部件）：' + (d0.j.parts || []).length);
    const p0 = (d0.j.parts || []).find((x) => x.name === 'word/document.xml');
    if (!p0) bad.push('parts 里没有 word/document.xml');
    else if (!['deflate', 'stored'].includes(p0.method) || typeof p0.bytes !== 'number' || typeof p0.compBytes !== 'number' || !/^[0-9a-f]+$/.test(String(p0.crc))) bad.push('部件条目缺 method/bytes/compBytes/CRC 之一：' + JSON.stringify(p0));
    const sh = (d0.j.shapes || []).find((x) => x.part === 'word/document.xml');
    if (!sh) bad.push('shapes 里没有 word/document.xml 的元素统计');
    else if (!sh.elementTop.some((e) => /^w:t=/.test(e))) bad.push('正文部件的元素统计里看不到 w:t（元素计数那一路没生效）：' + JSON.stringify(sh.elementTop).slice(0, 120));
    if (JSON.stringify(d0.j.text).includes('"entries"')) bad.push('默认（不带 --text）就把 entries 带出来了');
    if (d0.j.text.requested !== false) bad.push('text.requested 没自报 false');
    // ② 显式 --text：正文必须真给出来，元数据的值仍然不给
    const d1 = DP(cnPath, ['--text']);
    if (!d1.j || d1.j.ok !== true) return '--text 跑不起来：' + String(d1.p.stdout).replace(/\s+/g, ' ').slice(0, 140);
    const blob1 = JSON.stringify(d1.j);
    if (d1.j.text.requested !== true) bad.push('--text 时 text.requested 必须为 true');
    if (!blob1.includes(CN)) bad.push('带 --text 却没把正文给出来（这条开关是空的）');
    if (!d1.j.text.entries.every((e) => e.part === 'word/document.xml')) bad.push('--text 的条目没带来源部件名');
    if (blob1.includes(AUTHOR) || blob1.includes('自检夹具标题')) bad.push('带 --text 把元数据部件的值也带出来了（--text 只该管正文）');
    if (!d1.j.warnings.some((w) => /不是外发件/.test(w))) bad.push('--text 的产物没有"这不是外发件"的自曝（正文出域的静默分支）');
    if (!d1.j.warnings.some((w) => /元数据部件/.test(w))) bad.push('元数据永给形状这条没在 warnings 里自曝');
    // ③ --part 点名元数据部件 + --text：仍不许出现值
    const d2 = DP(cnPath, ['--part', 'docProps/core.xml', '--text']);
    if (!d2.j || d2.j.ok !== true) bad.push('--part 点名 core.xml 应能跑：' + JSON.stringify(d2.j && { code: d2.j.code }));
    else {
      const b2 = JSON.stringify(d2.j);
      for (const sec of [AUTHOR, '自检夹具标题']) if (b2.includes(sec)) bad.push(`--part docProps/core.xml --text 把 ${JSON.stringify(sec)} 带出来了`);
      if (d2.j.parts.length !== 1) bad.push('--part 过滤后 parts 应当只剩 1 条，实为 ' + d2.j.parts.length);
      if (!d2.j.shapes.some((x) => x.isMetaPart === true)) bad.push('元数据部件没被标 isMetaPart（调用方看不出它属于哪一类）');
    }
    // ④ ODF（WP-A v1.6.7）：夹具**自产**（mkOdt），旧版"本机没有 _probe/cn.odt 就 SKIP"的出口已删——
    // mimetype 首位 stored／order=0／--text 只抽正文不抽元数据的断言一条不减。
    const odtReal = odtFixturePath;
    {
      const d3 = DP(odtReal);
      if (!d3.j || d3.j.ok !== true) bad.push('真 ODT dump 失败：' + JSON.stringify(d3.j && { code: d3.j.code, error: String(d3.j.error).slice(0, 80) }));
      else {
        if (d3.j.container !== 'odt') bad.push('真 ODT 的容器应为 odt，实为 ' + d3.j.container);
        const mt = d3.j.parts.find((x) => x.name === 'mimetype');
        if (!mt) bad.push('ODF 包里没有 mimetype 部件？');
        else if (mt.method !== 'stored' || mt.order !== 0) bad.push(`真 ODT 的 mimetype 实测 method=${mt.method} order=${mt.order}（引擎写出的应是 stored+首条目——dump 看不见这个就等于看不见 R3-a 那条缺陷）`);
        const d4 = DP(odtReal, ['--text']);
        if (d4.j && d4.j.ok === true) {
          const b4 = JSON.stringify(d4.j);
          if (!d4.j.text.entries.length) bad.push('真 ODT 带 --text 却没抽到正文（ODF 的抽取路线没接通）');

          if (d4.j.text.entries.some((e) => /meta\.xml|docProps/.test(e.part))) bad.push('--text 把元数据部件的正文也抽出来了');
        } else bad.push('真 ODT --text 失败：' + JSON.stringify(d4.j && { code: d4.j.code }));
      }
    }
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });

  t('dump 的上限与截断必须自报：形状条数、扫描体积、正文条目三条各自有顶，超了就红在 truncated 上', () => {
    const bad = [];
    const DP = (f, extra) => { const p = spawnSync(process.execPath, [__filename, 'dump', f, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    // ① 形状条数上限：造一个有 DUMP_SHAPE_CAP+1 种元素名的部件
    const manyTags = '<?xml version="1.0"?><root>' + Array.from({ length: DUMP_SHAPE_CAP + 1 }, (_, i) => `<t${i}/>`).join('') + '</root>';
    const capDoc = `${S}/dump-cap.pptx`;
    const CTp = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
    const Pp = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    fs.writeFileSync(capDoc, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTp) },
      { name: 'ppt/presentation.xml', data: Buffer.from(`<?xml version="1.0"?><p:presentation xmlns:p="${Pp}"/>`) },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(manyTags) },
    ]));
    const c0 = DP(capDoc);
    if (!c0.j || c0.j.ok !== true) return '形状上限夹具跑不起来：' + String(c0.p.stdout).replace(/\s+/g, ' ').slice(0, 120);
    const sh = c0.j.shapes.find((x) => x.part === 'ppt/slides/slide1.xml');
    if (!sh) return 'shapes 里没有那张造出来的 slide1';
    if (sh.elementKinds !== DUMP_SHAPE_CAP + 2) bad.push(`元素种类该实数报 ${DUMP_SHAPE_CAP + 2}（root 一个 + 造的 ${DUMP_SHAPE_CAP + 1} 个），实为 ${sh.elementKinds}`);
    if (sh.elementTop.length !== DUMP_SHAPE_CAP) bad.push(`elementTop 该截在 ${DUMP_SHAPE_CAP} 条，实为 ${sh.elementTop.length}`);
    if (c0.j.truncated !== true) bad.push('截断了却没自报 truncated=true（静默截断是禁的形状）');
    if (!c0.j.caps || c0.j.caps.shapeCap !== DUMP_SHAPE_CAP) bad.push('caps 没把用的上限一起自报（调用方没法判断"这是全部还是截过"）');
    // ② 扫描体积上限：造一个解压后超 DUMP_SCAN_MAX_BYTES 的部件（全空格，deflate 后很小，造得起）
    const bigDoc = `${S}/dump-big.pptx`;
    fs.writeFileSync(bigDoc, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CTp) },
      { name: 'ppt/presentation.xml', data: Buffer.from(`<?xml version="1.0"?><p:presentation xmlns:p="${Pp}"/>`) },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from('<?xml version="1.0"?><root>' + ' '.repeat(DUMP_SCAN_MAX_BYTES) + '</root>') },
    ]));
    const b0 = DP(bigDoc);
    if (!b0.j || b0.j.ok !== true) return '体积上限夹具跑不起来：' + String(b0.p.stdout).replace(/\s+/g, ' ').slice(0, 120);
    const bsh = b0.j.shapes.find((x) => x.part === 'ppt/slides/slide1.xml');
    if (!bsh || !bsh.skipped || !/超过/.test(bsh.skipped)) bad.push('超体积的部件没被点名 skipped（静默跳过的形状）：' + JSON.stringify(bsh));
    if (b0.j.truncated !== true) bad.push('体积截断没自报 truncated');
    if (!b0.j.parts.find((x) => x.name === 'ppt/slides/slide1.xml')) bad.push('超体积的部件仍应出现在**部件清单**里（只是不扫内容）');
    // ③ 正文条目上限：DUMP_TEXT_MAX_ITEMS+20 段
    const runs = Array.from({ length: DUMP_TEXT_MAX_ITEMS + 20 }, (_, i) => `<w:r><w:t>条目${i}</w:t></w:r>`).join('');
    const longDoc = `${S}/dump-long.docx`;
    fs.writeFileSync(longDoc, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p>${runs}</w:p></w:body></w:document>`));
    const l0 = DP(longDoc, ['--text']);
    if (!l0.j || l0.j.ok !== true) return '正文条目上限夹具跑不起来：' + String(l0.p.stdout).replace(/\s+/g, ' ').slice(0, 120);
    if (l0.j.text.items !== DUMP_TEXT_MAX_ITEMS) bad.push(`正文条目该截在 ${DUMP_TEXT_MAX_ITEMS}，实为 ${l0.j.text.items}`);
    if (l0.j.text.truncated !== true || l0.j.text.cap !== DUMP_TEXT_MAX_ITEMS) bad.push('text 层没自报截断与上限：' + JSON.stringify({ truncated: l0.j.text.truncated, cap: l0.j.text.cap }));
    // ④ --part 未知走候选（复用 R1-b 那一层，不是自己再写一套）
    const u0 = DP(cnPath, ['--part', 'word/docuemnt.xml']);
    if (!u0.j || u0.j.ok !== false || u0.j.code !== 'invalid-output') bad.push('未知部件名应 invalid-output，实为 ' + JSON.stringify(u0.j && { ok: u0.j.ok, code: u0.j.code }));
    else if (!(u0.j.candidates || []).includes('word/document.xml')) bad.push('未知部件名没回候选：' + JSON.stringify(u0.j.candidates));
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });

  // ---- R4-a（任务书 P2-1）：verify 两条取字路线对账。判据分三条，各自有独立变异：
  //      J1 正向零差异 + 计数之间的关系（M44 覆盖率恒 1.0、M45 幻影清单取自 A）
  //      J2 反向有牙：文本层有、渲染层读不出的码点必须被点名（M83 missing 判定短路）
  //      J3 半条与降级：PDF 必须自报 render-only 且不宣称可验、OLE 前置拒绝、缺 tesseract 走 unavailable（M85 mode 谎报、M84 拆在位守卫）
  const VK = (f, extra, envExtra) => {
    const p = spawnSync(process.execPath, [__filename, 'verify', f, ...(extra || [])], { encoding: 'utf8', env: envExtra ? { ...process.env, ...envExtra } : process.env });
    let j = null; try { j = JSON.parse(p.stdout); } catch {}
    return { p, j, err: j ? '' : (String(p.stdout).replace(/\s+/g, ' ').slice(0, 120) || '(无输出)') };
  };
  // texts 里给一个 '@PAGE@' 就插一个分页符（它自己不产出文本行）⇒ A 侧是**文档级**行数、B 侧是**每页**行数，
  // 两者必然不等，"幻影清单到底从哪一侧取"才有可分辨的靶（单页夹具里两侧都是 3，M45 当场看不出来）。
  const vkDocx = (file, texts) => fs.writeFileSync(file, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body>${texts.map((t) => t === '@PAGE@' ? `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` : `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`));
  t('verify 正向：合成 ASCII 文档两条路线零差异，且覆盖率是算出来的不是报出来的（默认不回显行文本）', () => {
    // F-1（v1.6.2）：缺 tesseract ⇒ 整条 skip 并逐条点名。守卫只看 exe 路径存在性（不用 tesseractProbe().available）：
    // exe 在位但坏（--version 挂）时 available 也会翻 false，那会把"在位但功能坏"的真回归也吞成 SKIP——
    // 存在性守卫让第三臂（在位但坏 ⇒ 照跑 ⇒ 红）保得住。本条两条取字路线全是现场面，无静态半段可代跑，如实点名。
    if (!fs.existsSync(TESSERACT_EXE)) return `skip（本机无 tesseract（解析 ${TESSERACT_EXE}）：verify 正向的两条取字路线全现场面，无静态半段可代跑——降级形状由「verify 的半条与降级」的无 OCR 分支与 ocr 降级判据覆盖；不冒充通过）`;
    const bad = [];
    const okDoc = `${S}/vfy-ok.docx`, halfDoc = `${S}/vfy-half.docx`;
    vkDocx(okDoc, ['ALPHA ONE 12345', 'BRAVO TWO 67890', '@PAGE@', 'CHARLIE THREE']);
    const v0 = VK(okDoc);
    if (!v0.j || v0.j.ok !== true) return '正向夹具跑不起来：' + (v0.j ? v0.j.code + ' ' + String(v0.j.error).slice(0, 140) : v0.err);
    if (v0.j.mode !== 'both') bad.push('文字族应走两条路线，实为 ' + v0.j.mode);
    if (v0.j.aLines !== 3) bad.push('A 路线行数应为 3，实为 ' + v0.j.aLines);
    if (v0.j.missingInB.count !== 0) bad.push(`正向夹具被读丢了 ${v0.j.missingInB.count} 行（合成 ASCII 字模本机可读，这里必须 0）`);
    if (v0.j.phantomInB.count !== 0) bad.push(`正向夹具报出幻影 ${v0.j.phantomInB.count} 行 ⇒ 幻影清单的对照方向可能取反了（它该是"B 有而 A 没有"）`);
    if (v0.j.coverage !== 1) bad.push('正向覆盖率应为 1，实为 ' + v0.j.coverage);
    if (v0.j.clean !== true) bad.push('正向应自报 clean=true');
    const blob0 = JSON.stringify(v0.j);
    if (blob0.includes('ALPHA ONE') || blob0.includes('CHARLIE')) bad.push('默认（不带 --show）就把行文本带进回报了（承重 2/3）');
    if (!Array.isArray(v0.j.pages) || v0.j.pages.length !== 2 || v0.j.pages.some((p) => typeof p.darkRatio !== 'number')) bad.push('正向夹具应为两页且每页都有非白像素占比，实为 ' + JSON.stringify((v0.j.pages || []).map((p) => [p.page, p.darkRatio])));
    // 🔴 phantom 的定义式：它是"这一页 OCR 出来、文本层没有的行" ⇒ 必须 = 该页 ocrLines − 该页 matchedInA，且永不超过该页行数。
    //    没有这条，把清单换成 A 侧长度（M45）在"两边行数恰好相等"的夹具上照样绿。
    const defCheck = (tag, pages) => {
      for (const pg of pages || []) {
        if (pg.phantom !== pg.ocrLines - pg.matchedInA) bad.push(`${tag}：第 ${pg.page} 页 phantom=${pg.phantom} ≠ ocrLines(${pg.ocrLines}) − matchedInA(${pg.matchedInA}) ⇒ 幻影清单不是从渲染层取的`);
        if (pg.phantom > pg.ocrLines || pg.phantom < 0) bad.push(`${tag}：第 ${pg.page} 页幻影数越界（${pg.phantom} / 共 ${pg.ocrLines} 行）`);
      }
    };
    defCheck('正向', v0.j.pages);
    if (v0.j.coverage !== +((v0.j.aLines - v0.j.missingInB.count) / v0.j.aLines).toFixed(5)) bad.push('覆盖率与 missing 计数不满足同一个算式（字段之间的关系断了）');
    // 🔴 反面对照（同一条判据里必须有一例"读不出"），否则 coverage 恒 1.0 也照样绿——M44 就是打这一层
    const RARE = String.fromCodePoint(0x2A6B2);
    vkDocx(halfDoc, ['ALPHA ONE 12345', 'SECOND LINE ' + RARE + ' MISSING', 'CHARLIE THREE']);
    const v1 = VK(halfDoc);
    if (!v1.j || v1.j.ok !== true) bad.push('反面对照夹具跑不起来：' + (v1.j ? v1.j.code : v1.err));
    else {
      if (!(v1.j.coverage < 1)) bad.push(`含无字形码点的那一行 coverage 仍报 ${v1.j.coverage} ⇒ 覆盖率是算出来的还是报出来的？`);
      if (v1.j.missingInB.count !== 1) bad.push('反面对照应点名 1 行读不出，实为 ' + v1.j.missingInB.count);
      if (v1.j.clean !== false) bad.push('有行读不出却仍自报 clean');
      if (v1.j.coverage !== +((v1.j.aLines - v1.j.missingInB.count) / v1.j.aLines).toFixed(5)) bad.push('反面对照下覆盖率算式不自洽');
      defCheck('反向', v1.j.pages);
    }
    // --show 才给字符串，且给的就是被点名的那一行
    const v2 = VK(halfDoc, ['--show']);
    if (!v2.j || v2.j.ok !== true) bad.push('--show 跑不起来');
    else if (!(v2.j.missingInB.lines || []).length || String(v2.j.missingInB.lines[0]).indexOf(RARE) < 0) bad.push('--show 了却不给那一行原文（或给的不对）');
    else if (v2.j.missingInB.lineIndexes[0] !== 2) bad.push('missing 的行号不对，实为 ' + JSON.stringify(v2.j.missingInB.lineIndexes));
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  }, {needs:'kit'});
  t('verify 反向有牙：文本层写着、渲染层画不出的码点必须被点名（豆腐块像素挡不住这条）', () => {
    // F-1（v1.6.2）：同 J1 的存在性守卫——在位但坏时照跑（第三臂保得住），缺失时 skip 点名。
    if (!fs.existsSync(TESSERACT_EXE)) return `skip（本机无 tesseract（解析 ${TESSERACT_EXE}）：verify 反向的全部分支都要真跑 OCR，无静态半段可代跑——不冒充通过）`;
    const bad = [];
    const f = `${S}/vfy-glyph.docx`;
    const RARE = String.fromCodePoint(0x2A6B2);
    vkDocx(f, ['FIRST PLAIN LINE 42', 'SECOND ' + RARE + RARE + ' TAIL LINE 43']);
    const v = VK(f);
    if (!v.j || v.j.ok !== true) return '夹具跑不起来：' + (v.j ? v.j.code + ' ' + String(v.j.error).slice(0, 120) : v.err);
    // ① A 路线必须真拿到那个码点（否则这条红在"没写进去"而不是"画不出"）
    const shown = VK(f, ['--show']);
    const missingText = (shown.j && shown.j.missingInB.lines || []).join('');
    if (!missingText.includes(RARE)) bad.push('A 路线（to txt）里没拿到那个无字形码点 ⇒ 夹具没生效，这条红不是字形层的红');
    // ② B 路线读不出 ⇒ 必须点名
    if (v.j.missingInB.count < 1) bad.push('文本层写着、渲染层读不出的行没被点名 ⇒ verify 白跑');
    // ③ 那一页必须有墨（像素证据挡不住这条，正是它存在的理由）
    const pg = (v.j.pages || [])[0];
    if (!pg || !(pg.darkRatio > 0)) bad.push('该页非白像素占比应为正（有豆腐块也有字），实为 ' + JSON.stringify(pg && pg.darkRatio));
    if (v.j.clean !== false) bad.push('有行读不出却 clean=true');
    // ④ 明细方向不许反：B 有而 A 没有才叫幻影
    if (typeof v.j.phantomInB.count !== 'number') bad.push('phantomInB.count 缺失');
    if (!/像素|字形|OCR 有自身错误率/.test(String(v.j.caveat))) bad.push('caveat 没写清"非零先怀疑两处"，调用方会直接判文档坏了');
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  }, {needs:'kit'});
  await ta('verify 的半条与降级：数字 PDF 走双条；扫描件/缺 pdftotext 自报 render-only 不宣称可验；OLE 前置拒绝；缺 tesseract unavailable', async () => {
    const bad = [];
    // OLE 前置拒绝分支不依赖 tesseract（守卫在 OCR 之前），无 OCR 面照跑；PDF 双条与缺 tesseract 分支要真跑 OCR。
    const noTess = !fs.existsSync(TESSERACT_EXE);
    const noPoppler = !popplerTool('pdftotext').present;
    // 用"扩展名不在 FORMAT_MATRIX 内"的输入验前置拒绝（.doc 在矩阵内，真 OLE 会被引擎判 invalid-document——那是第八节第 4 条已登记的边界，不是这一条要测的）
    // F-1（v1.6.2）：这个分支不依赖 tesseract（前置守卫在 OCR 之前），**无 OCR 面照跑**，缺依赖时不许跟着整条 skip。
    const ole = `${S}/vfy-bare.zip`;
    fs.writeFileSync(ole, zipWrite([{ name: 'readme.txt', data: Buffer.from('两族都不是的裸 ZIP') }]));
    const vo = VK(ole);
    if (!vo.j || vo.j.ok !== false || vo.j.code !== 'unsupported-format') bad.push('矩阵外扩展名应前置 unsupported-format，实为 ' + JSON.stringify(vo.j && { ok: vo.j.ok, code: vo.j.code }));
    if (vo.p.status !== 1) bad.push('前置拒绝的退码应为 1，实为 ' + vo.p.status);
    if (noTess || noPoppler) {
      return bad.length ? bad.slice(0, 6).join(' | ')
        : `skip（PDF 双条需 tesseract 与 poppler pdftotext：${noTess ? 'tesseract 不在位' : ''}${noPoppler ? 'pdftotext 不在位' : ''}；OLE 前置拒绝分支已照跑且通过，PDF 双条未测——不冒充通过）`;
    }
    // 数字 PDF（docx 转换、带文本层）：mode=both，文本层与渲染层都有行（不要求 clean，OCR 有自身误差）
    const src = `${S}/vfy-pdfsrc.docx`;
    vkDocx(src, ['LINE FOR PDF BOTH ROUTE 7']);
    const pdf = `${S}/vfy-both.pdf`;
    const cv = runKit(['convert', '--input', src, '--output', pdf, '--timeout-ms', '60000']);
    if (!cv.ok) return 'PDF 夹具做不出来：' + cv.code + ' ' + String(cv.error).slice(0, 120);
    const v = VK(pdf, ['--lang', 'eng']);
    if (!v.j || v.j.ok !== true) bad.push('数字 PDF 应能跑，实为：' + (v.j ? v.j.code + ' ' + String(v.j.error).slice(0, 100) : v.err));
    else {
      if (v.j.mode !== 'both') bad.push('数字 PDF 应自报 mode=both，实为 ' + v.j.mode);
      if (!/pdftotext/.test(String(v.j.textRoute))) bad.push('textRoute 没说明走 pdftotext：' + v.j.textRoute);
      if (!(v.j.aLines >= 1) || !(v.j.bLines >= 1)) bad.push(`双条都应有行，aLines=${v.j.aLines} bLines=${v.j.bLines}`);
    }
    // 扫描件 PDF（纯图片、无文本层）：把渲染 PNG 用 pdf-lib 嵌进新 PDF，mode=render-only、clean=null
    const pl = loadPdfLib();
    if (pl.error) bad.push('pdf-lib 不在位，扫描件夹具造不出（' + pl.error + '）');
    else {
      const pgDir = freeDir(TMP_DIR, `vfy-scan-${stamp()}`);
      const rr = runKit(['render', '--input', pdf, '--output-dir', pgDir, '--timeout-ms', '60000']);
      if (!rr.ok || !(rr.images || []).length) bad.push('扫描件夹具的 PNG 渲染失败');
      else {
        const nd = await pl.lib.PDFDocument.create();
        const img = await nd.embedPng(fs.readFileSync(rr.images[0].path));
        const W = 612, H = 792, sc = Math.min(W / img.width, H / img.height), w = img.width * sc, h = img.height * sc;
        nd.addPage([W, H]).drawImage(img, { x: 0, y: H - h, width: w, height: h });
        const scanPdf = `${S}/vfy-scan.pdf`;
        fs.writeFileSync(scanPdf, await nd.save());
        const vs = VK(scanPdf, ['--lang', 'eng']);
        if (!vs.j || vs.j.ok !== true) bad.push('扫描件应能跑渲染半条，实为：' + (vs.j ? vs.j.code + ' ' + String(vs.j.error).slice(0, 100) : vs.err));
        else {
          if (vs.j.mode !== 'render-only') bad.push('扫描件应自报 mode=render-only，实为 ' + vs.j.mode);
          if (vs.j.clean !== null) bad.push('扫描件半条路线不许给 clean 结论，实为 ' + JSON.stringify(vs.j.clean));
          if (!/文本层为空|扫描件/.test(String(vs.j.note || ''))) bad.push('没在回报里写明扫描件退回原因');
          if (vs.j.missingInB.count !== null) bad.push('render-only 不该报 missing 计数：' + JSON.stringify(vs.j.missingInB.count));
        }
        try { fs.rmSync(pgDir, { recursive: true, force: true }); } catch {}
      }
    }
    const vd = VK(src, [], { DOCKIT_TESSERACT: 'Z:\\definitely\\missing\\tesseract.exe' });
    if (!vd.j || vd.j.ok !== false || vd.j.code !== 'unavailable') bad.push('缺 tesseract 应回 unavailable（不许半跑半成），实为 ' + JSON.stringify(vd.j && { code: vd.j.code }));
    if (vd.p.status !== 1) bad.push('降级路径退码应为 1，实为 ' + vd.p.status);
    if (!/DOCKIT_TESSERACT/.test(String(vd.j && vd.j.next))) bad.push('降级没指路环境变量：' + String(vd.j && vd.j.next).slice(0, 90));
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  }, {needs:'kit'});
  // ---- R4-b（任务书 P5-1）：factcheck 核文档里的时点事实。四类断言各配一个**已知错样本**（合同要求），
  //      外加两条"豁免不许扩大化"的对照：日志的历史数字不判错，但日志里把 rev-list 列义写反仍要判错。
  t('factcheck 时点事实：左右列语义不许写反、四类断言各有已知错样本、日志豁免不许扩大到语义', () => {
    const FC = (doc) => { const p = spawnSync(process.execPath, [__filename, 'factcheck', '--doc', doc], { encoding: 'utf8', cwd: ROOT }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const bad = [];
    // ⓪ 现值本身：左右列不许被换位置（左列＝只在 upstream 有的提交＝落后）。这是 M46 的靶。
    const c0 = FC('README.md');
    if (!c0.j || c0.j.ok !== true) return 'factcheck 跑不起来：' + (c0.j ? c0.j.code + ' ' + String(c0.j.error).slice(0, 120) : String(c0.p.stdout).slice(0, 120));
    const rawCols = String(c0.j.live.revListRaw || '').split(/\s+/).filter(Boolean).map(Number);
    // 公开树版（v3.0.1 开源化轮）：上游引用改为按 origin/<当前分支>→main→master 探测；
    // 全新孤儿仓（尚未 push）没有远端 ⇒ upstreamMissing=true 是**机器事实**，跳过列义对账（M46 的靶由下方自带夹具仓库独立覆盖）。
    if (c0.j.live.upstreamMissing) {
      // 无远端：只核"探测器没有瞎报一个 upstream"，列义对账由夹具仓库那半独立跑。
      if (c0.j.live.upstream) bad.push('upstreamMissing=true 却仍报了 upstream=' + c0.j.live.upstream + '（探测器自相矛盾）');
    } else if (rawCols.length !== 2) return 'rev-list 现值取不到两列：' + JSON.stringify(c0.j.live.revListRaw) + ' / ' + String(c0.j.live.revListError || '');
    else if (c0.j.live.behind !== rawCols[0] || c0.j.live.ahead !== rawCols[1]) bad.push(`左右列被换位置了：raw=${JSON.stringify(rawCols)} 却报 behind=${c0.j.live.behind} ahead=${c0.j.live.ahead}（左列＝落后是 --left-right 的定义）`);
    // 第二把尺（M46 的真正靶）：range 单向计数与 --left-right 的两列必须互相印证，与"两列是否相等"无关
    // 🔴 自带夹具仓库：init 一笔 base、开分支 up 指向 base，再提交一笔 ⇒ 左列必为 0、右列必为 1，两列**结构上不相等**。
    // 这样 M46（互换左右列）在任何同步状态下都能变红；上一版拿真实仓库的那一行自证，遇到 origin/main 追平 HEAD（现测 `0 0`）就成了假牙。
    {
      const GR = path.join(TMP_DIR, `fc-repo-${stamp()}`);
      const gitc = (a) => spawnSync('git', a, { encoding: 'utf8', cwd: GR });
      try {
        fs.mkdirSync(GR, { recursive: true });
        const idN = spawnSync('git', ['config', '--get', 'user.name'], { encoding: 'utf8', cwd: ROOT }).stdout;
        const idE = spawnSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8', cwd: ROOT }).stdout;
        const ident = ['-c', 'user.name=' + String(idN || 'x').trim(), '-c', 'user.email=' + String(idE || 'x').trim()];
        const gi = gitc(['init', '-q', '.']);
        if (gi.status !== 0) bad.push('夹具 git init 失败：' + String(gi.stderr || gi.stdout).slice(0, 80));
        else {
          fs.writeFileSync(path.join(GR, 'a.txt'), 'base' + String.fromCharCode(10));
          gitc([...ident, 'add', '-A']); const c1 = gitc([...ident, 'commit', '-q', '-m', 'base']);
          gitc(['branch', 'up']);
          fs.writeFileSync(path.join(GR, 'b.txt'), 'ahead' + String.fromCharCode(10));
          gitc([...ident, 'add', '-A']); const c2 = gitc([...ident, 'commit', '-q', '-m', 'two']);
          if (c1.status !== 0 || c2.status !== 0) bad.push('夹具提交没跑成：c1=' + c1.status + ' c2=' + c2.status);
          else {
            const fp = spawnSync(process.execPath, [__filename, 'factcheck', '--repo', GR, '--upstream', 'up', '--head', 'HEAD', '--doc', 'a.txt'], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
            let fj = null; try { fj = JSON.parse(fp.stdout); } catch {}
            if (!fj || !fj.live) bad.push('夹具仓库上 factcheck 没出 live：' + String(fp.stdout || fp.stderr).slice(0, 120));
            else {
              const fr = String(fj.live.revListRaw || '').split(/\s+/).filter(Boolean).map(Number);
              if (fr[0] !== 0 || fr[1] !== 1) bad.push('夹具仓库的列应当是 0 1，实为 ' + JSON.stringify(fr) + '（夹具本身坏了，后面的对账不算数）');
              else if (fj.live.behind !== 0 || fj.live.ahead !== 1) bad.push(`夹具仓库上左右列被换位置了：raw=0 1 却报 behind=${fj.live.behind} ahead=${fj.live.ahead}`);
              else if (fj.live.behindViaRange !== 0 || fj.live.aheadViaRange !== 1) bad.push(`range 第二把尺与列义不一致：behindViaRange=${fj.live.behindViaRange} aheadViaRange=${fj.live.aheadViaRange}（应为 0/1）`);
            }
          }
        }
      } finally { try { fs.rmSync(GR, { recursive: true, force: true }); } catch {} }
    }
        if (typeof c0.j.live.behindViaRange === 'number' && c0.j.live.behind !== c0.j.live.behindViaRange) bad.push(`左右列被换位置了：rev-list 单向对账说 behind=${c0.j.live.behindViaRange}（HEAD..upstream），而现值报 behind=${c0.j.live.behind}；ahead 同理 ${c0.j.live.ahead} vs ${c0.j.live.aheadViaRange}`);
    if (c0.j.live.upstreamMissing !== true && c0.j.live.aheadViaRange !== c0.j.live.ahead) bad.push(`range 计数与 --left-right 不一致：ahead=${c0.j.live.ahead} aheadViaRange=${c0.j.live.aheadViaRange}`);
    if (!/左列[^。；]{0,40}落后/.test(String(c0.j.live.columnMeaning))) bad.push('columnMeaning 没把"左列＝落后"写清楚（这条命令存在的理由就是把列义钉死）');
    if (typeof c0.j.live.dirtyFiles !== 'number' || typeof c0.j.live.untrackedFiles !== 'number') bad.push('脏文件数/孤儿文件数没取到现值');
    // ① 已知错样本：把列义写反
    const semBad = `${S}/fc-sem-bad.md`, semGood = `${S}/fc-sem-good.md`;
    fs.writeFileSync(semBad, '本段的结论：rev-list 左列＝领先，右列＝落后。' + String.fromCharCode(10));
    fs.writeFileSync(semGood, '本段的结论：rev-list 左列＝落后，右列＝领先。' + String.fromCharCode(10));
    const f1 = FC(semBad), f2 = FC(semGood);
    if (!f1.j || f1.j['判错'] < 1) bad.push('把列义写反的句子没被判错（已知错样本①没红）');
    if (!f2.j || f2.j['判错'] !== 0) bad.push('列义写对的句子被判错（哨兵过度）：' + JSON.stringify((f2.j.findings || []).filter((x) => x.verdict === 'mismatch').map((x) => x.kind)));
    // ② 已知错样本：时点计数报一个不可能相等的数
    const cnt = `${S}/fc-count.md`;
    fs.writeFileSync(cnt, '现场核对：判据条数=999999。' + String.fromCharCode(10) + '现场核对：孤儿文件数=888888。' + String.fromCharCode(10));
    const f3 = FC(cnt);
    const m3 = ((f3.j || {}).findings || []).filter((x) => x.verdict === 'mismatch' && x.kind === '时点计数');
    if (m3.length !== 2) bad.push('两处假计数应都判错，实为 ' + m3.length + '（已知错样本②）');
    if (m3.length && m3.some((x) => typeof x.live !== 'number')) bad.push('判错却没带出现场值（红要能归因）');
    // ③ 已知错样本：行数两种口径
    const nonl = `${S}/fc-nonl.txt`;
    fs.writeFileSync(nonl, 'a' + String.fromCharCode(10) + 'b');           // wc -l=1、编辑器行数=2
    const lnAmb = `${S}/fc-lines-amb.md`, lnBad = `${S}/fc-lines-bad.md`, lnOk = `${S}/fc-lines-ok.md`;
    fs.writeFileSync(lnAmb, '看 fc-nonl.txt 共 1 行。' + String.fromCharCode(10));
    fs.writeFileSync(lnBad, '看 fc-nonl.txt 共 77 行。' + String.fromCharCode(10));
    fs.writeFileSync(lnOk, '看 dockit.js 共 ' + ((fs.readFileSync(__filename, 'utf8').match(/\n/g) || []).length) + ' 行。' + String.fromCharCode(10));
    const g1 = FC(lnAmb), g2 = FC(lnBad), g3 = FC(lnOk);
    const pick = (f) => (((f.j || {}).findings) || []).filter((x) => x.kind === '行数口径');
    if (!pick(g1).some((x) => x.verdict === 'ambiguous')) bad.push('两口径不等时没报 ambiguous（已知错样本③a：' + JSON.stringify(pick(g1)) + '）');
    if (!pick(g2).some((x) => x.verdict === 'mismatch')) bad.push('行数是编的却没判错（③b）');
    if (!pick(g3).some((x) => x.verdict === 'ok')) bad.push('照现算值写的行数被判错（③c 哨兵过度）：' + JSON.stringify(pick(g3)));
    // ④ 已知错样本：否定式断言现场跑——"未提交文件为 0" 在当前脏树上必须被现场数一遍
    const negBad = `${S}/fc-neg.md`;
    fs.writeFileSync(negBad, '现场核对：没有未提交文件。' + String.fromCharCode(10) + '现场核对：孤儿文件数=0。' + String.fromCharCode(10));
    const n1 = FC(negBad);
    const nf = ((n1.j || {}).findings) || [];
    if (!nf.some((x) => x.kind === '否定式断言' && (x.verdict === 'ok' || x.verdict === 'mismatch'))) bad.push('否定式断言没被现场跑（只有 unverifiable 就等于不判）：' + JSON.stringify(nf.map((x) => [x.kind, x.verdict])));
    if (!nf.some((x) => x.kind === '时点计数' && x.name === '孤儿文件数')) bad.push('"孤儿文件数=0" 没被当成计数断言去现场核');
    // ⑤ 豁免范围：日志里的旧条数不判错，但日志里写反列义仍判错
    const logish = `${S}/迭代日志-fake.md`;
    fs.writeFileSync(logish, '历史条目原样引用：判据条数=61。' + String.fromCharCode(10) + '但这段把列义写反了：rev-list 左列＝领先。' + String.fromCharCode(10));
    const h1 = FC(logish);
    const hh = ((h1.j || {}).findings) || [];
    if (!hh.some((x) => x.verdict === 'historical' && x.kind === '时点计数')) bad.push('日志里引用旧数字没被豁免（会把每写一条历史都判红）：' + JSON.stringify(hh.map((x) => [x.kind, x.verdict])));
    if (!hh.some((x) => x.verdict === 'mismatch' && x.kind === 'rev-list 列义')) bad.push('豁免扩大到语义了——日志里把列义写反必须仍判错（这是 M87 的靶）');
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });
  // ---- 真实脏样本（机主本机文档；外人没有该文件则 SKIP，且计入总数）
  // 真件放稳定目录（躲开周期性清扫；目录见装置样本 README）。公开树版：路径走 env 优先，本机绝对路径不进源码。
  const realDoc = process.env.DOCKIT_REAL_SAMPLE || '';
  t('real 本机真实中文文档：缺字族非空（现况＝Courier 一族；GB2312 系已装载、不许重现）', () => { if (!fs.existsSync(realDoc)) return 'skip（外人无本机样本，属预期 SKIP 不是通过）'; const r = runKit(['convert', '--input', abs(realDoc), '--output', `${S}/real.pdf`, '--timeout-ms', '120000']); return r.ok && r.missingFonts?.length > 0 && !r.missingFonts.some((f) => /GB2312/i.test(f)) ? true : `missingFonts=${JSON.stringify(r.missingFonts)}（应非空且不含 GB2312 系——2026-10-10 已装载）`; }, {needs:'kit'});
  t('real 本机真实中文文档：整本渲染页数>1', () => { if (!fs.existsSync(realDoc)) return 'skip'; const r = runKit(['render', '--input', abs(realDoc), '--output-dir', `${S}/realpg`, '--timeout-ms', '120000']); return r.ok && r.pageCount > 1; }, {needs:'kit'});
  // ---- 变异对照不在这里做：判据有没有牙由常驻的 test/mutant.js（M1–M11）逐例对战，
  //      套件内自设变异只会和外部变异互相顶（外部改 FORMAT_MATRIX 时，内部这条必然"意外红"）。
  t('mutant 关掉像素证据时装置必须自报 off（不许伪造证据）', () => { const j = JSON.parse(spawnSync(process.execPath, [__filename, 'pages', cnPath, '--pixels', 'off', '--timeout-ms', '60000'], { encoding: 'utf8' }).stdout); return j.ok === true && j.pixelEvidence === 'off'; }, {needs:'kit'});
  t('flag --pixels 默认给逐 tile 证据并自报 scanned/of/truncated', () => { const j = JSON.parse(spawnSync(process.execPath, [__filename, 'pages', cnPath, '--timeout-ms', '60000'], { encoding: 'utf8' }).stdout); return j.ok === true && j.pixelEvidence.tiles.length === 1 && j.pixelEvidence.truncated === false && j.pixelEvidence.tiles[0].dark > 0; }, {needs:'kit'});

  t('pages 降级：kit 缺失时 PDF 用 poppler pdftoppm 渲染（自报 backend）；OOXML 与 poppler 也缺失时不扩大、回 unavailable', () => {
    if (!popplerTool('pdftoppm').present) return 'skip（poppler pdftoppm 不在位，降级分支无夹具可测；kit 在位时承重渲染不受影响）';
    const bad = [];
    const PG = (f, envExtra) => {
      const p = spawnSync(process.execPath, [__filename, 'pages', f, '--timeout-ms', '60000'], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...envExtra } });
      let j = null; try { j = JSON.parse(p.stdout); } catch {}
      return { p, j };
    };
    const pdf = `${S}/pg-fb.pdf`;
    const cv = runKit(['convert', '--input', cnPath, '--output', pdf, '--timeout-ms', '60000']);
    if (!cv.ok) return 'PDF 夹具做不出来：' + cv.code + ' ' + String(cv.error).slice(0, 120);
    const km = { DOCKIT_KIT_CLI: 'Z:\\__no_kit_pages__\\cli.js' };
    // ① PDF + kit 缺失 + poppler 在位 ⇒ 降级
    const a = PG(pdf, km);
    if (!a.j || a.j.ok !== true) bad.push('PDF 应能降级渲染，实为：' + (a.j ? a.j.code + ' ' + String(a.j.error).slice(0, 100) : '(无 JSON)'));
    else {
      if (a.j.backend !== 'poppler(fallback)') bad.push('应自报 backend=poppler(fallback)，实为 ' + a.j.backend);
      if (a.j.rasterEngine !== 'pdftoppm') bad.push('rasterEngine 应为 pdftoppm，实为 ' + a.j.rasterEngine);
      if (!(a.j.pageCount >= 1) || !(a.j.tiles || []).length) bad.push('降级应有页与 tile，pageCount=' + a.j.pageCount);
      if (!a.j.tiles.every((t) => t.w && t.h)) bad.push('降级 tile 缺 w/h');
      if (!/降级/.test(JSON.stringify(a.j.warnings))) bad.push('降级没在 warnings 点名');
    }
    // ② OOXML + kit 缺失 ⇒ 不许扩大，回 unavailable
    const b = PG(cnPath, km);
    if (!b.j || b.j.ok !== false || b.j.code !== 'unavailable') bad.push('OOXML 不许降级，应回 unavailable，实为 ' + JSON.stringify(b.j && { code: b.j.code }));
    // ③ PDF + kit 缺失 + poppler 也缺失 ⇒ 无降级，回 unavailable
    const c = PG(pdf, { ...km, DOCKIT_POPPLER_BIN: 'Z:\\__no_poppler__\\bin' });
    if (!c.j || c.j.ok !== false || c.j.code !== 'unavailable') bad.push('poppler 也缺失时应回 unavailable，实为 ' + JSON.stringify(c.j && { code: c.j.code }));
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  }, {needs:'kit'});

  await ta('throughput 串行 3 次转换都成功并自报耗时（不设墙上时间门：那是负载量不是正确性）', async () => {
    const ms = [];
    for (let i = 0; i < 3; i++) {
      const r = runKit(['convert', '--input', cnPath, '--output', `${S}/tp${i}.pdf`, '--timeout-ms', '30000']);
      if (!r.ok) return '第 ' + i + ' 次失败：' + r.code + ' ' + r.error;
      ms.push(r.ms);
    }
    return ms.every((x) => Number.isInteger(x) && x > 0 && x < 30000) ? true : '单次耗时越界：' + JSON.stringify(ms);
  }, {needs:'kit'});

  // ---- R-A（v1.6.4）依赖覆盖率闸（任务书 R-A 主件）。理由：本仓同一形状**连犯三次**——D-1 后端族 → F-1 tesseract 族 →
  //      G-1 kit 族，每次只给"刚被踩到的族"补守卫，没人闸住"以后新增一条吃外部依赖却忘了带声明"。咽喉层兜底（t/ta 的
  //      依赖缺失探针）解决"现状全绿"，这条闸解决"以后不复发"：缺失态下被 SKIP 的**集合逐字**钉死为注册表（v1.6.5 起不再只比条数），
  //      多一条（新判据吃 kit 没登记）少一条（该 SKIP 的没 SKIP）、以及**成员被换掉而条数不变**的，都必须红。
  //      注册值来源：2026-10-06 机器枚举（方法与清单见迭代日志 v1.6.4）初版 50 条候选，与缺失态**实测**对账后钉死：
  //      注册值＝52（v1.6.4 初版 48＝缺失态实测 SKIP 49 − 闸自身不递归 1；含 2 条经守卫修复的缺失态假绿、7 条经定性剔除的枚举误报，
  //      逐条定性见迭代日志；v1.8.0 增 olealign 四判据 ⇒ 52；v1.9.0 增 batch 两判据 ⇒ 54，仍按缺失态实测逐字对账）。🔴 新增吃 kit 的判据 ⇒ 同步**注册表成员**（只许跟着机器实测改，**改的是期望值不是松紧**）。
  t('依赖覆盖率闸：kit 缺失态被 SKIP 的判据集合必须逐字等于注册值（防"新增判据吃依赖忘带声明"——本仓同形状已连犯三次）', () => {
    if (!resolveKitCli().present) return 'skip（覆盖率闸自身不递归：本进程已在 kit 缺失模拟态，闸只在在位态运行）';
    // 注册表＝2026-10-06 真实 kit 缺失态 selftest 的机器导出（读数 项目审查意见/_mon-arm1.json，生成脚本
    // _mon-gen-registry.js；48 条、去重无重名）。v1.6.5（机主裁 Q-1）：硬断言由「条数＋12 关键成员」改成
    // **集合逐字相等**——旧口径下「一进一出保条数 48」会静默绿。监工侧实测过这条洞：无 .git 的副本里
    // factcheck 那条因缺 .git 被事后洗白成 SKIP，整跑自报 failed=0。改注册表只许跟着机器实测改。
const DEP_SKIP_REGISTRY = [
    "batch 批量转换：清单计数、产物与原件零改动",
    "batch 混合失败：单件失败不拖垮、整体判负",
    "cap 能力矩阵与 kit 实测对账",
    "check --backend 两条路线：zip 是默认且不起引擎，officecli 只回 schema 结论；缺后端不改 clean 也不红；未知值拒",
    "code pages 区间写法被拒（只认 all 或逗号列表）",
    "code 伪装件 → invalid-document",
    "code 对 docx 用 --range 被拒",
    "code 族外转换 → unsupported-format",
    "code 缺输入文件 → ENOENT 原样透出",
    "code 超时 → timeout",
    "code 输入超限 → input-too-large",
    "code 输出超限 → output-too-large",
    "code 页码越界被拒且文案带真实页数",
    "doc ADR-002 在册：四段行首齐、排除项同行点名、钉住的 exe sha256 与盘上实算一致",
    "edit 承重形状：产物名是 -work.、原件 sha 前后全等、判据独立回读副本、--out 撞车即拒、族外与缺 --type 都拒",
    "entry 登记表：entry-points.json 里每个非空的入口文件绝对路径必须存在",
    "env doctor 全绿",
    "flag --pixels 默认给逐 tile 证据并自报 scanned/of/truncated",
    "flag font-fallbacks 不改变缺字自曝（补了替换也不能宣称不缺字）",
    "flag font-fallbacks 二维数组可用",
    "flag font-fallbacks 单名必须被拒",
    "guard 同一输出再跑必须失败（不覆盖）",
    "guard 输入=输出被拒",
    "guard 输出目录父级不存在时报 ENOENT（装置负责建父级）",
    "help Qoder skill 与调用卡都覆盖命令面（漂移=别的 agent 学到旧用法）",
    "merge 承重形状：模板零改动、值真填进去且占位符不残留、空对象与非标量拒、输出撞车拒且不传后端 --force",
    "meta PDF 含 XMP 包（元数据面不止 /Info）",
    "meta 转出的 PDF 里作者串真的在（这族泄漏面成立）",
    "mutant 关掉像素证据时装置必须自报 off（不许伪造证据）",
    "olealign-broken 非对齐且内容真坏：修复尝试后仍失败（勿吞错）",
    "olealign-noop 已对齐 OLE 不许走修复（无差别修复＝越权）",
    "olealign-pages 非对齐 OLE：pages 同走副本对齐修复并自报",
    "olealign-to 非对齐 OLE：to 自动副本对齐修复并自报（原文件零改动）",
    "pages 降级：kit 缺失时 PDF 用 poppler pdftoppm 渲染（自报 backend）；OOXML 与 poppler 也缺失时不扩大、回 unavailable",
    "pdftext 直取文本层（数字中文 PDF 免 OCR）：txt 含已知中文、chars>0、正文不回显进 JSON",
    "pipeline DAG：依赖、条件分支、拓扑序、环与未知 id 都拦（v2.7.0 通用 DAG 落地）",
    "pipeline 步序列：逗号 flow 驱动（未知步拒、无 to 的非 PDF 拒、to 不在首位拒、正向 to,pdftext、旧名仍可用）",
    "pix 有字页非白像素 > 0",
    "pix 空白对照页非白像素 = 0（这条红了说明像素判据本身坏了）",
    "real 本机真实中文文档：整本渲染页数>1",
    "real 本机真实中文文档：缺字族非空（现况＝Courier 一族；GB2312 系已装载、不许重现）",
    "recalc --report-errors 逐格公式错误地图：#DIV/0!/#NAME? 分类型计数、Sheet!Cell 清单、total_formulas，正文不回显",
    "recalc 不碰原件（原件哈希不变）",
    "recalc 公式未被拍平（<f 仍在）",
    "recalc 前直接导 csv 会带出陈旧值（这条红了=陈旧值风险判据坏了）",
    "recalc 把故意留错的缓存值 999 纠正为 9（真实脏样本）",
    "recalc 无缓存公式被算出（B1=A1*2 → 6）",
    "scrub --verify 转 PDF 后作者串零残留（含检查条数>0，防空对空）",
    "scrub 产物可被 kit 正常打开（改过 ZIP 不算坏文件）",
    "scrub 双向自证：未清的产物含作者串、清过的不含",
    "scrub 的 ODF 面：meta.xml 九个目标字段全清、Thumbnails 条目删除、产物可开且四件套与原件一致",
    "sheet zip 路线枚举名与 render 路线一致",
    "sheet 双表出 csv 不给 --sheet 必须被拒（防静默只导第一张）",
    "sheet 双表指定表名出 csv 内容对得上那张表",
    "syn-content 转 txt 后已知中文串逐字在位",
    "syn-content-no-replacement 转出的文本无替换符",
    "syn-font-negative PDF 侧 missingFonts 为空（反向用例）",
    "syn-font-positive 故意声明的族被 missingFonts 报出",
    "syn-pdf-pagecount 渲染给回页数=1",
    "tables 几何抽取：docx 带边框表格转 PDF 后逐格相等；无网格回空且不猜表",
    "throughput 串行 3 次转换都成功并自报耗时（不设墙上时间门：那是负载量不是正确性）",
    "v1 版本号五处一致（package.json / 本文件 / 项目总览 / README / 调用卡）",
    "verify 反向有牙：文本层写着、渲染层画不出的码点必须被点名（豆腐块像素挡不住这条）",
    "verify 正向：合成 ASCII 文档两条路线零差异，且覆盖率是算出来的不是报出来的（默认不回显行文本）",
    "verify 的半条与降级：数字 PDF 走双条；扫描件/缺 pdftotext 自报 render-only 不宣称可验；OLE 前置拒绝；缺 tesseract unavailable",
    "入口数字与源对账：文档写的「非空入口数=<N>」必须等于 entry-points.json 现算的非空路径条数（数字靠人记一定烂）",
    "后端二进制与隔离 env 自曝：调用前后各取一次身份章，换了就在 warnings 里点名；回报里不回传后端 stdout",
    "后端留档件实算：bin/archive/officecli-win-x64-<版本>.exe 的 sha256 必须逐字等于登记枚集",
    "后端调用审计：每一次真起子进程调后端都必须落一行自报 env 与二进制前后哈希的审计，没起子进程的路径一行都不许多写",
    "登记表字段互不矛盾：状态称已落盘/已活验的行必须有非空入口路径，路径非空的行状态不许写\"未落盘\"",
    "装置 to 多表出 csv 时前置拒绝，next 里给出准确表名，且不落半成品文件",
    "装置 to 默认输出落 _out 不碰原件"
];
    const r = spawnSync(process.execPath, [__filename, 'selftest'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 420000, env: Object.assign({}, process.env, { DOCKIT_KIT_CLI: 'Z:\\__no_kit_for_gate__\\cli.js' }) });
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    if (!j) return '缺失态子 selftest 跑不出 JSON：' + String(r.stdout || r.stderr).slice(0, 140);
    // 🔴 v1.7.2：子进程可能吐的是**die 信封**（合法 JSON，但没有 checks）——那时 `j.failed` 是 undefined，
    // 旧写法会报成"failed=undefined（剔除控制组 0 条后应为 0）"，把人指去查判据集合，而真相是子进程崩了。
    // 红必须带因（规范 §4.4 第 6 条）：这里直接把信封里的 code+error 提出来。
    if (!Array.isArray(j.checks)) return '缺失态子 selftest 没交出自测结果（拿到的是 die 信封，不是 selftest 输出）：' + kidErr(r.stdout) + '｜退出码=' + r.status + ' signal=' + (r.signal || '无');
    // aud1-stub 是故意放的缺失态必红控制组（AUD-1 哨兵本体，无依赖声明）——它的红是正确行为，
    // 闸断言的是"剔除控制组后无红"；若它被洗成 SKIP 反而要红（见第四臂哨兵）。
    const stubFails = (j.checks || []).filter((c) => c.startsWith('FAIL') && c.includes('aud1-stub'));
    if (j.failed !== stubFails.length) return `kit 缺失态子 selftest failed=${j.failed}（剔除 aud1-stub 控制组 ${stubFails.length} 条后应为 0）：` + (j.checks || []).filter((c) => c.startsWith('FAIL') && !c.includes('aud1-stub')).slice(0, 3).join(' | ');
    // 剔除闸自身与第四臂哨兵（两者在缺失态子进程里按"设施自身不递归"口径 SKIP，不属于被闸的依赖集合）
    const skips = (j.checks || []).filter((c) => c.startsWith('SKIP')).map((c) => c.slice(5, c.indexOf(' :: ') < 0 ? undefined : c.indexOf(' :: '))).filter((s) => !s.includes('依赖覆盖率闸') && !s.includes('AUD-1 第四臂哨兵'));
    const uniq = [...new Set(skips)];
    if (uniq.length !== skips.length) return `SKIP 集合 ≠ 注册值：实测出现重名（共 ${skips.length} 条／去重 ${uniq.length} 条），逐字对账失去意义`;
    const extra = uniq.filter((x) => !DEP_SKIP_REGISTRY.includes(x));
    const missing = DEP_SKIP_REGISTRY.filter((x) => !uniq.includes(x));
    if (extra.length || missing.length) {
      return `SKIP 集合 ≠ 注册值（注册 ${DEP_SKIP_REGISTRY.length} 条／实测 ${uniq.length} 条）——≠ 注册值：多出来的是新吃 kit 却没登记的判据 [${extra.slice(0, 6).join(' / ') || '(无)'}]；少了的是该 SKIP 没 SKIP [${missing.slice(0, 6).join(' / ') || '(无)'}]`;
    }
    return true;
  });

  // ---- AUD-1 第四臂（v1.6.6，常驻哨兵）：与依赖无关的红在缺失态必须 FAIL。stub 判据**不带 {needs:'kit'} 声明**
  //      且红因是纯字符串比较（与 kit 无关）——按 A 案口径它缺失态必须 FAIL；若被洗成 SKIP 即"事后洗白复辟"，
  //      本哨兵当场红。监工侧验收口径：任何人注入同类无声明红判据，缺失态都必须 FAIL。
  t('AUD-1 第四臂哨兵：无依赖声明的红在缺失态必须 FAIL 不许被洗成 SKIP', () => {
    if (!resolveKitCli().present) return 'skip（本哨兵只在在位态运行：它自己要起一个缺失态子 selftest）';
    const r = spawnSync(process.execPath, [__filename, 'selftest', '--only=aud1-stub'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000, env: Object.assign({}, process.env, { DOCKIT_KIT_CLI: 'Z:\\__no_kit_for_stub__\\cli.js' }) });
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    if (!j) return '缺失态 stub 子 selftest 跑不出 JSON：' + String(r.stdout || r.stderr).slice(0, 120);
    const stubSkip = (j.checks || []).some((c) => c.startsWith('SKIP') && c.includes('aud1-stub'));
    const stubFail = (j.checks || []).some((c) => c.startsWith('FAIL') && c.includes('aud1-stub'));
    if (stubSkip) return '🔴 事后洗白复辟：aud1-stub（无依赖声明、缺失态红）被洗成 SKIP——wrapT 的 A 案归因口径被破坏';
    if (!stubFail) return 'aud1-stub 在缺失态既没 FAIL 也没 SKIP（没跑到？）：' + JSON.stringify({ passed: j.passed, failed: j.failed, skipped: j.skipped });
    if (j.failed !== 1) return '缺失态 stub 子 selftest failed=' + j.failed + '（应为 1——只有 stub 该红，多出来的红见 checks）';
    return true;
  });
  // stub 本体：🔴 故意**不带** {needs:'kit'} 第三参——它是"与依赖无关、缺失态必红"的哨兵（A 案下 wrapT 不许洗它）。
  t('aud1-stub 与任何依赖无关的静态断言（AUD-1 哨兵本体：缺失态必红不许 SKIP）', () => { if (resolveKitCli().present) return true; return 'zc-aud1-stub 纯字符串比较失败（红因与 kit 无关，缺失态必须以 FAIL 形状出现）'; });

  // ---- AUD-2（v1.6.6）T1 判据：两张依赖注册表存在且跑得动——防第二张表静默腐烂。
  //      成本门：lint 是秒级结构验证（表存在/JSON 可解析/与 dockit.js DEP_SKIP_REGISTRY 逐名一致/脚本可加载）；
  //      真克隆态逐名比对由显式入口 node test/dep-set.js check 承担（全跑约 2-4 分钟，不进每轮 selftest）。
  t('dep-set 注册表：两张依赖缺失态注册表存在可解析且与 dockit.js 内嵌表一致（AUD-2 T1，防静默腐烂）', () => {
    const ds = path.join(__dirname, 'test', 'dep-set.js');
    if (!fs.existsSync(ds)) return 'test/dep-set.js 不存在——真克隆注册表的校验入口没了';
    for (const f of ['test/dep-registry-missing.json', 'test/dep-registry-clone.json']) if (!fs.existsSync(path.join(__dirname, f))) return f + ' 不存在——第二张注册表会静默腐烂';
    const r = spawnSync(process.execPath, [ds, 'lint'], { encoding: 'utf8', timeout: 60000 });
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    if (!j || j.ok !== true) return 'dep-set lint 失败：' + String(r.stdout || r.stderr).slice(0, 200);
    return true;
  });

  // ---- v1.4.0 ocr 判据（ADR-001，任务书 G §2.5）：合成图用装置自画的 PNG（ASCII 字模，严禁机主私人文档文字入夹具/判据/日志/提交）。
  // 缺 tesseract 的机器上②③④逐条 SKIP 并点名（外人克隆依旧全绿）；降级形状由①用环境变量假路径覆盖，不需要引擎在位。
  const OCR_S = `${S}/ocr`;
  fs.mkdirSync(OCR_S, { recursive: true });
  const OCR_FONT = { D: [30, 17, 17, 17, 17, 17, 30], O: [14, 17, 17, 17, 17, 17, 14], C: [14, 17, 16, 16, 16, 17, 14], K: [17, 18, 20, 24, 20, 18, 17], I: [14, 4, 4, 4, 4, 4, 14], T: [31, 4, 4, 4, 4, 4, 4] };
  const drawTextPng = (text, file) => {
    // 最小 PNG 编码器：灰度 8bit、逐行 filter 0、zlib deflate——CRC/deflate 全是装置已有的标准库面
    const SC = 6, GAP = 2, M = 8;
    const w = M * 2 + text.length * 5 * SC + Math.max(0, text.length - 1) * GAP * SC, h = 7 * SC + M * 2;
    const px = Buffer.alloc(w * h, 255);
    [...text].forEach((ch, ci) => {
      const g = OCR_FONT[ch]; if (!g) throw new Error('font missing: ' + ch);
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if ((g[r] >> (4 - c)) & 1) for (let dy = 0; dy < SC; dy++) for (let dx = 0; dx < SC; dx++) px[(M + r * SC + dy) * w + (M + ci * (5 * SC + GAP * SC) + c * SC + dx)] = 0;
    });
    const raw = Buffer.alloc((w + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; px.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w); }
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  };
  const synthPng = `${OCR_S}/synth.png`; drawTextPng('DOCKIT', synthPng);
  const blankOcrPng = `${OCR_S}/blank.png`; drawTextPng('', blankOcrPng);
  const ocrRun = (img, envExtra, extraArgs) => { const r = spawnSync(process.execPath, [__filename, 'ocr', img, '--tessdata-dir', TESSDATA_DIR, ...(extraArgs || [])], { encoding: 'utf8', env: envExtra ? { ...process.env, ...envExtra } : process.env }); let j = null; try { j = JSON.parse(r.stdout); } catch {} return { r, j }; };

  t('ocr 降级：tesseract 不在位回 unavailable＋next＋退码 1，不落半成品', () => {
    const { r, j } = ocrRun(synthPng, { DOCKIT_TESSERACT: 'Z:\\definitely\\missing\\tesseract.exe' });
    if (!j || j.ok !== false) return '缺引擎竟然 ok 或非 JSON：' + String(r.stdout).slice(0, 120);
    if (r.status !== 1) return `退码应为 1，实测 ${r.status}`;
    if (j.code !== 'unavailable') return `码应为 unavailable，实测 ${j.code}：${j.error}`;
    if (!/DOCKIT_TESSERACT/.test(j.next || '')) return 'next 不指路环境变量：' + j.next;
    return true;
  });
  t('ocr 合成图出字（装置自画 ASCII 字模 PNG，正向）', () => {
    // R-B（v1.6.4）：守卫从探针 available 改**存在性口径**（与 verify 族同款）——装了但被换坏时 available 也翻 false，
    // 会把第三臂（在位但坏 ⇒ 照跑 ⇒ 红）吞成 SKIP；存在性守卫只 skip 真缺失。
    if (!fs.existsSync(TESSERACT_EXE)) return `skip（本机无 tesseract（解析 ${TESSERACT_EXE}），合成图判据跳过——降级形状由「ocr 降级」覆盖）`;
    const { r, j } = ocrRun(synthPng, null, ['--psm', '6']);
    if (!j || j.ok !== true) return '识别失败：' + JSON.stringify(j || String(r.stderr).slice(0, 120)).slice(0, 200);
    const flat = fs.readFileSync(j.pages[0].file, 'utf8').toUpperCase().replace(/[^A-Z]/g, '');
    if (!flat.includes('DOCKIT')) return `没认出字模 DOCKIT（chars=${j.pages[0].chars} lines=${j.pages[0].lines}，认出的形状：${flat.slice(0, 14) || '(空)'}）`;
    return true;
  });
  t('ocr 空白样张 0 行 0 字（正面控制，防幻影行）', () => {
    if (!fs.existsSync(TESSERACT_EXE)) return `skip（本机无 tesseract（解析 ${TESSERACT_EXE}），空白对照判据跳过）`; // R-B（v1.6.4）存在性口径
    const { r, j } = ocrRun(blankOcrPng);
    if (!j || j.ok !== true) return '识别失败：' + JSON.stringify(j || String(r.stderr).slice(0, 120)).slice(0, 200);
    const pg = j.pages[0];
    if (pg.lines !== 0 || pg.chars !== 0) return `空白图读出了内容（幻影行）：lines=${pg.lines} chars=${pg.chars}`;
    if (pg.pixelEvidence === 'off' || pg.pixelEvidence.err) return '像素证据缺失且未显式 off：' + JSON.stringify(pg.pixelEvidence).slice(0, 80);
    if (pg.pixelEvidence.ratio !== 0) return `空白图像素占比应为 0，实测 ${pg.pixelEvidence.ratio}`;
    return true;
  });
  t('ocr 自曝字段齐全（backend/语言包/逐页证据，缺即红）', () => {
    if (!fs.existsSync(TESSERACT_EXE)) return `skip（本机无 tesseract（解析 ${TESSERACT_EXE}），自曝判据跳过）`; // R-B（v1.6.4）存在性口径
    const { r, j } = ocrRun(synthPng);
    if (!j || j.ok !== true) return '识别失败：' + JSON.stringify(j || String(r.stderr).slice(0, 120)).slice(0, 200);
    if (!/^tesseract v/.test(j.backend || '')) return `backend 缺失或不像版本串：${JSON.stringify(j.backend)}`;
    if (!path.isAbsolute(j.tessdataDir || '')) return `tessdataDir 非绝对路径或缺失：${JSON.stringify(j.tessdataDir)}`;
    if (!j.langPack || !j.lang) return `langPack/lang 缺失：${JSON.stringify({ langPack: j.langPack, lang: j.lang })}`;
    if (!path.isAbsolute(j.tesseractExe || '')) return `tesseractExe 非绝对路径或缺失：${JSON.stringify(j.tesseractExe)}`;
    if (!Array.isArray(j.pages) || !j.pages.length) return 'pages 缺失或空数组（空数组不许冒充"没内容"）';
    const pg = j.pages[0];
    if (typeof pg.chars !== 'number' || typeof pg.lines !== 'number' || typeof pg.ms !== 'number') return '逐页 chars/lines/ms 缺失';
    if (!pg.pixelEvidence) return 'pixelEvidence 缺失（关掉要回 off，不许空）';
    if (typeof j.ms !== 'number' || j.ms <= 0) return '总耗时缺失';
    // v1.4.1：自报字段之间不许互相矛盾。`--tessdata-dir` 换过语言包目录时，langPack 必须跟着变——
    // 改前 langPack 恒取默认 tessdata 的基名，同一条 JSON 里会出现 langPack="tessdata" 而
    // tessdataDir 指向别的目录（实测：flag→tessdata-best 仍报 "tessdata"，env→同目录才报对）。
    // 调用方拿 langPack 判"这次用的哪套包"就是错答案（监工侧独立验收 G 轮撞出）。
    const ovr = `${OCR_S}/ovr-tessdata`, engSrc = path.join(TESSDATA_DIR, 'eng.traineddata');
    if (!fs.existsSync(engSrc)) return 'skip（本机 tessdata 里没有 eng.traineddata，覆盖目录的一致性无从构造）';
    fs.mkdirSync(ovr, { recursive: true });
    fs.copyFileSync(engSrc, path.join(ovr, 'eng.traineddata'));
    const o = ocrRun(synthPng, null, ['--tessdata-dir', ovr]);
    if (!o.j || o.j.ok !== true) return `换成覆盖目录后识别失败（本该通）：${JSON.stringify(o.j || {}).slice(0, 140)}`;
    if (o.j.langPack !== path.basename(ovr)) return `langPack 没跟着 --tessdata-dir 变：自报 ${JSON.stringify(o.j.langPack)}，实际所用目录基名 ${JSON.stringify(path.basename(ovr))}`;
    if (path.resolve(o.j.tessdataDir) !== path.resolve(ovr)) return `tessdataDir 自报的不是本次覆盖的目录：${o.j.tessdataDir}`;
    // v1.5.0：自报的语言清单也必须来自"本次真用的那个目录"。覆盖目录里只放了一份 eng.traineddata
    // ⇒ 只该数出 1 种；改前 ocr 借 probe 自曝，而 probe 恒按默认/env 目录跑 --list-langs，
    // 会把默认目录那套（eng + osd ＝ 2 种）报成这次的清单。
    if (o.j.langsNote) return `覆盖目录的语言清单没读成，却仍回了成功：${o.j.langsNote}`;
    if (o.j.langCount !== 1 || (o.j.langs || []).join(',') !== 'eng') return `语言清单不是本次覆盖目录的：langCount=${o.j.langCount} langs=${JSON.stringify(o.j.langs)}（那个目录里只有 eng.traineddata，应数出 1 种 eng）`;
    return true;
  });

  // ---- v1.9.0：media / batch / combine / split 判据组（每层各配独立攻击，见 M132–M144；新增吃 kit 的判据已登记进依赖表） ----
  t('media 抽取：OOXML 媒体面、类型与哈希对账', () => {
    const MS = ensureDir(`${S}/v19-media`);
    const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const jpg1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
    const dpath = `${MS}/a.docx`, ppath = `${MS}/b.pptx`;
    fs.writeFileSync(dpath, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CT) },
      { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>`) },
      { name: 'word/media/image1.png', data: png1 },
      { name: 'word/media/photo.JPG', data: jpg1 },
      { name: 'docProps/thumbnail.jpeg', data: jpg1 },
    ]));
    fs.writeFileSync(ppath, zipWrite([
      { name: 'ppt/presentation.xml', data: Buffer.from('<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>') },
      { name: 'ppt/media/image9.png', data: png1 },
    ]));
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ } return { p, j }; };
    const shaBefore = sha256(fs.readFileSync(dpath));
    const r1 = cli(['media', dpath]);
    if (!r1.j || r1.j.ok !== true) return 'docx 抽取失败：' + JSON.stringify(r1.j || String(r1.p.stderr).slice(0, 120)).slice(0, 220);
    if (r1.j.count !== 2) return `docx 应抽 2 件（image1.png + photo.JPG），实为 ${r1.j.count}：` + JSON.stringify((r1.j.files || []).map((f) => f.part));
    const byPart = {}; for (const f of r1.j.files) byPart[f.part] = f;
    if (!byPart['word/media/image1.png'] || !byPart['word/media/photo.JPG']) return '清单缺条目：' + JSON.stringify(Object.keys(byPart));
    if (byPart['word/media/image1.png'].type !== 'png' || byPart['word/media/photo.JPG'].type !== 'jpeg') return '类型判定不对（只按 magic）：' + JSON.stringify([byPart['word/media/image1.png'].type, byPart['word/media/photo.JPG'].type]);
    if ((r1.j.files || []).some((f) => f.part.includes('thumbnail'))) return '预览件（docProps/thumbnail*）被收进来了——按设计不在采集面';
    const srcMap = zipRead(fs.readFileSync(dpath));
    for (const f of r1.j.files) {
      const src = srcMap.get(f.part);
      if (!src || src.length !== f.bytes || sha256(src) !== f.sha256) return `${f.part} 的字节/哈希自报与源条目不符（自报面失真）`;
      if (!fs.existsSync(path.join(r1.j.dir, f.file))) return `${f.part} 自报落盘但文件不在：${f.file}`;
    }
    if (sha256(fs.readFileSync(dpath)) !== shaBefore) return '原件被改动了（media 必须只读输入）';
    const r2 = cli(['media', ppath]);
    if (!r2.j || r2.j.ok !== true || r2.j.count !== 1 || (r2.j.files[0] || {}).part !== 'ppt/media/image9.png') return 'pptx 侧抽取不对：' + JSON.stringify(r2.j && { ok: r2.j.ok, count: r2.j.count, parts: (r2.j.files || []).map((f) => f.part) });
    return true;
  });
  t('media 拒绝面、空包与落点去重自报', () => {
    const MS = ensureDir(`${S}/v19-media2`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ } return { p, j }; };
    const ole = `${MS}/fake-ole.doc`;
    fs.writeFileSync(ole, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]));
    const r1 = cli(['media', ole]);
    if (!r1.j || r1.j.ok !== false || r1.j.code !== 'unsupported-format') return 'OLE 输入应前置 unsupported-format：' + JSON.stringify(r1.j && { ok: r1.j.ok, code: r1.j.code });
    const broken = `${MS}/broken.docx`;
    fs.writeFileSync(broken, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not-a-real-zip-container')]));
    const r2 = cli(['media', broken]);
    if (!r2.j || r2.j.ok !== false || r2.j.code !== 'invalid-document') return '坏 ZIP 应 invalid-document：' + JSON.stringify(r2.j && { ok: r2.j.ok, code: r2.j.code });
    const noMedia = `${MS}/no-media.docx`;
    fs.writeFileSync(noMedia, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t> </w:t></w:r></w:p></w:body></w:document>`));
    const r3 = cli(['media', noMedia]);
    if (!r3.j || r3.j.ok !== true || r3.j.count !== 0) return '无媒体件应 ok:true 且 count=0（空结果是数据不是错误）：' + JSON.stringify(r3.j && { ok: r3.j.ok, count: r3.j.count });
    if (!Array.isArray(r3.j.warnings) || !r3.j.warnings.some((w) => w.includes('没有'))) return '空包必须自报一条 warning（静默即不可见）：' + JSON.stringify(r3.j.warnings);
    const many = `${MS}/many.docx`;
    const manyEntries = []; for (let i = 0; i < MEDIA_MAX_FILES + 1; i++) manyEntries.push({ name: `word/media/f${i}.png`, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, i & 0xff]) });
    fs.writeFileSync(many, zipWrite([{ name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: 'word/document.xml', data: Buffer.from('<w:document/>') }, ...manyEntries]));
    const r4 = cli(['media', many]);
    if (!r4.j || r4.j.ok !== false || r4.j.code !== 'invalid-output' || !String(r4.j.error).includes('上限')) return `超上限（${MEDIA_MAX_FILES + 1} 件）应 invalid-output 拒绝并点名上限：` + JSON.stringify(r4.j && { ok: r4.j.ok, code: r4.j.code, error: String(r4.j.error).slice(0, 90) });
    const r5 = cli(['media', noMedia]);
    if (!r5.j || r5.j.ok !== true) return '第二次跑失败：' + JSON.stringify(r5.j && { ok: r5.j.ok, code: r5.j.code });
    if (r3.j.dir === r5.j.dir) return '两次跑的落点相同（落点必须自动去重、永不覆盖）：' + r3.j.dir;
    if (!fs.existsSync(r3.j.dir) || !fs.existsSync(r5.j.dir)) return '两次跑的产物目录都应存在';
    return true;
  });
  t('media ODF 面：只收 Pictures、忽略缩略图', () => {
    const MS = ensureDir(`${S}/v19-media3`);
    const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const oPath = `${MS}/pic.odt`;
    fs.writeFileSync(oPath, zipWrite([
      { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text'), method: 0 },
      { name: 'content.xml', data: Buffer.from('<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>') },
      { name: 'Pictures/x1.png', data: png1 },
      { name: 'Thumbnails/thumbnail.png', data: png1 },
    ]));
    const p = spawnSync(process.execPath, [__filename, 'media', oPath], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ }
    if (!j || j.ok !== true) return 'odt 抽取失败：' + JSON.stringify(j || String(p.stderr).slice(0, 120)).slice(0, 200);
    if (j.count !== 1 || (j.files[0] || {}).part !== 'Pictures/x1.png') return 'ODF 采集面不对（应只收 Pictures/x1.png）：' + JSON.stringify((j.files || []).map((f) => f.part));
    if ((j.files || []).some((f) => f.part.startsWith('Thumbnails/'))) return '缩略图（第一页渲染图）被当成媒体件抽出——版面内容不许混进媒体面';
    if (j.files[0].type !== 'png') return '类型不对：' + j.files[0].type;
    return true;
  });
  t('batch 批量转换：清单计数、产物与原件零改动', () => {
    const BS = ensureDir(`${S}/v19-batch`);
    const docSrc = ROOT + '/test/fixtures/wps-newfile.doc', odtSrc = ROOT + '/test/fixtures/cn.odt';
    if (!fs.existsSync(docSrc) || !fs.existsSync(odtSrc)) return 'skip（夹具 wps-newfile.doc / cn.odt 不在位——入仓件缺失属仓库缺陷，不冒充通过）';
    const f1 = `${BS}/wps-newfile.doc`, f2 = `${BS}/cn.odt`;
    fs.copyFileSync(docSrc, f1); fs.copyFileSync(odtSrc, f2);
    fs.writeFileSync(`${BS}/note.txt`, 'not a document');
    const before = new Map([[f1, sha256(fs.readFileSync(f1))], [f2, sha256(fs.readFileSync(f2))]]);
    const p = spawnSync(process.execPath, [__filename, 'batch', BS, '--ext', '.doc,.odt'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ }
    if (!j || j.ok !== true) return '批量转换整体应成功：' + JSON.stringify(j || String(p.stderr).slice(0, 140)).slice(0, 220);
    if (!j.summary || j.summary.total !== 2 || j.summary.ok !== 2 || j.summary.failed !== 0) return '总账不对：' + JSON.stringify(j.summary);
    if ((j.items || []).length !== 2) return `件数不对（.txt 不该被收；--ext 过滤面破了？）：${(j.items || []).length}`;
    for (const it of j.items) {
      if (it.ok !== true || !it.output) return '有件没成功或缺 output：' + JSON.stringify(it).slice(0, 160);
      if (!fs.existsSync(it.output.path)) return `自报产物不在：${it.output.path}`;
      const b = fs.readFileSync(it.output.path);
      if (b.length !== it.output.bytes || sha256(b) !== it.output.sha256) return '产物字节/哈希与自报不符：' + it.output.path;
      if (!String(it.output.path).replace(/\\/g, '/').startsWith(String(OUT_DIR).replace(/\\/g, '/') + '/')) return '产物没落当轮产物根（落点契约；v2.9.0 起 selftest 态的产物根是 _tmp/selftest-*/out，不是字面量 _out）：' + it.output.path;
    }
    for (const [f, s] of before) if (sha256(fs.readFileSync(f)) !== s) return `原件被改动：${f}`;
    return true;
  }, {needs:'kit'});
  t('batch 混合失败：单件失败不拖垮、整体判负', () => {
    const BS = ensureDir(`${S}/v19-batch2`);
    const okSrc = ROOT + '/test/fixtures/cn.odt';
    if (!fs.existsSync(okSrc)) return 'skip（夹具 cn.odt 不在位——入仓件缺失属仓库缺陷）';
    const good = `${BS}/cn.odt`, badFile = `${BS}/fake.doc`;
    fs.copyFileSync(okSrc, good);
    fs.writeFileSync(badFile, 'this is not a compound file at all');
    const goodSha = sha256(fs.readFileSync(good));
    const p = spawnSync(process.execPath, [__filename, 'batch', BS], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ }
    if (!j || j.ok !== false || j.code !== 'failed') return '混有坏件时整体必须 ok:false＋code=failed：' + JSON.stringify(j && { ok: j.ok, code: j.code, summary: j.summary });
    if (p.status !== 1) return '混有坏件时退码必须 1，实测 ' + p.status;
    if (!j.summary || j.summary.total !== 2 || j.summary.ok !== 1 || j.summary.failed !== 1) return '总账应为 2 总/1 成/1 败：' + JSON.stringify(j.summary);
    const okItem = (j.items || []).find((x) => x.ok === true), badItem = (j.items || []).find((x) => x.ok === false);
    if (!okItem || !badItem) return 'items 应同时含成功件与失败件（单件失败不许拖垮其余）：' + JSON.stringify(j.items).slice(0, 200);
    if (!badItem.code || typeof badItem.code !== 'string') return '失败件必须带 code：' + JSON.stringify(badItem).slice(0, 160);
    if (!okItem.output || !fs.existsSync(okItem.output.path)) return '成功件的产物不在：' + JSON.stringify(okItem).slice(0, 160);
    if (sha256(fs.readFileSync(good)) !== goodSha) return '成功件处理时原文件被改动';
    return true;
  }, {needs:'kit'});
  t('batch 空目录、上限与 --to 拒绝自报', () => {
    const BS = ensureDir(`${S}/v19-batch3`);
    const empty = ensureDir(`${BS}/empty`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ } return { p, j }; };
    const r1 = cli(['batch', empty]);
    if (!r1.j || r1.j.ok !== true || r1.j.summary.total !== 0 || !(r1.j.warnings || []).some((w) => w.includes('没有匹配'))) return '空目录应 ok:true＋total=0＋warning：' + JSON.stringify(r1.j && { ok: r1.j.ok, summary: r1.j.summary, warnings: r1.j.warnings });
    const txtOnly = ensureDir(`${BS}/txtonly`);
    fs.writeFileSync(`${txtOnly}/x.txt`, 'x');
    const r2 = cli(['batch', txtOnly]);
    if (!r2.j || r2.j.ok !== true || r2.j.summary.total !== 0) return '.txt 不该被默认后缀面收（默认只含九个受支持输入族）：' + JSON.stringify(r2.j && { ok: r2.j.ok, summary: r2.j.summary });
    const r3 = cli(['batch', txtOnly, '--to', 'xyz']);
    if (!r3.j || r3.j.ok !== false || r3.j.code !== 'invalid-output') return '--to 写错应 invalid-output：' + JSON.stringify(r3.j && { ok: r3.j.ok, code: r3.j.code });
    const two = ensureDir(`${BS}/two`);
    fs.copyFileSync(ROOT + '/test/fixtures/wps-newfile.doc', `${two}/a.doc`);
    fs.copyFileSync(ROOT + '/test/fixtures/cn.odt', `${two}/b.odt`);
    const r4 = cli(['batch', two, '--max-items', '1']);
    if (!r4.j || r4.j.ok !== false || r4.j.code !== 'invalid-output' || !String(r4.j.error).includes('上限')) return '超 --max-items 应拒绝并点名上限（不静默截断）：' + JSON.stringify(r4.j && { ok: r4.j.ok, code: r4.j.code, error: String(r4.j.error).slice(0, 90) });
    const r5 = cli(['batch', `${BS}/no-such-dir`]);
    if (!r5.j || r5.j.ok !== false || r5.j.code !== 'invalid-document') return '不存在的目录应 invalid-document：' + JSON.stringify(r5.j && { ok: r5.j.ok, code: r5.j.code });
    return true;
  });
  await ta('combine 合并：页数、顺序与原件零改动', async () => {
    const CS = ensureDir(`${S}/v19-combine`);
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（本机 node_modules 里没有 pdf-lib——真克隆态必走这支；指令面不冒充通过）';
    const mk = async (file, widths) => { const d = await pl.PDFDocument.create(); for (const w of widths) d.addPage([w, 50]); fs.writeFileSync(file, await d.save()); };
    const a = `${CS}/a.pdf`, b = `${CS}/b.pdf`;
    await mk(a, [101, 102]); await mk(b, [201, 202, 203]);
    const shaA = sha256(fs.readFileSync(a)), shaB = sha256(fs.readFileSync(b));
    const p = spawnSync(process.execPath, [__filename, 'combine', a, b], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ }
    if (!j || j.ok !== true) return '合并失败：' + JSON.stringify(j || String(p.stderr).slice(0, 140)).slice(0, 220);
    if (j.pages !== 5) return `总页数应为 5，实为 ${j.pages}`;
    if (!j.out || !fs.existsSync(j.out.path)) return '产物不在：' + JSON.stringify(j.out && j.out.path);
    const out = await pl.PDFDocument.load(fs.readFileSync(j.out.path));
    if (out.getPageCount() !== 5) return '产物页数复读不符：' + out.getPageCount();
    const widths = out.getPages().map((pg) => Math.round(pg.getSize().width));
    const want = [101, 102, 201, 202, 203];
    if (JSON.stringify(widths) !== JSON.stringify(want)) return `页序不对（应按参数顺序拼接）：实为 [${widths.join(',')}]，应为 [${want.join(',')}]`;
    if ((j.sources || []).length !== 2 || !j.sources.every((s) => s.pages > 0)) return 'sources 自报不完整：' + JSON.stringify(j.sources);
    if (sha256(fs.readFileSync(a)) !== shaA || sha256(fs.readFileSync(b)) !== shaB) return '输入被改动（combine 必须只读输入）';
    return true;
  });
  await ta('combine/split 拒绝面：不足两件、坏件、覆盖拒绝、加密件', async () => {
    const CS = ensureDir(`${S}/v19-combine2`);
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（本机 node_modules 里没有 pdf-lib——真克隆态必走这支）';
    const mk = async (file, widths) => { const d = await pl.PDFDocument.create(); for (const w of widths) d.addPage([w, 50]); fs.writeFileSync(file, await d.save()); };
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ } return { p, j }; };
    const a = `${CS}/a.pdf`; await mk(a, [101]);
    const r0 = cli(['combine', a]);
    if (!r0.j || r0.j.ok !== false || r0.j.code !== 'invalid-output') return '单输入应 invalid-output（至少两件）：' + JSON.stringify(r0.j && { ok: r0.j.ok, code: r0.j.code });
    const badPdf = `${CS}/bad.pdf`;
    fs.writeFileSync(badPdf, '%PDF-1.7\nthis is not really a pdf');
    const r1 = cli(['combine', a, badPdf]);
    if (!r1.j || r1.j.ok !== false || r1.j.code !== 'invalid-document') return '坏 PDF 应 invalid-document：' + JSON.stringify(r1.j && { ok: r1.j.ok, code: r1.j.code });
    const b = `${CS}/b.pdf`; await mk(b, [201]);
    const outExists = `${CS}/exists.pdf`;
    fs.writeFileSync(outExists, 'sentinel-bytes');
    const sentinel = sha256(fs.readFileSync(outExists));
    const r2 = cli(['combine', a, b, '--out', outExists]);
    if (!r2.j || r2.j.ok !== false || r2.j.code !== 'invalid-output') return '--out 撞已存在必须 invalid-output：' + JSON.stringify(r2.j && { ok: r2.j.ok, code: r2.j.code });
    if (sha256(fs.readFileSync(outExists)) !== sentinel) return '撞车时既有文件被改写了（永不覆盖被打破）';
    // v1.9.1：加密 PDF 的拒绝面——码＝unsupported-format、next 指解密、消息/next 不许把库的绕法提示（ignoreEncryption）带出去
    const encF = ROOT + '/test/fixtures/encrypted.pdf';
    if (!fs.existsSync(encF)) return 'skip（夹具 test/fixtures/encrypted.pdf 不在位——入仓件缺失属仓库缺陷，不冒充通过）';
    const r3 = cli(['combine', encF, a]);
    if (!r3.j || r3.j.ok !== false || r3.j.code !== 'unsupported-format') return '加密件 combine 应 unsupported-format：' + JSON.stringify(r3.j && { ok: r3.j.ok, code: r3.j.code });
    if (/ignoreEncryption/i.test(String(r3.j.error) + String(r3.j.next))) return '加密件 combine 的 error/next 里出现了库的绕法提示（ignoreEncryption）——不许带出去';
    if (!String(r3.j.next).includes('解密')) return '加密件 combine 的 next 必须指"先解密"：' + r3.j.next;
    const r4 = cli(['split', encF]);
    if (!r4.j || r4.j.ok !== false || r4.j.code !== 'unsupported-format') return '加密件 split 应 unsupported-format：' + JSON.stringify(r4.j && { ok: r4.j.ok, code: r4.j.code });
    if (/ignoreEncryption/i.test(String(r4.j.error) + String(r4.j.next))) return '加密件 split 的 error/next 里出现了库的绕法提示（ignoreEncryption）——不许带出去';
    return true;
  });
  await ta('split 范围与逐 N：产物页数逐件对账', async () => {
    const SS = ensureDir(`${S}/v19-split`);
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（本机 node_modules 里没有 pdf-lib——真克隆态必走这支）';
    const mk = async (file, widths) => { const d = await pl.PDFDocument.create(); for (const w of widths) d.addPage([w, 30]); fs.writeFileSync(file, await d.save()); };
    const src = `${SS}/five.pdf`; await mk(src, [101, 102, 103, 104, 105]);
    const shaSrc = sha256(fs.readFileSync(src));
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ } return { p, j }; };
    const readWidths = async (file) => { const d = await pl.PDFDocument.load(fs.readFileSync(file)); return d.getPages().map((pg) => Math.round(pg.getSize().width)); };
    const r1 = cli(['split', src, '--ranges', '2-3,5']);
    if (!r1.j || r1.j.ok !== true) return '按区间拆失败：' + JSON.stringify(r1.j || String(r1.p.stderr).slice(0, 140)).slice(0, 200);
    if (r1.j.mode !== 'ranges' || (r1.j.outputs || []).length !== 2) return '区间模式产物数应为 2：' + JSON.stringify(r1.j && { mode: r1.j.mode, n: (r1.j.outputs || []).length });
    const o1 = r1.j.outputs[0], o2 = r1.j.outputs[1];
    const w1 = await readWidths(o1.path), w2 = await readWidths(o2.path);
    if (o1.pages !== 2 || JSON.stringify(o1.range) !== '[2,3]' || JSON.stringify(w1) !== '[102,103]') return '第一段（2-3）内容不对：' + JSON.stringify({ pages: o1.pages, range: o1.range, widths: w1 });
    if (o2.pages !== 1 || JSON.stringify(o2.range) !== '[5,5]' || JSON.stringify(w2) !== '[105]') return '第二段（5）内容不对：' + JSON.stringify({ pages: o2.pages, range: o2.range, widths: w2 });
    const r2 = cli(['split', src, '--every', '2']);
    if (!r2.j || r2.j.ok !== true || r2.j.mode !== 'every') return '逐 N 拆失败：' + JSON.stringify(r2.j && { ok: r2.j.ok, mode: r2.j.mode });
    const sizes = (r2.j.outputs || []).map((o) => o.pages);
    if (JSON.stringify(sizes) !== '[2,2,1]') return `每 2 页应出 [2,2,1]，实为 [${sizes.join(',')}]`;
    const allW = [];
    for (const o of r2.j.outputs) allW.push(...(await readWidths(o.path)));
    if (JSON.stringify(allW) !== '[101,102,103,104,105]') return '逐 N 产物拼起来与原件页序不符：' + JSON.stringify(allW);
    if (sha256(fs.readFileSync(src)) !== shaSrc) return '输入被改动（split 必须只读输入）';
    return true;
  });
  await ta('split 拒绝面：互斥、越界与封顶', async () => {
    const SS = ensureDir(`${S}/v19-split2`);
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（本机 node_modules 里没有 pdf-lib——真克隆态必走这支）';
    const mk = async (file, n) => { const d = await pl.PDFDocument.create(); for (let i = 1; i <= n; i++) d.addPage([100 + i, 30]); fs.writeFileSync(file, await d.save()); };
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ } return { p, j }; };
    const five = `${SS}/five.pdf`; await mk(five, 5);
    const r1 = cli(['split', five, '--ranges', '1-2', '--every', '2']);
    if (!r1.j || r1.j.ok !== false || r1.j.code !== 'invalid-output') return '--ranges 与 --every 同给应 invalid-output：' + JSON.stringify(r1.j && { ok: r1.j.ok, code: r1.j.code });
    const r2 = cli(['split', five, '--ranges', '3-1']);
    if (!r2.j || r2.j.ok !== false || r2.j.code !== 'invalid-output') return '倒序区间应 invalid-output：' + JSON.stringify(r2.j && { ok: r2.j.ok, code: r2.j.code });
    const r3 = cli(['split', five, '--ranges', '1-99']);
    if (!r3.j || r3.j.ok !== false || r3.j.code !== 'invalid-output' || !String(r3.j.error).includes('5 页')) return '越界区间应 invalid-output 且带真实页数：' + JSON.stringify(r3.j && { ok: r3.j.ok, code: r3.j.code, error: String(r3.j.error).slice(0, 100) });
    const notPdf = `${SS}/nope.gif`; fs.writeFileSync(notPdf, Buffer.from('GIF89a not a pdf'));
    const r4 = cli(['split', notPdf]);
    if (!r4.j || r4.j.ok !== false || r4.j.code !== 'unsupported-format') return '非 PDF 应 unsupported-format：' + JSON.stringify(r4.j && { ok: r4.j.ok, code: r4.j.code });
    const big = `${SS}/big.pdf`; await mk(big, SPLIT_MAX_OUTPUTS + 20);
    const r5 = cli(['split', big]);
    if (!r5.j || r5.j.ok !== false || r5.j.code !== 'invalid-output' || !String(r5.j.error).includes('上限')) return `逐页拆 ${SPLIT_MAX_OUTPUTS + 20} 页应拒绝并点上限：` + JSON.stringify(r5.j && { ok: r5.j.ok, code: r5.j.code, error: String(r5.j.error).slice(0, 100) });
    return true;
  });

  await ta('pageops 页级操作：rotate（含 --pages 部分）/delete/order 对账，输入零改；坏角度/删光/坏排列拒绝', async () => {
    const PS = ensureDir(`${S}/v22-pageops`);
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（无 pdf-lib，页级夹具造不了）';
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const three = `${PS}/three.pdf`;
    const dd = await pl.PDFDocument.create();
    for (let i = 1; i <= 3; i++) dd.addPage([300, 200 + i * 10]);
    fs.writeFileSync(three, await dd.save());
    const shaBefore = sha256(fs.readFileSync(three));
    const bad = [];
    const rot = (a) => { const p = cli(['pageops', three, 'rotate', ...a]); return p; };
    // ① 全转 90
    const r1 = rot(['90']);
    if (!r1.j || r1.j.ok !== true) bad.push('rotate 90 失败：' + JSON.stringify(r1.j && { ok: r1.j.ok, error: r1.j.error }));
    else {
      const chk = cli(['inspect', r1.j.out.path]);
      const rots = (chk.j.pdf.pages || []).map((p) => p.rotation);
      if (rots.join(',') !== '90,90,90') bad.push('应全转 90，实为 ' + rots.join(','));
    }
    // ② --pages 1-2 转 180（第 3 页保持 0）
    const r2 = rot(['180', '--pages', '1-2']);
    if (!r2.j || r2.j.ok !== true) bad.push('rotate 180 --pages 失败：' + JSON.stringify(r2.j && { error: r2.j.error }));
    else {
      const chk = cli(['inspect', r2.j.out.path]);
      const rots = (chk.j.pdf.pages || []).map((p) => p.rotation);
      if (rots.join(',') !== '180,180,0') bad.push('应 180,180,0，实为 ' + rots.join(','));
    }
    // ③ delete 2 → 2 页，顺序 1,3
    const r3 = cli(['pageops', three, 'delete', '2']);
    if (!r3.j || r3.j.ok !== true || r3.j.pages !== 2 || r3.j.pageOrder.join(',') !== '1,3') bad.push('delete 2 应余 2 页序 1,3：' + JSON.stringify(r3.j && { pages: r3.j.pages, order: r3.j.pageOrder }));
    // ④ order 3,1,2
    const r4 = cli(['pageops', three, 'order', '3,1,2']);
    if (!r4.j || r4.j.ok !== true || r4.j.pageOrder.join(',') !== '3,1,2') bad.push('order 3,1,2 不对：' + JSON.stringify(r4.j && { order: r4.j.pageOrder }));
    // ⑤ 拒绝面
    const e1 = cli(['pageops', three, 'rotate', '45']);
    if (!e1.j || e1.j.code !== 'invalid-output') bad.push('rotate 45 应拒：' + JSON.stringify(e1.j && { code: e1.j.code }));
    const e2 = cli(['pageops', three, 'delete', '1,2,3']);
    if (!e2.j || e2.j.code !== 'invalid-output') bad.push('删光应拒：' + JSON.stringify(e2.j && { code: e2.j.code }));
    const e3 = cli(['pageops', three, 'order', '1,2,2']);
    if (!e3.j || e3.j.code !== 'invalid-output') bad.push('坏排列应拒：' + JSON.stringify(e3.j && { code: e3.j.code }));
    // 🔴 v2.4.1：空页清单拒（实测 --pages '' 曾静默无操作却报 ok、rotatedPages:[]——假成功）
    const e4 = cli(['pageops', three, 'rotate', '90', '--pages', '']);
    if (!e4.j || e4.j.code !== 'invalid-output') bad.push('空页清单应拒（不许无操作假成功）：' + JSON.stringify(e4.j && { code: e4.j.code }));
    const e5 = cli(['pageops', three, 'delete', ',,']);
    if (!e5.j || e5.j.code !== 'invalid-output') bad.push('纯逗号页清单应拒：' + JSON.stringify(e5.j && { code: e5.j.code }));
    // 输入零改
    if (sha256(fs.readFileSync(three)) !== shaBefore) bad.push('输入被改动（pageops 必须只读）');
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  await ta('pipeline 串联：PDF 输入跳过 to（to-pages）；docx 走 to>pages；to-pages-ocr 出 ocr；坏 flow 拒绝', async () => {
    const LS = ensureDir(`${S}/v22-pipeline`);
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（无 pdf-lib，PDF 夹具造不了）';
    const cli = (a, env) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    const workDirs = [];
    const remember = (r) => { if (!r.j) return; if (r.j.workDir) workDirs.push(r.j.workDir); for (const s of (r.j.steps || [])) { if (s.dir) workDirs.push(s.dir); } };
    const bad = [];
    // 造 2 页 PDF
    const pdf = `${LS}/two.pdf`;
    const d = await pl.PDFDocument.create();
    d.addPage([200, 200]); d.addPage([200, 200]);
    fs.writeFileSync(pdf, await d.save());
    // ① PDF 输入 to-pages：跳过 to
    const r1 = cli(['pipeline', pdf, 'to-pages']);
    remember(r1);
    if (!r1.j || r1.j.ok !== true) bad.push('PDF to-pages 失败：' + JSON.stringify(r1.j && { error: r1.j.error }));
    else if (r1.j.skippedTo !== true || r1.j.steps.map((s) => s.step).join('>') !== 'pages' || r1.j.pageCount !== 2) bad.push('应跳过 to、单 pages、2 页：' + JSON.stringify({ skippedTo: r1.j.skippedTo, steps: r1.j.steps.map((s) => s.step), pageCount: r1.j.pageCount }));
    // ② docx 输入 to-pages：走 to>pages
    const docx = `${LS}/h.docx`;
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>HELLO</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
    const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
    fs.writeFileSync(docx, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(ct), method: 0 },
      { name: '_rels/.rels', data: Buffer.from(rels), method: 0 },
      { name: 'word/document.xml', data: Buffer.from(docXml), method: 8 },
    ]));
    if (resolveKitCli().present) {
      const r2 = cli(['pipeline', docx, 'to-pages']);
      remember(r2);
      if (!r2.j || r2.j.ok !== true) bad.push('docx to-pages 失败：' + JSON.stringify(r2.j && { error: r2.j.error }));
      else if (r2.j.skippedTo !== false || r2.j.steps.map((s) => s.step).join('>') !== 'to>pages') bad.push('应走 to>pages：' + JSON.stringify({ skippedTo: r2.j.skippedTo, steps: r2.j.steps.map((s) => s.step) }));
    }
    // ③ to-pages-ocr
    if (fs.existsSync(TESSERACT_EXE)) {
      const r3 = cli(['pipeline', pdf, 'to-pages-ocr']);
      remember(r3);
      if (!r3.j || r3.j.ok !== true) bad.push('to-pages-ocr 失败：' + JSON.stringify(r3.j && { failedStep: r3.j.failedStep, error: r3.j.error }));
      else if (r3.j.steps.map((s) => s.step).join('>') !== 'pages>ocr') bad.push('应 pages>ocr：' + r3.j.steps.map((s) => s.step).join('>'));
    }
    // ④ 坏 flow 拒绝
    const r4 = cli(['pipeline', pdf, 'bogus']);
    if (!r4.j || r4.j.code !== 'invalid-output') bad.push('坏 flow 应拒：' + JSON.stringify(r4.j && { code: r4.j.code }));
    // ⑤ 中途失败即停（v2.2.1）：docx + 假 kit ⇒ to 步失败，必须单行 JSON、退码 1、failedStep=to
    const r5 = cli(['pipeline', docx, 'to-pages'], { DOCKIT_KIT_CLI: 'Z:\\__no_kit_review__\\cli.js' });
    remember(r5);
    if (r5.p.status !== 1) bad.push('中途失败退码应为 1，实为 ' + r5.p.status);
    if (r5.p.stdout.trim().split(/\r?\n/).length !== 1) bad.push('中途失败应只出一行 JSON，实为 ' + r5.p.stdout.trim().split(/\r?\n/).length + ' 行');
    if (!r5.j || r5.j.ok !== false || r5.j.failedStep !== 'to' || r5.j.code !== 'unavailable' || typeof r5.j.workDir !== 'string') bad.push('中途失败应报 failedStep=to/code=unavailable＋workDir（供清理与诊断）：' + JSON.stringify(r5.j && { ok: r5.j.ok, failedStep: r5.j.failedStep, code: r5.j.code, workDir: r5.j.workDir }));
    // 自检造的 pipeline 中间产物（_out/pipeline-*）随测试清掉，不留垃圾
    for (const wd of workDirs) { try { fs.rmSync(wd, { recursive: true, force: true }); } catch {} }
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  // ---- v2.1.0：pdftext（poppler 文本层）/ media PDF（pdfimages）/ inspect AcroForm 判据组（攻击见 M150–M156）----
  // 正/负向两态都在本机实测过：pdftotext 对数字中文 PDF 瞬时取字（免 OCR）；pdfimages 中文输出路径走 cwd 宽字符绕 argv 解码坑。
  const PNG_RED_V21 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO4IycHAALyARlzRAvLAAAAAElFTkSuQmCC', 'base64');
  const PNG_BLUE_V21 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQs7kDAAGyATf/cv8XAAAAAElFTkSuQmCC', 'base64');
  t('pdftext 直取文本层（数字中文 PDF 免 OCR）：txt 含已知中文、chars>0、正文不回显进 JSON', () => {
    const pt = popplerTool('pdftotext');
    if (!pt.present) return `skip（本机无 pdftotext（解析 ${pt.exe}）：pdftext 正向取字跳过——降级形状由「pdftext 降级」判据覆盖）`;
    const cv = cnPdf(); if (!cv.ok) return 'skip（cn.pdf 夹具没转出来：' + String(cv.error).slice(0, 80) + '）';
    const p = spawnSync(process.execPath, [__filename, 'pdftext', `${S}/cn.pdf`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ }
    if (!j || j.ok !== true) return 'pdftext 正向失败：' + JSON.stringify(j || String(p.stderr).slice(0, 120)).slice(0, 200);
    if (j.op !== 'pdftext' || !/pdftotext/.test(j.backend || '')) return 'op/backend 自报不对：' + JSON.stringify({ op: j.op, backend: j.backend });
    if (!(j.chars > 0) || !(j.lines > 0)) return `chars/lines 应 >0，实为 chars=${j.chars} lines=${j.lines}`;
    if (!j.file || !fs.existsSync(j.file)) return '自报 txt 未落盘：' + j.file;
    const txt = str(fs.readFileSync(j.file));
    if (!txt.includes(CN)) return '取出的 txt 不含已知中文取证串（数字中文 PDF 本该免 OCR 直取）：' + txt.slice(0, 60);
    if (JSON.stringify(j).includes(CN)) return '正文串被回显进 JSON（隐私口径与 ocr 同：文本只落 txt、不进回报）';
    return true;
  }, { needs: 'kit' });
  t('pdftext 拒绝面：非 PDF/坏区间/页码 0/覆盖（纯参数校验，缺工具也到处能跑）', () => {
    const PS = ensureDir(`${S}/v21-pdftext-rej`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ } return { p, j }; };
    const txt = `${PS}/plain.txt`; fs.writeFileSync(txt, 'hello not pdf');
    const r1 = cli(['pdftext', txt]);
    if (!r1.j || r1.j.ok !== false || r1.j.code !== 'unsupported-format') return '非 PDF 应 unsupported-format：' + JSON.stringify(r1.j && { code: r1.j.code });
    const fake = `${PS}/fake.pdf`; fs.writeFileSync(fake, '%PDF-1.7\nnot really a pdf');
    const r2 = cli(['pdftext', fake, '--pages', '3-1']);
    if (!r2.j || r2.j.ok !== false || r2.j.code !== 'invalid-output') return '倒序区间 3-1 应 invalid-output：' + JSON.stringify(r2.j && { code: r2.j.code });
    const r3 = cli(['pdftext', fake, '--pages', '0']);
    if (!r3.j || r3.j.ok !== false || r3.j.code !== 'invalid-output') return '页码 0 应 invalid-output：' + JSON.stringify(r3.j && { code: r3.j.code });
    const r3b = cli(['pdftext', fake, '--pages', '1-x']);
    if (!r3b.j || r3b.j.ok !== false || r3b.j.code !== 'invalid-output') return '非法区间 1-x 应 invalid-output：' + JSON.stringify(r3b.j && { code: r3b.j.code });
    const exist = `${PS}/already.txt`; fs.writeFileSync(exist, 'sentinel'); const sh0 = sha256(fs.readFileSync(exist));
    const r4 = cli(['pdftext', fake, '--out', exist]);
    if (!r4.j || r4.j.ok !== false || r4.j.code !== 'invalid-output') return '--out 撞已存在应 invalid-output：' + JSON.stringify(r4.j && { code: r4.j.code });
    if (sha256(fs.readFileSync(exist)) !== sh0) return '撞车文件被改写（永不覆盖被打破）';
    return true;
  });
  t('pdftext 降级：poppler 不在位回 unavailable＋指路 DOCKIT_POPPLER_BIN＋退码 1＋不落半成品', () => {
    const PS = ensureDir(`${S}/v21-pdftext-down`);
    const fake = `${PS}/fake.pdf`; fs.writeFileSync(fake, '%PDF-1.7\nnot really');
    const outNo = `${PS}/should-not-exist.txt`;
    const p = spawnSync(process.execPath, [__filename, 'pdftext', fake, '--out', outNo], { encoding: 'utf8', env: { ...process.env, DOCKIT_POPPLER_BIN: 'Z:\\definitely\\missing\\poppler\\bin' } });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ }
    if (!j || j.ok !== false) return '缺 poppler 竟然 ok 或非 JSON：' + String(p.stdout).slice(0, 120);
    if (p.status !== 1) return `退码应为 1，实测 ${p.status}`;
    if (j.code !== 'unavailable') return `码应为 unavailable，实测 ${j.code}`;
    if (!/DOCKIT_POPPLER_BIN/.test(j.next || '')) return 'next 不指路 DOCKIT_POPPLER_BIN：' + j.next;
    if (fs.existsSync(outNo)) return '降级前竟落了半成品 txt（unavailable 不许写产物）';
    return true;
  });

  // ---- v2.3.0 markdown 族（文档→GFM，pandoc 后端；缺工具 unavailable＋指路，与 poppler/tesseract 同族形状）----
  // 夹具的 styles.xml 是必需的：不给它，pandoc 认不出 Heading1 样式（实测 `w:pStyle w:val="Heading1"` 在无
  // styles.xml 时被当未知样式忽略，标题掉成纯段落）——这条是造夹具时实测出来的，不是照文档抄的。
  t('markdown 正向：合成 docx 转 GFM（标题/中文串在位、chars>0、正文不回显、原件零改动）', () => {
    const pd = pandocTool();
    if (!pd.present) return `skip（本机无 pandoc（解析 ${pd.exe}）：markdown 正向跳过——降级形状由「markdown 降级」判据覆盖；不冒充通过）`;
    const MS = ensureDir(`${S}/v23-md`);
    const S_ = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
    const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const DOCRELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${S_}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`;
    const BODY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>装置标题甲</w:t></w:r></w:p><w:p><w:r><w:t>${CN}</w:t></w:r></w:p></w:body></w:document>`;
    const src = `${MS}/md-src.docx`;
    fs.writeFileSync(src, zipWrite([{ name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: '_rels/.rels', data: Buffer.from(RELS) }, { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCRELS) }, { name: 'word/styles.xml', data: Buffer.from(STYLES) }, { name: 'word/document.xml', data: Buffer.from(BODY) }]));
    const before = sha256(fs.readFileSync(src));
    const out1 = `${MS}/out1.md`;
    const p = spawnSync(process.execPath, [__filename, 'markdown', src, out1], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON 交断言 */ }
    if (!j || j.ok !== true) return 'markdown 正向失败：' + String(p.stdout || p.stderr).slice(0, 180);
    if (j.op !== 'markdown' || j.backend !== 'pandoc') return 'op/backend 自报不对：' + JSON.stringify({ op: j.op, backend: j.backend });
    if (!(j.chars > 0) || !(j.lines > 0)) return `chars/lines 应 >0，实为 ${j.chars}/${j.lines}`;
    if (!j.output || !j.output.path || !fs.existsSync(j.output.path)) return '自报产物未落盘：' + JSON.stringify(j.output);
    if (abs(j.output.path) !== abs(out1)) return '自报产物路径与请求的不符：' + j.output.path;
    const md = str(fs.readFileSync(j.output.path));
    if (!md.includes(CN)) return '产物不含已知中文取证串：' + md.slice(0, 60);
    if (!/^#\s+装置标题甲/m.test(md)) return 'Heading1 没映射成 markdown 标题（# 行）：' + md.slice(0, 80);
    if (JSON.stringify(j).includes(CN)) return '正文串被回显进 JSON（隐私口径与 ocr/pdftext 同：正文只落 .md 文件）';
    if (sha256(fs.readFileSync(src)) !== before) return '原件被改动（输入必须只读）';
    const p2 = spawnSync(process.execPath, [__filename, 'markdown', src, `${MS}/out2.md`, '--wrap', 'none'], { encoding: 'utf8' });
    let j2 = null; try { j2 = JSON.parse(p2.stdout); } catch { /* 非 JSON */ }
    if (!j2 || j2.ok !== true || j2.wrap !== 'none') return '--wrap none 透传失败：' + String(p2.stdout).slice(0, 120);
    return true;
  });
  t('markdown 降级：pandoc 不在位回 unavailable＋指路 DOCKIT_PANDOC＋退码 1＋不落半成品', () => {
    const MS = ensureDir(`${S}/v23-md-down`);
    const src = `${MS}/src.docx`;
    fs.writeFileSync(src, zipWrite([{ name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') }, { name: 'word/document.xml', data: Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>') }]));
    const outNo = `${MS}/should-not-exist.md`;
    const p = spawnSync(process.execPath, [__filename, 'markdown', src, outNo], { encoding: 'utf8', env: { ...process.env, DOCKIT_PANDOC: 'Z:\\definitely\\missing\\pandoc.exe' } });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ }
    if (!j || j.ok !== false) return '缺 pandoc 竟然 ok 或非 JSON：' + String(p.stdout).slice(0, 120);
    if (p.status !== 1) return `退码应为 1，实测 ${p.status}`;
    if (j.code !== 'unavailable') return `码应为 unavailable，实测 ${j.code}`;
    if (!/DOCKIT_PANDOC/.test(j.next || '')) return 'next 不指路 DOCKIT_PANDOC：' + j.next;
    if (fs.existsSync(outNo)) return '降级前竟落了半成品 md（unavailable 不许写产物）';
    return true;
  });
  t('markdown 拒绝面：PDF 指路 pdftext、OLE 老族指路 to、伪装件 invalid-document、输出撞车与输入=输出拒', () => {
    const MS = ensureDir(`${S}/v23-md-rej`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ } return { p, j }; };
    const pdf = `${MS}/doc.pdf`; fs.writeFileSync(pdf, '%PDF-1.7\nfake');
    const r1 = cli(['markdown', pdf]);
    if (!r1.j || r1.j.ok !== false || r1.j.code !== 'unsupported-format') return 'PDF 输入应 unsupported-format：' + JSON.stringify(r1.j && { code: r1.j.code });
    if (!/pdftext/.test(r1.j.next || '')) return 'PDF 的 next 应指路 pdftext：' + r1.j.next;
    const doc = `${MS}/old.doc`; fs.writeFileSync(doc, Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0]));
    const r2 = cli(['markdown', doc]);
    if (!r2.j || r2.j.ok !== false || r2.j.code !== 'unsupported-format') return '.doc 应 unsupported-format：' + JSON.stringify(r2.j && { code: r2.j.code });
    if (!/to/.test(r2.j.next || '')) return '.doc 的 next 应指路先 to 转新族：' + r2.j.next;
    const fake = `${MS}/fake.docx`; fs.writeFileSync(fake, 'plain text with docx suffix');
    const r3 = cli(['markdown', fake]);
    if (!r3.j || r3.j.ok !== false || r3.j.code !== 'invalid-document') return '伪装件应 invalid-document（不起 pandoc 就拒）：' + JSON.stringify(r3.j && { code: r3.j.code });
    const src = `${MS}/ok.docx`;
    fs.writeFileSync(src, zipWrite([{ name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') }, { name: 'word/document.xml', data: Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>') }]));
    const exist = `${MS}/already.md`; fs.writeFileSync(exist, 'sentinel'); const sh0 = sha256(fs.readFileSync(exist));
    const r4 = cli(['markdown', src, exist]);
    if (!r4.j || r4.j.ok !== false || r4.j.code !== 'invalid-output') return '输出撞已存在应 invalid-output：' + JSON.stringify(r4.j && { code: r4.j.code });
    if (sha256(fs.readFileSync(exist)) !== sh0) return '撞车文件被改写（永不覆盖被打破）';
    const r5 = cli(['markdown', src, src]);
    if (!r5.j || r5.j.ok !== false || r5.j.code !== 'invalid-output') return '输入=输出应 invalid-output：' + JSON.stringify(r5.j && { code: r5.j.code });
    const r6 = cli(['markdown', src, `${MS}/w.md`, '--wrap', 'bogus']);
    if (!r6.j || r6.j.ok !== false || r6.j.code !== 'invalid-output') return '--wrap 非法值应 invalid-output：' + JSON.stringify(r6.j && { code: r6.j.code });
    const r7 = cli(['markdown', `${MS}/nope.docx`]);
    if (!r7.j || r7.j.ok !== false || r7.j.code !== 'invalid-document') return '输入不存在应 invalid-document：' + JSON.stringify(r7.j && { code: r7.j.code });
    return true;
  });

  t('pipeline 步序列：逗号 flow 驱动（未知步拒、无 to 的非 PDF 拒、to 不在首位拒、正向 to,pdftext、旧名仍可用）', () => {
    const PS = ensureDir(`${S}/v24-pipe-steps`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ } return { p, j }; };
    const bad = [];
    const probeDoc = `${PS}/in.docx`;
    fs.writeFileSync(probeDoc, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>pipeline step probe</w:t></w:r></w:p></w:body></w:document>`));
    const r1 = cli(['pipeline', probeDoc, 'to,nonsense']);
    if (!r1.j || r1.j.code !== 'invalid-output') bad.push('未知步应 invalid-output：' + JSON.stringify(r1.j && { code: r1.j.code }));
    const r2 = cli(['pipeline', probeDoc, 'pages']);
    if (!r2.j || r2.j.code !== 'invalid-output') bad.push('非 PDF 输入跑 pages（无 to）应 invalid-output：' + JSON.stringify(r2.j && { code: r2.j.code }));
    const r4 = cli(['pipeline', probeDoc, 'pages,to']);
    if (!r4.j || r4.j.code !== 'invalid-output') bad.push('to 不在首位应 invalid-output：' + JSON.stringify(r4.j && { code: r4.j.code }));
    // r6 旧名 to-pages＝to+pages（只要 kit，不要 poppler）；只有 r5 的 pdftext 步要 pdftotext。
    const r6 = cli(['pipeline', probeDoc, 'to-pages']);
    if (!r6.j || r6.j.ok !== true) bad.push('旧名 to-pages 应仍可用：' + String(r6.p.stdout || '').slice(0, 120));
    if (!popplerTool('pdftotext').present) return bad.length ? bad.join(' | ') : 'skip（这台机器没有 pdftotext：to,pdftext 正向面跑不了，纯校验与旧名面已核）';
    const r5 = cli(['pipeline', probeDoc, 'to,pdftext']);
    if (!r5.j || r5.j.ok !== true) { bad.push('to,pdftext 正向失败：' + String(r5.p.stdout || '').slice(0, 180)); return bad.join(' | '); }
    const stNames = (r5.j.steps || []).map((s) => s.step).join(',');
    if (stNames !== 'to,pdftext') bad.push(`steps 序列应为 to,pdftext，实为 ${stNames}`);
    const pdftextStep = (r5.j.steps || []).find((s) => s.step === 'pdftext');
    if (!pdftextStep || !pdftextStep.file || !fs.existsSync(pdftextStep.file)) bad.push('pdftext 步应落 txt 产物并在 steps 里自报路径');
    return bad.length ? bad.join(' | ') : true;
  }, {needs:'kit'});
  await ta('media 抽 PDF 内嵌图：pdfimages 张数/类型/sha 对账、中文路径落盘、原件零改', async () => {
    const MS = ensureDir(`${S}/v21-media-pdf`);
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（无 pdf-lib，嵌图夹具造不了——真克隆态必走这支；不冒充通过）';
    const pi = popplerTool('pdfimages'); if (!pi.present) return `skip（本机无 pdfimages（解析 ${pi.exe}），media 抽 PDF 图跳过）`;
    const f = `${MS}/two.pdf`;
    const d = await pl.PDFDocument.create(); const pg = d.addPage([300, 300]);
    const ia = await d.embedPng(PNG_RED_V21), ib = await d.embedPng(PNG_BLUE_V21);
    pg.drawImage(ia, { x: 10, y: 10, width: 120, height: 120 }); pg.drawImage(ib, { x: 150, y: 10, width: 120, height: 120 });
    fs.writeFileSync(f, await d.save());
    const shaBefore = sha256(fs.readFileSync(f));
    const p = spawnSync(process.execPath, [__filename, 'media', f], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ }
    if (!j || j.ok !== true) return 'media 抽 PDF 图失败：' + JSON.stringify(j || String(p.stderr).slice(0, 120)).slice(0, 220);
    if (j.container !== 'pdf' || !/pdfimages/.test(j.backend || '')) return 'container/backend 自报不对：' + JSON.stringify({ container: j.container, backend: j.backend });
    if (j.listedImages !== 2 || j.count !== 2) return `应列出并抽出 2 张，实为 listed=${j.listedImages} count=${j.count}`;
    for (const x of j.files || []) {
      const disk = path.join(j.dir, x.file);
      if (!fs.existsSync(disk)) return '自报落盘但文件不在：' + x.file;
      const b2 = fs.readFileSync(disk);
      if (b2.length !== x.bytes || sha256(b2) !== x.sha256) return `${x.file} 字节/sha 自报与盘上不符（自报面失真）`;
      if (x.type !== 'png') return `${x.file} 类型应为 png，实为 ${x.type}`;
    }
    if (sha256(fs.readFileSync(f)) !== shaBefore) return '输入 PDF 被改动（media 必须只读）';
    return true;
  });
  await ta('media PDF 拒绝面：非容器/超 cap 落地前拒（不回 dir）/加密件', async () => {
    const MS = ensureDir(`${S}/v21-media-pdf-rej`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ } return { p, j }; };
    const txt = `${MS}/plain.txt`; fs.writeFileSync(txt, 'hello');
    const r0 = cli(['media', txt]);
    if (!r0.j || r0.j.ok !== false || r0.j.code !== 'unsupported-format') return '非 ZIP 非 PDF 应 unsupported-format：' + JSON.stringify(r0.j && { code: r0.j.code });
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（无 pdf-lib，超 cap 嵌图夹具造不了；非容器拒绝面上面已验）';
    const pi = popplerTool('pdfimages'); if (!pi.present) return `skip（无 pdfimages（${pi.exe}），cap/加密拒绝面跳过；非容器面已验）`;
    const f = `${MS}/two.pdf`;
    const d = await pl.PDFDocument.create(); const pg = d.addPage([300, 300]);
    const ia = await d.embedPng(PNG_RED_V21), ib = await d.embedPng(PNG_BLUE_V21);
    pg.drawImage(ia, { x: 10, y: 10, width: 100, height: 100 }); pg.drawImage(ib, { x: 150, y: 10, width: 100, height: 100 });
    fs.writeFileSync(f, await d.save());
    const r1 = cli(['media', f, '--max-files', '0']);
    if (!r1.j || r1.j.ok !== false || r1.j.code !== 'invalid-output') return '--max-files 0 应 invalid-output：' + JSON.stringify(r1.j && { code: r1.j.code });
    const r2 = cli(['media', f, '--max-files', '1']);
    if (!r2.j || r2.j.ok !== false || r2.j.code !== 'invalid-output' || !String(r2.j.error).includes('上限')) return '2 图 cap=1 应落地前拒并点名上限：' + JSON.stringify(r2.j && { code: r2.j.code, error: String(r2.j.error).slice(0, 90) });
    if (r2.j.dir) return '超 cap 却回了 dir（说明先落地才拒，违反"数图后、落地前拒"）';
    const encF = ROOT + '/test/fixtures/encrypted.pdf';
    if (!fs.existsSync(encF)) return 'skip（encrypted.pdf 夹具不在位——入仓件缺失属仓库缺陷，不冒充通过）';
    const r3 = cli(['media', encF]);
    if (!r3.j || r3.j.ok !== false || r3.j.code !== 'unsupported-format') return '加密 PDF media 应 unsupported-format：' + JSON.stringify(r3.j && { code: r3.j.code });
    return true;
  });
  await ta('pdftext/media 开关：pdftext --layout/--enc、media --reencode jpeg（DCTDecode 出 .jpg）；非法值拒绝', async () => {
    const MS = ensureDir(`${S}/v22-switches`);
    const pim = popplerTool('pdfimages'), ptx = popplerTool('pdftotext');
    if (!pim.present || !ptx.present) return `skip（poppler 工具不全：pdftotext=${ptx.present} pdfimages=${pim.present}）`;
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（无 pdf-lib，夹具造不了）';
    const cli = (a, env) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }); let j = null; try { j = JSON.parse(p.stdout); } catch {} return { p, j }; };
    // 文本 PDF（Helvetica 画字）
    const d = await pl.PDFDocument.create();
    const font = await d.embedFont(pl.StandardFonts.Helvetica);
    d.addPage([420, 300]).drawText('HELLO PDFTEXT LAYOUT 42', { x: 30, y: 250, size: 14, font });
    const textPdf = `${MS}/text.pdf`; fs.writeFileSync(textPdf, await d.save());
    const bad = [];
    // ① pdftext --layout：抽到字
    const a1 = cli(['pdftext', textPdf, '--layout']);
    if (!a1.j || a1.j.ok !== true || !(a1.j.chars > 0)) bad.push('pdftext --layout 应抽到字：' + JSON.stringify(a1.j && { ok: a1.j.ok, chars: a1.j.chars }));
    // ② pdftext --enc 非法：pdftotext 拒绝
    const a2 = cli(['pdftext', textPdf, '--enc', 'BOGUS']);
    if (!a2.j || a2.j.ok !== false) bad.push('pdftext --enc BOGUS 应拒绝：' + JSON.stringify(a2.j && { ok: a2.j.ok }));
    // ③ media --reencode jpeg：JPEG-PDF 出 .jpg
    const d2 = await pl.PDFDocument.create();
    const jpg = buildMinimalGrayJpeg();
    const img = await d2.embedJpg(jpg);
    d2.addPage([200, 200]).drawImage(img, { x: 10, y: 10, width: 100, height: 100 });
    const jpgPdf = `${MS}/jpg.pdf`; fs.writeFileSync(jpgPdf, await d2.save());
    const a3 = cli(['media', jpgPdf, '--reencode', 'jpeg']);
    if (!a3.j || a3.j.ok !== true || a3.j.count !== 1) bad.push('media --reencode jpeg 应出 1 张：' + JSON.stringify(a3.j && { ok: a3.j.ok, count: a3.j.count }));
    else if (!/\.jpg$/i.test(a3.j.files[0].file)) bad.push('应出 .jpg，实为 ' + a3.j.files[0].file);
    // ④ media --reencode 非法：invalid-output
    const a4 = cli(['media', jpgPdf, '--reencode', 'gif']);
    if (!a4.j || a4.j.ok !== false || a4.j.code !== 'invalid-output') bad.push('media --reencode gif 应 invalid-output：' + JSON.stringify(a4.j && { code: a4.j.code }));
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });
  await ta('inspect PDF 表单探针：AcroForm 字段计数＋拼拆丢失预警，无表单态为 null', async () => {
    const FS2 = ensureDir(`${S}/v21-form`);
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（无 pdf-lib，表单夹具造不了——真克隆态必走这支）';
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ } return { p, j }; };
    const formF = `${FS2}/form.pdf`;
    const d = await pl.PDFDocument.create(); d.addPage([400, 300]);
    const fm = d.getForm(); fm.createTextField('name'); fm.createTextField('city');
    fs.writeFileSync(formF, await d.save());
    const r1 = cli(['inspect', formF]);
    if (!r1.j || r1.j.ok !== true) return '含表单 PDF inspect 失败：' + JSON.stringify(r1.j || String(r1.p.stderr).slice(0, 120)).slice(0, 180);
    const it = r1.j.pdf && r1.j.pdf.interactive;
    if (!it || it.form !== 'AcroForm') return '应探到 AcroForm：' + JSON.stringify(it);
    if (it.formFields !== 2) return `字段数应为 2，实为 ${it.formFields}`;
    const adv = String((r1.j.pdf && r1.j.pdf.formAdvice) || '');
    if (!/表单/.test(adv) || !/combine\/split|§八/.test(adv)) return 'formAdvice 应预警拼拆会丢表单（点名 combine/split 与 §八#25）：' + adv.slice(0, 120);
    const plainF = `${FS2}/plain.pdf`;
    const d2 = await pl.PDFDocument.create(); d2.addPage([300, 300]); fs.writeFileSync(plainF, await d2.save());
    const r2 = cli(['inspect', plainF]);
    if (!r2.j || r2.j.ok !== true) return '无表单 PDF inspect 失败：' + JSON.stringify(r2.j).slice(0, 140);
    const it2 = r2.j.pdf && r2.j.pdf.interactive;
    if (!it2 || it2.form !== null) return '无表单 PDF 应 interactive.form=null：' + JSON.stringify(it2);
    return true;
  });

  // ---- v2.5.0 四条新面（skill 对照轮第三棒）：scrub 的 PDF 面、pdfform、markdown 修订足迹。夹具全部自产；
  //      pdf-lib 族在真克隆态逐条 SKIP（已登记克隆注册表），pandoc 族照跑（pandoc 是机器级安装）。各面配 M180–M189。
  await ta('scrub PDF 面：/Info 目标键＋XMP 双清并写新文件（产物字节零残留、结构回查、撞车拒、纯净件拒、原件零改）', async () => {
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（无 pdf-lib，PDF 面夹具造不了——真克隆态必走这支）';
    const DS = ensureDir(`${S}/v25-scrub-pdf`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ } return { p, j }; };
    const bad = [];
    const { PDFDocument, PDFName } = pl;
    // 夹具：/Info 标题与作者哨兵 ＋ 未压缩 XMP 流（字节面直接可见——令牌扫描因此有真对照面）
    const xmpText = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Seq><rdf:li>XMP-SENTINEL-A</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const d = await PDFDocument.create(); d.addPage([200, 200]);
    d.setTitle('INFO-SENTINEL-TITLE-A'); d.setAuthor('INFO-SENTINEL-AUTHOR-A');
    d.catalog.set(PDFName.of('Metadata'), d.context.register(d.context.stream(xmpText, { Type: 'Metadata', Subtype: 'XML' })));
    const src = `${DS}/src.pdf`; fs.writeFileSync(src, await d.save({ updateMetadata: false }));
    const srcRaw = fs.readFileSync(src).toString('latin1');
    if (!srcRaw.includes('xpacket') || !srcRaw.includes('XMP-SENTINEL-A')) return '夹具自身不对：源 PDF 字节面应含 XMP 明文';
    const before = sha256(fs.readFileSync(src));
    const out = `${DS}/out.pdf`;
    const r1 = cli(['scrub', src, out, '--verify']);
    if (!r1.j || r1.j.ok !== true) return 'scrub(PDF) 正向失败：' + kidErr(r1.p.stdout || r1.p.stderr);
    if (r1.j.container !== 'pdf') bad.push('container 应自报 pdf：' + r1.j.container);
    for (const need of ['Info:Title', 'Info:Author', 'XMP:/Metadata']) if (!(r1.j.removedFields || []).includes(need)) bad.push(`removedFields 缺 ${need}`);
    const outRaw = fs.readFileSync(out).toString('latin1');
    for (const t of ['xpacket', 'XMP-SENTINEL-A']) if (outRaw.includes(t)) bad.push('产物字节面仍有残留 ' + t + '（孤儿对象没删干净？）');
    if (!r1.j.tokenScan || r1.j.tokenScan.hit !== 0) bad.push('干净产物的 tokenScan.hit 应 0：' + JSON.stringify(r1.j.tokenScan));
    if (!r1.j.verify || r1.j.verify.residual !== 0) bad.push('--verify residual 应 0：' + JSON.stringify(r1.j.verify));
    const back = await PDFDocument.load(fs.readFileSync(out), { updateMetadata: false });
    const bi = back.context.trailerInfo.Info ? back.context.lookup(back.context.trailerInfo.Info) : null;
    const left = [];
    if (bi && bi.keys) for (const k of PDF_META_TARGETS) if (bi.get(PDFName.of(k))) left.push(k);
    if (left.length) bad.push('产物 /Info 仍有目标键：' + left.join(','));
    if (back.catalog.get(PDFName.of('Metadata'))) bad.push('产物 catalog 仍有 /Metadata 引用');
    if (sha256(fs.readFileSync(src)) !== before) bad.push('原件被改动（输入必须只读）');
    // 撞车：输出已存在必须拒绝且不改写既有文件
    const exist = `${DS}/exists.pdf`; fs.writeFileSync(exist, 'SENTINEL-EXIST'); const ex0 = sha256(fs.readFileSync(exist));
    const r2 = cli(['scrub', src, exist]);
    if (!r2.j || r2.j.ok !== false || r2.j.code !== 'invalid-output') bad.push('输出撞车应 invalid-output：' + JSON.stringify(r2.j && { ok: r2.j.ok, code: r2.j.code }));
    if (sha256(fs.readFileSync(exist)) !== ex0) bad.push('撞车文件被改写（永不覆盖被打破）');
    // 纯净件（独立构造：剥掉 Info＋无 XMP）：没有可清必须拒、不落产物
    const dc = await PDFDocument.create(); dc.addPage([100, 100]);
    const dcp = await PDFDocument.load(await dc.save({ updateMetadata: false }), { updateMetadata: false });
    if (dcp.context.trailerInfo.Info) delete dcp.context.trailerInfo.Info;
    const cleanF = `${DS}/clean.pdf`; fs.writeFileSync(cleanF, await dcp.save({ updateMetadata: false }));
    const cleanOut = `${DS}/clean-out.pdf`;
    const r3 = cli(['scrub', cleanF, cleanOut]);
    if (!r3.j || r3.j.ok !== false || r3.j.code !== 'invalid-output') bad.push('纯净件应 invalid-output（没有可清）：' + JSON.stringify(r3.j && { ok: r3.j.ok, code: r3.j.code }));
    if (fs.existsSync(cleanOut)) bad.push('纯净件被拒时不应落产物');
    // 字节尺的正向用例：结构面点不到的孤儿残留必须被 tokenScan 点出（否则字节尺是假牙）
    const doo = await PDFDocument.create(); doo.addPage([120, 120]); doo.setTitle('INFO-ORPHAN-TITLE-A');
    doo.context.register(doo.context.stream(xmpText, { Type: 'Metadata', Subtype: 'XML' }));   // 注册但不挂 catalog ⇒ 结构面看不见、字节面看得见
    const orphanF = `${DS}/orphan.pdf`; fs.writeFileSync(orphanF, await doo.save({ updateMetadata: false }));
    const r4 = cli(['scrub', orphanF, `${DS}/orphan-out.pdf`, '--verify']);
    if (!r4.j || r4.j.ok !== true) bad.push('孤儿件 scrub 失败：' + kidErr(r4.p.stdout || r4.p.stderr));
    else {
      if (!(r4.j.tokenScan && (r4.j.tokenScan.tokens || []).includes('xpacket'))) bad.push('字节尺应点出孤儿 XMP（tokenScan.tokens 应含 xpacket）：' + JSON.stringify(r4.j.tokenScan));
      if (!(r4.j.verify && (r4.j.verify.residualFields || []).includes('token:xpacket'))) bad.push('--verify 应把孤儿残留记进 residualFields（token:xpacket）');
    }
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });
  await ta('pdfform 正向：合成 AcroForm 全类型填值＋独立回读对账（text/checkbox/dropdown/radio、CJK 嵌字体、flatten、值不回显、原件零改）', async () => {
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（无 pdf-lib，表单夹具造不了——真克隆态必走这支）';
    const FS2 = ensureDir(`${S}/v25-pdfform`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ } return { p, j }; };
    const { PDFDocument } = pl;
    const d = await PDFDocument.create(); const pg = d.addPage([400, 300]);
    const fm = d.getForm();
    fm.createTextField('name'); fm.createTextField('city');
    try { fm.createCheckBox('agree').addToPage(pg, { x: 50, y: 50 }); } catch { /* 挂不上版面不影响字段值面 */ }
    fm.createDropdown('color').setOptions(['red', 'green', 'blue']);
    const rg = fm.createRadioGroup('size'); rg.addOptionToPage('small', pg); rg.addOptionToPage('large', pg);
    const formF = `${FS2}/form.pdf`; fs.writeFileSync(formF, await d.save());
    const before = sha256(fs.readFileSync(formF));
    const hasFont = PDFFORM_FONT_CANDIDATES.some((p) => fs.existsSync(p));
    let hasKit = false; try { require('@pdf-lib/fontkit'); hasKit = true; } catch { /* 缺件时走诚实降级断言 */ }
    const dataF = `${FS2}/data.json`;
    fs.writeFileSync(dataF, JSON.stringify({ name: 'Pluto Q', city: CN, agree: true, color: 'green', size: 'small' }));
    const out1 = `${FS2}/filled.pdf`;
    const r1 = cli(['pdfform', formF, '--data', dataF, '--out', out1]);
    if (!hasFont || !hasKit) {
      // 字体面缺件（非标定机器）：诚实降级必须回 unavailable，不许静默跳过中文值
      if (!r1.j || r1.j.ok !== false || r1.j.code !== 'unavailable') return '字体面缺件时应回 unavailable：' + JSON.stringify(r1.j && { ok: r1.j.ok, code: r1.j.code });
      return true;
    }
    if (!r1.j || r1.j.ok !== true) return '填值失败：' + kidErr(r1.p.stdout || r1.p.stderr);
    if (r1.j.filledCount !== 5 || (r1.j.filled || []).length !== 5) return 'filledCount 应 5：' + JSON.stringify({ n: r1.j.filledCount, filled: r1.j.filled });
    if (!r1.j.output || !fs.existsSync(r1.j.output.path)) return '自报产物未落盘：' + JSON.stringify(r1.j.output);
    if (JSON.stringify(r1.j).includes(CN)) return '字段值被回显进 JSON（值不回显被打破）';
    const back = await PDFDocument.load(fs.readFileSync(r1.j.output.path));
    const g = back.getForm();
    const bad = [];
    if (String(g.getTextField('name').getText()) !== 'Pluto Q') bad.push('name 回读不符');
    if (String(g.getTextField('city').getText()) !== CN) bad.push('city 回读不符（CJK）');
    if (g.getCheckBox('agree').isChecked() !== true) bad.push('agree 回读不符');
    if (String(g.getDropdown('color').getSelected()) !== 'green') bad.push('color 回读不符');
    if (String(g.getRadioGroup('size').getSelected()) !== 'small') bad.push('size 回读不符');
    if (r1.j.fontEmbedded !== true) bad.push('CJK 值应嵌字体并自报 fontEmbedded=true');
    if (sha256(fs.readFileSync(formF)) !== before) bad.push('原件被改动（输入必须只读）');
    const out2 = `${FS2}/flat.pdf`;
    const r2 = cli(['pdfform', formF, '--data', dataF, '--flatten', '--out', out2]);
    if (!r2.j || r2.j.ok !== true || r2.j.flattened !== true) return 'flatten 支失败：' + kidErr(r2.p.stdout || r2.p.stderr);
    const b2 = await PDFDocument.load(fs.readFileSync(out2));
    if (b2.getForm().getFields().length !== 0) bad.push('flatten 后应零字段：' + b2.getForm().getFields().length);
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });
  await ta('pdfform 拒绝面：XFA/未知名带候选/选项外值/非标量/互斥/无表单/撞车', async () => {
    const pl = (() => { try { return require('pdf-lib'); } catch { return null; } })();
    if (!pl) return 'skip（无 pdf-lib，表单夹具造不了——真克隆态必走这支）';
    const FS3 = ensureDir(`${S}/v25-pdfform-rej`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ } return { p, j }; };
    const { PDFDocument } = pl;
    const bad = [];
    const d = await PDFDocument.create(); d.addPage([300, 200]);
    const fm = d.getForm(); fm.createTextField('name'); fm.createTextField('city'); fm.createDropdown('color').setOptions(['red', 'green']);
    const formF = `${FS3}/form.pdf`; fs.writeFileSync(formF, await d.save());
    const jf = (o, n) => { const p = `${FS3}/${n}`; fs.writeFileSync(p, JSON.stringify(o)); return p; };
    // ① XFA：手搓最小 PDF 含 /XFA 明文（pdf-lib 造不出 XFA 件——它一碰 getForm() 就剥；守卫必须在 getForm() 之前）
    const objs = ['1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] /XFA (xfa-dummy) >> >>\nendobj\n', '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n'];
    let body = '%PDF-1.4\n'; const offs = [];
    for (const o of objs) { offs.push(body.length); body += o; }
    const xrefOff = body.length;
    let xref = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    for (const off of offs) xref += String(off).padStart(10, '0') + ' 00000 n \n';
    body += xref + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF\n';
    const xfaF = `${FS3}/xfa.pdf`; fs.writeFileSync(xfaF, Buffer.from(body, 'latin1'));
    const r1 = cli(['pdfform', xfaF, '--list']);
    if (!r1.j || r1.j.ok !== false || r1.j.code !== 'unsupported-format') bad.push('XFA 件应 unsupported-format：' + JSON.stringify(r1.j && { ok: r1.j.ok, code: r1.j.code }));
    // ② 未知名：invalid-output ＋ next 带候选与字段名单
    const r2 = cli(['pdfform', formF, '--data', jf({ nam: 'x' }, 'un.json')]);
    if (!r2.j || r2.j.code !== 'invalid-output') bad.push('未知名应 invalid-output：' + JSON.stringify(r2.j && { code: r2.j.code }));
    else if (!/name/.test(String(r2.j.next)) || !/可用字段/.test(String(r2.j.next))) bad.push('未知名 next 应带最近邻与可用字段名单');
    // ③ 选项外值
    const r3 = cli(['pdfform', formF, '--data', jf({ color: 'pink' }, 'badopt.json')]);
    if (!r3.j || r3.j.ok !== false || r3.j.code !== 'invalid-output') bad.push('选项外值应 invalid-output：' + JSON.stringify(r3.j && { ok: r3.j.ok, code: r3.j.code }));
    // ④ 非标量
    const r4 = cli(['pdfform', formF, '--data', jf({ name: { a: 1 } }, 'obj.json')]);
    if (!r4.j || r4.j.ok !== false || r4.j.code !== 'invalid-document') bad.push('非标量值应 invalid-document：' + JSON.stringify(r4.j && { ok: r4.j.ok, code: r4.j.code }));
    // ⑤ 互斥（--list 与 --data）与全缺
    const r5 = cli(['pdfform', formF, '--list', '--data', jf({ name: 'x' }, 'ok.json')]);
    if (!r5.j || r5.j.ok !== false || r5.j.code !== 'invalid-output') bad.push('--list 与 --data 互斥应 invalid-output：' + JSON.stringify(r5.j && { code: r5.j.code }));
    const r6 = cli(['pdfform', formF]);
    if (!r6.j || r6.j.ok !== false || r6.j.code !== 'invalid-output') bad.push('既无 --list 也无 --data 应 invalid-output：' + JSON.stringify(r6.j && { code: r6.j.code }));
    // ⑥ 无表单：--list 空列表（空是数据）、--data 拒
    const d2 = await PDFDocument.create(); d2.addPage([120, 120]);
    const plainF = `${FS3}/plain.pdf`; fs.writeFileSync(plainF, await d2.save());
    const r7 = cli(['pdfform', plainF, '--list']);
    if (!r7.j || r7.j.ok !== true || r7.j.count !== 0) bad.push('无表单 --list 应 ok＋count 0：' + JSON.stringify(r7.j && { ok: r7.j.ok, count: r7.j.count }));
    const r8 = cli(['pdfform', plainF, '--data', jf({ name: 'x' }, 'ok2.json')]);
    if (!r8.j || r8.j.ok !== false || r8.j.code !== 'invalid-document') bad.push('无表单填值应 invalid-document：' + JSON.stringify(r8.j && { code: r8.j.code }));
    // ⑦ 撞车 + 非 PDF magic
    const exist = `${FS3}/exists.pdf`; fs.writeFileSync(exist, 'SENTINEL'); const ex0 = sha256(fs.readFileSync(exist));
    const r9 = cli(['pdfform', formF, '--data', jf({ name: 'x' }, 'ok3.json'), '--out', exist]);
    if (!r9.j || r9.j.ok !== false || r9.j.code !== 'invalid-output') bad.push('输出撞车应 invalid-output：' + JSON.stringify(r9.j && { code: r9.j.code }));
    if (sha256(fs.readFileSync(exist)) !== ex0) bad.push('撞车文件被改写（永不覆盖被打破）');
    const txt = `${FS3}/fake.pdf`; fs.writeFileSync(txt, 'not a pdf at all');
    const r10 = cli(['pdfform', txt, '--list']);
    if (!r10.j || r10.j.code !== 'unsupported-format') bad.push('非 PDF 应 unsupported-format：' + JSON.stringify(r10.j && { code: r10.j.code }));
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });
  t('markdown 修订足迹：--track-changes 三态取视图（reject 反视图、all 双标记带 author）＋非 docx 拒＋非法值拒', () => {
    const pd = pandocTool();
    if (!pd.present) return `skip（本机无 pandoc（解析 ${pd.exe}）：修订足迹三态跳过——与「markdown 正向」同族的降级形状；不冒充通过）`;
    const MS = ensureDir(`${S}/v25-md-tc`);
    const cli = (a) => { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(p.stdout); } catch { /* 非 JSON */ } return { p, j }; };
    const bad = [];
    const S_ = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const body = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>前文平静甲 </w:t></w:r><w:ins w:id="1" w:author="Author-A"><w:r><w:t>新增甲串</w:t></w:r></w:ins><w:del w:id="2" w:author="Author-B"><w:r><w:delText>删除乙串</w:delText></w:r></w:del><w:r><w:t> 后文平静乙</w:t></w:r></w:p></w:body></w:document>`;
    const src = `${MS}/tc.docx`;
    fs.writeFileSync(src, zipWrite([{ name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: '_rels/.rels', data: Buffer.from(RELS) }, { name: 'word/document.xml', data: Buffer.from(body) }]));
    const before = sha256(fs.readFileSync(src));
    const rD = cli(['markdown', src, `${MS}/default.md`]);
    const rR = cli(['markdown', src, `${MS}/reject.md`, '--track-changes', 'reject']);
    const rA = cli(['markdown', src, `${MS}/all.md`, '--track-changes', 'all']);
    if (!rD.j || rD.j.ok !== true || rD.j.trackChanges !== 'accept(default)') return '默认支失败：' + kidErr(rD.p.stdout);
    if (!rR.j || rR.j.ok !== true || rR.j.trackChanges !== 'reject') return 'reject 支失败：' + kidErr(rR.p.stdout);
    if (!rA.j || rA.j.ok !== true || rA.j.trackChanges !== 'all') return 'all 支失败：' + kidErr(rA.p.stdout);
    const mD = str(fs.readFileSync(`${MS}/default.md`));
    if (!mD.includes('新增甲串') || mD.includes('删除乙串')) bad.push('默认视图应保留插入、丢弃删除');
    const mR = str(fs.readFileSync(`${MS}/reject.md`));
    if (mR.includes('新增甲串') || !mR.includes('删除乙串')) bad.push('reject 视图应丢弃插入、保留删除（换视图没生效？）');
    const mA = str(fs.readFileSync(`${MS}/all.md`));
    if (!mA.includes('insertion') || !mA.includes('deletion') || !/data-author="Author-A"/.test(mA)) bad.push('all 视图应带 insertion/deletion 标记与 author：' + mA.slice(0, 120));
    if (JSON.stringify(rA.j).includes('新增甲串')) bad.push('正文被回显进 JSON（隐私口径被打破）');
    if (sha256(fs.readFileSync(src)) !== before) bad.push('原件被改动（输入必须只读）');
    const rB = cli(['markdown', src, `${MS}/x.md`, '--track-changes', 'bogus']);
    if (!rB.j || rB.j.code !== 'invalid-output') bad.push('非法值应 invalid-output：' + JSON.stringify(rB.j && { code: rB.j.code }));
    if (fs.existsSync(`${MS}/x.md`)) bad.push('非法值被拒时不应落产物');
    const odtF = `${MS}/mini.odt`;
    fs.writeFileSync(odtF, zipWrite([{ name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text'), method: 0 }, { name: 'content.xml', data: Buffer.from('<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:text/></office:body></office:document-content>') }]));
    const rO = cli(['markdown', odtF, `${MS}/odt.md`, '--track-changes', 'accept']);
    if (!rO.j || rO.j.code !== 'invalid-output') bad.push('非 docx 用 --track-changes 应 invalid-output：' + JSON.stringify(rO.j && { code: rO.j.code }));
    if (fs.existsSync(`${MS}/odt.md`)) bad.push('非 docx 被拒时不应落产物');
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  // ---- 假判据对账网（v1.6.7 监工侧加）。实犯形状：WP-A 那轮在新判据的源码里用 indexOf 去找判据定义的开头串，
  //      旧的计数尺子没有行首锚，把那段代码文本本身当成了两条"定义"，于是"实际定义 104 条"与本轮真跑的 102 条打架——
  //      尺子坏了没人发现，全靠监工拿 --only 之外的原始 JSON 对表才抓出来。这条网断的是另一件事：定义了却走不到执行路径＝假判据。
  // ---- v2.7.0 七条新判据（media 编码自曝 / pipeline DAG / frommd / compress / redline / redact / tables）
  //      共用一个手搓 PDF 装配器：pdf-lib 造不出"带 JBIG2 图""带矢量网格线"这类形状（既有先例：XFA 夹具也是手搓）
  const mkPdfBytes = (objs, trailerExtra) => {
    const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
    let pos = parts[0].length; const offs = [];
    objs.forEach((body, i) => { offs.push(pos); const b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1'); parts.push(b); pos += b.length; });
    const xrefAt = pos;
    let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offs) x += String(o).padStart(10, '0') + ' 00000 n \n';
    x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.concat(parts.concat([Buffer.from(x, 'latin1')]));
  };
  const mkPdfStream = (dict, dataBuf) => dict.replace('/Length 0', '/Length ' + dataBuf.length) + '\nstream\n' + dataBuf.toString('latin1') + '\nendstream';

  function rlReadText(file) {
    // 🔴 只取 w:t：把标签整体剥掉会让 w:delText 里的文字也算"看见"，于是"reject 没把删除内容还原成正常文本"这一族缺陷静默混过去（M210 实测抓出来的）
    try {
      const m = zipRead(fs.readFileSync(file));
      const x = str(m.get('word/document.xml') || Buffer.alloc(0));
      let t = '';
      for (const mm of x.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) t += mm[1];
      return { visible: t, raw: x };
    } catch { return null; }
  }
  t('media PDF 编码自曝：JBIG2/JPEG2000 按原始流导出必须说破（v2.7.0 压测）', () => {
    if (!popplerTool('pdfimages').present) return 'skip（这台机器没有 pdfimages：PDF 内嵌图面跑不了，属外部依赖缺失不是缺陷）';
    const junk = Buffer.from([0, 0, 0, 3, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6]);
    const jpx = Buffer.concat([Buffer.from([0, 0, 0, 12, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]), junk]);
    const im = (filter, payload) => mkPdfStream(`<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 0 /Filter ${filter} >>`, payload);
    // 🔴 页必须有内容流里的 Do：实测 pdfimages **顺着内容流枚举图**，只把 XObject 挂在 /Resources 上时 -list 回 0 行（首版夹具就这样假绿过）
    const content = 'q 8 0 0 8 10 60 cm /Im0 Do Q\nq 8 0 0 8 10 40 cm /Im1 Do Q';
    const f = `${S}/enc-jbig2.pdf`;
    fs.writeFileSync(f, mkPdfBytes([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 4 0 R /Im1 5 0 R >> >> /Contents 6 0 R >>',
      im('/JBIG2Decode', junk), im('/JPXDecode', jpx),
      mkPdfStream('<< /Length 0 >>', Buffer.from(content, 'latin1')),
    ], ''));
    const p = spawnSync(process.execPath, [__filename, 'media', f], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch { }
    if (!j || j.ok !== true) return 'media 跑不通这份编码件：' + JSON.stringify(j && { code: j.code, error: String(j.error).slice(0, 160) });
    const bad = [];
    if (j.listedImages !== 2) bad.push(`-list 应数到 2 张图，实为 ${j.listedImages}`);
    if (!j.encodings || !j.encodings.jbig2 || !j.encodings.jpx) bad.push('没按编码自曝（encodings 里缺 jbig2 或 jpx）：' + JSON.stringify(j.encodings));
    if ((j.rawStreamExports || []).length !== 2) bad.push('原始流件没点名：' + JSON.stringify(j.rawStreamExports));
    if (!j.warnings || !j.warnings.some((w) => /原始流.*不是可直接显示|不是可直接显示的位图/.test(w))) bad.push('没自曝"导出的是原始流不是位图"（调用方会以为拿到了能看的图）');
    if (j.count < 2) bad.push(`这两件应能原样导出（count=${j.count}）——导出通道坏了`);
    const types = (j.files || []).map((x) => x.type);
    if (!types.includes('jp2')) bad.push('JPEG2000 的 jp2 魔术头没被认出来（type 清单：' + JSON.stringify(types) + '）');
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('pipeline DAG：依赖、条件分支、拓扑序、环与未知 id 都拦（v2.7.0 通用 DAG 落地）', () => {
    const D = ensureDir(`${S}/dag`);
    const src = `${S}/dag-a.docx`;
    fs.writeFileSync(src, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>DAG 夹具正文串DAGBODY</w:t></w:r></w:p></w:body></w:document>`));
    const w = (name, obj) => { const p = path.join(D, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; };
    const run = (file) => { const p = spawnSync(process.execPath, [__filename, 'pipeline', src, '--dag', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return { p, j }; };
    const bad = [];
    // ok.json 与 inherit.json 含真跑的 pdftext 步（要 pdftotext）；其余是纯校验面，缺 poppler 照跑。
    const noPdftotext = !popplerTool('pdftotext').present;
    if (!noPdftotext) {
      const ok = run(w('ok.json', { nodes: [{ id: 'pdf', step: 'to' }, { id: 'png', step: 'pages', needs: ['pdf'] }, { id: 'txt', step: 'pdftext', needs: ['pdf'] }, { id: 'ocr', step: 'ocr', needs: ['txt'], when: { step: 'png', field: 'pageCount', op: 'lte', value: 0 } }] }));
      if (!ok.j || ok.j.ok !== true) return 'DAG 正向跑不通：' + JSON.stringify(ok.j && { code: ok.j.code, error: String(ok.j.error).slice(0, 150), failedStep: ok.j.failedStep });
      if (ok.j.mode !== 'dag') bad.push('没自报 mode=dag');
      if (ok.j.order.join('>') !== 'pdf>png>txt>ocr') bad.push('拓扑序不对：' + ok.j.order.join('>'));
      const st = Object.fromEntries((ok.j.nodes || []).map((n) => [n.id, n.status]));
      if (st.ocr !== 'skipped') bad.push('when 不成立（pageCount lte 0 为假）的节点没被跳过，实为 ' + st.ocr);
      if (st.pdf !== 'ok' || st.png !== 'ok' || st.txt !== 'ok') bad.push('该跑的节点没跑成：' + JSON.stringify(st));
      if (ok.j.skippedCount !== 1) bad.push('skippedCount 应为 1，实为 ' + ok.j.skippedCount);
      const inh = run(w('inherit.json', { nodes: [{ id: 'pdf', step: 'to' }, { id: 'x', step: 'ocr', needs: ['y'] }, { id: 'y', step: 'pdftext', needs: ['pdf'] }] }));
      if (!inh.j || inh.j.ok !== true) bad.push('依赖链跑不通：' + JSON.stringify(inh.j && { code: inh.j.code, error: String(inh.j.error).slice(0, 120) }));
      else if ((inh.j.nodes || []).some((n) => n.status === 'skipped')) bad.push('上游 ok 却把下游跳过了（skip 传染写错方向）：' + JSON.stringify(inh.j.nodes));
    }
    const cyc = run(w('cyc.json', { nodes: [{ id: 'a', step: 'pdftext', needs: ['b'] }, { id: 'b', step: 'to', needs: ['a'] }] }));
    if (!cyc.j || cyc.j.ok !== false || cyc.j.code !== 'invalid-output' || !/环/.test(String(cyc.j.error))) bad.push('成环没被拒：' + JSON.stringify(cyc.j && { code: cyc.j.code, error: String(cyc.j.error).slice(0, 120) }));
    const ghost = run(w('ghost.json', { nodes: [{ id: 'a', step: 'pdftext', needs: ['nope'] }] }));
    if (!ghost.j || ghost.j.ok !== false || ghost.j.code !== 'invalid-output') bad.push('needs 引用不存在的 id 没被拒');
    const dup = run(w('dup.json', { nodes: [{ id: 'a', step: 'to' }, { id: 'a', step: 'pages' }] }));
    if (!dup.j || dup.j.ok !== false) bad.push('节点 id 重复没被拒');
    const two = run(w('two.json', { nodes: [{ id: 'a', step: 'to' }, { id: 'b', step: 'to' }] }));
    if (!two.j || two.j.ok !== false || !/多个 to/.test(String(two.j.error))) bad.push('多个 to 节点没拒（to 吃源文件，一图只该一个）');
    const badop = run(w('badop.json', { nodes: [{ id: 'a', step: 'pdftext' }, { id: 'b', step: 'ocr', needs: ['a'], when: { step: 'a', field: 'chars', op: 'regex', value: 'x' } }] }));
    if (!badop.j || badop.j.ok !== false) bad.push('未知 when.op 没被拒');
    const noflow = spawnSync(process.execPath, [__filename, 'pipeline', src, '--dag', w('only-dag.json', { nodes: [{ id: 'a', step: 'to' }] })], { encoding: 'utf8' });
    let nf = null; try { nf = JSON.parse(String(noflow.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!nf || nf.ok !== true) bad.push('只给 --dag 不给 flow 时必须能跑（否则新面被旧前置卡死）：' + JSON.stringify(nf && { code: nf.code, error: String(nf.error).slice(0, 100) }));
    if (noPdftotext) return bad.length ? bad.join(' | ') : 'skip（这台机器没有 pdftotext：含 pdftext 步的正向流跑不了，纯校验面已核）';
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  }, { needs: 'kit' });

  t('frommd 生产方向：md→docx/odt/html/pdf 产物可解包且正文样本词在位、原件零改动、缺件降级、参数互斥', () => {
    if (!pandocTool().present) return 'skip（这台机器没有 pandoc：frommd 全条是现场面，无静态半段可代跑——与 markdown 降级判据同口径）';
    const bad = [];
    const md = `${S}/prod-src.md`;
    fs.writeFileSync(md, '# 标题生产串PRODUCEHEAD\n\n这是正文段落，含唯一词 PRODUNIQUE 与第二个词 PRODTWO。\n\n- 列表项 PRODLIST\n\n```js\nconst codeShouldNotCount = 1; // PRODCODE 不该进样本\n```\n\n[锚文本PRODANCHOR](file:///C:/不存在的路径PRODURL)\n\n| 甲 | 乙 |\n|---|---|\n| PRODC1 | PRODC2 |\n');
    const before = sha256(fs.readFileSync(md));
    const F = (extra, out) => { const p = spawnSync(process.execPath, [__filename, 'frommd', md, ...(out ? [out] : []), ...(extra || [])], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return { p, j }; };
    for (const to of ['docx', 'odt', 'html']) {
      const r = F(['--to', to]);
      if (!r.j || r.j.ok !== true) { bad.push(`${to} 失败：${JSON.stringify(r.j && { code: r.j.code, error: String(r.j.error).slice(0, 120) })}`); continue; }
      if (r.j.produced !== to) bad.push(to + ' 没自报 produced');
      if (!r.j.verify || !(r.j.verify.sample > 0) || !(r.j.verify.found > 0)) bad.push(`${to} 的正文回读没验到词（sample/found=${JSON.stringify(r.j.verify)}）——退码 0 不算结论`);
      if (r.j.verify && r.j.verify.missing && r.j.verify.missing.length) bad.push(`${to} 样本词找不齐：${r.j.verify.missing.join(' , ')}`);
      if (!r.j.output || !fs.existsSync(r.j.output.path)) bad.push(to + ' 报的落点不在盘上');
      if (r.j.input && r.j.input.unchanged !== true) bad.push(to + ' 说原件被动过');
      if (/[A-Za-z]{6,}/.test(JSON.stringify(r.j).match(/PRODUNIQUE|PRODUCEHEAD|PRODTWO/g) || '')) bad.push(to + ' 把正文串回显进回报了');
    }
    if (sha256(fs.readFileSync(md)) !== before) bad.push('frommd 改了输入的 md');
    const noPdf = F(['--to', 'pdf']);
    if (!noPdf.j || noPdf.j.ok === false && noPdf.j.code === 'invalid-output') bad.push('--to pdf 被参数校验挡了（应当是走浏览器或 unavailable）：' + JSON.stringify(noPdf.j && { code: noPdf.j.code }));
    else if (noPdf.j.ok === true) { if (!(noPdf.j.verify && noPdf.j.verify.found > 0)) bad.push('pdf 产物没做正文回读核验'); }
    else if (['unavailable', 'failed'].includes(noPdf.j.code)) { if (!/DOCKIT_BROWSER|pdftotext|浏览器/.test(String(noPdf.j.next))) bad.push('pdf 支失败却没指路浏览器/pdftotext：' + String(noPdf.j.next).slice(0, 120)); }
    else bad.push('pdf 支码不在预期面：' + noPdf.j.code);
    const badTo = F(['--to', 'htm']);
    if (!badTo.j || badTo.j.ok !== false || badTo.j.code !== 'invalid-output') bad.push('错拼的 --to 没被拒');
    else if (!Array.isArray(badTo.j.candidates) || !badTo.j.candidates.includes('html')) bad.push('错拼的 --to 没回最近邻候选：' + JSON.stringify(badTo.j.candidates));
    const farTo = F(['--to', 'rtf']);
    if (!farTo.j || farTo.j.ok !== false || farTo.j.code !== 'invalid-output') bad.push('差太远的 --to 也必须拒');
    else if (farTo.j.candidates && farTo.j.candidates.length) bad.push('差太远宁可不给候选（给个不相干的比给空害处大）：' + JSON.stringify(farTo.j.candidates));
    const cssDocx = F(['--to', 'docx', '--css', md]);
    if (!cssDocx.j || cssDocx.j.ok !== false || cssDocx.j.code !== 'invalid-output') bad.push('--css 配 docx 该前置拒（docx 不吃 CSS）');
    const clash = `${S}/clash.md`; fs.writeFileSync(clash, '占位');
    const dup = F([], clash);
    if (!dup.j || dup.j.ok !== false || dup.j.code !== 'invalid-output') bad.push('输出撞已存在文件没拒（永不覆盖破了）');
    else if (str(fs.readFileSync(clash)) !== '占位') bad.push('撞车时把既有文件改了');
    const self = spawnSync(process.execPath, [__filename, 'frommd', clash, clash], { encoding: 'utf8' });
    let sj = null; try { sj = JSON.parse(String(self.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!sj || sj.ok !== false) bad.push('输入=输出没被拒');
    const notMd = F2js(['frommd', 'package.json']);
    if (!notMd || notMd.ok !== false || notMd.code !== 'unsupported-format') bad.push('非 markdown 后缀该 unsupported-format，实为 ' + JSON.stringify(notMd && { code: notMd.code, ok: notMd.ok }));
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });
  function F2js(a) { const p = spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', cwd: ROOT }); try { return JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { return null; } }

  t('compress：孤儿对象回收＋明文流 deflate，无损由页数与正文逐字相等共同证明（v2.7.0，不依赖 ghostscript）', () => {
    if (loadPdfLib().error) return 'skip（这台机器没有 pdf-lib：compress 跑不了，属外部依赖缺失不是缺陷）';
    if (!popplerTool('pdftotext').present) return 'skip（这台机器没有 pdftotext：无损核验那半跑不了，装置宁可 SKIP 也不出"没验证的压缩件"）';
    const bad = [];
    const big = Buffer.from('BT /F1 12 Tf 40 700 Td (COMPRESS ME PLAINLY ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(20) + ') Tj ET', 'latin1');
    const f = `${S}/cmp-in.pdf`;
    fs.writeFileSync(f, mkPdfBytes([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      mkPdfStream('<< /Length 0 >>', big),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Annot /Subtype /Link /Rect [1 1 2 2] >>',
    ], ''));
    const before = sha256(fs.readFileSync(f));
    const C = (extra, out) => { const p = spawnSync(process.execPath, [__filename, 'compress', f, ...(out ? [out] : []), ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return { p, j }; };
    const a = C();
    if (!a.j || a.j.ok !== true) return 'compress 跑不通：' + JSON.stringify(a.j && { code: a.j.code, error: String(a.j.error).slice(0, 160) });
    const bads = [];
    if (!a.j.verify || a.j.verify.textEqual !== true || a.j.verify.pagesEqual !== undefined && a.j.verify.pagesEqual === false) bads.push('没交出"正文逐字相等＋页数相等"的证据');
    if (a.j.verify && a.j.verify.pagesBefore !== a.j.verify.pagesAfter) bads.push(`页数变了：${a.j.verify.pagesBefore}→${a.j.verify.pagesAfter}`);
    if (!(a.j.orphanObjectsRemoved >= 1)) bads.push('那个谁都不引用的对象 6 没被回收（orphanObjectsRemoved=' + a.j.orphanObjectsRemoved + '）——回收那一半没生效');
    if (!(a.j.streamsDeflated >= 1)) bads.push('未压缩的正文流没被 deflate（streamsDeflated=' + a.j.streamsDeflated + '）');
    if (!(a.j.output.bytes < a.j.input.bytes)) bads.push(`产物没变小（${a.j.input.bytes}→${a.j.output.bytes}）——两件动作都做了却没省，判据要红`);
    if (sha256(fs.readFileSync(f)) !== before) bads.push('原件被动了');
    const back = spawnSync(process.execPath, [__filename, 'check', a.j.output.path], { encoding: 'utf8' });
    let bj = null; try { bj = JSON.parse(String(back.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!bj || bj.ok !== true) bads.push('产物 check 读不通：' + JSON.stringify(bj && { code: bj.code }));
    else if (bj.counts['meta-field'] && bj.counts['meta-field'] > 0) bads.push('产物凭空多出元数据结论（不该由压缩引入新内容）');
    const clash = `${S}/cmp-out.pdf`; fs.writeFileSync(clash, '%PDF-1.4\n占位占位\n%%EOF\n');
    const sh = sha256(fs.readFileSync(clash));
    const b2 = C([], clash);
    if (!b2.j || b2.j.ok !== false || b2.j.code !== 'invalid-output') bads.push('输出撞已存在没拒');
    else if (sha256(fs.readFileSync(clash)) !== sh) bads.push('撞车时把既有文件改了');
    const mini = C(['--min-stream-bytes', '10']);
    if (!mini.j || mini.j.ok !== false || mini.j.code !== 'invalid-output') bads.push('--min-stream-bytes 低于 64 没拒（deflate 有头开销）');
    const notPdf = `${S}/cmp-notpdf.docx`;
    fs.writeFileSync(notPdf, zipWrite([{ name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: 'word/document.xml', data: Buffer.from(`<w:document ${S_}><w:body/></w:document>`) }]));
    const nonPdf = F2js(['compress', notPdf]);
    if (!nonPdf || nonPdf.ok !== false || nonPdf.code !== 'unsupported-format') bads.push('非 PDF 输入该 unsupported-format，实为 ' + JSON.stringify(nonPdf && { code: nonPdf.code, error: String(nonPdf && nonPdf.error).slice(0, 90) }));
    const enc = F2js(['compress', ROOT + '/test/fixtures/encrypted.pdf']);
    if (!enc || enc.ok !== false || enc.code !== 'unsupported-format') bads.push('加密件该 unsupported-format（不绕加密），实为 ' + JSON.stringify(enc && { code: enc.code }));
    else if (!/解密/.test(String(enc.next))) bads.push('加密件没指解密');
    // 带表单的件必须前置拒（回收会丢交互层）
    const form = mkPdfBytes([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Annots [5 0 R] >>',
      '<< /Length 0 >>',
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (f1) /V (secret) /Rect [10 10 60 24] >>',
      '<< /Fields [5 0 R] >>',
    ], '');
    const fform = `${S}/cmp-form.pdf`; fs.writeFileSync(fform, form);
    const fr = F2js(['compress', fform]);
    if (!fr || fr.ok !== false || fr.code !== 'unsupported-format') bads.push('带 AcroForm 的件没拒：' + JSON.stringify(fr && { code: fr.code, error: String(fr.error).slice(0, 100) }));
    else if (!/交互层|表单/.test(String(fr.error))) bads.push('拒绝文案没说清丢的是什么');
    return bads.length ? bads.slice(0, 7).join(' | ') : true;
  });

  t('redline 修订写入：insert/delete/comment 写进去并被装置自己回读到、原件零改动、覆盖拒绝', () => {
    const bad = [];
    const bodyOf = (t1) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>${t1}</w:t></w:r></w:p><w:p><w:r><w:t>第二段 目标串TARGETPARA 结束</w:t></w:r></w:p></w:body></w:document>`;
    const base = `${S}/rl-base.docx`;
    fs.writeFileSync(base, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CT) },
      { name: '_rels/.rels', data: Buffer.from(RELS) },
      { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCRELS) },
      { name: 'word/document.xml', data: Buffer.from(bodyOf('第一段')) },
    ]));
    const sha0 = sha256(fs.readFileSync(base));
    const RL = (op, extra) => { const p = spawnSync(process.execPath, [__filename, 'redline', base, op, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return { p, j }; };
    const ins = RL('insert', ['--text', '插入文字INSERTEXT', '--match', '目标串TARGETPARA', '--author', '自检作者']);
    if (!ins.j || ins.j.ok !== true) return 'redline insert 跑不通：' + JSON.stringify(ins.j && { code: ins.j.code, error: String(ins.j.error).slice(0, 170) });
    const backOf = (j) => { const p = spawnSync(process.execPath, [__filename, 'check', j.output.path, '--kind', 'revisions,comments'], { encoding: 'utf8' }); try { return JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { return null; } };
    const ck = backOf(ins.j);
    if (!ck || ck.ok !== true) bad.push('insert 产物 check 读不通');
    else if ((ck.counts.revisions || 0) !== 1) bad.push('insert 后 check 应数到 1 处未接受修订，实为 ' + JSON.stringify(ck.counts));
    const dl = RL('delete', ['--match', '目标串TARGETPARA']);
    if (!dl.j || dl.j.ok !== true) bad.push('delete 失败：' + String(dl.j && dl.j.error).slice(0, 140));
    else { const c2 = backOf(dl.j); if (!c2 || (c2.counts.revisions || 0) !== 1) bad.push('delete 后 check 没数到删除修订：' + JSON.stringify(c2 && c2.counts)); }
    const cm = RL('comment', ['--text', '批注正文COMMENTTEXT', '--match', '目标串TARGETPARA']);
    if (!cm.j || cm.j.ok !== true) bad.push('comment 失败：' + String(cm.j && cm.j.error).slice(0, 160));
    else {
      const c3 = backOf(cm.j);
      if (!c3 || (c3.counts.comments || 0) !== 1) bad.push('comment 后 check 没数到批注：' + JSON.stringify(c3 && c3.counts));
      const cmap = zipRead(fs.readFileSync(cm.j.output.path));
      if (!/comments\.xml/.test(str(cmap.get('word/_rels/document.xml.rels') || Buffer.alloc(0)))) bad.push('批注的 rels 登记没做成（包里有部件但没有指向它的关系）');
      if (!/word\/comments\.xml/.test(str(cmap.get('[Content_Types].xml') || Buffer.alloc(0)))) bad.push('批注的 [Content_Types] 登记没做成');
      const parts = spawnSync(process.execPath, [__filename, 'dump', cm.j.output.path, '--part', 'word/comments.xml'], { encoding: 'utf8' });
      let dj = null; try { dj = JSON.parse(String(parts.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
      if (!dj || dj.ok !== true) bad.push('批注件读不通（回写把包弄坏了？）：' + JSON.stringify(dj && { code: dj.code, error: String(dj.error).slice(0, 120) }));
    }
    if (sha256(fs.readFileSync(base)) !== sha0) bad.push('🔴 原件被动了（redline 必须复制优先）');
    for (const j of [ins.j, cm.j]) if (j && j.verify && j.verify.textPresent !== true) bad.push('回读没验到写入文本：' + JSON.stringify(j.verify));
    if (dl.j && dl.j.verify && dl.j.verify.delTextPresent !== true) bad.push('delete 的回读没证明被删文字进了 delText：' + JSON.stringify(dl.j.verify));
    const acc = RL('accept');
    if (!acc.j || acc.j.ok !== true) bad.push('accept 失败：' + String(acc.j && acc.j.error).slice(0, 140));
    const rej = RL('reject');
    if (!rej.j || rej.j.ok !== true) bad.push('reject 失败（无修订件应通过）：' + String(rej.j && rej.j.error).slice(0, 140));
    const withRev = `${S}/rl-withrev.docx`;
    fs.writeFileSync(withRev, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: '_rels/.rels', data: Buffer.from(RELS) },
      { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:ins w:id="1" w:author="甲"><w:r><w:t>被插入的串INSKEEP</w:t></w:r></w:ins><w:del w:id="2" w:author="乙"><w:r><w:delText>被删除的串DELGONE</w:delText></w:r></w:del></w:p></w:body></w:document>`) },
    ]));
    const A = (op) => { const p = spawnSync(process.execPath, [__filename, 'redline', withRev, op], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return j; };
    const acc2 = A('accept'), rej2 = A('reject');
    if (!acc2 || acc2.ok !== true) bad.push('带修订件的 accept 失败：' + String(acc2 && acc2.error).slice(0, 150));
    if (!rej2 || rej2.ok !== true) bad.push('带修订件的 reject 失败：' + String(rej2 && rej2.error).slice(0, 150));
    if (acc2 && acc2.ok === true && rej2 && rej2.ok === true) {
      const x1 = rlReadText(acc2.output.path), x2 = rlReadText(rej2.output.path);
      if (x1 === null || x2 === null) bad.push('accept/reject 产物解包读不通（写坏了包）');
      else {
        if (!/INSKEEP/.test(x1.visible)) bad.push('accept 后插入的文字应当留下');
        if (/DELGONE/.test(x1.visible) || /<w:del\b/.test(x1.raw)) bad.push('accept 后被删的文字应当消失、w:del 应当清空');
        if (/INSKEEP/.test(x2.visible) || /<w:ins\b/.test(x2.raw)) bad.push('reject 后插入的文字应当消失');
        if (!/DELGONE/.test(x2.visible)) bad.push('reject 后被删的文字应当还原成正常文本（delText 没变回 w:t）');
      }
    }
    const fmt = `${S}/rl-fmtrev.docx`;
    fs.writeFileSync(fmt, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: '_rels/.rels', data: Buffer.from(RELS) },
      { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:rPr><w:rPrChange w:id="3" w:author="丙"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr><w:t>格式修订串FMT</w:t></w:r></w:p></w:body></w:document>`) },
    ]));
    const rej3 = F2js(['redline', fmt, 'reject']);
    if (!rej3 || rej3.ok !== false || rej3.code !== 'unsupported-format') bad.push('带格式修订的 reject 该前置拒（不做假还原），实为 ' + JSON.stringify(rej3 && { code: rej3.code }));
    const noTxt = RL('insert', ['--match', '目标串TARGETPARA']);
    if (noTxt && noTxt.j === null) bad.push('insert 缺 --text 应拒');
    const miss = RL('insert', ['--text', 'x', '--match', '根本没这个串ZZZ']);
    if (!miss.j || miss.j.ok !== false || miss.j.code !== 'invalid-output') bad.push('--match 没命中却没拒（找不到就写＝不知道写到哪去了）');
    const over = RL('insert', ['--text', 'x', '--para', '99']);
    if (!over.j || over.j.ok !== false || !/一共 2 个段落/.test(String(over.j.error))) bad.push('--para 越界没回真实段落数：' + String(over.j && over.j.error).slice(0, 100));
    const both = RL('accept', ['--text', '不该给']);
    if (!both.j || both.j.ok !== false) bad.push('accept 传 --text 该拒（它作用于全文修订）');
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });

  t('redact 真涂黑：删算子＋回读证明 needle 零命中；找不到/无文本层/加密件都不许宣称涂过', () => {
    if (loadPdfLib().error) return 'skip（这台机器没有 pdf-lib：redact 跑不了）';
    if (!popplerTool('pdftotext').present) return 'skip（这台机器没有 pdftotext：定位与验收两条腿都在它身上，缺它就只能画框＝假涂黑）';
    const bad = [];
    const f = `${S}/rd-in.pdf`;
    const { PDFDocument } = (() => { try { return require('pdf-lib'); } catch { return {}; } })();
    fs.writeFileSync(f, mkPdfBytes([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      mkPdfStream('<< /Length 0 >>', Buffer.from('BT /F1 12 Tf 20 150 Td (PUBLIC LINE ONE) Tj ET\nBT /F1 12 Tf 20 120 Td (SECRET TARGET STRING) Tj ET\nBT /F1 12 Tf 20 90 Td (PUBLIC LINE THREE) Tj ET', 'latin1')),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ], ''));
    const sha0 = sha256(fs.readFileSync(f));
    const R = (extra) => { const p = spawnSync(process.execPath, [__filename, 'redact', f, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return { p, j }; };
    const a = R(['--needle', 'SECRET TARGET STRING']);
    if (!a.j || a.j.ok !== true) return 'redact 正向跑不通：' + JSON.stringify(a.j && { code: a.j.code, error: String(a.j.error).slice(0, 180) });
    if (!(a.j.textOpsRemoved >= 1)) bad.push('没删掉任何文本绘制组（只画框＝假涂黑）：' + a.j.textOpsRemoved);
    if (!a.j.verify || a.j.verify.residual !== 0) bad.push('验收没给出"零残留"证据：' + JSON.stringify(a.j.verify));
    const outTxt = F2js(['pdftext', a.j.output.path]);
    if (outTxt && outTxt.ok === true) {
      const t2 = str(fs.readFileSync(outTxt.file));
      if (/SECRET TARGET STRING/.test(t2)) bad.push('🔴 产物文本层里仍能找到 needle——这就是假涂黑');
      if (!/PUBLIC LINE ONE/.test(t2) || !/PUBLIC LINE THREE/.test(t2)) bad.push('涂黑把**该留的文字也弄丢了**（应当只删命中的 BT/ET 组）');
    } else bad.push('产物 pdftext 读不通（涂黑后文件坏了？）');
    if (sha256(fs.readFileSync(f)) !== sha0) bad.push('原件被动了');
    const nf = R(['--needle', 'NEVER THERE ANYWHERE ZZ']);
    if (!nf.j || nf.j.ok !== false || nf.j.code !== 'invalid-output') bad.push('needle 找不到却没拒（找不到就不能宣称涂过）');
    const none = R();
    if (!none.j || none.j.ok !== false) bad.push('不给 needle 却没拒（不做"整页抹白"）');
    const nfj = `${S}/rd-n.json`; fs.writeFileSync(nfj, JSON.stringify(['PUBLIC LINE ONE', '不存在串ZZ']));
    const part = R(['--needles', nfj]);
    if (!part.j || part.j.ok !== false || part.j.code !== 'invalid-output' || !/不存在串ZZ/.test(String(part.j.error))) bad.push('needles 里有一枚找不到时应整体拒并点名，实为 ' + JSON.stringify(part.j && { code: part.j.code, error: String(part.j.error).slice(0, 90) }));
    const inline = R(['--needles', '["A"]']);
    if (!inline.j || inline.j.ok !== false) bad.push('--needles 给内联 JSON 当文件路径时必须失败（不许猜调用方意图）');
    const scan = `${S}/rd-scan.pdf`;
    fs.writeFileSync(scan, mkPdfBytes([
      '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
    ], ''));
    const sc = F2js(['redact', scan, '--needle', 'ANYTHING']);
    if (!sc || sc.ok !== false) bad.push('无文本层的件该拒（扫描件的涂黑要走 OCR 定坐标，装置不做那条路）');
    const enc = F2js(['redact', ROOT + '/test/fixtures/encrypted.pdf', '--needle', 'x']);
    if (!enc || enc.ok !== false || enc.code !== 'unsupported-format') bad.push('加密件该 unsupported-format，实为 ' + JSON.stringify(enc && { code: enc.code }));
    const badJson = `${S}/rd-bad.json`; fs.writeFileSync(badJson, JSON.stringify({ notNeedles: 1 }));
    const bj = R(['--needles', badJson]);
    if (!bj.j || bj.j.ok !== false) bad.push('needles JSON 形状不对没拒');
    // ---- v3.1.0 三件：--fill none / 删多预警 / 旋转页前置拒 ----
    // ① --fill none：删字留白（不画框），keep 行必须逐字保留、needle 必须零命中；black 回归不变
    const en = R(['--needle', 'SECRET TARGET STRING', '--fill', 'none']);
    if (!en.j || en.j.ok !== true || en.j.fill !== 'none') bad.push('--fill none 正向没跑通：' + JSON.stringify(en.j && { code: en.j.code, fill: en.j.fill }));
    else {
      const enTxt = F2js(['pdftext', en.j.output.path]);
      const t3 = enTxt && enTxt.ok === true ? str(fs.readFileSync(enTxt.file)) : '';
      if (/SECRET TARGET STRING/.test(t3)) bad.push('--fill none 后 needle 仍在（删字留白失败）');
      if (!/PUBLIC LINE ONE/.test(t3) || !/PUBLIC LINE THREE/.test(t3)) bad.push('--fill none 把 keep 行也弄丢了');
    }
    const ef = R(['--needle', 'SECRET TARGET STRING', '--fill', 'blue']);
    if (!ef.j || ef.j.ok !== false || ef.j.code !== 'invalid-output') bad.push('--fill 非法值该拒（black|none 白名单）');
    // ② 删多预警：一段 BT…ET 块画两行（双 Td，第二行在 needle 框外）⇒ 整段删＝顺手删 KEEPME，blocksWithOutsideText 必须 ≥1 并 warning
    const fCross = `${S}/rd-cross.pdf`;
    fs.writeFileSync(fCross, mkPdfBytes([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      mkPdfStream('<< /Length 0 >>', Buffer.from('BT /F1 12 Tf 20 150 Td (SECRET TARGET STRING) Tj 0 -30 Td (KEEPME NEIGHBOUR) Tj ET\nBT /F1 12 Tf 20 90 Td (PUBLIC LINE THREE) Tj ET', 'latin1')),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ], ''));
    // 🔴 删多例必须独立 spawn（R 闭包的文件名固定在 rd-in.pdf，复用它会把两例写进同一文件）
    const RC = (extra) => { const p = spawnSync(process.execPath, [__filename, 'redact', fCross, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return { p, j }; };
    const ec = RC(['--needle', 'SECRET TARGET STRING']);
    if (!ec.j || ec.j.ok !== true) bad.push('删多场景正向没跑通：' + JSON.stringify(ec.j && { code: ec.j.code }));
    else if (!(ec.j.blocksWithOutsideText >= 1)) bad.push('同段块跨行时删多预警没响（blocksWithOutsideText 应 ≥1，删多静默＝验收只防删漏不防删多的老形状）');
    // ③ 旋转页前置拒：/Rotate 90 的件（无论 needle 找不找得到）都 unsupported-format，不许按错误映射动手
    const fRot = `${S}/rd-rot.pdf`;
    fs.writeFileSync(fRot, mkPdfBytes([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Rotate 90 /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      mkPdfStream('<< /Length 0 >>', Buffer.from('BT /F1 12 Tf 50 650 Td (KEEPME LINE A) Tj ET', 'latin1')),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ], ''));
    // 🔴 旋转例必须独立 spawn（R 闭包的文件名固定在 rd-in.pdf，复用它会把两例写进同一文件）
    const RR = (extra) => { const p = spawnSync(process.execPath, [__filename, 'redact', fRot, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return { p, j }; };
    const er = RR(['--needle', 'NEVER THERE ZZ']);
    if (!er.j || er.j.ok !== false || er.j.code !== 'unsupported-format' || !/Rotate/.test(String(er.j.error))) bad.push('旋转页该前置拒（unsupported-format 且 error 点名 /Rotate；v3.1.0 实测错误映射会删错字）');
    // ④ --dry-run 试运行：只预览不写盘（wouldSucceed 真、产物文件不存在、输入 sha 不变）；needle 找不到时预览报 wouldSucceed=false 且同样不写盘不拒收
    const ed = R(['--needle', 'SECRET TARGET STRING', '--dry-run']);
    if (!ed.j || ed.j.ok !== true || ed.j.dryRun !== true) bad.push('dry-run 正向没跑通（试运行分支被摘＝预览变真跑）：' + JSON.stringify(ed.j && { code: ed.j.code, dryRun: ed.j.dryRun }));
    else {
      if (ed.j.wouldSucceed !== true) bad.push('dry-run 在全找得到的件上 wouldSucceed 该 true');
      if (!Array.isArray(ed.j.notFoundNeedles) || ed.j.notFoundNeedles.length !== 0) bad.push('dry-run 的 notFoundNeedles 该为空');
      if (ed.j.wouldWriteTo && fs.existsSync(ed.j.wouldWriteTo)) { try { fs.unlinkSync(ed.j.wouldWriteTo); } catch { } bad.push('dry-run 落盘了（试运行必须零写入）'); }
      if (sha256(fs.readFileSync(f)) !== sha0) bad.push('dry-run 动了输入（试运行必须零写入）');
    }
    const ed2 = R(['--needle', 'NEVER THERE ZZ', '--dry-run']);
    if (!ed2.j || ed2.j.ok !== true || ed2.j.dryRun !== true || ed2.j.wouldSucceed !== false) bad.push('dry-run 在找不到 needle 时该报 wouldSucceed=false 且不拒收（预览只点名）');
    else if (ed2.j.wouldWriteTo && fs.existsSync(ed2.j.wouldWriteTo)) { try { fs.unlinkSync(ed2.j.wouldWriteTo); } catch { } bad.push('dry-run 落盘了（试运行必须零写入）'); }
    // ⑤ XObject 残留：文字只在 Form XObject 里（页内容流无 BT 可删）⇒ 定位找得到、删不掉，验收必须 failed 抓出来（文档自承"验收会抓"，判据钉住它；v3.2.0 自检实测 pdftotext -bbox 看得见 XObject 文本）
    const fXo = `${S}/rd-xo.pdf`;
    fs.writeFileSync(fXo, mkPdfBytes([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >> >>',
      mkPdfStream('<< /Length 0 >>', Buffer.from('q 1 0 0 1 50 150 cm /Fm0 Do Q\n', 'latin1')),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      mkPdfStream('<< /Type /XObject /Subtype /Form /BBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Length 0 >>', Buffer.from('BT /F1 16 Tf 0 0 Td (SECRET XOBJECT ONLY) Tj ET\n', 'latin1')),
    ], ''));
    // 🔴 XObject 例必须独立 spawn（R 闭包的文件名固定在 rd-in.pdf，复用它会把两例写进同一文件）
    const RX = (extra) => { const p = spawnSync(process.execPath, [__filename, 'redact', fXo, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return { p, j }; };
    const ex = RX(['--needle', 'SECRET XOBJECT ONLY']);
    if (!ex.j || ex.j.ok !== false || ex.j.code !== 'failed' || !/仍能找到/.test(String(ex.j.error))) bad.push('XObject 里的同一串必须 failed（定位找得到、页内容流删不掉，验收抓残留）：' + JSON.stringify(ex.j && { code: ex.j.code }));
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  });

  t('tables 几何抽取：docx 带边框表格转 PDF 后逐格相等；无网格回空且不猜表', () => {
    if (!fs.existsSync(realDoc) && false) return 'skip';
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const cellXml = (t1, wid) => `<w:tc><w:tcPr><w:tcW w:w="${wid}" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${t1}</w:t></w:r></w:p></w:tc>`;
    const tr = (ts) => `<w:tr>${ts.map((x) => cellXml(x, 2200)).join('')}</w:tr>`;
    const BD = '<w:top w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="6" w:space="0" w:color="000000"/>';
    const tbl = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/><w:tblBorders>${BD}</w:tblBorders></w:tblPr>` + tr(['COLHA', 'COLHB']) + tr(['CELL11', 'CELL12']) + tr(['CELL21', 'CELL22']) + '</w:tbl>';
    const srcDoc = `${S}/tb-src.docx`;
    fs.writeFileSync(srcDoc, zipWrite([
      { name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: '_rels/.rels', data: Buffer.from(RELS) },
      { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${tbl}<w:p><w:r><w:t>表外段落表外段落表外</w:t></w:r></w:p></w:body></w:document>`) },
    ]));
    const cv = runKit(['convert', '--input', srcDoc, '--output', `${S}/tb.pdf`, '--timeout-ms', '90000']);
    if (!cv.ok) return `kit 转换没成（拿不到带网格的 PDF 样本）：${cv.code} ${String(cv.error).slice(0, 90)}`;
    if (!popplerTool('pdftotext').present) return 'skip（这台机器没有 pdftotext：词框入格面跑不了，kit 转网格 PDF 面已核）';
    const T = (f, extra) => { const p = spawnSync(process.execPath, [__filename, 'tables', f, ...(extra || [])], { encoding: 'utf8' }); let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { } return { p, j }; };
    const bad = [];
    const a = T(`${S}/tb.pdf`);
    if (!a.j || a.j.ok !== true) return 'tables 跑不通：' + JSON.stringify(a.j && { code: a.j.code, error: String(a.j.error).slice(0, 170) });
    if (a.j.count !== 1) return `应抽出 1 张表，实为 ${a.j.count}（清单：${JSON.stringify(a.j.tables).slice(0, 200)}）——网格法在 LibreOffice 真输出上失配，这条判据要红给人看`;
    const t1 = a.j.tables[0];
    if (t1.rows !== 3 || t1.cols !== 2) bad.push(`行列数应为 3×2，实为 ${t1.rows}×${t1.cols}`);
    const csv = fs.readFileSync(t1.file, 'utf8').replace(/^﻿/, '');
    const want = ['COLHA', 'COLHB', 'CELL11', 'CELL12', 'CELL21', 'CELL22'];
    for (const w of want) if (!csv.includes(w)) bad.push('产物 CSV 里没有 ' + w);
    if (/表外段落/.test(csv)) bad.push('表外的段落被塞进表里了（网格边界没管住）');
    if (csv.split('\n')[0] !== 'COLHA,COLHB') bad.push('表头行顺序不对：' + JSON.stringify(csv.split('\n')[0]));
    if (!/﻿/.test(fs.readFileSync(t1.file, 'utf8'))) bad.push('CSV 没带 UTF-8 BOM（Excel 开中文会乱码）');
    if (sha256(fs.readFileSync(`${S}/tb.pdf`)) !== sha256(fs.readFileSync(`${S}/tb.pdf`))) bad.push('hash 自证异常');
    const plain = `${S}/tb-plain.pdf`;
    fs.writeFileSync(plain, mkPdfBytes([
      '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      mkPdfStream('<< /Length 0 >>', Buffer.from('BT /F1 12 Tf 20 150 Td (NO GRID AT ALL HERE) Tj ET', 'latin1')),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ], ''));
    const b = T(plain);
    if (!b.j || b.j.ok !== true) bad.push('无网格件不该报错，实为 ' + JSON.stringify(b.j && { code: b.j.code }));
    else {
      if (b.j.count !== 0) bad.push('无网格件却报了表（猜表）：' + JSON.stringify(b.j.tables));
      if (!b.j.warnings || !b.j.warnings.some((x) => /不猜表|没抽到任何表/.test(x))) bad.push('没自曝"没网格就不出表"');
    }
    const ole = T(srcDoc);
    if (!ole.j || ole.j.ok !== false || ole.j.code !== 'unsupported-format') bad.push('非 PDF 输入该 unsupported-format（并指路 to ... .csv）');
    return bad.length ? bad.slice(0, 7).join(' | ') : true;
  }, { needs: 'kit' });

  t('变异台写盘韧性与结论优先（v2.7.0 实犯：收尾还原撞文件锁，整轮 221 例读数随 stdout 一起丢）', () => {
    const msrc = String(fs.readFileSync(ROOT + '/test/mutant.js'));
    // 🔴 自指判据必须先**排除 MUTANTS 表体**：M224/M225 攻击的就是这个文件自己，表里写着锚串与调用形状，
    //    拿全文做 indexOf／计数会读到定义行（2026-10-14 实犯：M225 把顺序打反了判据却仍绿——打印点与还原点
    //    两个 indexOf 都先命中 M225 自己那一行）。⇒ 只取「表体之外的可执行面」当被测文本。
    const mstart = msrc.indexOf('const MUTANTS = [');
    const mend = msrc.indexOf('\n];', mstart);
    if (mstart < 0 || mend < 0) return 'MUTANTS 数组边界找不到——自指判据无从排除定义行（先修判据自身）';
    const code = msrc.slice(0, mstart) + msrc.slice(mend);
    const bad = [];
    if (!/function writeHard\(/.test(code)) bad.push('台子里找不到 writeHard（写回没有韧性层）');
    for (const c of ['EBUSY', 'EPERM', 'UNKNOWN']) if (!new RegExp("'" + c + "'").test(code)) bad.push('锁类码表缺 ' + c);
    const body = (code.match(/function writeHard\([\s\S]*?\n  \}/) || [''])[0];
    const bound = +(body.match(/i < (\d+)/) || [0, 0])[1];
    if (bound < 5) bad.push('重试上界=' + bound + '（瞬时文件锁必须有一层退避，<5 等于没有）');
    const calls = ['writeHard(p, text.replace(m.find, () => m.to)', 'writeHard(p, orig,', 'writeHard(p, buf,'];
    const missing = calls.filter((c) => !code.includes(c));
    if (missing.length) bad.push('三处写回没都走韧性层，缺：' + missing.join(' , '));
    const fin = code.indexOf('} finally {');
    const seg = fin >= 0 ? code.slice(fin) : '';
    if (!seg) bad.push('找不到 finally 收尾块（顺序无从判）');
    else {
      const pAt = seg.indexOf('console.log(JSON.stringify(rows');
      const rAt = seg.indexOf("writeHard(p, buf, '收尾还原')");
      if (pAt < 0 || rAt < 0) bad.push('收尾块里找不到打印点或还原点（对账无从做起）');
      else if (pAt > rAt) bad.push('🔴 读数在还原**之后**才打印——还原抛穿 finally 就会吞掉整轮结论（2026-10-14 实犯形状）');
    }
    if (!/text\.replace\(m\.find, \(\) => m\.to\)/.test(code)) bad.push('🔴 注入不是函数替换：替换串里的 $\'／$&／$1 会被 String.replace 当特殊序列解释（2026-10-14 M227 实犯——to 里含引号-dollar 组合，把 dockit.js 拼成非法 JS，子进程无 JSON，本例只能判说不出结论）');
    if (!/mutant-bak-\$\{[^\n]*md5\(Buffer\.from\(m\.file\)\)/.test(code)) bad.push('备份件名没有路径哈希后缀：CJK 文件名会被 sanitize 撞车（项目总览.md 与 迭代日志.md 同为 ____），撞车＝还原没有干净副本');
    if (/^\s*fs\.writeFileSync\(p, orig\);\s*$/m.test(code)) bad.push('逐例还原仍是裸 writeFileSync');
    if (/^\s*fs\.writeFileSync\(p, text\.replace/m.test(code)) bad.push('注入仍是裸 writeFileSync');
    if (/^\s*for \(const \[p, buf\] of touched\) fs\.writeFileSync/m.test(code)) bad.push('收尾还原仍是裸 writeFileSync（没走 writeHard）');
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('gc 回收面：默认 dry-run 零改动、指纹只认装置签名、执行态是移动不是删除且可逆', () => {
    const bad = [];
    const eq = (got, want, label) => { if (got !== want) bad.push(`${label}：应 ${JSON.stringify(want)} 实 ${JSON.stringify(got)}`); };
    const OUT = ROOT + '/_out';
    ensureDir(OUT);
    const runGc = (extra) => {
      const r = spawnSync(process.execPath, [__filename, 'gc'].concat(extra), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      let j = null; try { j = JSON.parse(String(r.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
      return { j, code: r.status };
    };
    const FIX = 'gc 夹具内容，不参与判定，只占名字与字节';
    // 起手先清掉上一轮崩溃留下的同名夹具：本例是按「恰好搬走 4 件」逐条对账的，残留会让计数对不上（2026-10-14 实犯）
    for (const n of fs.readdirSync(OUT)) if (n.startsWith('gcfixture')) { try { fs.rmSync(path.join(OUT, n), { recursive: true, force: true }); } catch { } }
    const mk = (name, days) => {
      const p = path.join(OUT, name);
      fs.writeFileSync(p, FIX);
      const t = new Date(Date.now() - days * 86400000);
      fs.utimesSync(p, t, t);
      return p;
    };
    const files = [
      mk('gcfixture-old-20260101000000.txt', 30),
      mk('gcfixture-old-20260101000000-2.txt', 30),
      mk('gcfixture-fresh-20260101000000.txt', 1),
      mk('gcfixture-backend.txt.savetmp-fe53203562d9462e8cd0d32e68088d4d', 30),
      mk('gcfixture-human-named.txt', 30),
    ];
    const dirs = [path.join(OUT, 'gcfixture-dir-20260101000000'), path.join(OUT, 'gcfixture-dir-nostamp')];
    for (const d of dirs) { ensureDir(d); fs.writeFileSync(path.join(d, 'inner.txt'), 'x'); const t = new Date(Date.now() - 30 * 86400000); fs.utimesSync(d, t, t); }
    const revive = path.join(OUT, 'gcfixture-revive.txt');
    const before = fs.readdirSync(OUT).length;

    const dry = runGc(['--age', '7', '--base', 'gcfixture-']);
    if (!dry.j || dry.j.ok !== true) return 'gc dry-run 没跑通：' + JSON.stringify(dry.j && { code: dry.j.code, error: String(dry.j.error).slice(0, 140) });
    eq(dry.j.dryRun, true, '不给 --yes 必须自报 dryRun');
    eq(dry.j.moved, 0, 'dry-run 的 moved');
    if (fs.readdirSync(OUT).length !== before) bad.push('🔴 dry-run 竟然动了文件（列目录条数变了）');
    eq(dry.j.candidates, 4, 'dry-run 候选数（本轮新件与人起的名字都不该进面上，多一件就是指纹过宽）');
    const names = JSON.stringify(dry.j);
    // 排除"未匹配样本"数组后再搜：旧正则 `未匹配[^,]*` 只删到第一个逗号，数组多元素时排在后面的
    // human-named 样本泄漏出来造成误报（2026-10-15 公开树实抓：_out 里多一个 cn-scrubbed.odt 时必红）。
    if (/gcfixture-human-named/.test(names.replace(/"未匹配样本":\[[^\]]*\]/g, ''))) bad.push('人起的名字（不带装置时间戳）不该进候选面');
    if (!dry.j.dirs.some((d) => d.未匹配样本 && d.未匹配样本.length)) bad.push('没自报"未匹配样本"，人看不见哪些没被圈进来');

    const exec = runGc(['--yes', '--age', '7', '--base', 'gcfixture-']);
    if (!exec.j || exec.j.ok !== true) bad.push('--yes 执行失败：' + JSON.stringify(exec.j && { code: exec.j.code, error: String(exec.j.error).slice(0, 160) }));
    else {
      eq(exec.j.dryRun, false, '执行态自报 dryRun=false');
      // 🔴 同卷断言：搬运用的是 renameSync，跨卷必 EXDEV——gc 的「可逆」前提就是同卷（2026-10-14 真克隆门实抓：
      //    克隆在 C: 临时目录时 --yes 执行失败，主树却全绿，因为主树与写死的隔离区恰好同在 D:）。
      if (exec.j.quarantine) {
        const qRoot = path.parse(String(exec.j.quarantine)).root;
        if (qRoot !== path.parse(OUT).root) bad.push(`🔴 隔离区与产物区不同卷（${qRoot} vs ${path.parse(OUT).root}）＝renameSync 跨卷必失败，"搬移不删除"在这台机器上是空的`);
      }
      eq(exec.j.moved, 4, '--yes 实际搬移件数（＝四条指纹各一件，多一件少一件都不算对）');
      // 🔴 方向要搞对：**该搬的**在 _out 里必须已经没了、且能在隔离区里指着；**不该搬的**必须还在原位。
      //    （2026-10-14 实犯：我先把这四条写反了——写成 existsSync(该搬的) 为假就报错，于是实现是对的、判据必红。）
      const MUST_GONE = [[files[0], '第一指纹：带装置时间戳的旧件'], [files[1], '第一指纹的 -2 去重后缀分支'],
      [files[3], '第二指纹：后端 .savetmp 事务残骸'], [dirs[0], '第三指纹：目录形态产物']];
      const MUST_STAY = [[files[2], '本轮新件（mtime 1 天，--age 7 该放过）'], [files[4], '人起的名字（不带装置签名）'],
      [dirs[1], '不带时间戳的目录']];
      for (const [p, label] of MUST_GONE) {
        if (fs.existsSync(p)) { bad.push(`${label} 没被搬走（原位置还在）`); continue; }
        const inQ = path.join(String(exec.j.quarantine), '_out', path.basename(p));
        if (!fs.existsSync(inQ)) bad.push(`🔴 ${label} 原位置没了、隔离区里也找不到（${inQ}）＝既不是搬也不是删，说不清去哪了`);
      }
      for (const [p, label] of MUST_STAY) if (!fs.existsSync(p)) bad.push(`🔴 ${label} 被搬走了＝误清，违反"指纹只认装置签名"的收口`);
      const q = exec.j.quarantine;
      if (!q || !fs.existsSync(q)) bad.push('隔离区目录不在：' + q);
      else {
        const mf = path.join(q, 'MANIFEST.md');
        if (!fs.existsSync(mf)) bad.push('隔离区缺 MANIFEST.md＝不可认领、等于不可逆');
        else {
          const txt = str(fs.readFileSync(mf));
          const rows = txt.split('\n').filter((l) => l.startsWith('| ') && l.includes('gcfixture')).length;
          if (rows !== exec.j.moved) bad.push(`MANIFEST 行数 ${rows} 与 moved ${exec.j.moved} 不等＝清单不全，搬不回原样`);
          if (!/不删除/.test(txt) && !/可逆/.test(txt)) bad.push('MANIFEST 没写明"可逆回收，不是删除"');
        }
        // 可逆性实证：按清单把一件搬回原位，**字节**必须与搬走前一致（只验"文件在"不算可逆）
        const inQ = path.join(q, '_out', 'gcfixture-old-20260101000000.txt');
        if (!fs.existsSync(inQ)) bad.push('隔离区里找不到被搬走的件（相对路径形状与清单不符）：' + inQ);
        else {
          fs.renameSync(inQ, revive);
          if (!fs.existsSync(revive)) bad.push('按清单搬回失败＝不可逆');
          else if (str(fs.readFileSync(revive)) !== FIX) bad.push('搬回后内容与原文不一致＝"可逆"是假的');
        }
      }
      // 收尾：这一批隔离件是本例自己造的，验完就整批清掉——不许让自检在用户的隔离区里堆自己的垃圾
      const qOut = path.join(String(q), '_out');
      let qItems = []; try { qItems = fs.readdirSync(qOut); } catch { }
      if (qItems.length && qItems.every((n) => n.startsWith('gcfixture'))) { try { fs.rmSync(String(q), { recursive: true, force: true }); } catch { } }
      else if (qItems.length) bad.push('隔离批次里混进了非本轮夹具的件（' + qItems.slice(0, 3).join(' , ') + '）——本例拒绝自动清理，请人工认领');
    }
    for (const f of files.concat([revive])) { try { fs.rmSync(f, { force: true }); } catch { } }
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
    const src = str(fs.readFileSync(__filename)).replace(/\r\n/g, '\n');
    if (!/const GC_QUARANTINE_ROOT = path\.dirname\(ROOT\)/.test(src)) bad.push('🔴 隔离区落点又写成绝对路径常量（跨卷形状会复辟：主树全绿、克隆态必红）');
    const gcWindowStart = src.indexOf('function cmdGc');
    const gcWindow = src.slice(gcWindowStart, gcWindowStart + 9000);
    if (gcWindowStart < 0) bad.push('找不到 cmdGc（本条后半段无从判，先修判据）');
    // cmdGc 这一整段里**一个 rmSync 都不许出现**：搬运面只许 renameSync。旧写法只盯 path.join(x.dir, x.name)
    // 那一种形状，改成 fs.rmSync(srcPath) 就绕过去了——那是条有缝的牙。
    if (/fs\.rmSync\(/.test(gcWindow)) bad.push('🔴 gc 里出现了 rmSync＝删除而非移动，违反最小破坏授权（机主口径：删除换成可逆隔离）');
    if (!/fs\.renameSync\(srcPath, dstPath\)/.test(gcWindow)) bad.push('gc 的执行面不再是"搬移"（renameSync(srcPath→dstPath) 那条没了）');
    // --age 的下限是装置自我保护：0＝不按年龄过滤，会把**别人正在跑的**那一轮自检工作目录（_tmp/selftest-*，同样带装置时间戳）
    // 整只搬进隔离区，表现是人家那一轮莫名变红 yet 查不出谁动了件。这里**故意不带 --yes**：万一这条闸被人摘掉，
    // 本例也只是列个清单，不会真去扫走任何活目录（判据自己也不许有杀伤半径）。
    const zero = runGc(['--age', '0']);
    if (!zero.j || zero.j.ok !== false || zero.j.code !== 'invalid-output') bad.push('--age 0 没被拒（摘掉下限的代价是自检能把自己埋了）：' + JSON.stringify(zero.j && { code: zero.j.code }));
    // ---- --exclude 面（2026-10-14 实测立）：装置时间戳只证明"不是人起的名字"，不证明"这不是真工件"——
    //      真交付件（课件/作业）转出来的产物同样带签名，本轮在候选面里就数出 12 件。所以"排除"必须：
    //      ① 真的留在原位（行为面，不是只写在文案里）② 单独记账不混进"未匹配"③ 给了空清单要拒（不许静默"什么都不排除"）。
    const exOff = mk('gcx-off-20260101000000.txt', 30);
    const exOn = mk('gcx-on-20260101000000.txt', 30);
    const exDry = runGc(['--age', '7', '--base', 'gcx-', '--exclude', 'gcx-off']);
    if (!exDry.j || exDry.j.ok !== true) bad.push('--exclude 的 dry-run 没跑通：' + JSON.stringify(exDry.j && { code: exDry.j.code }));
    else {
      eq(exDry.j.candidates, 1, 'dry-run 候选数（被排除的那件不该进面上）');
      const od = (exDry.j.dirs || []).find((x) => x.dir === '_out') || {};
      eq(od.被排除条数, 1, '回报里的「被排除条数」（不单独记账就看不出"故意不收"与"没圈进来"的区别）');
      if (!(od.被排除样本 || []).some((n) => n.startsWith('gcx-off'))) bad.push('「被排除样本」没点名被排除的件：' + JSON.stringify(od.被排除样本));
    }
    const exRun = runGc(['--yes', '--age', '7', '--base', 'gcx-', '--exclude', 'gcx-off']);
    if (!exRun.j || exRun.j.ok !== true) bad.push('--exclude 的执行态失败：' + JSON.stringify(exRun.j && { code: exRun.j.code, errors: exRun.j.errors }));
    else {
      eq(exRun.j.moved, 1, '执行态 moved（只许搬走没被排除的那一件）');
      if (!fs.existsSync(exOff)) bad.push('🔴 被 --exclude 圈住的真工件形状还是被搬走了＝这一面是假的');
      if (fs.existsSync(exOn)) bad.push('--exclude 之外的该收件没被搬走');
      const q2 = String(exRun.j.quarantine);
      const qOut2 = path.join(q2, '_out');
      let qi2 = []; try { qi2 = fs.readdirSync(qOut2); } catch { }
      if (qi2.length && qi2.every((n) => n.startsWith('gcx-'))) { try { fs.rmSync(q2, { recursive: true, force: true }); } catch { } }
      else if (qi2.length) bad.push('排除面的隔离批次混进了非本轮夹具：' + qi2.slice(0, 3).join(' , '));
    }
    for (const f of [exOff, exOn]) { try { fs.rmSync(f, { force: true }); } catch { } }
    const emptyEx = runGc(['--exclude', ', ,']);
    if (!emptyEx.j || emptyEx.j.ok !== false || emptyEx.j.code !== 'invalid-output') bad.push('--exclude 给了空清单没拒（静默"什么都不排除"会让调用方以为自己圈住了）：' + JSON.stringify(emptyEx.j && { code: emptyEx.j.code }));
    // 🔴 v3.0.0（自检自修实抓）：--base 给了空/纯空白＝"静默不过滤"，调用方会以为自己圈住了子集（与 --exclude 空清单同族）。
    const emptyBase = runGc(['--base', '  ']);
    if (!emptyBase.j || emptyBase.j.ok !== false || emptyBase.j.code !== 'invalid-output') bad.push('--base 给了纯空白没被拒（静默"不过滤"＝调用方以为自己圈住了子集）：' + JSON.stringify(emptyBase.j && { ok: emptyBase.j.ok, code: emptyBase.j.code }));
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('本地解包路线的输入体积闸：一族都不许漏，超限回 input-too-large 且不落半成品', () => {
    const bad = [];
    const localRoutes = ['inspect', 'dump', 'check', 'scrub', 'media', 'combine', 'split', 'pageops', 'compress', 'pdftext', 'redact', 'tables', 'redline', 'sheetop', 'pdfform', 'edit', 'merge', 'frommd', 'sheets', 'pipeline'];
    // 🔴 读自身源码必须先把 CRLF 归一成 LF：本机 `core.autocrlf=true`，`git clone`／`git checkout` 出来的工作区是 CRLF，
    //    而下面用的是跨行锚点（`'  <命令>: {\n    usage: '`、`'\n  },'）——不归一时在**真克隆态**整族报"取不到 HELP_SPEC 块"，
    //    在主树却全绿（2026-10-14 由 `node test/dep-set.js check` 抓到；主树 selftest 161/161 完全看不见这一类形状）。
    const spec = str(fs.readFileSync(__filename)).replace(/\r\n/g, '\n');
    for (const cmd of localRoutes) {
      const i = spec.indexOf('  ' + cmd + ': {\n    usage: ');
      if (i < 0) { bad.push(`${cmd}: 取不到 HELP_SPEC 块（本条无从判，先修判据）`); continue; }
      const blk = spec.slice(i, spec.indexOf('\n  },', i));
      if (!blk.includes("name: 'max-input-bytes'")) bad.push(`${cmd}: HELP_SPEC 没宣告 --max-input-bytes（闸默认 256 MB 却不宣告＝调用方无从抬限）`);
      if (!/codes: \[[^\]]*'input-too-large'/.test(blk)) bad.push(`${cmd}: codes 里没有 input-too-large（有码不宣告＝处置文案无从对齐）`);
      const bi = spec.indexOf(`parseArgs(args, '${cmd}')`);
      if (bi < 0 || !spec.slice(bi, bi + 700).includes('inputSizeGuard(')) bad.push(`🔴 ${cmd}: 命令体没调用 inputSizeGuard（宣告了却不读＝假闸）`);
      // 多路输入族要有**逐路**闸：combine 的位置参数全是输入、merge 的前两个是输入（第三个是输出）
      if (cmd === 'combine' && !/for \(let gi = 0; gi < positional\.length; gi \+= 1\) inputSizeGuard\(positional\[gi\]/.test(spec)) bad.push('🔴 combine 没给 2..N 路输入逐路过闸（只拦第一路＝漏拦）');
      if (cmd === 'merge' && !spec.includes("inputSizeGuard(positional[1], flags['max-input-bytes'], 'merge 的数据件')")) bad.push('🔴 merge 的数据件没过闸（模板拦了、数据整件进内存）');
    }
    const src = str(fs.readFileSync(__filename)).replace(/\r\n/g, '\n');
    // 🔴 这条**不许写成 src.includes('const MAX_INPUT_BYTES_DEFAULT = 268435456;')**：判据体里那个字面量本身就在文件里，
    //    定义行被改掉时 includes() 会命中"自己的那一行"⇒ 假绿（2026-10-14 变异台 M243 实抓：常量漂了、判据仍绿，
    //    只有 help 那条红）。改成**行锚正则**——判据那一行有前导缩进，不会被 `^const` 命中。
    if (!/^const MAX_INPUT_BYTES_DEFAULT = 268435456;$/m.test(src)) bad.push('默认上限常量那一行不是 256 MB 的字面量（改配置区必须同步 help 的 default）');
    // 用**真实可过 check 的仓库夹具**，不许随便抓个文件当"正常件"：2026-10-14 实犯——我先写的 test/fixtures/cn.docx
    // 根本不存在（夹具只有 cn.odt / encrypted.pdf / wps-newfile.doc），退到 package.json 后被 check 以
    // unsupported-format 拒了，于是"默认上限下正常件被拒了（闸太紧）"这条假红替真 bug 让了路。
    const target = path.join(ROOT, 'test', 'fixtures', 'cn.odt');
    if (!fs.existsSync(target)) return '夹具不在（本条无从判，先修判据自身）：' + target;
    const bytes = fs.statSync(target).size;
    const r = spawnSync(process.execPath, [__filename, 'check', target, '--max-input-bytes', '10'], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(String(r.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!j || j.ok !== false || j.code !== 'input-too-large') bad.push('超限输入没回 input-too-large：' + JSON.stringify(j && { ok: j.ok, code: j.code, error: String(j.error).slice(0, 120) }));
    if (j && !new RegExp(String(bytes)).test(String(j.error))) bad.push('拒收文案没带真实字节数（调用方无从判断该抬到哪）');
    const r2 = spawnSync(process.execPath, [__filename, 'check', target], { encoding: 'utf8' });
    let j2 = null; try { j2 = JSON.parse(String(r2.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!j2 || j2.ok !== true) bad.push('默认上限下正常件被拒了（闸太紧）：' + JSON.stringify(j2 && { code: j2.code, error: String(j2.error).slice(0, 120) }));
    const env = spawnSync(process.execPath, [__filename, 'check', target, '--max-input-bytes', '10'], { encoding: 'utf8', env: Object.assign({}, process.env, { DOCKIT_MAX_INPUT_BYTES: String(bytes + 10) }) });
    let j3 = null; try { j3 = JSON.parse(String(env.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!j3 || j3.ok !== false || j3.code !== 'input-too-large') bad.push('--max-input-bytes 显式值必须赢过 env（否则 DOCKIT_MAX_INPUT_BYTES 会把调用方的显式意图顶掉）：' + JSON.stringify(j3 && { code: j3.code }));
    // 「不落半成品」要实测：只测 check（它本来就不写盘）证不了名字里这半句。改打一个**会写产物**的本地路线命令，
    // 产物区清单必须一字不变——闸排在任何解包/写盘之前。
    const outBefore = fs.readdirSync(OUT_DIR).sort().join('|');
    const w = spawnSync(process.execPath, [__filename, 'scrub', target, '--max-input-bytes', '10'], { encoding: 'utf8' });
    let jw = null; try { jw = JSON.parse(String(w.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!jw || jw.ok !== false || jw.code !== 'input-too-large') bad.push('scrub（会写产物的一族）超限没回 input-too-large：' + JSON.stringify(jw && { code: jw.code, error: String(jw.error).slice(0, 120) }));
    if (fs.readdirSync(OUT_DIR).sort().join('|') !== outBefore) bad.push('🔴 超限拒收却在产物区留下了东西＝半成品');
    // 🔴 多路输入族：combine 收 2..N 份、merge 还有数据件——只拦第一路就是漏拦（2026-10-14 自查补的口）。
    // 造法：把上限设在"第一路装得下、第二路装不下"之间，逼它必须报第二路；文案还得点名是哪一路。
    const gSmall = path.join(S, 'gate-small.odt');
    const gBig = path.join(S, 'gate-big.odt');
    fs.copyFileSync(target, gSmall);
    fs.writeFileSync(gBig, Buffer.concat([fs.readFileSync(target), Buffer.alloc(fs.statSync(target).size, 0x20)]));
    const capMid = fs.statSync(gSmall).size + 10;
    const rc = spawnSync(process.execPath, [__filename, 'combine', gSmall, gBig, '--max-input-bytes', String(capMid)], { encoding: 'utf8' });
    let jc = null; try { jc = JSON.parse(String(rc.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!jc || jc.ok !== false || jc.code !== 'input-too-large') bad.push('combine 的**第二路**输入没过闸（只拦第一路＝漏拦，第 2 份起仍整件进内存）：' + JSON.stringify(jc && { code: jc.code, ok: jc.ok }));
    else if (!/第 2 路/.test(String(jc.error))) bad.push('combine 的拒收文案没点名是第几路输入（调用方无从知道要挪哪一份）：' + String(jc.error).slice(0, 140));
    const gBigJson = path.join(S, 'gate-big.json');
    fs.writeFileSync(gBigJson, Buffer.alloc(fs.statSync(gSmall).size * 2, 0x20));
    const tpl = path.join(S, 'gate-tpl.docx');
    fs.writeFileSync(tpl, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>{{key}}</w:t></w:r></w:p></w:body></w:document>`));
    const rm2 = spawnSync(process.execPath, [__filename, 'merge', tpl, gBigJson, '--max-input-bytes', String(fs.statSync(tpl).size + 10)], { encoding: 'utf8' });
    let jm = null; try { jm = JSON.parse(String(rm2.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!jm || jm.ok !== false || jm.code !== 'input-too-large') bad.push('merge 的**数据件**没过闸（模板拦住了、数据仍然整件读进来）：' + JSON.stringify(jm && { code: jm.code, ok: jm.ok }));
    // env 必须真的被读：把它压到 1 字节，正常件就该被拒（不生效的开关等于假开关）
    const lo = spawnSync(process.execPath, [__filename, 'check', target], { encoding: 'utf8', env: Object.assign({}, process.env, { DOCKIT_MAX_INPUT_BYTES: '1' }) });
    let j4 = null; try { j4 = JSON.parse(String(lo.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!j4 || j4.ok !== false || j4.code !== 'input-too-large') bad.push('DOCKIT_MAX_INPUT_BYTES 压到 1 却没拦住＝env 是假开关：' + JSON.stringify(j4 && { code: j4.code }));
    // 🔴 v3.0.0（自检自修实抓）：--max-input-bytes 是"明示收紧/放宽"的开关——非法值**不许静默回退默认**。
    //    旧形状：`--max-input-bytes abc`／`0` 都悄悄按 256 MB 跑（调用方以为设了、实际没设；R1-b 同族）。
    const badV = spawnSync(process.execPath, [__filename, 'check', target, '--max-input-bytes', 'abc'], { encoding: 'utf8' });
    let jbv = null; try { jbv = JSON.parse(String(badV.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!jbv || jbv.ok !== false || jbv.code !== 'invalid-output') bad.push('--max-input-bytes 给了非数没被拒（静默回退默认＝调用方以为自己设了上限）：' + JSON.stringify(jbv && { ok: jbv.ok, code: jbv.code }));
    const badV0 = spawnSync(process.execPath, [__filename, 'check', target, '--max-input-bytes', '0'], { encoding: 'utf8' });
    let jbv0 = null; try { jbv0 = JSON.parse(String(badV0.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!jbv0 || jbv0.ok !== false || jbv0.code !== 'invalid-output') bad.push('--max-input-bytes 给 0 没被拒：' + JSON.stringify(jbv0 && { ok: jbv0.ok, code: jbv0.code }));
    const eqV = spawnSync(process.execPath, [__filename, 'check', target, '--max-input-bytes', String(fs.statSync(target).size)], { encoding: 'utf8' });
    let jeq = null; try { jeq = JSON.parse(String(eqV.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
    if (!jeq || jeq.ok !== true) bad.push('--max-input-bytes 恰好等于输入字节数时应放行（边界语义＝"超过"才拒）：' + JSON.stringify(jeq && { ok: jeq.ok, code: jeq.code }));
    return bad.length ? bad.slice(0, 8).join(' | ') : true;
  });

  t('freePath/freeDir 无占用一次探针、有占用单次 readdir（饱和名不再逐号 stat）', () => {
    const bad = [];
    const dir = ensureDir(path.join(S, 'freepath-sat'));
    const N = 900;
    for (let i = 1; i <= N; i += 1) fs.writeFileSync(path.join(dir, `sat-${i}.txt`), 'x');
    fs.writeFileSync(path.join(dir, 'sat.txt'), 'x');
    const srcAll = str(fs.readFileSync(__filename)).replace(/\r\n/g, '\n');
    const fpBody = (srcAll.match(/function freePath\(dir, base, ext\) \{[\s\S]*?\n\}/) || [''])[0];
    const fdBody = (srcAll.match(/function freeDir\(dir, base\) \{[\s\S]*?\n\}/) || [''])[0];
    if (!fpBody || !fdBody) return '取不到 freePath/freeDir 函数体（本条无从判，先修判据）';
    for (const [name, body] of [['freePath', fpBody], ['freeDir', fdBody]]) {
      if (/while \(fs\.existsSync/.test(body)) bad.push(`🔴 ${name} 仍是"逐号 existsSync 循环"（饱和名下每次调用要做 N 次 stat）`);
      if (!body.includes('dirNamesOf(dir)')) bad.push(`${name} 没走单次 readdir（dirNamesOf）`);
      if (!body.includes('if (!fs.existsSync(first)) return first;')) bad.push(`${name} 丢了"无占用时一次探针"的快路径（每次调用都列整目录，典型场景反而更慢）`);
    }
    // 行为面：占用 1..N 时下一次调用必须拿到 N+1，且拿不到已存在的名字
    const realFreePath = new Function('fs', 'path', 'ensureDir', 'dirNamesOf', fpBody + '\nreturn freePath;')(fs, path, ensureDir, dirNamesOf);
    const got = realFreePath(dir, 'sat', 'txt');
    if (path.basename(got) !== `sat-${N + 1}.txt`) bad.push(`跳号不对：应 sat-${N + 1}.txt，实为 ${path.basename(got)}`);
    if (fs.existsSync(got)) bad.push('发出去的路径已存在＝会覆盖（承重：永不覆盖）');
    // 时间面：把新旧两种实现放在同一份饱和目录上对跑，新实现不许更慢（这才是牙，不是"自报变快了"）
    const naive = (d, b, e) => { let p = `${d}/${b}.${e}`, n = 1; while (fs.existsSync(p)) { n += 1; p = `${d}/${b}-${n}.${e}`; } return p; };
    const REP = 30;
    const tn = Date.now(); for (let i = 0; i < REP; i += 1) naive(dir, 'sat', 'txt'); const naiveMs = Date.now() - tn || 1;
    const tx = Date.now(); for (let i = 0; i < REP; i += 1) realFreePath(dir, 'sat', 'txt'); const newMs = Date.now() - tx;
    if (newMs > naiveMs) bad.push(`饱和名下新实现没比朴素 existsSync 循环快（${newMs} ms vs ${naiveMs} ms，${REP} 次 × ${N} 个占用）`);
    if (naiveMs < 10) bad.push(`对照组太快（${naiveMs} ms）＝本条时间断言没有鉴别力，要么加大 N 要么删掉这半段，不许留假牙`);
    // 🔴 v3.0.0 修（自检自修实抓的回归）：readdir 集合是**精确大小写**的、而 Windows 卷不敏感——
    //    大小写错位的同名件（`CaseFix-2.pdf` vs 候选 `casefix-2.pdf`）在集合里查不到、existsSync 却属实占用；
    //    只信集合就会把它再发一次＝覆盖（承重 2）。两种函数各造一个错位占用场景量它。
    const dirC = ensureDir(path.join(S, 'freepath-case'));
    fs.writeFileSync(path.join(dirC, 'CaseFix.pdf'), 'a');
    fs.writeFileSync(path.join(dirC, 'CaseFix-2.pdf'), 'b');
    ensureDir(path.join(dirC, 'CaseDir'));
    ensureDir(path.join(dirC, 'CaseDir-2'));
    const gotC = realFreePath(dirC, 'casefix', 'pdf');
    if (fs.existsSync(gotC)) bad.push('🔴 大小写错位占用下 freePath 发出去的路径已存在（会覆盖 CaseFix-2.pdf）：' + path.basename(gotC));
    const realFreeDir = new Function('fs', 'path', 'ensureDir', 'dirNamesOf', fdBody + '\nreturn freeDir;')(fs, path, ensureDir, dirNamesOf);
    const gotD = realFreeDir(dirC, 'casedir');
    if (fs.existsSync(gotD)) bad.push('🔴 大小写错位占用下 freeDir 发出去的路径已存在（会覆盖 CaseDir-2）：' + path.basename(gotD));
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('产物根 OUT_DIR：默认仍是 _out，测试态经 DOCKIT_OUT_DIR 重定向且子进程继承', () => {
    const bad = [];
    const src = str(fs.readFileSync(__filename)).replace(/\r\n/g, '\n');
    if (!src.includes("let OUT_DIR = process.env.DOCKIT_OUT_DIR && String(process.env.DOCKIT_OUT_DIR).trim()")) bad.push('🔴 OUT_DIR 不再读 env 或非"不设 env 时等于 ROOT/_out"的形状（默认落点被改）');
    if (!/:\s*ROOT \+ '\/_out';/.test(src)) bad.push('找不到"无 env 时默认 ROOT/_out"那条分支（默认落点必须一字不变）');
    if (!src.includes("  OUT_DIR = path.join(S, 'out');")) bad.push('selftest 没把父进程 OUT_DIR 指向本次运行目录（判据产物仍会沉进 _out）');
    if (!src.includes('  process.env.DOCKIT_OUT_DIR = OUT_DIR;')) bad.push('🔴 selftest 没设 env ⇒ 判据里 spawn 出去的子装置进程仍写 _out（本轮 858 件沉积就是这么来的）');
    // 行为面 A：清掉 env 的子进程必须落回 ROOT/_out。
    // 🔴 这一段以前挂在 test/fixtures/cn.docx 上——那件根本不存在（夹具只有 cn.odt／encrypted.pdf／wps-newfile.doc），
    // 整段被 `if (existsSync)` 静默跳过＝一条"跑了但没量任何东西"的假牙（2026-10-14 实犯）。
    // 改法：输入用 selftest 自己的 docx() maker 现造，落点验完立刻删掉——本条不许反过来污染 _out。
    const inA = path.join(S, 'outdir-probe.docx');
    fs.writeFileSync(inA, docx(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${S_}><w:body><w:p><w:r><w:t>默认落点探针OUTDIRPROBE</w:t></w:r></w:p></w:body></w:document>`));
    const envA = Object.assign({}, process.env); envA.DOCKIT_OUT_DIR = '';
    const wantRoot = String(ROOT).replace(/\\/g, '/') + '/_out/';
    const runScrub = (env, label) => {
      const r = spawnSync(process.execPath, [__filename, 'scrub', inA], { encoding: 'utf8', env });
      let j = null; try { j = JSON.parse(String(r.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
      if (!j || j.ok !== true) { bad.push(`${label} 没跑通：` + JSON.stringify(j && { code: j.code, error: String(j.error).slice(0, 130) })); return null; }
      const p = String(j.output).replace(/\\/g, '/');
      // 探针产物**不论落在哪都立刻删**：变异态下落点可能跑到 _out，留着就是本例自己在用户产物区沉积
      if (fs.existsSync(p)) { try { fs.rmSync(p, { force: true }); } catch { bad.push('探针产物删不掉（本例须零残留）：' + p); } }
      else bad.push('scrub 报了落点却没落盘：' + p);
      return p;
    };
    const a = runScrub(envA, '默认落点（不设 env）');
    if (a && !a.startsWith(wantRoot)) bad.push(`🔴 不设 env 时产物没落进本仓 _out（实为 ${a}）＝装置默认落点被改了`);
    // 行为面 A2：设了 env 的子进程必须落在 env 指的地方——这一条才是 DOCKIT_OUT_DIR 那条分支的真牙
    // （2026-10-14 的 TDZ 事故形状：初始化式用了尚未声明的 const path，不设 env 时永不执行、设了 env 全体子进程崩）
    const envB = Object.assign({}, process.env); envB.DOCKIT_OUT_DIR = path.join(S, 'envout');
    const b = runScrub(envB, '重定向落点（设 env）');
    if (b && !b.startsWith(String(S).replace(/\\/g, '/') + '/envout/')) bad.push(`🔴 设了 DOCKIT_OUT_DIR 却没落进它指的目录（实为 ${b}）＝重定向没生效，测试产物照样沉进 _out`);
    // 行为面 B0：判据 spawn 出去的子装置进程**靠继承 env** 落进本轮目录——这一条才是"一轮测试不在 _out 沉积"的真凭据
    // （父进程只改自己的 OUT_DIR 不够：八条判据在子进程里写产物，旧行为是一个一个往 _out 沉）
    const c = runScrub(Object.assign({}, process.env), '自检态继承 env');
    if (c && !c.startsWith(String(OUT_DIR).replace(/\\/g, '/') + '/')) bad.push('🔴 子进程没继承本轮的 DOCKIT_OUT_DIR（它把产物写回 _out＝本轮 858 件沉积的老形状）：' + c);
    // 行为面 B：本次 selftest 运行目录里必须有 out/，且里面有东西（说明重定向生效）
    if (!fs.existsSync(OUT_DIR)) bad.push('OUT_DIR 指向的运行目录不存在：' + OUT_DIR);
    if (!String(OUT_DIR).replace(/\\/g, '/').includes('/selftest-')) bad.push('🔴 selftest 运行中 OUT_DIR 不在本次工作目录下（重定向没生效）：' + OUT_DIR);
    return bad.length ? bad.slice(0, 6).join(' | ') : true;
  });

  t('sheetop 引用重写：插行/移列后引用图逐段同构、地址双射、陈旧缓存清掉（v2.8.0 撤销"不落地"）', () => {
    const X = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`;
    const ROOTRELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    const WBRELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rIdS2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rIdCC" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>`;
    const WB = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${X} ${RNS}><sheets><sheet name="第一页" sheetId="1" r:id="rIdS1"/><sheet name="第二页" sheetId="2" r:id="rIdS2"/></sheets><definedNames><definedName name="打印区">第一页!$A$1:$C$7</definedName><definedName name="窄区">第一页!$B$2:$B$4</definedName><definedName name="常量">42</definedName></definedNames><calcPr calcId="124519"/></workbook>`;
    const S1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${X}><dimension ref="A1:C7"/><sheetViews><sheetView workbookViewId="0"><selection activeCell="B2" sqref="B2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>`
      + `<row r="1" spans="1:3"><c r="A1" t="inlineStr"><is><t>甲</t></is></c><c r="B1" t="inlineStr"><is><t>乙</t></is></c><c r="C1"><f>SUM(A2:B4)</f><v>21</v></c></row>`
      + `<row r="2" spans="1:3"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="C2"><f>A2+B2</f><v>3</v></c></row>`
      + `<row r="3" spans="1:3"><c r="A3"><v>3</v></c><c r="B3"><v>4</v></c><c r="C3"><f>$A$3*$B$3</f><v>12</v></c></row>`
      + `<row r="4" spans="1:3"><c r="A4"><v>5</v></c><c r="B4"><v>6</v></c><c r="C4"><f>SUM($A$2:$A$4)</f><v>9</v></c><c r="D4" t="inlineStr"><is><t>链接锚</t></is></c></row>`
      + `<row r="5" spans="1:3"><c r="C5"><f t="shared" ref="C5:C6" si="7">A5*2</f><v>10</v></c></row>`
      + `<row r="6" spans="1:3"><c r="C6"><f t="shared" si="7"/><v>12</v></c></row>`
      + `<row r="7" spans="1:3"><c r="A7"><v>7</v></c></row>`
      + `</sheetData><mergeCells count="1"><mergeCell ref="A6:B6"/></mergeCells>`
      + `<conditionalFormatting sqref="C2:C4"><cfRule type="cellIs" dxfId="0" operator="greaterThan"><formula>AND($C3&gt;0,$A3&gt;0)</formula></cfRule></conditionalFormatting>`
      + `<dataValidations count="1"><dataValidation type="whole" operator="between" sqref="A2:A4"><formula1>$A$2</formula1><formula2>100</formula2></dataValidation></dataValidations>`
      + `<hyperlinks><hyperlink ref="D4" location="A5"/></hyperlinks><pageBreaks/><rowBreaks count="1" manualBreakCount="1"><brk id="3" min="0" max="16383" man="1"/></rowBreaks></worksheet>`;
    const S2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${X}><dimension ref="A1:B2"/><sheetData><row r="1" spans="1:2"><c r="A1"><f>第一页!C1+1</f><v>22</v></c><c r="B1"><v>9</v></c></row><row r="2" spans="1:2"><c r="A2"><f>A1*2</f><v>44</v></c></row></sheetData></worksheet>`;
    const CC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><calcChain xmlns="${X}"><c r="C1" i="1"/><c r="C2" i="1"/></calcChain>`;
    const CHART = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:ser><c:cat><c:strRef><c:f>第一页!$A$2:$A$4</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>第一页!$C$2:$C$4</c:f></c:numRef></c:val></c:ser></c:chartSpace>`;
    const DIR = ensureDir(`${S}/so`);
    const put = (name, opts) => {
      const bag = { '[Content_Types].xml': CT, '_rels/.rels': ROOTRELS, 'xl/_rels/workbook.xml.rels': WBRELS, 'xl/workbook.xml': WB, 'xl/worksheets/sheet1.xml': S1, 'xl/worksheets/sheet2.xml': S2, 'xl/calcChain.xml': CC, 'xl/charts/chart1.xml': CHART };
      const alias = { CT: '[Content_Types].xml', ROOTRELS: '_rels/.rels', WBRELS: 'xl/_rels/workbook.xml.rels', WB: 'xl/workbook.xml', S1: 'xl/worksheets/sheet1.xml', S2: 'xl/worksheets/sheet2.xml', CC: 'xl/calcChain.xml', CHART: 'xl/charts/chart1.xml' };
      for (const [k, from, to] of (opts && opts.edits) || []) {
        const key = alias[k] || k;
        if (from === null) { bag[key] = to; continue; }
        if (!bag[key] || !bag[key].includes(from)) throw new Error('夹具改不动：' + key + ' 里没有 ' + from.slice(0, 40));
        bag[key] = bag[key].replace(from, to);
      }
      for (const [k, v] of (opts && opts.extra) || []) bag[k] = v;
      const f = `${DIR}/${name}.xlsx`;
      fs.writeFileSync(f, zipWrite(Object.entries(bag).map(([n, x]) => ({ name: n, data: Buffer.from(x, 'utf8') }))));
      return f;
    };
    const run = (file, extra) => {
      const p = spawnSync(process.execPath, [__filename, 'sheetop', file].concat(extra), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      let j = null; try { j = JSON.parse(String(p.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch { }
      return j || { ok: false, code: 'NO-JSON', error: String(p.stdout || p.stderr).slice(0, 160) };
    };
    const partOf = (file, name) => { try { const z = zipRead(fs.readFileSync(file)); return z.has(name) ? str(z.get(name)) : ''; } catch { return ''; } };
    const cellOf = (xml, addr) => { const m = new RegExp(`<c r="${addr}"[\\s\\S]{0,240}?(?:/>|</c>)`).exec(xml); return m ? m[0].replace(/\s+/g, ' ') : '(没有 ' + addr + ')'; };
    const attrOf = (xml, re) => { const m = re.exec(xml); return m ? m[1] : '(没找到)'; };
    const base = put('base');
    const baseSha = sha256(fs.readFileSync(base));
    const bad = [];
    const eq = (got, want, label) => { if (got !== want) bad.push(`${label}：应 ${JSON.stringify(want)} 实 ${JSON.stringify(got)}`); };

    const r1 = run(base, ['row-insert', '--sheet', '第一页', '--at', '2', '--skip-recalc']);
    if (!r1.ok) return '插行正向没跑通：' + JSON.stringify({ code: r1.code, error: String(r1.error).slice(0, 200) });
    const p1 = r1.output.path;
    const x1 = partOf(p1, 'xl/worksheets/sheet1.xml'), x2 = partOf(p1, 'xl/worksheets/sheet2.xml'), w1 = partOf(p1, 'xl/workbook.xml');
    eq(cellOf(x1, 'C1'), '<c r="C1"><f>SUM(A3:B5)</f></c>', '插行后 C1 区间引用');
    eq(cellOf(x1, 'C3'), '<c r="C3"><f>A3+B3</f></c>', '插行后原 C2 落 C3 且引用同移');
    eq(cellOf(x1, 'C4'), '<c r="C4"><f>$A$4*$B$4</f></c>', '插行后绝对引用也要移');
    eq(cellOf(x1, 'C5'), '<c r="C5"><f>SUM($A$3:$A$5)</f></c>', '插行后跨绝对区间');
    eq(cellOf(x1, 'C6'), '<c r="C6"><f t="shared" ref="C6:C7" si="7">A6*2</f></c>', '共享公式母格与 ref 区');
    eq(x1.includes('r="A2"'), false, '插行后第 2 行应空着');
    eq(cellOf(x1, 'A8'), '<c r="A8"><v>7</v></c>', '插行后末行地址');
    eq(attrOf(x1, /<dimension ref="([^"]*)"/), 'A1:C8', 'dimension');
    eq(attrOf(x1, /<mergeCell ref="([^"]*)"/), 'A7:B7', 'mergeCell');
    eq(attrOf(x1, /<conditionalFormatting sqref="([^"]*)"/), 'C3:C5', '条件格式 sqref');
    eq(attrOf(x1, /<formula>([^<]*)<\/formula>/), 'AND($C4&gt;0,$A4&gt;0)', '条件格式规则式引用');
    eq(attrOf(x1, /<dataValidation[^>]*sqref="([^"]*)"/), 'A3:A5', '数据验证 sqref');
    eq(attrOf(x1, /<formula1>([^<]*)<\/formula1>/), '$A$3', '数据验证规则式引用');
    eq(attrOf(x1, /<hyperlink ref="([^"]*)"/), 'D5', '超链接 ref');
    eq(attrOf(x1, /<hyperlink[^>]*location="([^"]*)"/), 'A6', '超链接内部目标 location');
    eq(attrOf(x1, /<selection activeCell="([^"]*)"/), 'B3', '选区 activeCell');
    eq(attrOf(x1, /<brk id="(\d+)"/), '4', '手动分页符行号');
    eq(attrOf(w1, /<definedName name="打印区">([^<]*)/), '第一页!$A$1:$C$8', '命名域（打印区）');
    eq(attrOf(w1, /<definedName name="窄区">([^<]*)/), '第一页!$B$3:$B$5', '命名域（窄区）');
    eq(attrOf(w1, /<definedName name="常量">([^<]*)/), '42', '常量型命名域不许动');
    eq(cellOf(x2, 'A1'), '<c r="A1"><f>第一页!C1+1</f><v>22</v></c>', '别表指向第 1 行的引用不该动');
    eq(cellOf(x2, 'A2'), '<c r="A2"><f>A1*2</f><v>44</v></c>', '别表自己的内部引用不许动');
    eq(attrOf(partOf(p1, 'xl/charts/chart1.xml'), /<c:f>([^<]*)<\/c:f>/), '第一页!$A$3:$A$5', '图表系列缓存引用');
    eq(partOf(p1, 'xl/calcChain.xml'), '', 'calcChain 必须整件删除');
    eq(partOf(p1, '[Content_Types].xml').includes('calcChain'), false, '[Content_Types] 不许还登记 calcChain');
    eq(partOf(p1, 'xl/_rels/workbook.xml.rels').includes('calcChain'), false, 'workbook 关系不许还指着 calcChain');
    eq(/fullCalcOnLoad="1"/.test(w1), true, '必须写 fullCalcOnLoad');
    eq(r1.cacheCleared > 0, true, '改过公式的缓存值至少要清一格');
    eq(r1.cellsMoved > 0, true, 'cellsMoved 自报');
    eq(r1.verify.refGraph, 'isomorphic', '引用图判定');
    eq(r1.input.unchanged, true, '原件零写入');
    eq(sha256(fs.readFileSync(base)), baseSha, '原件哈希');
    eq(r1.verify.recalc.ran, false, '--skip-recalc 时不许谎称跑了引擎尺');

    const r2 = run(base, ['row-insert', '--sheet', '第一页', '--at', '1', '--skip-recalc']);
    if (!r2.ok) bad.push('插在第 1 行没跑通：' + String(r2.error).slice(0, 140));
    else eq(cellOf(partOf(r2.output.path, 'xl/worksheets/sheet2.xml'), 'A1'), '<c r="A1"><f>第一页!C2+1</f></c>', '别表指向本表的引用必须跟着映射');

    const r3 = run(base, ['col-move', '--sheet', '第一页', '--from', '3', '--to', '1', '--skip-recalc']);
    if (!r3.ok) bad.push('移列没跑通：' + String(r3.error).slice(0, 140));
    else {
      const y1 = partOf(r3.output.path, 'xl/worksheets/sheet1.xml'), y2 = partOf(r3.output.path, 'xl/worksheets/sheet2.xml');
      eq(cellOf(y1, 'A1'), '<c r="A1"><f>SUM(B2:C4)</f></c>', '移列后原 C1 落 A1，区间引用跟着置换');
      eq(cellOf(y1, 'A3'), '<c r="A3"><f>$B$3*$C$3</f></c>', '移列后绝对引用跟着置换');
      eq(attrOf(y1, /<dimension ref="([^"]*)"/), 'A1:C7', 'dimension 两角归一（不许写成 B1:A7）');
      eq(attrOf(y1, /<mergeCell ref="([^"]*)"/), 'B6:C6', 'mergeCell 置换');
      eq(attrOf(partOf(r3.output.path, 'xl/workbook.xml'), /<definedName name="窄区">([^<]*)/), '第一页!$C$2:$C$4', '命名域置换');
      eq(cellOf(y2, 'A1'), '<c r="A1"><f>第一页!A1+1</f></c>', '别表指向本表：C1 置换成 A1');
    }

    const r4 = run(base, ['row-insert', '--sheet', '第一页', '--at', '2']);
    if (!resolveKitCli().present) {
      eq(r4.verify.recalc.ran, false, 'kit 不在位时引擎尺不许冒充跑过');
      if (!(Array.isArray(r4.warnings) && r4.warnings.some((w) => /引擎尺/.test(String(w))))) bad.push('kit 不在位却没在 warnings 里说破"数值等价未证"');
    } else if (!r4.ok) bad.push('带引擎尺的插行没跑通：' + String(r4.error).slice(0, 180));
    else {
      eq(r4.verify.recalc.ran, true, '引擎尺应真跑');
      if (!(r4.verify.recalc.cellsCompared > 0)) bad.push('引擎尺比到 0 格却报成功（这把尺没量到东西）');
      eq(r4.verify.recalc.mismatches.length, 0, '引擎尺逐格数值');
    }

    const refuse = [
      ['结构化引用', { edits: [['S1', '<f>SUM(A2:B4)</f>', '<f>SUM(表1[甲])</f>']] }, 'unsupported-format', '结构化引用'],
      ['行缺 r 属性', { edits: [['S1', '<row r="7" spans="1:3">', '<row spans="1:3">']] }, 'unsupported-format', '没有 r 属性'],
      ['工作表保护', { edits: [['S1', '</sheetData>', '</sheetData><sheetProtection sheet="1"/>']] }, 'unsupported-format', '保护'],
      ['透视件', { extra: [['xl/pivotTables/pivotTable1.xml', '<?xml version="1.0"?><pivotTableDefinition xmlns="x"/>']] }, 'unsupported-format', '不改的结构件'],
      ['外链件', { extra: [['xl/externalLinks/externalLink1.xml', '<?xml version="1.0"?><externalLink xmlns="x"/>']] }, 'unsupported-format', '不改的结构件'],
      ['R1C1', { edits: [['WB', '<calcPr calcId="124519"/>', '<calcPr calcId="124519" refMode="r1c1"/>']] }, 'unsupported-format', 'R1C1'],
    ];
    for (const [tag, opts, code, phrase] of refuse) {
      const j = run(put('refuse-' + tag.replace(/[^\w]/g, ''), opts), ['row-insert', '--sheet', '第一页', '--at', '2', '--skip-recalc']);
      eq(j.ok, false, `拒收（${tag}）`);
      eq(j.code, code, `拒收码（${tag}）`);
      if (!String(j.error || '').includes(phrase)) bad.push(`拒收（${tag}）文案没点名"${phrase}"：${String(j.error).slice(0, 120)}`);
    }
    const gates = [
      ['多表不点名', ['row-insert', '--at', '2', '--skip-recalc']],
      ['表名不认识', ['row-insert', '--sheet', '没有这张表', '--at', '2', '--skip-recalc']],
      ['at 越界', ['row-insert', '--sheet', '第一页', '--at', '99', '--skip-recalc']],
      ['from=to', ['col-move', '--sheet', '第一页', '--from', '2', '--to', '2', '--skip-recalc']],
      ['插入类给 to', ['row-insert', '--sheet', '第一页', '--at', '2', '--to', '3', '--skip-recalc']],
      ['count 超上限', ['row-insert', '--sheet', '第一页', '--at', '2', '--count', '5000', '--skip-recalc']],
      ['操作不认识', ['rowdel', '--sheet', '第一页', '--at', '2']],
      ['未知开关', ['row-insert', '--sheet', '第一页', '--at', '2', '--nope']],
    ];
    for (const [tag, extra] of gates) { const j = run(base, extra); eq(j.ok, false, `闸（${tag}）`); eq(j.code, 'invalid-output', `闸码（${tag}）`); }
    const dup = `${DIR}/dup.xlsx`;
    fs.writeFileSync(dup, fs.readFileSync(base));
    eq(run(base, ['row-insert', '--sheet', '第一页', '--at', '2', '--skip-recalc', dup]).code, 'invalid-output', '闸（输出撞名）');
    eq(run(dup, ['row-insert', '--sheet', '第一页', '--at', '2', '--skip-recalc', dup]).code, 'invalid-output', '闸（输入=输出）');
    eq(run(base, ['row-insert', '--sheet', '第一页', '--at', '2', '--skip-recalc']).ok, true, '同一条命令连跑两次都要能出产物（去重不撞自己）');
    return bad.length ? bad.slice(0, 8).join(' | ') : true;
  });

  t('判据定义数与本轮走到的条数对账（防"定义了却跑不到"的假判据）', () => {
    const srcAll = str(fs.readFileSync(__filename));
    const names = [...srcAll.matchAll(/^[ \t]*(?:await[ \t]+)?(?:ta|t)\(\s*'([^']+)'/gm)].map((m) => m[1]);
    const selfKey = '判据定义数与本轮走到的条数对账';
    const defined = names.filter((n) => !n.includes(selfKey)).length;   // 不含本条：本条此刻还没计入任何计数
    const reached = passed + failed + skipped + filtered;               // --only 下没选中的也算"走到过注册处"
    if (defined !== reached) return `定义了 ${defined} 条（不含本条）但本轮走到 ${reached} 条 ⇒ 差 ${reached - defined}：要么有判据定义了却跑不到（假判据），要么有代码文本被计数尺子误当成定义`;
    return true;
  });

  const total = passed + failed + skipped;   // 计数口径含 SKIP：拿 passed 当总数会让外人首次运行退化成环境探针
  const keep = flags.keep === true;
  if (!keep) { try { fs.rmSync(S, { recursive: true, force: true }); } catch { /* 清不掉不影响结论，下面自报 */ } }
  out({ ok: failed === 0, version: VERSION, passed, failed, skipped, total, filtered, checks, workdir: keep ? S : null, cleaned: !keep && !fs.existsSync(S), note: 'total=passed+failed+skipped；SKIP 只用于明确的可选环境前置缺失（外部后端、公开树未携带的内账文档或未配置的可选样本），且必须逐条点名；--keep 保留自检目录' });
  if (failed) process.exit(1);
}
function cellRaw(file) { return zipRead(fs.readFileSync(file)).get('xl/worksheets/sheet1.xml'); }
function str0(buf) { return buf.toString('latin1'); }
//#endregion

//#region 入口区
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  // 🔴 命令名必须**自带**在 COMMANDS 上：`COMMANDS['toString']` 从 Object.prototype 继承而来是 truthy，
  // 于是 `node dockit.js toString` 既不输出 JSON 也不报失败（实测 2026-10-06 退码 0、stdout 空）——
  // 违反"装置任何路径只出结构化 JSON"这条承重（总览第四节第 15 条）。按 own 属性判。
  if (!cmd || !Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) {
    const cand = nearestCandidates(cmd || '', Object.keys(COMMANDS));
    die('invalid-output', `未知命令或开关：${cmd || '(空)'}`, (cand.length ? `最接近的命令：${cand.join(' | ')}；` : '') + `可用命令：${Object.keys(COMMANDS).join(' | ')}；看 help`, { candidates: cand });
  }
  if (cmd.startsWith('--')) die('invalid-output', `首个参数不能是开关 ${cmd}`, '顺序是：命令 位置参数 开关');
  const r = ( () => { try { return COMMANDS[cmd](rest); } catch (e) {
    // 兜住同步命令里漏出的异常：装置对任何调用方的承诺是" stdout/stderr 只有结构化 JSON"，
    // 裸栈会让上层（别的 agent）拿不到 ok/code——变异台 M10 就是靠这条把红因看清的。
    const msg = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300);
    const zipish = e && e.dockitCode ? e.dockitCode === 'invalid-document' : /CRC|ZIP|EOCD|inflate|zlib|code lengths|incorrect header|invalid distance/i.test(msg);
    const code = zipish ? 'invalid-document' : 'failed';
    die(code, `装置内部异常（已兜住，不吐裸栈）：${msg}`, zipish
      ? '这个文件按 ZIP 读不通（条目 CRC 不匹配、压缩流坏了或不是 ZIP 容器）。先怀疑文件本身损坏：别外发、别当已核验，必要时从来源重取'
      : '这是装置缺陷：把本行 JSON 原样回报给调用方，不要重试');
  } } )();
  if (r && typeof r.then === 'function') r.catch((e) => { const p = asyncFailPayload(e); die(p.code, p.error, p.next); });
}
module.exports = { freePath, zipRead, zipWrite, LANG_FILES: langFiles, pngDarkRatio, detectKind, runKit, FORMAT_MATRIX, nextFor, asyncFailPayload, VERSION, KIT_VERSION, abs, extOf, familyOf };
//#endregion
