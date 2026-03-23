import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "release/**", "client/**", "data/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: [
      "server.js",
      "lib/**/*.js",
      "bin/**/*.js",
      "tests/**/*.js",
      "scripts/**/*.mjs",
      "scripts/**/*.js",
      "electron/**/*.cjs",
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
];
