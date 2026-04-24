// Flat config. Scopes:
//   - TypeScript sources in apps/** and packages/** get typescript-eslint's
//     recommended + a few rules whose absence bit us in the code review.
//   - Portal (React) also gets react-hooks rules.
//   - Everything non-TS (configs, dist, node_modules) is ignored.
//
// We deliberately skip the type-checked preset — it needs every tsconfig
// wired up and slows lint to a crawl. If a specific rule warrants it
// later, turn it on per-package.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-migrate/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Catch the most common async/await footguns.
      '@typescript-eslint/no-floating-promises': 'off', // requires type info; skip for speed
      // Unused vars prefixed with _ are intentional (function args, destructuring).
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unused-vars': 'off', // superseded by typescript-eslint rule above
      // `any` is fine in a handful of spots (json bodies, generics); don't fail CI for it.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Empty catch blocks typically hide a bug.
      'no-empty': ['error', { allowEmptyCatch: false }],
      // Prefer const where the binding isn't reassigned.
      'prefer-const': 'error',
      // Unused expressions other than IIFEs / short-circuit assertions.
      '@typescript-eslint/no-unused-expressions': ['warn', { allowShortCircuit: true, allowTernary: true }],
    },
  },
  {
    files: ['apps/portal/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Scripts + migrations run in node; console is fine.
    files: ['**/scripts/**', '**/migrations/**', '**/*.config.{js,mjs,ts}'],
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
];
