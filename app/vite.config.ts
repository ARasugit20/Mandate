import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// `vite --mode fixtures` turns on fixture data without needing an .env file.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: mode === "fixtures" ? { "import.meta.env.VITE_FIXTURES": JSON.stringify("1") } : {},
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "../shared"),
    },
  },
  server: { port: 5173, strictPort: true },
}));
