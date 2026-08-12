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
   *
   * Task 10 surface:
   *   acquire / setSaturated / completeOwner / designateRecoveryOwner /
   *   recoverToNormal / registerJobLimit / nativeLeaseFor / noteNativeOpen /
   *   parkProbe / snapshot
   *
   * Ownership: completeOwner authenticates the completing current job id and
   * advances wakeGeneration once per ownership epoch. A distinct recovery
   * successor installs a fresh epoch so B→C handoff works in the same provider
   * generation; late duplicates of prior owners are frozen no-ops.
   *
   * Probes stay parked through saturated/recovering; only authenticated
   * recoverToNormal drains them once (sorted) for reschedule.
   *
   * Permits: physical outstanding is tracked separately from current-generation
   * issuance. acquire caps against physical outstanding (including stale-gen
   * permits). setSaturated clears current issuance only. Stale release never
   * touches current-generation counters.
   *
   * Owner flag: isProviderOwner === true (isDrainOwner is a compatibility alias).
   */
  function createProviderGate(opts) {
    opts = opts || {};
    var providerKey = requireNonblankId(opts.providerKey, "providerKey");

    var state = "normal";
    var generation = 0;
    var wakeGeneration = 0;
    var ownerJobId = null;
    var reducedConcurrency = null;

    // Current-generation issuance counts: jobId -> count (cleared on gen bump).
    var currentIssuanceByJob = new Map();
    // Physical outstanding permits (any generation) still held: jobId -> count.
    var physicalOutstandingByJob = new Map();
    // Normal-state native maxConnections registration: jobId -> positive int
    var jobLimits = new Map();
    // Observed native open counts (not permits): jobId -> nonnegative int
    // Cleared on provider generation transitions so snapshots cannot claim
    // stale opens are current.
    var nativeOpen = new Map();
    // Parked detection/enrichment probe ids (stay until recoverToNormal).
    var parkedProbes = new Set();
    // Ownership epochs: each install gets a new epoch; terminalizing is once.
    var ownershipEpoch = 0;
    var ownerEpochTerminalized = true; // no owner initially

    function currentIssuance(jobId) {
      return currentIssuanceByJob.get(jobId) || 0;
    }

    function physicalOutstanding(jobId) {
      return physicalOutstandingByJob.get(jobId) || 0;
    }

    function bumpPhysical(jobId, delta) {
      var n = physicalOutstanding(jobId) + delta;
      if (n <= 0) physicalOutstandingByJob.delete(jobId);
      else physicalOutstandingByJob.set(jobId, n);
    }

    function bumpCurrentIssuance(jobId, delta) {
      var n = currentIssuance(jobId) + delta;
      if (n <= 0) currentIssuanceByJob.delete(jobId);
      else currentIssuanceByJob.set(jobId, n);
    }

    function clearCurrentIssuance() {
      currentIssuanceByJob.clear();
    }

    function bumpGeneration() {
      generation += 1;
      // Invalidate current-generation issuance only. Physical outstanding
      // remains until each still-live permit releases.
      clearCurrentIssuance();
      // Drop diagnostic native-open observations for the prior generation.
      nativeOpen.clear();
    }

    function installOwner(jobId) {
      ownerJobId = jobId;
      ownershipEpoch += 1;
      ownerEpochTerminalized = false;
    }

    function clearOwner() {
      ownerJobId = null;
      ownerEpochTerminalized = true;
    }

    function effectiveCap(jobId, maxForJob) {
      if (state === "normal") return maxForJob;
      if (ownerJobId && jobId === ownerJobId && reducedConcurrency != null) {
        return Math.min(maxForJob, reducedConcurrency);
      }
      return 0;
    }

    function isOwnerFlag(options) {
      // Neutral Task-10 flag; isDrainOwner kept as compatibility alias.
      return options.isProviderOwner === true || options.isDrainOwner === true;
    }

    function canAcquire(jobId, options) {
      if (options.isRunningJob !== true) return false;
      if (state === "normal") return true;
      // saturated | recovering: only designated owner with owner flag
      if (!ownerJobId || jobId !== ownerJobId) return false;
      if (!isOwnerFlag(options)) return false;
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
      // Cap against physical outstanding so still-live stale-generation
      // browser connections block replacement issuance.
      if (physicalOutstanding(jobId) >= cap) return null;

      bumpPhysical(jobId, 1);
      bumpCurrentIssuance(jobId, 1);
      var issuedGeneration = generation;
      var released = false;

      var permit = Object.freeze({
        jobId: jobId,
        purpose: purpose,
        generation: issuedGeneration,
        release: function release() {
          if (released) return;
          released = true;
          // Always decrement physical outstanding for this live permit.
          bumpPhysical(jobId, -1);
          // Current-generation issuance only when this permit is current.
          if (issuedGeneration === generation) {
            bumpCurrentIssuance(jobId, -1);
          }
        },
      });
      return permit;
    }

    function setSaturated(args) {
      args = args || {};
      var drainOwnerJobId = requireNonblankId(args.drainOwnerJobId, "drainOwnerJobId");
      var reduced = requirePositiveInt(args.reducedConcurrency, "reducedConcurrency");
      bumpGeneration();
      state = "saturated";
      reducedConcurrency = reduced;
      installOwner(drainOwnerJobId);
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
      var jid = requireNonblankId(jobId, "jobId");
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

    function frozenCompleteNoop() {
      return deepFreeze({
        advanced: false,
        wakeGeneration: wakeGeneration,
        parkedProbeIds: [],
      });
    }

    /**
     * Ownership-event terminal of the current owner epoch.
     * Advances wakeGeneration only when:
     *   - state is saturated|recovering
     *   - jobId exactly equals the current owner
     *   - that ownership epoch has not already terminalized
     * Does not drain parked probes. Distinct nonblank recoveryOwnerJobId
     * (≠ completing jobId) installs a fresh owner epoch; otherwise remains
     * recovering with no owner (blocked).
     */
    function completeOwner(args) {
      args = args || {};
      var jobId = requireNonblankId(args.jobId, "jobId");

      if (state === "normal") return frozenCompleteNoop();
      if (!ownerJobId || jobId !== ownerJobId) return frozenCompleteNoop();
      if (ownerEpochTerminalized) return frozenCompleteNoop();

      ownerEpochTerminalized = true;
      wakeGeneration += 1;
      state = "recovering";

      var next = args.recoveryOwnerJobId;
      if (isNonblankString(next) && next !== jobId) {
        installOwner(next);
      } else {
        clearOwner();
      }

      // Probes remain parked; return empty list so callers never treat a wake
      // as a probe drain.
      return deepFreeze({
        advanced: true,
        wakeGeneration: wakeGeneration,
        parkedProbeIds: [],
      });
    }

    /**
     * When recovering with no owner (blocked after terminal without a valid
     * successor), designate a recovery owner for Task 10. Creates a fresh
     * ownership epoch. No-op when not blocked-recovering.
     */
    function designateRecoveryOwner(args) {
      args = args || {};
      var next = requireNonblankId(args.recoveryOwnerJobId, "recoveryOwnerJobId");
      if (state !== "recovering" || ownerJobId != null) {
        return deepFreeze({
          applied: false,
          ownerJobId: ownerJobId,
        });
      }
      installOwner(next);
      return deepFreeze({
        applied: true,
        ownerJobId: ownerJobId,
      });
    }

    /**
     * Successful recovery path: authenticate current recovery owner, bump
     * provider generation, return to normal, drain parked probes once.
     * Stale/wrong completions are frozen no-ops that leave probes parked.
     */
    function recoverToNormal(args) {
      args = args || {};
      var jobId = requireNonblankId(args.jobId, "jobId");

      if (state !== "recovering") {
        return deepFreeze({
          advanced: false,
          generation: generation,
          parkedProbeIds: [],
        });
      }
      if (!ownerJobId || jobId !== ownerJobId) {
        return deepFreeze({
          advanced: false,
          generation: generation,
          parkedProbeIds: [],
        });
      }

      bumpGeneration();
      state = "normal";
      clearOwner();
      reducedConcurrency = null;
      var drained = drainParkedProbes();

      return deepFreeze({
        advanced: true,
        generation: generation,
        parkedProbeIds: drained.slice(),
      });
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
      designateRecoveryOwner: designateRecoveryOwner,
      recoverToNormal: recoverToNormal,
      snapshot: snapshot,
    };
  }

  return {
    createProviderGate: createProviderGate,
  };
});
