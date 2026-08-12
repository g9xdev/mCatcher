(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McDownloadScheduler = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  function deepFreeze(o) {
    if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
    Object.getOwnPropertyNames(o).forEach(function (k) {
      var v = o[k];
      if (v && typeof v === "object") deepFreeze(v);
    });
    return Object.freeze(o);
  }

  function isNonblankString(v) {
    return typeof v === "string" && v.trim().length > 0;
  }

  function requireNonblankId(value, label) {
    if (!isNonblankString(value)) {
      throw new TypeError(label + " must be a nonblank string");
    }
    return value;
  }

  /** Positive finite integer (not 0, not float, not Infinity/NaN). */
  function requirePositiveInt(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new RangeError(label + " must be a positive finite integer");
    }
    return value;
  }

  function requireFunction(value, label) {
    if (typeof value !== "function") {
      throw new TypeError(label + " must be a function");
    }
    return value;
  }

  function clampRetries(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return 0;
    var i = Math.floor(n);
    if (i < 0) return 0;
    if (i > 10) return 10;
    return i;
  }

  function freezeIntent(intent) {
    if (!intent || typeof intent !== "object") {
      throw new TypeError("intent must be an object");
    }
    if (Object.isFrozen(intent)) return intent;
    // Shallow-safe copy then freeze (intent fields are primitives / null).
    return deepFreeze({
      requestedFilename: intent.requestedFilename,
      destinationDirectory: intent.destinationDirectory === undefined ? null : intent.destinationDirectory,
      saveMode: intent.saveMode,
      userSelectedFirefox: intent.userSelectedFirefox,
      userActionToken: intent.userActionToken,
      createdAt: intent.createdAt,
    });
  }

  function defaultRandomToken() {
    var seq = 0;
    return function () {
      seq += 1;
      return "attempt-" + seq + "-" + Math.random().toString(36).slice(2, 10);
    };
  }

  /**
   * Pure synchronous download scheduler — global admission core (Task 9).
   *
   * Session memory only. No timers, no browser globals.
   *
   * States used now: created | queued | running | completed | failed
   * (pausing_provider / waiting_provider / retry_backoff / needs_user /
   *  handing_off_firefox / handed_to_firefox / cancelled reserved for Tasks 10–11)
   *
   * Slot contract: holdsGlobalSlot boolean token + stateVersion CAS.
   * globalRunning === count(holdsGlobalSlot === true) always.
   *
   * Fairness: FIFO within providerKey; round-robin across providers.
   * providerKey is always the captured key — never derived from mediaOrigin/CDN.
   */
  function createDownloadScheduler(opts) {
    opts = opts || {};
    var maxConcurrent = requirePositiveInt(opts.maxConcurrent, "maxConcurrent");
    var now = opts.now == null ? function () { return Date.now(); } : requireFunction(opts.now, "now");
    var randomToken =
      opts.randomToken == null ? defaultRandomToken() : requireFunction(opts.randomToken, "randomToken");

    // Internal job store: id -> job record (mutable; never returned live).
    var jobs = new Map();
    // Creation order for deterministic snapshot job listing.
    var jobOrder = [];
    // Provider FIFO queues: providerKey -> [jobId, ...]
    var providerQueues = new Map();
    // Stable provider order for round-robin (first-seen).
    var providerOrder = [];
    // Last provider that won admission; next drain starts after this key.
    // Survives providerOrder growth so a later-seen provider is not starved.
    var lastAdmittedProviderKey = null;
    // Exact slot counter; must equal count of holdsGlobalSlot tokens.
    var globalRunning = 0;
    var draining = false;
    // Monotonic token suffix when randomToken collides / blanks.
    var tokenGuard = 0;

    function ensureProvider(providerKey) {
      if (!providerQueues.has(providerKey)) {
        providerQueues.set(providerKey, []);
      }
      if (providerOrder.indexOf(providerKey) === -1) {
        providerOrder.push(providerKey);
      }
    }

    function projectJob(job) {
      // Safe allowlist — never ephemeral, cookies, headers, signed URLs.
      return deepFreeze({
        id: job.id,
        providerKey: job.providerKey,
        state: job.state,
        stateVersion: job.stateVersion,
        holdsGlobalSlot: job.holdsGlobalSlot,
        retryRemaining: job.retryRemaining,
        retryUsed: job.retryUsed,
        effectiveConcurrency: job.effectiveConcurrency,
        intent: job.intent,
        attemptToken: job.attemptToken,
        mode: job.mode,
        mediaKind: job.mediaKind,
        autoWakeCount: job.autoWakeCount,
      });
    }

    function getJob(jobId) {
      var job = jobs.get(jobId);
      if (!job) return null;
      return projectJob(job);
    }

    function buildProvidersProjection() {
      var keys = providerOrder.slice().sort();
      var out = {};
      for (var i = 0; i < keys.length; i++) {
        var pk = keys[i];
        var queued = (providerQueues.get(pk) || []).slice();
        var running = [];
        jobs.forEach(function (j) {
          if (j.providerKey === pk && j.state === "running") {
            running.push(j.id);
          }
        });
        // Running order: creation order within provider.
        running.sort(function (a, b) {
          return jobOrder.indexOf(a) - jobOrder.indexOf(b);
        });
        out[pk] = deepFreeze({
          queued: Object.freeze(queued),
          running: Object.freeze(running),
        });
      }
      return deepFreeze(out);
    }

    function getSnapshot() {
      var list = [];
      for (var i = 0; i < jobOrder.length; i++) {
        var j = jobs.get(jobOrder[i]);
        if (j) list.push(projectJob(j));
      }
      return deepFreeze({
        maxConcurrent: maxConcurrent,
        globalRunning: globalRunning,
        jobs: Object.freeze(list),
        providers: buildProvidersProjection(),
      });
    }

    function mintAttemptToken() {
      tokenGuard += 1;
      var t = randomToken();
      if (!isNonblankString(t)) {
        t = "attempt-" + tokenGuard;
      } else {
        t = String(t);
      }
      // Guarantee uniqueness even if hook returns a constant.
      return t + "#" + tokenGuard;
    }

    function clearEphemeralOnce(job) {
      if (!job.ephemeral) return;
      var e = job.ephemeral;
      job.ephemeral = null;
      if (e && typeof e.clear === "function") {
        try {
          e.clear();
        } catch (err) {
          // Clearing must not throw out of the scheduler transaction.
        }
      }
    }

    /**
     * Atomically admit a queued job into running: one slot token, fresh
     * attemptToken, single stateVersion bump. Caller already removed it
     * from the provider FIFO.
     */
    function admitJob(job) {
      if (job.state !== "queued") return false;
      if (globalRunning >= maxConcurrent) return false;
      job.state = "running";
      job.stateVersion += 1;
      job.holdsGlobalSlot = true;
      job.attemptToken = mintAttemptToken();
      globalRunning += 1;
      return true;
    }

    /**
     * Central synchronous drain. FIFO within each provider; round-robin
     * across providers. Skips empty provider queues. Re-entrant calls
     * collapse into one pass.
     *
     * Start scan just after lastAdmittedProviderKey so fairness holds even
     * when providerOrder grows after the previous admission.
     */
    function drain() {
      if (draining) return;
      draining = true;
      try {
        while (globalRunning < maxConcurrent) {
          var n = providerOrder.length;
          if (n === 0) break;

          var start = 0;
          if (lastAdmittedProviderKey != null) {
            var li = providerOrder.indexOf(lastAdmittedProviderKey);
            if (li !== -1) start = (li + 1) % n;
          }

          var admitted = false;
          for (var i = 0; i < n; i++) {
            var idx = (start + i) % n;
            var pk = providerOrder[idx];
            var q = providerQueues.get(pk);
            if (!q || q.length === 0) continue;

            // Drop stale head entries until a true queued job or empty.
            while (q.length > 0) {
              var headId = q[0];
              var headJob = jobs.get(headId);
              if (headJob && headJob.state === "queued") break;
              q.shift();
            }
            if (q.length === 0) continue;

            var jobId = q.shift();
            var job = jobs.get(jobId);
            if (!job || job.state !== "queued") continue;

            if (admitJob(job)) {
              lastAdmittedProviderKey = pk;
              admitted = true;
              break;
            }
            // Cap race (should not happen): restore FIFO head.
            q.unshift(jobId);
            break;
          }
          if (!admitted) break;
        }
      } finally {
        draining = false;
      }
    }

    function createJob(input) {
      input = input || {};
      var id = requireNonblankId(input.id, "id");
      var providerKey = requireNonblankId(input.providerKey, "providerKey");
      if (jobs.has(id)) {
        throw new Error("duplicate job id: " + id);
      }
      var segmentConcurrency = requirePositiveInt(input.segmentConcurrency, "segmentConcurrency");
      var intent = freezeIntent(input.intent);
      var retryRemaining = clampRetries(input.retries);

      // mediaOrigin is accepted for forward compatibility but NEVER used as providerKey.
      var mediaOrigin = input.mediaOrigin == null ? null : input.mediaOrigin;
      var mediaKind = input.mediaKind == null ? null : input.mediaKind;
      var ephemeral = input.ephemeral == null ? null : input.ephemeral;

      var job = {
        id: id,
        providerKey: providerKey,
        state: "created",
        stateVersion: 1,
        holdsGlobalSlot: false,
        retryRemaining: retryRemaining,
        retryUsed: 0,
        effectiveConcurrency: segmentConcurrency,
        intent: intent,
        attemptToken: null,
        mode: "multi-range",
        mediaKind: mediaKind,
        mediaOrigin: mediaOrigin,
        ephemeral: ephemeral,
        autoWakeCount: 0,
        // Reserved for Tasks 10–11 (provider gate, wake, cancel, handoff).
        cancelRequested: false,
        inFlightPermits: 0,
        nativeOpenConnections: 0,
      };
      jobs.set(id, job);
      jobOrder.push(id);
      ensureProvider(providerKey);
      return projectJob(job);
    }

    function enqueue(jobId) {
      var job = jobs.get(jobId);
      if (!job) return;
      if (job.state !== "created") return;
      job.state = "queued";
      job.stateVersion += 1;
      ensureProvider(job.providerKey);
      var q = providerQueues.get(job.providerKey);
      q.push(job.id);
      drain();
    }

    function setMaxConcurrent(n) {
      maxConcurrent = requirePositiveInt(n, "maxConcurrent");
      // Raising drains immediately; lowering never demotes running work.
      drain();
    }

    /**
     * Terminalize a running job that presents the current attempt token.
     * Same transaction: release slot, bump stateVersion once, clear ephemeral
     * once, then drain. Late/duplicate/wrong-token → no-op.
     */
    function terminalizeRunning(job, attemptToken, nextState) {
      if (!job) return false;
      if (job.state !== "running") return false;
      if (!isNonblankString(attemptToken)) return false;
      if (job.attemptToken !== attemptToken) return false;

      var held = job.holdsGlobalSlot === true;
      job.state = nextState;
      job.stateVersion += 1;
      if (held) {
        job.holdsGlobalSlot = false;
        if (globalRunning > 0) globalRunning -= 1;
      } else {
        job.holdsGlobalSlot = false;
      }
      clearEphemeralOnce(job);
      // Drop any lingering queue membership (should not be queued while running).
      var q = providerQueues.get(job.providerKey);
      if (q) {
        var idx = q.indexOf(job.id);
        if (idx !== -1) q.splice(idx, 1);
      }
      drain();
      return true;
    }

    function onTransportResult(jobId, attemptToken, result) {
      var job = jobs.get(jobId);
      if (!job) return;
      result = result || {};
      var status = result.status;

      if (status === "completed") {
        terminalizeRunning(job, attemptToken, "completed");
        return;
      }
      if (status === "failed") {
        // Task 9: minimal terminal failed path. Retry / saturation policy is Tasks 10–11.
        terminalizeRunning(job, attemptToken, "failed");
        return;
      }
      if (status === "cancelled") {
        // Minimal terminal cancel; full cancel() API arrives in later tasks.
        terminalizeRunning(job, attemptToken, "cancelled");
        return;
      }
      // Unknown status: no-op.
    }

    // Public surface — keep method names stable for Tasks 10–11 extensions.
    return {
      createJob: createJob,
      enqueue: enqueue,
      setMaxConcurrent: setMaxConcurrent,
      onTransportResult: onTransportResult,
      getJob: getJob,
      getSnapshot: getSnapshot,
      // Placeholders reserved so later tasks extend without reshaping the object:
      // cancel, onCapabilitySwitch, onQuiesced, notePermitAcquired, releasePermit,
      // acquireProviderPermit, issueAttemptToken, manualRetry, requestFirefoxHandoff, tick
    };
  }

  return {
    createDownloadScheduler: createDownloadScheduler,
  };
});
