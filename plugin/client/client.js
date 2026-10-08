// plugin/client/client.js
// 设置面板（浏览器半边）：官方 ModuleLoader 惰性 CJS factory，**无 JSX、无构建**。
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
    const { createElement: h, useState, useSyncExternalStore, useCallback } = React;

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
      };
    }

    /** @param {{choices?: readonly any[], default?: readonly string[]}} meta readMeta 的产物 */
    function buildRows (meta, selected) {
      const fixed = FIXED_ENTRIES;
      const available = new Set();
      for (const choice of meta?.choices ?? []) {
        if (typeof choice?.name === 'string') available.add(choice.name);
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
    const SLOT = 'settings.plugins.tab';
    const PLUGIN_TAB_ID = 'tool-search';

    const en = {
      nav: 'Tool discovery',
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
    };
    const zh = {
      nav: '工具发现',
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
      ];
    }

    function saveSetting(form, key, value) {
      if (!['alwaysVisible', 'initialToolsEnabled', 'alwaysAllowPresetTools', 'requireTrustedEpoch', 'requireTrustedEpochForSubagents'].includes(key)) return Promise.resolve(false);
      return form.mutate([{ op: 'set', path: [key], value }]);
    }

    /** 叶子组件：只收 props，不读 ctx。 */
    function SettingsPanel ({ t, snapshot, error, notice, onToggle, onRestore, onFeature }) {
      const [query, setQuery] = useState('');
      const selected = Array.isArray(snapshot?.value?.alwaysVisible) ? snapshot.value.alwaysVisible : [];
      const built = buildRows(snapshot?.meta, selected);
      const visible = filterRows(built.rows, query);

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('h3', null, t('features')),
        ...featureChoices(snapshot?.value).map(([key, label, help, checked]) => h('section', { key },
          h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', {
              type: 'checkbox', checked,
              'aria-describedby': `tool-discovery-${key}-help`,
              disabled: snapshot?.status !== 'ready' || snapshot?.writable === false,
              onChange: (event) => onFeature(key, event.target.checked),
            }), t(label)),
          h('p', { id: `tool-discovery-${key}-help`, style: { margin: '4px 0', fontSize: '12px' } }, t(help)))),
        h('h3', { style: { margin: 0, fontSize: '15px', fontWeight: '600' } }, t('title')),
        h('p', { style: { margin: 0, fontSize: '13px' } }, t('intro')),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', {
            type: 'search',
            'aria-label': t('searchLabel'),
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', {
            type: 'button',
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
                checked: row.selected,
                onChange: () => onToggle(selected, row.name),
              }),
              h('label', { htmlFor: `initial-tool-${row.name}`, style: { fontSize: '13px' } },
                row.name,
                row.status === 'registered' ? null : h('span', { style: { marginLeft: '8px', fontSize: '11px' } }, `(${t(row.status === 'unknown' ? 'unknown' : 'missing')})`)),
            ))),

        h('p', { style: { fontSize: '12px', margin: 0 } }, t('pending')),
        error ? h('p', { role: 'alert', style: { fontSize: '12px', margin: 0 } }, error) : null,
        notice ? h('p', { style: { fontSize: '12px', margin: 0 } }, notice) : null)
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
          value: formSnapshot.value,
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
        const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

        /** 一次写入：false 或抛错都是"没被宿主接受"，必须显式呈现。 */
        const write = useCallback(async (value, key = 'alwaysVisible') => {
          setError(null);
          let ok = false;
          try {
            ok = await saveSetting(form, key, value);
          } catch (reason) {
            logSaveFailure(reason);
            ok = false;
          }
          if (ok) setNotice(t('saved'));
          else { setNotice(null); setError(t('failed')); }
          return ok;
        }, []);

        const onToggle = useCallback((current, name) => write(toggleName(current, name)), [snapshot]);
        const onRestore = useCallback(
          (current) => write(isDefaultSelection(current, snapshot.defaults) ? [...current] : [...snapshot.defaults]),
          [snapshot],
        );

        const onFeature = useCallback((key, enabled) => {
          if (!['initialToolsEnabled', 'alwaysAllowPresetTools', 'requireTrustedEpoch', 'requireTrustedEpochForSubagents'].includes(key) || typeof enabled !== 'boolean') return false;
          return write(enabled, key);
        }, []);
        return h(SettingsPanel, { t, snapshot, error, notice, onToggle, onRestore, onFeature });
      };
    }

    const inject = ['slots', 'locale', 'configForms', 'settingsSchema'];

    function apply (ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tool-discovery: settings dictionaries');
      const Root = createTabRoot(ctx, t);
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: PLUGIN_TAB_ID,
        order: 20,
        label: () => t('nav'),
      }, Root));
    }

    // 供 vm 内测试取用（不参与渲染）：纯逻辑 + 接缝 + 装配点。
    exports.__test = {
      buildRows, filterRows, toggleName, isDefaultSelection, featureChoices, saveSetting,
      ownView, alwaysVisibleNode, readMeta, createTabRoot, createSnapshotSource, SettingsPanel,
      FIXED_ENTRIES, NS, PLUGIN_TAB_ID, SLOT,
    };

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

// sourceMappingURL=client.js.map
