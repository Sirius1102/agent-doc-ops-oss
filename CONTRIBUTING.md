# 贡献指南

本仓是一个"行为可自证"的命令行装置：任何改动都必须能被机器重新验证。

## 基本纪律

- 输入文件只读，产物只落 `_out/`（或调用方显式给的 `--out`），永不覆盖已有文件。
- 回报恒为一行 JSON；失败必须带 `code`（失败码族）与可执行的下一步（`next`）。
- 不提交任何个人身份信息、机器绝对路径、用户名、内网地址。

## 改代码前

- 先读 `README.md` 命令面总表与 `docs/adr/` 里相关的设计决策。
- 涉及安装器（`setup.js`／`install-skill.js`／`install-fonts.js`）的测试只许在隔离目录里跑，不得动本机真实落点。

## 改代码后（按序跑）

```bat
node dockit.js selftest
npm run test:installers
node test\char-baseline.js check   :: 字符集基线（默认只报不红；save 需机主同意）
node test\font-baseline.js check   :: 字体解析基线（换机器/删字体前后各跑；CI 不跑，机器字体相关）
node test\dep-set.js lint          :: 依赖缺失态注册表秒级校验
node test\mutant.js --public
```

（Windows PowerShell 若因执行策略拦 `npm`，改直调 `node test/installers-args.js`，同一件事。）

- `selftest` 必须全绿（公开树允许设计内 SKIP，见 README 说明）。
- 加变异例必须同步改 `README.md` 里的 `变异例数=<N>` 与编号区间（`selftest` 的文档卫生判据会机器核对，漂移就红）。
- 升版本时同步改 `dockit.js` 的 `VERSION`、头注版本行、`package.json`、`package-lock.json`、`README.md` 版本行。

## 基线更新

- `node test\char-baseline.js save` 需要机主同意（`DOCKIT_BASELINE_CONSENT=1`），并在提交说明里写清新增码点的来源。
- 作者与组织名（Sirius／Sirius1102）为机主公开身份，刻意保留；不要当泄漏清理。
- CI 只跑子集（见 `.github/workflows/ci.yml`）：无字体基线、无写后端现场面、无真机样本——全量按上序本地跑。
- 🔴 贴输出到公开 issue 前先删路径行：`inspect`／`to` 等回执会原样回显输入/产物路径（按需回显，不做占位化）；诊断类输出已占位化，可直接贴。
