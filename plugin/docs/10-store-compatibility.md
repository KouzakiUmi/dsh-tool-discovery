# 10 · DSH STORE 上架契约与兼容声明

更新日期：2026-11-06。本文依据工作区 [manifest](<../../package.json>) `0.6.0` 区分兼容声明、测试、分发与安装；现行行为见 [00](<00-current-contract.md>)，实际测试状态见 [05](<05-current-status.md>)。本次未核验 STORE 收录、npm 最新版本或用户 Profile 的在线状态。

## 1. 目的与边界

manifest 声明不证明某次包载荷已经发布、安装或生效。STORE 规则和目录状态须针对目标版本与固定提交另行核验；实际安装状态须在目标 Profile 和 GUI 上核验。

| 状态 | 证据口径 |
|---|---|
| 工作区声明 | 当前 manifest、patch 与源码；不等同实际发布载荷 |
| 测试 | 记录目标 Core、测试范围及结果；mock provider 不是实际外部 provider |
| STORE / npm / GitHub 资产 | 各自检查对应发布记录和载荷，不从 manifest 推断 |
| Profile / GUI | 在目标环境单独验证；历史一次性实验不代表当前生效 |

## 2. 兼容矩阵（manifest 声明）

当前 `engines.dsh` 为 `>=0.2.2-rc.1`；`dsh.compatibility.dshReleases` 显式列出：

| DSH Core | 声明 |
|---|---|
| `0.2.0-rc.2` | `incompatible` |
| `0.2.1-alpha.1` | `incompatible` |
| `0.2.1-alpha.2` | `incompatible` |
| `0.2.2-rc.1` | `compatible` |

上述更旧版本不在本版支持范围。安装准入范围、逐版本声明与实测是不同事实；`0.2.2-rc.1` 之后的版本未逐一验收，开放范围不证明全部兼容。具体已执行测试与未覆盖项见 [05](<05-current-status.md>)。

Node 的 `engines.node` 为 `^22.19.0 || >=24.0.0`；宿主 peer 范围以 manifest 为准。不同操作系统、宿主形态、真实 provider、GUI 和目标 Profile 均须分别取证。

## 3. 上架契约逐项对照

| 检查项 | 工作区声明 |
|---|---|
| 仓库 | manifest 指向 `https://github.com/KouzakiUmi/dsh-tool-discovery` |
| 许可证 | manifest 为 MIT；发布载荷须另核 |
| Bundle patch | `./cordis.patch.yml` |
| 运行入口 | `./plugin/adapters/dsh/index.mjs`，另导出 domain 与 client |
| 打包文件 | `files` 指定 adapter、domain、client 与 patch；实际包载荷另核 |
| 依赖 | `zod` 为运行依赖；DSH 服务及 schemastery 为 peer，具体可选性见 manifest |
| 安装脚本 | manifest 未定义 `preinstall`、`install`、`postinstall` 或 `prepare` |
| 兼容范围 | 见 §2；声明不代替测试和安装验收 |

## 3.1 STORE 策略与历史复算

2026-10-11 曾对固定提交 `2c59d20` 的旧版本做 STORE 自动策略本地镜像复算，并记录需要单独审查的文件访问和供应链信号。该结果仅说明当时输入与规则下的评估，不代表 `0.6.0` 或当前 STORE 策略、收录与审核状态。需要上架时应对目标固定提交和实际载荷重新预检。

## 4. 一次性 Profile 操作（历史）

2026-10-10 在 Windows 隔离 Profile 上，以 Core `0.2.1-alpha.2` 和旧 manifest 的 `0.3.0` 产物记录过安装、配置导出启动、卸载与重新安装；失败安装后的自动恢复也有对照记录。成功安装后的显式 rollback 未单独执行。

这是针对旧 manifest 的一次性历史参考，不是 `0.6.0` 在 alpha 宿主上的兼容或安装证据，也不说明用户真实 Profile、GUI、真实 provider 或跨进程恢复已验收。

## 5. 历史宿主语义

alpha 期的 fork 子代理生命周期和测试取证曾有调整；对应结论只适用于当时的宿主与源码快照。当前版本的 resume、own-only 和会话隔离以 [00](<00-current-contract.md>) 与 [03](<03-implementation-and-acceptance.md>) 的准入口径为准。

## 6. 后续门槛

1. 对目标 Core 和实际发布产物分别完成适用测试、真实 provider 与目标 Profile/GUI 验证，并明确未覆盖范围。
2. 如需上架，针对固定提交和实际载荷执行 STORE 预检；分别核验收录、发布、安装与生效，不由任何单一结果推断其他状态。
