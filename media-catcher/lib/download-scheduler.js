(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McDownloadScheduler = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function (root) {
  "use strict";

  /**
   * Deep-freeze a scheduler-owned allowlist graph. Always traverse children
   * even when a parent is already frozen. Callers must only pass objects the
   * scheduler created — never untrusted caller graphs.
   */
  function deepFreeze(o) {
    if (!o || typeof o !== "object") return o;
    Object.getOwnPropertyNames(o).forEach(function (k) {
      var v = o[k];
      if (v && typeof v === "object") deepFreeze(v);
    });
    if (!Object.isFrozen(o)) Object.freeze(o);
    return o;
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

  /** Nonnegative finite integer (0 allowed). */
  function requireNonnegInt(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new RangeError(label + " must be a nonnegative finite integer");
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

  /**
   * CommonJS is the active path when module.exports is live and require exists.
   * In that mode, require deps directly and propagate load/init failures.
   * Browser dual-export uses globals only when CommonJS is not the active path.
   */
  function isCommonJsActive() {
    return (
      typeof module === "object" &&
      module != null &&
      typeof module.exports !== "undefined" &&
      typeof require === "function"
    );
  }

  function resolveProviderGateApi() {
    if (isCommonJsActive()) {
      return require("./provider-gate.js");
    }
    if (root && root.McProviderGate) return root.McProviderGate;
    throw new Error("McProviderGate is required for DownloadScheduler");
  }

  function resolveFailureClassifyApi() {
    if (isCommonJsActive()) {
      return require("./failure-classify.js");
    }
    if (root && root.McFailureClassify) return root.McFailureClassify;
    throw new Error("McFailureClassify is required for DownloadScheduler");
  }

  /**
   * Always mint a brand-new exact allowlist intent. Never passthrough a frozen
   * caller object (secrets / signed URLs / nested aliases must not survive).
   * Reject non-primitive values under allowlisted keys before job creation.
   */
  function sanitizeIntent(intent) {
    if (!intent || typeof intent !== "object") {
      throw new TypeError("intent must be an object");
    }
    if (!isNonblankString(intent.requestedFilename)) {
      throw new TypeError("intent.requestedFilename must be a nonblank string");
    }
    var destinationDirectory =
      intent.destinationDirectory === undefined ? null : intent.destinationDirectory;
    if (destinationDirectory !== null && !isNonblankString(destinationDirectory)) {
      throw new TypeError("intent.destinationDirectory must be null or a nonblank string");
    }
    if (intent.saveMode !== "default" && intent.saveMode !== "save-as") {
      throw new TypeError('intent.saveMode must be "default" or "save-as"');
    }
    if (typeof intent.userSelectedFirefox !== "boolean") {
      throw new TypeError("intent.userSelectedFirefox must be a boolean");
    }
    if (!isNonblankString(intent.userActionToken)) {
      throw new TypeError("intent.userActionToken must be a nonblank string");
    }
    if (typeof intent.createdAt !== "string") {
      throw new TypeError("intent.createdAt must be a string");
    }
    return deepFreeze({
      requestedFilename: intent.requestedFilename,
      destinationDirectory: destinationDirectory,
      saveMode: intent.saveMode,
      userSelectedFirefox: intent.userSelectedFirefox,
      userActionToken: intent.userActionToken,
      createdAt: intent.createdAt,
    });
  }

  function sanitizeMediaKind(value) {
    if (value == null) return null;
    if (!isNonblankString(value)) {
      throw new TypeError("mediaKind must be null or a nonblank string");
    }
    return value;
  }

  function defaultRandomToken() {
    var seq = 0;
    return function () {
      seq += 1;
      return "attempt-" + seq + "-" + Math.random().toString(36).slice(2, 10);
    };
  }

  function reducedCapFrom(prev) {
    var n = typeof prev === "number" && Number.isFinite(prev) ? Math.floor(prev) : 1;
    if (n < 1) n = 1;
    return Math.max(1, Math.floor(n / 2));
  }

  /**
   * Pure synchronous download scheduler — global admission + provider saturation (Tasks 9–10).
   *
   * Session memory only. No timers, no browser globals.
   *
   * States: created | queued | running | pausing_provider | waiting_provider |
   *         retry_backoff | completed | failed | cancelled
   * (needs_user / handing_off_firefox / handed_to_firefox reserved for Task 11+)
   *
   * Slot contract: holdsGlobalSlot boolean token + stateVersion CAS.
   * globalRunning === count(holdsGlobalSlot === true) always.
   * pausing_provider is the only non-running state that may hold a slot.
   *
   * Fairness: FIFO within providerKey; round-robin across providers.
   * providerKey is always the captured key — never derived from mediaOrigin/CDN.
   *
   * ProviderGate is the sole internal permit/lease authority. Public surface exposes
   * only acquireProviderPermit (no raw gate / gate.acquire leakage).
   */
  function createDownloadScheduler(opts) {
    opts = opts || {};
    var maxConcurrent = requirePositiveInt(opts.maxConcurrent, "maxConcurrent");
    var now = opts.now == null ? function () { return Date.now(); } : requireFunction(opts.now, "now");
    var randomToken =
      opts.randomToken == null ? defaultRandomToken() : requireFunction(opts.randomToken, "randomToken");
    // Optional forward-compat hook — automatic failures/saturation MUST NEVER call it.
    var firefoxDownload = null;
    if (opts.firefoxDownload != null) {
      firefoxDownload = requireFunction(opts.firefoxDownload, "firefoxDownload");
    }
    void firefoxDownload; // retained for requestFirefoxHandoff (later); never auto-invoked.
    void now;

    var ProviderGateApi = resolveProviderGateApi();
    var FailureClassify = resolveFailureClassifyApi();
    if (typeof ProviderGateApi.createProviderGate !== "function") {
      throw new Error("McProviderGate.createProviderGate is required");
    }
    if (
      typeof FailureClassify.isSaturationCandidate !== "function" ||
      typeof FailureClassify.hasActiveSibling !== "function"
    ) {
      throw new Error("McFailureClassify saturation APIs are required");
    }

    // Internal job store: id -> job record (mutable; never returned live).
    var jobs = new Map();
    // Creation order for deterministic snapshot job listing / oldest-owner selection.
    var jobOrder = [];
    // Provider FIFO queues: providerKey -> [jobId, ...]
    var providerQueues = new Map();
    // Provider wait FIFO: providerKey -> [jobId, ...]
    var providerWaitQueues = new Map();
    // Exactly one ProviderGate per captured providerKey.
    var providerGates = new Map();
    // Stable provider order for round-robin (first-seen).
    var providerOrder = [];
    // Last provider that won admission; next drain starts after this key.
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
      if (!providerWaitQueues.has(providerKey)) {
        providerWaitQueues.set(providerKey, []);
      }
      if (!providerGates.has(providerKey)) {
        providerGates.set(
          providerKey,
          ProviderGateApi.createProviderGate({ providerKey: providerKey })
        );
      }
      if (providerOrder.indexOf(providerKey) === -1) {
        providerOrder.push(providerKey);
      }
    }

    function getGate(providerKey) {
      ensureProvider(providerKey);
      return providerGates.get(providerKey);
    }

    function totalInFlightPermits(job) {
      var w = job.wrapperPermits || 0;
      var o = job.observedPermits || 0;
      return w + o;
    }

    function projectJob(job) {
      // Safe allowlist — never ephemeral, cookies, headers, signed URLs, mediaOrigin.
      // inFlightPermits is the exact sum of wrapper-owned + observation-adapter counts.
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
        inFlightPermits: totalInFlightPermits(job),
        nativeOpenConnections: job.nativeOpenConnections,
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
        var waiting = (providerWaitQueues.get(pk) || []).slice();
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
        var gate = providerGates.get(pk);
        var gs = gate ? gate.snapshot() : null;
        out[pk] = deepFreeze({
          queued: Object.freeze(queued),
          running: Object.freeze(running),
          waiting: Object.freeze(waiting),
          gate: deepFreeze({
            state: gs ? gs.state : "normal",
            generation: gs ? gs.generation : 0,
            wakeGeneration: gs ? gs.wakeGeneration : 0,
            ownerJobId: gs ? gs.ownerJobId : null,
            reducedConcurrency: gs ? gs.reducedConcurrency : null,
          }),
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

    /**
     * Mint a unique nonblank attempt token without mutating job/slot state.
     * A throwing / blank / non-string randomToken hook never fails admission:
     * fall back to the scheduler's monotonic token so the queue cannot strand.
     */
    function mintAttemptToken() {
      tokenGuard += 1;
      var t = null;
      try {
        t = randomToken();
      } catch (err) {
        t = null;
      }
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

    function removeFromQueue(job) {
      var q = providerQueues.get(job.providerKey);
      if (!q) return;
      var idx = q.indexOf(job.id);
      if (idx !== -1) q.splice(idx, 1);
    }

    function removeFromWaitQueue(job) {
      var w = providerWaitQueues.get(job.providerKey);
      if (!w) return;
      var idx = w.indexOf(job.id);
      if (idx !== -1) w.splice(idx, 1);
    }

    function appendWaitFifo(job) {
      ensureProvider(job.providerKey);
      var w = providerWaitQueues.get(job.providerKey);
      if (w.indexOf(job.id) === -1) w.push(job.id);
    }

    function isQuiescent(job) {
      return (
        totalInFlightPermits(job) <= 0 &&
        (!job.nativeOpenConnections || job.nativeOpenConnections <= 0)
      );
    }

    /**
     * Shared quiesce edge: pausing_provider → waiting_provider exactly once when
     * total permits and native opens are both zero. State guard only (single-threaded).
     */
    function maybeQuiesce(job) {
      if (!job) return;
      if (job.state !== "pausing_provider") return;
      if (!isQuiescent(job)) return;
      job.state = "waiting_provider";
      job.stateVersion += 1;
      job.attemptToken = null;
      releaseSlotIfHeld(job);
      appendWaitFifo(job);
      drain();
    }

    function releaseSlotIfHeld(job) {
      if (job.holdsGlobalSlot !== true) return false;
      if (globalRunning <= 0) {
        throw new Error(
          "slot invariant violation: releasing slot with globalRunning <= 0"
        );
      }
      job.holdsGlobalSlot = false;
      globalRunning -= 1;
      return true;
    }

    function assertRunningOwnsSlot(job) {
      if (job.holdsGlobalSlot !== true || globalRunning <= 0) {
        throw new Error(
          "slot invariant violation: running job must own a global slot with globalRunning > 0"
        );
      }
    }

    function syncJobLimit(job) {
      var gate = getGate(job.providerKey);
      try {
        gate.registerJobLimit(job.id, job.effectiveConcurrency);
      } catch (err) {
        // Ignore registration races for terminal jobs.
      }
    }

    function applyReducedConcurrency(job, reduced) {
      // Never increase during the job; apply provider reduced cap (min 1).
      var next = Math.min(job.effectiveConcurrency, reduced);
      if (next < 1) next = 1;
      job.effectiveConcurrency = next;
      syncJobLimit(job);
    }

    function buildSiblingFacts(excludeJobId) {
      var facts = [];
      for (var i = 0; i < jobOrder.length; i++) {
        var j = jobs.get(jobOrder[i]);
        if (!j) continue;
        facts.push({
          id: j.id,
          providerKey: j.providerKey,
          state: j.state,
          inFlightPermits: totalInFlightPermits(j),
          nativeOpenConnections: j.nativeOpenConnections,
          cancelRequested: j.cancelRequested === true,
        });
      }
      void excludeJobId;
      return facts;
    }

    function pickOldestActiveSibling(providerKey, excludeJobId) {
      var facts = buildSiblingFacts(excludeJobId);
      var check = FailureClassify.hasActiveSibling({
        providerKey: providerKey,
        excludeJobId: excludeJobId,
        jobs: facts,
      });
      if (!check || !check.ok || !check.siblingJobId) return null;
      // hasActiveSibling walks facts in creation order → first match is oldest.
      var owner = jobs.get(check.siblingJobId);
      if (!owner) return null;
      // Explicit distinct-sibling guard: failed job can never be owner.
      if (owner.id === excludeJobId) return null;
      return owner;
    }

    /**
     * Pure peek: can this job be admitted for provider reasons?
     * Never designates recovery owner or lowers concurrency.
     */
    function providerCanAdmit(job) {
      var gate = getGate(job.providerKey);
      var st = gate.state;
      if (st === "normal") return true;
      var snap = gate.snapshot();
      if (snap.ownerJobId && job.id === snap.ownerJobId) return true;
      // recovering blocked (no owner): eligible for commit-time designation.
      if (st === "recovering" && snap.ownerJobId == null) return true;
      return false;
    }

    /**
     * Commit-time provider admission mutations. Call only after global capacity
     * is known and immediately before slot commit. Designates recovery owner
     * at most once for recovering-blocked providers.
     */
    function commitProviderAdmission(job) {
      var gate = getGate(job.providerKey);
      var st = gate.state;
      if (st === "normal") return true;
      var snap = gate.snapshot();
      if (snap.ownerJobId && job.id === snap.ownerJobId) return true;
      if (st === "recovering" && snap.ownerJobId == null) {
        var des = gate.designateRecoveryOwner({ recoveryOwnerJobId: job.id });
        if (des && des.applied) {
          if (snap.reducedConcurrency != null) {
            applyReducedConcurrency(job, snap.reducedConcurrency);
          }
          return true;
        }
        return false;
      }
      return false;
    }

    /**
     * Atomically admit a queued job into running: commit provider designation
     * (if needed), one slot token, fresh attemptToken, single stateVersion bump.
     * Caller already removed it from the provider FIFO.
     */
    function admitJob(job) {
      if (job.state !== "queued") return false;
      if (globalRunning >= maxConcurrent) return false;
      if (!providerCanAdmit(job)) return false;
      // Capacity known: designate/recover-owner commit immediately before slot.
      if (!commitProviderAdmission(job)) return false;
      var token = mintAttemptToken();
      job.state = "running";
      job.stateVersion += 1;
      job.holdsGlobalSlot = true;
      job.attemptToken = token;
      globalRunning += 1;
      syncJobLimit(job);
      return true;
    }

    /**
     * Central synchronous drain. FIFO within each provider; round-robin
     * across providers. Skips empty / blocked provider queues. Re-entrant
     * calls collapse into one pass.
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

            // Pure peek: never designate or mutate concurrency.
            var peekJob = jobs.get(q[0]);
            if (!peekJob || peekJob.state !== "queued") continue;
            if (!providerCanAdmit(peekJob)) continue;

            var jobId = q.shift();
            var job = jobs.get(jobId);
            if (!job || job.state !== "queued") continue;

            if (admitJob(job)) {
              lastAdmittedProviderKey = pk;
              admitted = true;
              break;
            }
            // Local admit failure after shift: restore FIFO and keep scanning
            // independent providers rather than aborting the full drain.
            q.unshift(jobId);
          }
          if (!admitted) break;
        }
      } finally {
        draining = false;
      }
    }

    /** Start a new wait epoch: reset per-epoch wake authorization / retry flags. */
    function beginWaitEpoch(job) {
      job.waitEpoch = (job.waitEpoch || 0) + 1;
      job.wakeAuthorized = false;
      job.wakeRetryConsumed = false;
    }

    function enterWaitingProvider(job, opts) {
      opts = opts || {};
      if (job.state === "waiting_provider") {
        // Same epoch: ensure FIFO membership + optional mark.
        if (opts.consumeRetryOnWake === true && !job.wakeRetryConsumed) {
          job.consumeRetryOnWake = true;
        }
        appendWaitFifo(job);
        return;
      }
      // pausing → waiting keeps the same wait epoch; only non-pause starts a new one.
      if (job.state !== "pausing_provider") {
        beginWaitEpoch(job);
      }
      job.state = "waiting_provider";
      job.stateVersion += 1;
      job.attemptToken = null;
      if (opts.consumeRetryOnWake === true) {
        job.consumeRetryOnWake = true;
      }
      releaseSlotIfHeld(job);
      appendWaitFifo(job);
    }

    function enterPausingProvider(job, opts) {
      opts = opts || {};
      if (job.state === "pausing_provider" || job.state === "waiting_provider") {
        if (opts.consumeRetryOnWake === true && !job.wakeRetryConsumed) {
          job.consumeRetryOnWake = true;
        }
        return;
      }
      beginWaitEpoch(job);
      job.state = "pausing_provider";
      job.stateVersion += 1;
      job.attemptToken = null;
      // retains global slot
      if (opts.consumeRetryOnWake === true) {
        job.consumeRetryOnWake = true;
      }
    }

    function pauseOrWaitNonOwner(job, opts) {
      opts = opts || {};
      if (isQuiescent(job)) {
        enterWaitingProvider(job, opts);
      } else {
        enterPausingProvider(job, opts);
      }
    }

    function enterRetryBackoff(job, attemptToken) {
      if (!job) return false;
      if (job.state !== "running") return false;
      if (!isNonblankString(attemptToken)) return false;
      if (job.attemptToken !== attemptToken) return false;
      assertRunningOwnsSlot(job);
      job.state = "retry_backoff";
      job.stateVersion += 1;
      job.attemptToken = null;
      releaseSlotIfHeld(job);
      removeFromQueue(job);
      // Placeholder for Task 11 timers — slot released immediately; never Firefox.
      drain();
      return true;
    }

    /**
     * Terminalize a running job that presents the current attempt token.
     * Same transaction: release slot, bump stateVersion once, clear ephemeral
     * once when truly terminal, then drain. Late/duplicate/wrong-token → no-op.
     */
    function terminalizeRunning(job, attemptToken, nextState) {
      if (!job) return false;
      if (job.state !== "running") return false;
      if (!isNonblankString(attemptToken)) return false;
      if (job.attemptToken !== attemptToken) return false;

      assertRunningOwnsSlot(job);

      job.state = nextState;
      job.stateVersion += 1;
      job.holdsGlobalSlot = false;
      globalRunning -= 1;
      job.attemptToken = null;
      if (
        nextState === "completed" ||
        nextState === "failed" ||
        nextState === "cancelled"
      ) {
        clearEphemeralOnce(job);
      }
      removeFromQueue(job);
      drain();
      return true;
    }

    function oldestEligibleWaiter(providerKey) {
      var w = providerWaitQueues.get(providerKey) || [];
      for (var i = 0; i < w.length; i++) {
        var j = jobs.get(w[i]);
        if (!j) continue;
        if (j.state !== "waiting_provider") continue;
        if (j.cancelRequested === true) continue;
        return j;
      }
      return null;
    }

    /**
     * Single authorized wake of a waiting_provider job back to queued for the
     * current wait epoch. Late duplicates in the same epoch no-op.
     * Failed waiters consume at most one retry per epoch; paused-only consume none.
     * Never bypasses global admission — appends wait-FIFO order into provider FIFO,
     * then central drain applies global cap / round-robin.
     */
    function authorizeWake(job) {
      if (!job || job.state !== "waiting_provider") return false;
      // Per wait-epoch idempotence (not job lifetime).
      if (job.wakeAuthorized) return false;
      job.wakeAuthorized = true;
      job.autoWakeCount += 1;
      // Failed saturation waiter: consume retry budget exactly once per epoch at wake.
      // Paused-only competitors do not consume. Task 11 finishes backoff timers.
      if (job.consumeRetryOnWake === true && job.wakeRetryConsumed !== true) {
        job.wakeRetryConsumed = true;
        job.consumeRetryOnWake = false;
        if (job.retryRemaining > 0) {
          job.retryRemaining -= 1;
          job.retryUsed += 1;
        }
      }
      removeFromWaitQueue(job);
      job.state = "queued";
      job.stateVersion += 1;
      job.attemptToken = null;
      ensureProvider(job.providerKey);
      var q = providerQueues.get(job.providerKey);
      // Deterministic wait-FIFO: append preserves authorization order among wakes.
      if (q.indexOf(job.id) === -1) q.push(job.id);
      return true;
    }

    /**
     * Owner terminal path for saturated/recovering: release slot, authenticated
     * completeOwner, single wake of oldest waiter (or leave blocked).
     */
    function completeProviderOwner(job, attemptToken, nextState) {
      if (!job) return false;
      if (job.state !== "running") return false;
      if (!isNonblankString(attemptToken)) return false;
      if (job.attemptToken !== attemptToken) return false;

      var gate = getGate(job.providerKey);
      var snap = gate.snapshot();
      if (snap.state !== "saturated" && snap.state !== "recovering") return false;
      if (snap.ownerJobId !== job.id) return false;

      assertRunningOwnsSlot(job);

      var waiter = oldestEligibleWaiter(job.providerKey);
      var recoveryId = waiter ? waiter.id : null;

      // Side-effect order: terminalize + release slot, then completeOwner, then wake, then drain.
      job.state = nextState;
      job.stateVersion += 1;
      job.holdsGlobalSlot = false;
      globalRunning -= 1;
      job.attemptToken = null;
      if (
        nextState === "completed" ||
        nextState === "failed" ||
        nextState === "cancelled"
      ) {
        clearEphemeralOnce(job);
      }
      removeFromQueue(job);

      var result = gate.completeOwner({
        jobId: job.id,
        recoveryOwnerJobId: recoveryId,
      });

      if (result && result.advanced === true && recoveryId) {
        var next = jobs.get(recoveryId);
        if (next && next.state === "waiting_provider") {
          // Install reduced cap for recovery owner.
          var after = gate.snapshot();
          if (after.reducedConcurrency != null) {
            applyReducedConcurrency(next, after.reducedConcurrency);
          }
          authorizeWake(next);
        }
      }

      drain();
      return true;
    }

    /**
     * Successful recovery-owner completion: terminalize + authenticated recoverToNormal,
     * then re-authorize every remaining eligible same-provider waiter in wait-FIFO order.
     * Never admits directly — central drain applies global cap / round-robin.
     */
    function completeRecoverySuccess(job, attemptToken) {
      if (!job) return false;
      if (job.state !== "running") return false;
      if (!isNonblankString(attemptToken)) return false;
      if (job.attemptToken !== attemptToken) return false;

      var gate = getGate(job.providerKey);
      var snap = gate.snapshot();
      if (snap.state !== "recovering" || snap.ownerJobId !== job.id) return false;

      assertRunningOwnsSlot(job);

      job.state = "completed";
      job.stateVersion += 1;
      job.holdsGlobalSlot = false;
      globalRunning -= 1;
      job.attemptToken = null;
      clearEphemeralOnce(job);
      removeFromQueue(job);

      gate.recoverToNormal({ jobId: job.id });

      // Re-authorize remaining waiters in deterministic wait-FIFO order.
      var waitQ = providerWaitQueues.get(job.providerKey) || [];
      var remaining = waitQ.slice();
      for (var i = 0; i < remaining.length; i++) {
        var waiter = jobs.get(remaining[i]);
        if (!waiter) continue;
        if (waiter.state !== "waiting_provider") continue;
        if (waiter.cancelRequested === true) continue;
        authorizeWake(waiter);
      }

      drain();
      return true;
    }

    /**
     * Join an already-saturated/recovering gate's wait under the existing reduced
     * cap without generation bump / re-halving / re-arming owner bookkeeping.
     */
    function joinExistingSaturationWait(failedJob, snap) {
      if (snap.reducedConcurrency != null) {
        applyReducedConcurrency(failedJob, snap.reducedConcurrency);
      }
      pauseOrWaitNonOwner(failedJob, { consumeRetryOnWake: true });
      drain();
    }

    function enterSaturation(failedJob, ownerJob) {
      var gate = getGate(failedJob.providerKey);
      var snap = gate.snapshot();

      // Fresh saturation only from normal. Late failures join existing wait.
      if (snap.state !== "normal") {
        joinExistingSaturationWait(failedJob, snap);
        return;
      }

      // Explicit distinct oldest-active-sibling guard; failed job can never be owner.
      if (!ownerJob || ownerJob.id === failedJob.id) return;

      var reduced = reducedCapFrom(ownerJob.effectiveConcurrency);

      gate.setSaturated({
        drainOwnerJobId: ownerJob.id,
        reducedConcurrency: reduced,
      });

      // Immediately lower owner and failed job effectiveConcurrency.
      applyReducedConcurrency(ownerJob, reduced);
      applyReducedConcurrency(failedJob, reduced);

      // Owner remains running. Every running non-owner same-provider job pauses/waits.
      for (var i = 0; i < jobOrder.length; i++) {
        var j = jobs.get(jobOrder[i]);
        if (!j) continue;
        if (j.providerKey !== failedJob.providerKey) continue;
        if (j.id === ownerJob.id) continue;
        if (j.state !== "running" && j.id !== failedJob.id) {
          // Already non-running competitors untouched.
          continue;
        }
        // Apply reduced cap to competitors.
        applyReducedConcurrency(j, reduced);
        var isFailed = j.id === failedJob.id;
        pauseOrWaitNonOwner(j, {
          consumeRetryOnWake: isFailed,
        });
      }

      // Other providers untouched; freed slots fill via drain.
      drain();
    }

    function createJob(input) {
      input = input || {};
      var id = requireNonblankId(input.id, "id");
      var providerKey = requireNonblankId(input.providerKey, "providerKey");
      if (jobs.has(id)) {
        throw new Error("duplicate job id: " + id);
      }
      var segmentConcurrency = requirePositiveInt(input.segmentConcurrency, "segmentConcurrency");
      // Validate intent + mediaKind before any job store mutation.
      var intent = sanitizeIntent(input.intent);
      var mediaKind = sanitizeMediaKind(input.mediaKind);
      var retryRemaining = clampRetries(input.retries);

      // mediaOrigin is accepted for forward compatibility but NEVER used as providerKey
      // and NEVER projected from getJob/getSnapshot.
      var mediaOrigin = input.mediaOrigin == null ? null : input.mediaOrigin;
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
        cancelRequested: false,
        // Separate wrapper-owned vs observation-adapter permit counts.
        // Projected inFlightPermits is their exact sum.
        wrapperPermits: 0,
        observedPermits: 0,
        nativeOpenConnections: 0,
        // Saturation wake bookkeeping (not projected).
        waitEpoch: 0,
        consumeRetryOnWake: false,
        wakeRetryConsumed: false,
        wakeAuthorized: false,
      };
      jobs.set(id, job);
      jobOrder.push(id);
      ensureProvider(providerKey);
      // Register finite native lease limit for this job.
      syncJobLimit(job);
      return projectJob(job);
    }

    function enqueue(jobId) {
      var job = jobs.get(jobId);
      if (!job) return;
      if (job.state !== "created") return;
      job.state = "queued";
      job.stateVersion += 1;
      ensureProvider(job.providerKey);
      // If provider is recovering-blocked, designation happens at admission time.
      var q = providerQueues.get(job.providerKey);
      q.push(job.id);
      drain();
    }

    function setMaxConcurrent(n) {
      maxConcurrent = requirePositiveInt(n, "maxConcurrent");
      // Raising drains immediately; lowering never demotes running work.
      drain();
    }

    function notePermitAcquired(jobId) {
      var job = jobs.get(jobId);
      if (!job) return;
      // Observation adapter only — never touches wrapper-owned or raw permits.
      job.observedPermits += 1;
    }

    function releasePermit(jobId) {
      var job = jobs.get(jobId);
      if (!job) return;
      // Observation adapter only — never under-counts wrapper-owned permits.
      if (job.observedPermits > 0) {
        job.observedPermits -= 1;
      }
      maybeQuiesce(job);
    }

    function noteNativeOpen(jobId, n) {
      var job = jobs.get(jobId);
      if (!job) return;
      var count = requireNonnegInt(n, "n");
      job.nativeOpenConnections = count;
      var gate = getGate(job.providerKey);
      gate.noteNativeOpen(jobId, count);
      if (count === 0) {
        maybeQuiesce(job);
      }
    }

    function nativeLeaseFor(jobId) {
      var job = jobs.get(jobId);
      if (!job) {
        throw new TypeError("unknown jobId");
      }
      var gate = getGate(job.providerKey);
      var lease = gate.nativeLeaseFor(jobId);
      // Safe plain projection (no functions / live refs).
      return deepFreeze({
        jobId: lease.jobId,
        providerGeneration: lease.providerGeneration,
        maxConnections: lease.maxConnections,
      });
    }

    /**
     * Sole public ProviderGate wrapper. Only a running job may acquire; during
     * saturated/recovering only the authenticated owner acquires at reduced cap.
     * Returns a wrapped frozen permit. Wrapper release calls raw.release first;
     * only on success marks released and decrements wrapper count. Failed raw
     * release leaves counts unchanged and can be retried.
     */
    function acquireProviderPermit(jobId, purpose) {
      var job = jobs.get(jobId);
      if (!job) return null;
      if (job.state !== "running") return null;
      if (!isNonblankString(purpose)) {
        throw new TypeError("purpose must be a nonblank string");
      }

      var gate = getGate(job.providerKey);
      var snap = gate.snapshot();
      var isOwner =
        (snap.state === "saturated" || snap.state === "recovering") &&
        snap.ownerJobId === job.id;

      var raw = gate.acquire(jobId, {
        maxForJob: job.effectiveConcurrency,
        isRunningJob: true,
        isProviderOwner: isOwner,
        isDrainOwner: isOwner,
        purpose: purpose,
      });
      if (!raw) return null;

      // Wrapper-owned count only (observation adapter is separate).
      job.wrapperPermits += 1;
      var released = false;

      return Object.freeze({
        jobId: raw.jobId,
        purpose: raw.purpose,
        generation: raw.generation,
        release: function release() {
          if (released) return;
          // raw first — throws leave released=false and counts unchanged for retry.
          raw.release();
          released = true;
          if (job.wrapperPermits > 0) {
            job.wrapperPermits -= 1;
          }
          maybeQuiesce(job);
        },
      });
    }

    /**
     * Public quiesce hook: idempotent. Counter edges (wrapper release, observed
     * releasePermit, noteNativeOpen(...,0)) also call maybeQuiesce automatically.
     */
    function onQuiesced(jobId) {
      var job = jobs.get(jobId);
      if (!job) return;
      maybeQuiesce(job);
    }

    function userStatus(jobOrId) {
      var job = null;
      if (typeof jobOrId === "string") {
        job = jobs.get(jobOrId);
      } else if (jobOrId && typeof jobOrId === "object") {
        if (typeof jobOrId.id === "string") job = jobs.get(jobOrId.id);
        // Allow projected snapshot objects (use their state/providerKey directly).
        if (!job && typeof jobOrId.state === "string" && typeof jobOrId.providerKey === "string") {
          job = jobOrId;
        }
      }
      if (!job) return "";
      var state = job.state;
      var pk = job.providerKey;
      if (state === "pausing_provider" || state === "waiting_provider") {
        return "Waiting for " + pk;
      }
      if (state === "running") return "Downloading";
      if (state === "queued") return "Queued";
      if (state === "created") return "Created";
      if (state === "retry_backoff") return "Retrying";
      if (state === "completed") return "Completed";
      if (state === "failed") return "Failed";
      if (state === "cancelled") return "Cancelled";
      if (state === "needs_user") return "Needs attention";
      if (state === "handing_off_firefox") return "Handing off to Firefox";
      if (state === "handed_to_firefox") return "Handed to Firefox";
      return String(state || "");
    }

    function onTransportResult(jobId, attemptToken, result) {
      var job = jobs.get(jobId);
      if (!job) return;
      result = result || {};
      var status = result.status;

      if (status === "completed") {
        // Successful recovery owner → recoverToNormal.
        var gateC = getGate(job.providerKey);
        var snapC = gateC.snapshot();
        if (
          snapC.state === "recovering" &&
          snapC.ownerJobId === job.id &&
          job.state === "running" &&
          isNonblankString(attemptToken) &&
          job.attemptToken === attemptToken
        ) {
          completeRecoverySuccess(job, attemptToken);
          return;
        }
        // Saturated/recovering owner completion that is not a successful recovery
        // end (e.g. saturated drain owner) wakes next waiter via completeOwner.
        if (
          (snapC.state === "saturated" || snapC.state === "recovering") &&
          snapC.ownerJobId === job.id
        ) {
          // For recovering owner, completed means recovery success (handled above).
          // Saturated owner completed → wake chain.
          if (snapC.state === "saturated") {
            completeProviderOwner(job, attemptToken, "completed");
            return;
          }
        }
        terminalizeRunning(job, attemptToken, "completed");
        return;
      }

      if (status === "cancelled") {
        var gateX = getGate(job.providerKey);
        var snapX = gateX.snapshot();
        if (
          (snapX.state === "saturated" || snapX.state === "recovering") &&
          snapX.ownerJobId === job.id
        ) {
          completeProviderOwner(job, attemptToken, "cancelled");
          return;
        }
        terminalizeRunning(job, attemptToken, "cancelled");
        return;
      }

      if (status === "failed") {
        if (job.state !== "running") return;
        if (!isNonblankString(attemptToken)) return;
        if (job.attemptToken !== attemptToken) return;

        var category = result.failureCategory;
        // Never call Firefox on automatic failures/saturation.
        // firefoxDownload is intentionally unused here.

        var gateF = getGate(job.providerKey);
        var snapF = gateF.snapshot();

        // Owner failure while saturated/recovering: hand off via completeOwner
        // (or bounded retry / terminal failed if no waiter).
        if (
          (snapF.state === "saturated" || snapF.state === "recovering") &&
          snapF.ownerJobId === job.id
        ) {
          var waiter = oldestEligibleWaiter(job.providerKey);
          if (waiter) {
            completeProviderOwner(job, attemptToken, "failed");
            return;
          }
          // No waiter: inspect retryRemaining. Positive → retry_backoff + completeOwner(null).
          // Zero → terminal failed + completeOwner(null). Never leave exhausted owner retrying.
          if (FailureClassify.isSaturationCandidate(category)) {
            assertRunningOwnsSlot(job);
            if (job.retryRemaining > 0) {
              job.state = "retry_backoff";
              job.stateVersion += 1;
              job.attemptToken = null;
              releaseSlotIfHeld(job);
              removeFromQueue(job);
              gateF.completeOwner({ jobId: job.id, recoveryOwnerJobId: null });
              drain();
              return;
            }
            job.state = "failed";
            job.stateVersion += 1;
            job.attemptToken = null;
            releaseSlotIfHeld(job);
            clearEphemeralOnce(job);
            removeFromQueue(job);
            gateF.completeOwner({ jobId: job.id, recoveryOwnerJobId: null });
            drain();
            return;
          }
          completeProviderOwner(job, attemptToken, "failed");
          return;
        }

        if (FailureClassify.isSaturationCandidate(category)) {
          // Running non-owner under existing saturated/recovering joins that wait
          // without generation bump (enterSaturation guards on normal).
          if (snapF.state === "saturated" || snapF.state === "recovering") {
            if (snapF.ownerJobId !== job.id) {
              joinExistingSaturationWait(job, snapF);
              return;
            }
          }
          var owner = pickOldestActiveSibling(job.providerKey, job.id);
          if (owner && owner.id !== job.id) {
            enterSaturation(job, owner);
            return;
          }
          // No viable sibling: positive budget → retry_backoff; zero → terminal failed.
          // Never provider wait; never Firefox.
          if (job.retryRemaining > 0) {
            enterRetryBackoff(job, attemptToken);
          } else {
            terminalizeRunning(job, attemptToken, "failed");
          }
          return;
        }

        // Non-candidate permanent (or local_io / range_unsupported / cancelled category): terminal failed.
        terminalizeRunning(job, attemptToken, "failed");
        return;
      }
      // Unknown status: no-op.
    }

    // Public surface — stable method names for Tasks 10–11 extensions.
    return {
      createJob: createJob,
      enqueue: enqueue,
      setMaxConcurrent: setMaxConcurrent,
      onTransportResult: onTransportResult,
      getJob: getJob,
      getSnapshot: getSnapshot,
      notePermitAcquired: notePermitAcquired,
      releasePermit: releasePermit,
      acquireProviderPermit: acquireProviderPermit,
      onQuiesced: onQuiesced,
      noteNativeOpen: noteNativeOpen,
      nativeLeaseFor: nativeLeaseFor,
      userStatus: userStatus,
      // Placeholders reserved so later tasks extend without reshaping the object:
      // cancel, onCapabilitySwitch, issueAttemptToken, manualRetry, requestFirefoxHandoff, tick
    };
  }

  return {
    createDownloadScheduler: createDownloadScheduler,
  };
});
