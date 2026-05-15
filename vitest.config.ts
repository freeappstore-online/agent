import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    reporters: ["default", "json"],
    outputFile: { json: "test-results/results.json" },
  },
});
