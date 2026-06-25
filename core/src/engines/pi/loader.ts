/**
 * A short hint for a dynamic-import failure, covering the two common workspace causes — an
 * uninstalled dependency, or a non-ESM package — and EMPTY otherwise, so an unrelated error (a
 * syntax error, a top-level throw) is reported on its own rather than mis-attributed to module type.
 * Shared by tools/ and channels/ discovery (loadTools, loadChannels).
 */
export function moduleLoadHint(error: NodeJS.ErrnoException): string {
  if (error.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (package|module)/.test(error.message)) {
    return "\n  (a dependency is not installed — run `npm install` in the workspace)";
  }
  if (/import statement outside a module|Unexpected token 'export'|ERR_REQUIRE_ESM/.test(error.message)) {
    return '\n  (this workspace must be ESM — set "type": "module" in package.json)';
  }
  return "";
}
