// @ts-check
import eslint from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // ESLint boundaries — enforce hexagonal architecture layer rules (Decision 6)
  {
    plugins: {
      boundaries,
    },
    settings: {
      'boundaries/elements': [
        { type: 'domain', pattern: 'src/scoreboard/domain/**' },
        { type: 'application', pattern: 'src/scoreboard/application/**' },
        { type: 'infrastructure', pattern: 'src/scoreboard/infrastructure/**' },
        { type: 'interface', pattern: 'src/scoreboard/interface/**' },
        { type: 'shared', pattern: 'src/shared/**' },
      ],
    },
    rules: {
      // Inter-element dependency rules (hexagonal layer enforcement)
      // checkAllOrigins: true also checks imports of external/core packages
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        checkAllOrigins: true,
        rules: [
          // domain: no framework imports; only pure TypeScript/Node core allowed
          {
            from: { type: 'domain' },
            allow: [
              { to: { origin: 'core' } },
            ],
          },
          // application: may import from domain and shared; external packages ok
          {
            from: { type: 'application' },
            allow: [
              { to: { type: ['domain', 'shared'] } },
              { to: { origin: 'external' } },
              { to: { origin: 'core' } },
            ],
          },
          // infrastructure: may import from domain, application, and shared; external/core ok
          {
            from: { type: 'infrastructure' },
            allow: [
              { to: { type: ['domain', 'application', 'shared'] } },
              { to: { origin: 'external' } },
              { to: { origin: 'core' } },
            ],
          },
          // interface: may import from application and shared; external/core ok
          {
            from: { type: 'interface' },
            allow: [
              { to: { type: ['application', 'shared'] } },
              { to: { origin: 'external' } },
              { to: { origin: 'core' } },
            ],
          },
          // shared: may import from other shared; external/core ok
          {
            from: { type: 'shared' },
            allow: [
              { to: { type: ['shared'] } },
              { to: { origin: 'external' } },
              { to: { origin: 'core' } },
            ],
          },
        ],
      }],
    },
  },
);
