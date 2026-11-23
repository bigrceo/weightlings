// The rules in force. Each version of the hourly cull is one frozen file: /cull.v1.js, /cull.v2.js, …
// A round's record names the version it was run with, and (from version 2) its commitment carries the SHA-256 of that file.
// This file only points at the current version; the server imports it, and /verify loads the versioned file a record names.
export * from './cull.v2.js';
