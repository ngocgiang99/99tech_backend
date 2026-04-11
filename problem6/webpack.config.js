// webpack.config.js
// Used by `pnpm nest build --webpack` via nest-cli.json `webpackConfigPath`.
//
// Problem: `jose` v6 is ESM-only ("type":"module").  NestJS webpack default
// outputs CommonJS; `require("jose")` fails at runtime with ERR_REQUIRE_ESM.
//
// Fix: emit an ESM bundle (experiments.outputModule = true) and replace the
// NestJS default externals function (nodeExternals, which emits require) with
// a custom externals function that emits `import` for all node_modules.
// This is compatible with:
//   - CJS packages: Node v12+ wraps CJS as a named default for ESM consumers
//   - ESM-only packages like jose v6: loaded natively as ESM
//
// The output dist/main.js is an ES module.  Node loads it as ESM because the
// runtime package.json carries `"type":"module"` (injected only inside the
// Docker build stage — the source package.json on disk is unchanged).
//
// Note: webpack-node-externals is bundled inside @nestjs/cli and is NOT a
// direct project dependency, so we cannot require() it from user config.
// Instead we replicate its core logic: mark every non-relative import as an
// external module import.

'use strict';

const path = require('path');

/**
 * Custom externals function that treats every node_module as an ESM external.
 * Equivalent to nodeExternals() but emits `import X` instead of `require(X)`.
 */
function esmNodeExternals({ context, request }, callback) {
  // Relative imports and absolute paths are bundled, not external.
  if (request.startsWith('.') || request.startsWith('/') || path.isAbsolute(request)) {
    return callback();
  }
  // Webpack virtual modules (prefixed with webpack/) are internal.
  if (request.startsWith('webpack/')) {
    return callback();
  }
  // Everything else is a node_module — treat as an ESM import external.
  // 'module X' makes webpack emit: import * as X from "X" (ESM static import)
  return callback(null, `module ${request}`);
}

module.exports = function (options) {
  return {
    ...options,
    experiments: {
      ...(options.experiments || {}),
      outputModule: true,
    },
    output: {
      ...options.output,
      library: { type: 'module' },
      chunkFormat: 'module',
    },
    // Override NestJS default externals (which emits require) with our ESM variant.
    externals: [esmNodeExternals],
    externalsType: 'module',
    // Re-enable __dirname / __filename polyfills.
    // The NestJS webpack defaults set these to `false`, but the source code
    // uses __dirname (e.g. redis-token-bucket.ts reads a .lua file).
    // Webpack injects a module-relative path shim so the value is correct
    // inside the ESM bundle.
    node: {
      __dirname: true,
      __filename: true,
    },
  };
};
