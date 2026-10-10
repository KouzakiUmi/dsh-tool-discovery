# DSH Tool Discovery

[English](README.md) | 中文

与其把上百个工具一次性交给模型，不如只给几个小型控制入口，让模型按需加载真正需要的能力。

这是一个 DSH 插件。首轮请求里模型看到三个固定入口——`tool_list`、`tool_search`、`tool_load`——
外加每个能力类别的一段简短摘要，**以及默认初始集合**：DSH 自带的核心工具（手动基线）与当前
agent 自己 preset 登记的工具（默认保留）。其它普通工具首轮不披露。模型判断需要某个工具时调用 `tool_load`，该工具的真实原生 schema 会在**下一次**请求中
披露。之后模型照常调用该工具，仍然走 DSH 自身的审批、沙箱与权限链。

整个设计受两条不变量约束：

- **同一缓存周期内，已披露内容与顺序只增不改。** 加载不会移动或改写已披露条目：首次披露时记录的
  wire 会被持续原样发送，因此宿主侧工具升级不会静默改写模型已经读过的定义。
- **只有成功压缩才会重置周期。** 手动 `/compact` 与 DSH 自动压缩都算；失败、取消或没有摘要的压缩
  不算。模型无法卸载：`action: "unload"` 会被拒绝，因此两次成功压缩之间已披露集合只增不减。

冻结 wire 不等于执行权限。已披露的工具每次调用仍要经过宿主自身的审批、沙箱与授权检查，与它从未
被本插件中介过完全一样。

渐进式披露解决的是上下文，不是速度：只携带模型大概率会用到的内容，就不必携带宿主本可以提供的
全部内容。内核自身不持有任何工具，也从不绕过宿主。

## 三个入口

| 入口 | 回答的问题 | 改变激活集合？ |
|---|---|---|
| `tool_list` | 这个类别里有哪些可发现的工具？ | 否 |
| `tool_search` | 哪个工具适合当前任务？ | 否 |
| `tool_load` | 我要用这些工具。 | 是 |

`tool_load` 不会执行目标工具，它只记录选择，披露发生在下一轮。调用未加载的工具会被拒绝；卸载根本
不是模型的动作——只有一次成功压缩才会清空已披露集合。

## 环境要求

- DSH Core **`0.2.1-alpha.1` 或 `0.2.1-alpha.2`**——声明的 peer 范围正是这两个发行版，且都声明为
  `compatible`：`0.2.1-alpha.1` 是发布基线；`0.2.1-alpha.2` 在当前宿主上通过全套测试（组合 133 + 单元 381），
  门禁已计入该版本的子代理常驻语义变化。逐版本矩阵、证据与一次性 Profile 记录见
  [上架与兼容声明](plugin/docs/10-store-compatibility.md)。其它版本未测试。
- 原生 **`@deepseek-ai/schemastery`** peer 是配置面与设置面板的前提。缺少它时发现内核仍正常运行，
  但没有 Config，插件会记录 `ConfigUnavailable`，而不是假装存在一个设置页。
- **native** 工具展示模式。其它展示模式在激活期即被拒绝，不会静默降级。
- **每会话单个活动 agent**。单会话内多 agent 并发不受支持——请求无法无歧义地归属。
- Node `^22.19.0 || >=24.0.0`。

## 权限与外部依赖

DSH STORE 要求插件在安装前列清它能触及什么。以下是本插件的完整清单——不以「没搜到」代替事实：

| 面 | 行为 |
|---|---|
| 文件（读） | 激活时读一次 `$DSH_HOME/desktop-locale.json`，用于跟随桌面界面语言。任何失败（文件缺失、JSON 损坏、语言未知）都回落 `en` 并留一行日志。把配置项 `locale` 设为 `zh`/`en` 会**钉住语言并完全跳过这次读取**。 |
| 文件（写） | 不直接写文件系统。持久状态经宿主 `@deepseek-ai/dsh-storage-domain` 服务落盘：每个会话一条记录，内容是 epoch 身份加该会话允许常驻的**工具名名单**，不含文件内容、消息正文或凭据。 |
| 会话数据 | 通过公开的 `ctx.sessionQuery` 只读回放**本会话**事件（一次折叠 + 增量），用于恢复会话已 load 过的集合。 |
| 网络 | 无。插件不发起任何出站请求。 |
| 命令 | 无。不使用子进程、shell 或动态代码求值。 |
| 凭据 | 无。不读 `process.env`、不碰钥匙串或账号状态、不保存任何密钥。 |
| 日志 | 仅诊断信息（会话 id、状态、原因）。工具参数、文件内容与消息正文永不入日志。 |

**运行时依赖：`zod`。** 宿主存储 API（`@deepseek-ai/dsh-storage-domain`）接收 zod schema，因此可选的可信周期功能把 `zod` 声明为真实依赖。解析不到时插件**不**伪造内存存储：会话落入终态 `STORAGE_UNAVAILABLE` 并停止发请求。其余功能——三入口、目录、投影、门禁——不依赖它。

**宿主 peer。** `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-tools` 必需；`@deepseek-ai/dsh-storage-domain`（可信周期）与 `@deepseek-ai/dsh-home-paths`（界面语言路径）为可选：缺失时对应功能**诚实降级**，不做模拟。

## 安装与更新

DSH profile 安装仍可使用 **GitHub Release 构建资产**：`main` 绿跑会把仓库打包，在提交级
`build-<sha>` Release 上发布 `dsh-tool-discovery.tgz`（若已有更新的 `main` 提交，旧一次运行会直接跳过，
不会把旧提交重新发布成最新资产）。该资产是**构建产物，不是验收声明**；某个版本覆盖什么、明确
**不**宣称什么，见[当前状态](plugin/docs/05-current-status.md)。

本包自 `0.2.1` 起已发布到 npm。之后推送与 `package.json` 版本匹配的稳定 `v<version>` 标签，通过便携测试和
仓库检查后，npm 发布任务会自动运行。GitHub Actions 通过 OIDC 向 npm 验证身份，npm 同时生成 provenance；
GitHub 不保存 npm 写入令牌。发布步骤见[发布到 npm](#发布到-npm)。

请使用**你所运行的那套安装自带的 DSH CLI**，并指向真正会加载本插件的 profile。DSH NEXT 桌面端自带
CLI（经 `resources\app\lib\desktop-cli.js` 启动），插件也由其自身入口管理；`PATH` 上全局 npm 安装的
`dsh` 是另一套启动器、另一个 profile，不是这套安装的工具。**CLI 版本不等于 Core 版本**：
`dsh --version` 报的是 CLI，任何 CLI 版本号都不能说明某个 profile 解析到哪个 Core；请用
[环境要求](#环境要求) 里的 Core peer 对照该 profile。

```sh
# 首次安装 —— 先写包名，再给完整 tarball URL
dsh plugin --profile <profile> add \
  dsh-tool-discovery@https://github.com/KouzakiUmi/dsh-tool-discovery/releases/download/<build-tag>/dsh-tool-discovery.tgz

# 更新已安装副本 —— 同样是 name@URL 形式
dsh plugin --profile <profile> update \
  dsh-tool-discovery@https://github.com/KouzakiUmi/dsh-tool-discovery/releases/download/<build-tag>/dsh-tool-discovery.tgz
```

`<build-tag>` 是提交级 Release 标签，例如 `build-80216ba3effa`。标签里带着提交号，因此新构建不会
覆盖旧构建；两次构建也可能共用同一个清单版本——`version` 由维护者 bump，CI 不改——所以请钉住你测过的
那个标签对应的提交，始终显式写出包名，并以 Release 名（`v<version> · <sha>`）或该 tarball 内的清单
为准判断它到底是哪个版本，而不是假设 `main` 与本文一致。

Node 项目可通过 `npm install dsh-tool-discovery` 从 npm 安装。本节上面的 DSH profile 安装命令仍由 DSH CLI
从 GitHub Release 资产安装。

## 发布到 npm

npm 只允许在包已经存在后登记 Trusted Publisher。初始 `0.2.1` 发布已完成，npm 账号的双重验证使用了
Windows Hello。当前 Trusted Publisher 配置如下：

| 设置 | 值 |
| --- | --- |
| 提供方 | GitHub Actions |
| 组织/用户 | `KouzakiUmi` |
| 仓库 | `dsh-tool-discovery` |
| 工作流文件名 | `ci.yml` |
| 环境 | 无 |
| 发布权限 | `npm publish`、`npm stage publish`（npm 默认） |

每次发布稳定版本时，先更新并提交 `package.json`，再创建并推送同版本的 `v<version>` 标签。
`publish-npm` 任务会等待便携测试和仓库检查通过，核对标签后通过 OIDC 发布并生成 provenance。
暂存发布仍需维护者审核并通过双重验证后才会公开。

工作流需要 Node 24 和 npm 11.5.1 或更高版本，不使用 GitHub 的 `NPM_TOKEN` secret。预发布标签不会触发 npm 发布。

**本轮没有执行上述任何命令。** 未安装、未重载、未重启，也没有改动任何 profile，因此这条渠道的
**安装行为在本轮未验证**。核到的只是「某个已发布的 Release 及其资产元数据存在」（只读 `gh release
view`：标签、目标提交、资产名）；没有下载、解包或安装任何产物，而**未来**构建的产物（含其摘要）
只能在该次发布跑完后才能核对。确切的参数与 spec 形式以目标 CLI 自己的 `plugin --help` 为准。安装
失败时请保留 manifest、lockfile 与 CLI 输出并如实报告，不要手改 profile。

## 获取源码

本分支的源码版本为 **`0.3.0`**。某次下载究竟带哪个版本，由该构建 tarball 里的清单决定
——请与 Release 名（`v<version> · <sha>`）对照，而不是假设 `main` 与本文一致。

```sh
git clone https://github.com/KouzakiUmi/dsh-tool-discovery
cd dsh-tool-discovery
```

纯 JavaScript，无构建步骤。清单里声明了一个运行时 `dependencies` 项 `zod`（`^4.4.3`）——可信周期
记录表要以 zod schema 交给宿主的 storage domain——所需宿主包则声明为 `peerDependencies`，由 DSH
安装提供。项目不做 vendored 副本，也不存在可以拿来掩盖宿主包缺失的构建步骤。

## 自行验证

在仓库根目录执行：

```sh
npm test                          # 单元测试 —— 以该命令的实际输出为准
npm run test:composition          # 组合门禁（真实 DSH Loader）—— 以实际输出为准
npm run test:all                  # 依次运行以上两者
npm run check                     # 包身份 + 文档一致性检查（只需 Node）
npm run clean                     # 清除可再生的测试残留
```

单测大部分只需要 Node。其中两个文件依赖宿主：`plugin/tests/unit/client.test.mjs` 与
`plugin/tests/unit/settings.test.mjs` 在模块顶层就通过 `plugin/contracts/install-resolver.mjs`
从已安装的 DSH 里取 React 与 `@deepseek-ai/schemastery`。要在装有该 DSH 的机器上跑完整套件；
安装不在默认位置时用 `DSH_INSTALL_ROOT` 指向它。

因此 CI 的便携单测作业只跑除这两个文件以外的全部用例，并明确把这两个文件按宿主依赖跳过
并给出原因。该作业是便携子集，不等于整份单测证明：含这两个宿主文件在内的完整套件，由本地
在真实 DSH 安装根上执行的 `npm test` 覆盖。此处不声称任何浏览器或 DOM 渲染层面的覆盖。

用例数会随测试增减而变化，因此这里**刻意不写死数字**。以这两条命令的实际输出为准；写在本文件
里的数字必然过时。

`test:composition` 会在真实 Loader 上运行 `plugin/tests/composition/gate-*.test.mjs` 的全部文件：
适配器门禁、生命周期、恢复与 fork、事件 `seq`、缓存周期、设置、工具增减，以及可信周期各套。新增
门禁文件会被 glob 自动纳入，无需改其它地方。详见 [07 · 恢复与 fork 覆盖](plugin/docs/07-lifecycle-recovery-coverage.md)。

组合测试会针对已安装的 DSH 启动真实 Cordis Loader，因此需要宿主在场。它们从该安装解析包；若
安装不在默认位置，请用 `DSH_INSTALL_ROOT` 指向它。这些命令不安装、不重启，也不会改动你的
DSH profile；但会在被 Git 忽略的 `plugin/fixtures/tmp/` 下创建临时会话文件，并在每个测试进程退出时
清除。设置 `DSH_KEEP_TMP=1` 可保留现场用于排查；`npm run clean` 清除任何残留。

质量工装是公开的，但完整跑完需要冻结的评分数据集，而该数据集未公开，因此在公开检出上无法跑完。
该数据集覆盖什么、当前处于什么状态，见[当前状态](plugin/docs/05-current-status.md)。

## 配置

插件没有必需配置，所有字段都是插件自身配置命名空间里的**扁平根字段**——在当前的原生配置面上
**没有** `progressiveDiscovery` 外层包装：

```jsonc
{
  // "alwaysVisible": ["read", "grep"],  // 整项省略即保持 DSH 默认名单
  "initialToolsEnabled": true,  // 可关闭手动初始注入，不删除已配置名单
  "alwaysAllowPresetTools": true, // 保留当前实际绑定的 preset 所登记工具
  "requireTrustedEpoch": false, // 高级严格校验，默认不阻断存量会话
  "requireTrustedEpochForSubagents": false, // 仅主严格开关也开启时对子代理强制校验
  "frameworkRetained": [],  // 投影必须保留的可信框架工具名
  "categoryConfig": {},     // 本地化类别卡
  "budgets": null,          // 见下；null 表示不覆盖
  "locale": "auto"          // "auto" 跟随桌面语言；写 "zh"/"en" 可钉住语言并跳过读文件
}
```

`alwaysVisible` 是**替换手动初始名单**，而不是追加默认项；省略它即保持 DSH 核心工具默认值。
preset 保留是独立来源：`alwaysAllowPresetTools` 开启时，当前实际绑定 preset 所登记且原生作用域允许
的工具会与手动名单合并。若只需要三个发现入口，应设 `alwaysAllowPresetTools: false`，并设
`alwaysVisible: []` 或 `initialToolsEnabled: false`（显式框架保留仍可能贡献工具）。三个入口不可删除。
设置页全局目录中存在某工具，不意味着它会被授予所有会话。

### 设置面板

在原生 `schemastery` peer 在场时，DSH 自带设置页会为本插件渲染一个**工具发现**标签页，含可选功能开关与
**应用全局登记目录**。目录读取当前全部注册层，包括无需创建会话就已预加载的 preset；不读取会话资格、
发现/加载状态或历史请求头。支持按名称筛选、勾选切换与**恢复 DSH 默认**，勾选只写根级 `alwaysVisible`。
完整目录中缺少名字时标注为**未在应用全局目录登记**，不断言调用失败；宿主 SDK 无法提供完整目录时，
未列出的名字标注为**全局登记状态尚未确认**。全局已登记不保证每个会话都具备执行权限。

- **自动注入初始工具**（`initialToolsEnabled`，默认 `true`）：关闭不删除勾选名单，不自动注入这些工具，仍可用 `tool_load` 加载。开关和名单改动在**新会话或成功压缩后**采用，当前周期不改变。
- **永远放行 preset 规定的工具**（`alwaysAllowPresetTools`，默认 `true`）：只读取当前 agent 实际绑定的 preset 修订自身登记、且该 agent 原生目录仍允许的工具。不根据会话 header 中的 preset 名或设置页全局目录授信；其它 preset、后装 agent-only 工具不会被自动放行。与手动注入独立，在新会话或成功压缩后采用；保留初始集合，不绕过原生权限和执行校验。
- **强制可信周期校验**（`requireTrustedEpoch`，默认 `false`）：默认不读写可信周期存储、不因缺少记录或 storageDomain 阻断会话；常驻工具来自当前配置快照，历史出站头不授予资格。开启会重新加载插件，要求持久化周期记录；存量会话缺记录时需要成功执行用户 `/compact`，存储故障也会阻断。关闭后可恢复没有记录的会话，但**不提供严格模式的跨重启名单冻结保证**。
- **对子代理强制可信周期校验**（`requireTrustedEpochForSubagents`，默认 `false`）：只有主严格开关也开启时才生效。默认情况下，宿主运行时拥有的子代理使用配置基线，不读写 epoch 记录，不因缺记录要求 `/compact`，包括已有历史的子会话恢复。身份依据实时父子所有权，不信 header/meta 自称或单纯的持久 fork 血缘；作为顶层恢复的 fork 会话仍受主严格开关约束。该普通设置会重载插件，关闭后可恢复旧子会话，无需伪造压缩。显式开启可能阻断旧子会话；子代理不能代替用户执行 `/compact`。
- **界面语言**（`locale`，默认 `auto`）：`auto` 在激活时读一次桌面语言，读不到（文件缺失、JSON 损坏、语言不受支持）回落 `en`，且回落**一定会留日志**、不静默。写 `zh`/`en` 会钉住模型可见文案的语言，并**完全跳过这次读取**。非 volatile 字段：改动在插件重载后生效。
- 工具资格、协议回执、历史损坏校验和执行门禁始终有效，不提供关闭这些保护的开关。三个发现入口始终保留。

保存失败会显示错误，不宣称生效。该面板即原生配置面；不承诺旧包装配置或旧版设置 UI 的兼容性。浏览器渲染与在线安装仍需单独验收，工作区测试通过不代表已部署。

### 预算：硬上限默认关闭

本插件**默认不额外增加风险阈值**。所有硬上限——工具数量、批次大小、schema 字节、页大小、
结果字节、查询长度、技能字节——默认都是 `null`，即**关闭**。给它一个正整数即启用该项上限；
填回 `null` 即关闭。这里用 `null` 而不是 `Infinity`，因为 `Infinity` 无法在 JSON 中存在。

```jsonc
"budgets": {
  "maxActiveTools": null,        // 例如 12：限制同时加载的工具数
  "maxActiveSchemaBytes": null,  // 例如 49152：限制冻结的 schema 字节
  "maxLoadBatch": null,          // 例如 4：限制单次 load 的工具数
  "maxListLimit": null,          // 例如 20：限制页大小
  "maxSearchLimit": null,
  "maxListResultBytes": null,
  "maxSearchResultBytes": null,
  "maxQueryCodePoints": null,
  "maxSkillBytesPerLoad": null
}
```

`maxActiveTools` 与 `maxActiveSchemaBytes` **只统计按需选择项**——已加载、已冻结或待披露的。它们
不统计初始 `alwaysVisible` 基线，那是宿主注入的，不属于本插件的预算面。

**打开上限是有代价的权衡，不是免费的安全加成：**

- **它会阻断任务。** 超出上限时被拒绝的是**新增项**。已披露的工具在任何配置下都不会被淘汰
  来腾位置——不存在"为了塞进去而卸载"这种行为。
- **它会增加轮次。** 模型必须把同一件事拆成更小的多次 load，代价是更多模型往返、更高延迟、
  更高总成本。
- **它可能给下一次 load 造成压力，并可能诱使用户提前压缩。** 当已披露集合超过上限时，可选的应对
  包括**调高限额、关闭限额**，或压缩得更早一些——而过早的压缩需要重建上下文。这些都不是被迫的，
  限额由设置者完全掌控。
- **限额不等同于优化。** 一个让任务失败或变慢的上限，并没有让任何东西变得更便宜。默认建议保持
  关闭；只有在有明确理由时（例如部署必须约束 prompt 增长）才设置。

即使所有硬上限都关闭，以下仍然有界：默认页大小（`defaultListLimit`，20）、默认候选数
（`defaultSearchLimit`，5）、分页本身，以及各项 TTL。关闭硬上限不会让输出变得无界，只是表示在
这些默认值之上没有额外天花板。

`initialSchemaTargetTokens` 与 `maxInitialBytes` 是历史目标值，当前代码路径并未强制它们，因此
**不是**"实测保证的初始 2K 预算"。

## 架构与其代价

稳定 wire + 只增不改的披露会减少 prompt 中**不必要的前缀变动**；已知工具名可以批量加载，压缩之后
不会被强制再走一轮检索。这是设计意图——**不声称任何实测的上下文或 token 节省**，也不应从中读出
这类承诺。

另一面是权衡的另一侧：初始名单切得过小会增加模型往返与重新发现的开销。默认采用 DSH 核心工具、
同时保留可编辑，是一个有意识的平衡——不是"初始 2K 预算"的承诺。

## 它还不是什么

这是一个可运行的实现，不是成品。

- 尚未完成完整产品验收。`0.2.1`、`0.2.2` 已发布到 npm；`0.3.0` **尚未发布**——它只存在于 `main` 与
  提交级构建资产上。**没有向任何真实 profile 安装、重载或重启**：[上架与兼容声明](plugin/docs/10-store-compatibility.md)
  里的安装 / 启动 / 卸载 / 恢复证据取自一次性的 `DSH_HOME`，因此这里任何内容都不应被读作"已验收的在线 GUI"
  或"完整产品验收"。
- **设置 UI 有单测与集成测试覆盖，但没有渲染 DOM 的验收。** 原生配置面、缓存周期行为、目录元数据
  以及客户端辅助函数都已测试；面板本身未在真实浏览器中跑过。
- **不声称任何 token 节省。** 设计的出发点是让每次请求携带更少内容；实际缩减幅度没有测量过，
  延迟也没有。
- 检索质量——能否稳定找到正确的工具——同样没有测量。
- fork 继承与进程重启后的冷恢复只覆盖了一部分。不变量与已知缺口列在
  [当前状态](plugin/docs/05-current-status.md)中。

## 延伸阅读

- [设计文档](plugin/docs/README.md)——需求、冻结协议、验收矩阵、运行时证据与当前状态。
- [贡献](CONTRIBUTING.md) · [安全](SECURITY.md)

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
