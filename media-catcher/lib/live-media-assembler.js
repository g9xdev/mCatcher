/*
 * live-media-assembler.js — one-file HLS/DASH VOD assembly.
 *
 * Network access stays injected so the background controller can wrap every
 * manifest, key, init, and segment fetch in its scheduler/provider permit.
 * This module deliberately has no retry, download, native-host, or Firefox
 * behavior. It either returns one owned byte buffer or rejects.
 */
(function (root, factory) {
  "use strict";

  var api = factory(root);
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    root.McLiveMediaAssembler = api;
  }
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  var hasOwn = Object.prototype.hasOwnProperty;
  var arrayBufferTag = "[object ArrayBuffer]";

  function permanentError(message) {
    var error = new Error(message);
    error.failureCategory = "permanent";
    return error;
  }

  function abortError() {
    var error = new Error("Media assembly cancelled.");
    error.name = "AbortError";
    error.cancelled = true;
    return error;
  }

  function requireFunction(value, name) {
    if (typeof value !== "function") {
      throw new TypeError(name + " must be a function");
    }
    return value;
  }

  function requireObject(value, name) {
    if (!value || typeof value !== "object") {
      throw new TypeError(name + " must be an object");
    }
    return value;
  }

  function requireHttpUrl(value) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError("sourceUrl must be a nonblank HTTP(S) URL");
    }
    var parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      throw new TypeError("sourceUrl must be a nonblank HTTP(S) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("sourceUrl must be a nonblank HTTP(S) URL");
    }
    return value;
  }

  function isArrayBuffer(value) {
    return Object.prototype.toString.call(value) === arrayBufferTag;
  }

  function isByteView(value) {
    return (
      value != null &&
      typeof value === "object" &&
      ArrayBuffer.isView(value) &&
      value.BYTES_PER_ELEMENT === 1
    );
  }

  function copyBytes(value) {
    if (!isByteView(value) || value.byteLength === 0) {
      throw permanentError("Assembler produced malformed media bytes.");
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }

  function finish(bytes, mime, extension) {
    return Object.freeze({
      bytes: copyBytes(bytes),
      mime: mime,
      extension: extension,
    });
  }

  function normalizeHlsDownload(result) {
    if (!result || typeof result !== "object") {
      throw permanentError("HLS assembly returned a malformed result.");
    }
    var extension = result.ext;
    var mime = result.mime;
    if (
      typeof extension !== "string" ||
      !/^(?:mp4|m4a|ts|aac)$/i.test(extension) ||
      typeof mime !== "string" ||
      mime.trim() === ""
    ) {
      throw permanentError("HLS assembly returned a malformed result.");
    }
    return {
      bytes: copyBytes(result.data),
      mime: mime,
      extension: extension.toLowerCase(),
    };
  }

  function ownDataValue(object, key) {
    if (!object || typeof object !== "object") return undefined;
    var descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(object, key);
    } catch (error) {
      throw new TypeError("selection must contain data properties");
    }
    if (!descriptor) return undefined;
    if (!hasOwn.call(descriptor, "value")) {
      throw new TypeError("selection must contain data properties");
    }
    return descriptor.value;
  }

  function snapshotSelection(selection) {
    var snapshot = {
      representationId: null,
      width: null,
      height: null,
      bandwidth: null,
      mime: null,
    };
    if (selection == null) return snapshot;
    if (typeof selection !== "object") {
      throw new TypeError("selection must be an object or null");
    }
    var value = ownDataValue(selection, "representationId");
    if (value != null) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError("selection representation id must be a nonblank string");
      }
      snapshot.representationId = value;
    }
    var numericKeys = ["width", "height", "bandwidth"];
    for (var i = 0; i < numericKeys.length; i += 1) {
      var key = numericKeys[i];
      value = ownDataValue(selection, key);
      if (value == null) continue;
      if (!Number.isInteger(value) || value < 1) {
        throw new TypeError("selection quality metadata must be positive integers");
      }
      snapshot[key] = value;
    }
    value = ownDataValue(selection, "mime");
    if (value != null) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError("selection mime must be a nonblank string");
      }
      snapshot.mime = value.trim().toLowerCase();
    }
    return snapshot;
  }

  function numeric(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  function stringValue(value) {
    return typeof value === "string" ? value : "";
  }

  function compareBest(left, right) {
    var difference = numeric(right.bandwidth) - numeric(left.bandwidth);
    if (difference !== 0) return difference;
    difference = numeric(right.height) - numeric(left.height);
    if (difference !== 0) return difference;
    difference = numeric(right.width) - numeric(left.width);
    if (difference !== 0) return difference;
    var leftId = stringValue(left.id || left.uri);
    var rightId = stringValue(right.id || right.uri);
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return 0;
  }

  function bestEntry(entries, label) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw permanentError(label + " had no usable representations.");
    }
    var copy = entries.slice();
    for (var i = 0; i < copy.length; i += 1) {
      if (!copy[i] || typeof copy[i] !== "object") {
        throw permanentError(label + " contained a malformed representation.");
      }
    }
    copy.sort(compareBest);
    return copy[0];
  }

  function chooseDashVideo(video, selection) {
    if (!Array.isArray(video) || video.length === 0) {
      throw permanentError("DASH manifest had no video representations.");
    }
    if (selection.representationId !== null) {
      for (var i = 0; i < video.length; i += 1) {
        if (video[i] && video[i].id === selection.representationId) return video[i];
      }
      throw permanentError("Selected DASH representation is unavailable.");
    }

    var hasNumericSelection =
      selection.width !== null ||
      selection.height !== null ||
      selection.bandwidth !== null;
    if (hasNumericSelection || selection.mime !== null) {
      var matches = [];
      for (var j = 0; j < video.length; j += 1) {
        var candidate = video[j];
        if (!candidate || typeof candidate !== "object") continue;
        if (selection.width !== null && candidate.width !== selection.width) continue;
        if (selection.height !== null && candidate.height !== selection.height) continue;
        if (selection.bandwidth !== null && candidate.bandwidth !== selection.bandwidth) continue;
        if (
          !hasNumericSelection &&
          selection.mime !== null &&
          stringValue(candidate.mimeType).trim().toLowerCase() !== selection.mime
        ) {
          continue;
        }
        matches.push(candidate);
      }
      if (matches.length === 0) {
        throw permanentError("Selected DASH representation is unavailable.");
      }
      return bestEntry(matches, "Selected DASH quality");
    }
    return bestEntry(video, "DASH manifest");
  }

  function validMediaUri(value) {
    return typeof value === "string" && value.trim() !== "";
  }

  function validByteRange(value) {
    return (
      value == null ||
      (
        typeof value === "object" &&
        Number.isInteger(value.offset) &&
        value.offset >= 0 &&
        Number.isInteger(value.length) &&
        value.length > 0
      )
    );
  }

  function dashMediaFromRepresentation(representation) {
    if (!representation || typeof representation !== "object") {
      throw permanentError("DASH representation was malformed.");
    }
    var segments = representation.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      throw permanentError("DASH representation had no media segments.");
    }
    var mapped = [];
    for (var i = 0; i < segments.length; i += 1) {
      var segment = segments[i];
      if (
        !segment ||
        typeof segment !== "object" ||
        !validMediaUri(segment.uri) ||
        !validByteRange(segment.byteRange)
      ) {
        throw permanentError("DASH representation contained a malformed segment.");
      }
      mapped.push({
        uri: segment.uri,
        byteRange: segment.byteRange || null,
        key: null,
        seq: i,
      });
    }

    var map = null;
    if (representation.init != null) {
      if (
        typeof representation.init !== "object" ||
        !validMediaUri(representation.init.uri) ||
        !validByteRange(representation.init.byteRange)
      ) {
        throw permanentError("DASH representation contained a malformed init segment.");
      }
      map = {
        uri: representation.init.uri,
        byteRange: representation.init.byteRange || null,
      };
    }

    return {
      type: "media",
      map: map,
      segments: mapped,
      isLive: false,
      encryption: null,
    };
  }

  function explicitlyUnsupportedMp4(representation) {
    var mime = stringValue(representation && representation.mimeType).toLowerCase();
    return mime.indexOf("webm") !== -1 || mime.indexOf("ogg") !== -1;
  }

  function compatibleSplitDash(video, audio) {
    return (
      video &&
      audio &&
      video.init &&
      audio.init &&
      !explicitlyUnsupportedMp4(video) &&
      !explicitlyUnsupportedMp4(audio)
    );
  }

  function validateHlsMedia(media) {
    if (!media || typeof media !== "object" || media.type !== "media") {
      throw permanentError("HLS media playlist was malformed.");
    }
    if (media.isLive !== false) {
      throw permanentError("Live HLS is not supported by VOD assembly.");
    }
    if (!Array.isArray(media.segments) || media.segments.length === 0) {
      throw permanentError("HLS media playlist had no segments.");
    }
    if (media.encryption) {
      if (
        media.encryption.method !== "AES-128" ||
        (media.encryption.keyFormat && media.encryption.keyFormat !== "identity")
      ) {
        throw permanentError("Protected HLS content is not supported.");
      }
    }
    return media;
  }

  function bestHlsVariant(master) {
    if (!master || typeof master !== "object" || master.type !== "master") {
      throw permanentError("HLS master playlist was malformed.");
    }
    var variant = bestEntry(master.variants, "HLS master playlist");
    if (!validMediaUri(variant.uri)) {
      throw permanentError("HLS master playlist contained a malformed variant.");
    }
    return variant;
  }

  function associatedAudioUrl(master, variant) {
    if (!variant.audioGroup) return null;
    var groups = master.audioGroups;
    if (!groups || typeof groups !== "object") return null;
    var group = groups[variant.audioGroup];
    if (!Array.isArray(group) || group.length === 0) return null;
    var chosen = null;
    for (var i = 0; i < group.length; i += 1) {
      if (group[i] && group[i].default === true) {
        chosen = group[i];
        break;
      }
    }
    if (!chosen) chosen = group[0];
    if (!chosen || !validMediaUri(chosen.uri)) {
      throw permanentError("HLS audio rendition was malformed.");
    }
    return chosen.uri === variant.uri ? null : chosen.uri;
  }

  function createLiveMediaAssembler(dependencies) {
    dependencies = requireObject(dependencies, "dependencies");
    var HLS = requireObject(dependencies.HLS, "HLS");
    var DASH = requireObject(dependencies.DASH, "DASH");
    var Mux = requireObject(dependencies.Mux, "Mux");
    requireFunction(HLS.parsePlaylist, "HLS.parsePlaylist");
    requireFunction(HLS.downloadMedia, "HLS.downloadMedia");
    requireFunction(DASH.parse, "DASH.parse");
    requireFunction(Mux.combineFmp4, "Mux.combineFmp4");

    var Decoder = typeof TextDecoder === "function"
      ? TextDecoder
      : root && typeof root.TextDecoder === "function"
        ? root.TextDecoder
        : null;
    if (!Decoder) throw new Error("TextDecoder unavailable");

    function decodeManifest(buffer) {
      if (!isArrayBuffer(buffer)) {
        throw permanentError("Manifest fetch returned malformed bytes.");
      }
      try {
        return new Decoder("utf-8", { fatal: true }).decode(buffer);
      } catch (error) {
        throw permanentError("Manifest was not valid UTF-8.");
      }
    }

    async function assembleMedia(input) {
      input = requireObject(input, "assembly input");
      var kind = input.kind;
      if (kind !== "hls" && kind !== "dash") {
        throw new TypeError("kind must be hls or dash");
      }
      var sourceUrl = requireHttpUrl(input.sourceUrl);
      var selection = snapshotSelection(input.selection);
      var segmentConcurrency = input.segmentConcurrency;
      if (!Number.isInteger(segmentConcurrency) || segmentConcurrency < 1) {
        throw new TypeError("segmentConcurrency must be a positive integer");
      }
      var fetchArrayBuffer = requireFunction(input.fetchArrayBuffer, "fetchArrayBuffer");
      var shouldAbort = requireFunction(input.shouldAbort, "shouldAbort");
      var onProgress = requireFunction(input.onProgress, "onProgress");

      function checkAbort() {
        if (shouldAbort()) throw abortError();
      }

      async function fetchManifest(url) {
        checkAbort();
        var buffer = await fetchArrayBuffer(url);
        checkAbort();
        return decodeManifest(buffer);
      }

      function progress(event) {
        checkAbort();
        onProgress(event);
      }

      async function downloadHlsMedia(media, containerHint) {
        checkAbort();
        var result = await HLS.downloadMedia(media, {
          fetchFn: fetchArrayBuffer,
          concurrency: segmentConcurrency,
          allowLive: false,
          containerHint: containerHint,
          shouldAbort: shouldAbort,
          onProgress: progress,
        });
        checkAbort();
        return normalizeHlsDownload(result);
      }

      async function combine(video, audio, unsupportedMessage) {
        checkAbort();
        var combined;
        try {
          combined = Mux.combineFmp4(video.bytes, audio.bytes);
        } catch (error) {
          throw permanentError("Fragmented MP4 tracks could not be muxed.");
        }
        checkAbort();
        if (!isByteView(combined) || combined.byteLength === 0) {
          throw permanentError(unsupportedMessage);
        }
        return finish(combined, "video/mp4", "mp4");
      }

      checkAbort();
      var manifestText = await fetchManifest(sourceUrl);
      checkAbort();

      if (kind === "hls") {
        var parsedHls;
        try {
          parsedHls = HLS.parsePlaylist(manifestText, sourceUrl);
        } catch (error) {
          throw permanentError("HLS manifest was malformed.");
        }

        var videoMedia;
        var audioUrl = null;
        if (parsedHls && parsedHls.type === "master") {
          var variant = bestHlsVariant(parsedHls);
          audioUrl = associatedAudioUrl(parsedHls, variant);
          var videoText = await fetchManifest(variant.uri);
          try {
            videoMedia = HLS.parsePlaylist(videoText, variant.uri);
          } catch (error) {
            throw permanentError("HLS media manifest was malformed.");
          }
        } else {
          videoMedia = parsedHls;
        }
        validateHlsMedia(videoMedia);
        var video = await downloadHlsMedia(videoMedia, null);

        if (audioUrl === null) {
          return finish(video.bytes, video.mime, video.extension);
        }

        var audioText = await fetchManifest(audioUrl);
        var audioMedia;
        try {
          audioMedia = HLS.parsePlaylist(audioText, audioUrl);
        } catch (error) {
          throw permanentError("HLS audio manifest was malformed.");
        }
        validateHlsMedia(audioMedia);
        var audio = await downloadHlsMedia(audioMedia, null);
        if (video.extension !== "mp4" || audio.extension !== "mp4") {
          throw permanentError("Unsupported split HLS tracks; audio cannot be omitted.");
        }
        return combine(video, audio, "Unsupported split HLS tracks; audio cannot be omitted.");
      }

      var parsedDash;
      try {
        parsedDash = DASH.parse(manifestText, sourceUrl);
      } catch (error) {
        throw permanentError("DASH manifest was malformed.");
      }
      if (!parsedDash || typeof parsedDash !== "object" || parsedDash.type !== "dash") {
        throw permanentError("DASH manifest was malformed.");
      }
      if (parsedDash.drm === true) {
        throw permanentError("Protected DASH content is not supported.");
      }
      if (parsedDash.isDynamic === true) {
        throw permanentError("Dynamic DASH is not supported by VOD assembly.");
      }

      var videoRepresentation = chooseDashVideo(parsedDash.video, selection);
      if (explicitlyUnsupportedMp4(videoRepresentation)) {
        throw permanentError("Unsupported DASH video container.");
      }
      var audioRepresentation = null;
      if (Array.isArray(parsedDash.audio) && parsedDash.audio.length > 0) {
        audioRepresentation = bestEntry(parsedDash.audio, "DASH audio");
        if (!compatibleSplitDash(videoRepresentation, audioRepresentation)) {
          throw permanentError("Unsupported split DASH tracks; audio cannot be omitted.");
        }
      } else if (parsedDash.audio != null && !Array.isArray(parsedDash.audio)) {
        throw permanentError("DASH manifest had malformed audio representations.");
      }

      var dashVideo = await downloadHlsMedia(
        dashMediaFromRepresentation(videoRepresentation),
        "mp4"
      );
      if (audioRepresentation === null) {
        return finish(dashVideo.bytes, "video/mp4", "mp4");
      }

      var dashAudio = await downloadHlsMedia(
        dashMediaFromRepresentation(audioRepresentation),
        "m4a"
      );
      return combine(
        dashVideo,
        dashAudio,
        "Unsupported split DASH tracks; audio cannot be omitted."
      );
    }

    return Object.freeze(assembleMedia);
  }

  return Object.freeze({
    createLiveMediaAssembler: createLiveMediaAssembler,
  });
});
