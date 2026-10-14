import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
  server: {
    proxy: {
      // changeOrigin must stay false: the server's CSRF check compares the browser's Origin
      // (http://localhost:5173) with the Host header, so the proxy must not rewrite Host to :3001.
      "/api": { target: "http://localhost:3001", changeOrigin: false },
    },
  },
});
