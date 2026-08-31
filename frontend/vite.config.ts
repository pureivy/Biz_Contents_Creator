import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 프로덕션: `vite build` → dist/ 를 백엔드(Hono)가 같은 오리진(/)에서 서빙(프록시 불필요).
// 개발(`pnpm dev`): 아래 프록시로 API/SSE 를 biz-contents-creator 백엔드(:8787)로 보냄.
const target = "http://localhost:8787";
const proxy = Object.fromEntries(
  ["/runs", "/llm", "/company", "/wiki", "/approvals", "/sources", "/templates",
   "/mcp", "/api-keys", "/sync", "/agents", "/healthz", "/voice", "/jarvis"].map((p) => [
    p, { target, changeOrigin: true },
  ]),
);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  build: { outDir: "dist", emptyOutDir: true },
});
