// Minimal ESLint setup: the react-hooks rules are the point.
// rules-of-hooks as an ERROR is the automated guard against the
// React #310 crash class (hooks after conditional returns), which
// typecheck/unit tests/build cannot catch. Added 2026-10-26 after
// the F7 workspace-modal hooks shipped below AuthedApp's early
// returns and blanked the app on every login.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
