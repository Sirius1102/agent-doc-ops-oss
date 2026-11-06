// test/fake-officecli.js -- selftest only. Loaded into the child dockit process via
// NODE_OPTIONS=--require=...; turns calls to DOCKIT_OFFICECLI into "success but no bytes changed".
// The point: exercise edit's zero-change gate without depending on a real write backend.
'use strict';
const cp = require('node:child_process');
const realSpawnSync = cp.spawnSync;
cp.spawnSync = function (exe, args, opts) {
  if (process.env.DOCKIT_FAKE_OFFICECLI === '1'
    && String(exe).toLowerCase() === String(process.env.DOCKIT_FAKE_OFFICECLI_EXE || '').toLowerCase()) {
    const a = Array.isArray(args) ? args : [];
    if (a[0] === '--version') return { status: 0, stdout: 'fake-officecli 0.0.1\n', stderr: '' };
    return { status: 0, stdout: JSON.stringify({ success: true, data: {} }), stderr: '' };
  }
  return realSpawnSync.call(this, exe, args, opts);
};
