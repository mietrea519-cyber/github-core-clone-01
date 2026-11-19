// Entry lifecycle for the forge: this process is a server, not a script.
// It binds an ephemeral port, tells the env where it lives, then stays up
// until the env says the trial is finished, and only then exits.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  process.stderr.write('MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const TIMEOUT_MS = 30_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backoff between attempts: 250ms, doubling, never more than 2s.
function backoff(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** Math.min(attempt, 8));
}

// Tell the env which port we bound. The first registration wins, so a 409
// is as good as a 200 here; a 400 or 405 means we misunderstood the
// contract and there is nothing to retry.
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let fatal: Error | null = null;
    try {
      const res = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        fatal = new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch {
      // Network trouble or a timeout: the env may still be starting.
    }
    if (fatal) throw fatal;
    await pause(backoff(attempt));
  }
}

// Ask the env, again and again, whether the trial is over. Any failure
// simply means "not yet": this loop ends only on {"done": true}.
async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answered yet; keep waiting.
    }
    await pause(backoff(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const bound = server.address();
if (bound === null || typeof bound === 'string') {
  process.stderr.write('the server did not bind an ephemeral TCP port\n');
  process.exit(1);
}
process.stdout.write(`listening on port ${bound.port}\n`);
await announce(bound.port);
process.stdout.write('registered; waiting for the env to say done\n');
await untilDone();
server.close();
process.stdout.write('done\n');
process.exit(0);
