const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, module: 'readonly' } },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  { files: ['scripts/**/*.mjs', 'tests/**/*.mjs'], languageOptions: { sourceType: 'module', globals: globals.node } },
  { files: ['eslint.config.js'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
];
