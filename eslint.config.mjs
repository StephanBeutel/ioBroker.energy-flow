import iobrokerConfig from "@iobroker/eslint-config";
export default [
  ...iobrokerConfig,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
