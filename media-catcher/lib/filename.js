/*
 * filename.js — render output filenames from a template.
 * Tokens: {title} {host} {quality} {height} {date} {time} {ext} {name}
 * Exposed as global `Filename`.
 */
(function (global) {
  "use strict";

  function pad(n) { return String(n).padStart(2, "0"); }

  function sanitize(s) {
    return String(s == null ? "" : s)
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  }

  function render(template, fields) {
    fields = fields || {};
    const now = new Date();
    const map = {
      title: fields.title || "",
      host: fields.host || "",
      quality: fields.quality || "",
      height: fields.height ? fields.height + "p" : "",
      name: fields.name || "",
      ext: fields.ext || "",
      date: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()),
      time: pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()),
    };
    let out = String(template || "{title}")
      .replace(/\{(\w+)\}/g, (m, k) => (k in map ? sanitize(map[k]) : m));
    // Collapse artifacts from empty tokens (e.g. "-" runs, leading/trailing seps).
    out = out.replace(/[-_.\s]{2,}/g, (m) => m[0])
             .replace(/^[-_.\s]+|[-_.\s]+$/g, "")
             .slice(0, 150);
    if (!out) out = sanitize(fields.title) || sanitize(fields.name) || "video";
    return out;
  }

  global.Filename = { render, sanitize };
})(typeof self !== "undefined" ? self : this);
