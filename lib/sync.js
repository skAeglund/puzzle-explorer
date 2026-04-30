/**
 * sync.js — Cross-device progress sync via private GitHub Gist.
 *
 * Design (and why):
 *   - The user pastes their own GitHub fine-grained PAT (gist scope) plus,
 *     optionally, an existing gist ID. With no gist ID, we POST a new
 *     private gist on first save. Each user owns their own gist; the PAT
 *     IS the identity — we don't run a multi-tenant server.
 *   - A username string lives alongside the credentials (a) for namespacing
 *     localStorage so two people on the same browser don't clobber each
 *     other's local cache and (b) for a sanity-check field embedded in the
 *     gist body so a wrong-PAT / wrong-gist-ID combo is caught before it
 *     cross-contaminates FSRS state.
 *   - All progress mutations call Sync.notifyMutation() — Progress already
 *     wrote through to LS by the time notifyMutation runs, so LS is always
 *     authoritative for "what survives a tab kill." Sync's job is just to
 *     get that LS payload up to the gist on a 3-second debounce.
 *   - syncToGist is read-merge-write, NEVER blind PATCH. Without the read,
 *     every sync silently overwrites whatever another device wrote in the
 *     interim. The merge is per-pid latest-wins by lastSeen — see merge()
 *     for the full strategy.
 *   - Per the user-confirmed assumption (online + not simultaneous), the
 *     merge handles "phone graded yesterday, laptop grades today" cleanly.
 *     It does NOT cleanly merge two divergent FSRS trajectories from the
 *     same card — that needs path-aware reconciliation we explicitly
 *     punted on.
 *   - Heavy comments at decision points match the rest of the codebase's
 *     posture (CLAUDE.md "tone matches existing project conventions").
 *
 * Architectural decisions inherited verbatim from MistakeLab's hard-won
 * lessons (referenced read-only at /home/claude/mistake-lab-ref):
 *   - 5-second in-memory cache on the gist GET so concurrent readers
 *     during startup share one fetch (FETCH_CACHE_TTL).
 *   - keepalive: true on the PATCH only when body < 64KB (browser cap).
 *     Above the cap, browsers reject keepalive and fall back to a fetch
 *     that gets killed on page unload anyway — so we just use a normal
 *     fetch and accept the unload-flush risk for big payloads.
 *   - DON'T touch the gist `description` field on PATCH. Other writers
 *     (future analyzer integrations, anything else humans put in a gist
 *     description) own that field; PATCH semantics preserve omitted
 *     fields, so dropping it from the body is the right move.
 *   - For truncated gist file responses, fall back to raw_url WITHOUT an
 *     Authorization header — adding one triggers a CORS preflight that
 *     fails on raw.githubusercontent.com.
 *   - Dirty flag survives crashes: set in LS on every notifyMutation, read
 *     at startup, cleared only after a successful PATCH lands. So if the
 *     OS kills a mobile tab in the 3s debounce window, the next session
 *     re-pushes (after a fresh remote read + merge).
 *
 * Public API:
 *   Sync.init({ getProgressData, setProgressData, onStatusChange })
 *      - getProgressData: () => { positions: {...} } — usually Progress.exportData
 *      - setProgressData: (data) => void — usually data => Progress.importData(data)
 *      - onStatusChange: ({status, label}) => void — UI hook; status is one of
 *        'off' | 'syncing' | 'ok' | 'error'
 *   Sync.setUsername(name)               — affects gist body username field + LS namespace
 *   Sync.setCredentials(token, gistId)   — token required, gistId optional
 *   Sync.getCredentials()                — { token, gistId }
 *   Sync.clearCredentials()
 *   Sync.isConfigured()                  — true iff token+gistId both set
 *   Sync.notifyMutation()                — call after every Progress mutation
 *   Sync.flushNow()                      — immediate sync (used by pagehide)
 *   Sync.loadFromGist()                  — explicit pull; called at login
 *   Sync.createGist(seedData)            — POST /gists; returns new id
 *   Sync.merge(local, remote)            — pure; exposed for tests
 *   Sync.getStatus()                     — current status string
 *   Sync._setHooks(...)                  — testing override for storage / fetch / timer
 *
 * Dual-mode loading like the rest of lib/:
 *   Node:    const Sync = require('../lib/sync');
 *   Browser: <script src="lib/sync.js"></script>  (defines window.Sync)
 */
(function (root) {
  'use strict';

  // ─── constants ──────────────────────────────────────────────────────────
  var GIST_FILENAME      = 'puzzle_explorer_progress.json';
  var DEBOUNCE_MS        = 3000;
  var FETCH_CACHE_TTL_MS = 5000;
  var RETRY_MS           = 30000;
  var KEEPALIVE_MAX_BYTES = 65536; // browser cap; above this, drop keepalive
  var GIST_DESCRIPTION   = 'Puzzle Explorer progress';
  var BODY_VERSION       = 1;

  // Personal-tool defaults: a shared "guest" gist owned by skAeglund. Anyone
  // running this build can paste their own PAT and connect without juggling
  // a gist ID. The PAT is the actual secret — the gist ID is just a long
  // opaque hex string that's useless without the PAT, so committing it is
  // safe. Users who want their OWN per-user gist can clear the gist ID
  // field; that hits the createGist path and stamps their typed username
  // into a brand new private gist.
  var DEFAULT_USERNAME   = 'guest';
  var DEFAULT_GIST_ID    = 'df614a0d131baf9077cb3a6fa7290c65';

  // LS keys are namespaced by username so two users on one browser don't
  // share creds. The active username is stored unnamespaced (it's the
  // pointer to "which other keys to read"). All keys lowercase the username
  // via Progress.setUsername's normalization for symmetry.
  var LS_USERNAME       = 'puzzle_explorer_username';
  var LS_TOKEN_PREFIX   = 'puzzle_explorer_gist_token_';
  var LS_GISTID_PREFIX  = 'puzzle_explorer_gist_id_';
  var LS_DIRTY_PREFIX   = 'puzzle_explorer_progress_dirty_';
  // Without a username, dirty flag goes under a base key. Symmetric with
  // Progress's STORAGE_KEY behavior — bare key when anonymous, suffixed
  // key when logged in.
  var LS_DIRTY_BASE     = 'puzzle_explorer_progress_dirty';

  // ─── injectable hooks (default to runtime globals) ──────────────────────
  // These let sync-test.js drive the module deterministically without
  // patching globals. _setHooks replaces any subset; production code
  // never touches them.
  var _storage = (function () {
    if (typeof localStorage !== 'undefined') {
      try { localStorage.getItem(LS_USERNAME); return localStorage; }
      catch (e) { return _makeMemoryStorage(); }
    }
    return _makeMemoryStorage();
  })();
  var _fetch    = (typeof fetch !== 'undefined') ? fetch.bind(typeof globalThis !== 'undefined' ? globalThis : root) : null;
  var _now      = function () { return Date.now(); };
  var _setTO    = function (fn, ms) { return setTimeout(fn, ms); };
  var _clearTO  = function (id) { return clearTimeout(id); };

  function _makeMemoryStorage() {
    var d = Object.create(null);
    return {
      getItem:    function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
      setItem:    function (k, v) { d[k] = String(v); },
      removeItem: function (k) { delete d[k]; }
    };
  }

  function _setHooks(opts) {
    if (!opts) return;
    if (opts.storage)   _storage  = opts.storage;
    if (opts.fetch)     _fetch    = opts.fetch;
    if (opts.now)       _now      = opts.now;
    if (opts.setTimeout) _setTO   = opts.setTimeout;
    if (opts.clearTimeout) _clearTO = opts.clearTimeout;
  }

  // Reset all module-level state. Tests need this between cases — without
  // it, _debounceTimer set by one test's notifyMutation leaks into the
  // next test's first notifyMutation, where the leaked timer-handle gets
  // passed to a freshly-faked clearTimeout and skews the call count.
  // Production code never calls this; it lives behind the underscore
  // prefix as a contract that it's not part of the stable API.
  function _resetForTesting() {
    _username = '';
    _token = '';
    _gistId = '';
    _getProgressData = null;
    _setProgressData = null;
    _onStatusChange = null;
    _dirtyMem = false;
    _debounceTimer = null;
    _status = 'off';
    _cachedResponse = null;
    _cacheTimestamp = 0;
    _createGistInFlight = null;
  }

  // ─── module state ───────────────────────────────────────────────────────
  var _username = '';
  var _token = '';
  var _gistId = '';
  var _getProgressData = null;
  var _setProgressData = null;
  var _onStatusChange = null;

  var _dirtyMem = false;          // in-memory dirty flag (mirrored to LS)
  var _debounceTimer = null;
  var _status = 'off';            // 'off' | 'syncing' | 'ok' | 'error'

  // 5s GET cache so multiple readers (loadFromGist + the read leg of
  // syncToGist) during startup don't double-fetch.
  var _cachedResponse = null;
  var _cacheTimestamp = 0;

  // ─── small helpers ──────────────────────────────────────────────────────
  function _normalize(name) {
    if (typeof name !== 'string') return '';
    return name.trim().toLowerCase();
  }
  function _dirtyKey() {
    return _username ? (LS_DIRTY_PREFIX + _username) : LS_DIRTY_BASE;
  }
  function _safeGet(k) { try { return _storage.getItem(k); } catch (e) { return null; } }
  function _safeSet(k, v) { try { _storage.setItem(k, v); return true; } catch (e) { return false; } }
  function _safeDel(k) { try { _storage.removeItem(k); } catch (e) {} }

  function _setStatus(s, label) {
    _status = s;
    if (typeof _onStatusChange === 'function') {
      try { _onStatusChange({ status: s, label: label || '' }); } catch (e) {}
    }
  }
  function _statusForCurrentConfig() {
    return isConfigured() ? 'ok' : 'off';
  }

  // ─── credentials & username ─────────────────────────────────────────────
  function setUsername(name) {
    _username = _normalize(name);
    if (_username) _safeSet(LS_USERNAME, _username);
    else _safeDel(LS_USERNAME);
    // Loading credentials for the new username from LS — symmetric with
    // saveCredentials's namespaced write. Lets a per-device "switch user"
    // flow restore creds without re-pasting the PAT.
    if (_username) {
      var t = _safeGet(LS_TOKEN_PREFIX + _username);
      var g = _safeGet(LS_GISTID_PREFIX + _username);
      _token = t || '';
      _gistId = g || '';
      // Restore in-memory dirty flag from LS so a session that crashed
      // mid-debounce gets its pending state pushed on the next mutation
      // or explicit flush. See the long flush-on-crash comment in MistakeLab
      // — same shape applies here.
      _dirtyMem = _safeGet(_dirtyKey()) === '1';
    } else {
      _token = '';
      _gistId = '';
      _dirtyMem = _safeGet(_dirtyKey()) === '1';
    }
    _cachedResponse = null;
    _cacheTimestamp = 0;
  }
  function getUsername() { return _username; }

  function setCredentials(token, gistId) {
    _token = (typeof token === 'string') ? token.trim() : '';
    _gistId = (typeof gistId === 'string') ? gistId.trim() : '';
    if (_username) {
      // Persist under the namespaced keys so a future session with the same
      // username restores them automatically. Persisting plain creds in LS
      // is a deliberate trade-off: there's no good alternative for a
      // single-page web app on Pages, and the only realistic exposure is
      // an attacker with the user's browser anyway. Fine-grained PATs with
      // gist-only scope cap the blast radius.
      if (_token)  _safeSet(LS_TOKEN_PREFIX + _username, _token);  else _safeDel(LS_TOKEN_PREFIX + _username);
      if (_gistId) _safeSet(LS_GISTID_PREFIX + _username, _gistId); else _safeDel(LS_GISTID_PREFIX + _username);
    }
    _cachedResponse = null;
    _cacheTimestamp = 0;
  }
  function getCredentials() { return { token: _token, gistId: _gistId }; }
  function clearCredentials() {
    if (_username) {
      _safeDel(LS_TOKEN_PREFIX + _username);
      _safeDel(LS_GISTID_PREFIX + _username);
    }
    _token = '';
    _gistId = '';
    _cachedResponse = null;
    _cacheTimestamp = 0;
    _setStatus('off', 'Not synced');
  }
  function isConfigured() { return !!(_token && _gistId); }

  // ─── init ───────────────────────────────────────────────────────────────
  function init(opts) {
    opts = opts || {};
    if (typeof opts.getProgressData === 'function') _getProgressData = opts.getProgressData;
    if (typeof opts.setProgressData === 'function') _setProgressData = opts.setProgressData;
    if (typeof opts.onStatusChange === 'function')  _onStatusChange  = opts.onStatusChange;

    // Restore username + creds from LS. This is the cold-start path: a
    // returning user with stored creds gets re-armed without re-pasting
    // anything. The status callback is fired so the UI pill updates from
    // the initial 'off' to 'ok' (or 'off' for never-configured users).
    var storedName = _safeGet(LS_USERNAME);
    if (storedName) setUsername(storedName);
    _setStatus(_statusForCurrentConfig(), isConfigured() ? 'Synced' : 'Not synced');
  }

  // ─── pure merge (per-entry latest-wins by lastSeen) ─────────────────────
  // Lifted from MistakeLab's mergeGistData (positions branch only — we
  // don't have notes / repertoire / practice surfaces to merge). Strategy:
  //   - Per-pid: newer lastSeen wins for the entire entry. Treats the
  //     {completed, lastSeen, srs} triple as one timestamped record.
  //     {...remote, ...newer} keeps any forward-compat fields the remote
  //     side knows about that the local side doesn't.
  //   - Disjoint pids: union (both sides keep their own).
  //   - Equal lastSeen: remote wins. Deterministic tiebreak; in the
  //     intended usage (one user, multiple devices) this is statistically
  //     never going to fire.
  //   - Missing lastSeen: treated as epoch 0 (unknown < any real time).
  // The result is a deep clone — neither input is mutated. Callers can
  // freely re-merge or persist.
  function merge(local, remote) {
    if (!local && !remote) return { positions: {}, version: BODY_VERSION };
    if (!local)  return JSON.parse(JSON.stringify(remote));
    if (!remote) return JSON.parse(JSON.stringify(local));
    // Start from a deep clone of remote; carry over local's positions on top.
    var merged = JSON.parse(JSON.stringify(remote));
    if (!merged.positions || typeof merged.positions !== 'object' || Array.isArray(merged.positions)) {
      merged.positions = {};
    }
    if (typeof merged.version !== 'number') merged.version = BODY_VERSION;
    if (local.positions && typeof local.positions === 'object' && !Array.isArray(local.positions)) {
      for (var pid in local.positions) {
        if (!Object.prototype.hasOwnProperty.call(local.positions, pid)) continue;
        var localEntry = local.positions[pid];
        if (!localEntry || typeof localEntry !== 'object') continue;
        var remoteEntry = merged.positions[pid];
        if (!remoteEntry) { merged.positions[pid] = JSON.parse(JSON.stringify(localEntry)); continue; }
        var lt = _entryTime(localEntry);
        var rt = _entryTime(remoteEntry);
        // Strict greater-than → remote wins on ties (deterministic).
        var winner = lt > rt ? localEntry : remoteEntry;
        var spread = {};
        // Re-implement {...remote, ...winner} as ES5 to match codebase style.
        for (var k1 in remoteEntry) if (Object.prototype.hasOwnProperty.call(remoteEntry, k1)) spread[k1] = remoteEntry[k1];
        for (var k2 in winner)      if (Object.prototype.hasOwnProperty.call(winner, k2))      spread[k2] = winner[k2];
        merged.positions[pid] = spread;
      }
    }
    return merged;
  }
  function _entryTime(e) {
    if (!e || typeof e.lastSeen !== 'string') return 0;
    var t = new Date(e.lastSeen).getTime();
    return isFinite(t) ? t : 0;
  }
  // Used by loadFromGist to decide whether a follow-up sync is needed.
  // Returns true iff at least one local position is either (a) strictly
  // newer than its remote counterpart, or (b) absent from remote.
  function _localHasNewerOrUnique(local, remote) {
    if (!local || !local.positions) return false;
    var rPos = (remote && remote.positions) ? remote.positions : null;
    for (var pid in local.positions) {
      if (!Object.prototype.hasOwnProperty.call(local.positions, pid)) continue;
      var le = local.positions[pid];
      if (!le || typeof le !== 'object') continue;
      if (!rPos || !rPos[pid]) return true;          // local-only entry
      if (_entryTime(le) > _entryTime(rPos[pid])) return true;
    }
    return false;
  }

  // ─── HTTP layer ─────────────────────────────────────────────────────────
  function _gistFetchAll() {
    var now = _now();
    if (_cachedResponse && (now - _cacheTimestamp) < FETCH_CACHE_TTL_MS) {
      return Promise.resolve(_cachedResponse);
    }
    if (!_token || !_gistId || !_fetch) return Promise.resolve(null);
    return _fetch('https://api.github.com/gists/' + encodeURIComponent(_gistId), {
      headers: { 'Authorization': 'token ' + _token }
    }).then(function (resp) {
      if (!resp || !resp.ok) {
        var status = resp ? resp.status : 'no-response';
        throw new Error('Gist read failed: ' + status);
      }
      return resp.json();
    }).then(function (json) {
      _cachedResponse = json;
      _cacheTimestamp = _now();
      return json;
    });
  }
  function _invalidateCache() { _cachedResponse = null; _cacheTimestamp = 0; }

  // GitHub truncates large gist files in the API JSON. When file.truncated
  // is true (or content is missing), follow file.raw_url. NO Authorization
  // header on the raw fetch — raw_url is pre-signed for the requesting
  // identity, and adding the header triggers a CORS preflight that fails
  // on raw.githubusercontent.com. (We don't expect to hit this in
  // practice — even thousands of puzzles fits in <1MB JSON, well under
  // GitHub's 1MB truncation threshold — but the path is here for safety.)
  function _readFileContent(file) {
    if (!file) return Promise.resolve(null);
    if (file.truncated || !file.content) {
      if (!file.raw_url || !_fetch) return Promise.resolve(null);
      return _fetch(file.raw_url).then(function (r) {
        if (!r || !r.ok) throw new Error('Gist raw fetch failed: ' + (r ? r.status : 'no-response'));
        return r.text();
      });
    }
    return Promise.resolve(file.content);
  }

  function gistRead() {
    if (!_token || !_gistId) return Promise.resolve(null);
    return _gistFetchAll().then(function (gist) {
      if (!gist) return null;
      var file = gist.files && gist.files[GIST_FILENAME];
      if (!file) return null;
      return _readFileContent(file).then(function (content) {
        if (!content) return null;
        try { return JSON.parse(content); }
        catch (e) { return null; } // corrupt remote: treat as empty, will be overwritten next sync
      });
    });
  }

  function gistWrite(data) {
    if (!_token || !_gistId || !_fetch) return Promise.reject(new Error('Not configured'));
    var fileContent = JSON.stringify(data, null, 2);
    var bodyObj = { files: {} };
    bodyObj.files[GIST_FILENAME] = { content: fileContent };
    var body = JSON.stringify(bodyObj);
    // Don't include `description` — leaves whatever the gistCreate set
    // (or any human edit) intact across syncs.
    var opts = {
      method: 'PATCH',
      headers: {
        'Authorization': 'token ' + _token,
        'Content-Type': 'application/json'
      },
      body: body
    };
    if (body.length < KEEPALIVE_MAX_BYTES) {
      // keepalive: true lets the browser hold the request across page
      // unload (pagehide flushes on mobile especially). Above the 64KB
      // cap, browsers reject keepalive — fall back to plain fetch and
      // accept the unload-flush risk.
      opts.keepalive = true;
    }
    return _fetch('https://api.github.com/gists/' + encodeURIComponent(_gistId), opts)
      .then(function (resp) {
        if (!resp || !resp.ok) throw new Error('Gist write failed: ' + (resp ? resp.status : 'no-response'));
        _invalidateCache();
        return true;
      });
  }

  // In-flight guard — concurrent createGist calls must not POST twice.
  // Without this, a UI double-click between Save handler invocation and
  // the POST landing creates two real gists; the second's resolved id
  // overwrites the first's `_gistId`, leaving the first as an orphan in
  // the user's gist list (containing the seed data, so not harmless).
  // The guard returns the same promise to all callers in the same
  // in-flight window — they each see the same resolved id, no duplicate
  // POST. Cleared in both .then and .catch so a failed creation lets a
  // retry through.
  var _createGistInFlight = null;
  function createGist(seedData) {
    if (!_token || !_fetch) return Promise.reject(new Error('No token'));
    if (_createGistInFlight) return _createGistInFlight;
    var seed = seedData || { positions: {}, version: BODY_VERSION };
    if (_username && !seed.username) seed.username = _username;
    var fileContent = JSON.stringify(seed, null, 2);
    var bodyObj = {
      description: GIST_DESCRIPTION,
      'public': false,
      files: {}
    };
    bodyObj.files[GIST_FILENAME] = { content: fileContent };
    _createGistInFlight = _fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': 'token ' + _token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyObj)
    }).then(function (resp) {
      if (!resp || !resp.ok) throw new Error('Gist create failed: ' + (resp ? resp.status : 'no-response'));
      return resp.json();
    }).then(function (gist) {
      if (!gist || !gist.id) throw new Error('Gist create returned no id');
      // Adopt the new id automatically. Saves the caller from juggling it.
      _gistId = gist.id;
      if (_username) _safeSet(LS_GISTID_PREFIX + _username, _gistId);
      _invalidateCache();
      _createGistInFlight = null;
      return gist.id;
    }).catch(function (err) {
      _createGistInFlight = null;
      throw err;
    });
    return _createGistInFlight;
  }

  // ─── sync orchestration ─────────────────────────────────────────────────
  function notifyMutation() {
    _dirtyMem = true;
    _safeSet(_dirtyKey(), '1');
    if (!isConfigured()) return; // never-synced user — Progress LS write is enough
    if (_debounceTimer) _clearTO(_debounceTimer);
    _debounceTimer = _setTO(function () {
      _debounceTimer = null;
      // Return the promise so the timer host (or a test driver) can await
      // it. setTimeout itself ignores the return value in the browser, but
      // the test fakes invoke fn() directly and await it.
      return _syncToGist();
    }, DEBOUNCE_MS);
  }

  function _syncToGist() {
    if (!isConfigured()) return Promise.resolve(false);
    if (typeof _getProgressData !== 'function') return Promise.resolve(false);
    _setStatus('syncing', 'Syncing…');
    return gistRead().then(function (remote) {
      var local;
      try { local = _getProgressData(); }
      catch (e) { local = { positions: {} }; }
      // Sanity check: if the remote gist body has a username field that
      // doesn't match ours, abort the write. This catches the wrong-PAT /
      // wrong-gist-ID combo before it cross-contaminates FSRS state. The
      // user sees a sync error and can fix the credentials in the UI.
      if (remote && typeof remote.username === 'string' && _username &&
          remote.username !== _username) {
        _setStatus('error', 'Username mismatch');
        // Don't clear dirty — once the user fixes creds, the next mutation
        // (or an explicit retry) will sync the pending state.
        return false;
      }
      var merged = merge(local, remote || { positions: {}, version: BODY_VERSION });
      // Stamp username + version into the body. Username is the cross-device
      // sanity check we just verified above; version is a forward-compat
      // hook in case we change the merge rules later.
      if (_username) merged.username = _username;
      if (typeof merged.version !== 'number') merged.version = BODY_VERSION;
      return gistWrite(merged).then(function () {
        // Re-import the merged result locally — captures any cross-device
        // updates we just pulled in via the read leg. Without this, a
        // remote-side mutation made between our last sync and this one
        // would only be visible in this session if we re-loaded from gist
        // after the write.
        if (typeof _setProgressData === 'function') {
          try { _setProgressData(merged); } catch (e) {}
        }
        _dirtyMem = false;
        _safeDel(_dirtyKey());
        _setStatus('ok', 'Synced');
        return true;
      });
    }).catch(function (err) {
      // Read or write failure. Don't clear dirty — the next debounced
      // mutation will retry, and we also schedule an explicit retry so a
      // session with no further mutations doesn't get stuck. Both share
      // the same timer slot so a user mutation arriving during the retry
      // window cancels and re-debounces normally.
      var msg = (err && err.message) ? err.message : String(err);
      _setStatus('error', 'Sync failed');
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[sync] sync failed:', msg);
      }
      if (_debounceTimer) _clearTO(_debounceTimer);
      _debounceTimer = _setTO(function () {
        _debounceTimer = null;
        return _syncToGist();
      }, RETRY_MS);
      return false;
    });
  }

  function flushNow() {
    // Used by pagehide / beforeunload. Cancel any pending debounce and
    // sync immediately. keepalive on small bodies inside gistWrite keeps
    // the request alive across the unload.
    if (!isConfigured() || !_dirtyMem) return Promise.resolve(false);
    if (_debounceTimer) { _clearTO(_debounceTimer); _debounceTimer = null; }
    return _syncToGist();
  }

  // Explicit pull. Used at login-time to seed from a freshly-entered gist.
  // Result-shape:
  //   { ok: true,  data: <merged> }                          on success
  //   { ok: false, reason: 'username_mismatch', remote: ... } on the sanity-check failure
  //   { ok: false, reason: 'network', error: <msg> }         on read failure
  function loadFromGist() {
    if (!isConfigured()) return Promise.resolve({ ok: false, reason: 'not_configured' });
    _setStatus('syncing', 'Loading…');
    return gistRead().then(function (remote) {
      if (remote && typeof remote.username === 'string' && _username &&
          remote.username !== _username) {
        _setStatus('error', 'Username mismatch');
        return { ok: false, reason: 'username_mismatch', remote: remote };
      }
      var local = (typeof _getProgressData === 'function') ? _getProgressData() : { positions: {} };
      var merged = merge(local, remote || { positions: {}, version: BODY_VERSION });
      if (_username) merged.username = _username;
      if (typeof _setProgressData === 'function') {
        try { _setProgressData(merged); } catch (e) {}
      }
      // Dirty if local has any position that's strictly newer than remote's
      // counterpart, OR a position remote doesn't have at all. Counting keys
      // is not enough — that misses the "local has newer FSRS state for an
      // existing position" case (same key in both, but local's lastSeen >
      // remote's). The strict-newer pass also has zero false positives:
      // when local equals remote in value, dirty stays false and we avoid a
      // pointless follow-up PATCH on every cold-start auto-pull.
      if (_localHasNewerOrUnique(local, remote)) {
        _dirtyMem = true;
        _safeSet(_dirtyKey(), '1');
      }
      _setStatus('ok', 'Synced');
      return { ok: true, data: merged };
    }).catch(function (err) {
      var msg = (err && err.message) ? err.message : String(err);
      _setStatus('error', 'Load failed');
      return { ok: false, reason: 'network', error: msg };
    });
  }

  function getStatus() { return _status; }
  function isDirty() { return _dirtyMem; }

  // ─── exports ────────────────────────────────────────────────────────────
  var api = {
    // constants (exposed for tests)
    GIST_FILENAME:       GIST_FILENAME,
    DEBOUNCE_MS:         DEBOUNCE_MS,
    FETCH_CACHE_TTL_MS:  FETCH_CACHE_TTL_MS,
    RETRY_MS:            RETRY_MS,
    KEEPALIVE_MAX_BYTES: KEEPALIVE_MAX_BYTES,
    DEFAULT_USERNAME:    DEFAULT_USERNAME,
    DEFAULT_GIST_ID:     DEFAULT_GIST_ID,
    LS_USERNAME:         LS_USERNAME,
    LS_TOKEN_PREFIX:     LS_TOKEN_PREFIX,
    LS_GISTID_PREFIX:    LS_GISTID_PREFIX,
    LS_DIRTY_PREFIX:     LS_DIRTY_PREFIX,
    LS_DIRTY_BASE:       LS_DIRTY_BASE,
    // setup
    init:               init,
    setUsername:        setUsername,
    getUsername:        getUsername,
    setCredentials:     setCredentials,
    getCredentials:     getCredentials,
    clearCredentials:   clearCredentials,
    isConfigured:       isConfigured,
    // pure
    merge:              merge,
    // I/O
    gistRead:           gistRead,
    gistWrite:          gistWrite,
    createGist:         createGist,
    loadFromGist:       loadFromGist,
    notifyMutation:     notifyMutation,
    flushNow:           flushNow,
    // status
    getStatus:          getStatus,
    isDirty:            isDirty,
    // testing
    _setHooks:          _setHooks,
    _resetForTesting:   _resetForTesting,
    _makeMemoryStorage: _makeMemoryStorage
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Sync = api;
  }
})(typeof self !== 'undefined' ? self : this);
