import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Only our source is linted. The config file itself is not part of tsconfig,
  // so type-aware linting cannot see it and does not need to.
  // src/generated is Prisma's output, rewritten by `npm run db:generate`; linting
  // it would only report on code we never touch.
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs', 'src/generated/**'] },
  js.configs.recommended,
  // Type-aware rules: this is the point of having eslint here at all. The one
  // that earns its keep is no-floating-promises - an un-awaited promise in
  // payment or settlement code swallows its own error silently.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.check.json is the one that sees everything -- src, tests, and
        // the root config files. tsconfig.json covers only what gets built, so
        // type-aware linting has to read the wider one.
        project: ['./tsconfig.check.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
)
