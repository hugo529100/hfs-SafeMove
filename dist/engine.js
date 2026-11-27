'use strict'

// SafeMove transfer engine.
// Pure Node.js (no HFS dependency) so it can be unit-tested on its own.
// The design deliberately mirrors the server's own resumable upload machinery:
//   * write into a temporary file next to the destination volume
//   * remember the byte offset, so an interrupted transfer can continue
//   * only publish the final file with an atomic rename
//   * hash the source and the copy before deleting anything

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')

const COPY_CHUNK = 1024 * 1024       // 1 MiB: fine-grained throttling
const HASH_CHUNK = 4 * 1024 * 1024   // 4 MiB: fewer syscalls while hashing

class CanceledError extends Error {
  constructor() {
    super('canceled')
    this.code = 'SAFEMOVE_CANCELED'
  }
}

class SourceChangedError extends Error {
  constructor() {
    super('source changed during copy')
    this.code = 'SAFEMOVE_SOURCE_CHANGED'
  }
}

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * Copy `size` bytes of `src` into `temp`, starting at `offset`.
 * Maintains a global average of `bytesPerSec` (0 = unlimited).
 */
async function copyInto({ src, temp, offset = 0, size, bytesPerSec = 0, onProgress, shouldStop, chunkSize = COPY_CHUNK }) {
  if (!Number.isFinite(size) || size < 0)
    throw new Error('invalid size')
  const srcFh = await fsp.open(src, 'r')
  let dstFh
  try {
    dstFh = await fsp.open(temp, offset > 0 ? 'r+' : 'w')
    let pos = offset
    const base = offset
    const t0 = Date.now()
    let lastT = t0
    let lastPos = pos
    let speed = 0
    const buf = Buffer.allocUnsafe(chunkSize)
    while (pos < size) {
      if (shouldStop?.())
        throw new CanceledError()
      const len = Math.min(chunkSize, size - pos)
      const { bytesRead } = await srcFh.read(buf, 0, len, pos)
      if (!bytesRead)
        throw new Error('unexpected end of source')
      await dstFh.write(buf, 0, bytesRead, pos)
      pos += bytesRead
      if (bytesPerSec > 0) {
        const due = (pos - base) / bytesPerSec * 1000
        const elapsed = Date.now() - t0
        if (due > elapsed)
          await sleep(due - elapsed)
      }
      const now = Date.now()
      if (now - lastT >= 500) {
        speed = Math.max(0, (pos - lastPos) * 1000 / (now - lastT))
        lastT = now
        lastPos = pos
        onProgress?.({ copied: pos, size, speed })
      }
    }
    try { await dstFh.sync() } catch { /* some network shares reject fsync */ }
    onProgress?.({ copied: pos, size, speed: 0 })
    return { copied: pos }
  }
  finally {
    await dstFh?.close().catch(() => {})
    await srcFh.close().catch(() => {})
  }
}

/**
 * Hash a file with the requested algorithm. `size` is a cheap mode that only
 * reports the byte count and lets the final comparison check lengths.
 */
async function hashFile({ file, algo = 'sha256', bytesPerSec = 0, onProgress, shouldStop, chunkSize = HASH_CHUNK }) {
  const st = await fsp.stat(file)
  if (algo === 'size')
    return { hash: `size:${st.size}`, size: st.size }
  const hasher = crypto.createHash(algo)
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(chunkSize)
    let pos = 0
    const t0 = Date.now()
    let lastT = t0
    let lastPos = 0
    let speed = 0
    while (pos < st.size) {
      if (shouldStop?.())
        throw new CanceledError()
      const len = Math.min(chunkSize, st.size - pos)
      const { bytesRead } = await fh.read(buf, 0, len, pos)
      if (!bytesRead)
        break
      hasher.update(buf.subarray(0, bytesRead))
      pos += bytesRead
      if (bytesPerSec > 0) {
        const due = pos / bytesPerSec * 1000
        const elapsed = Date.now() - t0
        if (due > elapsed)
          await sleep(due - elapsed)
      }
      const now = Date.now()
      if (now - lastT >= 500) {
        speed = Math.max(0, (pos - lastPos) * 1000 / (now - lastT))
        lastT = now
        lastPos = pos
        onProgress?.({ done: pos, size: st.size, speed })
      }
    }
    onProgress?.({ done: pos, size: st.size, speed: 0 })
    return { hash: hasher.digest('hex'), size: st.size }
  }
  finally {
    await fh.close().catch(() => {})
  }
}

/** Return a non-existing name in `dir`, based on `name` ("x.txt" -> "x (1).txt"). */
function uniqueName(dir, name, exists = fs.existsSync) {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!exists(path.join(dir, candidate)))
      return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

async function renameWithRetry(from, to, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to)
    }
    catch (e) {
      const retryable = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')
      if (!retryable || i >= attempts)
        throw e
      await sleep(150 + i * 150)
    }
  }
}

module.exports = {
  COPY_CHUNK,
  HASH_CHUNK,
  CanceledError,
  SourceChangedError,
  copyInto,
  hashFile,
  uniqueName,
  renameWithRetry,
  sleep,
}
