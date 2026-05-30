/**
 * liveUpdate.js — over-the-air (OTA) web-bundle updates for the native
 * (Capacitor) build, in MANUAL / self-hosted mode over @capgo/capacitor-updater.
 *
 * WHY
 * Almost every change to this app is in the web layer (index.html, lib/*),
 * not the native shell. Rebuilding + reinstalling an APK for each of those is
 * friction. OTA lets a web push reach the installed APK on next launch with no
 * rebuild — while staying fully offline-capable (the last good bundle is cached
 * on-device by the plugin). Native changes (adding/upgrading a Capacitor plugin
 * or editing capacitor.config) STILL require a real APK; OTA only swaps web
 * assets, which is exactly the common case here. Store policy explicitly allows
 * OTA of JS/HTML/CSS in a webview (it's native code that may not be updated).
 *
 * MODE
 * Manual, not Capgo-cloud: capacitor.config sets autoUpdate:false, so the
 * plugin does nothing on its own. WE drive it from a static manifest we host
 * (no SaaS, no Supabase, no special server — just two files on the existing
 * data Pages repo). resetWhenUpdate:true means installing a fresh APK discards
 * any OTA bundle from the previous APK, so a new native build's bundled assets
 * always win and OTA resumes cleanly from there.
 *
 * DECISION MODEL (self-contained, plugin-agnostic)
 * Each bundle carries its own ./bundle-version.json = { version: <int> } baked
 * in at build time (build-www.js / publish-bundle.js). The running app reads
 * that local file to learn its OWN version — true for both the APK's built-in
 * bundle and any OTA bundle, since every bundle contains the file. It then
 * fetches the remote manifest app-manifest.json = { version, url, ... }; if
 * remote.version > local.version, it downloads + sets the new bundle. The swap
 * takes effect on the NEXT launch (we never reload mid-session — that would
 * yank the board/queue out from under the user). Versions are plain
 * monotonically-increasing integers: unambiguous, no semver parsing.
 *
 * ROLLBACK
 * notifyReady() (→ plugin.notifyAppReady) MUST run at boot in every bundle.
 * Capgo arms a rollback: if a freshly-set bundle fails to call notifyAppReady
 * within its timeout (e.g. it white-screens), the plugin reverts to the prior
 * working bundle on next start. So a bad OTA push is self-healing.
 *
 * minNative: carried in the manifest as a forward hook (a web bundle that needs
 * a newer native shell could declare it) but NOT enforced at runtime in this
 * version — a web call into a missing native plugin merely rejects gracefully,
 * and resetWhenUpdate + rollback cover the rest. Enforcement can be added later
 * once native versioning is wired through.
 *
 * SAFETY POSTURE
 * Every path is wrapped and degrades to a no-op: missing plugin, no Capacitor,
 * fetch failure, malformed manifest, download/set failure — none throw, none
 * block boot, none disturb the currently-running (working) bundle. Inert on the
 * web build and in Node (available() === false), so it's a pure native add.
 *
 * Plugin reached via window.Capacitor.Plugins.CapacitorUpdater (no bundler).
 *
 * Dual-mode load:
 *   Node:    const LiveUpdate = require('../lib/liveUpdate'); // available()===false
 *   Browser: <script src="lib/liveUpdate.js"></script>        // window.LiveUpdate
 *
 * Tests inject fakes via _setPlugin / _setFetch / _setLocalVersionLoader.
 */
(function (root) {
  'use strict';

  var pluginImpl = null;   // injected in tests; else resolved from Capacitor
  var fetchImpl = null;    // injected in tests; else root.fetch
  var localVersionLoader = null; // injected in tests; else fetch ./bundle-version.json

  function isNative() {
    return !!(root.Capacitor
      && typeof root.Capacitor.isNativePlatform === 'function'
      && root.Capacitor.isNativePlatform());
  }

  function getPlugin() {
    if (pluginImpl) return pluginImpl;
    if (root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.CapacitorUpdater) {
      return root.Capacitor.Plugins.CapacitorUpdater;
    }
    return null;
  }

  function getFetch() {
    if (fetchImpl) return fetchImpl;
    return (typeof root.fetch === 'function') ? root.fetch.bind(root) : null;
  }

  function available() {
    if (pluginImpl) return true;
    return isNative() && !!getPlugin();
  }

  // Confirm the current bundle is healthy so Capgo doesn't roll it back. Safe
  // to call always; no-op when unavailable. Returns a Promise<bool> for tests.
  function notifyReady() {
    var p = getPlugin();
    if (!p || typeof p.notifyAppReady !== 'function') return Promise.resolve(false);
    return Promise.resolve().then(function () { return p.notifyAppReady(); })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  // ─── pure decision (unit-tested) ────────────────────────────────────────
  // currentVersion: integer (the running bundle's version; 0 if unknown).
  // manifest: { version:int, url:string, ... } | null.
  // → { action: 'update'|'noop', reason, version?, url? }
  function compareDecision(currentVersion, manifest) {
    var cur = (typeof currentVersion === 'number' && isFinite(currentVersion)) ? currentVersion : 0;
    if (!manifest || typeof manifest !== 'object') return { action: 'noop', reason: 'no-manifest' };
    if (typeof manifest.version !== 'number' || !isFinite(manifest.version)) {
      return { action: 'noop', reason: 'bad-manifest-version' };
    }
    if (typeof manifest.url !== 'string' || !manifest.url) return { action: 'noop', reason: 'no-url' };
    if (manifest.version > cur) {
      return { action: 'update', reason: 'newer', version: manifest.version, url: manifest.url };
    }
    return { action: 'noop', reason: 'up-to-date' };
  }

  // ─── helpers ────────────────────────────────────────────────────────────
  function loadLocalVersion() {
    if (localVersionLoader) return Promise.resolve().then(localVersionLoader).catch(function () { return 0; });
    var f = getFetch();
    if (!f) return Promise.resolve(0);
    // Cache-bust the local file so a freshly-applied bundle reports its own version.
    return f('./bundle-version.json?_=' + Date.now())
      .then(function (r) { return (r && r.ok) ? r.json() : null; })
      .then(function (j) { return (j && typeof j.version === 'number') ? j.version : 0; })
      .catch(function () { return 0; });
  }

  function fetchManifest(url) {
    var f = getFetch();
    if (!f) return Promise.resolve(null);
    return f(url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return (r && r.ok) ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ─── orchestration (native) ─────────────────────────────────────────────
  // Fetch local + remote versions, decide, and if newer download + set the
  // bundle (applied on NEXT launch). Never throws; resolves a small report.
  function checkAndStage(opts) {
    opts = opts || {};
    var manifestUrl = opts.manifestUrl;
    var plugin = getPlugin();
    if (!plugin || !manifestUrl) return Promise.resolve({ ok: false, reason: 'unavailable' });

    return Promise.all([loadLocalVersion(), fetchManifest(manifestUrl)])
      .then(function (res) {
        var decision = compareDecision(res[0], res[1]);
        if (decision.action !== 'update') {
          return { ok: true, updated: false, reason: decision.reason, current: res[0] };
        }
        return Promise.resolve()
          .then(function () {
            return plugin.download({ url: decision.url, version: String(decision.version) });
          })
          .then(function (bundle) {
            if (!bundle || !bundle.id) throw new Error('download returned no bundle id');
            // set() makes it the active bundle on the next app launch. We do
            // NOT reload() — applying mid-session would reset the user's board.
            return plugin.set({ id: bundle.id }).then(function () {
              return { ok: true, updated: true, staged: true, version: decision.version, bundleId: bundle.id };
            });
          })
          .catch(function (e) {
            return { ok: false, updated: false, reason: 'download-or-set-failed',
                     error: (e && e.message) ? e.message : String(e) };
          });
      })
      .catch(function (e) {
        return { ok: false, reason: 'check-failed', error: (e && e.message) ? e.message : String(e) };
      });
  }

  var api = {
    available: available,
    isNative: isNative,
    notifyReady: notifyReady,
    checkAndStage: checkAndStage,
    compareDecision: compareDecision,
    // test seams
    _setPlugin: function (p) { pluginImpl = p || null; },
    _setFetch: function (f) { fetchImpl = f || null; },
    _setLocalVersionLoader: function (fn) { localVersionLoader = fn || null; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LiveUpdate = api;
})(typeof self !== 'undefined' ? self : this);
