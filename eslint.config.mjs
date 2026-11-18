import { defineConfig, globalIgnores } from "eslint/config";
import next_core_web_vitals from "eslint-config-next/core-web-vitals";
import next_typescript from "eslint-config-next/typescript";

export default defineConfig([
  ...next_core_web_vitals,
  ...next_typescript,
  {
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
