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
   * Pure synchronous download scheduler — global admission, provider saturation,
   * finite retries, cancel drain, capability switch, and explicit Firefox handoff
   * (Tasks 9–11).
   *
   * Session memory only. No real timers, no browser globals.
   *
   * States: created | queued | running | pausing_provider | waiting_provider |
   *         retry_backoff | needs_user | handing_off_firefox | handed_to_firefox |
   *         completed | failed | cancelled
   *
   * Slot contract: holdsGlobalSlot boolean token + stateVersion CAS.
   * globalRunning === count(holdsGlobalSlot === true) always.
   * pausing_provider is the only non-running state that may hold a slot.
   * retry_backoff / waiting_provider / needs_user / handing_off_firefox /
   * handed_to_firefox / terminal hold no slot.
   *
   * Fairness: FIFO within providerKey; round-robin across providers.
   * providerKey is always the captured key — never derived from mediaOrigin/CDN.
   *
   * ProviderGate is the sole internal permit/lease authority. Public surface exposes
   * only acquireProviderPermit (no raw gate / gate.acquire leakage).
   *
   * Firefox: requestFirefoxHandoff is the ONLY path that may invoke firefoxDownload.
   * Automatic failures, saturation, range switch, cancel, tick, and local_io never call it.
   *
   * issueAttemptToken(jobId): returns the current live attempt token for a running
   * job that already holds one. Never rotates the token, never mutates budget/slot,
   * and throws when there is no live attempt (created/queued/backoff/needs_user/terminal).
   * Fresh tokens are issued only by admitJob on actual admission.
   */
  function createDownloadScheduler(opts) {
    opts = opts || {};
    var maxConcurrent = requirePositiveInt(opts.maxConcurrent, "maxConcurrent");
    var now = opts.now == null ? function () { return Date.now(); } : requireFunction(opts.now, "now");
    var randomToken =
      opts.randomToken == null ? defaultRandomToken() : requireFunction(opts.randomToken, "randomToken");
    // Guarded Firefox adapter hook — automatic failures/saturation MUST NEVER call it.
    var firefoxDownload = null;
    if (opts.firefoxDownload != null) {
      firefoxDownload = requireFunction(opts.firefoxDownload, "firefoxDownload");
    }
    // One-time popup token store: Set of tokens, or Map jobId -> token (or Set of tokens).
    var popupTokenStore = opts.popupTokenStore == null ? null : opts.popupTokenStore;

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
    // Last observed tick time (reject backward only as no-op for due checks).
    var lastTickMs = null;

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
      // Safe allowlist — never ephemeral, cookies, headers, signed URLs, mediaOrigin,
      // drainingAttemptToken, pendingDrainTerminal, or drainTransportUnavailable.
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
        localActivities: job.localActivities || 0,
      });
    }

    /** Scheduler-private only — never projected or echoed in errors. */
    function clearDrainingState(job) {
      if (!job) return;
      job.drainingAttemptToken = null;
      job.pendingDrainTerminal = null;
      job.drainTransportUnavailable = false;
    }

    /**
     * Invalidate local-activity leases for a physical attempt boundary.
     * Zeros the projected count and advances the private epoch so stale
     * release() calls are inert. Never projected.
     */
    function invalidateLocalActivities(job) {
      if (!job) return;
      job.localActivities = 0;
      job.localActivityEpoch =
        (Number.isInteger(job.localActivityEpoch) ? job.localActivityEpoch : 0) + 1;
    }

    /**
     * Confirm ProviderGate native-open zero without auto-quiescing.
     * Mirrors onTransportUnavailable failure-atomicity: throw-before leaves
     * gate/job coherent and retryable; mutate-then-throw may continue once.
     * Returns true when zero is confirmed; rethrows throw-before faults.
     */
    function confirmNativeOpenZero(job) {
      var gate = getGate(job.providerKey);
      var nativeConfirmed = false;
      try {
        gate.noteNativeOpen(job.id, 0);
        nativeConfirmed = true;
      } catch (errNative) {
        var openAfter = gate.snapshot().nativeOpen;
        var gateOpens =
          openAfter && Object.prototype.hasOwnProperty.call(openAfter, job.id)
            ? openAfter[job.id]
            : null;
        if (gateOpens === 0) {
          nativeConfirmed = true;
        } else {
          throw errNative;
        }
      }
      if (!nativeConfirmed) return false;
      var openSnap = gate.snapshot().nativeOpen;
      if (
        openSnap &&
        Object.prototype.hasOwnProperty.call(openSnap, job.id) &&
        openSnap[job.id] !== 0
      ) {
        return false;
      }
      job.nativeOpenConnections = 0;
      return true;
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
        (!job.nativeOpenConnections || job.nativeOpenConnections <= 0) &&
        (!job.localActivities || job.localActivities <= 0)
      );
    }

    /**
     * Terminalize a waiting_provider job exactly once: remove from wait/provider
     * queues, release a held slot only if present, clear attempt token + ephemeral,
     * and close the wait epoch so it cannot be re-woken.
     */
    function isTrulyTerminal(state) {
      return (
        state === "completed" ||
        state === "failed" ||
        state === "cancelled" ||
        state === "handed_to_firefox"
      );
    }

    function clearRetryDeadline(job) {
      job.retryDeadlineMs = null;
    }

    /**
     * Enter needs_user: release capacity, clear deadline/queues/token, keep ephemeral
     * for a later manualRetry or explicit Firefox handoff. Never holds a slot.
     */
    function enterNeedsUser(job) {
      if (!job) return false;
      if (isTrulyTerminal(job.state) || job.state === "needs_user") {
        if (job.state === "needs_user") {
          clearRetryDeadline(job);
          releaseSlotIfHeld(job);
          removeFromQueue(job);
          removeFromWaitQueue(job);
          clearDrainingState(job);
          invalidateLocalActivities(job);
        }
        return false;
      }
      removeFromWaitQueue(job);
      removeFromQueue(job);
      releaseSlotIfHeld(job);
      clearRetryDeadline(job);
      clearDrainingState(job);
      invalidateLocalActivities(job);
      job.state = "needs_user";
      job.stateVersion += 1;
      job.attemptToken = null;
      job.consumeRetryOnWake = false;
      job.wakeRetryConsumed = true;
      job.wakeAuthorized = true;
      // Keep ephemeral for manual retry / explicit Firefox.
      return true;
    }

    function terminalizeWaitingJob(job, nextState) {
      if (!job || job.state !== "waiting_provider") return false;
      removeFromWaitQueue(job);
      removeFromQueue(job);
      releaseSlotIfHeld(job);
      clearRetryDeadline(job);
      clearDrainingState(job);
      invalidateLocalActivities(job);
      job.state = nextState;
      job.stateVersion += 1;
      job.attemptToken = null;
      job.consumeRetryOnWake = false;
      job.wakeRetryConsumed = true;
      job.wakeAuthorized = true;
      if (isTrulyTerminal(nextState)) {
        clearEphemeralOnce(job);
      }
      return true;
    }

    /** Failed waiter with zero retry budget must not requeue forever. */
    function isExhaustedFailedWaiter(job) {
      return (
        !!job &&
        job.state === "waiting_provider" &&
        job.consumeRetryOnWake === true &&
        job.retryRemaining <= 0
      );
    }

    /**
     * After a job becomes waiting_provider (including late quiesce), authorize
     * progress only when the gate can accept work: recovering-blocked with no
     * owner, or normal after recovery. Never admit directly — wake → queued → drain.
     * Active saturated/recovering owners leave the waiter parked.
     */
    function maybeAuthorizeReadyWaiter(job) {
      if (!job || job.state !== "waiting_provider") return;
      var gate = getGate(job.providerKey);
      var snap = null;
      // Bound snapshot faults: a single injected throw must not permanently
      // strand a waiter when the gate is already normal/recovering-blocked.
      // Never throw out of a quiesce/release transaction.
      for (var snapAttempt = 0; snapAttempt < 2 && !snap; snapAttempt++) {
        try {
          snap = gate.snapshot();
        } catch (errSnap) {
          snap = null;
        }
      }
      if (!snap) return;
      if (snap.state === "recovering" && snap.ownerJobId == null) {
        // Prefer oldest eligible (skips/terminalizes exhausted FIFO heads).
        var next = oldestEligibleWaiter(job.providerKey);
        if (next) authorizeWake(next);
        return;
      }
      if (snap.state === "normal") {
        authorizeWake(job);
      }
      // saturated with drain owner, or recovering with active owner: remain parked.
    }

    /**
     * Best-effort follow-up after a quiesce transition that may have thrown mid-way.
     * Never throws. Safe to call when job already left pausing_provider.
     */
    function finishQuiesceSideEffects(job) {
      if (!job) return;
      if (job.state === "waiting_provider") {
        try {
          maybeAuthorizeReadyWaiter(job);
        } catch (errAuth) {
          // Nonthrowing by contract; defensive.
        }
      }
      try {
        drain();
      } catch (errDrain) {
        // Admission/drain faults must not escape local-release / quiesce edges.
      }
    }

    /**
     * Shared quiesce edge: pausing_provider settles once when total permits and
     * native opens are both zero. A stored draining terminal is dispatched before
     * default pausing → waiting. Transport-unavailable with no pending outcome
     * settles cancel (if requested) or needs_user before ordinary waiting.
     * State guard only (single-threaded).
     * Late quiesce after owner completion / recovery-to-normal auto-authorizes wake
     * when the gate is recovering-blocked or normal (never while an owner is active).
     * Internally nonthrowing once state mutation begins: gate/hook faults are
     * reconciled so a live local-activity release can always observe a coherent
     * post-state (waiting / terminal / needs_user / still-pausing).
     */
    function maybeQuiesce(job) {
      if (!job) return;
      if (job.state !== "pausing_provider") return;
      if (!isQuiescent(job)) return;
      try {
        // Stored draining terminal settles before default pause-control waiting.
        if (job.pendingDrainTerminal != null) {
          settleDrainingTerminal(job);
          return;
        }
        // Fail-closed hold: physical counters are zero but the semantic terminal for
        // this exact private draining identity has not arrived yet. Do not erase
        // auth, release the slot, or move to waiting/cancelled — matching
        // onDrainingTransportResult settles later; onTransportUnavailable escapes.
        if (
          typeof job.drainingAttemptToken === "string" &&
          job.drainingAttemptToken.trim().length > 0
        ) {
          return;
        }
        // Cancel-requested pausing work finishes as cancelled once quiescent.
        if (job.cancelRequested === true) {
          releaseSlotIfHeld(job);
          removeFromWaitQueue(job);
          removeFromQueue(job);
          clearRetryDeadline(job);
          clearDrainingState(job);
          invalidateLocalActivities(job);
          job.state = "cancelled";
          job.stateVersion += 1;
          job.attemptToken = null;
          clearEphemeralOnce(job);
          finishQuiesceSideEffects(job);
          return;
        }
        // Helper disconnect with no pending outcome: park needs_user once provider
        // permits also reach zero. Helper disappearance proves native zero only.
        if (job.drainTransportUnavailable === true) {
          enterNeedsUser(job);
          finishQuiesceSideEffects(job);
          return;
        }
        clearDrainingState(job);
        job.state = "waiting_provider";
        job.stateVersion += 1;
        job.attemptToken = null;
        releaseSlotIfHeld(job);
        appendWaitFifo(job);
        finishQuiesceSideEffects(job);
      } catch (errQuiesce) {
        // Mutate-then-throw: complete authorization/drain without rethrowing so a
        // local-activity release can seal as true without stranding waiters.
        finishQuiesceSideEffects(job);
      }
    }

    /**
     * Apply a once-accepted private draining terminal after full permit/native
     * quiescence. Pausing jobs are non-owners — never mutates ProviderGate ownership.
     * Precedence: cancelRequested > completed > drainTransportUnavailable > outcome class.
     */
    function settleDrainingTerminal(job) {
      if (!job || job.state !== "pausing_provider") return false;
      var outcome = job.pendingDrainTerminal;
      if (!outcome || typeof outcome !== "object") return false;
      // Capture private unavailable-during-drain before clearing private drain state.
      var transportUnavailable = job.drainTransportUnavailable === true;
      // Consume pending exactly once.
      job.pendingDrainTerminal = null;
      job.drainingAttemptToken = null;
      job.drainTransportUnavailable = false;
      // Physical attempt settles: fence any leftover local-activity leases.
      invalidateLocalActivities(job);

      // User cancel wins over any stored native terminal (and over unavailable).
      if (job.cancelRequested === true) {
        releaseSlotIfHeld(job);
        removeFromWaitQueue(job);
        removeFromQueue(job);
        clearRetryDeadline(job);
        job.state = "cancelled";
        job.stateVersion += 1;
        job.attemptToken = null;
        clearEphemeralOnce(job);
        drain();
        return true;
      }

      var status = outcome.status;

      if (status === "completed") {
        // Completed/committed is the semantic terminal even if the helper
        // disconnected while wrapper/observed permits still drained.
        releaseSlotIfHeld(job);
        removeFromWaitQueue(job);
        removeFromQueue(job);
        clearRetryDeadline(job);
        job.state = "completed";
        job.stateVersion += 1;
        job.attemptToken = null;
        job.consumeRetryOnWake = false;
        clearEphemeralOnce(job);
        drain();
        return true;
      }

      // Helper unavailable during drain: non-success pending outcomes park
      // needs_user once fully quiescent. No wake, no retry charge, no Firefox.
      if (transportUnavailable) {
        enterNeedsUser(job);
        drain();
        return true;
      }

      if (status === "cancelled") {
        // Pause-control ack: waiting_provider, no paused-only retry charge.
        job.state = "waiting_provider";
        job.stateVersion += 1;
        job.attemptToken = null;
        releaseSlotIfHeld(job);
        appendWaitFifo(job);
        maybeAuthorizeReadyWaiter(job);
        drain();
        return true;
      }

      if (status === "failed") {
        var category = outcome.failureCategory;
        var partState = outcome.partState;
        var mode = outcome.mode;

        // range_unsupported + empty multi-range → capability park (fresh token later).
        if (
          category === "range_unsupported" &&
          mode === "multi-range" &&
          partState === "empty"
        ) {
          job.mode = "single-connection";
          job.effectiveConcurrency = 1;
          syncJobLimit(job);
          job.state = "waiting_provider";
          job.stateVersion += 1;
          job.attemptToken = null;
          releaseSlotIfHeld(job);
          appendWaitFifo(job);
          maybeAuthorizeReadyWaiter(job);
          drain();
          return true;
        }

        // Non-empty range_unsupported follows permanent/needs_user handling.
        if (category === "range_unsupported") {
          enterNeedsUser(job);
          clearDrainingState(job);
          drain();
          return true;
        }

        if (category === "local_io" || category === "permanent") {
          enterNeedsUser(job);
          clearDrainingState(job);
          drain();
          return true;
        }

        if (FailureClassify.isSaturationCandidate(category)) {
          // Mark consume-on-wake idempotently; wake-time charges once per epoch.
          if (job.wakeRetryConsumed !== true) {
            job.consumeRetryOnWake = true;
          }
          job.state = "waiting_provider";
          job.stateVersion += 1;
          job.attemptToken = null;
          releaseSlotIfHeld(job);
          appendWaitFifo(job);
          maybeAuthorizeReadyWaiter(job);
          drain();
          return true;
        }

        // failed + failureCategory cancelled: permanent-class terminal failed.
        // Distinct from status cancelled (pause-control ack → waiting_provider).
        if (category === "cancelled") {
          releaseSlotIfHeld(job);
          removeFromWaitQueue(job);
          removeFromQueue(job);
          clearRetryDeadline(job);
          job.state = "failed";
          job.stateVersion += 1;
          job.attemptToken = null;
          job.consumeRetryOnWake = false;
          clearEphemeralOnce(job);
          drain();
          return true;
        }

        // Unknown/other permanent-class failures: needs_user, never Firefox.
        enterNeedsUser(job);
        clearDrainingState(job);
        drain();
        return true;
      }

      // Unknown status should never have been stored; fail closed as waiting.
      job.state = "waiting_provider";
      job.stateVersion += 1;
      job.attemptToken = null;
      releaseSlotIfHeld(job);
      appendWaitFifo(job);
      maybeAuthorizeReadyWaiter(job);
      drain();
      return true;
    }

    // Null-prototype allowlists: ordinary objects accept inherited keys such as
    // "__proto__", "constructor", and "toString" as truthy membership.
    var ALLOWED_DRAIN_STATUSES = Object.freeze(
      Object.assign(Object.create(null), {
        completed: true,
        cancelled: true,
        failed: true,
      })
    );
    var ALLOWED_DRAIN_MODES = Object.freeze(
      Object.assign(Object.create(null), {
        "multi-range": true,
        "single-connection": true,
      })
    );
    var ALLOWED_DRAIN_PART_STATES = Object.freeze(
      Object.assign(Object.create(null), {
        committed: true,
        empty: true,
        partial: true,
      })
    );
    var KNOWN_DRAIN_FAILURE_CATEGORIES = Object.freeze(
      Object.assign(Object.create(null), {
        range_unsupported: true,
        timeout: true,
        connection_reset: true,
        short_read: true,
        http_429: true,
        http_5xx_temporary: true,
        local_io: true,
        cancelled: true,
        permanent: true,
      })
    );

    function isOwnAllowlisted(dict, key) {
      return (
        typeof key === "string" &&
        Object.prototype.hasOwnProperty.call(dict, key) === true &&
        dict[key] === true
      );
    }

    /**
     * Snapshot one own DATA descriptor value without invoking accessors.
     * Returns { ok:false } on missing required field, accessor, or trap/error.
     * Optional fields may be absent (ok with value undefined).
     */
    function readOwnDataField(obj, key, required) {
      try {
        var desc = Object.getOwnPropertyDescriptor(obj, key);
        if (desc == null) {
          if (required) return { ok: false };
          return { ok: true, value: undefined };
        }
        // Reject accessors even when the property is optional.
        if (
          typeof desc.get === "function" ||
          typeof desc.set === "function" ||
          !Object.prototype.hasOwnProperty.call(desc, "value")
        ) {
          return { ok: false };
        }
        return { ok: true, value: desc.value };
      } catch (err) {
        return { ok: false };
      }
    }

    /**
     * Validate a draining terminal result into a scheduler-owned allowlist.
     * Never coerces hostile values; returns null when invalid.
     * Reads only own DATA descriptors for status/mode/partState/failureCategory —
     * never executes accessors or propagates proxy/getter errors.
     */
    function validateDrainingResult(result) {
      if (!result || typeof result !== "object") return null;

      var statusRead;
      var modeRead;
      var partRead;
      var failRead;
      try {
        statusRead = readOwnDataField(result, "status", true);
        modeRead = readOwnDataField(result, "mode", true);
        partRead = readOwnDataField(result, "partState", true);
        failRead = readOwnDataField(result, "failureCategory", false);
      } catch (err) {
        return null;
      }
      if (!statusRead.ok || !modeRead.ok || !partRead.ok || !failRead.ok) {
        return null;
      }

      var status = statusRead.value;
      var mode = modeRead.value;
      var partState = partRead.value;
      var failureCategory = failRead.value;

      // Exact built-in primitive strings only — no boxed String coercion.
      // Own-membership only so inherited Object.prototype keys never match.
      if (typeof status !== "string" || !isOwnAllowlisted(ALLOWED_DRAIN_STATUSES, status)) {
        return null;
      }
      if (typeof mode !== "string" || !isOwnAllowlisted(ALLOWED_DRAIN_MODES, mode)) {
        return null;
      }
      if (
        typeof partState !== "string" ||
        !isOwnAllowlisted(ALLOWED_DRAIN_PART_STATES, partState)
      ) {
        return null;
      }

      var outCategory = null;
      if (status === "completed") {
        if (partState !== "committed") return null;
        if (failureCategory !== null && failureCategory !== undefined) return null;
        outCategory = null;
      } else if (status === "cancelled") {
        // Accept only absent/undefined/null or exact primitive "cancelled".
        if (failureCategory === undefined || failureCategory === null) {
          outCategory = "cancelled";
        } else if (
          typeof failureCategory === "string" &&
          failureCategory === "cancelled"
        ) {
          outCategory = "cancelled";
        } else {
          return null;
        }
      } else if (status === "failed") {
        if (partState === "committed") return null;
        if (typeof failureCategory !== "string") return null;
        if (!isOwnAllowlisted(KNOWN_DRAIN_FAILURE_CATEGORIES, failureCategory)) {
          return null;
        }
        outCategory = failureCategory;
      } else {
        return null;
      }

      return deepFreeze({
        status: status,
        mode: mode,
        failureCategory: outCategory,
        partState: partState,
      });
    }

    /**
     * Authenticate a late physical native terminal for a pausing_provider job
     * against the private draining attempt token. Zeros native opens atomically,
     * stores at most one allowlisted pending outcome, and settles when fully
     * quiescent. Returns true only when the terminal is accepted.
     */
    function onDrainingTransportResult(jobId, oldAttemptToken, result) {
      var job = jobs.get(jobId);
      if (!job) return false;
      if (job.state !== "pausing_provider") return false;
      // Exact primitive built-in string identity — no String() / boxed coercion.
      if (typeof oldAttemptToken !== "string") return false;
      if (oldAttemptToken.trim().length === 0) return false;
      if (typeof job.drainingAttemptToken !== "string") return false;
      if (job.drainingAttemptToken !== oldAttemptToken) return false;
      // Already accepted a terminal for this draining identity.
      if (job.pendingDrainTerminal != null) return false;

      var allowlisted = validateDrainingResult(result);
      if (!allowlisted) return false;
      // Mode must match the job's current mode (range switch is a settlement effect).
      if (allowlisted.mode !== job.mode) return false;

      // Reconcile native-open zero inside this API before consuming the terminal.
      // Do NOT call public noteNativeOpen(0) — that would auto-quiesce and destroy auth.
      if (!confirmNativeOpenZero(job)) return false;

      // Accept: clear private auth token and freeze the pending outcome.
      job.drainingAttemptToken = null;
      job.pendingDrainTerminal = allowlisted;

      if (isQuiescent(job)) {
        settleDrainingTerminal(job);
      }
      // Else remain pausing_provider holding the global slot until wrapper/observed
      // permits also reach zero; maybeQuiesce dispatches the stored terminal.
      return true;
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
      // Fresh physical attempt: old draining identity must never re-authenticate.
      clearDrainingState(job);
      // Fresh local-activity epoch; prior leases cannot decrement this attempt.
      invalidateLocalActivities(job);
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
      // Immediate waiting without a physical attempt (or after pause drain without
      // a stored terminal) invalidates any private draining identity.
      if (job.pendingDrainTerminal == null) {
        clearDrainingState(job);
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
      // transportTerminalConsumed: this job's own transport terminal was already
      // accepted (e.g. saturation failure via onTransportResult). Never capture
      // or preserve a private drain identity for that physical attempt — late
      // old-token contradictions must not re-authenticate. Clear any stale
      // private drain state before public token nulling.
      if (opts.transportTerminalConsumed === true) {
        clearDrainingState(job);
      } else if (
        job.drainingAttemptToken == null &&
        typeof job.attemptToken === "string" &&
        job.attemptToken.trim().length > 0 &&
        Number.isInteger(job.nativeOpenConnections) &&
        job.nativeOpenConnections > 0
      ) {
        // Paused-only sibling with a live native open at pause entry: capture the
        // physical attempt token before public nulling so a late native terminal
        // can authenticate privately. Permit-only non-quiescence (native opens
        // already zero) has no native pget terminal to await — do not capture.
        // Never overwrite an existing draining identity on repeat pause calls.
        job.drainingAttemptToken = job.attemptToken;
      }
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

    /**
     * Ordinary transient failure with matching live token:
     * - budget remaining: charge once, enter retry_backoff with deadline
     * - budget exhausted: enter needs_user
     * Duplicate/stale tokens no-op. Never Firefox.
     */
    function scheduleAutomaticRetry(job, attemptToken) {
      if (!job) return false;
      if (job.state !== "running") return false;
      if (!isNonblankString(attemptToken)) return false;
      if (job.attemptToken !== attemptToken) return false;
      if (job.cancelRequested === true) {
        // Cancel wins over retry: treat as cancelled terminalization.
        return terminalizeRunning(job, attemptToken, "cancelled");
      }
      assertRunningOwnsSlot(job);

      if (job.retryRemaining <= 0) {
        enterNeedsUser(job);
        removeFromQueue(job);
        drain();
        return true;
      }

      // Charge budget exactly once under the matching attempt token.
      job.retryRemaining -= 1;
      job.retryUsed += 1;
      // deadline = now + min(30000, 1000 * 2^automaticRetriesUsed)
      var delay = Math.min(30000, 1000 * Math.pow(2, job.retryUsed));
      var nowMs = now();
      if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) nowMs = 0;
      job.retryDeadlineMs = nowMs + delay;

      clearDrainingState(job);
      invalidateLocalActivities(job);
      job.state = "retry_backoff";
      job.stateVersion += 1;
      job.attemptToken = null;
      releaseSlotIfHeld(job);
      removeFromQueue(job);
      drain();
      return true;
    }

    function enterRetryBackoff(job, attemptToken) {
      // Compatibility alias: ordinary transient path uses scheduleAutomaticRetry.
      return scheduleAutomaticRetry(job, attemptToken);
    }

    /**
     * Terminalize a running job that presents the current attempt token.
     * Same transaction: release slot, bump stateVersion once, clear ephemeral
     * once when truly terminal, then drain. Late/duplicate/wrong-token → no-op.
     * needs_user is non-terminal for ephemeral (manual retry / Firefox).
     */
    function terminalizeRunning(job, attemptToken, nextState) {
      if (!job) return false;
      if (job.state !== "running") return false;
      if (!isNonblankString(attemptToken)) return false;
      if (job.attemptToken !== attemptToken) return false;

      assertRunningOwnsSlot(job);

      clearDrainingState(job);
      invalidateLocalActivities(job);
      job.state = nextState;
      job.stateVersion += 1;
      job.holdsGlobalSlot = false;
      globalRunning -= 1;
      job.attemptToken = null;
      clearRetryDeadline(job);
      if (isTrulyTerminal(nextState)) {
        clearEphemeralOnce(job);
      }
      removeFromQueue(job);
      drain();
      return true;
    }

    /**
     * Oldest eligible waiting_provider for recovery/wake selection.
     * Exhausted failed waiters are terminalized in FIFO order (bounded, non-recursive)
     * so they never become recovery owners or requeue forever. Paused-only waiters
     * at zero budget remain eligible.
     */
    function oldestEligibleWaiter(providerKey) {
      var w = providerWaitQueues.get(providerKey) || [];
      var i = 0;
      while (i < w.length) {
        var j = jobs.get(w[i]);
        if (!j) {
          i += 1;
          continue;
        }
        if (j.state !== "waiting_provider") {
          i += 1;
          continue;
        }
        if (j.cancelRequested === true) {
          i += 1;
          continue;
        }
        if (isExhaustedFailedWaiter(j)) {
          // Exhausted failed waiters enter needs_user (final Task-11 rule).
          // Removes from wait queue; next candidate shifts into index i.
          terminalizeWaitingJob(j, "needs_user");
          continue;
        }
        return j;
      }
      return null;
    }

    /**
     * Single authorized wake of a waiting_provider job back to queued for the
     * current wait epoch. Late duplicates in the same epoch no-op.
     * Failed waiters consume at most one retry per epoch; paused-only consume none.
     * Exhausted failed waiters enter needs_user instead of requeueing.
     * Never bypasses global admission — appends wait-FIFO order into provider FIFO,
     * then central drain applies global cap / round-robin.
     */
    function authorizeWake(job) {
      if (!job || job.state !== "waiting_provider") return false;
      // Per wait-epoch idempotence (not job lifetime).
      if (job.wakeAuthorized) return false;

      // Exhausted failed waiter: needs_user exactly once; do not requeue.
      if (isExhaustedFailedWaiter(job)) {
        terminalizeWaitingJob(job, "needs_user");
        return false;
      }

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
      clearDrainingState(job);
      invalidateLocalActivities(job);
      job.state = nextState;
      job.stateVersion += 1;
      job.holdsGlobalSlot = false;
      globalRunning -= 1;
      job.attemptToken = null;
      clearRetryDeadline(job);
      if (isTrulyTerminal(nextState)) {
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

      clearDrainingState(job);
      invalidateLocalActivities(job);
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
      // Own failure already consumed by onTransportResult — no private drain auth.
      pauseOrWaitNonOwner(failedJob, {
        consumeRetryOnWake: true,
        transportTerminalConsumed: true,
      });
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
        // Failed job: transport terminal already consumed — no private drain token.
        // Paused-only siblings: capture drain token for late native terminals.
        pauseOrWaitNonOwner(j, {
          consumeRetryOnWake: isFailed,
          transportTerminalConsumed: isFailed,
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
      var configuredRetries = clampRetries(input.retries);
      var retryRemaining = configuredRetries;

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
        configuredRetries: configuredRetries,
        retryRemaining: retryRemaining,
        retryUsed: 0,
        retryDeadlineMs: null,
        effectiveConcurrency: segmentConcurrency,
        intent: intent,
        attemptToken: null,
        mode: "multi-range",
        mediaKind: mediaKind,
        mediaOrigin: mediaOrigin,
        ephemeral: ephemeral,
        autoWakeCount: 0,
        cancelRequested: false,
        firefoxHandoffInFlight: false,
        // Separate wrapper-owned vs observation-adapter permit counts.
        // Projected inFlightPermits is their exact sum.
        wrapperPermits: 0,
        observedPermits: 0,
        nativeOpenConnections: 0,
        // Local assembly/sink activity accounting (count projected; epoch private).
        localActivities: 0,
        localActivityEpoch: 0,
        // Saturation wake bookkeeping (not projected).
        waitEpoch: 0,
        consumeRetryOnWake: false,
        wakeRetryConsumed: false,
        wakeAuthorized: false,
        // Private draining identity for outstanding physical native attempts
        // while public attemptToken is nulled in pausing_provider. Never projected.
        drainingAttemptToken: null,
        pendingDrainTerminal: null,
        // Private: helper disconnected after an authenticated pending drain
        // terminal was accepted. Never projected or echoed in errors.
        drainTransportUnavailable: false,
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
      // Ignore late observations outside the live permit lifetime so waiting /
      // terminal jobs cannot re-inflate counts and block a later cycle.
      if (job.state !== "running" && job.state !== "pausing_provider") return;
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
    /**
     * Reconcile a local-activity release after a scheduler/gate fault.
     * Returns whether the live lease was consumed (true) or remains retryable
     * (false). Never throws. Sealing the closure `released` flag is the caller's
     * responsibility when this returns true OR when the lease is known stale.
     */
    function reconcileLocalActivityRelease(job, epoch) {
      if (!job) return false;
      // Forced fence / generation change: this lease is dead.
      if ((job.localActivityEpoch || 0) !== epoch) {
        return false;
      }
      // Mutate-then: already left pausing with the decrement applied.
      if (job.state === "waiting_provider") {
        finishQuiesceSideEffects(job);
        return true;
      }
      if (
        job.state === "needs_user" ||
        job.state === "cancelled" ||
        job.state === "completed" ||
        job.state === "failed" ||
        job.state === "handed_to_firefox"
      ) {
        finishQuiesceSideEffects(job);
        return true;
      }
      // Still pausing/running: attempt to complete quiesce once more.
      if (job.state === "pausing_provider" && isQuiescent(job)) {
        try {
          maybeQuiesce(job);
        } catch (errRetry) {
          finishQuiesceSideEffects(job);
        }
        if (job.state !== "pausing_provider") {
          return true;
        }
        // Still pausing after retry with zero local count and no other activity:
        // unknown split-brain — restore the decrement so the lease stays retryable.
        if (isQuiescent(job) && (job.localActivities || 0) === 0) {
          // Quiesce should have progressed; if it did not, restore for retry.
          job.localActivities = 1;
          return false;
        }
      }
      // Throw-before coherent transition (or non-quiescent after decrement only):
      // restore the count when still on this epoch and state was not advanced.
      if (
        (job.state === "pausing_provider" || job.state === "running") &&
        (job.localActivityEpoch || 0) === epoch
      ) {
        job.localActivities = (job.localActivities || 0) + 1;
        return false;
      }
      // Cannot safely restore; do not seal as success.
      return false;
    }

    /**
     * Acquire a scheduler-owned local activity lease for assembly / sink cleanup.
     * Not a provider permit or native connection. Only a live running job without
     * cancel or Firefox handoff may acquire. purpose must be a primitive nonblank
     * string (no coercion). Returns a frozen {jobId, purpose, release} or null.
     * release() is failure-atomic: returns a boolean, never propagates gate /
     * scheduler-hook exceptions, and seals the lease only after the count
     * decrement and any final quiesce transition are coherent.
     */
    function acquireLocalActivity(jobId, purpose) {
      var job = jobs.get(jobId);
      if (!job) return null;
      if (job.state !== "running") return null;
      if (job.cancelRequested === true) return null;
      if (job.firefoxHandoffInFlight === true) return null;
      // Exact primitive string — reject boxed String / objects without coercion.
      if (typeof purpose !== "string" || purpose.trim().length === 0) {
        throw new TypeError("purpose must be a nonblank string");
      }

      job.localActivities = (job.localActivities || 0) + 1;
      var epoch = job.localActivityEpoch || 0;
      var released = false;
      var purposeValue = purpose;

      return Object.freeze({
        jobId: job.id,
        purpose: purposeValue,
        release: function releaseLocalActivity() {
          if (released) return false;
          try {
            var current = jobs.get(jobId);
            if (current !== job) {
              released = true;
              return false;
            }
            if ((current.localActivityEpoch || 0) !== epoch) {
              released = true;
              return false;
            }
            if (!(current.localActivities > 0)) {
              released = true;
              return false;
            }
            // Decrement first; do not seal until quiesce is coherent.
            current.localActivities -= 1;
            try {
              maybeQuiesce(current);
              released = true;
              return true;
            } catch (errRelease) {
              var ok = reconcileLocalActivityRelease(current, epoch);
              if (ok || (current.localActivityEpoch || 0) !== epoch) {
                released = true;
              }
              // Stale epoch after fence: seal as inert false.
              if ((current.localActivityEpoch || 0) !== epoch) {
                return false;
              }
              return ok;
            }
          } catch (errOuter) {
            // Public release must never throw.
            return false;
          }
        },
      });
    }

    function acquireProviderPermit(jobId, purpose) {
      var job = jobs.get(jobId);
      if (!job) return null;
      if (job.state !== "running") return null;
      if (job.cancelRequested === true) return null;
      if (job.firefoxHandoffInFlight === true) return null;
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

      // Late results after needs_user / terminal / backoff with no live token: no-op.
      if (
        job.state === "needs_user" ||
        job.state === "retry_backoff" ||
        job.state === "handing_off_firefox" ||
        job.state === "handed_to_firefox" ||
        isTrulyTerminal(job.state)
      ) {
        return;
      }

      if (status === "completed") {
        if (job.state !== "running") return;
        if (!isNonblankString(attemptToken) || job.attemptToken !== attemptToken) return;

        // cancelRequested: completion after cancel becomes cancelled (idempotent release).
        if (job.cancelRequested === true) {
          status = "cancelled";
        } else {
          // Successful recovery owner → recoverToNormal.
          var gateC = getGate(job.providerKey);
          var snapC = gateC.snapshot();
          if (
            snapC.state === "recovering" &&
            snapC.ownerJobId === job.id
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
      }

      if (status === "cancelled") {
        if (job.state !== "running") return;
        if (!isNonblankString(attemptToken) || job.attemptToken !== attemptToken) return;
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

        // cancelRequested wins over failure classification.
        if (job.cancelRequested === true) {
          var gateCancel = getGate(job.providerKey);
          var snapCancel = gateCancel.snapshot();
          if (
            (snapCancel.state === "saturated" || snapCancel.state === "recovering") &&
            snapCancel.ownerJobId === job.id
          ) {
            completeProviderOwner(job, attemptToken, "cancelled");
            return;
          }
          terminalizeRunning(job, attemptToken, "cancelled");
          return;
        }

        var category = result.failureCategory;
        // Never call Firefox on automatic failures/saturation.

        var gateF = getGate(job.providerKey);
        var snapF = gateF.snapshot();

        // Owner failure while saturated/recovering: hand off via completeOwner
        // (or bounded retry / needs_user if no waiter).
        if (
          (snapF.state === "saturated" || snapF.state === "recovering") &&
          snapF.ownerJobId === job.id
        ) {
          // local_io: never saturation/Firefox. Advance authenticated owner generation,
          // wake at most one eligible waiter, put owner in needs_user (ephemeral retained).
          // Reuses completeProviderOwner — same ordering as other owner terminal paths.
          if (category === "local_io") {
            completeProviderOwner(job, attemptToken, "needs_user");
            return;
          }
          var waiter = oldestEligibleWaiter(job.providerKey);
          if (waiter) {
            // Owner ends; wake chain selects next. Permanent/transient both release owner.
            completeProviderOwner(job, attemptToken, "failed");
            return;
          }
          // No waiter: ordinary bounded retry / needs_user. Never leave exhausted owner retrying.
          if (FailureClassify.isSaturationCandidate(category)) {
            assertRunningOwnsSlot(job);
            if (job.retryRemaining > 0) {
              // Charge + deadline then complete owner generation (no waiter).
              job.retryRemaining -= 1;
              job.retryUsed += 1;
              var delayO = Math.min(30000, 1000 * Math.pow(2, job.retryUsed));
              var nowO = now();
              if (typeof nowO !== "number" || !Number.isFinite(nowO)) nowO = 0;
              job.retryDeadlineMs = nowO + delayO;
              clearDrainingState(job);
              invalidateLocalActivities(job);
              job.state = "retry_backoff";
              job.stateVersion += 1;
              job.attemptToken = null;
              releaseSlotIfHeld(job);
              removeFromQueue(job);
              gateF.completeOwner({ jobId: job.id, recoveryOwnerJobId: null });
              drain();
              return;
            }
            clearDrainingState(job);
            invalidateLocalActivities(job);
            job.state = "needs_user";
            job.stateVersion += 1;
            job.attemptToken = null;
            clearRetryDeadline(job);
            releaseSlotIfHeld(job);
            removeFromQueue(job);
            gateF.completeOwner({ jobId: job.id, recoveryOwnerJobId: null });
            drain();
            return;
          }
          // Permanent owner failure with no waiter.
          completeProviderOwner(job, attemptToken, "failed");
          return;
        }

        // local_io: needs_user, never provider saturation, never Firefox.
        if (category === "local_io") {
          terminalizeRunning(job, attemptToken, "needs_user");
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
          // No viable sibling: charge budget → retry_backoff or needs_user.
          // Never provider wait; never Firefox.
          scheduleAutomaticRetry(job, attemptToken);
          return;
        }

        // Permanent (or range_unsupported without capability switch, cancelled category): terminal failed.
        // range_unsupported is never Firefox; capability switch is a separate API.
        terminalizeRunning(job, attemptToken, "failed");
        return;
      }
      // Unknown status: no-op.
    }

    /**
     * Move due retry_backoff jobs to queued, then central drain.
     * Collect all due jobs first and sort by (retryDeadlineMs asc, creation order)
     * so staggered same-provider deadlines are deterministic after a large clock jump.
     * Central drain still enforces provider FIFO / global round-robin.
     * Invalid / non-finite nowMs is a no-op. Duplicate ticks after admission
     * cannot double-admit (state is no longer retry_backoff). No real timers.
     */
    function tick(nowMs) {
      if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return;
      lastTickMs = nowMs;
      var due = [];
      jobs.forEach(function (job) {
        if (job.state !== "retry_backoff") return;
        if (job.retryDeadlineMs == null) return;
        if (nowMs < job.retryDeadlineMs) return;
        due.push(job);
      });
      due.sort(function (a, b) {
        if (a.retryDeadlineMs !== b.retryDeadlineMs) {
          return a.retryDeadlineMs - b.retryDeadlineMs;
        }
        return jobOrder.indexOf(a.id) - jobOrder.indexOf(b.id);
      });
      for (var di = 0; di < due.length; di++) {
        var job = due[di];
        if (job.state !== "retry_backoff") continue;
        // Due: re-enter provider FIFO for central admission (fresh token on admit).
        clearRetryDeadline(job);
        job.state = "queued";
        job.stateVersion += 1;
        job.attemptToken = null;
        ensureProvider(job.providerKey);
        var q = providerQueues.get(job.providerKey);
        if (q.indexOf(job.id) === -1) q.push(job.id);
      }
      drain();
    }

    /**
     * Idempotent cancel. Immediate for work with no live transport attempt.
     * Active running/pausing work records cancelRequested, denies new permits,
     * preserves the attempt token until matching cancel/terminal acknowledgement,
     * and releases the slot exactly once when acknowledged.
     * During explicit Firefox handoff, records a late cancel request (not a silent
     * no-op) so adapter rejection can settle as cancelled.
     */
    function cancel(jobId) {
      var job = jobs.get(jobId);
      if (!job) return;
      if (isTrulyTerminal(job.state)) return;
      if (job.state === "handing_off_firefox" || job.firefoxHandoffInFlight === true) {
        // Late cancel during explicit handoff: record only; settlement decides terminal.
        job.cancelRequested = true;
        return;
      }

      if (job.state === "running" || job.state === "pausing_provider") {
        if (job.cancelRequested === true) return;
        job.cancelRequested = true;
        // If already quiescent in pausing_provider, finish cancel now.
        if (job.state === "pausing_provider" && isQuiescent(job)) {
          // Pausing with cancel: release slot, terminalize cancelled.
          // If this job is not a provider owner, simple terminal path.
          // Prefer stored draining terminal settlement so cancel still wins via
          // settleDrainingTerminal's cancelRequested branch.
          if (job.pendingDrainTerminal != null) {
            settleDrainingTerminal(job);
            return;
          }
          // Physical counters zero but private drain identity still awaiting its
          // semantic terminal: remain pausing/slot-held until that terminal;
          // cancelRequested then wins inside settleDrainingTerminal.
          if (
            typeof job.drainingAttemptToken === "string" &&
            job.drainingAttemptToken.trim().length > 0
          ) {
            return;
          }
          releaseSlotIfHeld(job);
          removeFromWaitQueue(job);
          removeFromQueue(job);
          clearRetryDeadline(job);
          clearDrainingState(job);
          invalidateLocalActivities(job);
          job.state = "cancelled";
          job.stateVersion += 1;
          job.attemptToken = null;
          clearEphemeralOnce(job);
          drain();
        }
        // Running (or non-quiescent pausing): wait for matching transport/quiesce ack.
        return;
      }

      // created / queued / waiting_provider / retry_backoff / needs_user: immediate.
      removeFromQueue(job);
      removeFromWaitQueue(job);
      releaseSlotIfHeld(job);
      clearRetryDeadline(job);
      clearDrainingState(job);
      invalidateLocalActivities(job);
      job.state = "cancelled";
      job.stateVersion += 1;
      job.attemptToken = null;
      job.cancelRequested = true;
      clearEphemeralOnce(job);
      drain();
    }

    /**
     * Multi-range → single-connection capability switch.
     * Only a matching live running attempt may switch when mode is single-connection
     * and partState is empty. Preserves job, slot, attempt token, filename, budget.
     * Never Firefox. Invalid/non-running/cancelled/repeat → no-op.
     */
    function onCapabilitySwitch(jobId, info) {
      var job = jobs.get(jobId);
      if (!job) return;
      if (job.state !== "running") return;
      if (job.cancelRequested === true) return;
      info = info || {};
      if (info.mode !== "single-connection") return;
      if (info.partState !== "empty") return;
      if (job.mode === "single-connection") return; // repeat no-op
      job.mode = "single-connection";
      job.effectiveConcurrency = 1;
      job.stateVersion += 1;
      syncJobLimit(job);
    }

    /**
     * Return the current live attempt token for a running job.
     * Does not mint, rotate, charge budget, or release slots.
     * Throws when there is no live attempt to share.
     */
    function issueAttemptToken(jobId) {
      var job = jobs.get(jobId);
      if (!job) {
        throw new Error("unknown job: no live attempt token");
      }
      if (job.state !== "running" || !isNonblankString(job.attemptToken)) {
        throw new Error("no live attempt token for job");
      }
      if (job.cancelRequested === true) {
        throw new Error("no live attempt token for cancelled job");
      }
      return job.attemptToken;
    }

    /**
     * Terminalize cancelRequested running/pausing work after helper disconnect has
     * confirmed native-open zero, any authenticated owner release, AND full
     * wrapper/observed permit quiescence. Exact-once slot/queue/deadline/ephemeral
     * cleanup; never charges retry or calls Firefox.
     * Caller must not invoke this while ProviderGate still names the job owner,
     * or while totalInFlightPermits remains positive.
     */
    function terminalizeUnavailableCancelled(job) {
      if (!job) return false;
      if (job.state !== "running" && job.state !== "pausing_provider") return false;
      if (job.cancelRequested !== true) return false;
      if (isTrulyTerminal(job.state)) return false;
      releaseSlotIfHeld(job);
      removeFromWaitQueue(job);
      removeFromQueue(job);
      clearRetryDeadline(job);
      clearDrainingState(job);
      invalidateLocalActivities(job);
      job.state = "cancelled";
      job.stateVersion += 1;
      job.attemptToken = null;
      clearEphemeralOnce(job);
      drain();
      return true;
    }

    /**
     * Hold a running/pausing job after helper disconnect when wrapper/observed
     * permits remain. Helper disappearance proves native zero only — not provider
     * permit zero. Marks drainTransportUnavailable idempotently, invalidates any
     * residual private native drain auth (no fabricated drainingAttemptToken),
     * transitions running → pausing_provider without releasing the global slot,
     * and leaves final settlement to maybeQuiesce on last permit release.
     * Duplicate unavailable while already holding returns false.
     */
    function holdUnavailableUntilPermitsDrain(job) {
      if (!job) return false;
      if (job.state !== "running" && job.state !== "pausing_provider") return false;
      if (job.drainTransportUnavailable === true) {
        // Already recorded: residual native drain auth stays invalid; no re-entry.
        job.drainingAttemptToken = null;
        return false;
      }
      // Invalidate private native drain identity — helper is gone; do not mint a
      // new drainingAttemptToken (native opens are already zero).
      job.drainingAttemptToken = null;
      job.pendingDrainTerminal = null;
      job.drainTransportUnavailable = true;
      if (job.state === "running") {
        job.state = "pausing_provider";
        job.stateVersion += 1;
        job.attemptToken = null;
        // retains global slot and cancelRequested
      } else {
        // Already pausing: keep slot/cancelRequested; public token stays null.
        job.attemptToken = null;
      }
      return true;
    }

    /**
     * Park a live job when the native helper transport disconnects.
     * Applies only to running | pausing_provider | waiting_provider.
     * Default outcome is one needs_user transition (single stateVersion bump),
     * release held slot once, clear queues / retry deadline / live attempt token,
     * zero native opens on the job and its ProviderGate, preserve
     * intent/mode/concurrency/retries/ephemeral.
     * When cancelRequested is already set on running/pausing work with no pending
     * authenticated drain terminal, cancellation wins instead of needs_user once
     * native zero, any owner release, and full wrapper/observed permit quiescence
     * are confirmed. Outstanding provider permits hold the job in pausing_provider
     * with the global slot retained until maybeQuiesce settles.
     * Authenticated saturated/recovering owners complete ownership with no recovery
     * successor and do not wake same-provider waiters. Independent-provider capacity
     * is drained only after the global slot is released. No retry charge, no Firefox,
     * no popup proof. Duplicate/unknown/non-eligible → false no-op.
     */
    function onTransportUnavailable(jobId) {
      var job = jobs.get(jobId);
      if (!job) return false;
      if (
        job.state !== "running" &&
        job.state !== "pausing_provider" &&
        job.state !== "waiting_provider"
      ) {
        return false;
      }

      var gate = getGate(job.providerKey);

      // Confirm ProviderGate native-open zero BEFORE projecting the job counter.
      // Never allow job.nativeOpenConnections=0 while the gate still records >0.
      // maybeQuiesce is intentionally not invoked (would detour pausing → waiting).
      var nativeConfirmed = false;
      try {
        gate.noteNativeOpen(job.id, 0);
        nativeConfirmed = true;
      } catch (errNative) {
        var openAfter = gate.snapshot().nativeOpen;
        var gateOpens =
          openAfter && Object.prototype.hasOwnProperty.call(openAfter, job.id)
            ? openAfter[job.id]
            : null;
        if (gateOpens === 0) {
          // Mutated then threw: zeros are confirmed; safe to continue the park.
          nativeConfirmed = true;
        } else {
          // Throw-before-mutation: leave job/gate coherent and retryable.
          throw errNative;
        }
      }
      if (!nativeConfirmed) return false;
      var openSnap = gate.snapshot().nativeOpen;
      if (
        openSnap &&
        Object.prototype.hasOwnProperty.call(openSnap, job.id) &&
        openSnap[job.id] !== 0
      ) {
        // Gate retained a positive count — refuse a false success projection.
        return false;
      }
      job.nativeOpenConnections = 0;

      // Authenticated pending drain terminal is the one semantic terminal for this
      // physical attempt. Helper disconnect must not erase or overwrite it.
      // Record a private unavailable-during-drain condition and settle only after
      // full physical quiescence (maybeQuiesce → settleDrainingTerminal).
      // cancelRequested still wins inside settleDrainingTerminal.
      // Local activities model adapter-local work, not provider sockets: helper
      // disconnect is a forced invalidation boundary for them (epoch fence).
      if (job.state === "pausing_provider" && job.pendingDrainTerminal != null) {
        if (job.drainTransportUnavailable === true) {
          // Duplicate unavailable while already recorded: false no-op.
          return false;
        }
        job.drainTransportUnavailable = true;
        // Residual private token is no longer needed; pending outcome is authoritative.
        job.drainingAttemptToken = null;
        invalidateLocalActivities(job);
        if (!isQuiescent(job)) {
          // Wrapper/observed permits remain: stay pausing, keep slot, preserve pending.
          return true;
        }
        // Fully quiescent (provider permits/native only): settle via unified
        // precedence (cancel > completed > unavailable). Local work is already fenced.
        settleDrainingTerminal(job);
        return true;
      }

      // Authenticated saturated/recovering owner: confirmed release with no recovery
      // successor and no same-provider waiter authorization on helper disconnect.
      // Must run before settlement so ownership never outlives the disconnect ack.
      var snap = gate.snapshot();
      if (
        (snap.state === "saturated" || snap.state === "recovering") &&
        snap.ownerJobId === job.id
      ) {
        var release = reconcileProviderOwnerRelease(job, {
          recoveryOwnerJobId: null,
          authorizeRecovery: false,
        });
        if (release.stillOwner || !release.advanced) {
          // Fail closed: do not park/return true while gate still names this owner.
          if (release.error) throw release.error;
          return false;
        }
      }

      // Helper disconnect fences local activities before hold-vs-settle. Provider
      // wrapper/observed permits alone decide whether to retain the global slot.
      // Ordinary saturation pause does not use this path and retains local work.
      if (job.state === "running" || job.state === "pausing_provider") {
        invalidateLocalActivities(job);
      }

      // Wrapper/observed permits still live: helper disconnect proved native zero
      // only. Hold the global slot in pausing_provider until actual permit release
      // drives maybeQuiesce (cancelRequested → cancelled; else needs_user).
      // Do not authorize provider wake or admit independent capacity early.
      if (
        (job.state === "running" || job.state === "pausing_provider") &&
        !isQuiescent(job)
      ) {
        return holdUnavailableUntilPermitsDrain(job);
      }

      // Fully quiescent (native zero + no provider permits): private drain auth is
      // no longer usable and settlement can proceed immediately.
      clearDrainingState(job);

      // User cancellation wins once physical native work and provider permits are gone
      // (and ownership, if any, has released).
      if (
        job.cancelRequested === true &&
        (job.state === "running" || job.state === "pausing_provider")
      ) {
        return terminalizeUnavailableCancelled(job);
      }

      // Single stateVersion bump, slot release, queue/token/deadline clear; ephemeral
      // retained for manualRetry after reconnection.
      if (!enterNeedsUser(job)) return false;
      drain();
      return true;
    }

    /**
     * Manual retry from needs_user only. New explicit generation: reset configured
     * automatic budget and retry-use counter, clear deadline, preserve immutable
     * intent/filename and reduced concurrency/mode, queue via central drain.
     * Fresh token issued on admission. Outside needs_user → no-op.
     */
    function manualRetry(jobId) {
      var job = jobs.get(jobId);
      if (!job) return;
      if (job.state !== "needs_user") return;
      job.retryRemaining = job.configuredRetries;
      job.retryUsed = 0;
      clearRetryDeadline(job);
      job.cancelRequested = false;
      job.firefoxHandoffInFlight = false;
      job.consumeRetryOnWake = false;
      job.wakeRetryConsumed = false;
      job.wakeAuthorized = false;
      job.attemptToken = null;
      clearDrainingState(job);
      job.state = "queued";
      job.stateVersion += 1;
      ensureProvider(job.providerKey);
      var q = providerQueues.get(job.providerKey);
      if (q.indexOf(job.id) === -1) q.push(job.id);
      drain();
    }

    /**
     * Consume a one-time popup token from Set or job-bound Map.
     * Synchronous and exactly-once before any await.
     * Set: has(token)/delete(token).
     * Map: jobId -> token string, or jobId -> Set of tokens.
     */
    function consumePopupToken(jobId, token) {
      if (!isNonblankString(token)) return false;
      if (!popupTokenStore) return false;
      // Map form (job-bound): native Map has get+set; Set has add, not get/set.
      if (
        typeof popupTokenStore.get === "function" &&
        typeof popupTokenStore.set === "function" &&
        typeof popupTokenStore.has === "function" &&
        typeof popupTokenStore.delete === "function"
      ) {
        if (!popupTokenStore.has(jobId)) return false;
        var bound = popupTokenStore.get(jobId);
        if (typeof bound === "string") {
          if (bound !== token) return false;
          popupTokenStore.delete(jobId);
          return true;
        }
        if (bound && typeof bound.has === "function" && typeof bound.delete === "function") {
          if (!bound.has(token)) return false;
          bound.delete(token);
          if (typeof bound.size === "number" && bound.size === 0) {
            popupTokenStore.delete(jobId);
          }
          return true;
        }
        return false;
      }
      // Set form (or Set-like): has/delete without Map get+set.
      if (typeof popupTokenStore.has === "function" && typeof popupTokenStore.delete === "function") {
        if (!popupTokenStore.has(token)) return false;
        popupTokenStore.delete(token);
        return true;
      }
      return false;
    }

    function intentsBindEqual(jobIntent, handoffIntent) {
      if (!jobIntent || !handoffIntent) return false;
      return (
        jobIntent.requestedFilename === handoffIntent.requestedFilename &&
        jobIntent.destinationDirectory === handoffIntent.destinationDirectory &&
        jobIntent.saveMode === handoffIntent.saveMode
      );
    }

    /**
     * Authorize the gate-named recovery owner at most once when they are still
     * waiting_provider. Never charges/wakes a different waiter than the gate owner.
     */
    function authorizeGateNamedRecoveryOwner(providerKey) {
      var gate = getGate(providerKey);
      var snap = gate.snapshot();
      if (snap.state !== "saturated" && snap.state !== "recovering") return false;
      var recoveryId = snap.ownerJobId;
      if (!recoveryId) return false;
      var next = jobs.get(recoveryId);
      if (!next || next.state !== "waiting_provider") return false;
      if (snap.reducedConcurrency != null) {
        applyReducedConcurrency(next, snap.reducedConcurrency);
      }
      return authorizeWake(next);
    }

    /**
     * Shared owner-reconciliation for Firefox handoff setup and failed settlement.
     * Authenticated completeOwner with oldest eligible recovery (or null). Authorizes
     * the installed recovery owner only when advancement is confirmed (or when the
     * gate already names an eligible waiting recovery owner).
     *
     * Returns:
     *   {
     *     wasAuthenticatedOwner: boolean,
     *     advanced: boolean,
     *     stillOwner: boolean,
     *     recoveryId: string|null,
     *     authorized: boolean,
     *     error: Error|null
     *   }
     */
    function reconcileProviderOwnerRelease(job, options) {
      options = options || {};
      var gate = getGate(job.providerKey);
      var snap = gate.snapshot();
      var wasAuthenticatedOwner =
        (snap.state === "saturated" || snap.state === "recovering") &&
        snap.ownerJobId === job.id;
      // Default true preserves Firefox/settlement paths; transport disconnect passes false.
      var shouldAuthorize = options.authorizeRecovery !== false;

      if (!wasAuthenticatedOwner) {
        // Gate already advanced (or job was never owner): authorize exact named
        // recovery owner at most once; do not charge a different waiter.
        var authorizedExisting = shouldAuthorize
          ? authorizeGateNamedRecoveryOwner(job.providerKey)
          : false;
        return {
          wasAuthenticatedOwner: false,
          advanced: true,
          stillOwner: false,
          recoveryId: snap.ownerJobId,
          authorized: authorizedExisting,
          error: null,
        };
      }

      var recoveryId = null;
      if (Object.prototype.hasOwnProperty.call(options, "recoveryOwnerJobId")) {
        recoveryId = options.recoveryOwnerJobId;
      } else {
        var waiter = oldestEligibleWaiter(job.providerKey);
        recoveryId = waiter ? waiter.id : null;
      }

      var result = null;
      var err = null;
      try {
        result = gate.completeOwner({
          jobId: job.id,
          recoveryOwnerJobId: recoveryId,
        });
      } catch (e) {
        err = e;
      }

      var after = gate.snapshot();
      var stillOwner =
        (after.state === "saturated" || after.state === "recovering") &&
        after.ownerJobId === job.id;
      // Prefer explicit advanced flag; also treat post-throw snapshot that no longer
      // names this job as owner as advancement (gate mutated before throw).
      var advanced = !!(result && result.advanced === true) || (!stillOwner && err);

      var authorized = false;
      if (advanced && !stillOwner && shouldAuthorize) {
        // Authorize exact gate-named recovery owner (or the recovery we requested if
        // still waiting under that id). authorizeWake is per-epoch idempotent.
        if (after.ownerJobId) {
          authorized = authorizeGateNamedRecoveryOwner(job.providerKey);
        } else if (recoveryId) {
          var nextFallback = jobs.get(recoveryId);
          if (nextFallback && nextFallback.state === "waiting_provider") {
            if (after.reducedConcurrency != null) {
              applyReducedConcurrency(nextFallback, after.reducedConcurrency);
            }
            authorized = authorizeWake(nextFallback);
          }
        }
      }

      return {
        wasAuthenticatedOwner: true,
        advanced: advanced,
        stillOwner: stillOwner,
        recoveryId: recoveryId,
        authorized: authorized,
        error: err,
      };
    }

    /**
     * Restore the exact live mCatcher attempt after a failed pre-adapter owner
     * transition. StateVersion stays monotonic (never decremented). Caller must
     * not have drained between slot release and this restore.
     */
    function restoreRunningOwnerAttempt(job, priorAttemptToken) {
      job.firefoxHandoffInFlight = false;
      job.attemptToken = priorAttemptToken;
      if (job.holdsGlobalSlot !== true) {
        job.holdsGlobalSlot = true;
        globalRunning += 1;
      }
      if (job.state !== "running") {
        job.state = "running";
        job.stateVersion += 1;
      }
    }

    /**
     * Settle a failed/aborted explicit Firefox handoff after the one-time token
     * was consumed. Never leaves handing_off_firefox / firefoxHandoffInFlight stuck.
     * Late cancel → cancelled (ephemeral cleared); otherwise needs_user (ephemeral retained).
     * Reconciles provider ownership so waiters are not stranded and a nonrunning job
     * never remains gate owner when release can be confirmed.
     *
     * Returns { ownerStillHeld: boolean, error: Error|null } for callers that must
     * surface unconfirmed owner release after rollback is no longer possible.
     */
    function settleFailedFirefoxHandoff(job) {
      if (!job) {
        return { ownerStillHeld: false, error: null };
      }
      if (job.state === "handed_to_firefox") {
        return { ownerStillHeld: false, error: null };
      }
      // Duplicate/late settlement: already left handoff; do not re-wake or re-release.
      if (job.state !== "handing_off_firefox" && job.firefoxHandoffInFlight !== true) {
        if (isTrulyTerminal(job.state) || job.state === "needs_user" || job.state === "running") {
          job.firefoxHandoffInFlight = false;
          return { ownerStillHeld: false, error: null };
        }
      }
      if (isTrulyTerminal(job.state) && job.state !== "handing_off_firefox") {
        job.firefoxHandoffInFlight = false;
        return { ownerStillHeld: false, error: null };
      }

      removeFromQueue(job);
      removeFromWaitQueue(job);
      clearRetryDeadline(job);
      releaseSlotIfHeld(job);
      job.attemptToken = null;
      clearDrainingState(job);
      invalidateLocalActivities(job);
      job.firefoxHandoffInFlight = false;

      var release = {
        stillOwner: false,
        error: null,
        advanced: false,
      };
      try {
        release = reconcileProviderOwnerRelease(job);
      } catch (errS) {
        // If completeOwner path threw outside the helper, still try to authorize
        // any gate-named recovery owner so waiters are not stranded.
        release = {
          stillOwner: false,
          error: errS,
          advanced: false,
        };
        try {
          var gateSnap = getGate(job.providerKey).snapshot();
          release.stillOwner =
            (gateSnap.state === "saturated" || gateSnap.state === "recovering") &&
            gateSnap.ownerJobId === job.id;
          if (!release.stillOwner) {
            authorizeGateNamedRecoveryOwner(job.providerKey);
          }
        } catch (errAuth) {
          // Authorization best-effort after unexpected gate failure.
        }
      }

      if (job.cancelRequested === true) {
        job.state = "cancelled";
        job.stateVersion += 1;
        clearEphemeralOnce(job);
      } else {
        job.state = "needs_user";
        job.stateVersion += 1;
        // Ephemeral retained for manualRetry / later explicit handoff.
      }
      drain();
      return {
        ownerStillHeld: release.stillOwner === true,
        error: release.error || null,
      };
    }

    /**
     * Explicit Firefox handoff — the scheduler's ONLY Firefox hook.
     * Requires immutable intent with userSelectedFirefox === true, a nonblank
     * popup token present in the one-time store, exact filename/destination/saveMode
     * binding, and an eligible nonterminal job. Consumes the token synchronously
     * once before the first await.
     *
     * Pre-existing cancelRequested rejects before token consumption (no resurrection).
     * During handoff, firefoxHandoffInFlight (not auto-set cancelRequested) denies new
     * mCatcher permits; cancel() may record a late cancel request.
     *
     * Settlement:
     *   - hook success → handed_to_firefox (ownership transferred; ephemeral cleared)
     *   - reject + late cancel → cancelled (ephemeral cleared)
     *   - reject otherwise → needs_user (token consumed, ephemeral retained)
     * Post-token pre-await mutations share the same recovery boundary as the adapter call.
     */
    async function requestFirefoxHandoff(jobId, handoffIntent) {
      var job = jobs.get(jobId);
      if (!job) {
        throw new Error("unknown job for Firefox handoff");
      }
      if (!handoffIntent || typeof handoffIntent !== "object") {
        throw new TypeError("Firefox handoff intent must be an object");
      }
      if (!Object.isFrozen(handoffIntent)) {
        throw new TypeError("Firefox handoff intent must be immutable (frozen)");
      }
      if (handoffIntent.userSelectedFirefox !== true) {
        throw new Error("Firefox handoff requires userSelectedFirefox === true");
      }
      if (!isNonblankString(handoffIntent.userActionToken)) {
        throw new Error("Firefox handoff requires a nonblank userActionToken");
      }
      if (!intentsBindEqual(job.intent, handoffIntent)) {
        throw new Error("Firefox handoff intent does not match job binding");
      }
      if (isTrulyTerminal(job.state)) {
        throw new Error("Firefox handoff rejected: job is terminal");
      }
      if (job.state === "handing_off_firefox" || job.firefoxHandoffInFlight === true) {
        throw new Error("Firefox handoff already in progress or completed for token");
      }
      // Pre-existing user cancel: reject before token consumption / state mutation.
      if (job.cancelRequested === true) {
        throw new Error("Firefox handoff rejected: cancel already requested");
      }
      // Eligible: needs_user, or safe live/quiescent path (running/queued/backoff/waiting/created without outstanding physical permits).
      var eligible =
        job.state === "needs_user" ||
        job.state === "created" ||
        job.state === "queued" ||
        job.state === "retry_backoff" ||
        job.state === "waiting_provider" ||
        job.state === "running";
      if (!eligible) {
        throw new Error("Firefox handoff rejected: job state not eligible");
      }
      // Outstanding wrapper/observed permits or native opens: reject until safe.
      // Preserve ProviderGate physical counters — do not pretend they vanished.
      if (job.state === "running" || job.state === "pausing_provider") {
        if (!isQuiescent(job)) {
          throw new Error("Firefox handoff rejected: outstanding permits or native opens");
        }
      }
      if (typeof firefoxDownload !== "function") {
        throw new Error("Firefox handoff requires firefoxDownload hook");
      }

      // Consume token synchronously and exactly once before first await.
      if (!consumePopupToken(jobId, handoffIntent.userActionToken)) {
        throw new Error("Firefox handoff token missing, forged, or already consumed");
      }

      // Recovery boundary: every post-token pre-await mutation + adapter call.
      // A sync throw must not leave handing_off_firefox / inFlight stuck.
      // Do not auto-set cancelRequested — firefoxHandoffInFlight denies new permits.
      // Owner release must advance before Firefox; non-advanced / still-owner rolls back
      // the live mCatcher attempt (no drain between slot release and restore).
      var adapterReady = false;
      var rolledBackOwner = false;
      var priorAttemptToken = job.attemptToken;
      var ownershipTransitionError = null;
      try {
        job.firefoxHandoffInFlight = true;

        // Stop/mark mCatcher work: deny permits, clear retry deadline/queues, release slot.
        removeFromQueue(job);
        removeFromWaitQueue(job);
        clearRetryDeadline(job);
        // If this job is a saturated/recovering owner, wake next only when completeOwner advances.
        var gateH = getGate(job.providerKey);
        var snapH = gateH.snapshot();
        var wasOwner =
          job.state === "running" &&
          (snapH.state === "saturated" || snapH.state === "recovering") &&
          snapH.ownerJobId === job.id;

        if (wasOwner) {
          // Local transition first; do NOT drain until commit or rollback completes.
          job.state = "handing_off_firefox";
          job.stateVersion += 1;
          job.attemptToken = null;
          releaseSlotIfHeld(job);

          var releaseH = reconcileProviderOwnerRelease(job);

          if (!releaseH.advanced && releaseH.stillOwner) {
            // Fail closed: restore exact live attempt; never invoke Firefox.
            restoreRunningOwnerAttempt(job, priorAttemptToken);
            rolledBackOwner = true;
            drain(); // rollback complete — safe to drain with slot restored
            var failClosedErr =
              releaseH.error ||
              new Error(
                "Firefox handoff rejected: provider ownership did not advance"
              );
            throw failClosedErr;
          }

          if (releaseH.advanced && releaseH.error) {
            // Gate advanced then threw: reconcile recovery already applied; settle
            // failed without Firefox. Do not restore a job that is no longer owner.
            ownershipTransitionError =
              releaseH.error instanceof Error
                ? releaseH.error
                : new Error(String(releaseH.error || "provider ownership transition failed"));
            settleFailedFirefoxHandoff(job);
            throw ownershipTransitionError;
          }

          // Ownership advanced cleanly — commit drain so recovery can admit.
          drain();
        } else {
          job.state = "handing_off_firefox";
          job.stateVersion += 1;
          job.attemptToken = null;
          releaseSlotIfHeld(job);
          drain();
        }

        // Build guarded adapter input: only immutable intent + in-memory source handle.
        // Never project/serialize media URLs, cookies, headers, or ephemeral objects.
        var sourceHandle = null;
        if (job.ephemeral && typeof job.ephemeral === "object") {
          // Pass a closure/handle object without exposing raw URL fields via projection.
          sourceHandle = job.ephemeral;
        }
        var adapterInput = Object.freeze({
          filename: job.intent.requestedFilename,
          saveAs: true,
          intent: job.intent,
          sourceHandle: sourceHandle,
        });

        adapterReady = true;
        // Sync throw from firefoxDownload itself is treated as adapter rejection.
        await firefoxDownload(adapterInput);

        // Success → ownership transferred to Firefox (even if a late cancel was recorded).
        if (job.state === "handing_off_firefox") {
          job.state = "handed_to_firefox";
          job.stateVersion += 1;
          job.attemptToken = null;
          job.firefoxHandoffInFlight = false;
          invalidateLocalActivities(job);
          clearEphemeralOnce(job);
        }
        // A handed_to_firefox job must never remain the gate owner.
        try {
          var snapDone = getGate(job.providerKey).snapshot();
          if (
            (snapDone.state === "saturated" || snapDone.state === "recovering") &&
            snapDone.ownerJobId === job.id
          ) {
            reconcileProviderOwnerRelease(job);
          }
        } catch (errDone) {
          // Success path already terminal for the job; gate reconcile is best-effort.
        }
        drain();
      } catch (err) {
        // Rolled-back owner path already restored running — rethrow without settle.
        if (rolledBackOwner) {
          throw err;
        }
        // Ownership transition after advance already settled — rethrow to surface error.
        if (ownershipTransitionError) {
          throw ownershipTransitionError;
        }
        // Pre-await failure or adapter rejection: settle without stuck inFlight.
        // Token remains consumed. Adapter rejection resolves (settled); internal
        // unconfirmed owner-release after settlement is surfaced as rejection.
        var settleResult = settleFailedFirefoxHandoff(job);
        if (!adapterReady) {
          // Pre-adapter failure that was not a clean rollback: surface the error.
          throw err;
        }
        if (settleResult && settleResult.ownerStillHeld) {
          throw (
            settleResult.error ||
            err ||
            new Error(
              "Firefox handoff failed: provider ownership could not be released"
            )
          );
        }
        // Adapter rejection with confirmed ownership release: resolve (needs_user /
        // cancelled already applied). Existing callers await without expect-reject.
        void adapterReady;
      }
    }

    // Public surface — stable method names for Tasks 9–11 (+ transport park / drain).
    return {
      createJob: createJob,
      enqueue: enqueue,
      setMaxConcurrent: setMaxConcurrent,
      cancel: cancel,
      onTransportResult: onTransportResult,
      onTransportUnavailable: onTransportUnavailable,
      onDrainingTransportResult: onDrainingTransportResult,
      onCapabilitySwitch: onCapabilitySwitch,
      getJob: getJob,
      getSnapshot: getSnapshot,
      notePermitAcquired: notePermitAcquired,
      releasePermit: releasePermit,
      acquireProviderPermit: acquireProviderPermit,
      acquireLocalActivity: acquireLocalActivity,
      onQuiesced: onQuiesced,
      noteNativeOpen: noteNativeOpen,
      nativeLeaseFor: nativeLeaseFor,
      userStatus: userStatus,
      issueAttemptToken: issueAttemptToken,
      manualRetry: manualRetry,
      requestFirefoxHandoff: requestFirefoxHandoff,
      tick: tick,
    };
  }

  return {
    createDownloadScheduler: createDownloadScheduler,
  };
});
