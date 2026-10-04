import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        // None. Shipped source runs in React Native (Hermes) as well as Node,
        // and React Native provides Buffer, URL, URLSearchParams and
        // TextEncoder incompletely or not at all. Listing none here makes any
        // use of them a lint error rather than a crash on a phone.
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // `--fix` is deliberately not wired into any script here: a build that
      // rewrites tracked sources hides from review the very errors review
      // exists to catch, and leaves the fix uncommitted so it returns on the
      // next checkout.
    },
  },
  {
    files: ["src/**/__tests__/**/*.ts"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        jest: "readonly",
        // Tests run in Node and compare against its encoder; shipped source may not.
        Buffer: "readonly",
      },
    },
  },
];
