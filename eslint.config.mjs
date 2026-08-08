import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/ban-ts-comment": "off", "@typescript-eslint/no-require-imports": "off", "no-unused-expressions": "off", "@typescript-eslint/no-unused-expressions": "off", "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }] } },
);
