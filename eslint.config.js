import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.config.js', '*.config.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // common/coding-style.md：生产代码不得使用 console.log
      'no-console': ['error', { allow: ['error', 'warn'] }],

      // 不可变数据契约：禁止把参数与领域对象原地改写
      'no-param-reassign': 'error',
      'prefer-const': 'error',

      // 异步边界：所有异步操作必须支持 AbortSignal，禁止吞掉 Promise
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // 外部输入不可信：禁止用 any 绕过校验
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // 错误处理：不允许静默丢弃（空 catch 必须写明理由）
      'no-empty': ['error', { allowEmptyCatch: false }],

      // 未使用变量以下划线前缀显式忽略
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // 类型导入必须显式区分，配合 verbatimModuleSyntax
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
    },
  },
  {
    // 浏览器前端与构建脚本。
    //
    // 两者的共同点是**不在 tsconfig 的 project service 里**，类型化规则无法运行
    // （会直接报"文件找不到"）。这里关掉类型化规则、保留基础规则——
    // 直接 ignore 掉整个目录也行，但前端 JS 有 500 多行，值得留下拼写与未使用
    // 变量这类检查。
    //
    // 前端还额外需要浏览器全局：`js.configs.recommended` 的 `no-undef`
    // 不认识 `document` / `WebSocket`，不声明会把每一处都报成错误。
    files: ['src/clients/web/static/**/*.js', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        sessionStorage: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // 测试文件放宽：允许断言用 any、允许 console
    files: ['tests/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-console': 'off',
    },
  },
)
