// freeze-labels 工装的单测。
//
// 边界：全部在 progressive-v2/quality/tests/.tmp 下的专属临时目录里操作，
// 绝不写仓库内的真实 queries/labels。清理前先断言解析后的真实路径确属本文件创建的临时目录。
// 本测试证明的是工装行为（排他创建不覆盖已存在的冻结文件、拒绝覆盖、来源声明、时间来源、
// 无 import 写副作用），不证明也不声称数据可以评分。
//
// 关键约定：writeJson 注入只是可信测试缝，用来制造 IO 失败；证明默认真实文件系统排他写的是
// TOCTOU / exists 谎报两个用例，它们一律走默认的真实文件系统。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const qualityDir = path.resolve(testsDir, '..');
const toolFile = path.join(qualityDir, 'tools', 'freeze-labels.mjs');
const TEMP_BASE = path.join(testsDir, '.tmp');
const ownedSandboxes = new Set();

function makeSandbox(t) {
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TEMP_BASE, 'freeze-')));
  const base = fs.realpathSync(TEMP_BASE);
  assert.ok(dir.startsWith(base + path.sep), '临时目录必须位于 .tmp 内: ' + dir);
  ownedSandboxes.add(dir);
  t.after(() => removeOwnedSandbox(dir));
  return dir;
}

/** 需要 queries/labels 子目录的用例才创建；import 副作用用例要求沙箱根目录保持空。 */
function sandboxLayout(dir) {
  const queriesDir = path.join(dir, 'queries');
  const labelsDir = path.join(dir, 'labels');
  fs.mkdirSync(queriesDir);
  fs.mkdirSync(labelsDir);
  return { queriesDir, labelsDir };
}

/** 删除前强制复核：路径必须仍在本文件登记的沙箱集合内，且位于 .tmp 下。 */
function removeOwnedSandbox(dir) {
  const base = fs.realpathSync(TEMP_BASE);
  assert.ok(ownedSandboxes.has(dir), '拒绝删除未登记的目录: ' + dir);
  assert.ok(dir.startsWith(base + path.sep), '拒绝删除 .tmp 之外的目录: ' + dir);
  ownedSandboxes.delete(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sampleQueries() {
  return {
    schemaVersion: 'quality-queries-v1',
    datasetId: 'heldout-v1',
    queries: [
      {
        queryId: 'S001',
        query: 'sample one',
        category: 'files',
        language: 'en',
        band: 'natural-language',
        tags: ['synonym'],
        expectedNames: ['glob'],
        negative: false,
        labelRationale: 'sample rationale one'
      },
      {
        queryId: 'S002',
        query: 'sample two',
        category: 'all',
        language: 'en',
        band: 'natural-language',
        tags: ['negative-out-of-catalog'],
        expectedNames: [],
        negative: true,
        labelRationale: 'sample rationale two'
      }
    ]
  };
}

function seedSandbox(dir) {
  sandboxLayout(dir);
  fs.writeFileSync(path.join(dir, 'queries', 'heldout.queries.json'), JSON.stringify(sampleQueries(), null, 2));
  const tuning = sampleQueries();
  tuning.datasetId = 'tuning-v1';
  fs.writeFileSync(path.join(dir, 'queries', 'train.queries.json'), JSON.stringify(tuning, null, 2));
}

async function loadTool() {
  return import(pathToFileUrl(toolFile));
}

function pathToFileUrl(file) {
  return new URL('file://' + file.replace(/\\/g, '/')).href;
}

after(() => {
  if (!fs.existsSync(TEMP_BASE)) return;
  const base = fs.realpathSync(TEMP_BASE);
  assert.ok(ownedSandboxes.size === 0, '仍有未清理的沙箱: ' + [...ownedSandboxes].join(', '));
  assert.ok(base.startsWith(fs.realpathSync(testsDir) + path.sep), '拒绝清理 tests 目录之外的路径');
  assert.deepEqual(fs.readdirSync(base), [], '临时目录应为空');
  fs.rmdirSync(base);
});

describe('freeze-labels 工装', () => {
  it('canonical：键排序、数组顺序保留', async () => {
    const { canonical } = await loadTool();
    assert.equal(canonical({ b: 1, a: [3, 1, 2] }), '{"a":[3,1,2],"b":1}');
  });

  it('buildLabelsFromQueries 是纯函数，labelDigest 与记录本身一致', async () => {
    const { buildLabelsFromQueries, sha256Of } = await loadTool();
    const doc = sampleQueries();
    const snapshot = JSON.stringify(doc);
    const built = buildLabelsFromQueries(doc, 'sample');
    assert.equal(JSON.stringify(doc), snapshot, '不得修改输入文档');
    for (const label of built.labels) {
      const { labelDigest, ...record } = label;
      assert.equal(labelDigest, sha256Of(record));
    }
  });

  it('冻结 payload 声明代理合成标注，且源码不再含“人工裁定”或硬编码未来时间', async () => {
    const tool = await loadTool();
    const frozenAtIso = new Date('2026-10-06T01:00:00.000Z').toISOString();
    const payload = tool.buildHeldoutPayload(sampleQueries(), frozenAtIso);
    assert.equal(payload.labelsProvenance, 'agent-authored-synthetic-labels');
    assert.match(payload.labelsOwnerNote, /代理/);
    assert.match(payload.labelsOwnerNote, /不代表人类专家/);
    assert.doesNotMatch(payload.labelsOwnerNote, /人工裁定/);
    assert.match(payload.digestScopeNote, /不证明标签语义正确/);
    assert.match(payload.digestScopeNote, /不证明标注来源独立/);

    const tuning = tool.buildTuningPayload(sampleQueries(), frozenAtIso);
    assert.equal(tuning.labelsProvenance, 'agent-authored-synthetic-labels');
    assert.equal(tuning.frozen, false, '调参集不得标为冻结');

    const source = fs.readFileSync(toolFile, 'utf8');
    assert.doesNotMatch(source, /人工裁定/, '源码不得再生成“人工裁定”声明');
    assert.doesNotMatch(source, /2026-10-06T09:45/, '源码不得再硬编码旧冻结时间戳');
    assert.doesNotMatch(source, /frozenAt:\s*'\d{4}-\d{2}-\d{2}/, 'frozenAt 不得是字面量');
  });

  it('frozenAt 来自调用方时间源，不晚于实际运行时间', async () => {
    const tool = await loadTool();
    const before = Date.now();
    const payload = tool.buildHeldoutPayload(sampleQueries(), new Date());
    const after = Date.now();
    const at = Date.parse(payload.frozenAt);
    assert.ok(Number.isFinite(at));
    assert.ok(at >= before - 1000 && at <= after + 1000, 'frozenAt 必须落在实际运行时刻附近: ' + payload.frozenAt);
    assert.equal(new Date(payload.frozenAt).getTime(), new Date(payload.frozenAt).getTime());
  });

  it('import 本模块没有任何写副作用', async (t) => {
    const sandbox = makeSandbox(t);
    const url = pathToFileUrl(toolFile);
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', 'await import(' + JSON.stringify(url) + '); console.log("imported")'], { cwd: sandbox });
    assert.match(stdout, /imported/);
    assert.deepEqual(fs.readdirSync(sandbox), [], 'import 不得在当前工作目录写任何东西');
  });

  it('已存在的冻结文件一律拒绝，且不产生任何写入', async (t) => {
    const tool = await loadTool();
    const sandbox = makeSandbox(t);
    seedSandbox(sandbox);
    const frozenPath = path.join(sandbox, 'labels', 'labels.frozen.json');
    fs.writeFileSync(frozenPath, '{"pre":"existing"}\n');
    const before = sha256File(frozenPath);

    await assert.rejects(
      async () => {
        await tool.runFreeze({ queriesDir: path.join(sandbox, 'queries'), labelsDir: path.join(sandbox, 'labels') });
      },
      (error) => error.code === tool.REFUSAL_CODES.FROZEN_EXISTS
    );

    assert.equal(sha256File(frozenPath), before, '既有冻结文件不得被改动');
    assert.deepEqual(fs.readdirSync(path.join(sandbox, 'labels')), ['labels.frozen.json'], '拒绝时不得顺带写调参集');
  });

  it('TOCTOU：检查之后、提交之前被并发创建的冻结文件，字节不被覆盖，且调参集不随后写入', async (t) => {
    const tool = await loadTool();
    const sandbox = makeSandbox(t);
    seedSandbox(sandbox);

    const SENTINEL = '{"SENTINEL":"concurrent-freeze-writer"}\n';
    const frozenPath = path.join(sandbox, 'labels', 'labels.frozen.json');
    let planted = false;

    // readJson 回调发生在 planFreeze 的 existsSync 检查之后、排他创建提交之前，
    // 这就是真实竞态的时间窗；此处用的是默认的真实文件系统 createExclusive，没有注入写函数。
    const readJson = (file) => {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!planted) {
        planted = true;
        fs.writeFileSync(frozenPath, SENTINEL);
      }
      return doc;
    };

    await assert.rejects(
      async () => {
        await tool.runFreeze({
          queriesDir: path.join(sandbox, 'queries'),
          labelsDir: path.join(sandbox, 'labels'),
          readJson
        });
      },
      (error) => {
        assert.equal(error.code, tool.REFUSAL_CODES.FROZEN_EXISTS, '撞名必须映射为 FROZEN_EXISTS');
        return true;
      }
    );

    assert.ok(planted, '哨兵必须真的在检查之后被创建，否则本用例没有覆盖竞态');
    assert.equal(fs.readFileSync(frozenPath, 'utf8'), SENTINEL, '并发创建的冻结文件字节必须原样保留');
    assert.deepEqual(
      fs.readdirSync(path.join(sandbox, 'labels')),
      ['labels.frozen.json'],
      '冻结被撞名拒绝后不得顺带写调参集'
    );
  });

  it('排他性来自 open(wx) 而不是“先查后写”或 rename', async (t) => {
    const tool = await loadTool();
    const source = fs.readFileSync(toolFile, 'utf8');
    assert.match(source, /flag:\s*'wx'/, '冻结提交必须是 O_CREAT|O_EXCL 的排他创建');
    assert.doesNotMatch(source, /renameSync|copyFileSync/, 'rename/copy 会覆盖或绕过排他语义，不得出现');

    // 直接证伪“只靠 existsSync”：注入一个恒返回 false 的 exists，真实文件仍在时必须被拒。
    const sandbox = makeSandbox(t);
    seedSandbox(sandbox);
    const frozenPath = path.join(sandbox, 'labels', 'labels.frozen.json');
    fs.writeFileSync(frozenPath, '{"SENTINEL":"exists-lies"}\n');
    await assert.rejects(
      async () => {
        await tool.runFreeze({
          queriesDir: path.join(sandbox, 'queries'),
          labelsDir: path.join(sandbox, 'labels'),
          exists: (f) => f.endsWith('queries.json') // 对 labels 一律谎报不存在
        });
      },
      (error) => error.code === tool.REFUSAL_CODES.FROZEN_EXISTS,
      '即使 exists 谎报不存在，排他创建也必须挡住覆盖'
    );
    assert.equal(fs.readFileSync(frozenPath, 'utf8'), '{"SENTINEL":"exists-lies"}\n');
  });

  it('可证明的硬链接别名：provableAliasReason 认得，调参写入被拒', async (t) => {
    const tool = await loadTool();
    const sandbox = makeSandbox(t);
    seedSandbox(sandbox);
    const labelsDir = path.join(sandbox, 'labels');
    const frozenPath = path.join(labelsDir, 'labels.frozen.json');
    const trainPath = path.join(labelsDir, 'labels.train.json');
    fs.writeFileSync(frozenPath, '{"SENTINEL":"same-inode"}\n');
    fs.linkSync(frozenPath, trainPath); // 同一 dev+ino，可证明的别名

    assert.match(
      tool.provableAliasReason(trainPath, frozenPath),
      /硬链接别名/,
      'provableAliasReason 必须识别同一 inode 的硬链接'
    );
    // 默认顺序下 planFreeze 的快路径先命中；无论命中哪个码，都必须零写入。
    await assert.rejects(async () => {
      await tool.runFreeze({ queriesDir: path.join(sandbox, 'queries'), labelsDir });
    }, (error) => error.code === tool.REFUSAL_CODES.FROZEN_EXISTS || error.code === tool.REFUSAL_CODES.TRAIN_ALIASES_FROZEN);
    assert.equal(fs.readFileSync(frozenPath, 'utf8'), '{"SENTINEL":"same-inode"}\n');
  });

  it('可证明的符号链接别名：调参目标是冻结文件的软链时拒绝，平台不支持则显式 unknown', async (t) => {
    const tool = await loadTool();
    const sandbox = makeSandbox(t);
    seedSandbox(sandbox);
    const labelsDir = path.join(sandbox, 'labels');
    const frozenPath = path.join(labelsDir, 'labels.frozen.json');
    const trainPath = path.join(labelsDir, 'labels.train.json');

    try {
      fs.symlinkSync('labels.frozen.json', trainPath, 'file');
    } catch (error) {
      const unsupported = ['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error && error.code);
      if (!unsupported) throw error;
      t.diagnostic('本平台无法创建符号链接（' + error.code + '），符号链接别名一项为 unknown，不据此推断通过');
      t.skip('平台不支持符号链接，别名端到端用例为 unknown');
      return;
    }

    assert.match(
      tool.provableAliasReason(trainPath, frozenPath),
      /符号链接/,
      'provableAliasReason 必须识别指向冻结目标的符号链接'
    );

    // 冻结文件此时尚不存在，快路径不命中；必须由别名检查拒下，且一个字节都不写。
    await assert.rejects(
      async () => {
        await tool.runFreeze({ queriesDir: path.join(sandbox, 'queries'), labelsDir });
      },
      (error) => error.code === tool.REFUSAL_CODES.TRAIN_ALIASES_FROZEN
    );
    assert.deepEqual(fs.readdirSync(labelsDir), ['labels.train.json'], '别名拒绝时不得写入任何 labels 文件');
    assert.equal(
      fs.lstatSync(trainPath).isSymbolicLink(),
      true,
      '不得为了"恢复干净"而删掉用户已存在的软链'
    );
  });

  it('非别名的调参文件仍按设计可覆盖（拒绝不能变成永久冻结）', async (t) => {
    const tool = await loadTool();
    const sandbox = makeSandbox(t);
    seedSandbox(sandbox);
    const trainPath = path.join(sandbox, 'labels', 'labels.train.json');
    fs.writeFileSync(trainPath, '{"stale":true}\n');

    assert.equal(tool.provableAliasReason(trainPath, path.join(sandbox, 'labels', 'labels.frozen.json')), null);

    const result = tool.runFreeze({ queriesDir: path.join(sandbox, 'queries'), labelsDir: path.join(sandbox, 'labels') });
    assert.equal(result.written.length, 2);
    const tuning = JSON.parse(fs.readFileSync(trainPath, 'utf8'));
    assert.equal(tuning.frozen, false, '调参集确实被重写');
  });

  it('半批 IO 失败不谎称事务原子性，也不删除已提交文件', async (t) => {
    const tool = await loadTool();
    const sandbox = makeSandbox(t);
    seedSandbox(sandbox);
    const labelsDir = path.join(sandbox, 'labels');

    await assert.rejects(
      async () => {
        await tool.runFreeze({
          queriesDir: path.join(sandbox, 'queries'),
          labelsDir,
          writeJson: () => { const e = new Error('模拟磁盘满'); e.code = 'ENOSPC'; throw e; }
        });
      },
      (error) => {
        assert.equal(error.code, tool.REFUSAL_CODES.TRAINING_WRITE_FAILED);
        assert.match(error.message, /不是事务原子性/);
        return true;
      }
    );
    const frozenPath = path.join(labelsDir, 'labels.frozen.json');
    assert.ok(fs.existsSync(frozenPath), '已提交的冻结文件不得被回滚删除');
    assert.deepEqual(fs.readdirSync(labelsDir), ['labels.frozen.json']);
  });

  it('--force 被显式拒绝，没有任何静默绕过', async (t) => {
    const tool = await loadTool();
    const sandbox = makeSandbox(t);
    seedSandbox(sandbox);
    for (const argv of [['--force'], ['--force=true']]) {
      await assert.rejects(
        async () => {
          await tool.runFreeze({ argv, queriesDir: path.join(sandbox, 'queries'), labelsDir: path.join(sandbox, 'labels') });
        },
        (error) => error.code === tool.REFUSAL_CODES.FORCE_UNSUPPORTED
      );
    }
    assert.deepEqual(fs.readdirSync(path.join(sandbox, 'labels')), [], '被拒绝时不得留下任何文件');
    await assert.rejects(
      async () => {
        await tool.runFreeze({ argv: ['--overwrite'], queriesDir: path.join(sandbox, 'queries'), labelsDir: path.join(sandbox, 'labels') });
      },
      (error) => error.code === tool.REFUSAL_CODES.UNKNOWN_ARGUMENT
    );
  });

  it('正常路径：只写尚不存在的文件，摘要只承诺字节一致', async (t) => {
    const tool = await loadTool();
    const sandbox = makeSandbox(t);
    seedSandbox(sandbox);
    const result = tool.runFreeze({ queriesDir: path.join(sandbox, 'queries'), labelsDir: path.join(sandbox, 'labels') });

    assert.equal(result.labelsProvenance, 'agent-authored-synthetic-labels');
    assert.match(result.note, /不证明标签语义正确/);
    assert.match(result.note, /不修改 reports\/quality-plan\.md/);
    assert.equal(result.written.length, 2);

    const frozen = JSON.parse(fs.readFileSync(path.join(sandbox, 'labels', 'labels.frozen.json'), 'utf8'));
    const tuning = JSON.parse(fs.readFileSync(path.join(sandbox, 'labels', 'labels.train.json'), 'utf8'));
    assert.equal(frozen.frozen, true);
    assert.equal(tuning.frozen, false);
    assert.equal(frozen.labelsProvenance, 'agent-authored-synthetic-labels');
    assert.equal(frozen.heldoutScoringDigest, result.digests.heldout);

    const rebuilt = tool.buildLabelsFromQueries(sampleQueries(), 'sample');
    assert.equal(rebuilt.heldoutScoringDigest, frozen.heldoutScoringDigest, '摘要应可由同一函数复算');
    assert.deepEqual(
      fs.readdirSync(sandbox).sort(),
      ['labels', 'queries'],
      '不得在沙箱根目录写额外文件'
    );
  });

  it('真实只读数据在整轮测试后未被改动，且冻结摘要仍可复算', async () => {
    const tool = await loadTool();
    const tracked = [
      path.join(qualityDir, 'fixtures', 'catalog.invented.json'),
      path.join(qualityDir, 'queries', 'heldout.queries.json'),
      path.join(qualityDir, 'queries', 'train.queries.json'),
      path.join(qualityDir, 'labels', 'labels.frozen.json'),
      path.join(qualityDir, 'labels', 'labels.train.json'),
      path.join(qualityDir, 'validate.mjs')
    ];
    const before = tracked.map(sha256File);

    const doc = JSON.parse(fs.readFileSync(path.join(qualityDir, 'queries', 'heldout.queries.json'), 'utf8'));
    const labelsDoc = JSON.parse(fs.readFileSync(path.join(qualityDir, 'labels', 'labels.frozen.json'), 'utf8'));
    const scoringInput = {
      queryTexts: doc.queries.map((q) => ({
        queryId: q.queryId,
        query: q.query,
        category: q.category,
        language: q.language,
        band: q.band,
        tags: q.tags
      })),
      labels: labelsDoc.labels.map((l) => ({
        queryId: l.queryId,
        expectedNames: l.expectedNames,
        negative: l.negative,
        labelRationale: l.labelRationale
      }))
    };
    assert.equal(
      tool.sha256Of(scoringInput),
      'sha256:d3ff166099e1f1a380f36eabbc928f7573feebb885025f3fcd1c45bb79140b4e',
      '本工装的摘要函数必须复现既有冻结摘要'
    );

    assert.deepEqual(tracked.map(sha256File), before, '真实只读数据不得被改动');
  });
});