/**
 * lichessAuth.js — OAuth 2.0 + PKCE flow for Lichess.
 *
 * Used by the Lichess study import to access PRIVATE studies (the public
 * /api/study/<id>.pgn endpoint already works without auth). On success,
 * future fetches add `Authorization: Bearer <token>` and Lichess returns
 * private-study PGN as well as public.
 *
 * Why PKCE: Lichess treats us as a public client (no client_secret), so
 * PKCE is the only safe option — without it, a malicious page could
 * intercept the auth code via a crafted redirect and exchange it for a
 * token. PKCE bind the token exchange to a random verifier this tab
 * generated, so even with the auth code in hand an attacker can't
 * exchange it without the verifier (which never leaves this tab).
 *
 * Why state: CSRF guard. Without state, a malicious site could bait the
 * user into redirecting to lichess.org/oauth?... with the attacker's
 * client_id and a redirect_uri pointing back to OUR app, then we'd
 * receive THEIR code and exchange it — connecting their account on the
 * user's machine. The state nonce ensures we only complete exchanges we
 * actually initiated.
 *
 * Storage:
 *   localStorage:
 *     puzzle_explorer_lichess_oauth = { accessToken, expiresAt, username }
 *   sessionStorage (per-tab, in-flight only):
 *     puzzle_explorer_lichess_oauth_session = { verifier, state }
 *
 * Lichess endpoints:
 *   Auth:    GET https://lichess.org/oauth?response_type=code&...
 *   Token:   POST https://lichess.org/api/token (urlencoded)
 *   Revoke:  DELETE https://lichess.org/api/token (Bearer auth)
 *   Account: GET https://lichess.org/api/account (Bearer auth)
 *
 * Loaded in Node via:    const LichessAuth = require('../lib/lichessAuth');
 * Loaded in browser via: <script src="lib/lichessAuth.js"></script>
 *                         (defines window.LichessAuth)
 *
 * Most of this module assumes a browser context (window, localStorage,
 * sessionStorage, crypto.subtle, fetch, history.replaceState). Node-side
 * tests cover the pure helpers (base64UrlEncode, callback URL parsing,
 * token storage round-trips with a memory backing) but skip the crypto/
 * network paths.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    authorizationUrl:  'https://lichess.org/oauth',
    tokenUrl:          'https://lichess.org/api/token',
    accountUrl:        'https://lichess.org/api/account',
    scopes:            ['study:read'],
    storageKey:        'puzzle_explorer_lichess_oauth',
    sessionStorageKey: 'puzzle_explorer_lichess_oauth_session'
  };

  // ─── configuration ────────────────────────────────────────────────────────
  // configure() must be called once at app start before anything else. The
  // clientId can be any string Lichess will accept; per Lichess convention
  // it's typically a URL pointing to the app's homepage so users see what
  // they're authorizing during the consent screen.
  var config = null;
  function configure(opts) {
    if (!opts || typeof opts !== 'object') throw new Error('LichessAuth.configure: opts required');
    if (!opts.clientId) throw new Error('LichessAuth.configure: opts.clientId required');
    if (!opts.redirectUri) throw new Error('LichessAuth.configure: opts.redirectUri required');
    config = {
      authorizationUrl:  opts.authorizationUrl  || DEFAULTS.authorizationUrl,
      tokenUrl:          opts.tokenUrl          || DEFAULTS.tokenUrl,
      accountUrl:        opts.accountUrl        || DEFAULTS.accountUrl,
      clientId:          opts.clientId,
      redirectUri:       opts.redirectUri,
      scopes:            opts.scopes            || DEFAULTS.scopes,
      storageKey:        opts.storageKey        || DEFAULTS.storageKey,
      sessionStorageKey: opts.sessionStorageKey || DEFAULTS.sessionStorageKey,
      // Storage adapters — defaults read from window.* but can be swapped
      // in tests for an in-memory shim.
      _localStorage:   opts._localStorage   || (typeof localStorage   !== 'undefined' ? localStorage   : null),
      _sessionStorage: opts._sessionStorage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null),
      // now() seam for testing token-expiry logic deterministically.
      _now: opts._now || function () { return Date.now(); }
    };
  }
  function _requireConfig() {
    if (!config) throw new Error('LichessAuth not configured — call LichessAuth.configure() first');
  }

  // ─── encoding helpers ─────────────────────────────────────────────────────
  // RFC 4648 §5 base64url: + → -, / → _, strip = padding. Used for both the
  // PKCE verifier (random bytes → string) and challenge (sha256 hash bytes →
  // string).
  function base64UrlEncode(bytes) {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    if (bytes && typeof bytes.length === 'number' && !(bytes instanceof Uint8Array)) {
      // Buffer or array-of-numbers → Uint8Array
      bytes = new Uint8Array(bytes);
    }
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var b64;
    if (typeof btoa !== 'undefined') {
      b64 = btoa(bin);
    } else {
      // Node fallback for tests
      b64 = Buffer.from(bin, 'binary').toString('base64');
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // ─── PKCE primitives ──────────────────────────────────────────────────────
  function _randomBytes(n) {
    var arr = new Uint8Array(n);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
      return arr;
    }
    // Node fallback
    var nodeCrypto = require('crypto');
    var buf = nodeCrypto.randomBytes(n);
    for (var i = 0; i < n; i++) arr[i] = buf[i];
    return arr;
  }
  // 32 random bytes → 43-char base64url string. PKCE spec requires
  // 43–128 chars; 43 is the minimum and produced from 32 bytes which
  // is the recommended entropy.
  function generateVerifier() {
    return base64UrlEncode(_randomBytes(32));
  }
  function generateState() {
    return base64UrlEncode(_randomBytes(16));
  }
  // Browser-only — uses crypto.subtle. Node test path uses computeChallengeNode.
  async function computeChallenge(verifier) {
    var bytes = new TextEncoder().encode(verifier);
    var hash = await crypto.subtle.digest('SHA-256', bytes);
    return base64UrlEncode(hash);
  }
  // Node test convenience — synchronous, uses node:crypto. Not exposed on
  // the browser path because the browser lacks a sync sha256 primitive
  // and we don't want to ship a JS sha256 implementation.
  function computeChallengeNode(verifier) {
    var nodeCrypto = require('crypto');
    var hash = nodeCrypto.createHash('sha256').update(verifier, 'utf8').digest();
    return base64UrlEncode(hash);
  }

  // ─── token storage ────────────────────────────────────────────────────────
  // Rejects non-object / missing-accessToken payloads silently — corrupted
  // LS shouldn't crash the app, just look "logged out".
  function _loadToken() {
    _requireConfig();
    if (!config._localStorage) return null;
    try {
      var raw = config._localStorage.getItem(config.storageKey);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }
  function _saveToken(record) {
    _requireConfig();
    if (!config._localStorage) return false;
    try {
      config._localStorage.setItem(config.storageKey, JSON.stringify(record));
      return true;
    } catch (e) {
      return false;
    }
  }
  function _clearToken() {
    _requireConfig();
    if (!config._localStorage) return;
    try { config._localStorage.removeItem(config.storageKey); } catch (e) { /* ignore */ }
  }

  // ─── public read-only API ─────────────────────────────────────────────────
  function isAuthenticated() {
    return getToken() !== null;
  }
  function getToken() {
    var t = _loadToken();
    if (!t) return null;
    if (t.expiresAt && t.expiresAt < config._now()) {
      // Expired — proactively clear so callers don't see a stale token.
      _clearToken();
      return null;
    }
    return t.accessToken;
  }
  function getUsername() {
    var t = _loadToken();
    if (!t) return null;
    if (t.expiresAt && t.expiresAt < config._now()) return null;
    return t.username || null;
  }
  function authHeader() {
    var token = getToken();
    return token ? { Authorization: 'Bearer ' + token } : null;
  }

  // ─── auth flow ────────────────────────────────────────────────────────────
  // Redirects the page to Lichess. After consent, Lichess redirects back to
  // config.redirectUri with ?code=...&state=... appended; handleCallback()
  // processes that on next page load.
  async function startAuthFlow() {
    _requireConfig();
    if (!config._sessionStorage) {
      throw new Error('LichessAuth.startAuthFlow: sessionStorage unavailable');
    }
    var verifier = generateVerifier();
    var state = generateState();
    var challenge = await computeChallenge(verifier);
    config._sessionStorage.setItem(config.sessionStorageKey, JSON.stringify({
      verifier: verifier,
      state: state
    }));
    var params = new URLSearchParams({
      response_type:         'code',
      client_id:             config.clientId,
      redirect_uri:          config.redirectUri,
      code_challenge_method: 'S256',
      code_challenge:        challenge,
      scope:                 config.scopes.join(' '),
      state:                 state
    });
    window.location.href = config.authorizationUrl + '?' + params.toString();
  }

  // Pure helper: parse a URL string and return relevant OAuth params.
  // Exposed so Node tests can verify parsing without DOM.
  function parseCallbackUrl(urlString) {
    try {
      var u = new URL(urlString);
      return {
        code:  u.searchParams.get('code'),
        state: u.searchParams.get('state'),
        error: u.searchParams.get('error'),
        errorDescription: u.searchParams.get('error_description')
      };
    } catch (e) {
      return { code: null, state: null, error: null, errorDescription: null };
    }
  }

  // Browser-only — strips OAuth params from the URL bar without reload.
  function _cleanCallbackParams() {
    if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
    var u = new URL(window.location.href);
    u.searchParams.delete('code');
    u.searchParams.delete('state');
    u.searchParams.delete('error');
    u.searchParams.delete('error_description');
    var clean = u.pathname + (u.search ? u.search : '') + u.hash;
    window.history.replaceState(null, '', clean);
  }

  // Detect a callback in the current URL and exchange the code for a token.
  // Returns one of:
  //   { status: 'no_callback' }                             nothing to do
  //   { status: 'success',  username: <string|null> }       token saved
  //   { status: 'denied' }                                  user clicked Deny
  //   { status: 'error', message: <string> }                anything else
  //
  // The URL is cleaned of OAuth params at the very start of any non-noop
  // path, so refreshing the page during the exchange (or after a stale
  // ?code= URL is left around) does NOT re-attempt the exchange. Codes
  // are single-use anyway; the only sane behavior on refresh is to start
  // over.
  async function handleCallback() {
    _requireConfig();
    var parsed = parseCallbackUrl(window.location.href);
    // No oauth-relevant params → nothing to do, no URL mutation needed.
    if (!parsed.code && !parsed.error) return { status: 'no_callback' };
    // Clean URL FIRST so any later refresh sees a fresh slate. We do this
    // before any await — the URL change is synchronous via replaceState,
    // and we want it to win against the user pressing F5 mid-exchange.
    _cleanCallbackParams();

    if (parsed.error) {
      if (config._sessionStorage) {
        try { config._sessionStorage.removeItem(config.sessionStorageKey); } catch (e) {}
      }
      // Lichess uses 'access_denied' when the user clicks Deny. Surface a
      // friendlier outcome for that one case so the UI can avoid an
      // alarming "ERROR" banner for a benign decision.
      if (parsed.error === 'access_denied') return { status: 'denied' };
      return { status: 'error', message: parsed.errorDescription || parsed.error };
    }
    // parsed.code is set (we returned early on no-code-no-error above).

    if (!config._sessionStorage) {
      return { status: 'error', message: 'sessionStorage unavailable — cannot complete auth flow' };
    }
    var session = null;
    try {
      var raw = config._sessionStorage.getItem(config.sessionStorageKey);
      if (raw) session = JSON.parse(raw);
    } catch (e) { session = null; }

    if (!session || typeof session.verifier !== 'string' || typeof session.state !== 'string') {
      // Session lost (e.g. user opened the callback URL in a new tab, or
      // sessionStorage was cleared). The code is unusable without our
      // verifier, so abandon.
      return { status: 'error', message: 'Lost session state — please connect again.' };
    }
    if (parsed.state !== session.state) {
      try { config._sessionStorage.removeItem(config.sessionStorageKey); } catch (e) {}
      return { status: 'error', message: 'State mismatch — possible CSRF, please try again.' };
    }
    // Consume session-side state regardless of token-exchange outcome.
    try { config._sessionStorage.removeItem(config.sessionStorageKey); } catch (e) {}

    var body = new URLSearchParams({
      grant_type:    'authorization_code',
      code:          parsed.code,
      redirect_uri:  config.redirectUri,
      client_id:     config.clientId,
      code_verifier: session.verifier
    });
    var data;
    try {
      var res = await fetch(config.tokenUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString()
      });
      if (!res.ok) {
        var errText;
        try { errText = await res.text(); } catch (e) { errText = ''; }
        return { status: 'error', message: 'Token exchange failed (' + res.status + '): ' + errText };
      }
      data = await res.json();
    } catch (e) {
      return { status: 'error', message: 'Network error during token exchange: ' + (e && e.message ? e.message : e) };
    }
    if (!data || typeof data.access_token !== 'string') {
      return { status: 'error', message: 'Token response missing access_token' };
    }
    var record = {
      accessToken: data.access_token,
      expiresAt:   (typeof data.expires_in === 'number') ? config._now() + data.expires_in * 1000 : null,
      username:    null
    };
    _saveToken(record);

    // Best-effort username fetch. Lichess /api/account returns the user's
    // profile including the username, which we cache for UI display ("Connected
    // as <name>"). A failure here doesn't fail the auth flow — the token is
    // already stored and usable.
    try {
      var accRes = await fetch(config.accountUrl, {
        headers: { Authorization: 'Bearer ' + record.accessToken }
      });
      if (accRes.ok) {
        var account = await accRes.json();
        if (account && typeof account.username === 'string') {
          record.username = account.username;
          _saveToken(record);
        }
      }
    } catch (e) { /* non-fatal */ }
    return { status: 'success', username: record.username };
  }

  // Revoke + clear. Best-effort revocation — even if the network call fails,
  // we still clear local state so the user sees themselves as signed out.
  async function signOut() {
    _requireConfig();
    var token = getToken();
    _clearToken();
    if (token && config.tokenUrl) {
      try {
        await fetch(config.tokenUrl, {
          method:  'DELETE',
          headers: { Authorization: 'Bearer ' + token }
        });
      } catch (e) { /* ignore */ }
    }
  }

  var api = {
    configure:        configure,
    isAuthenticated:  isAuthenticated,
    getToken:         getToken,
    getUsername:      getUsername,
    authHeader:       authHeader,
    startAuthFlow:    startAuthFlow,
    handleCallback:   handleCallback,
    signOut:          signOut,
    parseCallbackUrl: parseCallbackUrl,
    // Pure helpers exposed for tests.
    base64UrlEncode:     base64UrlEncode,
    generateVerifier:    generateVerifier,
    generateState:       generateState,
    computeChallengeNode: computeChallengeNode,
    // Test seams — expose just enough so analyzer tests can reset state.
    _resetForTests: function () { config = null; }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.LichessAuth = api;
  }
})(typeof self !== 'undefined' ? self : this);
