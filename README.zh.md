# DSH Tool Discovery

[English](README.md) | 中文

与其把上百个工具一次性交给模型，不如只给几个小型控制入口，让模型按需加载真正需要的能力。

这是一个 DSH 插件。首轮请求里模型只看到三个入口——`tool_list`、`tool_search`、`tool_load`——
外加每个能力类别的一段简短摘要，普通工具完全不出现。模型判断需要某个工具时调用 `tool_load`，
该工具的真实原生 schema 会在**下一次**请求中披露。之后模型照常调用该工具，仍然走 DSH 自身的审批、
沙箱与权限链。

渐进式披露解决的是上下文，不是速度：只携带模型大概率会用到的内容，就不必携带宿主本可以提供的
全部内容。内核自身不持有任何工具，也从不绕过宿主。

## 三个入口

| 入口 | 回答的问题 | 改变激活集合？ |
|---|---|---|
| `tool_list` | 这个类别里有哪些可发现的工具？ | 否 |
| `tool_search` | 哪个工具适合当前任务？ | 否 |
| `tool_load` | 我要用这些工具。 | 是 |

`tool_load` 不会执行目标工具，它只记录选择，披露发生在下一轮。卸载是显式的；调用未加载的工具
会被拒绝。

## 环境要求

- DSH Core **`0.2.1-alpha.1`**。其它版本未测试，本插件依赖的宿主接口是特定版本上的。
- **native** 工具展示模式。其它展示模式在激活期即被拒绝，不会静默降级。
- **每会话单个活动 agent**。单会话内多 agent 并发不受支持——请求无法无歧义地归属。
- Node `^22.19.0 || >=24.0.0`。

## 获取源码

插件未发布到 npm，也没有任何安装渠道经过验证。克隆仓库：

```sh
git clone https://github.com/KouzakiUmi/dsh-tool-discovery
cd dsh-tool-discovery
```

纯 JavaScript，无构建步骤，自身不依赖任何包——这些由宿主提供。

## 自行验证

在仓库根目录执行。单测只需要 Node：

```sh
npm test                          # 160 通过，0 失败
npm run test:composition          # 42 通过，0 失败
```

`test:composition` 跑四套真实 Loader 用例：14 项适配器门禁、7 项生命周期、13 项恢复与 fork、
8 项事件 `seq`。前两套在 `main` 上；恢复与事件 `seq` 两套位于未合并的分支，因此检出 `main` 会跑
21 个组合用例，本分支为 42 个，详见 [07 · 恢复与 fork 覆盖](plugin/docs/07-lifecycle-recovery-coverage.md)。

组合测试会针对已安装的 DSH 启动真实 Cordis Loader，因此需要宿主在场。它们从该安装解析包；若
安装不在默认位置，请用 `DSH_INSTALL_ROOT` 指向它。这些命令不安装、不重启，也不会改动你的
DSH profile；但会在被 Git 忽略的 `plugin/fixtures/tmp/` 下创建并清理临时会话文件。

质量工装是公开的，但完整跑完需要冻结的评分数据集，而该数据集未公开，因此在公开检出上无法跑完。
该数据集覆盖什么、当前处于什么状态，见[当前状态](plugin/docs/05-current-status.md)。

## 它还不是什么

这是一个可运行的实现，不是成品。

- 尚未完成完整产品验收，未发布到 npm，也未安装进任何 DSH profile 或 GUI。
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
