export default {
  input: "openapi.yaml",
  output: {
    path: "packages/core/src/generated",
    tsConfigPath: "packages/core/tsconfig.json",
    module: {
      extension: ".js",
    },
  },
  plugins: ["@hey-api/client-fetch"],
};
