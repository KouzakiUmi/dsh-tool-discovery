# 10 · DSH STORE 上架契约与兼容声明

核验日期：2026-10-10（Asia/Hong_Kong）。
证据类型：**固定 Commit 上的 manifest 声明 + 隔离 DSH_HOME 的一次性 Profile 安装/启动/卸载/恢复记录**。
本文件是上架与兼容口径的权威说明；它**不**构成「已上架」「已通过独立安全审核」或「全部路径已验收」的声明。

## 1. 目的与边界

DSH STORE 对每个第三方插件都从**固定 Commit**读取 manifest、Bundle Patch、许可证、生命周期脚本与
有界运行时代码，并据此决定目录状态与安装准入。本文件把本仓库对应的事实集中记录，避免把
「构建产物存在」「npm 已发布」「商城已收录」「真实 Profile 已安装」混成一句话。

四件事互相独立，逐项分开写：

| 状态 | 本仓库当前事实 |
|---|---|
| 源码可安装契约（manifest / Patch / 许可证 / `files`） | 见 §3 |
| 一次性 Profile 的安装、启动、卸载、恢复 | 见 §4（有记录） |
| npm 发布 | `0.2.1`、`0.2.2` 已发布；发布不等于已安装到任何 Profile |
| DSH STORE 收录 / 真实 Profile 加载 | **未验证**；本仓库无上架记录，也未对真实 Profile 执行安装 |

## 2. 兼容矩阵（manifest 声明）

`package.json` 的 `dsh.compatibility.dshReleases` 对官方当前三个发行版逐项声明：

| DSH 版本 | 声明 | 证据 |
|---|---|---|
| `0.2.0-rc.2` | `unknown` | 本机无该版本安装，未测 |
| `0.2.1-alpha.1` | `compatible` | 发布基线：`0.2.1`–`0.2.2` 的单元与组合测试在该 Core 上通过（结论集见 [当前状态](<05-current-status.md>)）。**本次未复跑**——本机 Core 已是 `0.2.1-alpha.2` |
| `0.2.1-alpha.2` | `compatible` | 本次实测：**133/133 组合测试**与 375/375 单元测试在当前宿主上通过，一次性 Profile 的安装/启动/卸载/恢复全通（§4）。该版本改变了本地 fork 子代理的常驻语义，门禁的取证方式已随之更新（§5） |

peer 范围（安装准入）与上表是**两件不同的事**：`peerDependencies` 写
`0.2.1-alpha.1 || 0.2.1-alpha.2`，表示这两个运行时都允许安装；`dshReleases` 表示作者掌握的兼容证据。
未声明的版本一律按未知处理，不用范围推断兼容。

Node：`engines.node` = `^22.19.0 || >=24.0.0`，与 CI 的 `22.19.0` 下限矩阵一致。

## 3. 上架契约逐项对照

| STORE 检查项 | 本仓库事实 |
|---|---|
| 公开 canonical GitHub 仓库 | `https://github.com/KouzakiUmi/dsh-tool-discovery`（public，默认分支 `main`） |
| manifest `repository` 与仓库一致 | 指向同一仓库 |
| 许可证一致 | manifest `license: MIT`；仓库内 `LICENSE`（MIT）；GitHub 识别为 MIT |
| `dsh.bundle.patch` | `./cordis.patch.yml`，包内相对路径 |
| entry ID 唯一 | `tool-search`：Patch 只新增该行，不覆盖、不禁用任何官方组件 |
| 生命周期脚本 | **无** `preinstall`/`install`/`postinstall`/`prepare`；打包以 `npm pack --ignore-scripts` 执行 |
| 运行文件与 `files` | `files` 声明 `plugin/adapters/`、`plugin/domain/`、`plugin/client/`、`cordis.patch.yml`；本机 `npm pack` 载荷 36 项 / 约 152 KB（含自动附带的 `package.json`、`LICENSE`、`README*`、`CHANGELOG.md`） |
| 运行依赖 | `zod`（运行时 `import('zod')`）；`@deepseek-ai/*` 为 peer，由宿主安装提供 |
| 兼容声明 | 见 §2 |

## 4. 一次性 Profile 验收（2026-10-10）

隔离 `DSH_HOME`（`%TEMP%\dsh-e3-home`），**未触碰真实 `~/.dsh`**；CLI 为 DSH NEXT 随包 CLI
（`resources\app\lib\desktop-cli.js`，Core `0.2.1-alpha.2`）。

| 操作 | 命令 | 结果 |
|---|---|---|
| 安装 | `dsh plugin --profile e3b add <0.3.0 tarball>` | 通过；Profile 清单登记 `dsh-tool-discovery`，安装副本含 `plugin/`、`cordis.patch.yml`、`LICENSE` |
| 启动（组合面） | `dsh --profile e3b --dump-config` | exit 0；组合中出现 `- id: tool-search`，无 `incompatible` / `rejected` |
| 启动（模块导入） | `dsh --profile e3b --dump-config-schema` | exit 0；导出本插件 Config（`alwaysVisible`、`frameworkRetained`） |
| 卸载 | `dsh plugin --profile e3b remove dsh-tool-discovery` | 通过；Profile 清单与 `node_modules` 均不再含该包 |
| 恢复 | 重装同一固定产物 | 通过；版本读回 `0.3.0`，入口文件就位 |

对照组（证明「安装准入」确实在起作用）：`0.2.2` 在 `0.2.1-alpha.2` 上被 CLI 以
`incompatible-version` 拒绝（其 peer 钉死 `0.2.1-alpha.1`），Profile 的
`package.json` / `pnpm-lock.yaml` / `node_modules` 被自动恢复；同一 tarball 在 0.3.0 的新范围下通过。

**未做**：真实 Profile 安装、GUI 可见性、真实 provider 出站请求、跨进程重启的会话恢复。

## 5. `0.2.1-alpha.2` 的宿主语义变更与取证方式

alpha.2 改变了本地 fork 子代理的生命周期：`result` 落定后，idle 的本地 fork 子 Agent 会从 live
registry 释放（`ctx.agents.get(childId)` → `undefined`），插件也随 `session/disposed` 清掉内存
runtime；此后该会话按**顶层**会话恢复 —— `epoch-policy.isRuntimeSubagent` 只认 live 的父子关系，
不为「曾经的子代理」保留豁免（该状态由 `SE5` 覆盖）。

因此三条真实 fork 门禁的**取证方式**必须改变，而不是放宽断言：

| 门禁 | alpha.2 下的取证方式 |
|---|---|
| `SE3` | 用 mock provider 的**响应闸门**（`mock-store.holdNextResponse`）把子代理的活动期钉成可控窗口：请求已录制、响应未回放，于是在它仍 live 时观测「子代理默认 `disabled`」；第二轮同样在活动期内取证 |
| `TF1` | 运行时观测改为**按该会话自己的持久记录重建 runtime** 后再看。`applied` 的期望由「恰好 0」改为「≤1 且必须来自子自己的 `op_tf1-child-load`」——重建会重放子自己那一条对；继承对仍由 `rejected === 0` 与 `selected` 的 name / `operationId` 精确钉住 |
| `L03` | 同上：按记录重建后再观测恢复结果，`selected` 仍只允许子自己的 `op_c-load`，`rejected === 0` |

结论：`0.2.1-alpha.2` 上组合 **133/133**、单元 **375/375** 全部通过。宿主语义变化记录在测试注释里，
断言强度未降低 ——「继承前缀的对绝不进入子的折叠管线」这条性质仍由精确的 `selected` /
`operationId` / `rejected` 断言保证。

## 6. 后续门槛

1. 在 `0.2.1-alpha.2` 上补一次**真实 provider** 的出站请求验收（当前为 mock provider + 真实 Loader 组合）；
2. 需要上架时，由作者在 DSH STORE 侧走一次固定 Commit 预检，并按结果更新 §1 的状态表。
