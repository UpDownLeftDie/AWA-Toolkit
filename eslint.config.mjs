import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import ts from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  sonarjs.configs.recommended,
  unicorn.configs.recommended,
  prettier,
  // recommendedTypeChecked[0] is parser-only. tsconfigRootDir keeps
  // projectService rooted on this package so the IDE matches CLI types.
  {
    files: ['src/**/*.ts'],
    ...ts.configs.recommendedTypeChecked[0],
    languageOptions: {
      ...ts.configs.recommendedTypeChecked[0].languageOptions,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ...ts.configs.recommendedTypeChecked[0].languageOptions?.parserOptions,
        // Explicit project (not projectService): in a multi-root workspace the
        // IDE otherwise type-checks this package against the wrong tsconfig and
        // no-unsafe-* fires on error types that CLI + tsc never see.
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-script-url': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-magic-numbers': [
        'warn',
        {
          ignore: [0, 1, -1],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
        },
      ],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'unicorn/filename-case': 'off',
      'unicorn/prefer-global-number-constants': 'off',
      'unicorn/prefer-number-properties': [
        'error',
        { checkNaN: true, checkInfinity: true },
      ],
    },
  },
  {
    // Artifact effect tables and ARP math are inherently numeric game data;
    // naming every tier bonus / percent / slot index adds noise without clarity.
    files: ['src/artifacts/**/*.ts'],
    rules: {
      'no-magic-numbers': 'off',
    },
  },
  {
    ignores: [
      'dist/',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      'vite.config.ts',
      'eslint.config.mjs',
    ],
  },
];
