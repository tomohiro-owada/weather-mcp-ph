import { createServer } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TOKEN = 'integration-test-token-with-enough-entropy';
let child: ChildProcessWithoutNullStreams;
let port: number;
let stderr = '';

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate test port');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`HTTP server did not start. stderr: ${stderr}`);
}

describe('Streamable HTTP transport', () => {
  beforeAll(async () => {
    port = await freePort();
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_HOST: '127.0.0.1',
        PORT: String(port),
        MCP_AUTH_TOKEN: TOKEN,
        ENABLED_TOOLS: 'basic',
        ANALYTICS_ENABLED: 'false',
        WEATHER_LIGHTNING_PREWARM: 'false',
        LOG_LEVEL: 'ERROR'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    await waitUntilReady();
  }, 15_000);

  afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise(resolve => setTimeout(resolve, 5_000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  it('rejects an unauthenticated MCP initialization', async () => {
    const client = new Client({ name: 'unauthorized-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    );
    await expect(client.connect(transport)).rejects.toThrow(/401|Unauthorized/i);
  });

  it('initializes a session and lists tools with a bearer token', async () => {
    const client = new Client({ name: 'authorized-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }
    );
    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.map(tool => tool.name)).toContain('get_weather_summary');
    await client.close();
  });
});
