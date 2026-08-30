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
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
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
];
