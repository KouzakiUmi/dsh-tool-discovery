// Runtime ownership is authoritative. Durable fork lineage and user/meta labels
// do not make a resumed top-level agent a subagent, and unknown agents get no exemption.
export function isRuntimeSubagent(agents, agent) {
  if (agent === undefined || typeof agents?.list !== 'function' || typeof agents?.roots !== 'function') return false;
  try {
    return agents.list().includes(agent) && !agents.roots().includes(agent);
  } catch { return false; }
}
export function requiresTrustedEpoch(config, agents, agent) {
  if (config.requireTrustedEpoch !== true) return false;
  if (config.requireTrustedEpochForSubagents === true) return true;
  return !isRuntimeSubagent(agents, agent);
}
