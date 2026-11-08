// Read the agent's registry view without this plugin's own restriction.
// DSH 0.2.2 exposes only post-restriction public reads. This narrowly scoped
// compatibility adapter mirrors its view algorithm and never removes a mask
// to inspect the registry: other plugins' restrictions must remain effective.
import { DomainError } from '../../domain/index.mjs';

// These private APIs are required before installing any provider-owned hooks.
export function assertRestrictionHost(tools, log = () => {}) {
  const required = {
    'layers.chainLayers': tools?.layers?.chainLayers,
    'layers.peek': tools?.layers?.peek,
    'layers.global.tools.entries': tools?.layers?.global?.tools?.entries,
    selectExecutor: tools?.selectExecutor,
    view: tools?.view,
    restrict: tools?.restrict,
  };
  const missing = Object.entries(required).filter(([, value]) => typeof value !== 'function').map(([name]) => name);
  if (missing.length === 0) return;
  log('restriction:incompatible-host', { missing });
  throw new DomainError('INCOMPATIBLE_COMPOSITION', `Provider-owned tool registry APIs are unavailable: ${missing.join(', ')}`);
}

export function viewWithoutRestriction(tools, scope, ignoredRestriction) {
  const ignored = ignoredRestriction instanceof Set ? ignoredRestriction : new Set([ignoredRestriction]);
  const layers = tools?.layers;
  if (typeof layers?.chainLayers !== 'function' || typeof layers?.peek !== 'function'
    || typeof layers?.global?.tools?.entries !== 'function') {
    throw new Error('Unsupported host tool registry: restriction-safe catalog unavailable');
  }
  const chain = layers.chainLayers(scope);
  const own = layers.peek(scope);
  const inherited = new Map(layers.global.tools.entries());
  for (const layer of chain) {
    if (layer === own) continue;
    for (const [name, registration] of layer.tools.entries()) inherited.set(name, registration);
  }
  const visible = new Map();
  const registrations = new Map();
  const knownNames = new Set();
  const restrictableNames = new Set();
  for (const [name, registration] of inherited) {
    knownNames.add(name);
    restrictableNames.add(name);
    let admitted = true;
    for (const layer of chain) {
      if (typeof layer.restrictions?.values !== 'function') throw new Error('Unsupported host restriction table');
      for (const filter of layer.restrictions.values()) {
        if (ignored.has(filter)) continue;
        if ((filter.allow !== undefined && !filter.allow.has(name)) || filter.deny?.has(name)) admitted = false;
      }
    }
    if (admitted) {
      visible.set(name, registration.definition);
      registrations.set(name, registration);
    }
  }
  if (own !== undefined) {
    for (const [name, registration] of own.tools.entries()) {
      knownNames.add(name);
      visible.set(name, registration.definition);
      registrations.set(name, registration);
    }
  }
  return { visible, registrations, knownNames, restrictableNames };
}
