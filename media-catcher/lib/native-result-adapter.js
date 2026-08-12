(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McNativeResultAdapter = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
    "use strict";

    var KNOWN_FAILURE_CATEGORIES = {
      range_unsupported: true,
      timeout: true,
      connection_reset: true,
      short_read: true,
      http_429: true,
      http_5xx_temporary: true,
      local_io: true,
      cancelled: true,
      permanent: true
    };

    var ALLOWED_STATUSES = {
      completed: true,
      failed: true,
      cancelled: true
    };

    var ALLOWED_MODES = {
      "multi-range": true,
      "single-connection": true
    };

    var ALLOWED_PART_STATES = {
      committed: true,
      empty: true,
      partial: true
    };

    function isNonblankString(v) {
      return typeof v === "string" && v.trim().length > 0;
    }

    function normalizeFailureCategory(value) {
      if (typeof value === "string" && KNOWN_FAILURE_CATEGORIES[value]) {
        return value;
      }
      return "permanent";
    }

    /**
     * Map a structured native pget-result into scheduler APIs.
     * Pure adapter: no browser downloads, native messaging, timers, or storage.
     * options.startSingleConnection is the only effect callback that may be invoked.
     * After a successful capability switch, startSingleConnection errors propagate.
     */
    function handlePgetResult(scheduler, msg, options) {
      var startAfterSwitch = null;

      try {
        if (!scheduler || typeof scheduler !== "object") return;
        if (!msg || typeof msg !== "object") return;

        var type = msg.type;
        var id = msg.id;
        var attemptToken = msg.attemptToken;
        var status = msg.status;
        var mode = msg.mode;
        var failureCategory = msg.failureCategory;
        var partState = msg.partState;

        if (type !== "pget-result") return;
        if (!isNonblankString(id)) return;
        if (!isNonblankString(attemptToken)) return;
        if (!ALLOWED_STATUSES[status]) return;
        if (!ALLOWED_MODES[mode]) return;
        if (!ALLOWED_PART_STATES[partState]) return;

        if (typeof scheduler.getJob !== "function") return;

        var job;
        try {
          job = scheduler.getJob(id);
        } catch (e) {
          return;
        }
        if (!job || typeof job !== "object") return;

        // Pausing jobs authenticate privately via the draining API. Public
        // attemptToken is null and must never be used as identity. Do not
        // capability-switch or startSingleConnection while parked.
        if (job.state === "pausing_provider") {
          if (typeof scheduler.onDrainingTransportResult !== "function") return;
          // Ordinary path requires mode match with the job's current mode.
          if (mode !== job.mode) return;

          var drainCategory;
          if (status === "completed") {
            if (partState !== "committed") return;
            if (failureCategory !== null) return;
            drainCategory = null;
          } else if (status === "cancelled") {
            drainCategory = "cancelled";
          } else if (status === "failed") {
            // Failed must never carry committed (invalid Task-13 terminal).
            if (partState === "committed") return;
            drainCategory = normalizeFailureCategory(failureCategory);
          } else {
            return;
          }

          var drainAllowlisted = {
            status: status,
            mode: mode,
            failureCategory: drainCategory,
            partState: partState
          };

          try {
            // Pass the message token (private draining identity), never public null.
            scheduler.onDrainingTransportResult(id, attemptToken, drainAllowlisted);
          } catch (eDrain) {
            return;
          }
          return;
        }

        if (job.state !== "running") return;
        if (!isNonblankString(job.attemptToken)) return;
        if (job.attemptToken !== attemptToken) return;

        // Exact multi-range → single-connection capability switch.
        // Checked before ordinary mode-mismatch ignore so a duplicate after switch
        // (job already single-connection, msg still multi-range) is a no-op.
        if (
          job.mode === "multi-range" &&
          mode === "multi-range" &&
          status === "failed" &&
          failureCategory === "range_unsupported" &&
          partState === "empty"
        ) {
          // Capture and type-check start callback before any capability mutation.
          // Invalid/missing/throwing start must leave the job in multi-range.
          var startFn = null;
          if (options && typeof options === "object") {
            startFn = options.startSingleConnection;
          }
          if (typeof startFn !== "function") return;

          if (typeof scheduler.onCapabilitySwitch !== "function") return;
          try {
            scheduler.onCapabilitySwitch(id, {
              mode: "single-connection",
              partState: "empty"
            });
          } catch (e) {
            return;
          }

          var post;
          try {
            post = scheduler.getJob(id);
          } catch (e2) {
            return;
          }
          if (!post || typeof post !== "object") return;
          if (post.state !== "running") return;
          if (post.attemptToken !== attemptToken) return;
          if (post.mode !== "single-connection") return;

          // Defer call so outer fail-closed catch does not swallow start errors.
          startAfterSwitch = { fn: startFn, job: post };
        } else {
          // Ordinary path requires mode match with the job's current mode.
          if (mode !== job.mode) return;

          var outCategory;
          if (status === "completed") {
            if (partState !== "committed") return;
            if (failureCategory !== null) return;
            outCategory = null;
          } else if (status === "cancelled") {
            outCategory = "cancelled";
          } else if (status === "failed") {
            // Failed must never carry committed (invalid Task-13 terminal).
            if (partState === "committed") return;
            outCategory = normalizeFailureCategory(failureCategory);
          } else {
            return;
          }

          if (typeof scheduler.onTransportResult !== "function") return;

          var allowlisted = {
            status: status,
            mode: mode,
            failureCategory: outCategory,
            partState: partState
          };

          try {
            scheduler.onTransportResult(id, attemptToken, allowlisted);
          } catch (e3) {
            return;
          }
        }
      } catch (outer) {
        // Fail closed: never throw from validation / hostile accessors.
        return;
      }

      if (startAfterSwitch) {
        startAfterSwitch.fn(startAfterSwitch.job);
      }
    }

    return {
      handlePgetResult: handlePgetResult
    };
  }
);
