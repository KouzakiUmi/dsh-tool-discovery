# rc.1 组合测试迁移

## 基线

在只读 rc.1 解包安装树上运行 `npm run test:composition`：102 tests，13 pass，89 fail，0 skipped。失败包含引用已删除 journal 的导入错误、旧 epoch/canonical/projection 断言，以及产品激活错误。

## 文件分诊

| 文件 | 处理 | 当前目标 |
|---|---|---|
| gate-adapter | 重写 | 四入口、无 sessionQuery 依赖、审批、冲突回滚、白名单 |
| gate-adapter-lifecycle | 重写 | 候选引用、跨会话隔离、公开 unload、durable resume |
| gate-rc1-native-restriction | 重写 | mask 安装/admit/revoke、两步语义、换版、peer restriction、重入注册、entry shadow |
| gate-terminal-load-result | 重写 | load body 成功即 admission；post-block/取消不回滚已提交事实；list 默认导航 |
| gate-ptc-disclosure | 删除并替换为 gate-ptc-mask | 无兼容分支；TS/Python SDK 从真实 definitions() 掩码视图渲染 |
| gate-adapter-event-seq | 删除 | journal canonical seq 子系统已移除，无独立等价目标 |
| gate-adapter-recovery | 删除并迁移有效目标 | admission resume/故障回退/会话隔离由 lifecycle、review-boundaries、mask 覆盖 |
| gate-subagent-epoch-option | 删除并迁移有效目标 | epoch 配置不再存在；fork admission 隔离由 lifecycle 覆盖 |
| gate-optional-settings / gate-settings | 逐用例适配 | 可选存储、配置形状/volatile、实时目录、压缩不中止 |
| gate-global-tools-preset | 逐用例适配 | 全局登记目录、preset 默认名单、第三方 restriction |
| gate-runtime-verification | 逐用例适配 | 核心工具运行时自证与 respectAlwaysVisible |
| gate-review-boundaries | 重写 | admission 读写故障/迟到服务不阻断、默认全遮 |
| gate-tool-churn | 逐用例适配 | 移除/换版撤权、旧引用失效、重新 load 恢复 |
| gate-plugin-disposal | 重写 | 自有 runtime/mask/guard/store 生命周期；不复活旧 runtime |
| gate-disclosure-settings-fixes | 重写 | 初始注入开关、换版后当前定义、压缩不换准入周期 |
| contracts/harness / composition/harness | 调整装配 | 移除 projection-guard fixture；sessionQuery 非必需依赖，保留服务供宿主及测试取证 |

此前已删除的 cache-epoch、builtin-descriptions、trusted-epoch 系列不恢复；无旧周期/逐字冻结 wire 验收。

## 等价覆盖

- global 未 load：provider 最终 request 不含工具；猜名 body=0。
- own-scope：宿主可披露，默认 admission guard 拒绝未 load；不声称 own 工具可隐藏。
- 同响应 load：本步 toolSet 不含 global 目标，body=0；下一步披露且真实执行。
- tool_unload：addition-only 下一请求不含声明且不可执行；in-history 可保留历史 schema 但无执行资格。
- 换版/移除：旧 admission 与候选引用失效；重新 load 下步恢复。
- session/fork：admission 不跨 sessionId 继承；resume 仅采用自身 durable admission 且核对当前 digest。
- storageDomain：真实 put 与重启同 root 恢复；缺席/失败退化内存，不阻断请求。
- 四个 entry 任一被 own 同名覆盖：guard 拒绝，不执行影子 body。
- 自有掩码反馈有界；掩码事件内重入第三方注册对齐所有 runtime；其它插件 restrict 继续有效。
- PTC SDK TS/Python 从宿主 definitions() 同源渲染，load/unload 与掩码一致。

## 产品缺陷取证

迁移中发现并交由产品负责人处理，未用测试 shim 绕过：

1. validateConfig 引用已删除的 builtin-description resolver，导致激活失败。
2. tool_load candidates.items 缺显式 additionalProperties，rc.1 schema compiler 拒绝激活。
3. 初始 mask 未纳入 alwaysVisible 名单，配置工具会被隐藏。
4. agent/created 未建立 runtime，guard 对首步 own-scope 工具可能无 admission 放行。
5. 协议版本常量迁移后 adapter 两处仍写死旧值，导致引擎拒绝激活。
6. gateOwnScopeTools=false 只在目录外生效；真实 own 工具已在目录时仍被拒。RV8 保留 own 放行/global 拒绝的对照验收，产品负责人修复 guard 判断位置。

## 最终验证

在 `plugin/` 目录执行：

```sh
DSH_INSTALL_ROOT="D:/Software Projects/dsh-tool-discovery/.probe/install-root-rc1" npm run test:composition
```

结果：exit 0；70 tests / 70 pass / 0 fail / 0 skipped / 0 cancelled，耗时 1706.5948ms。范围内 `git diff --check` 通过。

上述六项产品问题均由产品负责人修复，组合回归已覆盖修复后的行为；本迁移不修改 domain/adapters。仅 mock provider 与测试私有存储，不代表 GUI、真实模型或所有宿主版本已验收。
