import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Emits .next/standalone with a self-contained server.js and only the
   * node_modules actually reached by the build. docker/web.Dockerfile copies
   * that folder and runs it — without this setting, the image build fails at
   * the COPY step.
   */
  output: 'standalone',

  /**
   * Trace from the monorepo root, not apps/web.
   *
   * Next traces from the project directory by default, so in a workspace setup
   * it would miss the hoisted node_modules at the repository root and produce a
   * standalone bundle that crashes on a missing module at runtime rather than
   * failing the build.
   *
   * Because the trace root is the repo root, the output preserves the workspace
   * path: the entrypoint lands at .next/standalone/apps/web/server.js, which is
   * what web.Dockerfile's CMD targets.
   *
   * process.cwd() is apps/web when built via `npm run build --workspace=@docuflow/web`
   * or from within the app directory.
   */
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
};

export default nextConfig;
