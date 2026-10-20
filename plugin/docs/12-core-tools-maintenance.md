# 12 · 核心工具跟版与名单漂移

## 1. 维护约定

**DSH Core 升版必须核验并按差集更新 `CORE_TOOL_NAMES`**，同时更新其派生依据，不能仅更新 peer 范围。
基线见 [core-tools.mjs](<../domain/core-tools.mjs>)；检查器见 [check-core-tools.mjs](<../../scripts/check-core-tools.mjs>)。
宿主工具定义没有供本插件使用的来源契约；同名工具不等于来源已得到认证。
跟版清单不能用未核验的 `layers` 结构认证来源，也不要把 preset 的 `tool-*` 注册 ID 当成工具名。
这与现有 [tool-inventory.mjs](<../adapters/dsh/tool-inventory.mjs>) 为 UI/preset 读取登记层是不同用途：
后者有局部/unknown 边界，不是已核验的完整 Core 工具清单，也不能证明任意未来版本接口稳定。
核心同名自证只作用于维护表中的名称；上游新增一个不在表中的名字，不会自动成为可信核心身份。

## 2. 漂移日志（不改变授权）

生命周期在恢复完成后的 pre-step 屏障与周期边界读取当前候选名单，产生 `lifecycle:names-drift`。
同一 runtime 的相同差异只记录一次；恢复一致后再次出现差异会重新记录。无 timer、无持久写。

| 字段 | 含义 |
|---|---|
| `added` / `removed` | 当前候选相对 `runtime.alwaysNames` 周期快照的新增 / 移除 |
| `effectiveOnly` | 实际 `alwaysNameSet` 中存在、周期快照没有的名字（例如 guard 自证） |
| `pendingAdded` | 当前候选有、实际集合还没有的名字；不表示工具必然存在或可执行 |
| `requireTrustedEpoch` / `baselineState` | 是否要求可信记录以及当前基线状态 |
| `point` | `pre-step` 或 `epoch-boundary`；边界日志比较的是更新前快照 |
| `activation` | 周期换名的条件说明，不是生效保证 |

候选由配置、preset 保留项和允许时的核心同名自证共同产生，日志**不归因于 Core 升级**。
候选读取失败记 `lifecycle:names-drift-unavailable`，不转储异常原文，不改变原门禁结果。

`requireTrustedEpoch=true` 时，周期名单更新必须满足周期/迁移资格并有可信记录 durable 落定；
缺失记录的老会话、迁移不合格或存储失败时，成功压缩本身不保证生效。
`respectAlwaysVisible=true` 是另一维约束：不再自动吸收未配置的核心同名工具。
这两项不能统称一个“严格模式”。本次不改变任一开关或 guard 行为。

“新增工具必须等压缩才可见”不是通用结论：默认 guard 的核心自证或显式 `tool_load` 都是独立路径。
常驻配置在已有 runtime 的周期内不主动更新，新 runtime 使用自己的初始化/恢复契约。
旧项 wire 冻结、新项追加，也不等于允许无记录地扩大执行授权。

## 3. 离线跟版检查

```sh
node scripts/check-core-tools.mjs --inventory /path/to/audited-core-tools.json
```

检查器不要求 SDK，不执行宿主包、不访问真实 profile，不使用隐式安装路径。
输入是**目标版本已核验的核心 composition 清单**，不是当前 profile 的全量工具列表。
按该版本的官方 preset 逐个解析实际插件贡献，再核验 agent-loop、subagent、workflow、plan-mode 等
动态注入工具；在清单中逐项注明包版本及注册位置。不要混入用户插件或 MCP 工具。
不同 preset/scope 的范围必须写清；需要全面跟版时应使用目标核心 composition 的工具并集。

清单契约（示例只演示格式，不代表完整宿主工具面）：

```json
{
  "schemaVersion": 1,
  "core": { "package": "@deepseek-ai/dsh", "version": "目标实际 Core 版本" },
  "composition": "所核验 preset、scope 与动态贡献范围",
  "complete": true,
  "tools": [
    {
      "name": "bash",
      "source": {
        "package": "实际贡献该工具的包",
        "version": "该包实际版本",
        "kind": "preset",
        "evidence": "相对包路径:行号或明确注册位置"
      }
    }
  ]
}
```

`kind` 只能为 `preset` 或 `dynamic`。重复名字、空清单、缺来源/版本/完整性声明均拒绝检查。
工具并集中的同名项应先核验冲突，再保留一项证据；不得靠去重掩盖同名覆盖。

输出 `missingFromBaseline`（基线漏收）和 `absentFromComposition`（该 composition 未提供的基线名）。
退出码：`0` 无漏收；`1` 有漏收；`2` 参数/读取/清单契约错误。
composition 没有的基线名只报告，不自动删除：某些名字仅存在于其它 scope、版本或 preset。

**证据边界**：`complete=true` 是取证者的声明，检查器只验证清单结构与差集，不能证明声明真实，
不能认证工具来源，也不能替代真实宿主组合测试。本阶段未实现自动宿主清单导出。
CI 的 portable unit 自动测试检查器；有已核验清单的 composition 环境可显式运行上述命令。
未提供清单时不能把 B1 视为“已完成目标宿主跟版核验”，也不接入一个无证据却恒绿的 CI 步骤。
