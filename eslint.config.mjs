import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
  ]),
  {
    // Monorepo: tell the Next.js rules where each app lives.
    settings: { next: { rootDir: ["apps/frontend/", "apps/backend/"] } },
  },
  {
    rules: {
      // Calling load() / fetch() inside useEffect is the correct pattern for
      // data fetching — this rule produces false positives for this codebase.
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
