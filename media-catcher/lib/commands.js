/*
 * commands.js — build ready-to-run download commands for external tools,
 * carrying the Referer / User-Agent captured from the page. This is the
 * reliable path for anything the in-browser engine won't do (separate-audio
 * muxing, clean remux, DASH, DRM-free live you're entitled to record).
 *
 * Exposed as global `Commands`.
 */
(function (global) {
  "use strict";

  // Single-quote a value for POSIX shells, escaping embedded quotes.
  function sq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function safeOut(name, ext) {
    const base = (name || "video")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "video";
    return base + "." + (ext || "mp4");
  }

  function ytdlp(url, opts) {
    opts = opts || {};
    const parts = ["yt-dlp"];
    // Pull cookies straight from the browser session for gated content.
    if (opts.cookiesFromBrowser !== false) parts.push("--cookies-from-browser", "firefox");
    if (opts.referer) parts.push("--referer", sq(opts.referer));
    if (opts.userAgent) parts.push("--user-agent", sq(opts.userAgent));
    // Prefer best video+audio merged to mp4 (yt-dlp muxes for you).
    parts.push("-f", sq("bv*+ba/b"), "--merge-output-format", "mp4");
    if (opts.output) parts.push("-o", sq(safeOut(opts.output, "%(ext)s").replace(/\.%\(ext\)s$/, ".%(ext)s")));
    parts.push(sq(url));
    return parts.join(" ");
  }

  function ffmpeg(url, opts) {
    opts = opts || {};
    const headerLines = [];
    if (opts.referer) headerLines.push("Referer: " + opts.referer);
    if (opts.userAgent) headerLines.push("User-Agent: " + opts.userAgent);
    const parts = ["ffmpeg"];
    if (headerLines.length) parts.push("-headers", sq(headerLines.join("\r\n") + "\r\n"));
    parts.push("-i", sq(url), "-c", "copy", sq(safeOut(opts.output, opts.ext || "mp4")));
    return parts.join(" ");
  }

  // Remux a local .ts capture into .mp4. MPEG-TS timestamps start at the
  // broadcast's elapsed time, so a mid-stream capture reports a bogus (hours-
  // long) duration; muxing to MP4 rebuilds the duration from sample counts and
  // faststart makes it seekable.
  function ffmpegRemux(inputFile, output) {
    return [
      "ffmpeg",
      "-fflags", "+genpts",
      "-i", sq(inputFile),
      "-c", "copy",
      "-movflags", "+faststart",
      sq(safeOut(output, "mp4")),
    ].join(" ");
  }

  // ffmpeg command to merge a separately-downloaded video + audio file.
  function ffmpegMerge(videoFile, audioFile, output) {
    return [
      "ffmpeg",
      "-i", sq(videoFile),
      "-i", sq(audioFile),
      "-c", "copy",
      sq(safeOut(output, "mp4")),
    ].join(" ");
  }

  function streamlink(url, opts) {
    opts = opts || {};
    const parts = ["streamlink"];
    if (opts.referer) parts.push("--http-header", sq("Referer=" + opts.referer));
    if (opts.userAgent) parts.push("--http-header", sq("User-Agent=" + opts.userAgent));
    parts.push(sq(url), "best", "-o", sq(safeOut(opts.output, opts.ext || "mp4")));
    return parts.join(" ");
  }

  function build(tool, url, opts) {
    switch (tool) {
      case "yt-dlp": return ytdlp(url, opts);
      case "ffmpeg": return ffmpeg(url, opts);
      case "streamlink": return streamlink(url, opts);
      default: return url;
    }
  }

  global.Commands = { build, ytdlp, ffmpeg, ffmpegMerge, ffmpegRemux, streamlink, safeOut };
})(typeof self !== "undefined" ? self : this);
