# ADR-002 · 引入 OfficeCLI 作为 `edit`／`merge` 的写操作后端

- 状态：**已接受并生效施工**（2026-10-06 06:15 起本轮为无人值守场景；《方案》§3 R6 原写"前置＝ADR-002 经机主过目"，机主 2026-10-05 声明**完全授权给执行者与监督者** ⇒ 该门降级为"执行者按四段式自写自批、监工事后独立复核"，任务书 H §0 明令**不许拿"等机主过目"当停手理由**。本 ADR 的自批性质就是这么来的，如实写在第一行，不装作有机主签字）
- 版本：v1.6.0 R0-b（2026-10-06）
- 关联：认领与首跑隔离的装机对账记录（监工侧一手读数）；本 ADR §二的"四项未验"读数由执行者亲跑（原始件留沙箱产物目录，逐条命令一条 `.out`/`.err`/`.json`）
- 依赖面现状：kit（引擎）＋ Tesseract（ADR-001）＝ 2 个外部依赖。本 ADR 把它推到 **3 个**，并额外引入一条 ADR-001 没有的性质：**被委托程序会去驱动第三个应用（WPS）**。

## 一、背景

装置从 v1.0.0 起只做"读与转"：原件只读、产物只写 `_out/`、永不覆盖（总览第四节第 1 条）。这带来一个真实缺口——**装置不能改文档内容**：填模板（`{{key}}`）、改一处文字、补一段落，今天只能"整份重做"或绕开装置手点 Office。《方案》P2-2 因此要求接入写能力，候选是上游 `iOfficeAI/OfficeCLI`（"AI-friendly CLI for Office documents"，C#，Apache-2.0）。

监工侧 2026-10-05 已完成认领：exe 33,480,616 B，**SHA256 三源一致**（本地实算 × 上游 `SHA256SUMS` 资产 `sha256sum -c` OK × GitHub API `assets[].digest`），版本 **v1.0.153**（2026-09-30 Release），落点为**本机装置目录下的 `officecli-win-x64.exe`**（独立 git 仓，二进制不入仓）。`--version` 退码 0 回 `1.0.153`，首跑零落点，只读命令 `validate`／`view issues` 吃真件通过且**输入 sha 逐字全等**。

剩下四项未验（任务书 H §8 点名交给我）在本 ADR §二关掉。**这四项的结论方向不一致**：两项支持接入，两项给出硬性排除项——这正是"取证而不是表忠心"该有的形状。

## 二、候选与实测（全部带本机第一手数字；官网宣传值一概未采用）

### ① `refresh` 在无 MS Word 的机器上实际打谁 —— 🔴 结论：打 **WPS**，而且**它写输入文件**

| 读数 | 值 |
|---|---|
| 命令 | `officecli refresh real.docx --json`（工作目录＝沙箱，输入＝`_probe/real.docx` 的**副本**） |
| 退码／耗时 | `0`／`1463 ms` |
| 自报 | `{"success":true,"data":"Refreshed: …real.docx (backend: word)"}`——`data` 是**字符串**（我第一次把它当数组数出"57 项"，那是 `Object.keys(字符串)` 的假读数，已作废并在此更正） |
| **输入被改写** | 副本 `60,623 B` → `70,575 B`，sha `74bf6a35…` → `768f138d…`（**同一次跑两遍还得不到同一个数**：第一次后 70,613 B、第二次后 70,575 B ⇒ 产物字节会漂，"四件套"里的字节数不能当它的可复现判据） |
| 真后端证据 | 沙箱 `AppData/Roaming/kingsoft/office6/log/wps/202610060918_wps_25792.klog` ＋ `.../prometheus/202610060918_wpsoffice_40132.klog`，插件路径里带版本号 **12.1.0.28505** ⇒ 起来的是 **WPS**，不是 Word |
| 本机 COM 实态 | `Word.Application.12`／`Excel.Application.12`／`PowerPoint.Application.12` 三个 ProgID 全部由 **WPS 注册**（PowerPoint 那条下还挂着 WPS 的 `.ksobak` 备份键）——本机**没有** MS Word |

**为什么这一条最重**：`refresh` 名义上是"重算派生字段"（TOC 页码、PAGE/NUMPAGES），实际是**把一个 GUI 办公套件拉起来干活**。三个连带后果：(a) 它**就地改写输入**，与装置"原件只读"的承重直接冲突；(b) 它可能**附着到用户已经开着的实例**——本机在我探针之前就有 `wps` PID 76632（02:32 起）与 `wpscloudsvr` 在跑，桌面是有人用的；(c) 它有自己的网络与配置写面（沙箱 home 里同时长出 `tiance.db`、`kconfigcenter/kccsdkdb/mdbx.dat`、`addons/.../knetwork_3.1.0.4673/download.7z`，后者是**插件在联网下载**）。真实 `AppData\Roaming\kingsoft` 里另有 5 个文件在 09:00 后被写（`office6/log/update/wpsupdate_2026_10_06.log`、`kfpccomb/ids_v3_lang_60|128.ini` 等），**但我无法把这 5 个归给我的探针**——本机常驻的 WPS 进程自己也会写配置，这是本 ADR 里唯一一条"时间相邻、归因不确定"的读数，按不确定登记。

⇒ **排除项 A：装置永不提供 `refresh`。** 它同时违反两条承重（原件只读、不驱动 GUI 应用），且没有任何 dockit 侧的等价缺口需要它补（页码刷新不在本轮交付面里）。

### ② `view screenshot`／`--render native` 与宿主无头浏览器的关系 —— 🔴 结论：《方案》§6 的前提被推翻，**浏览器依赖根本不存在**

| 命令 | 退码 | 耗时 | 落点 | 起了 WPS 吗 |
|---|---|---|---|---|
| `view real.pptx screenshot`（`--render auto`） | 0 | 1,916 ms | 🔴 **写到真实 `%LOCALAPPDATA%\Temp\officecli_screenshot_real_092115_….png`（5,356 B）** | 是（`log/wpp/..._wpp_25084.klog`） |
| 同命令，**加 `TMP`/`TEMP` 重定向**后重跑 | 0 | 1,196 ms | `_sandbox/tmp\officecli_screenshot_real_092159_….png`，真实 Temp **没再多一个** | 是 |
| `view real.pptx screenshot --render native` | 0 | 1,203 ms | 沙箱 tmp | **是**（`wpp_7172.klog`） |
| `view real.pptx screenshot --render html` | 0 | 3,269 ms | 沙箱 tmp | **否**（沙箱 home 新增 **0** 条） |

- 上游 help 原文：`--render <render>  Screenshot rendering path (docx/pptx): auto (default; native on Windows w/ Word/PowerPoint, html elsewhere), native (force OS-native, error if unavailable), html`。本机没有 Word/PowerPoint，但 **WPS 顶着那两个 ProgID**，所以 `native` 从不"error if unavailable"——它安静地打到 WPS。
- ⇒ **不需要装 Playwright/Chromium，也不需要动 Chrome**：`--render html` 就是浏览器零依赖的那条路（代价：3.27 s vs 1.20 s）。《方案》§6 那条"依赖宿主无头浏览器、顺序是先试本机 Chrome 再装 Playwright"的**前提不成立**，它列的两步一步都不必做。
- 顺带钉住两条边界：`--browser` 这个开关会**在桌面上打开浏览器**，装置不许传；以及**隔离形状必须含 `TMP`/`TEMP`**——我第一版探针只挪 `HOME`/`USERPROFILE`，于是 PNG 落进了真实 Temp（09:21 那次 5,356 B 就是这么来的；该文件已移入 `_sandbox/out/quarantine-2026-10-06/` 并留 MANIFEST，不删）。
- 渲染面**整族**（`screenshot`/`pdf`/`svg`/`html` + `watch`）依然**不进装置命令面**：装置已有 `pages`（kit 渲染）这条同源路线，再吃一个会拉起 GUI 套件的渲染后端纯属增加 blast radius，而《方案》要的"A/B 对照"在结论变成"native＝WPS"之后已经不成立——拿两个不同引擎的渲染结果做 A/B 是另一件事，不在本轮范围。

### ③ 写类命令（`create`/`set`/`add`/`batch`/`merge`）—— ✅ 结论：**行为干净、可委托**，且"写完磁盘立刻看得见"已被独立路线证实

在沙箱工作目录跑 11 例（原始件 `_sandbox/out/w*.json`；下表"变字节"＝`字节#sha8` 前后）：

| 例 | 命令 | 退码 | 耗时 | 读数 |
|---|---|---|---|---|
| w1 | `create t1.docx` | 0 | 497 ms | `Created: t1.docx`，新增 5,183 B；stderr 一句 `Note: locale 'zh-CN' inferred from OS user culture. Pass --locale to override.` |
| w2 | `create t1.docx`（再来一次） | **1** | 347 ms | `Error: File already exists: t1.docx. Use --force to overwrite.` |
| w3 | `add t1.docx / --type paragraph --prop text=HELLO_SENTINEL_1` | 0 | 747 ms | `Added paragraph at /body/p[@paraId=00100000]`，`t1.docx:5183#0195ec8e → 5259#89ad30bc` |
| — | **用 dockit 从磁盘读回**（`to t1.docx …txt`，与 officecli 完全无关的第二条路线） | — | — | 文本层**含 `HELLO_SENTINEL_1`**（18 字符） ⇒ **写即落盘，不需要 `save`/`close`/idle-autosave** |
| w4 | `set t1.docx /body/p[1] --prop text=HELLO_SENTINEL_2` | 0 | 816 ms | `Updated /body/p[1]: text=…`，`5259#89ad30bc → 5260#54c13f84`；磁盘读回**含**新值 |
| w5 | `batch t1.docx --commands '[{"command":"add","parent":"/","type":"paragraph","props":{"text":"BATCH_SENTINEL_3"}}]'` | 0 | 777 ms | `[1] Added paragraph …`＋`Batch complete: 1 succeeded, 0 failed, 1 total`，`5260#54c13f84 → 5284#a1a1beb3`；磁盘读回**含** |
| w7 | `add tpl.docx / … --prop text={{KEYSENTINEL}}` | 0 | 746 ms | 占位符原样写入（`5183#76670cd2 → 5261#54de6012`） |
| w8 | `merge tpl.docx out_merged.docx --data {"KEYSENTINEL":"REPLACED_OK"}` | 0 | 718 ms | `Merged: out_merged.docx  Replaced keys: 1`，**新增** out_merged.docx；磁盘读回**含 `REPLACED_OK`**（13 字符） |
| w9 | `merge` 到已存在的输出 | **1** | 343 ms | `Error: Output file already exists: out_merged.docx. Use --force to overwrite.` |
| w10 | `validate out_merged.docx` | 0 | 569 ms | `Validation passed: no errors found.`（**写出来的文件被上游 schema 认**） |

三条对施工有决定意义：

1. **零常驻**：`OFFICECLI_NO_AUTO_RESIDENT=1` 下，全部写例跑完 `Get-Process officecli*` 计数 **0**；`home新增` 对每一个写动词都是 **0**（`set`/`add`/`batch`/`merge`/`validate` 都不碰 profile、不起 COM）。这跟 ①② 形成鲜明对照——**同一支 exe，动词之间的 blast radius 差一个数量级**，所以白名单必须按动词给，不能按"OfficeCLI 这个程序"给。
2. **写即落盘**：help 里那句"a direct disk reader sees the pre-edit file until a flush"只在**有 resident** 时成立；我们禁 auto-resident，实测每条写命令返回后磁盘内容就已更新，且由**另一条独立路线**（kit 的 `to txt`）证实。R6 的"写后回读对账"因此是可测的，不是摆设。
3. **拒绝覆盖是默认**：`create`/`merge` 撞已有文件都是退码 1（`file_exists` 族），`--force` 才覆盖 ⇒ 装置的"永不覆盖既有文件"这条**不需要靠输出路径唯一化来兜**，但**仍然要兜**：装置的默认落点走 `_out/` 去重，`--force` 永不传（透出去就等于把"覆盖"变成调用方可选项）。

### ④ `dump` 的元数据带出面 —— 🔴 结论：读面**带作者名与整篇正文**，装置的脱敏口径必须由装置自己实现

拿 `_sandbox/work/real.docx`（60,623 B 那份中文报告的副本，`docProps/core.xml` 695 B）逐条扫每条读命令的输出，问"这个字段的**值**出现在里面吗"（只报字段名与命中，不回显值——探针脚本 `_probe/oc-egress-scan.js`，针取自 ZIP 自行 inflate）：

| 命令 | 输出体积 | 输出里的 CJK 字符数 | 带出的元数据字段 |
|---|---|---|---|
| `dump <f> / --json` | 🔴 **1,080,864 B** | **8,128** | **`creator`、`lastModifiedBy`、`Application`** |
| `get <f> / --json` | 3,443 B | 0（不含正文） | 🔴 **`creator`、`lastModifiedBy`、`Application`** ——**只要一个根节点就把作者名带出来** |
| `raw <f> /document` | 179,722 B | 8,204 | 无元数据，但**整篇正文** |
| `raw <f> /core-properties` | 0 B | — | 退码 1：`Unknown part: /core-properties. Available: /document, /styles, …`（够不着 core.xml） |
| `view <f> issues --json` | 24,580 B | 2,388 | 无元数据，issue 条目里带正文片段 |
| `view <f> stats` | 366 B | 8 | 无 |
| `view <f> text --max-lines 2` | 166 B | 14 | 无 |
| `query <f> paragraph --json --limit 3` | 1,883 B | 0 | 退码 1：`Unrecognized command or argument '--limit'`（这开关不属于 query，写错形状不会静默） |
| `dump <f> /styles --json` | 740,373 B | 42 | 无元数据 |

⇒ **排除项 B：OfficeCLI 的读面 stdout 一个字节都不许透传给调用方**（后端 stdout 一律不透传）。`get /` 尤其危险——它看起来"只给结构"（0 个 CJK），实际带着作者名与 `Application`。装置的 `inspect`/`check`/`dump` 那套"只给字段名＋长度"的脱敏口径（总览第四节第 2 条三串口径）**不会被后端继承**，只能在委托层自己实现：只消费 `success`/`error.code`/计数与路径标识，不转发 stdout。

### ⑤ 未纳入本轮的两项（如实留白，不假装验过）

- **`plugins` 面**（`.doc`/`.hwpx`/PDF 导出的插件形状）：未验。
- **PATH 未被改**：监工侧 2026-10-05 自己标注的弱证据仍然有效——它没存改前 `Path` 的完整哈希，只有"注册表 `HKCU\Environment\Path` 里没有 `officecli` 字样"这一决定性检查。本轮我没有把 exe 加进 PATH 的任何动作，也没有重装，所以这条结论**没有被加强**，引用时按"字样级证据"引用。

### ⑥ 🔴 施工期间实测：后端**把自己升级了**，钉版被打穿（2026-10-06 09:46:59，R6 施工中）

为本 ADR 新写的判据（`doc ADR-002 在册…`，核"文档里钉的 sha256 必须等于盘上实算"）上线几分钟后**自己变红了**，读数如下：

| 项 | 值 |
|---|---|
| 盘上实算 | `bin\officecli-win-x64.exe` **33,497,000 B**，sha256（前 16 位）`50a57626ff7c5b11…`，`--version` 回 **`1.0.154`**，文件 mtime `2026-10-06 09:46:59` |
| ADR 原钉值（v1.0.153 认领件） | sha256（前 16 位）`05dd712595690672…`（33,480,616 B）——**逐字节留档在 `bin\officecli-win-x64.exe.old`**，本轮 09:52 复算仍是该值 ⇒ 三源认领没有作废，只是**不再等于在位件** |
| 触发者 | 🔴 **是我自己**：装置里 `officecliVersion()`（问 `--version` 的那条懒探针）第一版**漏传隔离 env**，用的是裸 `spawnSync`。`OFFICECLI_SKIP_UPDATE=1` 是随进程环境给的，那条路径没给 ⇒ 后端按默认行为检查更新并就地替换二进制，留下 `.old` |
| 影响面自查 | 沙箱 home 里新建了 `~/.officecli/config.json`（说明这次真走了更新分支）；六个 agent 配置根 `*officecli*` 命中仍 **0**（没往别人目录写 skill）；无常驻进程。取证四项（§二①–④）的读数是 **v1.0.153** 上跑的；R6 的 `edit`/`merge`/`check --backend` 全部 smoke 是 **v1.0.154** 上跑的 ⇒ **同一批交付里混了两个后端版本**，这条显式登记，不事后抹平 |
| 🔴 追加式勘误（2026-10-07 15:1x 监工实测；上面三行原文不删） | 上面"旧字节逐字节留档在 `.old`"**只对到 10-06**：10-07 **11:21:14** 后端**第二次**自更新（1.0.154→1.0.155），更新器把当时在位的 154 改名成 `.old`，**覆盖了原先那份留档**。现测 `Get-Item` 版本资源：`.old` ＝ **v1.0.154**（33,497,000 B，`50a57626`…），在位件 ＝ **v1.0.155** ⇒ **153 的字节本机已不存在**。结论：**留档不许放 `.old` 这种会被轮换覆盖的固定槽位**，改放 `bin\archive\officecli-win-x64-1.0.153.exe`（重下与"实算归档件"判据＝机主 2026-10-07 已同意，台账 `DK-DRIFT-153`） |
| v1.0.155 三源认领（机主 2026-10-07 裁 P-1 选①） | sha256（前 16 位）`66757c7a3ac4e8b1…`，**33,497,000 B**，版本资源与 `--version` 均 **1.0.155**；三源一致＝① 本地 `sha256sum` 实算 ② GitHub API `assets[].digest`（Release `v1.0.155`，`published_at 2026-10-06T07:30:28Z`） ③ 该 Release 自带 `SHA256SUMS` 资产 `sha256sum -c` 回 `officecli-win-x64.exe: OK`。时间线自洽：上游 10-06 15:30（本地）发布、本机 10-07 11:21 自动更新收到 ⇒ **不是人为替换件**。按 §二⑥ 的口径，第 3 枚出现后**登记并重跑 R6 的 11 例**（读数在迭代日志 v1.6.6 之后那条） |
| 🔴 留档位改法与 153 恢复（机主 2026-10-07 裁 P-2） | 从上游 v1.0.153 Release 重下 → `bin\archive\officecli-win-x64-1.0.153.exe`：**33,480,616 B**，sha256 与本机留存的 `evidence\SHA256SUMS-资产原件` 里 win-x64 那行**逐字相等**（前 16 位 `05dd712595690672…`），PE 版本资源 **1.0.153**。同时把 154 的字节也归档：`bin\archive\officecli-win-x64-1.0.154.exe`（33,497,000 B／`50a57626ff7c5b11…`，`cp -p` 保留 mtime 10-06 09:46:59，版本资源 1.0.154）。**立规矩**：留档只认 `bin\archive\officecli-win-x64-<版本>.exe`；`.old` 是后端自己的轮换槽（10-07 11:21 就是它把 153 的留档覆盖掉的），**永不许当留档**。"实算归档件＝ADR 登记的认领值"这条判据由派工轮落地（台账 `DK-ARCHIVE-GATE`） |
| 🔴 第三次自更新与 v1.0.156 三源认领（2026-10-10 复审轮；执行者自写自批——按本 ADR 首行口径） | sha256（前 16 位）`70b4e26695cf3197…`，**33,509,288 B**，`--version` 与 PE 版本资源均 **1.0.156**；三源一致＝① 本地实算 ② GitHub API `assets[].digest`（Release `v1.0.156`，`published_at 2026-10-09T17:14:31Z`） ③ 该 Release 自带 `SHA256SUMS` 的 win-x64 行逐字相等。逐字节归档 `bin\archive\officecli-win-x64-1.0.156.exe`。替换窗口：审计 `_audit/backend-calls.jsonl` 首现行 2026-10-10T14:20:59.9Z→14:21:01.3Z 之间（bin 目录 mtime 22:21、文件 mtime 22:13:59 本地）；**自然版本变化、非人为替换**。触发形状：与本节首条同族——"未隔离 env 的调用"；多轮回归/变异测试都会在活体上复现该形状（M95 的设计就是复现它），上游 10-09 发布后任一次即可触发；归因不到具体某一轮，按"没留痕的版本变化"登记。⇒ 已按本节口径**重跑写面 11 例**：11/11 符合预期（含 file_exists 拒绝 ×2）、独立路线（`dump`）读回命中、零常驻；原始件留证据目录；事件详录随版本审计留档 |
| 🔴 第四次自更新与 v1.0.157 三源认领（2026-10-13 v2.5.0 轮；执行者自写自批——按本 ADR 首行口径） | sha256（前 16 位）`bd64eba587e56cc7…`，**33,513,384 B**，`--version` 与 PE 版本资源均 **1.0.157**；三源一致＝① 本地实算 ② GitHub API `assets[].digest`（Release `v1.0.157`，`published_at 2026-10-12T13:01:22Z`） ③ 该 Release 自带 `SHA256SUMS` 的 win-x64 行逐字相等。逐字节归档 `bin\archive\officecli-win-x64-1.0.157.exe`。替换窗口：审计 `_audit/backend-calls.jsonl` 首现行 2026-10-13T13:27:31.9Z→13:27:33.4Z 之间（bin 目录 mtime 21:27:32、下载件 mtime 21:20:46 本地；更新分支痕迹 `~/.officecli/config.json` mtime 21:20:37）；**自然版本变化、非人为替换**。触发形状：与前三次同族——"未隔离 env 的调用"；本仓全量变异台（M95 的设计就是复现它）在活体上复现该形状，归因不到具体某一轮，按"没留痕的版本变化"登记。🔴 同轮**防护落地**：`test/mutant.js` 给所有子 selftest 注入 `OFFICECLI_SKIP_UPDATE=1`＋`OFFICECLI_NO_AUTO_RESIDENT=1`（父环境继承，挡"活体下载替换"复现；M95 的牙＝源码级断言，不受影响）。已按本节口径**重跑写面 11 例**：11/11 符合预期（含 file_exists 拒绝 ×2）、独立路线（`dump`）读回命中、零常驻；原始件留证据目录；事件详录随版本审计留档 |

⇒ 三条更正（都进代码与判据，不是只写在文档里）：
1. **所有**调后端的路径一律走同一个 `officecliEnv()`（含只问版本的探针）；判据 `后端二进制与隔离 env 自曝` 从源码层核"每一次 `spawnSync(resolved.exe` 都带 env"，漏一处就红（攻击 **M95**——把我刚犯的那个形状原样变异回去）。
2. 装置每次调用后端**前后各取一次二进制身份章**（字节数 + sha 前 8 位），变了就在 `warnings[]` 里点名前后两个值（`backend.binaryBefore` / `binaryAfter` / `binaryDrift` 同时进回报）。静默换版比换版本身更危险。
3. 判据的 sha 对账改成**"盘上实算必须等于 ADR 里已登记的某一枚"**：1.0.153 的认领值与 1.0.154 的在位值**都**在本节登记在案，所以红的是"冒出第三枚没登记过的二进制"，而不是"上游发了新版"这个自然事件。这不是放宽——**未登记的替换照样红**（攻击仍是 **M92**：把文档里那枚当前值改错一号 ⇒ 盘上值不再等于任何登记值 ⇒ 红）。

### ⑦ R6 施工期间撞出的三条事实（两条是后端行为、一条是我自己委托层的缺陷；都直接改写了写法）

1. 🔴 **退码 2 可以是 `success:true` ＋ "属性被静默丢弃"**。实测 `add t4.docx /body --type paragraph --prop zzz=NOTAPROP_888 --json` ⇒ **退码 2**、`{"success":true,"data":"Added paragraph at …","warnings":[{"message":"Unsupported property: zzz","code":"unsu…"}]}`，而那个值**根本没进文件**（装置解 ZIP 回读找不到针）。另一例 `set … --prop zzz=NOTAPROP_777` 回 **退码 2 ＋ `success:false`**（`"No properties applied to /body/p[1]"`），但**文件字节仍然被改**（sha `a1a1beb3→ac309732`）。⇒ 《方案》§4 那条"退码 2＝带保留的成功，翻成 dockit 退码 0 + warnings[]"**只覆盖了 API 形状，没覆盖语义**：委托层不许拿 `success:true` 当结论，必须**装置自己回读值**，读不到就 `code:'failed'` 停手（攻击 **M48**＝拆掉这道闸门）。布尔/纯数字这类标量值被后端写成标签或半点整数（`bold=true`、`size=14`），拿字面值当针必然假阴 ⇒ 装置**不做值对账**，但必须在 `verify.notValueChecked` 里自报"这一面没测"，不许静默跳过。
2. 🔴 **装置自己有一处谎报落点的缺陷**（09:57 自查抓到，与后端无关，是我写的委托层的错）：上一版把命令按 `path.basename(...) ＋ cwd: OUT_DIR` 拼给后端。`merge` 的输出路径**在 `_out` 之外**时，产物落进 `_out/<同名>`，而回报里写的是用户给的那个路径——实测回报 `{"ok":true,"output":"D:\\…\\_probe\\r6out\\m.docx"}` 而那个文件**不存在**、`_out\m.docx` 却存在。⇒ 修法两层：① 一律传**绝对路径**；② 写完后先核"我报的那个路径真的存在"，不存在就 `invalid-output`，并点名 _out 里是否有同名意外件。这条现在常驻判据（`merge 承重形状` 里带一个 `_out` 之外的输出用例），因为"谎报路径"这一类不会自己冒头。
3. **`--version` 之外还有一条容易被忽略的面**：`officecli help` 的 Commands 里 `open`/`close`/`save`/`watch`/`unwatch` 是常驻与 flush 语义（help 原文："a direct disk reader sees the pre-edit file until a flush"，自适应 2–10 s）。本轮实测在 `OFFICECLI_NO_AUTO_RESIDENT=1` 下**每条写命令返回后磁盘就已更新**（用 kit 的 `to txt` 从盘上读回哨兵，三次全命中），所以装置不需要、也不透出 flush 类动词——但若哪天有人给同一份文档起了 `open`，"命令返回了而盘上还是旧文件"就会回来，这正是 §三-2 把它们列进不可达清单的理由之一。

### ⑧ 2026-10-07 监工侧补：`plugins` 面取证、`refresh` 附着读数、留档位改法（机主裁 P-1／P-2／第 3 项放行）

取证全程在临时沙箱里跑：`HOME`／`USERPROFILE` 指向沙箱 home、`TMP`／`TEMP` 指向沙箱 tmp、带 `OFFICECLI_SKIP_UPDATE=1` 与 `OFFICECLI_NO_AUTO_RESIDENT=1`。一手读数留档在监工侧证据目录。

| 例 | 命令 | 退码 | 读数 |
|---|---|---|---|
| p1 | `plugins --help` | 0 | 603 B；子命令面只有 `list`（"List plugins discoverable in …"）——**没有 install/add 之类写入面**暴露在 `plugins` 下 |
| p2 | `plugins`（不给子命令） | **1** | 605 B，回的是 help 文本；退码非 0，装置按"失败"翻译没有歧义 |
| p3 | `plugins list --json` | 0 | **40 B**，`{"success":true,"data":[]}` ⇒ 本机可发现的插件集为空；跑完沙箱 home 里**零产物**（列目录 = 空）——所以 §二⑤ 担心的"插件下载"这条面在默认状态下不触发 |
| r1 | `refresh <沙箱副本.docx> --json` | 0 | 2290 ms，`data="Refreshed: … (backend: word)"` ⇒ 后端自称 word 引擎，实测仍由 **WPS** 顶（`Word.Application.*` ProgID 归 WPS，见 §二①） |
| r2 | 输入是否被改写 | — | **1608B#c83d8347 → 1608B#c83d8347，未改写**。🔴 这与 §二① 的"refresh 改写输入（60,623→70,575 B）"**并不矛盾**：那份空白件没有任何域/页码可刷，引擎无事可做；有域的真件才会被写。**所以"改写输入"是条件性事实，不许写成无条件**——本轮就是把 §二① 读成了无条件，才需要在这里加这条限定 |
| r3 | WPS 家族进程数 | — | 调用前 12 → 调用后 13（跑完回收，17:1x 复核只剩 3 个常驻：16 天前那个 + 今日会话 + wpscloudsvr）⇒ **它会新起一个进程而不是纯附着**；但没证明它附着到已开实例时会不会抢前台/改文档窗口——那要在机主自己开着的 WPS 窗口上做，属可见动作，本轮不做 |
| r4 | 隔离是否成立 | — | 真 `~/.officecli` 的 mtime 前后一致（`2026-10-06T01:46:57.235Z` 未变），沙箱 home 零产物 ⇒ 带齐两枚旗标 + HOME/TMP 重定向时，`plugins`/`refresh` 都不往真 profile 写 |

⇒ 三条结论进口径：① **`plugins` 面可以放进"已验"**（只读、空集、零写盘），但它不在装置动词白名单里，所以只是取证结论、不改变可达性；② `refresh` 的"改写输入"降级为**条件性风险**（有域才写），装置的排除项 A 维持不变——不确定性本身就是要付的代价，不因为它这次没写就放它进面；③ **留档位不用 `.old`**：见 §二⑥ 的追加式勘误，逐字节留档改放 `bin\archive\officecli-win-x64-<版本>.exe`（153 已由机主裁 P-2 重下恢复，154/155 一并归档），判据 `后端留档件实算` 逐枚哈希对账。
## 三、决策

1. **接入，但只接两个动词族**：`set`/`add`/`remove`（装置侧合成一条 `edit`）与 `merge`。`batch` 作为 `edit` 的多操作实现载体（一次 open/save 周期），不作为独立命令透出。
2. **动词白名单按动词给，不给整支 exe**：装置源码里维护一份允许清单（`create`/`set`/`add`/`remove`/`merge`/`validate`/`query`/`get`/`dump` 中**只允许** `set`/`add`/`remove`/`merge`/`validate` 被真正调用；`batch` 的命令数组里也只能出现被允许的动词），**清单外的动词一律不可达**。🔴 明确不可达：`refresh`（① 原件只读冲突）、`screenshot`/`pdf`/`svg`/`html`/`watch`/`unwatch`（② 会拉起 GUI 套件、渲染面装置已有）、`open`/`close`/`save`（常驻与 flush 语义会把"写完看不见"变成常态）、`install`/`skills`/`mcp`（会往别人的配置目录写文件＝仓外写越界，任务书硬禁令）、`create`/`add-part`/`raw-set`/`import`/`plugins`（本轮交付面用不到，多一个可达面就多一个漂移源）。
3. **原件只读靠"先复制再委托"**：`edit`/`merge` 的第一步必须是把输入复制成 `_out/<名>-<UTC时间戳>-work.<ext>`，后端**只碰这份副本**；调用前后各算一次输入文件的 sha256，不相等立即 `code:'failed'` 并点名前后两个值。写完后同样要回读对账（副本可被 `inspect` 认出容器；写类结果由第二条独立路线——kit 的 `to txt` 或 `dump` 形状——证实，不接受"后端自己说成功了"）。
4. **隔离形状三件套进配置区**：`OFFICECLI_SKIP_UPDATE=1`、`OFFICECLI_NO_AUTO_RESIDENT=1`、以及**调用时的 `cwd` 与 `TMP`/`TEMP` 指向装置控制的目录**（② 的教训：只挪 `HOME`/`USERPROFILE` 不够，Windows 的 `GetTempPath` 吃 `TMP`/`TEMP`，PNG 就是这样漏进真实 Temp 的）。exe 路径走"配置区常量 → `DOCKIT_OFFICECLI` 环境变量覆盖 → 回退注册表 User/Machine 值"三级（本机踩过常驻进程读不到后设 User 变量那一坑），并**自报实际解析到的绝对路径与版本**。
5. **退码契约一个字不改**（《方案》§4）：OfficeCLI 退码 0 → 装置成功；退码 1 → 按它的 `error.code` 映射进装置八码族（`unsupported_type`→`unsupported-format`，`file_exists`/`file_locked`→`invalid-output`，其余映射不到的落 `failed`），并把它的 `error.error` 原文塞进 `next`；退码 2（带保留的成功）→ 装置退码 **0** ＋ `warnings[]`。**后端的 stdout 永不透传**（④）。
6. **缺后端 = 可诊断降级，不是红**（照 ADR-001 已立的形状）：OfficeCLI 不在位时 `edit`/`merge` 回 `unavailable` ＋ 指路 ＋ 退码 1，`doctor` 那一行报 **WARN 不 FAIL**，相关判据在无后端的机器上逐条 **SKIP 点名** ⇒ 外人克隆、没装它的机器上 `selftest` 依旧全绿。
7. **依赖面从 2 变 3 的代价由装置承担而不是由调用方承担**：`项目总览` 第九节式样登记后端版本（v1.0.153）与 sha256，**换后端版本＝重跑相关判据全阶梯**，不沿用旧结论（与 kit 0.1.5、Tesseract 5.4.0.20240606 同口径）。

## 四、后果

- **换来**：装置第一次能**改**文档（元素级 set/add/remove、模板 `{{key}}` 填充），且写出来的文件被上游 OpenXML schema 认（`validate` 退码 0）；单次写 0.5–0.8 s（w1/w3/w4/w5 实测 497/747/816/777 ms，与装置一次引擎调用 0.8–1.3 s 同量级，不改变时间预算）；`merge` 自带 `Replaced keys: N` 计数，可直接当写后对账的一手读数。
- **付出**：① **依赖面 2 → 3**（Node 标准库 + kit + Tesseract + OfficeCLI），换机器/新克隆必须多装一个 33 MB 静态 exe；② 装置命令面第一次出现"会写盘的后端"，`_out/` 之外多出一个可写工作区，"原件只读"从**结构上不可能违反**（kit 路线根本没有写动词）降级成**靠装置的复制与前后 sha 对账来守**——所以 §三的复制＋回读对账不是可选步骤，是这条能力的准入条件；③ 后端行为里有**机器画像依赖**：`create` 的 stderr 会自报 `locale 'zh-CN' inferred from OS user culture`，同一命令在别的机器上可能生成不同默认值 ⇒ 装置的判据不许吃它的默认文档内容，只吃形状；④ 一旦有人"顺手"想加 `refresh` 或 `screenshot`，就会把**WPS（或任何顶着 Office ProgID 的套件）连同它的联网插件下载**拉进交付链——这条排除的代价是"页码/目录刷新"和"高保真原生渲染"两个能力**装置明确不做**，写进调用卡让别的 agent 别以为漏了。
- **何时重新评估**：① OfficeCLI 升版破坏 `set`/`add`/`merge` 中任何一条（重跑本轮那 11 例 + 相关判据全阶梯）；② 出现真实交付要求需要"刷新域/页码"或"原生渲染 A/B"（那时必须重新裁"能不能接受为一次转换拉起一个 GUI 套件"，并把 WPS 的实例附着风险测清楚——本轮只证明了它会起进程与写日志，**没证明**它附着到已开实例时会发生什么）；③ `doctor` 的后端哨兵在位但 `edit` 连续失败（先查 `OFFICECLI_*` 三个环境变量有没有被别的会话改掉，再怀疑装置代码）；④ 🔴 若机主决定把装置开源发布：本 ADR 依赖的取证件（`_sandbox/out/` 下 20 余条 `.out`）里**有真文档正文与作者名**，它们必须留在 gitignore 的 `_sandbox/` 内、**永不进任何仓**，发布前的外发审查（《项目开源化》那份）要专门扫这个目录名；⑤ `plugins` 面完成取证后（§二⑤）本 ADR 追加带日期的补充节，不改本决策。
