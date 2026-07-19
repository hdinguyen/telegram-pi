/**
 * Deprecated compatibility shim.
 * Image payload access is now provided through src/agent/vision-bridge.js and
 * the shared pi event bus instead of unsupported session.extensions hooks.
 */
export function registerImageHooks() {
  return [];
}
