// 常驻名单漂移只用于诊断：不改变名单、engine 或可信记录。
export function describeNamesDrift(candidateNames, runtime) {
  const sorted = (values) => [...new Set(values)].sort();
  const candidates = sorted(candidateNames);
  const epoch = sorted(runtime.alwaysNames ?? []);
  const effective = sorted(runtime.alwaysNameSet ?? []);
  // 每轮 pre-step 都会跑到这里：filter+includes 是 O(n×m)，换 Set 做排除集。
  const difference = (left, right) => {
    const exclude = new Set(right);
    return left.filter((name) => !exclude.has(name));
  };
  return {
    added: difference(candidates, epoch),
    removed: difference(epoch, candidates),
    effectiveOnly: difference(effective, epoch),
    pendingAdded: difference(candidates, effective),
    requireTrustedEpoch: runtime.requireTrustedEpoch === true,
    baselineState: runtime.ledger?.state ?? 'disabled',
  };
}

export function createNamesDriftObserver(log) {
  // 弱引用随 runtime 回收；只保留最近一次差异，不积累历史名单。
  const previous = new WeakMap();
  return (runtime, candidates, point) => {
    const details = describeNamesDrift(candidates, runtime);
    const key = JSON.stringify(details);
    if (previous.get(runtime) === key) return;
    previous.set(runtime, key);
    if (!details.added.length && !details.removed.length && !details.effectiveOnly.length) return;
    log('lifecycle:names-drift', {
      sessionId: runtime.scope.sessionId, point, ...details,
      activation: details.requireTrustedEpoch
        ? 'next-eligible-epoch-after-durable-record; load-and-core-self-admission-are-separate'
        : 'next-epoch-snapshot; load-and-core-self-admission-are-separate',
    });
  };
}
