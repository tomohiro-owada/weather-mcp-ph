import type { Response } from 'express';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  AuthorizationParams,
  OAuthServerProvider
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_SCOPES = 'openid email profile';
const MCP_SCOPE = 'mcp:tools';
const AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

interface PendingGoogleAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface AuthorizationCodeRecord extends PendingGoogleAuthorization {
  email: string;
}

interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  email: string;
  expiresAt: number;
}

interface RefreshTokenRecord extends AccessTokenRecord {}

interface OAuthStoreData {
  clients: Record<string, OAuthClientInformationFull>;
  pendingGoogle: Record<string, PendingGoogleAuthorization>;
  authorizationCodes: Record<string, AuthorizationCodeRecord>;
  accessTokens: Record<string, AccessTokenRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
}

export interface GoogleOAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  callbackUrl: URL;
  resourceUrl: URL;
  allowedEmails: string[];
  storePath: string;
}

function emptyStore(): OAuthStoreData {
  return {
    clients: {},
    pendingGoogle: {},
    authorizationCodes: {},
    accessTokens: {},
    refreshTokens: {}
  };
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sameResource(actual: URL | undefined, expected: string): boolean {
  if (!actual) return true;
  const normalized = new URL(actual.href);
  normalized.hash = '';
  return normalized.href === expected;
}

export class GoogleOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = false;
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #callbackUrl: URL;
  readonly #resourceUrl: URL;
  readonly #allowedEmails: Set<string>;
  readonly #storePath: string;
  readonly #googleJwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
  #data: OAuthStoreData;

  constructor(options: GoogleOAuthProviderOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#callbackUrl = options.callbackUrl;
    this.#resourceUrl = new URL(options.resourceUrl.href);
    this.#resourceUrl.hash = '';
    this.#allowedEmails = new Set(options.allowedEmails.map(email => email.trim().toLowerCase()));
    this.#storePath = options.storePath;
    this.#data = this.#load();
    this.#prune();

    this.clientsStore = {
      getClient: clientId => this.#data.clients[clientId],
      registerClient: client => {
        const registered: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000)
        };
        this.#data.clients[registered.client_id] = registered;
        this.#save();
        return registered;
      }
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    this.#prune();
    const scopes = params.scopes?.length ? params.scopes : [MCP_SCOPE];
    if (scopes.some(scope => scope !== MCP_SCOPE)) {
      throw new InvalidScopeError(`Only the ${MCP_SCOPE} scope is supported`);
    }
    if (!sameResource(params.resource, this.#resourceUrl.href)) {
      throw new InvalidTargetError('The requested resource does not match this MCP server');
    }

    const googleState = opaqueToken();
    this.#data.pendingGoogle[tokenHash(googleState)] = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes,
      resource: this.#resourceUrl.href,
      expiresAt: Date.now() + AUTHORIZATION_LIFETIME_MS
    };
    this.#save();

    const url = new URL(GOOGLE_AUTHORIZATION_URL);
    url.searchParams.set('client_id', this.#clientId);
    url.searchParams.set('redirect_uri', this.#callbackUrl.href);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPES);
    url.searchParams.set('state', googleState);
    url.searchParams.set('prompt', 'select_account');
    res.redirect(url.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    this.#prune();
    const record = this.#data.authorizationCodes[tokenHash(authorizationCode)];
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    this.#prune();
    const key = tokenHash(authorizationCode);
    const record = this.#data.authorizationCodes[key];
    delete this.#data.authorizationCodes[key];
    if (
      !record ||
      record.clientId !== client.client_id ||
      (redirectUri !== undefined && redirectUri !== record.redirectUri) ||
      !sameResource(resource, record.resource)
    ) {
      this.#save();
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    const tokens = this.#issueTokens(record.clientId, record.scopes, record.resource, record.email);
    this.#save();
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.#prune();
    const key = tokenHash(refreshToken);
    const record = this.#data.refreshTokens[key];
    delete this.#data.refreshTokens[key];
    const requestedScopes = scopes?.length ? scopes : record?.scopes;
    if (
      !record ||
      record.clientId !== client.client_id ||
      !requestedScopes ||
      requestedScopes.some(scope => !record.scopes.includes(scope)) ||
      !sameResource(resource, record.resource)
    ) {
      this.#save();
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    const tokens = this.#issueTokens(
      record.clientId,
      requestedScopes,
      record.resource,
      record.email
    );
    this.#save();
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.#prune();
    const record = this.#data.accessTokens[tokenHash(token)];
    if (!record || record.expiresAt <= Date.now()) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(record.resource),
      extra: { email: record.email }
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const key = tokenHash(request.token);
    const access = this.#data.accessTokens[key];
    const refresh = this.#data.refreshTokens[key];
    if (access?.clientId === client.client_id) delete this.#data.accessTokens[key];
    if (refresh?.clientId === client.client_id) delete this.#data.refreshTokens[key];
    this.#save();
  }

  async handleGoogleCallback(query: URLSearchParams): Promise<URL> {
    this.#prune();
    const state = query.get('state');
    if (!state) throw new Error('Missing OAuth state');
    const pendingKey = tokenHash(state);
    const pending = this.#data.pendingGoogle[pendingKey];
    delete this.#data.pendingGoogle[pendingKey];
    this.#save();
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new Error('Invalid or expired OAuth state');
    }

    const googleError = query.get('error');
    if (googleError) {
      return this.#clientErrorRedirect(pending, 'access_denied');
    }
    const code = query.get('code');
    if (!code) return this.#clientErrorRedirect(pending, 'access_denied');

    try {
      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
          redirect_uri: this.#callbackUrl.href
        }),
        signal: AbortSignal.timeout(20_000)
      });
      const tokenBody = await tokenResponse.json() as { id_token?: string };
      if (!tokenResponse.ok || !tokenBody.id_token) {
        return this.#clientErrorRedirect(pending, 'access_denied');
      }
      const verified = await jwtVerify(tokenBody.id_token, this.#googleJwks, {
        audience: this.#clientId,
        issuer: ['https://accounts.google.com', 'accounts.google.com']
      });
      const email = typeof verified.payload.email === 'string'
        ? verified.payload.email.toLowerCase()
        : '';
      if (verified.payload.email_verified !== true || !this.#allowedEmails.has(email)) {
        return this.#clientErrorRedirect(pending, 'access_denied');
      }

      const authorizationCode = opaqueToken();
      this.#data.authorizationCodes[tokenHash(authorizationCode)] = {
        ...pending,
        email
      };
      this.#save();
      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set('code', authorizationCode);
      if (pending.state) redirect.searchParams.set('state', pending.state);
      return redirect;
    } catch {
      return this.#clientErrorRedirect(pending, 'server_error');
    }
  }

  #clientErrorRedirect(
    pending: PendingGoogleAuthorization,
    error: 'access_denied' | 'server_error'
  ): URL {
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('error', error);
    if (pending.state) redirect.searchParams.set('state', pending.state);
    return redirect;
  }

  #issueTokens(clientId: string, scopes: string[], resource: string, email: string): OAuthTokens {
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    const now = Date.now();
    this.#data.accessTokens[tokenHash(accessToken)] = {
      clientId,
      scopes,
      resource,
      email,
      expiresAt: now + ACCESS_TOKEN_LIFETIME_SECONDS * 1000
    };
    this.#data.refreshTokens[tokenHash(refreshToken)] = {
      clientId,
      scopes,
      resource,
      email,
      expiresAt: now + REFRESH_TOKEN_LIFETIME_MS
    };
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      scope: scopes.join(' '),
      refresh_token: refreshToken
    };
  }

  #load(): OAuthStoreData {
    if (!existsSync(this.#storePath)) return emptyStore();
    try {
      const parsed = JSON.parse(readFileSync(this.#storePath, 'utf8')) as Partial<OAuthStoreData>;
      return {
        clients: parsed.clients ?? {},
        pendingGoogle: parsed.pendingGoogle ?? {},
        authorizationCodes: parsed.authorizationCodes ?? {},
        accessTokens: parsed.accessTokens ?? {},
        refreshTokens: parsed.refreshTokens ?? {}
      };
    } catch {
      throw new Error(`Unable to read OAuth store at ${this.#storePath}`);
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#storePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#storePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.#data), { mode: 0o600 });
    renameSync(temporaryPath, this.#storePath);
  }

  #prune(): void {
    const now = Date.now();
    let changed = false;
    for (const collection of [
      this.#data.pendingGoogle,
      this.#data.authorizationCodes,
      this.#data.accessTokens,
      this.#data.refreshTokens
    ]) {
      for (const [key, value] of Object.entries(collection)) {
        if (value.expiresAt <= now) {
          delete collection[key];
          changed = true;
        }
      }
    }
    if (changed) this.#save();
  }
}

export const GOOGLE_OAUTH_SCOPE = MCP_SCOPE;
