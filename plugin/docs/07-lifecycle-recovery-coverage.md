# 07 · 恢复与 fork 覆盖增强（分支 `fix/lifecycle-recovery-coverage`）

> **状态**：本文件所述的恢复与 fork 覆盖增强**已并入当前 `main` 基线**。
> 仓库于 2026-10-06 重建，旧历史（`2a1f9c0`、`257ddc0` 等）已重写移除、**不再可引用**；
> 下文出现的这些 commit ID 仅为历史记录。
>
> **独立核验通过 ≠ 产品验收**：本文不改变 [03 §11](<03-implementation-and-acceptance.md>) 的发布门槛结论，
> 冻结协议、预算表、错误码与验收 ID **一律未改**。

## 1. 这一轮补的是什么

原基线上，恢复相关的两条关键结论缺少可信实证：

| 缺口 | `main` 上的状态 |
|---|---|
| **L01 恢复条件断言空转** | 旧 `L01` 的断言块**整体被跳过**：清理动作实为删除整个 tmpRoot（jsonl 一并删除），且取态接口返回空值。断言从未真正压到「不满足」的分支，因此「通过」不代表链路可 ready。 |
| **fork 继承前缀是否被重放为子选中** | 静态**疑似风险**，当时无实证。既有的不继承结论**依赖 revision 差异**（父子的 `bindingGeneration` 必然不同），属**结构性隐患**：若两者 revision 相同，安全性就失去依据。 |

## 2. 修了什么（产品改动仅一处）

own-only 折叠的权威事实改为**当前公开的 query / session 协议**，不再依赖 revision 差异：

- 折叠边界取 `readSession` 返回的 `inheritedEventCount`，并与 live 会话的同名字段**交叉核验**；缺失 / 负数 / 非整 / 不一致 → **fail closed**。
- 按 **seq 值**过滤（`seq >= ownSeqStart`），不盲切数组；事件流须自 0 连续，断口 → fail closed；边界越界 → fail closed；边界等于流长是合法的「整段继承」。
- 三处（restore 折叠、恢复窗口缓冲、live 事件观测）使用同一边界；继承前缀不折叠、不观测、不入缓冲。跨边界的 call/result 天然不成对。
- own 对被 domain 判据拒绝时**照常计入 rejected**——过滤不吞安全判据。
- **未改**：`domain/**`（零 diff）、冻结常量与协议、`lifecycle.mjs`；沿用既有 fail-closed 语义，不使用已弃用的会话快照接口。

### 2.1 事件 seq 门禁（同一分支的后续修复，仍只改 `journal.mjs`）

**基线上的缺陷**：canonical `tool/result` 的 `seq` 畸形（`undefined` / `NaN` / 非整 / 负数 /
unsafe integer / `null` / 缺键）时，**撤销动作被直接丢弃，而该对仍被计入 allowed 集合**，即
畸形 `seq` **未被 guard 拦截**——`evaluateCall().allowed` 仍为 `true`、会话仍 `ready`、旧 selection
在下一轮被重新披露。**这里只说明 guard 是否放行；没有任何「工具 body 实际执行了」的观测。**

**修复**：

- 合法 `seq` 的判定收紧为**非负安全整数**，并按事件是否影响状态分类。
- **不确定的 pending state call 采取保守 seal**：一旦封存，清空 calls 缓冲，并在 restore 前后各设
  闸门；`activeSelectedNames` 在非 ready 时返回 `[]`，因此**出站 mock provider 录制的最终
  `GenerateOptions.tools`** 只剩三个入口（真实 assembly，非真实 provider wire）。
  **pending 的重复事件不会复活已封存的状态。**
- **双重损坏的取舍**：`seq` 畸形且存在 pending state call → 保守 seal；`seq` 合法时**不走**该 seq
  门禁；`seq` 合法但双损的 load 因无法配对而**不予授权**。因此**不能说「所有双损都 seal」，也不能
  说「所有普通 result 绝不误 seal」**——这是可用性换安全性的取舍，不是全称命题。
- **未改**：`projection.mjs`、`domain/**`、`guard`；范围严格限于 `journal.mjs`。
- **未知 `inheritedEventCount` 下的 state 相关 result 保守 fail closed**，属**可用性取舍**，
  不宣称行为无变化。

**宿主契约与总线方法学（已独立复核，方法学如下）**：

- 实读 Core `0.2.1-alpha.1`：`session.append` 以自身 `SessionSeq`（`log.length`）校验，**通过才
  emit**。
- 独立真实总线一轮正常路径：**19 事件 / 13 类型**，`selected=[hidden]`，`mode=ready`，header 可见，
  journal 折叠成功。
- **合法但伪造的 `seq` 9000 / 9001**：被真实 projection 以「cannot advance across missing seq 19」
  拒绝，**journal 未收到**。
- **畸形 `seq`**：被 `SessionSeq` 校验以 `TypeError` 拒绝，**journal 未收到**。

**结论的边界（不得扩写）**：据此**仅正常 bus 路径已实证**，且**在该 API 下注入异常到不了 journal**。
因此 §2.1 的异常防御回归是**直驱 `journal.onEvent` 的合成**，**不能声称真实宿主的畸形总线也已覆盖**。
**持久化损坏日志的实际端到端取证价值仍未验证。**

另：真实宿主的 `sourceEventSeqs` 允许 not-started 缺省；作者断言宿主 seq 合法，该断言**只在已实读的
契约范围内成立**，**不宣称损坏不可能发生**。出站 mock provider 的录制只是装配证据，**不是真实
provider wire**。

## 3. 实证强度（务必区分）

| 判据 | 性质 |
|---|---|
| `L03` / `L03xL01` 真实 fork：子会话不继承父 `selected`、子 own load 可披露可执行、跨重启恢复 | **真实宿主 seam**（`ctx.subagents` + fork-in-process 真实 seeded 子会话），非手搓 seed、非 mock |
| `L11a` query 缺失、`L11b` `readSession` 失败 → fail closed，含健康会话正控 | `L11a` 为真实组合；**`L11b` 是故障注入**（包装真实服务、只对目标会话 reject），**不冒称宿主自然腐败**——恢复读盘先于插件恢复，损坏日志会先让 resume 失败、到不了该分支 |
| `F08xL01` unload×恢复、`F03cxL01` 候选冷恢复、`S03xL05` 代次变更、`L06xL01` 恢复×资格 | 真实组合，均配正负控制 |
| `L03b1`–`L03b4`（同 revision 继承对、混跨边界、畸形 `inheritedEventCount` 与 seq 流、重叠去重） | **合成反例**，只证边界语义；**宿主实况下父子 `bindingGeneration` 必然不同，不会自然产生同 revision 或畸形流** |
| `boot SEQ` + `SEQ1`–`SEQ7`（真实 composition 产出的真实 load/unload 对与出站 header；畸形 canonical result 的 seq、pending 封存、restore 不复活、非 canonical 事件不误封、own-only 不被放宽、封存后出站只三入口、双重损坏与迟到重复） | 套件共 **8 项**（1 个 `boot` 取真实材料 + `SEQ1`–`SEQ7` 七项断言），**真实 composition 上运行**；畸形 `seq` 经**合成注入**产生（见下「方法学」：真实总线按构造到不了 journal）；非 canonical 工具与普通事件配正控制，验证不误封 |

## 4. 结论口径（严格）

- **已证实**：真实 fork 子会话的继承前缀中，父 `tool_load` canonical 对**曾进入**子会话的 restore 折叠管线，并被 domain 判据以 revision 不匹配拒绝。
- **未观察、未证实**：父工具在子会话中被实际继承激活的现象**没有被观察到，也没有被证实**。探针显示子会话首请求仅三入口、猜父工具 body=0。**因此不声称发生过授权继承漏洞**。
- 修复把 fork `reset`（冻结策略常量）落为 **own-only 折叠**，`L03b1` 单独证明同 revision 的继承对也会被排除。
- **恢复未落定（`runtime.restoring` 为真）期间，首请求不再发那份只有三入口的缩水请求**：装配改为等待
  公开的 `lifecycle.whenReady(sessionId)` 落定后再投影。等待**没有新增默认超时**，只有两个出口——恢复落定，
  或宿主本轮的取消信号 `context.signal`。**恢复已决为失败/incompatible 时**的只留基线三入口仍是既有
  fail-closed 语义，**与「pending 未落定」不是一回事**，本轮等待没有放宽它；**成功的 compaction 仍然 reset**。

**核验范围的限制（如实记录）**：源码实现与代码复核是**同一型号、不同会话**，代码复核已完成。文档
对齐与本轮复核同样是**同一型号、不同会话**。两条链路因此都存在**共享模型来源带来的关联误差**，
**不等价于异源独立证据**。本轮的主要证据是**机器可复现的断言与命令退出码**；本 PR 留维护者复核，
**不自动合并**。所谓「核验通过」在本文件里**只覆盖源码与其可复现证据**，不覆盖产品验收。

**本分支的状态分层（不得合并表述）**：

| 范围 | 状态 |
|---|---|
| 当时的恢复覆盖提交（own-only 折叠 + 13 项恢复套件，composition 34） | 源码已由独立会话核验通过，**限该核验范围** |
| §2.1 的 seq 门禁 + 8 项 event-seq 套件（composition 42） | **独立源码复审已 GREEN_REVIEW_PASS，范围严格限于本轮 3 个 code 文件**（`journal.mjs`、`package.json`、新测试）。独立复审亲跑 `unit 160` 与 `test:composition 42`，退出码 0；P1 为 assembly 口径的三入口 / body=0，P2 为双损 3/3 转 `incompatible` 且不复活，首轮发现的 deferred-read 竞态不回归。**这不是产品验收，也不覆盖上述 3 个文件以外任何源码。** |

## 5. 不声称范围

不覆盖 **L04 compaction、L08 crash/fsync 窗口、L10 HMR、S12、S13**、多 scope 并发压力、回执 meta 通道、真实 provider wire / token / TTFT / 检索质量；也不代表安装、GUI 生效或 npm 发布。

**新增的未覆盖项**：§2.1 的异常防御回归是**直驱 `journal.onEvent` 的合成**，**真实宿主的畸形总线未被
覆盖**；**持久化损坏日志的实际端到端取证价值仍未验证**。`fork` 后的长会话仍属产品层面未验。

## 6. 相关文件

- 测试：[`gate-adapter-recovery.test.mjs`](../tests/composition/gate-adapter-recovery.test.mjs)（13 项）、[`gate-adapter-lifecycle.test.mjs`](../tests/composition/gate-adapter-lifecycle.test.mjs)（`L01` 强化）、[`gate-adapter-event-seq.test.mjs`](../tests/composition/gate-adapter-event-seq.test.mjs)（8 项）
- 实现：[`adapters/dsh/journal.mjs`](../adapters/dsh/journal.mjs)
- 状态与判据：[02 协议](<02-protocol-and-data-model.md>) §6.1 状态机、§11 恢复规则、[03 矩阵 §7](<03-implementation-and-acceptance.md>)、[05 当前状态](<05-current-status.md>)

> 私有实施报告与运行日志**不随文档公开**，本文件只引用**公开测试与具体判据**。