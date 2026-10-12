// plugin/client/client.js
// 插件主页（设置 → 工具发现，顶层 `settings.section` 区）：官方 ModuleLoader 惰性 CJS
// factory，**无 JSX、无构建**。布局参照 dsh-subusage 的设置页形态：页头 + 状态条 +
// 分区卡片（三入口说明 / 可选功能 / 初始工具名单 / 高级配置），全部走 `--dsw-alias-*`
// 设计令牌，深浅色自动适配。
//
// 取舍说明（此前这里有一条未经验证的推断，已删）：
//   共享 settings 包只提供 configForms / settingsSchema / describe 镜像这些**服务**，
//   本包**不含** schema→控件渲染器。本面板之所以自己渲染，是因为需求是
//   "列出当前真实存在的工具 + 复选框"；这**不**构成对宿主原生字段渲染"不可行"的判断。
//
// 为什么不外部 require：ModuleLoader 的 require 是**浏览器 CJS**，只认识注册过的
//   module id（官方形态见 dsh-client-ui-*：`require("@deepseek-ai/dsh-client-ui-slots")`）。
//   普通 ESM 相对路径（`./model.mjs`）不是 module id、没有 factory、无构建时拿不到。
//   故纯逻辑**内联**在本 factory 内，与 plugin/client/model.mjs 同构；
//   unit/client.test.mjs 在 vm 里跑这个 wrapper（只提供 React），并断言两处一致。
//
// 数据流（单向）：
//   装配点（唯一接触 ctx 的闭包）→ configForms.describe() 镜像 + configForms.get(entryId)
//     → **身份稳定**的派生 snapshot → <SettingsPanel {...派生 props} />
// 叶子组件只收 props，不读 ctx。
window.__ModuleLoader__.load({
  id: 'dsh-tool-discovery',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const { createElement: h, useState, useRef, useSyncExternalStore, useCallback } = React;

    // ---- 纯逻辑（与 plugin/client/model.mjs 同构） ----------------------------
    const FIXED_ENTRIES = ['tool_list', 'tool_search', 'tool_load'];

    function filterRows (rows, query) {
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (needle === '') return rows;
      return rows.filter((row) => row.name.toLowerCase().includes(needle));
    }

    function toggleName (selected, name) {
      const list = Array.isArray(selected) ? [...selected] : [];
      const at = list.indexOf(name);
      if (at === -1) list.push(name);
      else list.splice(at, 1);
      return list;
    }

    function isDefaultSelection (selected, defaults) {
      const a = new Set(Array.isArray(selected) ? selected : []);
      const b = new Set(Array.isArray(defaults) ? defaults : []);
      if (a.size !== b.size) return false;
      for (const name of a) if (!b.has(name)) return false;
      return true;
    }

    /**
     * 面板需要的元数据，形状由**接缝一次归一**，组件不必知道宿主 meta 的键名。
     * 服务端把活目录写在 `meta.initialToolChoices`（见 config.mjs 的
     * publishToolChoices），DSH 默认名单在 `meta.default`。
     * @param {any} node alwaysVisible 节点
     */
    function readMeta (node) {
      return {
        choices: Array.isArray(node?.meta?.initialToolChoices) ? node.meta.initialToolChoices : [],
        default: Array.isArray(node?.meta?.default) ? [...node.meta.default] : [],
        catalogComplete: node?.meta?.toolDirectory?.scope === 'application' && node.meta.toolDirectory.complete === true,
        constraints: node?.meta?.settingConstraints,
      };
    }

    /** @param {{choices?: readonly any[], default?: readonly string[]}} meta readMeta 的产物 */
    function buildRows (meta, selected) {
      const fixed = FIXED_ENTRIES;
      const available = new Set();
      for (const choice of meta?.choices ?? []) {
        if (typeof choice?.name === 'string' && !fixed.includes(choice.name)) available.add(choice.name);
      }
      const chosen = new Set();
      for (const name of selected ?? []) {
        if (typeof name === 'string' && name.length > 0) chosen.add(name);
      }
      const rows = [];
      for (const name of chosen) {
        if (fixed.includes(name)) continue;
        rows.push({ name, selected: true, available: available.has(name),
          status: available.has(name) ? 'registered' : meta?.catalogComplete === true ? 'unregistered' : 'unknown' });
      }
      // 目录里**尚未选中**的也必须成行 —— 否则用户无法添加任何第三方工具。
      for (const name of available) {
        if (chosen.has(name)) continue;
        rows.push({ name, selected: false, available: true, status: 'registered' });
      }
      rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return {
        fixed,
        rows,
        selectedCount: rows.filter((r) => r.selected).length,
        missingCount: rows.filter((r) => r.status === 'unregistered').length,
        unknownCount: rows.filter((r) => r.status === 'unknown').length,
      };
    }
    // ------------------------------------------------------------------------

    // 独立命名空间：不要占用 settings.plugins，那会与别的插件的字符串撞车。
    const NS = 'toolDiscovery.settings';
    // 主页挂顶层设置区。`settings.section` 是 list slot：必须给 id（SlotCore 会拒收
    // 无 id 的条目），label 由 settings-general 的 useSections 经 resolveSlotLabel 解析
    // 后按 order 排序渲染；组件收到 renderSlot 传入的 { close } 与 inject() 合并 props。
    const SLOT = 'settings.section';
    const SECTION_ID = 'tool-discovery';
    // configForms 命名空间 = cordis.patch.yml 的 `- id: tool-search`，与槽位 id 无关。
    const PLUGIN_TAB_ID = 'tool-search';

    const en = {
      nav: 'Tool discovery',
      hero: 'The first request no longer carries every tool’s full schema: the model picks capabilities through the three small entries below, and a selected tool’s real native schema arrives on the next turn, then runs through the host’s own approval and sandbox chain like any other tool.',
      entriesGroup: 'Three entries',
      entryListAnswer: 'Which tools are discoverable in this category?',
      entryListResult: 'Returns paginated full tool names',
      entrySearchAnswer: 'Which tool suits this task?',
      entrySearchResult: 'Returns top-K candidate cards (short purpose + ref/revision)',
      entryLoadAnswer: 'I want these tools.',
      entryLoadResult: 'Returns a versioned success receipt; the real schema is disclosed next turn',
      activeNo: 'Does not change the active set',
      activeYes: 'Changes the active set after a successful load',
      invariants: 'Two invariants bound the design: within one cache epoch the disclosed set only grows (the wire recorded at first disclosure never changes), and only a successful compaction resets the epoch — the model cannot unload, action "unload" is rejected. Disclosure is not execution permission: every call still passes the host’s own approval, sandbox, and permission chain.',
      statFixed: 'fixed entries',
      statCatalog: 'catalog tools',
      statSelected: 'initial list',
      statMissing: 'unregistered',
      statUnknown: 'unconfirmed',
      statNoMeta: 'catalog metadata unavailable',
      features: 'Optional features',
      initialTools: 'Inject initial tools',
      initialToolsHelp: 'Enabled by default. When disabled, configured initial tools are not injected automatically; tool_load can still load them. Takes effect in a new session or after successful compaction.',
      presetTools: 'Always allow tools specified by the preset',
      presetToolsHelp: 'On by default. Includes only the current bound preset’s registered tools, even when manual injection is off. Does not grant tools from other presets or bypass native permissions. Applies in a new session or after successful compaction.',
      strictEpoch: 'Require trusted epoch records (advanced)',
      strictEpochHelp: 'Off by default. Enabling reloads the plugin and requires durable epoch records. Existing main sessions without a record need a successful user /compact; subagent enforcement is off by default. Keep off for uninterrupted use; eligibility and protocol checks still apply.',
      childEpoch: 'Also require trusted epochs for subagents (advanced)',
      childEpochHelp: 'Off by default. Effective only when strict epoch verification is on. Subagents cannot perform user /compact, so enabling may block legacy child sessions. Changing this reloads the plugin; native ownership, not session labels, identifies children.',
      title: 'Manual initial tool list',
      intro: 'Lists application-wide registered tools, not session loading state. When manual injection is on, checked tools are advertised initially. Preset retention is controlled separately; registration does not guarantee permission in every session.',
      search: 'Filter tools',
      searchLabel: 'Filter tools by name',
      restore: 'Restore DSH default',
      empty: 'No tool matches the filter.',
      missing: 'not registered in the application catalog — uncheck to remove',
      unknown: 'global registration status not confirmed',
      fixed: 'Always present',
      fixedNote: 'The three discovery entries are always advertised and cannot be removed.',
      pending: 'Takes effect in the next new session, or after a successful compaction. The current session keeps the list it started with.',
      saved: 'Saved.',
      failed: 'Not saved — the host rejected the write. Retry.',
      tolerantLoad: 'Allow idempotent loading of initial tools',
      tolerantLoadHelp: 'On by default. Off rejects repeated loads of baseline tools. Changing this reloads the plugin.',
      exactList: 'Use an exact initial tool list (including DSH core tools)',
      exactListHelp: 'Off by default: when initial injection is enabled, registered core tools are also included. Turn on to require tool_load for unlisted core tools. Changing this reloads the plugin.',
      advanced: 'Advanced configuration',
      reload: 'These fields reload the plugin when saved; this may reset in-memory state and block existing sessions in strict mode.',
      locale: 'Model-facing language', auto: 'Follow interface', en: 'English', zh: 'Chinese',
      budgets: 'Budget overrides (JSON)',
      budgetsHelp: 'null disables overrides. Use an object of budget keys and positive integers or null for individual hard limits. Small limits can block normal tasks or add model round-trips; they do not guarantee lower token costs.',
      categoryConfig: 'Category navigation copy (JSON)',
      categoryConfigHelp: 'Use an object keyed by category, with title and capabilitySummary. An empty object uses localized defaults. Categories do not grant permissions.',
      framework: 'Trusted framework entries (read-only)',
      apply: 'Save', invalidJson: 'Enter a JSON object (or null for budget overrides).',
      invalidValue: 'Invalid configuration: check known keys, positive integer limits, or category title/capabilitySummary fields.',
      loading: 'Configuration is loading or unavailable.', readOnly: 'This configuration is read-only.', saving: 'Saving…',
    };
    const zh = {
      nav: '工具发现',
      hero: '首轮请求不再携带全部工具的完整 schema：模型通过下面三个小入口挑选能力，选中的工具在下一轮才拿到真实原生 schema，之后与普通工具一样走宿主原生的审批与沙箱链调用。',
      entriesGroup: '三个入口',
      entryListAnswer: '某类别里有哪些可发现工具？',
      entryListResult: '返回分页的完整工具名',
      entrySearchAnswer: '哪个工具适合当前任务？',
      entrySearchResult: '返回 Top-K 候选卡（短用途 + ref/revision）',
      entryLoadAnswer: '我要用哪些工具？',
      entryLoadResult: '返回版本化成功回执；下一轮披露真实 schema',
      activeNo: '不改变激活集合',
      activeYes: '成功 load 后改变激活集合',
      invariants: '两条不变量框住整个设计：一个缓存周期内已披露集合只增不改（首披露时记录的 wire 不再变化），只有一次成功的压缩才会重置周期——模型不能卸载，action "unload" 会被拒绝。披露不是执行许可：每次调用仍走宿主原生的审批、沙箱与权限链。',
      statFixed: '常驻入口',
      statCatalog: '目录工具',
      statSelected: '初始名单',
      statMissing: '未登记',
      statUnknown: '未确认',
      statNoMeta: '目录元数据不可用',
      features: '可选功能',
      initialTools: '自动注入初始工具',
      initialToolsHelp: '默认开启。关闭后不自动注入下方配置的工具，仍可通过 tool_load 加载。在新会话或成功压缩后生效。',
      presetTools: '永远放行 preset 规定的工具',
      presetToolsHelp: '默认开启。保留当前会话实际绑定 preset 登记的工具，即使关闭手动初始注入；不会放行其它 preset 的工具或绕过原生权限。在新会话或成功压缩后采用。',
      strictEpoch: '强制可信周期校验（高级）',
      strictEpochHelp: '默认关闭。开启会重新加载插件并要求持久化可信周期记录；没有记录的存量主会话需要成功执行用户 /compact；默认不对子代理强制校验。希望不中断使用时请保持关闭；工具资格和协议校验仍然有效。',
      childEpoch: '对子代理强制可信周期校验（高级）',
      childEpochHelp: '默认关闭，仅在强制可信周期校验开启时生效。子代理不能自行执行用户 /compact，开启可能阻断旧子会话；切换会重新加载插件。身份按宿主运行时父子所有权判断，不信会话自称。',
      title: '手动初始工具名单',
      intro: '以下是应用全局登记目录，不是会话加载状态。开启手动初始注入后，勾选工具会直接披露；preset 保留由独立开关控制。全局已登记不代表每个会话都具有执行权限。',
      search: '筛选工具',
      searchLabel: '按名称筛选工具',
      restore: '恢复 DSH 默认',
      empty: '没有匹配的工具。',
      missing: '未在应用全局目录登记（取消勾选可移除）',
      unknown: '全局登记状态尚未确认',
      fixed: '始终存在',
      fixedNote: '三个发现入口始终披露，不可删除。',
      pending: '改动在下一个新会话、或一次成功压缩之后生效；当前会话保持它开始时的名单。',
      saved: '已保存。',
      failed: '未保存——宿主拒绝了这次写入，可重试。',
      tolerantLoad: '容忍重复加载初始工具',
      tolerantLoadHelp: '默认开启，重复加载常驻工具保持幂等；关闭后拒绝此类重复加载。修改会重新加载插件。',
      exactList: '使用精确初始名单（含 DSH 核心工具）',
      exactListHelp: '默认关闭：初始注入开启时还会加入已登记的核心工具。开启后，名单外的核心工具也需 tool_load。修改会重新加载插件。',
      advanced: '高级配置',
      reload: '保存这些字段会重新加载插件，可能重置内存状态；严格模式下可能阻断存量会话。',
      locale: '模型可见文案语言', auto: '跟随界面', en: '英语', zh: '中文',
      budgets: '预算覆盖（JSON）',
      budgetsHelp: 'null 表示不覆盖。对象可填写预算键与正整数，单项硬限额可用 null 关闭。较小上限可能阻断正常任务或增加模型往返，不保证降低 token 成本。',
      categoryConfig: '类别导航文案（JSON）',
      categoryConfigHelp: '以类别为键，填写 title 与 capabilitySummary；空对象使用本地化默认值。类别不授予权限。',
      framework: '可信框架保留项（只读）',
      apply: '保存', invalidJson: '请输入 JSON 对象（预算覆盖也可为 null）。',
      invalidValue: '配置无效：请检查支持的键、正整数上限、或类别的 title/capabilitySummary 字段。',
      loading: '配置正在加载或暂不可用。', readOnly: '当前配置为只读。', saving: '正在保存…',
    };

    /** 从 describe 镜像里取出本插件这一行。 */
    function ownView (mirrorSnapshot) {
      const view = mirrorSnapshot?.view;
      if (view === undefined) return undefined;
      return view.namespaces.find((row) => row.ns === PLUGIN_TAB_ID);
    }

    /**
     * 重投影宿主发来的 schema 信封，取出 `alwaysVisible` 节点。
     * describe() 原样发出 `schema.toJSON()` 的整棵树（dsh-settings lib/index.js
     * :421-435、:444），活目录（meta.initialToolChoices）与 DSH 默认名单
     * （meta.default）都在这棵树上 —— 不必另开 RPC、广播或只读配置字段。
     */
    function alwaysVisibleNode (view, schemaService) {
      if (view === undefined || typeof schemaService?.rehydrate !== 'function') return undefined;
      try {
        return schemaService.rehydrate(view.schema)?.dict?.alwaysVisible;
      } catch {
        return undefined;
      }
    }

    /** mutate 抛错时的记录：呈现给用户，绝不吞成未处理拒绝。 */
    function logSaveFailure (reason) {
      try {
        console.error('[dsh-tool-discovery] initial tools write failed:', reason);
      } catch { /* 记录失败不影响 UI 呈现 */ }
    }

    function featureChoices(value) {
      return [
        ['initialToolsEnabled', 'initialTools', 'initialToolsHelp', value?.initialToolsEnabled !== false],
        ['alwaysAllowPresetTools', 'presetTools', 'presetToolsHelp', value?.alwaysAllowPresetTools !== false],
        ['requireTrustedEpoch', 'strictEpoch', 'strictEpochHelp', value?.requireTrustedEpoch === true],
        ['requireTrustedEpochForSubagents', 'childEpoch', 'childEpochHelp', value?.requireTrustedEpochForSubagents === true],
        ['tolerantLoadProtected', 'tolerantLoad', 'tolerantLoadHelp', value?.tolerantLoadProtected !== false],
        ['respectAlwaysVisible', 'exactList', 'exactListHelp', value?.respectAlwaysVisible === true],
      ];
    }

    const BOOLEAN_SETTINGS = featureChoices({}).map(([key]) => key);
    function saveSetting(form, key, value) {
      if (![...BOOLEAN_SETTINGS, 'alwaysVisible', 'locale', 'budgets', 'categoryConfig'].includes(key)) return Promise.resolve(false);
      return form.mutate([{ op: 'set', path: [key], value }]);
    }

    function validAdvancedSetting(key, value, constraints) {
      if (key === 'locale') return typeof value === 'string' && ['auto', 'en', 'zh'].includes(value);
      if (key === 'budgets' && value === null) return true;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      if (key === 'budgets') {
        if (!Array.isArray(constraints?.budgetKeys)) return false;
        return Object.entries(value).every(([name, limit]) => constraints.budgetKeys.includes(name)
          && ((limit === null && constraints.optionalLimitKeys?.includes(name))
            || (typeof limit === 'number' && Number.isInteger(limit) && limit > 0)));
      }
      if (key === 'categoryConfig') {
        if (!Array.isArray(constraints?.categoryKeys)) return false;
        return Object.entries(value).every(([name, card]) => constraints.categoryKeys.includes(name)
          && card !== null && typeof card === 'object' && !Array.isArray(card)
          && typeof card.title === 'string' && typeof card.capabilitySummary === 'string');
      }
      return false;
    }

    // 草稿与服务端已保存值分离；修订变化时重建编辑器，避免恢复默认/外部更新留下旧草稿。
    function JsonSetting ({ t, name, value, disabled, keys, onSave }) {
      const [draft, setDraft] = useState(JSON.stringify(value, null, 2));
      const [error, setError] = useState(null);
      const submit = () => {
        let parsed;
        try {
          parsed = JSON.parse(draft);
          if ((parsed === null && name !== 'budgets') || (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed)))) throw new Error('shape');
        } catch {
          setError(t('invalidJson'));
          return;
        }
        setError(null);
        onSave(name, parsed);
      };
      return h('section', null,
        h('label', { htmlFor: `tool-discovery-${name}` }, t(name)),
        h('p', { style: { fontSize: '12px' } }, t(`${name}Help`)),
        h('code', { style: { display: 'block', fontSize: '11px', overflowWrap: 'anywhere' } }, (keys ?? []).join(', ')),
        h('textarea', { id: `tool-discovery-${name}`, rows: 6, value: draft, disabled,
          style: { width: '100%', boxSizing: 'border-box', fontFamily: 'monospace' },
          onChange: event => setDraft(event.target.value) }),
        h('button', { type: 'button', disabled, onClick: submit }, t('apply')),
        error ? h('p', { role: 'alert' }, error) : null);
    }

    // ---- 设计令牌（--dsw-alias-* 均带兜底值；跟随宿主深浅色主题） ------------------
    const S = {
      section: { maxWidth: '720px', display: 'flex', flexDirection: 'column', gap: '16px', color: 'var(--dsw-alias-label-primary, inherit)' },
      title: { margin: 0, fontSize: '18px', fontWeight: '600' },
      hero: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, inherit)' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      chip: { height: '22px', lineHeight: '22px', padding: '0 10px', fontSize: '12px', borderRadius: '999px', background: 'var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.15))', color: 'var(--dsw-alias-label-secondary, inherit)', whiteSpace: 'nowrap' },
      groupHead: { margin: 0, fontSize: '12px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary, inherit)' },
      cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' },
      card: { border: '.5px solid var(--dsw-alias-settings-card-stroke, rgba(128,128,128,.25))', borderRadius: 'var(--dsw-radius-xl, 14px)', background: 'var(--dsw-alias-settings-card-fill, transparent)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' },
      cardTitle: { fontSize: '13px', fontWeight: '600' },
      cardText: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, inherit)' },
      cardMeta: { margin: 0, fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, inherit)' },
      badge: (on) => ({ alignSelf: 'flex-start', fontSize: '11px', lineHeight: '16px', padding: '1px 8px', borderRadius: '999px', background: on ? 'var(--dsw-alias-state-business-primary, rgba(64,120,255,.18))' : 'var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.15))', color: on ? 'var(--dsw-alias-state-business-primary, inherit)' : 'var(--dsw-alias-label-tertiary, inherit)' }),
      note: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, inherit)' },
    };

    /** 叶子组件：只收 props，不读 ctx。 */
    function SettingsPanel ({ t, snapshot, error, notice, busy, onToggle, onRestore, onFeature, onSetting }) {
      const [query, setQuery] = useState('');
      const disabled = busy === true || snapshot?.status !== 'ready' || snapshot?.writable === false;
      const locale = snapshot?.value?.locale ?? 'auto';
      const selected = Array.isArray(snapshot?.value?.alwaysVisible) ? snapshot.value.alwaysVisible : [];
      const built = buildRows(snapshot?.meta, selected);
      const visible = filterRows(built.rows, query);

      return h('div', { style: S.section },
        h('h2', { style: S.title }, t('nav')),
        h('p', { style: S.hero }, t('hero')),
        h('div', { style: S.chips },
          h('span', { style: S.chip }, `${t('statFixed')}: ${built.fixed.length}`),
          h('span', { style: S.chip }, `${t('statCatalog')}: ${built.rows.length}`),
          h('span', { style: S.chip }, `${t('statSelected')}: ${built.selectedCount}`),
          built.missingCount > 0 ? h('span', { style: S.chip }, `${t('statMissing')}: ${built.missingCount}`) : null,
          built.unknownCount > 0 ? h('span', { style: S.chip }, `${t('statUnknown')}: ${built.unknownCount}`) : null,
          snapshot?.metaAvailable === false ? h('span', { style: S.chip }, t('statNoMeta')) : null),
        snapshot?.status !== 'ready' ? h('p', { role: 'status', style: S.note }, t('loading')) : null,
        snapshot?.writable === false ? h('p', { role: 'status', style: S.note }, t('readOnly')) : null,
        busy ? h('p', { role: 'status', style: S.note }, t('saving')) : null,
        h('h3', { style: S.groupHead }, t('entriesGroup')),
        h('div', { style: S.cards },
          ...[['tool_list', 'entryListAnswer', 'entryListResult', false],
            ['tool_search', 'entrySearchAnswer', 'entrySearchResult', false],
            ['tool_load', 'entryLoadAnswer', 'entryLoadResult', true]].map(([name, answer, result, activates]) =>
            h('div', { key: name, style: S.card },
              h('code', { style: S.cardTitle }, name),
              h('p', { style: S.cardText }, t(answer)),
              h('p', { style: S.cardMeta }, t(result)),
              h('span', { style: S.badge(activates) }, t(activates ? 'activeYes' : 'activeNo'))))),
        h('p', { style: S.note }, t('invariants')),
        h('h3', { style: S.groupHead }, t('features')),
        ...featureChoices(snapshot?.value).map(([key, label, help, checked]) => h('section', { key },
          h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', {
              type: 'checkbox', checked, id: `tool-discovery-${key}`,
              'aria-describedby': `tool-discovery-${key}-help`,
              disabled,
              onChange: (event) => onFeature(key, event.target.checked),
            }), t(label)),
          h('p', { id: `tool-discovery-${key}-help`, style: { margin: '4px 0', fontSize: '12px' } }, t(help)))),
        h('h3', { style: S.groupHead }, t('title')),
        h('p', { style: S.note }, t('intro')),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', {
            type: 'search',
            'aria-label': t('searchLabel'),
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', {
            type: 'button', disabled: disabled || snapshot?.metaAvailable === false,
            onClick: () => { setQuery(''); onRestore(selected); },
          }, t('restore'))),

        h('div', { style: { fontSize: '12px' } },
          h('strong', null, `${t('fixed')}: `),
          built.fixed.join(', '),
          h('div', null, t('fixedNote'))),

        visible.length === 0
          ? h('p', { style: { fontSize: '13px' } }, t('empty'))
          : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' } },
            visible.map((row) => h('li', { key: row.name, style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                type: 'checkbox',
                id: `initial-tool-${row.name}`,
                checked: row.selected, disabled,
                onChange: () => onToggle(selected, row.name),
              }),
              h('label', { htmlFor: `initial-tool-${row.name}`, style: { fontSize: '13px' } },
                row.name,
                row.status === 'registered' ? null : h('span', { style: { marginLeft: '8px', fontSize: '11px' } }, `(${t(row.status === 'unknown' ? 'unknown' : 'missing')})`)),
            ))),

        h('p', { style: S.note }, t('pending')),
        h('details', null,
          h('summary', { style: S.groupHead }, t('advanced')),
          h('p', { style: S.note }, t('reload')),
          h('label', { htmlFor: 'tool-discovery-locale' }, t('locale')),
          h('select', { id: 'tool-discovery-locale', value: locale, disabled,
            onChange: event => onSetting('locale', event.target.value) },
            ...[...new Set(['auto', 'en', 'zh', locale])].map(value => h('option', { key: value, value }, ['auto', 'en', 'zh'].includes(value) ? t(value) : value))),
          ...['budgets', 'categoryConfig'].map(name => h(JsonSetting, {
            key: `${name}:${JSON.stringify(snapshot?.value?.[name])}`,
            t, name, value: snapshot?.value?.[name] ?? (name === 'budgets' ? null : {}),
            disabled: disabled || !snapshot?.meta?.constraints,
            keys: snapshot?.meta?.constraints?.[name === 'budgets' ? 'budgetKeys' : 'categoryKeys'], onSave: onSetting,
          })),
          h('p', { style: S.note }, `${t('framework')}: ${(snapshot?.value?.frameworkRetained ?? []).join(', ') || '—'}`)),
        error ? h('p', { role: 'alert', style: S.note }, error) : null,
        notice ? h('p', { role: 'status', style: S.note }, notice) : null)
    }

    /**
     * 快照源：订阅 + **身份稳定**的 getSnapshot。
     *
     * 身份必须稳定：useSyncExternalStore 渲染后会比对新旧快照，每次返回新对象
     * 会无限重渲染。这里按 (mirrorSnapshot, formSnapshot) 两个**引用**缓存派生
     * 结果 —— 只有上游真正换了快照引用才产出新对象。
     */
    function createSnapshotSource (ctx) {
      const mirror = ctx.configForms.describe();
      const form = ctx.configForms.get(PLUGIN_TAB_ID);
      const schemaService = ctx.settingsSchema;
      let cachedSources = null;
      let cachedSnapshot = null;

      function derive (mirrorSnapshot, formSnapshot) {
        if (cachedSources !== null
          && cachedSources.mirror === mirrorSnapshot
          && cachedSources.form === formSnapshot) {
          return cachedSnapshot;
        }
        const node = alwaysVisibleNode(ownView(mirrorSnapshot), schemaService);
        const meta = readMeta(node);
        cachedSources = { mirror: mirrorSnapshot, form: formSnapshot };
        cachedSnapshot = {
          // 形状已由 readMeta 归一：活目录 meta.choices、DSH 默认名单 meta.default。
          meta,
          // 别名：组件里读起来直白，也免得再有人在 meta.choices / meta.default
          // 之间猜宿主键名。
          choices: meta.choices,
          defaults: meta.default,
          metaAvailable: node !== undefined,
          value: { ...formSnapshot.value, alwaysVisible: Array.isArray(formSnapshot.value?.alwaysVisible)
            ? formSnapshot.value.alwaysVisible : [...meta.default] },
          revision: formSnapshot.revision,
          status: formSnapshot.status,
          writable: formSnapshot.writable,
        };
        return cachedSnapshot;
      }

      return {
        mirror,
        form,
        subscribe: (listener) => {
          const offMirror = mirror.subscribe(listener);
          const offForm = form.subscribe(listener);
          return () => { offMirror(); offForm(); };
        },
        getSnapshot: () => derive(mirror.getSnapshot(), form.getSnapshot()),
      };
    }

    /**
     * 装配点：唯一接触 ctx 的地方。ctx 服务在**组件函数之外**读一次并固定下来。
     */
    function createTabRoot (ctx, t) {
      const source = createSnapshotSource(ctx);
      const { subscribe, getSnapshot, form } = source;

      return function SettingsTabRoot () {
        const [error, setError] = useState(null);
        const [notice, setNotice] = useState(null);
        const [busy, setBusy] = useState(false);
        const writing = useRef(false);
        const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

        /** 一次写入：false 或抛错都是"没被宿主接受"，必须显式呈现。 */
        const write = useCallback(async (value, key = 'alwaysVisible') => {
          const current = getSnapshot();
          if (writing.current || current.status !== 'ready' || current.writable === false) return false;
          writing.current = true;
          setBusy(true);
          setError(null);
          setNotice(null);
          let ok = false;
          try {
            ok = await saveSetting(form, key, value);
          } catch (reason) {
            logSaveFailure(reason);
          } finally {
            writing.current = false;
            setBusy(false);
          }
          if (ok) setNotice(t('saved'));
          else setError(t('failed'));
          return ok;
        }, []);

        const onToggle = useCallback((_current, name) => {
          if (FIXED_ENTRIES.includes(name)) return false;
          return write(toggleName(getSnapshot().value.alwaysVisible, name));
        }, []);
        const onRestore = useCallback(() => {
          const current = getSnapshot();
          if (!current.metaAvailable || isDefaultSelection(current.value.alwaysVisible, current.defaults)) return false;
          return write([...current.defaults]);
        }, []);

        const onFeature = useCallback((key, enabled) => {
          if (!BOOLEAN_SETTINGS.includes(key) || typeof enabled !== 'boolean') return false;
          return write(enabled, key);
        }, []);
        const onSetting = useCallback((key, value) => {
          if (!validAdvancedSetting(key, value, getSnapshot().meta.constraints)) {
            setNotice(null);
            setError(t('invalidValue'));
            return false;
          }
          return write(value, key);
        }, []);
        return h(SettingsPanel, { t, snapshot, error, notice, busy, onToggle, onRestore, onFeature, onSetting });
      };
    }

    const inject = ['slots', 'locale', 'configForms', 'settingsSchema'];

    function apply (ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tool-discovery: settings dictionaries');
      const Root = createTabRoot(ctx, t);
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: SECTION_ID,
        order: 24,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({}),
      }, Root));
    }

    // 供 vm 内测试取用（不参与渲染）：纯逻辑 + 接缝 + 装配点。
    exports.__test = {
      buildRows, filterRows, toggleName, isDefaultSelection, featureChoices, saveSetting, validAdvancedSetting,
      ownView, alwaysVisibleNode, readMeta, createTabRoot, createSnapshotSource, SettingsPanel,
      FIXED_ENTRIES, NS, PLUGIN_TAB_ID, SECTION_ID, SLOT,
    };

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

// sourceMappingURL=client.js.map
