import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PUBLIC_URL = 'https://weather.example.com';
let child: ChildProcessWithoutNullStreams;
let port: number;
let temporaryDirectory: string;
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
  throw new Error(`OAuth HTTP server did not start. stderr: ${stderr}`);
}

describe('Google OAuth discovery and dynamic client registration', () => {
  beforeAll(async () => {
    port = await freePort();
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'weather-mcp-oauth-test-'));
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_HOST: '127.0.0.1',
        PORT: String(port),
        MCP_PUBLIC_URL: PUBLIC_URL,
        MCP_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
        MCP_GOOGLE_CLIENT_SECRET: 'test-client-secret',
        MCP_GOOGLE_ALLOWED_EMAILS: '["owner@example.com"]',
        MCP_OAUTH_STORE_PATH: join(temporaryDirectory, 'oauth.json'),
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
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 5_000))
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('advertises OAuth and the DCR endpoint', async () => {
    const protectedResource = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`
    );
    expect(protectedResource.status).toBe(200);
    await expect(protectedResource.json()).resolves.toMatchObject({
      resource: `${PUBLIC_URL}/mcp`,
      authorization_servers: [`${PUBLIC_URL}/`],
      scopes_supported: ['mcp:tools']
    });

    const authorizationServer = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`
    );
    await expect(authorizationServer.json()).resolves.toMatchObject({
      issuer: `${PUBLIC_URL}/`,
      registration_endpoint: `${PUBLIC_URL}/register`,
      code_challenge_methods_supported: ['S256']
    });
  });

  it('registers a client and starts Google authorization', async () => {
    const registration = await fetch(`http://127.0.0.1:${port}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'OAuth integration test',
        redirect_uris: ['http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };
    expect(registered.client_id).toBeTruthy();

    const authorize = new URL(`http://127.0.0.1:${port}/authorize`);
    authorize.searchParams.set('client_id', registered.client_id);
    authorize.searchParams.set('redirect_uri', 'http://127.0.0.1/callback');
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('code_challenge', 'test-code-challenge');
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('scope', 'mcp:tools');
    authorize.searchParams.set('resource', `${PUBLIC_URL}/mcp`);
    const response = await fetch(authorize, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const google = new URL(response.headers.get('location')!);
    expect(google.origin).toBe('https://accounts.google.com');
    expect(google.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/oauth/callback`);
  });

  it('returns discoverable OAuth metadata with unauthenticated MCP responses', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`
    );
  });
});
