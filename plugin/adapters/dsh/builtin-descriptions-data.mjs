// Immutable v1 copy, checked against official DSH Core 0.2.1-rc.3 definitions.
// Fingerprints include name, full description AND every parameter field. Unknown
// variants (including third-party shell overrides) are never rewritten.
// Source and update procedure: ../../docs/13-builtin-descriptions.md.
// Do not edit released v1 strings in place: old session headers pin this revision.
const bashEn = 'Run bash -c in a fresh shell; return stdout/stderr. Use workdir, not cd. $DSH_* holds harness facts. Long output keeps its tail and reports a full-output file when available. Put description before command. Before delete/move, verify the resolved absolute target; never use an unchecked computed path, and guard unset variables with ${VAR:?}. A [sandbox: file access denied under <mode> mode] result is a policy denial: do not retry another way.';
const bashZh = '在新 shell 中执行 bash -c，返回 stdout/stderr。用 workdir 而非 cd；$DSH_* 提供运行环境事实。长输出保留尾部，有完整输出文件时返回路径。参数 description 放在 command 前。删除或移动前核对解析后的绝对目标路径；不操作未经核实的计算路径，用 ${VAR:?} 防止变量未设置。出现 [sandbox: file access denied under <mode> mode] 即策略拒绝，不得换方式重试。';
const pwshEn = 'Run pwsh -Command in a fresh process; return stdout/stderr. Use workdir, not cd; native Windows paths (C:\\...), $env:NAME for environment and $env:DSH_* for harness facts. Long output keeps its tail and reports a full-output file when available. A force-kill on Windows may return [exit code: 1] without a signal: treat it as interruption. Put description before command. Before delete/move, verify the resolved absolute target; never use an unchecked computed path. Do not assign automatic variables: $HOME and $home are the same read-only variable. [sandbox: file access denied under <mode> mode] means policy denial: do not retry another way.';
const pwshZh = '在新进程中执行 pwsh -Command，返回 stdout/stderr。用 workdir 而非 cd；原生 Windows 路径 C:\\...，环境变量用 $env:NAME，运行环境事实用 $env:DSH_*。长输出保留尾部，有完整输出文件时返回路径。Windows 强制终止可能仅返回 [exit code: 1]、无 signal，按中断处理。参数 description 放在 command 前。删除或移动前核对解析后的绝对目标路径，不操作未经核实的计算路径。勿赋值自动变量：$HOME 与 $home 是同一只读变量。出现 [sandbox: file access denied under <mode> mode] 即策略拒绝，不得换方式重试。';
const sandboxEn = ' Windows sandbox: read-only uses ConstrainedLanguage; workspace-write uses FullLanguage unless host policy overrides it. In read-only use cmdlets, core types ([string], [datetime], [regex], [guid]), properties and -f; .NET static methods ([System.IO.*]::, [math]::), Add-Type, COM and reflection fail with "only core types". Both confined modes prohibit named pipes: Node child_process.spawn/exec with piped stdio fails EPERM; inherit/ignore stdio and PowerShell pipelines work. Do not bypass that denial; only request an authorized exact-command escalation or restructure to avoid output capture.';
const sandboxZh = ' Windows 沙箱：read-only 为 ConstrainedLanguage；workspace-write 通常为 FullLanguage，以宿主策略为准。只读时用 cmdlet、核心类型（[string]/[datetime]/[regex]/[guid]）、属性与 -f；.NET 静态方法（[System.IO.*]::/[math]::）、Add-Type、COM、反射会报 only core types。两种受限模式均禁命名管道：Node child_process.spawn/exec 的 pipe stdio 会 EPERM，inherit/ignore 及 PowerShell 自身管道可用。不得绕过拒绝；只能按授权申请原命令升级，或重构为不捕获输出。';

export const BUILTIN_DESCRIPTION_RULES = Object.freeze([
  { name: 'bash', sourceDigests: [
    'sha256:78a7b5e33a5c75ca4e8a1ad321b2839b08dca8495fec5939b94ab620f3b1d232',
    'sha256:bf0567112b869e72230adeb40e135ede0df3e38da3ae8bbe5263cf87eb90a61e',
    'sha256:12ebf5ed6169b0b862730e24f41075740e1511ccdac16a184b0a62000842731d',
    'sha256:ff999bdbae72a6f0a6c32e9eb8beccc72b7ec05d625e1d93019e3a9c9734731b',
    'sha256:c566d617a59d1416d9027ba6585454d9379d770810813a74bd0f20ba598c2183',
    'sha256:59ed3b135d3fa6f192b1b497720d1873631f0327db3f055f28b6a2766ab65afd',
  ], en: bashEn, zh: bashZh },
  { name: 'pwsh', sourceDigests: [
    'sha256:a1c2e9b36a443e7e931a5672652cb8da0ee1dcb236261cc85b662e536c325540',
    'sha256:b408ded0e6da9d0764793b31d19574689c1c05b63b978946f46b05cf89ade4c1',
    'sha256:f7e4cf43ec0f085bc77f42055c76a633582489a3b678df60676bfff1e325de07',
  ], en: pwshEn, zh: pwshZh },
  { name: 'pwsh', sourceDigests: [
    'sha256:e13fc1b19d4cc5bf208bffa73367469160cc998e5008befdcbd9f40882400b48',
    'sha256:19a0d4f49b57606ea3e27a58bf6e1715e3af25d0b9662576c169e9da28d34141',
    'sha256:ce0a69a26a7745b9b701058a380ffc182889e37b10fdef11df0257c400ce02c3',
  ], en: pwshEn + sandboxEn, zh: pwshZh + sandboxZh },
  { name: 'workflow', sourceDigests: ['sha256:370aa6628c3110767e574d13080a3008b24e793cafb73999252daa4727b82c06'],
    en: 'Orchestrate many independent tasks with a JavaScript script. Hooks: agent(prompt, opts?) returns a Promise of final text, or a validated object when opts.schema is supplied; failed children return null (filter(Boolean)). Schema must have an object root and use only type/properties/required/additionalProperties/items/enum/const/oneOf. Other opts: label, phase, independent provider/model overrides. pipeline(items, ...stages) runs each item independently without a stage barrier; stage(prev, item, index), throws drop that item to null and skip its remaining stages. Prefer pipeline for multi-stage work. parallel(thunks) runs zero-argument functions concurrently and waits for all; throwing thunks return null. Use only when all results are needed together. phase(title) starts a phase; log(message) reports progress; args is the supplied args unchanged. Invalid hook arguments, unknown options, unsupported schemas or exceeded caps terminate the entire script, not null. No filesystem, network, timer or Node APIs in scripts; agents do the work.',
    zh: '用 JavaScript 脚本编排大量独立任务。钩子：agent(prompt, opts?) 返回 Promise，默认是子代理最终文本；opts.schema 存在时返回校验后的对象；子代理失败返回 null，可 filter(Boolean)。schema 须以 object 为根，只允许 type/properties/required/additionalProperties/items/enum/const/oneOf。其他 opts：label、phase、独立的 provider/model 覆盖。pipeline(items, ...stages) 各项独立流转、无阶段屏障；stage(prev, item, index) 抛错则该项为 null 并跳过后续阶段，多阶段任务优先用它。parallel(thunks) 并行运行零参数函数，等待全部完成；单个函数抛错返回 null，仅在确需汇齐结果时使用。phase(title) 开始阶段，log(message) 报告进度，args 为传入参数原值。钩子参数错误、未知选项、不支持的 schema 或超限会终止整个脚本，不返回 null。脚本无文件系统、网络、计时器或 Node API，由子代理执行实际工作。' },
  { name: 'read_image', sourceDigests: ['sha256:eb5f0beb6117a9e0a1ed9075113de3eada4c0bbf576ec392118d4826914168a5'],
    en: 'Return a PNG/JPEG/WebP/GIF image; large images downscale automatically. Do not install image libraries or create inspection thumbnails.',
    zh: '读取并返回 PNG/JPEG/WebP/GIF 图像，大图自动缩小。勿为检查图像安装图像库或创建缩略图。' },
  { name: 'create_goal', sourceDigests: ['sha256:fb3d36f642f89d1dcf1ff8bc688edaf7d6e33ddf72c692489d18de3adef32a33'],
    en: 'Persist a goal for automatic continuation of a direct human long-running request, even without the word "goal". Not for single-turn work.',
    zh: '为用户直接提出的长期任务保存目标，使会话自动续办；无需用户说出“目标”。不用于单轮工作。' },
].map(rule => Object.freeze({ ...rule, sourceDigests: Object.freeze(rule.sourceDigests) })));
