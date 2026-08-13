import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Underscore-prefixed args are deliberate: they keep a signature
      // matching an interface even when the body ignores them.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  /*
   * Type-aware rules, on the code that talks to the database and the network.
   *
   * `no-floating-promises` is here because of a real bug it would have caught:
   * an unawaited write inside an `after()` callback, which resolved after the
   * response had been sent and took its rejection with it. That is the whole
   * class, and it is invisible to a non-type-aware linter.
   *
   * Scoped rather than global because these rules need the type checker, which
   * is slow, and because the client components are full of deliberately
   * fire-and-forget handlers where the rule would be noise. `scripts/` is in
   * too: nine of those write to the database.
   */
  {
    files: ["lib/**/*.ts", "app/api/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        // Only the return-value form. Checking every argument position flags
        // things like an async callback passed to an array method, which is
        // usually fine and always noisy.
        { checksVoidReturn: false },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored pdf.js, copied by scripts/copy-pdf-worker.mjs:
    "public/pdf.min.mjs",
    "public/pdf.worker.min.mjs",
    /*
     * Where the local storage driver puts uploaded files. No source in it, and
     * the tests write and delete directories there while they run, so linting
     * it fails the whole gate with ENOENT on a directory a test has just
     * removed. That is a lint run failing for a reason unrelated to lint.
     */
    ".uploads/**",
  ]),
]);

export default eslintConfig;
