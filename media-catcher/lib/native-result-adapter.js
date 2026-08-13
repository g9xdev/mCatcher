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

    // Null-prototype allowlists: ordinary objects accept inherited keys such as
    // "__proto__", "constructor", and "toString" as truthy membership.
    var KNOWN_FAILURE_CATEGORIES = Object.freeze(
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

    var ALLOWED_STATUSES = Object.freeze(
      Object.assign(Object.create(null), {
        completed: true,
        failed: true,
        cancelled: true,
      })
    );

    var ALLOWED_MODES = Object.freeze(
      Object.assign(Object.create(null), {
        "multi-range": true,
        "single-connection": true,
      })
    );

    var ALLOWED_PART_STATES = Object.freeze(
      Object.assign(Object.create(null), {
        committed: true,
        empty: true,
        partial: true,
      })
    );

    function isOwnAllowlisted(dict, key) {
      return (
        typeof key === "string" &&
        Object.prototype.hasOwnProperty.call(dict, key) === true &&
        dict[key] === true
      );
    }

    function isPrimitiveString(v) {
      return typeof v === "string";
    }

    function isNonblankPrimitiveString(v) {
      return typeof v === "string" && v.trim().length > 0;
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
     * Running failed path after descriptor-safe snapshot:
     * - absent / own undefined / own null → permanent (compat)
     * - known exact primitive string → preserve
     * - unknown exact primitive string → permanent (compat)
     * - any other type (boxed string/object/array/number/bool/bigint/symbol/fn)
     *   → reject; never coerce or launder to permanent
     */
    function normalizeFailureCategory(value) {
      if (value === undefined || value === null) {
        return { ok: true, category: "permanent" };
      }
      if (!isPrimitiveString(value)) {
        return { ok: false };
      }
      if (isOwnAllowlisted(KNOWN_FAILURE_CATEGORIES, value)) {
        return { ok: true, category: value };
      }
      return { ok: true, category: "permanent" };
    }

    /**
     * Validate completed/cancelled/failed category rules shared by running and pausing.
     * Returns { ok:true, category } or { ok:false }.
     * Pausing failed requires a known exact category (scheduler contract).
     * Running failed still normalizes missing/unknown primitive strings to permanent.
     */
    function resolveTerminalCategory(status, partState, failureCategory, pausing) {
      if (status === "completed") {
        if (partState !== "committed") return { ok: false };
        if (failureCategory !== null && failureCategory !== undefined) {
          return { ok: false };
        }
        return { ok: true, category: null };
      }
      if (status === "cancelled") {
        // Accept only absent/undefined/null or exact primitive "cancelled".
        if (failureCategory === undefined || failureCategory === null) {
          return { ok: true, category: "cancelled" };
        }
        if (
          isPrimitiveString(failureCategory) &&
          failureCategory === "cancelled"
        ) {
          return { ok: true, category: "cancelled" };
        }
        return { ok: false };
      }
      if (status === "failed") {
        // Failed must never carry committed (invalid Task-13 terminal).
        if (partState === "committed") return { ok: false };
        if (pausing) {
          if (
            !isPrimitiveString(failureCategory) ||
            !isOwnAllowlisted(KNOWN_FAILURE_CATEGORIES, failureCategory)
          ) {
            return { ok: false };
          }
          return { ok: true, category: failureCategory };
        }
        return normalizeFailureCategory(failureCategory);
      }
      return { ok: false };
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

        // Snapshot only own DATA descriptors for required wire fields and optional
        // failureCategory. Accessors/proxies reject fail-closed without invoking.
        var typeRead = readOwnDataField(msg, "type", true);
        var idRead = readOwnDataField(msg, "id", true);
        var tokenRead = readOwnDataField(msg, "attemptToken", true);
        var statusRead = readOwnDataField(msg, "status", true);
        var modeRead = readOwnDataField(msg, "mode", true);
        var partRead = readOwnDataField(msg, "partState", true);
        var failRead = readOwnDataField(msg, "failureCategory", false);
        if (
          !typeRead.ok ||
          !idRead.ok ||
          !tokenRead.ok ||
          !statusRead.ok ||
          !modeRead.ok ||
          !partRead.ok ||
          !failRead.ok
        ) {
          return;
        }

        var type = typeRead.value;
        var id = idRead.value;
        var attemptToken = tokenRead.value;
        var status = statusRead.value;
        var mode = modeRead.value;
        var partState = partRead.value;
        var failureCategory = failRead.value;

        if (!isPrimitiveString(type) || type !== "pget-result") return;
        if (!isNonblankPrimitiveString(id)) return;
        if (!isNonblankPrimitiveString(attemptToken)) return;
        if (!isOwnAllowlisted(ALLOWED_STATUSES, status)) return;
        if (!isOwnAllowlisted(ALLOWED_MODES, mode)) return;
        if (!isOwnAllowlisted(ALLOWED_PART_STATES, partState)) return;

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

          var drainResolved = resolveTerminalCategory(
            status,
            partState,
            failureCategory,
            true
          );
          if (!drainResolved.ok) return;

          var drainAllowlisted = {
            status: status,
            mode: mode,
            failureCategory: drainResolved.category,
            partState: partState,
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
        if (!isNonblankPrimitiveString(job.attemptToken)) return;
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
              partState: "empty",
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

          var runResolved = resolveTerminalCategory(
            status,
            partState,
            failureCategory,
            false
          );
          if (!runResolved.ok) return;

          if (typeof scheduler.onTransportResult !== "function") return;

          var allowlisted = {
            status: status,
            mode: mode,
            failureCategory: runResolved.category,
            partState: partState,
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
      handlePgetResult: handlePgetResult,
    };
  }
);
