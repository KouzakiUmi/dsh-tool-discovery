#!/usr/bin/env node
// 质量工装：把查询集中的标注裁定冻结为 labels 文件。
// 这是数据工装，不是产品代码：它不 import 任何产品模块，也不参与运行时。
//
// 用法：
//   node plugin/quality/tools/freeze-labels.mjs           # 仅创建尚不存在的 labels 文件
//   node plugin/quality/tools/freeze-labels.mjs --json    # 同上，机器可读输出
//
// 不可用且刻意不提供的绕过方式：
//   --force / 任何覆盖既有冻结文件的开关：一律拒绝。没有环境变量或隐藏参数可以绕过。
//   修改冻结评分输入（query / category / expectedNames / negative / labelRationale）只能通过
//   显式新版本 + 新冻结，并由独立于作者的人签发标签语义；本工装不代劳这一步。
//
// 冻结语义与其边界：
//   - labels/*.json 与 queries/*.json 是同一份标注的两个副本，不是相互独立的真源。
//     digest 只证明两份文件逐字节一致，不证明标签语义正确，也不证明标注来源独立。
//   - 本工装不修改 reports/quality-plan.md 的 digest 锚点。锚点的更新是另一件需要显式评审的事，
//     不得用它来掩盖冻结输入的变化。
//   - held-out 冻结文件已存在时拒绝，且拒绝发生在任何写盘动作之前。
//   - labels.train.json 未冻结，可按设计覆盖；这不构成对冻结文件的绕过，但调参目标若是冻结文件的
//     符号链接/硬链接别名，本工装拒绝写入。
//
// 排他性保证（这是安全性质的真正来源）：
//   - 冻结文件用 open(wx) 语义创建，即 O_CREAT|O_EXCL|O_WRONLY。内核保证"创建"与"检查目标不存在"
//     是同一个原子动作：目标已被创建（包括在本工装检查之后、提交之前被并发创建）时，创建失败并返回
//     EEXIST，本工装映射为 FROZEN_EXISTS，并且此时调参集还没有被写入。
//   - planFreeze 里的 existsSync 只是提前给出可读拒绝的快路径，是**咨询性**的，不是安全保证。
//     任何"先 existsSync 再普通 writeFileSync"的写法都不构成排他保证，rename 同样不行（rename 覆盖）。
//   - 本工装不声称能抵抗具备任意写权限的恶意进程：它只保证自己的写入路径不覆盖已存在的冻结文件。

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const LABELS_PROVENANCE = 'agent-authored-synthetic-labels';
export const LABELS_OWNER_NOTE =
  '标注由 quality worker（AI 代理）编写的合成标注并冻结，不代表人类专家审核，也不来自用户需求调研。'
  + 'domain/调参 worker 不得修改本文件，不得以调参为由重算 digest。';
export const DIGEST_SCOPE_NOTE =
  'digest 只覆盖 canonical JSON 的字节一致性；它不证明标签语义正确，也不证明标注来源独立于 queries。';
export const SCORING_DIGEST_INPUT =
  'canonical-json of {queryTexts(queryId,query,category,language,band,tags), labels(queryId,expectedNames,negative,labelRationale)}';

export const REFUSAL_CODES = {
  FORCE_UNSUPPORTED: 'FORCE_UNSUPPORTED',
  UNKNOWN_ARGUMENT: 'UNKNOWN_ARGUMENT',
  FROZEN_EXISTS: 'FROZEN_EXISTS',
  TRAIN_ALIASES_FROZEN: 'TRAIN_ALIASES_FROZEN',
  FROZEN_WRITE_FAILED: 'FROZEN_WRITE_FAILED',
  TRAINING_WRITE_FAILED: 'TRAINING_WRITE_FAILED',
  QUERIES_MISSING: 'QUERIES_MISSING',
  QUERIES_INVALID: 'QUERIES_INVALID',
  INVALID_CLOCK: 'INVALID_CLOCK'
};

const ALLOWED_ARGS = new Set(['--json']);
const REQUIRED_QUERY_FIELDS = ['queryId', 'expectedNames', 'negative', 'labelRationale'];

/** 拒绝不是异常路径上的意外：它带稳定 code，供调用方与测试断言。 */
export class RefusalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RefusalError';
    this.code = code;
  }
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256Of(value) {
  return 'sha256:' + createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function assertQueriesDoc(doc, label) {
  if (!doc || !Array.isArray(doc.queries) || doc.queries.length === 0) {
    throw new RefusalError(REFUSAL_CODES.QUERIES_INVALID, label + ': queries 为空或不是数组');
  }
  const seen = new Set();
  for (const q of doc.queries) {
    for (const field of REQUIRED_QUERY_FIELDS) {
      if (q[field] === undefined) {
        throw new RefusalError(
          REFUSAL_CODES.QUERIES_INVALID,
          label + ': ' + (q.queryId ?? '(无 queryId)') + ' 缺少字段 ' + field + '，拒绝生成可能缺字段的 labels'
        );
      }
    }
    if (seen.has(q.queryId)) {
      throw new RefusalError(REFUSAL_CODES.QUERIES_INVALID, label + ': 重复 queryId ' + q.queryId);
    }
    seen.add(q.queryId);
  }
}

/** 纯函数：queries 文档 → 带 labelDigest 的 labels 与文件级摘要。不碰文件系统。 */
export function buildLabelsFromQueries(doc, label) {
  assertQueriesDoc(doc, label);
  const labels = doc.queries.map((q) => {
    const record = {
      queryId: q.queryId,
      expectedNames: q.expectedNames,
      negative: q.negative,
      labelRationale: q.labelRationale
    };
    return { ...record, labelDigest: sha256Of(record) };
  });
  const scoringInput = {
    queryTexts: doc.queries.map((q) => ({
      queryId: q.queryId,
      query: q.query,
      category: q.category,
      language: q.language,
      band: q.band,
      tags: q.tags
    })),
    labels: labels.map((l) => ({
      queryId: l.queryId,
      expectedNames: l.expectedNames,
      negative: l.negative,
      labelRationale: l.labelRationale
    }))
  };
  return { labels, scoringInput, heldoutScoringDigest: sha256Of(scoringInput) };
}

function isoFromNow(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new RefusalError(REFUSAL_CODES.INVALID_CLOCK, 'frozenAt 必须来自可解析的时间源，不能是写死在源码里的字面量');
  }
  return date.toISOString();
}

function basePayload({ datasetId, labelVersion, frozen, frozenAt, queriesSource, digest, labels, ownerNote }) {
  return {
    schemaVersion: 'quality-labels-v1',
    datasetId,
    labelVersion,
    frozen,
    frozenAt,
    labelsProvenance: LABELS_PROVENANCE,
    labelsOwnerNote: ownerNote,
    digestScopeNote: DIGEST_SCOPE_NOTE,
    queriesSource,
    scoringDigestInput: SCORING_DIGEST_INPUT,
    heldoutScoringDigest: digest,
    labels
  };
}

/** 纯函数：不写盘，构造一个尚未落盘的 held-out 冻结 payload。frozenAt 来自调用方时间源。 */
export function buildHeldoutPayload(doc, now) {
  const built = buildLabelsFromQueries(doc, 'heldout');
  return basePayload({
    datasetId: doc.datasetId ?? 'heldout-v1',
    labelVersion: '1.0.0',
    frozen: true,
    frozenAt: isoFromNow(now),
    queriesSource: 'queries/heldout.queries.json',
    digest: built.heldoutScoringDigest,
    labels: built.labels,
    ownerNote: LABELS_OWNER_NOTE
  });
}

/** 纯函数：调参集 payload。frozenAt 记录本次生成时间，但 frozen 恒为 false。 */
export function buildTuningPayload(doc, now) {
  const built = buildLabelsFromQueries(doc, 'tuning');
  return basePayload({
    datasetId: doc.datasetId ?? 'tuning-v1',
    labelVersion: '1.0.0',
    frozen: false,
    frozenAt: isoFromNow(now),
    queriesSource: 'queries/train.queries.json',
    digest: built.heldoutScoringDigest,
    labels: built.labels,
    ownerNote: '调参集的标注由 AI 代理编写，可随调参迭代；其结论不能作为最终质量结论。'
  });
}

/**
 * 纯函数：先算清楚要做什么、会拒绝什么，再决定是否落盘。拒绝时不产生任何写入。
 *
 * 注意：这里的 exists 命中是**咨询性快路径**，只为给出可读的 FROZEN_EXISTS 拒绝。
 * 排他性由 runFreeze 里的 open(wx) 提交保证；本函数返回 "目标不存在" 并不构成任何安全保证。
 */
export function planFreeze({ argv, queriesDir, labelsDir, now, exists = existsSync }) {
  for (const arg of argv) {
    if (arg === '--force' || arg.startsWith('--force=')) {
      throw new RefusalError(
        REFUSAL_CODES.FORCE_UNSUPPORTED,
        '拒绝 --force：覆盖冻结评分输入只能通过显式新版本 + 新冻结，并由独立于作者的人签发标签语义。'
      );
    }
    if (!ALLOWED_ARGS.has(arg)) {
      throw new RefusalError(REFUSAL_CODES.UNKNOWN_ARGUMENT, '未知参数 ' + arg + '；本工装没有覆盖既有冻结文件的开关。');
    }
  }
  const heldoutQueries = path.join(queriesDir, 'heldout.queries.json');
  const tuningQueries = path.join(queriesDir, 'train.queries.json');
  for (const file of [heldoutQueries, tuningQueries]) {
    if (!exists(file)) {
      throw new RefusalError(REFUSAL_CODES.QUERIES_MISSING, '缺少查询文件 ' + file);
    }
  }
  const heldoutTarget = path.join(labelsDir, 'labels.frozen.json');
  if (exists(heldoutTarget)) {
    throw new RefusalError(
      REFUSAL_CODES.FROZEN_EXISTS,
      '拒绝覆盖已存在的冻结文件 ' + heldoutTarget + '。本工装没有静默绕过；如需变更请走新版本 + 新冻结。'
    );
  }
  return { heldoutQueries, tuningQueries, heldoutTarget, tuningTarget: path.join(labelsDir, 'labels.train.json'), frozenAt: isoFromNow(now) };
}

/** 两个已存在路径是否可证明指向同一个文件（同一 dev+ino）。信息不足时返回 false，不猜测。 */
function provableSameFile(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (!sa.ino || !sb.ino) return false; // 拿不到 inode 就无法证明
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false; // 目标不存在或不可 stat：不能证明别名
  }
}

/**
 * 判定调参目标是否**可证明地**是指向冻结目标的符号链接/硬链接别名。
 * 只认能证明的两种情形，不做启发式猜测；返回拒绝理由字符串，或 null。
 *
 * 不覆盖的情形：可证明性检查与后续写入之间被恶意进程换入别名。本工装明确不声称抵抗任意写权限的
 * 恶意进程；它只保证自己不会静默写穿一个当时可证明的别名。
 */
export function provableAliasReason(tuningTarget, heldoutTarget) {
  const heldout = path.resolve(heldoutTarget);
  let st;
  try {
    st = lstatSync(tuningTarget);
  } catch {
    return null; // 调参目标尚不存在，无从别名
  }
  if (st.isSymbolicLink()) {
    let resolved;
    try {
      resolved = path.resolve(path.dirname(path.resolve(tuningTarget)), readlinkSync(tuningTarget));
    } catch {
      return null;
    }
    if (resolved === heldout) return '调参目标是直接指向冻结文件的符号链接';
    try {
      if (provableSameFile(realpathSync(tuningTarget), realpathSync(heldout))) {
        return '调参目标经符号链接解析后与冻结文件是同一文件';
      }
    } catch {
      // 冻结文件尚不存在或不可解析：无法证明为别名
    }
    return null;
  }
  if (provableSameFile(tuningTarget, heldout)) return '调参目标与冻结文件是同一硬链接别名';
  return null;
}

/**
 * 默认的排他提交：open(..., 'wx')，即 O_CREAT|O_EXCL|O_WRONLY。
 * "目标不存在"与"创建"是内核里的同一个原子动作；已被并发创建时抛 EEXIST，不覆盖任何字节。
 * 不用 rename：rename 会覆盖既有目标。
 */
function createExclusiveJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  return writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}

function isAlreadyExists(error) {
  return Boolean(error) && error.code === 'EEXIST';
}

/**
 * 可注入依赖的入口，便于单测；import 本模块不会产生任何写副作用。
 * 默认实现才使用真实文件系统与真实时钟。
 *
 * 写盘顺序（这是排他保证的一半，另一半是 wx 的原子性）：
 *   1. 规划与参数拒绝（无写入）
 *   2. 读取 queries、在内存里构建两个 payload（无写入）
 *   3. 调参目标别名检查（无写入）
 *   4. **以 wx 排他创建提交冻结文件**——这是唯一的"占名"动作，不可被覆盖
 *   5. 写调参集（可覆盖，按设计）
 *
 * 因此冻结文件已存在时，第 4 步失败，第 5 步不会执行。
 * 两个文件**不是**一个事务：第 5 步 IO 失败时冻结文件已经落盘，本工装不删除它、不回滚，
 * 而是明确报告半批失败，交由人工处置——靠删除已写入数据来伪装"成功"是被禁止的。
 */
export function runFreeze(options = {}) {
  const {
    argv = [],
    queriesDir,
    labelsDir,
    now = new Date(),
    readJson = (f) => JSON.parse(readFileSync(f, 'utf8')),
    writeJson = (f, value) => {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(value, null, 2) + '\n', 'utf8');
    },
    createExclusive = createExclusiveJson,
    exists = existsSync
  } = options;

  const plan = planFreeze({ argv, queriesDir, labelsDir, now, exists });

  const alias = provableAliasReason(plan.tuningTarget, plan.heldoutTarget);
  if (alias) {
    throw new RefusalError(
      REFUSAL_CODES.TRAIN_ALIASES_FROZEN,
      '拒绝写入调参集：' + alias + '（' + plan.tuningTarget + ' ↔ ' + plan.heldoutTarget + '）。'
      + '可证明的别名会让可覆盖的调参写入穿掉冻结文件。'
    );
  }

  const heldoutPayload = buildHeldoutPayload(readJson(plan.heldoutQueries), plan.frozenAt);
  const tuningPayload = buildTuningPayload(readJson(plan.tuningQueries), plan.frozenAt);

  try {
    createExclusive(plan.heldoutTarget, heldoutPayload);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new RefusalError(
        REFUSAL_CODES.FROZEN_EXISTS,
        '拒绝覆盖已存在的冻结文件 ' + plan.heldoutTarget
        + '（排他创建返回 EEXIST，可能是在本次检查之后被并发创建的）。本工装没有静默绕过；如需变更请走新版本 + 新冻结。'
      );
    }
    throw new RefusalError(
      REFUSAL_CODES.FROZEN_WRITE_FAILED,
      '冻结文件排他创建失败：' + plan.heldoutTarget + '（' + (error && error.code ? error.code + ' ' : '') + (error && error.message) + '）。'
      + '若该失败发生在开始写入之后，目标处可能残留一个不完整文件；本工装不删除它（删除写入中的数据来伪装成功是被禁止的），'
      + '该残留在被人工核查前会一直让后续冻结以 FROZEN_EXISTS 拒绝。调参集未被写入。'
    );
  }

  try {
    writeJson(plan.tuningTarget, tuningPayload);
  } catch (error) {
    throw new RefusalError(
      REFUSAL_CODES.TRAINING_WRITE_FAILED,
      '冻结文件已提交，但调参集写入失败：' + plan.tuningTarget
      + '（' + (error && error.code ? error.code + ' ' : '') + (error && error.message) + '）。'
      + '这不是事务原子性：两个文件不会一起成或一起败。本工装不回滚、不删除已提交的冻结文件，'
      + '需要人工判断后再决定重冻结。'
    );
  }

  return {
    frozenAt: plan.frozenAt,
    labelsProvenance: LABELS_PROVENANCE,
    written: [plan.heldoutTarget, plan.tuningTarget],
    digests: {
      heldout: heldoutPayload.heldoutScoringDigest,
      tuning: tuningPayload.heldoutScoringDigest
    },
    note: DIGEST_SCOPE_NOTE + ' 本工装不修改 reports/quality-plan.md 的 digest 锚点。'
  };
}

function render(result, asJson) {
  if (asJson) return JSON.stringify(result, null, 2);
  return [
    'heldout records : ' + result.digests.heldout,
    'tuning  records : ' + result.digests.tuning,
    'frozenAt        : ' + result.frozenAt,
    'provenance      : ' + result.labelsProvenance,
    'written         : ' + result.written.join(', '),
    '说明            : ' + result.note
  ].join('\n');
}

function main(argv) {
  const qualityDir = path.resolve(here, '..');
  try {
    const result = runFreeze({
      argv,
      queriesDir: path.join(qualityDir, 'queries'),
      labelsDir: path.join(qualityDir, 'labels')
    });
    console.log(render(result, argv.includes('--json')));
    return 0;
  } catch (error) {
    if (error instanceof RefusalError) {
      console.error('冻结被拒绝 [' + error.code + ']: ' + error.message);
      return 2;
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}