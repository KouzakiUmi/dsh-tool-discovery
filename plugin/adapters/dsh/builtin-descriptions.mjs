// Native-only display policy. Source identity and displayed identity stay distinct.
import { digestOf } from '../../domain/canonical.mjs';
import { BUILTIN_DESCRIPTION_RULES } from './builtin-descriptions-data.mjs';
import { V2_ADDITIONAL_DESCRIPTION_RULES } from './builtin-descriptions-v2.mjs';
import { wireOfSchema } from './registry.mjs';
import { LEGACY_DESCRIPTION_TOOLS, selectedDescriptionTools, encodeDescriptionTools, decodeDescriptionTools } from './builtin-description-options.mjs';

export const BUILTIN_DESCRIPTION_REVISION = 'v2';
const MARKER = /\n\[dsh-tool-discovery:builtin-descriptions:(v\d+):(en|zh)(?::([0-9a-f]+))?\]$/;
const allRules = [...BUILTIN_DESCRIPTION_RULES, ...V2_ADDITIONAL_DESCRIPTION_RULES];
const indexRules = list => new Map(list.flatMap(rule => rule.sourceDigests.map(digest => [digest, rule])));
const ruleSets = { v1: indexRules(BUILTIN_DESCRIPTION_RULES), v2: indexRules(allRules) };

export function descriptionPolicyMarker(locale, selected = LEGACY_DESCRIPTION_TOOLS, revision = BUILTIN_DESCRIPTION_REVISION) {
  const language = locale === 'zh' ? 'zh' : 'en';
  if (revision === 'v1') return `\n[dsh-tool-discovery:builtin-descriptions:v1:${language}]`;
  if (revision !== BUILTIN_DESCRIPTION_REVISION) throw new TypeError('Unknown builtin description revision.');
  return `\n[dsh-tool-discovery:builtin-descriptions:v2:${language}:${encodeDescriptionTools(selected)}]`;
}

/** A session snapshot, changed only at new-session/successful-compaction boundaries. */
export function createBuiltinDescriptionPolicy({ enabled = false, locale = 'en', overrides, log = () => {} } = {}) {
  let active;
  let language;
  let revision;
  let selected;
  const reported = new Set();
  function adopt(nextEnabled, nextLocale, nextRevision, tools) {
    active = nextEnabled === true;
    language = nextLocale === 'zh' ? 'zh' : 'en';
    revision = nextRevision;
    selected = new Set(tools);
    reported.clear();
  }
  function reset(nextEnabled, nextLocale = locale, nextOverrides) {
    adopt(nextEnabled, nextLocale, BUILTIN_DESCRIPTION_REVISION, selectedDescriptionTools(nextOverrides));
  }
  reset(enabled, locale, overrides);

  function project(wire) {
    if (!active || !wire || !selected.has(wire.name)) return wire;
    const fingerprint = digestOf(wireOfSchema(wire));
    const rule = ruleSets[revision].get(fingerprint);
    if (!rule || rule.name !== wire.name) {
      if (!reported.has(fingerprint)) {
        reported.add(fingerprint);
        log('descriptions:skipped', { name: wire.name, reason: 'unrecognized-source' });
      }
      return wire;
    }
    if (!reported.has(fingerprint)) {
      reported.add(fingerprint);
      log('descriptions:matched', { name: wire.name, revision });
    }
    return { ...wire, description: rule[language] };
  }
  return {
    reset,
    project,
    status: () => ({ enabled: active, revision: active ? revision : null, locale: language, tools: active ? [...selected] : [] }),
    // Only own current-epoch headers arrive here, before receipt replay. This
    // is presentation evidence, never tool eligibility or authorization.
    restore(events) {
      const headers = events.filter(event => event.type === 'request/header');
      if (headers.length === 0) return;
      const control = headers.flatMap(event => event.data?.header?.tools ?? []).find(wire => wire?.name === 'tool_load');
      const match = typeof control?.description === 'string' ? MARKER.exec(control.description) : null;
      if (match?.[1] === 'v1' && match[3] === undefined) {
        adopt(true, match[2], 'v1', LEGACY_DESCRIPTION_TOOLS);
        return;
      }
      const tools = match?.[1] === 'v2' ? decodeDescriptionTools(match[3]) : null;
      if (tools !== null) {
        adopt(true, match[2], 'v2', tools);
        return;
      }
      adopt(false, language, BUILTIN_DESCRIPTION_REVISION, []);
      if (match) log('descriptions:skipped', { name: 'tool_load', reason: 'unknown-or-invalid-policy' });
    },
    bindings(bindings) {
      if (!active) return bindings;
      return bindings.map(binding => {
        const wire = project(binding.wire);
        if (wire === binding.wire) return binding;
        return { ...binding, wire,
          // Do not collapse different source definitions behind the same short text.
          // Full original search text is preserved; only display wire is replaced.
          bindingGeneration: `${binding.bindingGeneration ?? ''}|source:${digestOf(binding.wire)}`,
        };
      });
    },
    control(wire) {
      if (!active || !wire || wire.name !== 'tool_load') return wire;
      const suffix = descriptionPolicyMarker(language, selected, revision);
      if (typeof wire.description === 'string' && wire.description.endsWith(suffix)) return wire;
      return { ...wire, description: `${wire.description}${suffix}` };
    },
  };
}
