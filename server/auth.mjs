import * as oidc from 'openid-client';
import { randomBytes } from 'node:crypto';

export const sessionCookie = '__Host-homebase';
export const loginCookie = '__Host-homebase-login';
export function cookie(req, name) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return raw?.slice(name.length + 1) || null;
}
export function setCookie(name, value, maxAge) { return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }

export class Auth {
  constructor(config, store) { this.config = config; this.store = store; this.discovery = null; }
  async client() {
    if (!this.config?.issuer) throw new Error('Sign-in is not configured.');
    if (!this.discovery) this.discovery = oidc.discovery(new URL(this.config.issuer), this.config.clientId, this.config.clientSecret).catch(error => { this.discovery = null; throw error; });
    return this.discovery;
  }
  async begin() {
    const config = await this.client(), verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
    const browser = randomBytes(32).toString('base64url');
    this.store.login(browser, { verifier, state, nonce });
    const url = oidc.buildAuthorizationUrl(config, { redirect_uri: this.config.callback, scope: 'openid profile email', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce });
    return { browser, url: url.href };
  }
  async complete(browser, requestUrl) {
    if (!browser) throw new Error('Sign-in expired.');
    const flow = this.store.consumeLogin(browser);
    if (!flow) throw new Error('Sign-in expired.');
    const config = await this.client();
    const tokens = await oidc.authorizationCodeGrant(config, new URL(requestUrl), { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
    const claims = tokens.claims();
    const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    if (!this.config.allowedUsers?.includes(info.preferred_username)) throw new Error('This account does not have access to Homebase.');
    return this.store.session({ id: info.sub, name: info.name || info.preferred_username, username: info.preferred_username });
  }
}
