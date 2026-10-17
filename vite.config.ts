import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { version } from "./package.json";

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  clearScreen: false,
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    restoreMocks: true,
  },
});
