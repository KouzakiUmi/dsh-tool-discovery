# 13 · DSH 默认工具提示词精简

更新日期：2026-10-26。本文描述工作区实现，不表示已发布或在线安装。

## 1. 总开关与逐工具开关

“设置 → 工具发现”保留总开关 **DSH 默认工具提示词精简**，并提供可折叠的 **逐工具描述精简开关**。每个受支持工具都有自己的开关，不按类别捆绑。

```json
{
  "compactBuiltinToolDescriptions": true,
  "compactBuiltinToolOverrides": {
    "subagent_fork": true,
    "str_replace_editor": true,
    "pwsh": false
  }
}
```

- 总开关默认 `false`，优先于所有逐项选择；关闭时仍能预先编辑逐项选择。
- 兼容已有配置：原有 `bash`、`pwsh`、`workflow`、`read_image`、`create_goal` 五项，未配置逐项值时仍随总开关启用。
- **新增工具默认关闭。** 将其逐项值设为 `true` 才参与精简；原五项也可以单独设为 `false`。
- 逐项对象默认 `{}`，只接受本页列出的工具名与布尔值；不接受“全部工具”通配、未知工具或自由替换文本。
- UI 对每次切换只写 `compactBuiltinToolOverrides.<name>`，不以旧对象覆盖其它工具的选择。

## 2. 范围与边界

- 仅 native 模式；PTC / `run_code` SDK 保持原样。
- 只替换完整原始定义指纹匹配的顶层 `description`。工具名、参数结构、参数说明、执行函数、原生作用域、审批、沙箱均不改。
- 不修改宿主注册表对象、不覆盖安装文件、不调用模型生成摘要、不改变初始工具集合。
- 未识别的上游版本、定制参数、追加描述等均保留原文。指纹验证覆盖名称、完整原描述和完整参数定义，绝不退化为仅按名称或前缀匹配。
- 指纹是已审校文案/参数合同的匹配证据，不是代码供应商身份证明。同名工具不能仅凭名称被当作官方实现。
- 全局规则、技能目录、MCP、额度插件、Git Bash 插件的定制提示词不在覆盖范围内。
- 中/英文模板按插件语言和周期快照选择，不假设字符数等于 token 数。

## 3. 覆盖清单

当前提供 **28 个工具的独立开关、53 种精确匹配的定义变体**。核验基线是 **DSH Core 0.2.1-rc.3**，不是对所有版本、所有实验性插件的兼容声明。

| 类别 | 工具 |
|---|---|
| Shell / 终端 | `bash`、`pwsh`、`terminal_open`、`terminal_send`、`working_directory` |
| 文件 / 交付 | `read_image`、`str_replace_editor`、`glob`、`grep`、`present` |
| 子代理 / 编排 | `workflow`、`subagent`、`subagent_fork`、`list_subagent_models`、`send_message`、`interrupt_agent`、`ralph` |
| 规划 / 交互 | `create_goal`、`todo_write`、`exit_plan_mode`、`ask_user_question`、`skill` |
| 检查 / 环境 | `cordis_inspect_list`、`cordis_inspect_query`、`load_workspace_dependencies` |
| 提醒 | `schedule_create`、`schedule_update`、`schedule_delete` |

重要变体边界：

- `bash` / `pwsh` 区分一次性与持久 shell；一次性形态另外区分沙箱、前台/后台、超时转 job 等，不能混用语义。
- `subagent` / `subagent_fork` 共覆盖 12 种组合，分别保留是否继承对话、是否支持续聊、能否选模型，以及后端/父代理路由默认值；不把不同后端统写成一种说明。
- `todo_write` 区分单个 in_progress 与允许并行；`glob` 区分首批截断与跨顶层抽样；`terminal_send` 区分能否后台运行。
- `ask_user_question` 仅匹配较长的 timed 形态（默认 120 秒参数定义），保留 pending 与用户提交跳过的区别；短 legacy 形态不改。
- `glob` / `grep` 目前匹配默认 100 路径 / 250 匹配项的定义；自定义限额导致指纹不同则保留原文。
- 官方模块另行注入的安全指令 section 始终保留。定时工具的参数说明也未精简。

较短的定义（例如 `read`、`write`、`edit`、`job_kill`、`schedule_list` 等）不因“覆盖率”而强行缩短。尚未确认来源的动态工具（如当前目录里的 `list_agents`）不按名称套用模板。

## 4. 身份与缓存

协议仍是版本 2，不削弱原有校验：

1. registry 观察原始 definition 实例和原始 wire，维持绑定代次。
2. 会话策略只为启用且匹配的工具生成展示 wire；原始 wire 摘要仍进入绑定 identity，避免不同原定义被相同短描述混同。
3. catalog 的 `schemaDigest`、load 回执、真实出站、advertised、冻结和按需 schema 字节预算使用同一展示 wire。
4. 搜索继续使用完整原始描述，避免为精简展示而丢失检索词。
5. 定义变更/撤权照常使执行选择失效；保留冻结展示不等于恢复调用权限。

实现入口为 [builtin-descriptions.mjs](<../adapters/dsh/builtin-descriptions.mjs>)，原五项文案在 [v1 数据](<../adapters/dsh/builtin-descriptions-data.mjs>)，扩展文案在 [v2 数据](<../adapters/dsh/builtin-descriptions-v2.mjs>)，逐项默认值及稳定位序在 [选项定义](<../adapters/dsh/builtin-description-options.mjs>)。

## 5. 生效与旧版本恢复

总开关和逐项对象都是 volatile：**保存不重载插件**。它们仅在新会话或成功压缩时被同步快照；失败、取消、缺摘要的压缩不切换，已发送的旧数组不改写。

当前 v2 标记随已有 `tool_load` 描述进入原生 `request/header`：

```text
[dsh-tool-discovery:builtin-descriptions:v2:zh:1f]
```

最后一段是逐工具启用位掩码，`1f` 表示原五项，`0` 表示全关；不会重复注入完整工具名清单。无需新增 Session event、存储服务或系统提示词段落。总开关关闭的新周期不添加标记。

恢复顺序：核验 own/inherited 和压缩边界 → 恢复本周期策略 → 重建展示目录 → 校验/回放 load 回执 → 恢复真实披露 wire。

- 已有 header 但无标记：保持原版，到下一成功周期边界才采用当前配置。
- v1 标记：保留原五项及原文案，**不会获得 v2 新工具或新变体**。
- v2 标记：恢复当时的语言和全部逐项选择；用户此后关闭总开关或修改选项，也不改写这个旧周期。
- 无任何本周期 header：使用当前边界捕获的配置。
- 未知版本、非法掩码、未知位：不启用部分精简策略，继续遵守原有冻结/回执校验。
- 继承前缀和旧周期不能控制当前周期。单独标记不能授予工具资格。

已发布模板、默认值和掩码位序不得原地改变。后续修订需继续保留旧版回放或明确等待成功压缩。

## 6. 验证与维护

- [原五项样本](<../tests/fixtures/builtin-descriptions-rc3.json>) 与 [扩展注册样本](<../tests/fixtures/builtin-descriptions-extra-rc3.json>)来自官方 rc.3 注册过程；不执行工具、不启动子代理或终端、不读取凭据。
- [扩展捕获助手](<../tests/helpers/capture-extra-builtins.mjs>)供目标安装对照，不根据当前安装自动“批准”新指纹。
- [逐项单测](<../tests/unit/builtin-description-options.test.mjs>)覆盖全部开关、掩码、v1/v2 回放、正负向匹配及 UI 单叶写入。
- [生命周期单测](<../tests/unit/builtin-descriptions.test.mjs>)与[真实宿主组合测试](<../tests/composition/gate-builtin-descriptions.test.mjs>)覆盖实际请求、执行门禁、volatile 不重载、冷启动、真实手动/自动压缩。

字符与 UTF-8 字节可复现，但不是实际模型 token 数。收益由真正披露的工具和匹配到的变体决定；不把互斥变体的字数相加冒充一次请求成本，也不承诺整个提示词固定降幅。真实模型行为、安全边界与任务完成率还需要独立 A/B 评估。

官方来源：[项目与工具源码](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages)、[Cordis 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)、[Session 插件约束](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md)。这些链接是上游当前文档，不能代替目标版本的固定样本和运行核验。
