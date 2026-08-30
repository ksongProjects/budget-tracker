import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.expo/**'],
  },
  js.configs.recommended,

  // Type-aware linting for package and app source, which belong to a tsconfig.
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
  })),
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        // Explicit list rather than projectService: package tsconfigs exclude
        // tests so they stay out of dist, and the service would not find the
        // root test config on its own.
        project: ['./packages/*/tsconfig.json', './tsconfig.test.json', './apps/*/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // Numbers in templates are not the hazard this rule exists for, and
      // React Native's dimension types are literally `${number}%`.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Rounding money is never incidental; it belongs in the schema helpers
      // where the rule is stated once and tested.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']",
          message: 'Rounding money is a domain decision — use the @budget/schema money helpers.',
        },
      ],
    },
  },
  {
    files: ['packages/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Root config files sit outside every tsconfig; lint them without type info.
  {
    files: ['*.js', '*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Build tooling that has to stay CommonJS (Metro reads it with require).
  // Node scripts: real ES modules, run by node rather than bundled.
  {
    files: ['tools/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
  },

  {
    files: ['**/metro.config.js', '**/babel.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
      },
    },
  },
];
