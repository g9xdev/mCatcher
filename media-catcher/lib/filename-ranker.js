(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.McFilenameRanker = api;
})(
  typeof self !== "undefined" ? self :
  (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";
  function rank() {
    throw new Error("FilenameRanker.rank not implemented");
  }
  return { rank, MEDIA_EXT_RE: /\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|flac|ogg|opus|ts|m2ts|mpeg|mpg)$/i };
});
