// ESLint flat config：eslint:recommended + 项目风格（2 空格/无分号/单引号）。
// 覆盖 src/tests/scripts（含 eslint.config.js 自身）；ignore 生成物。
// src 为 .ts（TS 第二阶段——Node ≥24 原生类型剥离运行；ts 块用
// @typescript-eslint/parser 解析，其余规则与 js 块同一套）。
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'

const styleRules = {
  '@stylistic/semi': ['error', 'never'],
  '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
  '@stylistic/indent': ['error', 2],
  '@stylistic/comma-dangle': ['error', 'never'],
  '@stylistic/space-before-function-paren': ['error', 'always'],
  // catch 参数未使用是常见合法形态（如 catch { }）——recommended 不报，显式确认
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
}

export default [
  {
    ignores: ['node_modules/', 'coverage/', 'data/', 'logs/']
  },
  {
    files: ['src/**/*.js', 'tests/**/*.mjs', 'scripts/**/*.mjs', 'eslint.config.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    plugins: {
      '@stylistic': stylistic
    },
    rules: {
      ...js.configs.recommended.rules,
      ...styleRules
    }
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    plugins: {
      '@stylistic': stylistic
    },
    rules: {
      ...js.configs.recommended.rules,
      ...styleRules
    }
  }
]
