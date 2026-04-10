'use strict';

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    'import/order': [
      'warn',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
      },
    ],
    'import/no-duplicates': 'error',
  },
  env: {
    node: true,
    es2023: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', '*.js'],
  overrides: [
    // ── Rule 1: presentation/** cannot import (value) from */infrastructure/** ──
    // Must route through the application layer.
    // `import type` is allowed — e.g. mapper.ts uses `import type { Resource }` from
    // infrastructure/db/schema, which is a type-only structural reference.
    {
      files: ['src/modules/*/presentation/**/*.ts'],
      rules: {
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/infrastructure/**'],
                message:
                  'Presentation cannot import from infrastructure directly; route through the application layer',
                allowTypeImports: true,
              },
            ],
          },
        ],
      },
    },

    // ── Rule 2: infrastructure/** cannot import (value) from */application/** or */presentation/** ──
    // `import type` is allowed — e.g. repository.ts uses `import type { CursorPayload }`
    // from application/cursor (the encoded-string type is a structural concern, not a direction violation).
    {
      files: ['src/modules/*/infrastructure/**/*.ts'],
      rules: {
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/application/**'],
                message: 'Infrastructure cannot import from application or presentation',
                allowTypeImports: true,
              },
              {
                group: ['**/presentation/**'],
                message: 'Infrastructure cannot import from application or presentation',
                allowTypeImports: true,
              },
            ],
          },
        ],
      },
    },

    // ── Rule 3: application/** cannot import from */presentation/** (value or type) ──
    {
      files: ['src/modules/*/application/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: ['**/presentation/**'],
          },
        ],
      },
    },

    // ── Rule 4: Cross-module imports are forbidden ──
    // Files inside src/modules/**/* must not import from a sibling module.
    // Within a module, each layer uses relative paths that never contain "/modules/" —
    // only imports that traverse up and back into a *different* module will match this pattern.
    // Extract shared code to src/shared/ instead.
    {
      files: ['src/modules/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: ['**/modules/**'],
          },
        ],
      },
    },

    // ── Rule 5: src/infrastructure/** and src/shared/** cannot import from src/modules/** or src/http/** ──
    {
      files: ['src/infrastructure/**/*.ts', 'src/shared/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: ['**/modules/**', '**/http/**'],
          },
        ],
      },
    },
  ],
};
