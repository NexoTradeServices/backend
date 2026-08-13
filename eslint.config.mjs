import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Only our source is linted. The config file itself is not part of tsconfig,
  // so type-aware linting cannot see it and does not need to.
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'] },
  js.configs.recommended,
  // Type-aware rules: this is the point of having eslint here at all. The one
  // that earns its keep is no-floating-promises - an un-awaited promise in
  // payment or settlement code swallows its own error silently.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
)
