import { mkdir } from 'node:fs/promises';

export function launchOptions() {
  return process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {};
}

export async function traceStart(context) {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
}

export async function traceFinish(context, scenario, failed) {
  if (!failed) return context.tracing.stop();
  await mkdir('test-results/traces', { recursive: true });
  const path = `test-results/traces/${scenario}-${process.env.GITHUB_SHA || 'local'}.zip`;
  await context.tracing.stop({ path });
  console.error('Playwright trace:', path);
}
