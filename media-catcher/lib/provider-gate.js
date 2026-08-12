(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McProviderGate = api;
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

  /** Nonnegative finite integer (0 allowed). */
  function requireNonnegInt(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new RangeError(label + " must be a nonnegative finite integer");
    }
    return value;
  }

  /**
   * Pure synchronous per-provider permit / lease gate.
   * Session memory only — never persisted.
   *
   * States: normal | saturated | recovering
   * Task 10 consumes acquire / setSaturated / completeOwner / recoverToNormal
   * and nativeLeaseFor + registerJobLimit for native connection caps.
   */
  function createProviderGate(opts) {
    opts = opts || {};
    var providerKey = requireNonblankId(opts.providerKey, "providerKey");

    var state = "normal";
    var generation = 0;
    var wakeGeneration = 0;
    var ownerJobId = null;
    var reducedConcurrency = null;

    // Current-generation active browser permit counts: jobId -> count
    var activeByJob = new Map();
    // Normal-state native maxConnections registration: jobId -> positive int
    var jobLimits = new Map();
    // Observed native open counts (not permits): jobId -> nonnegative int
    var nativeOpen = new Map();
    // Parked detection/enrichment probe ids
    var parkedProbes = new Set();
    // Provider generation for which completeOwner already advanced wake (once).
    var wakeAppliedForGeneration = null;

    function clearActivePermits() {
      activeByJob.clear();
    }

    function activeCount(jobId) {
      return activeByJob.get(jobId) || 0;
    }

    function bumpGeneration() {
      generation += 1;
      clearActivePermits();
      // New saturation generation may accept one owner-completion wake.
      wakeAppliedForGeneration = null;
    }

    function effectiveCap(jobId, maxForJob) {
      if (state === "normal") return maxForJob;
      if (ownerJobId && jobId === ownerJobId && reducedConcurrency != null) {
        return Math.min(maxForJob, reducedConcurrency);
      }
      return 0;
    }

    function canAcquire(jobId, options) {
      if (options.isRunningJob !== true) return false;
      if (state === "normal") return true;
      // saturated | recovering: only designated owner with drain flag
      if (!ownerJobId || jobId !== ownerJobId) return false;
      if (options.isDrainOwner !== true) return false;
      return true;
    }

    function acquire(jobId, options) {
      requireNonblankId(jobId, "jobId");
      options = options || {};
      var maxForJob = requirePositiveInt(options.maxForJob, "maxForJob");
      var purpose = requireNonblankId(options.purpose, "purpose");

      if (!canAcquire(jobId, options)) return null;

      var cap = effectiveCap(jobId, maxForJob);
      if (cap < 1) return null;
      if (activeCount(jobId) >= cap) return null;

      activeByJob.set(jobId, activeCount(jobId) + 1);
      var issuedGeneration = generation;
      var released = false;

      var permit = {
        jobId: jobId,
        purpose: purpose,
        generation: issuedGeneration,
        release: function release() {
          if (released) return;
          released = true;
          // Stale permits must never touch current-generation counters.
          if (issuedGeneration !== generation) return;
          var n = activeCount(jobId);
          if (n <= 1) activeByJob.delete(jobId);
          else activeByJob.set(jobId, n - 1);
        },
      };
      return permit;
    }

    function setSaturated(args) {
      args = args || {};
      var drainOwnerJobId = requireNonblankId(args.drainOwnerJobId, "drainOwnerJobId");
      var reduced = requirePositiveInt(args.reducedConcurrency, "reducedConcurrency");
      bumpGeneration();
      state = "saturated";
      ownerJobId = drainOwnerJobId;
      reducedConcurrency = reduced;
    }

    /**
     * Register the finite native connection cap for a job in normal state.
     * Required so nativeLeaseFor never returns Infinity/NaN for direct jobs.
     */
    function registerJobLimit(jobId, maxConnections) {
      requireNonblankId(jobId, "jobId");
      var limit = requirePositiveInt(maxConnections, "maxConnections");
      jobLimits.set(jobId, limit);
    }

    function nativeLeaseFor(jobId) {
      // jobId may be any string key; empty is still echoed for shape stability
      // when callers pass a known id. Validation only on mutators.
      var jid = jobId == null ? "" : String(jobId);
      var maxConnections = 0;
      if (state === "normal") {
        maxConnections = jobLimits.has(jid) ? jobLimits.get(jid) : 0;
      } else if (ownerJobId && jid === ownerJobId && reducedConcurrency != null) {
        maxConnections = reducedConcurrency;
      } else {
        maxConnections = 0;
      }
      return {
        jobId: jid,
        providerGeneration: generation,
        maxConnections: maxConnections,
      };
    }

    function noteNativeOpen(jobId, n) {
      requireNonblankId(jobId, "jobId");
      var count = requireNonnegInt(n, "n");
      nativeOpen.set(jobId, count);
    }

    function parkProbe(probeId) {
      requireNonblankId(probeId, "probeId");
      parkedProbes.add(probeId);
    }

    function drainParkedProbes() {
      var ids = Array.from(parkedProbes).sort();
      parkedProbes.clear();
      return ids;
    }

    /**
     * Idempotent owner completion / wake.
     * Advances wakeGeneration at most once per provider generation so
     * completion + late cancellation cannot double-wake. Designates a
     * recovery owner (or blocks with no owner). Further completeOwner
     * calls for the same generation are no-ops until setSaturated or
     * recoverToNormal bumps generation.
     */
    function completeOwner(args) {
      args = args || {};
      if (state === "normal" || wakeAppliedForGeneration === generation) {
        return deepFreeze({
          advanced: false,
          wakeGeneration: wakeGeneration,
          parkedProbeIds: [],
        });
      }

      wakeAppliedForGeneration = generation;
      wakeGeneration += 1;
      var drained = drainParkedProbes();

      var next = args.recoveryOwnerJobId;
      state = "recovering";
      if (isNonblankString(next)) {
        ownerJobId = next;
      } else {
        ownerJobId = null;
      }

      return deepFreeze({
        advanced: true,
        wakeGeneration: wakeGeneration,
        parkedProbeIds: drained.slice(),
      });
    }

    /**
     * Successful recovery path: back to normal.
     * Bumps generation so saturated/recovering permits cannot corrupt counters.
     */
    function recoverToNormal() {
      bumpGeneration();
      state = "normal";
      ownerJobId = null;
      reducedConcurrency = null;
      parkedProbes.clear();
    }

    function snapshot() {
      var open = {};
      nativeOpen.forEach(function (n, id) {
        open[id] = n;
      });
      var limits = {};
      jobLimits.forEach(function (n, id) {
        limits[id] = n;
      });
      return deepFreeze({
        providerKey: providerKey,
        state: state,
        generation: generation,
        wakeGeneration: wakeGeneration,
        ownerJobId: ownerJobId,
        reducedConcurrency: reducedConcurrency,
        parkedProbeIds: Array.from(parkedProbes).sort(),
        nativeOpen: open,
        jobLimits: limits,
      });
    }

    return {
      get providerKey() { return providerKey; },
      get state() { return state; },
      get generation() { return generation; },
      get wakeGeneration() { return wakeGeneration; },
      acquire: acquire,
      setSaturated: setSaturated,
      registerJobLimit: registerJobLimit,
      nativeLeaseFor: nativeLeaseFor,
      noteNativeOpen: noteNativeOpen,
      parkProbe: parkProbe,
      completeOwner: completeOwner,
      recoverToNormal: recoverToNormal,
      snapshot: snapshot,
    };
  }

  return {
    createProviderGate: createProviderGate,
  };
});
