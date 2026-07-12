/*
 * dash.js — practical MPEG-DASH (.mpd) parser.
 * Covers SegmentTemplate (number + timeline), SegmentList, SegmentBase
 * (single-file byte ranges), multi-period, BaseURL resolution, and
 * ContentProtection (DRM) detection. Static (VOD) profiles only.
 *
 * Exposed as global `DASH`.
 */
(function (global) {
  "use strict";

  function resolve(base, uri) {
    try { return new URL(uri, base).href; } catch (e) { return uri; }
  }

  function firstText(el, tag) {
    const n = el.getElementsByTagName(tag)[0];
    return n ? (n.textContent || "").trim() : null;
  }

  function attr(el, name, dflt) {
    const v = el.getAttribute(name);
    return v == null ? (dflt == null ? null : dflt) : v;
  }

  // Duration like "PT1H2M3.5S" -> seconds.
  function parseDuration(s) {
    if (!s) return 0;
    const m = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?/.exec(s);
    if (!m) return 0;
    const [, , , d, h, mi, se] = m;
    return (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+se || 0);
  }

  function baseUrlOf(el, parentBase) {
    const b = el.getElementsByTagName("BaseURL")[0];
    // Only direct-child BaseURL should apply; getElementsByTagName is deep, so
    // guard by checking parentNode.
    if (b && b.parentNode === el) return resolve(parentBase, (b.textContent || "").trim());
    return parentBase;
  }

  function fillTemplate(tpl, vars) {
    return tpl.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (m, name, width) => {
      if (name === "RepresentationID") return vars.RepresentationID;
      if (name === "Bandwidth") return vars.Bandwidth;
      if (name === "$") return "$";
      let val = vars[name];
      if (val == null) return m;
      if (width) val = String(val).padStart(parseInt(width, 10), "0");
      return String(val);
    }).replace(/\$\$/g, "$");
  }

  function hasDRM(el) {
    const cps = el.getElementsByTagName("ContentProtection");
    return cps && cps.length > 0;
  }

  // Build the ordered segment list for a representation using SegmentTemplate.
  function segmentsFromTemplate(tpl, base, repId, bandwidth) {
    const media = tpl.getAttribute("media");
    const initTpl = tpl.getAttribute("initialization");
    const startNumber = parseInt(tpl.getAttribute("startNumber") || "1", 10);
    const timescale = parseInt(tpl.getAttribute("timescale") || "1", 10);
    const vars = { RepresentationID: repId, Bandwidth: bandwidth };

    const segments = [];
    let init = null;
    if (initTpl) init = { uri: resolve(base, fillTemplate(initTpl, vars)) };

    const timelineEl = tpl.getElementsByTagName("SegmentTimeline")[0];
    if (timelineEl) {
      let number = startNumber;
      let time = 0;
      const ss = timelineEl.getElementsByTagName("S");
      for (let i = 0; i < ss.length; i++) {
        const s = ss[i];
        const t = s.getAttribute("t");
        if (t != null) time = parseInt(t, 10);
        const d = parseInt(s.getAttribute("d"), 10);
        const r = parseInt(s.getAttribute("r") || "0", 10); // repeat
        for (let j = 0; j <= r; j++) {
          const v = Object.assign({ Number: number, Time: time }, vars);
          segments.push({ uri: resolve(base, fillTemplate(media, v)), duration: d / timescale });
          time += d;
          number++;
        }
      }
    } else {
      // Number-based: derive count from total duration / segment duration.
      const segDur = parseInt(tpl.getAttribute("duration"), 10);
      const total = tpl.__totalDuration || 0;
      const count = segDur && total ? Math.ceil((total * timescale) / segDur) : 0;
      for (let i = 0; i < count; i++) {
        const v = Object.assign({ Number: startNumber + i, Time: i * segDur }, vars);
        segments.push({ uri: resolve(base, fillTemplate(media, v)), duration: segDur / timescale });
      }
    }
    return { init, segments };
  }

  function segmentsFromList(listEl, base) {
    const init = null;
    const initEl = listEl.getElementsByTagName("Initialization")[0];
    const initObj = initEl && initEl.getAttribute("sourceURL")
      ? { uri: resolve(base, initEl.getAttribute("sourceURL")) }
      : null;
    const segments = [];
    const urls = listEl.getElementsByTagName("SegmentURL");
    for (let i = 0; i < urls.length; i++) {
      const media = urls[i].getAttribute("media");
      if (media) segments.push({ uri: resolve(base, media), duration: 0 });
    }
    return { init: initObj, segments };
  }

  // SegmentBase: whole representation is one file; init is a byte range.
  function segmentsFromBase(repBase, base) {
    return { init: null, segments: [{ uri: base, duration: 0, wholeFile: true }] };
  }

  function parse(text, mpdUrl) {
    const DP = global.DOMParser;
    if (!DP) throw new Error("DOMParser unavailable");
    const doc = new DP().parseFromString(text, "application/xml");
    const mpd = doc.getElementsByTagName("MPD")[0];
    if (!mpd) throw new Error("Not a valid MPD");

    const isDynamic = (mpd.getAttribute("type") || "static") === "dynamic";
    const totalDuration = parseDuration(mpd.getAttribute("mediaPresentationDuration"));
    const mpdBase = baseUrlOf(mpd, mpdUrl);

    const videoReps = [];
    const audioReps = [];
    let drm = false;

    const periods = mpd.getElementsByTagName("Period");
    for (let p = 0; p < periods.length; p++) {
      const period = periods[p];
      const periodBase = baseUrlOf(period, mpdBase);
      const adaptSets = period.getElementsByTagName("AdaptationSet");
      for (let a = 0; a < adaptSets.length; a++) {
        const as = adaptSets[a];
        const asBase = baseUrlOf(as, periodBase);
        const mime = (attr(as, "mimeType", "") || attr(as, "contentType", "") || "").toLowerCase();
        const kind = mime.indexOf("audio") >= 0 ? "audio"
          : mime.indexOf("video") >= 0 ? "video" : null;
        if (hasDRM(as)) drm = true;

        const asTemplate = as.getElementsByTagName("SegmentTemplate")[0];
        const reps = as.getElementsByTagName("Representation");
        for (let r = 0; r < reps.length; r++) {
          const rep = reps[r];
          if (hasDRM(rep)) drm = true;
          const repId = rep.getAttribute("id") || "";
          const bandwidth = parseInt(rep.getAttribute("bandwidth") || "0", 10);
          const width = parseInt(rep.getAttribute("width") || "0", 10);
          const height = parseInt(rep.getAttribute("height") || "0", 10);
          const codecs = rep.getAttribute("codecs") || "";
          const repBase = baseUrlOf(rep, asBase);
          const repMime = (rep.getAttribute("mimeType") || mime).toLowerCase();
          const repKind = kind || (repMime.indexOf("audio") >= 0 ? "audio"
            : repMime.indexOf("video") >= 0 ? "video" : "video");

          let seg = { init: null, segments: [] };
          const tpl = rep.getElementsByTagName("SegmentTemplate")[0] || asTemplate;
          const list = rep.getElementsByTagName("SegmentList")[0];
          const segBase = rep.getElementsByTagName("SegmentBase")[0];

          if (tpl) {
            tpl.__totalDuration = totalDuration;
            seg = segmentsFromTemplate(tpl, repBase, repId, bandwidth);
          } else if (list) {
            seg = segmentsFromList(list, repBase);
          } else if (segBase || repBase) {
            seg = segmentsFromBase(rep, repBase);
          }

          const entry = {
            id: repId, bandwidth, width, height, codecs,
            mimeType: repMime, kind: repKind,
            init: seg.init, segments: seg.segments,
          };
          (repKind === "audio" ? audioReps : videoReps).push(entry);
        }
      }
    }

    videoReps.sort((a, b) => b.bandwidth - a.bandwidth);
    audioReps.sort((a, b) => b.bandwidth - a.bandwidth);

    return {
      type: "dash",
      isDynamic,
      drm,
      duration: totalDuration,
      video: videoReps,
      audio: audioReps,
      variants: videoReps.map((v) => ({
        id: v.id,
        height: v.height,
        bandwidth: v.bandwidth,
        resolution: v.width && v.height ? v.width + "x" + v.height : "",
        label: (v.width && v.height ? v.width + "x" + v.height : (v.height ? v.height + "p" : "auto")) +
          (v.bandwidth ? " · " + Math.round(v.bandwidth / 1000) + " kbps" : ""),
      })),
    };
  }

  global.DASH = { parse, parseDuration, fillTemplate, resolve };
})(typeof self !== "undefined" ? self : this);
