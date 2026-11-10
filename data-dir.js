// Where the server keeps the data it saves while running: uploaded social figures, Meta history,
// the publications list and saved reports.
//
// By default these stay where they always were, next to the code. Set DATA_DIR in .env (or on the
// host) to keep them somewhere else, e.g. a persistent disk, so a redeploy can't wipe them.
// The first time DATA_DIR is used, anything already saved next to the code is copied across.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;

// name: the file or folder name inside DATA_DIR. defaultPath: where it lives when DATA_DIR isn't set.
function dataPath(name, defaultPath) {
  if (!DATA_DIR) return defaultPath;
  const target = path.join(DATA_DIR, name);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(target) && fs.existsSync(defaultPath)) {
      fs.cpSync(defaultPath, target, { recursive: true });
      console.log(`Copied ${name} into ${DATA_DIR}`);
    }
  } catch (error) {
    console.warn(`Could not prepare ${name} in ${DATA_DIR}:`, error.message);
  }
  return target;
}

module.exports = { DATA_DIR, dataPath };