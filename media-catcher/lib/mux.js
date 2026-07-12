/*
 * mux.js — combine a separate video fMP4 and audio fMP4 (CMAF, as split-track
 * LL-HLS delivers) into ONE playable two-track MP4, entirely in the browser.
 *
 * Both inputs are fragmented MP4: [ftyp][moov(1 trak)][ (styp?) moof mdat ]…
 * We build a new moov that carries BOTH traks (renumbering the audio track so
 * its id can't collide with the video track), rewrite the audio fragments'
 * tfhd track_IDs to match, then concatenate video fragments + audio fragments.
 * Each input's fragment timeline was already rebased to 0 by recordLive, so the
 * two tracks stay in sync.
 *
 * combineFmp4() throws on anything it doesn't understand; callers fall back to
 * saving the two files plus an ffmpeg merge command.
 *
 * Exposed as global `Mux`.
 */
(function (global) {
  "use strict";

  function dvOf(buf) { return new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  function typeAt(buf, p) { return String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]); }
  function getU32(buf, off) { return dvOf(buf).getUint32(off); }
  function setU32(buf, off, val) { dvOf(buf).setUint32(off, val >>> 0); }

  // Enumerate boxes in [start, end). Each: {type, start, size, hdr, dataStart, dataEnd}.
  function boxes(buf, start, end) {
    const dv = dvOf(buf);
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
      else if (size === 0) { size = end - p; }
      if (size < hdr || p + size > end) break;
      out.push({ type: typeAt(buf, p + 4), start: p, size: size, hdr: hdr, dataStart: p + hdr, dataEnd: p + size });
      p += size;
    }
    return out;
  }
  function find(buf, start, end, type) {
    for (const b of boxes(buf, start, end)) if (b.type === type) return b;
    return null;
  }
  function raw(buf, b) { return buf.subarray(b.start, b.start + b.size); }        // view
  function rawCopy(buf, b) { return buf.slice(b.start, b.start + b.size); }        // owned copy

  function makeBox(type, parts) {
    let len = 0;
    for (const a of parts) len += a.length;
    const total = 8 + len;
    const b = new Uint8Array(total);
    dvOf(b).setUint32(0, total);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const a of parts) { b.set(a, o); o += a.length; }
    return b;
  }
  function concat(arrs) {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }

  // {ftyp, moov, mediaStart} — mediaStart is the first byte after moov.
  function splitInit(buf) {
    let ftyp = null, moov = null;
    for (const b of boxes(buf, 0, buf.length)) {
      if (b.type === "ftyp") ftyp = b;
      else if (b.type === "moov") { moov = b; return { ftyp, moov, mediaStart: b.dataEnd }; }
    }
    throw new Error("no moov (not fMP4)");
  }

  // Byte offset of track_ID within a tkhd box (depends on its version).
  function tkhdTrackIdOffset(buf, tkhd) {
    const ver = buf[tkhd.dataStart];              // version byte
    return tkhd.dataStart + 4 + (ver === 1 ? 16 : 8); // +flags(4) +creation/modification
  }

  // Rewrite every moof→traf→tfhd track_ID in a media byte range (in place).
  function rewriteFragmentTrackIds(media, newId) {
    for (const b of boxes(media, 0, media.length)) {
      if (b.type !== "moof") continue;
      for (const t of boxes(media, b.dataStart, b.dataEnd)) {
        if (t.type !== "traf") continue;
        const tfhd = find(media, t.dataStart, t.dataEnd, "tfhd");
        if (tfhd) setU32(media, tfhd.dataStart + 4, newId); // track_ID after version/flags
      }
    }
  }

  function combineFmp4(video, audio) {
    const V = splitInit(video);
    const A = splitInit(audio);
    if (!V.ftyp) throw new Error("video has no ftyp");

    const vMoov = V.moov, aMoov = A.moov;
    const mvhd = find(video, vMoov.dataStart, vMoov.dataEnd, "mvhd");
    const vTrak = find(video, vMoov.dataStart, vMoov.dataEnd, "trak");
    const vMvex = find(video, vMoov.dataStart, vMoov.dataEnd, "mvex");
    const aTrak = find(audio, aMoov.dataStart, aMoov.dataEnd, "trak");
    const aMvex = find(audio, aMoov.dataStart, aMoov.dataEnd, "mvex");
    if (!mvhd || !vTrak || !vMvex || !aTrak || !aMvex) throw new Error("moov missing mvhd/trak/mvex");

    const vTkhd = find(video, vTrak.dataStart, vTrak.dataEnd, "tkhd");
    const vTrex = find(video, vMvex.dataStart, vMvex.dataEnd, "trex");
    const aTrex = find(audio, aMvex.dataStart, aMvex.dataEnd, "trex");
    if (!vTkhd || !vTrex || !aTrex) throw new Error("moov missing tkhd/trex");

    const vId = getU32(video, tkhdTrackIdOffset(video, vTkhd));
    const newAId = vId === 1 ? 2 : 1;   // guarantee distinct from the video track

    // Audio trak: copy and renumber its tkhd track_ID.
    const aTrakBytes = rawCopy(audio, aTrak);
    const aTkhd = find(aTrakBytes, 8, aTrakBytes.length, "tkhd");
    if (!aTkhd) throw new Error("audio trak has no tkhd");
    setU32(aTrakBytes, tkhdTrackIdOffset(aTrakBytes, aTkhd), newAId);

    // Audio trex: copy and renumber its track_ID (payload+4).
    const aTrexBytes = rawCopy(audio, aTrex);
    setU32(aTrexBytes, 8 + 4, newAId);

    // New mvex = [mehd?] + video trex + audio trex.
    const vMehd = find(video, vMvex.dataStart, vMvex.dataEnd, "mehd");
    const mvexParts = [];
    if (vMehd) mvexParts.push(raw(video, vMehd));
    mvexParts.push(raw(video, vTrex));
    mvexParts.push(aTrexBytes);
    const newMvex = makeBox("mvex", mvexParts);

    // mvhd: bump next_track_ID (last u32 of the box).
    const mvhdBytes = rawCopy(video, mvhd);
    setU32(mvhdBytes, mvhdBytes.length - 4, Math.max(vId, newAId) + 1);

    const newMoov = makeBox("moov", [mvhdBytes, raw(video, vTrak), aTrakBytes, newMvex]);

    // Media fragments. Audio gets its fragment track_IDs renumbered to match.
    const vMedia = video.subarray(V.mediaStart);
    const aMedia = audio.slice(A.mediaStart);   // owned copy so we can rewrite
    rewriteFragmentTrackIds(aMedia, newAId);

    const out = concat([raw(video, V.ftyp), newMoov, vMedia, aMedia]);
    validate(out, vId, newAId);
    return out;
  }

  // Structural sanity check — cheap insurance that we produced a two-track file.
  function validate(out, vId, aId) {
    const { moov } = splitInit(out);
    const traks = boxes(out, moov.dataStart, moov.dataEnd).filter((b) => b.type === "trak");
    if (traks.length !== 2) throw new Error("expected 2 traks, got " + traks.length);
    const mvex = find(out, moov.dataStart, moov.dataEnd, "mvex");
    const trex = mvex ? boxes(out, mvex.dataStart, mvex.dataEnd).filter((b) => b.type === "trex") : [];
    if (trex.length !== 2) throw new Error("expected 2 trex, got " + trex.length);
    const ids = traks.map((tk) => {
      const h = find(out, tk.dataStart, tk.dataEnd, "tkhd");
      return getU32(out, tkhdTrackIdOffset(out, h));
    });
    if (ids[0] === ids[1]) throw new Error("track ids collide");
    if (ids.indexOf(vId) < 0 || ids.indexOf(aId) < 0) throw new Error("track ids unexpected");
  }

  global.Mux = { combineFmp4 };
})(typeof self !== "undefined" ? self : this);
