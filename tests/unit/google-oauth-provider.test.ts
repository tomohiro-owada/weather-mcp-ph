import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({ mocked: true })),
  jwtVerify: vi.fn(async () => ({
    payload: { email: 'owner@example.com', email_verified: true }
  }))
}));

import { GoogleOAuthProvider } from '../../src/auth/googleOAuthProvider.js';

const RESOURCE_URL = new URL('https://weather.example.com/mcp');
const REDIRECT_URI = 'http://127.0.0.1/callback';
let temporaryDirectory: string;

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('GoogleOAuthProvider', () => {
  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'weather-oauth-provider-test-'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id_token: 'mock-google-id-token' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('issues, verifies, refreshes, and revokes audience-bound tokens', async () => {
    const provider = new GoogleOAuthProvider({
      clientId: 'google-client.apps.googleusercontent.com',
      clientSecret: 'google-client-secret',
      callbackUrl: new URL('https://weather.example.com/oauth/callback'),
      resourceUrl: RESOURCE_URL,
      allowedEmails: ['owner@example.com'],
      storePath: join(temporaryDirectory, 'oauth.json')
    });
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    });
    const verifier = 'test-code-verifier-with-at-least-forty-three-characters-123';
    let googleRedirect = '';
    await provider.authorize(client, {
      redirectUri: REDIRECT_URI,
      codeChallenge: challengeFor(verifier),
      state: 'client-state',
      scopes: ['mcp:tools'],
      resource: RESOURCE_URL
    }, { redirect: (url: string) => { googleRedirect = url; } } as unknown as Response);

    const googleState = new URL(googleRedirect).searchParams.get('state');
    expect(googleState).toBeTruthy();
    const clientRedirect = await provider.handleGoogleCallback(new URLSearchParams({
      state: googleState!,
      code: 'mock-google-code'
    }));
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(REDIRECT_URI);
    expect(clientRedirect.searchParams.get('state')).toBe('client-state');
    const authorizationCode = clientRedirect.searchParams.get('code')!;
    await expect(provider.challengeForAuthorizationCode(client, authorizationCode))
      .resolves.toBe(challengeFor(verifier));

    const tokens = await provider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      REDIRECT_URI,
      RESOURCE_URL
    );
    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect(auth).toMatchObject({
      clientId: client.client_id,
      scopes: ['mcp:tools'],
      extra: { email: 'owner@example.com' }
    });
    expect(auth.resource?.href).toBe(RESOURCE_URL.href);

    const refreshed = await provider.exchangeRefreshToken(
      client,
      tokens.refresh_token!,
      undefined,
      RESOURCE_URL
    );
    await expect(provider.exchangeRefreshToken(
      client,
      tokens.refresh_token!,
      undefined,
      RESOURCE_URL
    )).rejects.toThrow(/Invalid or expired refresh token/);
    await provider.revokeToken(client, { token: refreshed.access_token });
    await expect(provider.verifyAccessToken(refreshed.access_token))
      .rejects.toThrow(/Invalid or expired access token/);
  });

  it('rejects an authorization code for a different resource', async () => {
    const provider = new GoogleOAuthProvider({
      clientId: 'google-client.apps.googleusercontent.com',
      clientSecret: 'google-client-secret',
      callbackUrl: new URL('https://weather.example.com/oauth/callback'),
      resourceUrl: RESOURCE_URL,
      allowedEmails: ['owner@example.com'],
      storePath: join(temporaryDirectory, 'oauth.json')
    });
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none'
    });
    let googleRedirect = '';
    await provider.authorize(client, {
      redirectUri: REDIRECT_URI,
      codeChallenge: 'challenge',
      scopes: ['mcp:tools'],
      resource: RESOURCE_URL
    }, { redirect: (url: string) => { googleRedirect = url; } } as unknown as Response);
    const state = new URL(googleRedirect).searchParams.get('state')!;
    const redirect = await provider.handleGoogleCallback(
      new URLSearchParams({ state, code: 'mock-google-code' })
    );
    const authorizationCode = redirect.searchParams.get('code')!;
    await expect(provider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      REDIRECT_URI,
      new URL('https://attacker.example/mcp')
    )).rejects.toThrow(/Invalid or expired authorization code/);
  });
});
