import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "release/**", "data/**", "coverage/**", ".claude/**"],
  },
  js.configs.recommended,
  {
    files: [
      "server.js",
      "lib/**/*.js",
      "bin/**/*.js",
      "routes/**/*.js",
      "tests/**/*.js",
      "scripts/**/*.mjs",
      "scripts/**/*.js",
      "electron/**/*.cjs",
      "playwright.config.js",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-assignment": "warn",
      "no-control-regex": "off",
    },
  },
  {
    files: ["electron/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    files: ["client/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        SiskelI18n: "readonly",
        SiskelRafBatcher: "readonly",
        marked: "readonly",
        DOMPurify: "readonly",
      },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-assignment": "warn",
      "no-var": "off",
      "no-control-regex": "off",
    },
  },
  {
    files: ["vscode-extension/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["sdk/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, fetch: "readonly", URLSearchParams: "readonly", TextDecoder: "readonly" },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
];
