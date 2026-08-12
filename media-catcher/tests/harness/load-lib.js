"use strict";
const path = require("node:path");
const mediaCatcherRoot = path.resolve(__dirname, "..", "..");

function loadLib(relFromMediaCatcher) {
  const abs = path.join(mediaCatcherRoot, relFromMediaCatcher);
  delete require.cache[require.resolve(abs)];
  return require(abs);
}

module.exports = { loadLib, mediaCatcherRoot };
