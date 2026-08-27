import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The example consumes the package from source so `npm run dev` picks up edits.
  resolve: { alias: { "react-render-detective": new URL("../../src/index.ts", import.meta.url).pathname } },
});
