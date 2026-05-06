#!/usr/bin/env node
/**
 * lichess-auth-test.js — Test the Node-testable parts of lib/lichessAuth.
 *
 * Most of LichessAuth is browser-coupled (window, crypto.subtle, fetch,
 * history.replaceState, real localStorage). This suite covers what's
 * sensibly testable in Node:
 *   - configure() validation
 *   - base64UrlEncode round-trip and edge cases
 *   - generateVerifier / generateState entropy + format
 *   - computeChallengeNode (the Node sibling of computeChallenge — verifies
 *     the challenge encoding shape)
 *   - parseCallbackUrl on every relevant URL shape
 *   - Token storage round-trip with an in-memory localStorage shim
 *   - Token expiry + clear-on-expired behavior
 *   - Sign-out clears token even if network would fail
 *
 * Browser-only paths (handleCallback, startAuthFlow) are smoke-tested
 * manually in the browser — replicating fetch + crypto.subtle + history
 * in Node is more apparatus than insight.
 *
 * Run: node analyzer/lichess-auth-test.js
 */

const LichessAuth = require('../lib/lichessAuth');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// In-memory Storage shim that mimics the Storage interface enough for
// LichessAuth to work without a browser.
function memoryStorage() {
  const data = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
    _data: data
  };
}

function freshConfigure(overrides) {
  LichessAuth._resetForTests();
  LichessAuth.configure(Object.assign({
    clientId: 'puzzle-explorer-test',
    redirectUri: 'https://example.test/app/',
    _localStorage: memoryStorage(),
    _sessionStorage: memoryStorage(),
    _now: () => 1_700_000_000_000  // fixed deterministic clock
  }, overrides || {}));
}

// ─── configure() ──────────────────────────────────────────────────────────
section('configure()');
let threw;
LichessAuth._resetForTests();
threw = false;
try { LichessAuth.configure(); } catch (e) { threw = true; }
check('throws without opts', threw);
threw = false;
try { LichessAuth.configure({ redirectUri: 'x' }); } catch (e) { threw = true; }
check('throws without clientId', threw);
threw = false;
try { LichessAuth.configure({ clientId: 'x' }); } catch (e) { threw = true; }
check('throws without redirectUri', threw);
threw = false;
try { LichessAuth.configure({ clientId: 'x', redirectUri: 'y' }); } catch (e) { threw = true; }
check('does not throw with required fields', !threw);

LichessAuth._resetForTests();
threw = false;
try { LichessAuth.isAuthenticated(); } catch (e) { threw = true; }
check('API methods throw before configure', threw);

// ─── base64UrlEncode ─────────────────────────────────────────────────────
section('base64UrlEncode');
// Standard base64 of [0xff, 0xff, 0xff] = "////"; base64url = "____" (no pad).
check('basic 3-byte array', LichessAuth.base64UrlEncode(new Uint8Array([0xff, 0xff, 0xff])) === '____');
// "Hello" → "SGVsbG8" (no pad)
check('utf-8 ASCII', LichessAuth.base64UrlEncode(new TextEncoder().encode('Hello')) === 'SGVsbG8');
// Single byte 0x3e (>) and 0x3f (?) sit in the index where +/ would appear.
// Standard base64: 0x3e3f → "Pj8="; URL-safe: "Pj8" (no pad, special chars
// don't actually appear here since "Pj8" already only has alnum). Verify.
check('two bytes 0x3e 0x3f', LichessAuth.base64UrlEncode(new Uint8Array([0x3e, 0x3f])) === 'Pj8');
// Force a + → -: bytes producing "+" in standard b64. 0xfb 0xff = "+/8="
// → URL-safe "-_8".
check('plus → dash', LichessAuth.base64UrlEncode(new Uint8Array([0xfb, 0xff])) === '-_8');
// Empty input → empty string.
check('empty input', LichessAuth.base64UrlEncode(new Uint8Array([])) === '');
// ArrayBuffer input also works.
const buf = new ArrayBuffer(2);
new Uint8Array(buf)[0] = 0x68; // h
new Uint8Array(buf)[1] = 0x69; // i
check('ArrayBuffer input', LichessAuth.base64UrlEncode(buf) === 'aGk');

// ─── generateVerifier / generateState ────────────────────────────────────
section('generateVerifier / generateState');
const v1 = LichessAuth.generateVerifier();
const v2 = LichessAuth.generateVerifier();
check('verifier is string', typeof v1 === 'string');
check('verifier is 43 chars (32 random bytes → b64url)', v1.length === 43);
check('verifier matches RFC base64url alphabet', /^[A-Za-z0-9\-_]+$/.test(v1));
check('two verifiers differ (entropy check)', v1 !== v2);
const s1 = LichessAuth.generateState();
check('state is 22 chars (16 bytes → b64url)', s1.length === 22);
check('state matches alphabet', /^[A-Za-z0-9\-_]+$/.test(s1));

// ─── computeChallengeNode (PKCE sha256) ──────────────────────────────────
section('computeChallengeNode');
// Reference vector from RFC 7636 §4.2:
//   verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
//   challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
const refVerifier  = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const refChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
check('PKCE challenge matches RFC 7636 reference vector',
  LichessAuth.computeChallengeNode(refVerifier) === refChallenge,
  'got ' + LichessAuth.computeChallengeNode(refVerifier));
// Distinct verifiers produce distinct challenges.
check('different verifier → different challenge',
  LichessAuth.computeChallengeNode('aaaa') !== LichessAuth.computeChallengeNode('bbbb'));

// ─── parseCallbackUrl ────────────────────────────────────────────────────
section('parseCallbackUrl');
let p;
p = LichessAuth.parseCallbackUrl('https://example.test/app/?code=ABC&state=XYZ');
check('code + state parsed', p.code === 'ABC' && p.state === 'XYZ' && p.error === null);
p = LichessAuth.parseCallbackUrl('https://example.test/app/?error=access_denied');
check('error parsed', p.error === 'access_denied' && p.code === null);
p = LichessAuth.parseCallbackUrl('https://example.test/app/?error=invalid_request&error_description=bad%20stuff');
check('errorDescription parsed and decoded', p.errorDescription === 'bad stuff');
p = LichessAuth.parseCallbackUrl('https://example.test/app/');
check('no params → all null', p.code === null && p.state === null && p.error === null);
p = LichessAuth.parseCallbackUrl('https://example.test/app/?code=ABC&state=XYZ&other=1#hash');
check('hash and extra params ignored', p.code === 'ABC' && p.state === 'XYZ');
p = LichessAuth.parseCallbackUrl('not a url');
check('garbage URL → all null (no throw)', p.code === null && p.state === null && p.error === null);

// ─── token storage round-trip ────────────────────────────────────────────
section('token storage');
freshConfigure();
check('starts unauthenticated', !LichessAuth.isAuthenticated());
check('getToken returns null', LichessAuth.getToken() === null);
check('getUsername returns null', LichessAuth.getUsername() === null);
check('authHeader returns null', LichessAuth.authHeader() === null);

// Manually populate the storage shim to simulate a saved token without
// running the network exchange.
function injectToken(record) {
  // Reach into the configured _localStorage shim. Test code only — real
  // app uses the storage adapter exclusively via the LichessAuth API.
  // We don't expose a public seam for "set token directly" because no
  // production code path needs it.
  const ls = LichessAuth._configForTests ? LichessAuth._configForTests()._localStorage : null;
  // Without an exposed config getter, write through a fresh configure:
  const shim = memoryStorage();
  shim.setItem('puzzle_explorer_lichess_oauth', JSON.stringify(record));
  LichessAuth._resetForTests();
  LichessAuth.configure({
    clientId: 'puzzle-explorer-test',
    redirectUri: 'https://example.test/app/',
    _localStorage: shim,
    _sessionStorage: memoryStorage(),
    _now: () => 1_700_000_000_000
  });
}

injectToken({ accessToken: 'tok123', expiresAt: 1_700_000_999_999, username: 'alice' });
check('isAuthenticated true with valid token', LichessAuth.isAuthenticated());
check('getToken returns tok123', LichessAuth.getToken() === 'tok123');
check('getUsername returns alice', LichessAuth.getUsername() === 'alice');
check('authHeader returns Bearer tok123',
  JSON.stringify(LichessAuth.authHeader()) === JSON.stringify({ Authorization: 'Bearer tok123' }));

// Expired token: now > expiresAt
injectToken({ accessToken: 'old', expiresAt: 1_600_000_000_000, username: 'alice' });
check('expired token reads as not-authenticated', !LichessAuth.isAuthenticated());
check('expired token getToken returns null', LichessAuth.getToken() === null);
check('expired token getUsername returns null', LichessAuth.getUsername() === null);

// Token with no expiresAt is treated as non-expiring.
injectToken({ accessToken: 'foreverToken', expiresAt: null, username: 'bob' });
check('null expiresAt → never expires', LichessAuth.isAuthenticated());
check('null expiresAt → token returned', LichessAuth.getToken() === 'foreverToken');

// Corrupt LS payloads → unauthenticated, no crash.
function injectRaw(s) {
  const shim = memoryStorage();
  shim.setItem('puzzle_explorer_lichess_oauth', s);
  LichessAuth._resetForTests();
  LichessAuth.configure({
    clientId: 'puzzle-explorer-test',
    redirectUri: 'https://example.test/app/',
    _localStorage: shim,
    _sessionStorage: memoryStorage(),
    _now: () => 1_700_000_000_000
  });
}
injectRaw('not json');
check('corrupt JSON → unauthenticated', !LichessAuth.isAuthenticated());
injectRaw('null');
check('null payload → unauthenticated', !LichessAuth.isAuthenticated());
injectRaw('"a string"');
check('string payload → unauthenticated', !LichessAuth.isAuthenticated());
injectRaw('{}');
check('empty object → unauthenticated', !LichessAuth.isAuthenticated());
injectRaw('{"accessToken":""}');
check('empty accessToken → unauthenticated', !LichessAuth.isAuthenticated());
injectRaw('{"accessToken":42}');
check('non-string accessToken → unauthenticated', !LichessAuth.isAuthenticated());

// ─── signOut clears local state even with no network ─────────────────────
section('signOut');
freshConfigure();
// Inject a token via the same trick.
injectToken({ accessToken: 'tok', expiresAt: 1_700_000_999_999, username: 'alice' });
check('authenticated before signOut', LichessAuth.isAuthenticated());
// signOut does an awaitable fetch revoke; in Node without fetch defined,
// it'll throw inside the try/catch and just clear LS. We don't await
// because we just want to verify the LS clearing happens synchronously
// before any await. (signOut clears LS first, THEN does the network call.)
LichessAuth.signOut();
check('signOut clears auth state immediately', !LichessAuth.isAuthenticated());

// ─── summary ─────────────────────────────────────────────────────────────
console.log('\n' + (fail ? '✗' : '✓') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
