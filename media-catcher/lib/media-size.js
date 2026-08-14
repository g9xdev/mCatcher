"use strict";
// Pure media-size policy: validate exact HTTP totals, derive visibly-marked
// bitrate estimates, apply exact-over-estimated precedence, and render labels.
// Inputs are untrusted records; every read is descriptor-safe so a hostile
// accessor can never run inside this module.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McMediaSize = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  const MAX_HEADERS = 128;

  function positiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  // Reads an own data property, refusing accessors so caller code never runs.
  function ownData(record, key) {
    try {
      if (!record || (typeof record !== "object" && typeof record !== "function")) return null;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) return null;
      return { value: descriptor.value };
    } catch (_error) {
      return null;
    }
  }

  // Case-insensitive lookup over {name,value} data pairs. Conflicting duplicates
  // are not resolvable, so the whole read fails closed.
  function readHeader(headers, wantedName) {
    if (!Array.isArray(headers)) return { ok: false, value: "" };
    const lengthState = ownData(headers, "length");
    const length = lengthState && Number.isSafeInteger(lengthState.value) ? lengthState.value : -1;
    if (length < 0 || length > MAX_HEADERS) return { ok: false, value: "" };
    let found = null;
    for (let index = 0; index < length; index += 1) {
      const entryState = ownData(headers, String(index));
      const nameState = entryState && ownData(entryState.value, "name");
      const valueState = entryState && ownData(entryState.value, "value");
      if (!nameState || !valueState || typeof nameState.value !== "string" ||
          typeof valueState.value !== "string") return { ok: false, value: "" };
      if (nameState.value.toLowerCase() === wantedName) {
        if (found !== null && found !== valueState.value) return { ok: false, value: "" };
        found = valueState.value;
      }
    }
    return { ok: true, value: found || "" };
  }

  function exactSizeFromHttp(input) {
    const statusState = ownData(input, "statusCode");
    const headersState = ownData(input, "responseHeaders");
    if (!statusState || !headersState || !Number.isInteger(statusState.value)) return null;
    const rangeState = readHeader(headersState.value, "content-range");
    const lengthState = readHeader(headersState.value, "content-length");
    if (!rangeState.ok || !lengthState.ok) return null;
    const rawRange = rangeState.value.trim();
    const match = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+)$/i.exec(rawRange);
    if (rawRange && !match) return null;
    let bytes = null;
    if (match) {
      const total = positiveSafeInteger(Number(match[3]));
      if (!total) return null;
      const start = match[1] == null ? null : Number(match[1]);
      const end = match[2] == null ? null : Number(match[2]);
      const validRange = start == null || (Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
        start >= 0 && start <= end && end < total);
      if (!validRange) return null;
      bytes = total;
    }
    // A 206 Content-Length describes one chunk, never the resource total.
    if (!bytes && statusState.value === 200) {
      const rawLength = lengthState.value.trim();
      bytes = /^\d+$/.test(rawLength) ? positiveSafeInteger(Number(rawLength)) : null;
    }
    return bytes ? Object.freeze({ sizeBytes: bytes, sizeConfidence: "exact" }) : null;
  }

  function estimatedSizeFromBitrate(input) {
    const durationState = ownData(input, "durationSeconds");
    if (!durationState || !Number.isFinite(durationState.value) || durationState.value <= 0) return null;
    let bitrate = null;
    for (const key of ["selectedBandwidth", "bandwidth"]) {
      const state = ownData(input, key);
      if (state && Number.isFinite(state.value) && state.value > 0) { bitrate = state.value; break; }
    }
    if (bitrate == null) {
      const sampledState = ownData(input, "sampledKbps");
      if (sampledState && Number.isFinite(sampledState.value) && sampledState.value > 0) {
        bitrate = sampledState.value * 1000;
      }
    }
    if (bitrate == null) return null;
    const bytes = positiveSafeInteger(Math.round((bitrate * durationState.value) / 8));
    return bytes ? Object.freeze({ sizeBytes: bytes, sizeConfidence: "estimated" }) : null;
  }

  function chooseSize(current, candidate) {
    function validated(value) {
      const bytesState = ownData(value, "sizeBytes");
      const confidenceState = ownData(value, "sizeConfidence");
      const bytes = bytesState && positiveSafeInteger(bytesState.value);
      const confidence = confidenceState && confidenceState.value;
      return bytes && (confidence === "exact" || confidence === "estimated")
        ? { sizeBytes: bytes, sizeConfidence: confidence }
        : null;
    }
    const before = validated(current);
    const after = validated(candidate);
    const winner = !before ? after : !after ? before
      : before.sizeConfidence === "exact" && after.sizeConfidence !== "exact" ? before
      : after;
    return winner
      ? Object.freeze({ sizeBytes: winner.sizeBytes, sizeConfidence: winner.sizeConfidence })
      : null;
  }

  function sizeLabel(metadata, humanSize) {
    const safe = chooseSize(null, metadata);
    if (!safe || typeof humanSize !== "function") return "Size unknown";
    const value = humanSize(safe.sizeBytes);
    return safe.sizeConfidence === "estimated" ? "Est. " + value : value;
  }

  return Object.freeze({ exactSizeFromHttp, estimatedSizeFromBitrate, chooseSize, sizeLabel });
  }
);
