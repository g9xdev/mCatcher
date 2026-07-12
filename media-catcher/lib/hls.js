/*
 * hls.js — minimal HLS (m3u8) parser + downloader.
 *
 * Scope: standard, open HLS. Handles VOD playlists, master/variant playlists,
 * fMP4 (#EXT-X-MAP) and MPEG-TS segments, and clear-key AES-128 encryption
 * (METHOD=AES-128, key served in the clear) — which is what a normal player
 * does to play the stream. It does NOT attempt to defeat DRM systems
 * (Widevine / PlayReady / FairPlay, or SAMPLE-AES key-server DRM). Those
 * streams are detected but reported as unsupported.
 *
 * Exposed as global `HLS` for the background page.
 */
(function (global) {
  "use strict";

  // Resolve a possibly-relative URI against a base playlist URL.
  function resolveUrl(base, uri) {
    try {
      return new URL(uri, base).href;
    } catch (e) {
      return uri;
    }
  }

  function parseAttributes(line) {
    // Parses `KEY=VALUE,KEY="quoted,value",...`
    const attrs = {};
    const re = /([A-Z0-9\-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      let val = m[2];
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      attrs[m[1]] = val;
    }
    return attrs;
  }

  // Returns { type: 'master', variants: [...] } or { type: 'media', ...media }.
  function parsePlaylist(text, playlistUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

    if (isMaster) {
      const variants = [];
      const audioGroups = {};
      const subtitleGroups = {};
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("#EXT-X-MEDIA:")) {
          const a = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
          if (a.TYPE === "AUDIO" && a.URI) {
            (audioGroups[a["GROUP-ID"]] = audioGroups[a["GROUP-ID"]] || []).push({
              name: a.NAME,
              language: a.LANGUAGE || "",
              uri: resolveUrl(playlistUrl, a.URI),
              default: a.DEFAULT === "YES",
            });
          } else if (a.TYPE === "SUBTITLES" && a.URI) {
            (subtitleGroups[a["GROUP-ID"]] = subtitleGroups[a["GROUP-ID"]] || []).push({
              name: a.NAME,
              language: a.LANGUAGE || "",
              uri: resolveUrl(playlistUrl, a.URI),
              default: a.DEFAULT === "YES",
            });
          }
        } else if (line.startsWith("#EXT-X-STREAM-INF")) {
          const a = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
          // The URI is the next non-comment line.
          let uri = "";
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j] && !lines[j].startsWith("#")) {
              uri = lines[j];
              i = j;
              break;
            }
          }
          if (!uri) continue;
          const res = a.RESOLUTION || "";
          const bw = parseInt(a.BANDWIDTH || "0", 10);
          variants.push({
            uri: resolveUrl(playlistUrl, uri),
            bandwidth: bw,
            resolution: res,
            codecs: a.CODECS || "",
            audioGroup: a.AUDIO || null,
            subtitleGroup: a.SUBTITLES || null,
            height: res ? parseInt(res.split("x")[1] || "0", 10) : 0,
          });
        }
      }
      variants.sort((x, y) => y.bandwidth - x.bandwidth);
      return { type: "master", variants, audioGroups, subtitleGroups };
    }

    // Media playlist.
    const media = {
      type: "media",
      segments: [],
      map: null, // init segment for fMP4
      encryption: null,
      isLive: !lines.includes("#EXT-X-ENDLIST"),
      targetDuration: 0,
    };

    let currentKey = null; // {method, uri, iv}
    let mediaSequence = 0;
    let segIndex = 0;
    let pendingDuration = 0;
    let pendingByteRange = null;
    let lastByteEnd = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = parseInt(line.split(":")[1], 10) || 0;
        segIndex = mediaSequence;
      } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
        media.targetDuration = parseInt(line.split(":")[1], 10) || 0;
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const a = parseAttributes(line.slice("#EXT-X-MAP:".length));
        if (a.URI) {
          media.map = { uri: resolveUrl(playlistUrl, a.URI) };
          if (a.BYTERANGE) {
            const [len, off] = a.BYTERANGE.split("@");
            media.map.byteRange = { length: parseInt(len, 10), offset: parseInt(off || "0", 10) };
          }
        }
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        const spec = line.slice("#EXT-X-BYTERANGE:".length);
        const [len, off] = spec.split("@");
        const length = parseInt(len, 10);
        const offset = off != null ? parseInt(off, 10) : lastByteEnd;
        pendingByteRange = { length, offset };
        lastByteEnd = offset + length;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const a = parseAttributes(line.slice("#EXT-X-KEY:".length));
        if (a.METHOD === "NONE") {
          currentKey = null;
        } else {
          currentKey = {
            method: a.METHOD,
            uri: a.URI ? resolveUrl(playlistUrl, a.URI) : null,
            iv: a.IV || null,
            keyFormat: a.KEYFORMAT || "identity",
          };
          media.encryption = currentKey;
        }
      } else if (line.startsWith("#EXTINF:")) {
        pendingDuration = parseFloat(line.slice("#EXTINF:".length).split(",")[0]) || 0;
      } else if (!line.startsWith("#")) {
        media.segments.push({
          uri: resolveUrl(playlistUrl, line),
          duration: pendingDuration,
          key: currentKey,
          seq: segIndex,
          byteRange: pendingByteRange,
        });
        pendingDuration = 0;
        pendingByteRange = null;
        segIndex++;
      }
    }
    return media;
  }

  // ---- Decryption (clear-key AES-128-CBC only) ----

  function hexToBytes(hex) {
    hex = hex.replace(/^0x/i, "");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function seqToIv(seq) {
    // Default IV = 16-byte big-endian media sequence number.
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(12, seq >>> 0, false);
    return iv;
  }

  async function decryptAes128(cipherBuf, keyBytes, ivBytes) {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: ivBytes },
      key,
      cipherBuf
    );
    return new Uint8Array(plain);
  }

  // ---- Download orchestration ----
  // fetchFn(url) must return a Promise<ArrayBuffer>. The background page
  // supplies one that injects Referer/cookies for the origin.

  async function downloadMedia(media, opts) {
    opts = opts || {};
    const fetchFn = opts.fetchFn;
    const concurrency = opts.concurrency || 6;
    const onProgress = opts.onProgress || function () {};
    const shouldAbort = opts.shouldAbort || (() => false);

    if (media.isLive && !opts.allowLive) {
      throw new Error("This is a live stream — only a fixed recording window can be captured, not the whole broadcast.");
    }
    if (media.encryption && media.encryption.method !== "AES-128") {
      throw new Error(
        "Stream uses " + media.encryption.method + " (protected content). This tool only supports open, unencrypted or clear AES-128 HLS."
      );
    }
    if (media.encryption && media.encryption.keyFormat && media.encryption.keyFormat !== "identity") {
      throw new Error("Stream uses a DRM key system (" + media.encryption.keyFormat + "). Not supported.");
    }

    const parts = [];
    if (media.map) parts.push({ uri: media.map.uri, key: null, isInit: true, seq: -1, byteRange: media.map.byteRange || null });
    for (const s of media.segments) parts.push(s);

    const total = parts.length;
    const results = new Array(total);
    const keyCache = {};
    let done = 0;
    let bytesDone = 0;
    let nextIndex = 0;
    let aborted = false;

    function rangeHeader(br) {
      if (!br) return null;
      return "bytes=" + br.offset + "-" + (br.offset + br.length - 1);
    }

    async function getKey(keyInfo) {
      if (keyCache[keyInfo.uri]) return keyCache[keyInfo.uri];
      const buf = await fetchFn(keyInfo.uri);
      const bytes = new Uint8Array(buf);
      keyCache[keyInfo.uri] = bytes;
      return bytes;
    }

    async function worker() {
      while (true) {
        if (aborted || shouldAbort()) {
          aborted = true;
          return;
        }
        const idx = nextIndex++;
        if (idx >= total) return;
        const part = parts[idx];

        let buf;
        try {
          const range = rangeHeader(part.byteRange);
          buf = await fetchFn(part.uri, range ? { range } : undefined);
        } catch (e) {
          throw new Error("Failed to fetch segment " + idx + ": " + e.message);
        }

        let bytes = new Uint8Array(buf);
        if (part.key && part.key.method === "AES-128") {
          const keyBytes = await getKey(part.key);
          const iv = part.key.iv ? hexToBytes(part.key.iv) : seqToIv(part.seq);
          bytes = await decryptAes128(buf, keyBytes, iv);
        }
        results[idx] = bytes;
        done++;
        bytesDone += (buf && buf.byteLength) || bytes.length;
        onProgress({ done, total, bytes: bytesDone });
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, total); i++) workers.push(worker());
    await Promise.all(workers);

    if (aborted) throw new Error("Download cancelled.");

    // Concatenate.
    let size = 0;
    for (const r of results) size += r ? r.length : 0;
    const out = new Uint8Array(size);
    let off = 0;
    for (const r of results) {
      if (!r) continue;
      out.set(r, off);
      off += r.length;
    }

    let ext = media.map ? "mp4" : "ts";
    let mime = media.map ? "video/mp4" : "video/mp2t";
    if (opts.containerHint === "mp4") { ext = "mp4"; mime = "video/mp4"; }
    else if (opts.containerHint === "m4a") { ext = "m4a"; mime = "audio/mp4"; }
    else if (opts.containerHint === "aac") { ext = "aac"; mime = "audio/aac"; }
    return { data: out, ext, mime };
  }

  // ---- fMP4 timeline reset ----
  // A recording started mid-broadcast inherits the broadcast's absolute
  // timeline: each fMP4 fragment's tfdt.baseMediaDecodeTime is the time since
  // the show began, so a 7-minute clip that begins 2h in reports a 2h07m
  // duration and the seek bar starts at 2h. Subtract the first fragment's
  // decode time from every fragment so the file starts at 0. TS segments have
  // no tfdt (their PTS lives in PES headers) and are left to the ffmpeg remux.
  function fourcc(buf, p) {
    return String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
  }
  function resetFmp4Timeline(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const tfdts = [];
    // Descend only into moof→traf to reach tfdt; skip ftyp/moov/mdat.
    function walk(start, end) {
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p);
        const type = fourcc(buf, p + 4);
        let header = 8;
        if (size === 1) { size = Number(dv.getBigUint64(p + 8)); header = 16; }
        else if (size === 0) { size = end - p; }
        if (size < header || p + size > end) break; // malformed — stop
        if (type === "moof" || type === "traf") walk(p + header, p + size);
        else if (type === "tfdt") tfdts.push({ ver: buf[p + header], at: p + header + 4 });
        p += size;
      }
    }
    walk(0, buf.length);
    if (!tfdts.length) return buf;

    const read = (t) => (t.ver === 1 ? dv.getBigUint64(t.at) : BigInt(dv.getUint32(t.at)));
    let min = null;
    for (const t of tfdts) { const v = read(t); if (min === null || v < min) min = v; }
    if (min === null || min === 0n) return buf;
    for (const t of tfdts) {
      const nv = read(t) - min;
      if (t.ver === 1) dv.setBigUint64(t.at, nv);
      else dv.setUint32(t.at, Number(nv) >>> 0);
    }
    return buf;
  }

  // ---- Live recording ----
  // A live HLS media playlist is a sliding window: it lists only the last few
  // segments and is rewritten every few seconds as new ones arrive. To record
  // it we re-fetch the *playlist* on a timer and append segments we haven't seen
  // (identified by their media-sequence number), buffering everything in memory
  // until the user stops or the broadcast ends (#EXT-X-ENDLIST appears).
  //
  // opts.fetchFn(url, {range})   -> Promise<ArrayBuffer>  (segments / keys)
  // opts.fetchText(url)          -> Promise<string>       (the playlist)
  // opts.onProgress({segments,bytes,duration})
  // opts.shouldStop()  -> true to finish and SAVE what we have
  // opts.shouldAbort() -> true to discard and throw
  async function recordLive(playlistUrl, opts) {
    opts = opts || {};
    const fetchFn = opts.fetchFn;
    const fetchText = opts.fetchText;
    const onProgress = opts.onProgress || function () {};
    const shouldStop = opts.shouldStop || (() => false);
    const shouldAbort = opts.shouldAbort || (() => false);

    const seen = new Set();     // media-sequence numbers already captured
    const chunks = [];          // ordered byte buffers
    const keyCache = {};
    let bytes = 0;
    let duration = 0;
    let mapWritten = false;
    let ext = "ts";
    let mime = "video/mp2t";
    let firstPass = true;

    async function getKey(uri) {
      if (keyCache[uri]) return keyCache[uri];
      const b = new Uint8Array(await fetchFn(uri));
      keyCache[uri] = b;
      return b;
    }

    function rangeOpt(br) {
      if (!br) return undefined;
      return { range: "bytes=" + br.offset + "-" + (br.offset + br.length - 1) };
    }

    // Sleep in short slices so Stop/Abort feel responsive.
    async function nap(ms) {
      const step = 250;
      for (let waited = 0; waited < ms; waited += step) {
        if (shouldStop() || shouldAbort()) return;
        await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
      }
    }

    while (true) {
      if (shouldAbort()) throw new Error("Recording cancelled.");

      let media = null;
      try {
        const text = await fetchText(playlistUrl);
        media = parsePlaylist(text, playlistUrl);
      } catch (e) {
        if (firstPass) throw e;      // can't even start — surface it
        await nap(1500);             // transient refresh error — retry
        continue;
      }

      if (media && media.type === "media") {
        if (media.encryption && media.encryption.method !== "AES-128") {
          throw new Error(
            "Stream uses " + media.encryption.method + " (protected content). Live recording supports open or clear AES-128 HLS only."
          );
        }
        if (media.encryption && media.encryption.keyFormat && media.encryption.keyFormat !== "identity") {
          throw new Error("Stream uses a DRM key system (" + media.encryption.keyFormat + "). Not supported.");
        }

        // fMP4 init segment — needed once, before any media segment.
        if (media.map && !mapWritten) {
          const b = new Uint8Array(await fetchFn(media.map.uri, rangeOpt(media.map.byteRange)));
          chunks.push(b);
          bytes += b.length;
          mapWritten = true;
          ext = "mp4";
          mime = "video/mp4";
        }

        for (const seg of media.segments) {
          if (shouldAbort()) throw new Error("Recording cancelled.");
          if (seen.has(seg.seq)) continue;
          seen.add(seg.seq);

          let b;
          try {
            b = new Uint8Array(await fetchFn(seg.uri, rangeOpt(seg.byteRange)));
          } catch (e) {
            seen.delete(seg.seq); // let a later refresh retry it while still in-window
            continue;
          }

          if (seg.key && seg.key.method === "AES-128") {
            const keyBytes = await getKey(seg.key.uri);
            const iv = seg.key.iv ? hexToBytes(seg.key.iv) : seqToIv(seg.seq);
            b = await decryptAes128(b, keyBytes, iv);
          }

          chunks.push(b);
          bytes += b.length;
          duration += seg.duration || 0;
          onProgress({ segments: seen.size, bytes, duration });
        }

        firstPass = false;
        if (!media.isLive) break;      // #EXT-X-ENDLIST — broadcast ended
      }

      if (shouldStop()) break;

      // Poll roughly once per segment; clamp to a sane 1–6s.
      const td = media && media.targetDuration ? media.targetDuration : 2;
      await nap(Math.min(6, Math.max(1, td)) * 1000);
    }

    let size = 0;
    for (const c of chunks) size += c.length;
    let out = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }

    // fMP4 (has an init segment): rebase the timeline to zero so a mid-stream
    // recording reports its true length, not the broadcast's elapsed time.
    let tsReset = false;
    if (mapWritten) {
      try { out = resetFmp4Timeline(out); tsReset = true; } catch (e) { /* leave as-is */ }
    }
    return { data: out, ext, mime, bytes: size, duration, segments: seen.size, container: ext, tsReset };
  }

  global.HLS = {
    resolveUrl,
    parsePlaylist,
    downloadMedia,
    recordLive,
    resetFmp4Timeline,
  };
})(typeof self !== "undefined" ? self : this);
