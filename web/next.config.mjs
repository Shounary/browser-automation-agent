import { fileURLToPath } from 'node:url';

// The backend's lockfile sits one level up; point Turbopack at this app.
const nextConfig = {
  agentRules: false,
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
  env: { NEXT_PUBLIC_AGENT_WS: process.env.AGENT_WS ?? 'ws://localhost:3001' },
};

export default nextConfig;
