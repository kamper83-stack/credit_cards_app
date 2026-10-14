import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.VITE_BASE_URL ?? "/credit_cards_app/",
  plugins: [react()],
  server: {
    proxy: {
      // changeOrigin must stay false: the server's CSRF check compares the browser's Origin
      // (http://localhost:5173) with the Host header, so the proxy must not rewrite Host to :3001.
      "/api": { target: "http://localhost:3001", changeOrigin: false },
    },
  },
});
