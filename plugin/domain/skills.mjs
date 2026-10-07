// progressive-v2/domain/skills.mjs
// 可信工具技能:只补使用指导与边界,不重复 schema。
// 技能载荷若复述 schema(parameters/schema/description/examples)即拒绝,避免双份累积。
import { utf8Bytes } from './canonical.mjs';
import { DomainError } from './errors.mjs';
import { isPlainObject } from './util.mjs';

// --- i18n shim (added by the message migration) ---------------------------
// These validators are pure and take no locale argument. The plugin resolves
// one locale per activation, so bind the text accessor once here rather than
// threading it through every signature. setLocaleForDomain() is called by the
// adapter at activation; tests call it directly to exercise both languages.
import { domainText } from './locale.mjs';
const text = domainText;
const t = (path) => text.t(path);


const FORBIDDEN_SKILL_KEYS = Object.freeze(['parameters', 'schema', 'description', 'examples']);

/**
 * 校验技能载荷:不得复述 schema,字段须与条目版本对齐。
 * @param {import('./catalog.mjs').CatalogEntry} entry
 */
export function validateSkill(entry) {
  const s = entry.skill;
  if (!s) return;
  for (const k of Object.keys(s)) {
    if (FORBIDDEN_SKILL_KEYS.includes(k)) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `技能载荷包含禁止字段: ${k}`);
    }
  }
  if (s.skillRevision !== entry.skillRevision) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'skillVersionMismatch']));
  }
}

/**
 * 投影可序列化的技能卡片(不含 schema / nativeSchema)。
 * @param {import('./catalog.mjs').CatalogEntry} entry
 * @returns {{toolId:string, skillRevision:string, usage:string, limitations:string[]}|null}
 */
export function projectSkill(entry) {
  validateSkill(entry);
  if (!entry.skill) return null;
  return {
    toolId: entry.toolId,
    skillRevision: entry.skill.skillRevision,
    usage: entry.skill.usage,
    limitations: entry.skill.limitations.slice(),
  };
}

/**
 * 一次 load 的技能总字节。
 * @param {Array<{toolId:string, skillRevision:string, usage:string, limitations:string[]}|null>} skills
 */
export function skillBytes(skills) {
  let total = 0;
  for (const s of skills) {
    if (!s) continue;
    total += utf8Bytes(JSON.stringify(s));
  }
  return total;
}

/**
 * 校验一次 load 的技能总字节上限(超限 → BUDGET_EXCEEDED,不截断技能正文)。
 * `maxSkillBytes` 为 null = 上限默认关闭，不做任何判定。
 * @param {Array<object|null>} skills
 * @param {number|null} maxSkillBytes
 */
export function assertSkillBudget(skills, maxSkillBytes) {
  const bytes = skillBytes(skills);
  if (maxSkillBytes !== null && bytes > maxSkillBytes) {
    throw new DomainError('BUDGET_EXCEEDED', t(['detail', 'skillResponseOverBudget']), { bytes, maxSkillBytes });
  }
  return bytes;
}

/** 供测试:技能载荷是否为 plain object。 */
export { isPlainObject };
