'use strict'

// SafeMove - cross-disk large-file migration engine for HFS 3
//
// It hooks the stock `move_files` API only when at least one selected file is
// both large and located on a different volume than the destination. Those
// files are copied by a persistent server-side queue (resumable, throttled,
// hash-verified). Everything else is handed back to the native HFS code path,
// untouched, so same-disk renames stay instantaneous.

exports.version = 2.0
exports.description = "SafeMove: account-isolated, resumable migration of large files across volumes. Queues large HFS move/copy jobs with configurable parallelism (one at a time by default), throttling and hash verification, visible only to the owning account; same-disk and small operations stay native."
exports.apiRequired = 13.73
exports.repo = "hugo529100/hfs-SafeMove"
exports.frontend_js = ["main.js"]
exports.frontend_css = ["style.css"]

// Clipboard-Sync calls this when both plugins are installed. The real
// implementation is bound inside init(); before that it resolves to undefined,
// which tells the caller to use the native moveFiles path.
let smartTransferImpl
exports.customApi = {
    safemove_move: (uris, to, ctx) => smartTransferImpl?.('move', uris, to, ctx),
    safemove_copy: (uris, to, ctx) => smartTransferImpl?.('copy', uris, to, ctx),
    // Aliases kept for Clipboard-Sync 2.1 and pages that cached the old name.
    fastmove_move: (uris, to, ctx) => smartTransferImpl?.('move', uris, to, ctx),
    fastmove_copy: (uris, to, ctx) => smartTransferImpl?.('copy', uris, to, ctx),
}

exports.config = {
    enabled: {
        type: 'boolean',
        defaultValue: true,
        label: "Enable SafeMove",
        helperText: "When off, every move is handled by the stock HFS path.",
    },
    thresholdMb: {
        type: 'number',
        defaultValue: 50,
        min: 0,
        max: 1048576,
        label: "Large-file threshold (MB)",
        helperText: "Files at least this large, moving to a different volume, are handled by SafeMove.",
    },
    speedMb: {
        type: 'number',
        defaultValue: 0,
        min: 0,
        max: 102400,
        label: "Migration speed limit (MB/s)",
        helperText: "0 = unlimited. Keeps disk load predictable; the live panel shows the actual transfer speed.",
    },
    parallelJobs: {
        type: 'number',
        defaultValue: 1,
        min: 1,
        max: 16,
        label: "Parallel transfers",
        helperText: "Default 1: one file at a time. Higher values run multiple cross-volume jobs concurrently and increase disk load.",
    },
    verifyMb: {
        type: 'number',
        defaultValue: 0,
        min: 0,
        max: 102400,
        label: "Verification speed limit (MB/s)",
        helperText: "0 = unlimited. Hashing reads both files once; set a limit if the server must stay quiet.",
    },
    partialSuffix: {
        type: 'string',
        defaultValue: '.part',
        label: "Incomplete suffix",
        helperText: "The final file is renamed without this suffix only after the hash check passes.",
    },
    hashAlgo: {
        type: 'select',
        options: {
            'SHA-256': 'sha256',
            'MD5': 'md5',
            'Size only (fastest)': 'size',
        },
        defaultValue: 'sha256',
        label: "Integrity check",
        helperText: "Source and copy are hashed after the transfer. 'Size only' compares lengths instead.",
    },
    maxRetries: {
        type: 'number',
        defaultValue: 3,
        min: 0,
        max: 50,
        label: "Automatic retries",
        helperText: "Failed chunks are resumed; if the error persists the row offers Retry / Skip / Stop.",
    },
    retryDelaySec: {
        type: 'number',
        defaultValue: 5,
        min: 1,
        max: 600,
        label: "Retry delay (seconds)",
        helperText: "Delay is multiplied by the attempt number, up to 5x.",
    },
    conflict: {
        type: 'select',
        options: {
            'Ask with buttons': 'ask',
            'Overwrite': 'overwrite',
            'Rename': 'rename',
            'Skip': 'skip',
        },
        defaultValue: 'ask',
        label: "When destination exists",
        helperText: "Ask shows Overwrite / Rename / Skip buttons in the progress row.",
    },
    keepDoneSec: {
        type: 'number',
        defaultValue: 3,
        min: 3,
        max: 300,
        label: "Keep completed row (seconds)",
        helperText: "How long the integrity result stays visible before the row disappears.",
    },

}

exports.init = async api => {
    const fsp = api.require('fs/promises')
    const fs = api.require('fs')
    const path = api.require('path')
    const crypto = api.require('crypto')
    const engine = require('./engine')

    const { urlToNode, nodeIsFolder, getVirtualName, statusCodeForMissingPerm, isSameFilePath, hasPermission } = api.require('./vfs')
    const { pathEncode, pathDecode, moveStoredFileAttrs, join: joinVfs } = api.require('./misc')
    const frontEndApis = api.require('./frontEndApis')
    const { moveFiles } = frontEndApis
    const nativeCopyFiles = frontEndApis.copy_files

    let optional = {}
    try { optional.upload = api.require('./upload') } catch {}
    try { optional.uploadOwners = api.require('./uploadOwners') } catch {}
    try { optional.webdav = api.require('./webdav') } catch {}
    try { optional.admin = api.require('./adminApis') } catch {}

    const MB = 1024 * 1024
    const API_URI = api.Const?.API_URI || '/~/api/'
    const ACTIVE = new Set(['queued', 'running', 'verifying', 'waiting', 'paused', 'interrupted'])
    const CHANNEL_PREFIX = 'safemove:'
    const MAX_JOBS_PER_USER = 60

    const storageDir = api.storageDir || path.join(__dirname, 'storage')
    await fsp.mkdir(storageDir, { recursive: true }).catch(() => {})
    const jobsFile = path.join(storageDir, 'jobs.json')

    const jobs = new Map()
    const active = new Map()
    let secret = Buffer.alloc(0)
    let stopping = false
    let saveTimer = null
    let saveChain = Promise.resolve()
    let tickTimer = null
    let notifySeq = 0

    try {
        secret = await fsp.readFile(path.join(storageDir, 'channel.key'))
    }
    catch {
        secret = crypto.randomBytes(32)
        await fsp.writeFile(path.join(storageDir, 'channel.key'), secret, { mode: 0o600 }).catch(() => {})
    }

    await loadJobs()



    // ---------------------------------------------------------------- config

    function num(key, fallback) {
        const value = Number(api.getConfig(key))
        return Number.isFinite(value) ? value : fallback
    }

    const thresholdBytes = () => Math.max(0, num('thresholdMb', 50)) * MB
    const copyRate = () => Math.max(0, num('speedMb', 0)) * MB
    const partialSuffix = () => {
        const raw = String(api.getConfig('partialSuffix') || '.part')
            .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '')
            .replace(/[ .]+$/, '')
            .slice(0, 40)
        return raw || '.part'
    }
    const verifyRate = () => Math.max(0, num('verifyMb', 0)) * MB
    const keepDoneMs = () => Math.max(3, num('keepDoneSec', 3)) * 1000
    const algo = () => {
        const value = api.getConfig('hashAlgo')
        return value === 'md5' || value === 'size' ? value : 'sha256'
    }
    // Test-only escape hatch for single-disk development machines. It is not
    // exposed in plugin settings; production calls only enter for real cross-volume moves.
    const forceCross = () => process.env.SAFEMOVE_TEST_FORCE_CROSS === '1'

    // ------------------------------------------------------------- identity

    function channelFor(username) {
        return CHANNEL_PREFIX + crypto.createHmac('sha256', secret).update(String(username)).digest('hex').slice(0, 40)
    }

    function isAdmin(ctx) {
        try { return Boolean(optional.admin?.ctxAdminAccess?.(ctx)) }
        catch { return false }
    }

    // ----------------------------------------------------------------- jobs

    async function loadJobs() {
        try {
            const raw = JSON.parse(await fsp.readFile(jobsFile, 'utf8'))
            for (const job of Array.isArray(raw?.jobs) ? raw.jobs : []) {
                if (!job || typeof job.id !== 'string' || typeof job.srcPath !== 'string' || typeof job.destPath !== 'string')
                    continue
                // A process that died mid-transfer leaves a resumable temp file.
                // Do not auto-resume: mark it interrupted so the folder prompt can ask.
                if (job.pauseRequested) {
                    job.status = 'paused'
                    job.phase = 'paused'
                    job.speed = 0
                    delete job.pauseRequested
                }
                else if (job.status === 'running' || job.status === 'verifying' || job.phase === 'commit') {
                    job.status = 'interrupted'
                    // finalize means the destination is already published; keep it
                    job.phase = job.phase === 'finalize' ? 'finalize' : 'interrupted'
                    job.speed = 0
                    job.retryAt = null
                }
                if (job.status === 'done' && Date.now() - (job.doneAt || 0) > 300_000)
                    continue
                jobs.set(job.id, job)
            }
        }
        catch { /* first run */ }
    }

    function save() {
        if (saveTimer)
            return
        saveTimer = setTimeout(() => {
            saveTimer = null
            void saveNow()
        }, 400)
    }

    async function saveNow() {
        // Serialize writers: the debounced save and unload() must not race on jobs.json.tmp.
        saveChain = saveChain.then(writeJobs, writeJobs)
        return saveChain
    }

    async function writeJobs() {
        const tmp = jobsFile + '.tmp'
        const data = { version: 1, savedAt: Date.now(), jobs: [...jobs.values()] }
        try {
            await fsp.writeFile(tmp, JSON.stringify(data))
            await engine.renameWithRetry(tmp, jobsFile, 2)
        }
        catch (e) {
        }
    }

    function newId() {
        return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex')
    }

    function publicJob(job, queuePos) {
        const short = value => typeof value === 'string' && value
            ? (value.startsWith('size:') ? value : value.slice(0, 16))
            : undefined
        return {
            id: job.id,
            op: job.op || 'move',
            name: job.name,
            partial: job.tempPath ? path.basename(job.tempPath) : null,
            size: job.size,
            copied: job.copied || 0,
            status: job.status,
            phase: job.phase,
            reason: job.reason,
            error: job.error,
            speed: job.speed || 0,
            verifyBytes: job.verifyBytes || 0,
            verified: job.verified,
            srcHash: short(job.srcHash),
            destHash: short(job.destHash),
            attempts: job.attempts || 0,
            srcUri: job.srcUri,
            destUri: job.destUri,
            srcDir: job.srcDir,
            destDir: job.destFolderUri,
            actions: actionsFor(job),
            queuePos: queuePos || 0,
            retryAt: job.retryAt || null,
            doneAt: job.doneAt || null,
            hideAt: job.hideAt || null,
            resumed: Boolean(job.resumed),
        }
    }

    function actionsFor(job) {
        switch (job.status) {
            case 'waiting': return job.reason === 'conflict'
                ? ['rename', 'skip', ...(job.canOverwrite ? ['overwrite'] : [])]
                : ['retry', 'skip', 'abort']
            case 'failed': return ['retry', 'skip', 'abort']
            case 'paused':
            case 'interrupted': return ['resume', 'abort']
            case 'queued':
            case 'running':
            case 'verifying': return ['pause', 'abort']
            default: return []
        }
    }

    function notify(job) {
        if (!job?.user)
            return
        try { api.notifyClient(channelFor(job.user), 'safemove', { id: job.id, status: job.status }) }
        catch {}
    }

    function notifyProgress(job) {
        const now = Date.now()
        if (now - (job._lastNotify || 0) < 450)
            return
        job._lastNotify = now
        notify(job)
    }

    async function removeTemp(job) {
        if (!job.tempPath)
            return
        await fsp.rm(job.tempPath, { force: true }).catch(() => {})
    }

    async function dropJob(job) {
        job.abort = true
        await removeTemp(job)
        jobs.delete(job.id)
        save()
        notify(job)
    }

    // ------------------------------------------------------------- queueing

    function nextQueued() {
        const now = Date.now()
        let best
        for (const job of jobs.values()) {
            if (job.status !== 'queued')
                continue
            if (job.retryAt && job.retryAt > now)
                continue
            if (!best || job.createdAt < best.createdAt)
                best = job
        }
        return best
    }

    function kick(delay = 0) {
        if (stopping)
            return
        if (delay > 0) {
            setTimeout(() => kick(), delay)
            return
        }
        setTimeout(() => { void pump() }, 5)
    }

    async function pump() {
        if (stopping)
            return
        const limit = Math.max(1, Math.min(16, Math.floor(num('parallelJobs', 1))))
        while (active.size < limit) {
            const job = nextQueued()
            if (!job)
                break
            active.set(job.id, job)
            void runJob(job)
        }
    }

    async function runJob(job) {
        try {
            await execute(job)
        }
        catch (e) {
            await handleFailure(job, e)
        }
        finally {
            active.delete(job.id)
            save()
            kick()
        }
    }

    async function execute(job) {
        // A previous run published the destination but failed to remove the source.
        const finishing = job.phase === 'finalize' && fs.existsSync(job.destPath)
        job.startedAt ||= Date.now()
        job.status = 'running'
        job.phase = finishing ? 'commit' : 'copy'
        job.speed = 0
        job.error = null
        job.abort = false
        delete job.pauseRequested
        delete job.reason
        notify(job)
        if (finishing) {
            await finalize(job)
            return
        }

        const srcStat = await fsp.stat(job.srcPath).catch(() => null)
        if (!srcStat?.isFile())
            throw withCode(new Error('source missing'), 'ENOENT')
        job.srcAtimeMs = srcStat.atimeMs
        job.srcMode = srcStat.mode
        if (srcStat.size !== job.size || !sameMtime(srcStat.mtimeMs, job.srcMtimeMs)) {
            job.size = srcStat.size
            job.srcMtimeMs = srcStat.mtimeMs
            job.copied = 0
            await removeTemp(job)
            job.tempPath = null
        }

        await resolveConflict(job)
        if (job.status !== 'running')
            return

        const temp = await tempPathFor(job)
        let offset = 0
        const tempStat = await fsp.stat(temp).catch(() => null)
        if (tempStat?.size) {
            if (tempStat.size <= job.size)
                offset = tempStat.size
            else {
                await removeTemp(job)
                offset = 0
            }
        }
        job.copied = offset
        job.resumed = offset > 0
        job.tempPath = temp

        // Refuse to "resume" a stale partial copy left by a changed source.
        if (offset > 0 && job.storedMtime && !sameMtime(job.srcMtimeMs, job.storedMtime)) {
            await fsp.rm(temp, { force: true }).catch(() => {})
            job.tempPath = null
            offset = 0
            job.copied = 0
        }
        job.storedMtime = job.srcMtimeMs

        if (offset < job.size) {
            await engine.copyInto({
                src: job.srcPath,
                temp,
                offset,
                size: job.size,
                bytesPerSec: copyRate(),
                onProgress: p => {
                    job.copied = p.copied
                    job.speed = p.speed
                    job.updatedAt = Date.now()
                    notifyProgress(job)
                    save()
                },
                shouldStop: () => job.abort || job.pauseRequested || stopping,
            })
        }
        job.copied = job.size
        job.speed = 0

        const after = await fsp.stat(job.srcPath).catch(() => null)
        if (!after || after.size !== job.size || !sameMtime(after.mtimeMs, job.srcMtimeMs))
            throw withCode(new Error('source changed during copy'), 'SAFEMOVE_SOURCE_CHANGED')

        job.status = 'verifying'
        job.phase = 'verify'
        job.verifyBytes = 0
        notify(job)
        const result = await verify(job, temp)
        job.srcHash = result.srcHash
        job.destHash = result.destHash
        job.verified = result.equal
        if (!result.equal) {
            job.phase = 'verify'
            job.verifyBytes = 0
            job.tempPath = null
            await fsp.rm(temp, { force: true }).catch(() => {})
            job.copied = 0
            throw withCode(new Error('integrity check failed'), 'SAFEMOVE_INTEGRITY')
        }

        if (job.pauseRequested) {
            pauseJob(job)
            return
        }
        await commit(job, temp)
    }

    async function resolveConflict(job) {
        const destStat = await fsp.stat(job.destPath).catch(() => null)
        if (!destStat)
            return
        if (destStat.isDirectory())
            throw withCode(new Error('destination is a folder'), 'EISDIR')
        if (job.overwrite)
            return
        const policy = api.getConfig('conflict') || 'ask'
        if (policy === 'overwrite' && job.canOverwrite) {
            job.overwrite = true
            return
        }
        if (policy === 'rename') {
            applyRename(job)
            return
        }
        job.status = 'waiting'
        job.phase = 'conflict'
        job.reason = 'conflict'
        job.speed = 0
        notify(job)
        save()
    }

    function applyRename(job) {
        const dir = path.dirname(job.destPath)
        const next = engine.uniqueName(dir, path.basename(job.destPath))
        job.name = next
        job.destPath = path.join(dir, next)
        job.destUri = asVfsUri(joinVfs(job.destFolderUri || '/', pathEncode(next)))
        job.overwrite = false
        delete job.reason
        delete job.conflict
    }

    async function verify(job, temp) {
        const stop = () => job.abort || job.pauseRequested || stopping
        const rate = verifyRate()
        const src = await engine.hashFile({
            file: job.srcPath,
            algo: algo(),
            bytesPerSec: rate,
            shouldStop: stop,
            onProgress: p => {
                job.verifyBytes = p.done
                job.verifySpeed = p.speed
                notifyProgress(job)
            },
        })
        const dst = await engine.hashFile({
            file: temp,
            algo: algo(),
            bytesPerSec: rate,
            shouldStop: stop,
            onProgress: p => {
                job.verifyBytes = job.size + p.done
                job.verifySpeed = p.speed
                notifyProgress(job)
            },
        })
        return { srcHash: src.hash, destHash: dst.hash, equal: src.hash === dst.hash }
    }

    async function commit(job, temp) {
        job.phase = 'commit'
        job.status = 'verifying'
        notify(job)
        if (fs.existsSync(job.destPath)) {
            if (job.overwrite)
                await fsp.rm(job.destPath, { force: true })
            else {
                // A new conflict appeared while copying: never clobber it silently.
                applyRename(job)
            }
        }
        await engine.renameWithRetry(temp, job.destPath)
        job.tempPath = null
        // From here on the destination is published; a failure must only retry cleanup.
        job.phase = 'finalize'
        await saveNow()
        // Native rename preserves these; a copy does not, so restore them explicitly.
        if (job.srcAtimeMs || job.srcMtimeMs)
            await fsp.utimes(job.destPath, (job.srcAtimeMs || job.srcMtimeMs) / 1000, job.srcMtimeMs / 1000).catch(() => {})
        if (job.srcMode !== undefined)
            await fsp.chmod(job.destPath, job.srcMode & 0o777).catch(() => {})
        if (job.uploadMeta && optional.upload?.saveUploadMeta) {
            try { await optional.upload.saveUploadMeta(job.destPath, job.uploadMeta) }
            catch {}
        }
        if ((job.op || 'move') === 'move') {
            try { await fsp.rm(job.srcPath, { force: true }) }
            catch (e) {
                if (e.code !== 'ENOENT') {
                    job.phase = 'finalize'
                    throw withCode(e, e.code || 'SAFEMOVE_FINALIZE')
                }
            }
            await finishMetadata(job)
        }
        // copy: keep the source, do not move its attributes/owner.
        job.copied = job.size
        job.speed = 0
        job.status = 'done'
        job.phase = 'done'
        job.doneAt = Date.now()
        job.hideAt = job.doneAt + keepDoneMs()
        job.retryAt = null
        delete job.error
        notify(job)
        save()
        setTimeout(() => {
            if (jobs.get(job.id) === job && job.status === 'done') {
                jobs.delete(job.id)
                save()
            }
        }, Math.max(60_000, keepDoneMs() + 50_000)).unref?.()
    }

    async function finalize(job) {
        try {
            job.status = 'verifying'
            job.phase = 'commit'
            notify(job)
            if (job.uploadMeta && optional.upload?.saveUploadMeta) {
                try { await optional.upload.saveUploadMeta(job.destPath, job.uploadMeta) }
                catch {}
            }
            if ((job.op || 'move') === 'move') {
                await fsp.rm(job.srcPath, { force: true }).catch(e => { if (e.code !== 'ENOENT') throw e })
                await finishMetadata(job)
            }
            job.status = 'done'
            job.phase = 'done'
            job.doneAt = Date.now()
            job.hideAt = job.doneAt + keepDoneMs()
            notify(job)
            save()
        }
        catch (e) {
            job.phase = 'finalize'
            throw e
        }
    }

    async function finishMetadata(job) {
        try { await moveStoredFileAttrs?.(job.srcPath, job.destPath) } catch {}
        try {
            if (job.srcVfs && optional.uploadOwners?.moveUploadOwner)
                await optional.uploadOwners.moveUploadOwner(job.srcVfs, job.destUri, job.destPath)
        }
        catch {}
    }

    function pauseJob(job) {
        job.status = 'paused'
        job.phase = 'paused'
        job.speed = 0
        job.updatedAt = Date.now()
        delete job.pauseRequested
        notify(job)
        save()
    }

    async function handleFailure(job, e) {
        const code = e?.code || ''
        if (job.pauseRequested && !job.abort) {
            pauseJob(job)
            return
        }
        if (job.abort || code === 'SAFEMOVE_CANCELED') {
            // Plugin reload / server shutdown must preserve the partial file for resume.
            if (stopping && !job.canceledByUser) {
                job.status = 'interrupted'
                job.phase = 'interrupted'
                job.speed = 0
                job.abort = false
                save()
                return
            }
            await dropJob(job)
            return
        }
        if (code === 'SAFEMOVE_SOURCE_CHANGED' || code === 'SAFEMOVE_INTEGRITY') {
            await removeTemp(job)
            job.tempPath = null
            job.copied = 0
            job.verifyBytes = 0
        }
        job.attempts = (job.attempts || 0) + 1
        const max = Math.max(0, num('maxRetries', 3))
        const fatal = ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EISDIR'].includes(code)
        const finalizing = job.phase === 'finalize'
        job.speed = 0
        job.error = friendlyError(code)
        if (!fatal && job.attempts <= max) {
            job.status = 'queued'
            job.phase = finalizing ? 'finalize' : 'retry'
            job.retryAt = Date.now() + Math.min(5, job.attempts) * Math.max(1, num('retryDelaySec', 5)) * 1000
        }
        else {
            job.status = 'failed'
            job.phase = finalizing ? 'finalize' : 'failed'
            job.retryAt = null
        }
        notify(job)
        save()
    }

    // --------------------------------------------------------------- temp

    async function tempPathFor(job) {
        if (job.tempPath) {
            await fsp.mkdir(path.dirname(job.tempPath), { recursive: true }).catch(() => {})
            return job.tempPath
        }
        // Deterministic on purpose: after a crash even a rebuilt job can find
        // <final-name>.part in the destination and continue from its size.
        job.tempPath = path.join(path.dirname(job.destPath), path.basename(job.destPath) + partialSuffix())
        return job.tempPath
    }

    // ------------------------------------------------------------ intercept

    async function enqueueFast(uri, ctx, destNode, destDev, op = 'move') {
        if (!uri || typeof uri !== 'string')
            return 400
        const srcNode = await urlToNode(uri, ctx)
        const src = srcNode?.source
        if (!src)
            return 404
        if (nodeIsFolder(srcNode))
            return 405
        if (optional.upload?.isUploading?.(src))
            return 409
        const stat = await fsp.stat(src).catch(() => null)
        if (!stat?.isFile())
            return 404

        const destName = path.basename(src)
        const dest = path.join(destNode.source, destName)
        const visibleName = getVirtualName(destName, destNode, dest)
        const destChild = await urlToNode(pathEncode(visibleName), ctx, destNode, { includeHidden: true })
        const destExists = fs.existsSync(dest)
        if (destExists && (!destChild?.source || !await isSameFilePath(destChild.source, dest)))
            return 403
        if (destChild && statusCodeForMissingPerm(destChild, 'can_delete', ctx))
            return ctx.status >= 400 ? ctx.status : 403
        const destUri = asVfsUri(destChild?.vfsPath || joinVfs(destNode.vfsPath || '/', pathEncode(visibleName)))
        const webdav = optional.webdav
        if (webdav?.getWebdavLockTarget && webdav?.isWebdavLocked) {
            const [destLock, lock] = await Promise.all([
                webdav.getWebdavLockTarget(destUri, dest).catch(() => undefined),
                webdav.getWebdavLockTarget(srcNode.vfsPath, src).catch(() => undefined),
            ])
            if (webdav.isWebdavLocked(destLock, ctx, true) || lock && webdav.isWebdavLocked(lock, ctx, true))
                return ctx.status >= 400 ? ctx.status : 423
        }

        const permError = statusCodeForMissingPerm(srcNode, op === 'copy' ? 'can_read' : 'can_delete', ctx)
        if (permError)
            return permError

        const norm = p => process.platform === 'win32' ? p.toLowerCase() : p
        for (const job of jobs.values()) {
            if (!ACTIVE.has(job.status))
                continue
            if (norm(job.srcPath) === norm(src))
                return 409
            // visible <name>.part is shared by destination, so reject a second
            // writer before it can append to someone else's temp file
            if (job.destPath && norm(job.destPath) === norm(dest))
                return 409
        }

        const user = api.getCurrentUsername(ctx)
        if (!user)
            return 401
        if ([...jobs.values()].filter(j => j.user === user && ACTIVE.has(j.status)).length >= MAX_JOBS_PER_USER)
            return 429

        let overwrite = false
        let waiting = false
        let finalDest = dest
        let finalName = visibleName
        let finalUri = destUri
        let conflict = destExists
        const canOverwrite = !destChild || !statusCodeForMissingPerm(destChild, 'can_delete', ctx)

        if (conflict) {
            const policy = api.getConfig('conflict') || 'ask'
            if (policy === 'skip')
                return undefined
            if (policy === 'overwrite' && canOverwrite)
                overwrite = true
            else if (policy === 'rename') {
                const next = engine.uniqueName(path.dirname(dest), destName)
                finalName = next
                finalDest = path.join(path.dirname(dest), next)
                finalUri = asVfsUri(joinVfs(destNode.vfsPath || '/', pathEncode(next)))
                conflict = false
            }
            else
                waiting = true
        }

        let uploadMeta
        if (optional.upload?.getUploadMeta) {
            try { uploadMeta = await optional.upload.getUploadMeta(src) }
            catch {}
        }
        const job = {
            id: newId(),
            user,
            op: op === 'copy' ? 'copy' : 'move',
            name: finalName,
            srcUri: uri,
            srcPath: src,
            srcVfs: asVfsUri(srcNode.vfsPath),
            srcDir: parentUri(uri),
            srcSize: stat.size,
            srcMtimeMs: stat.mtimeMs,
            size: stat.size,
            destUri: asVfsUri(finalUri),
            destPath: finalDest,
            destFolderUri: asVfsUri(destNode.vfsPath),
            destDir: parentUri(finalUri),
            tempPath: null,
            uploadMeta,
            status: waiting ? 'waiting' : 'queued',
            phase: waiting ? 'conflict' : 'queued',
            reason: waiting ? 'conflict' : undefined,
            conflict,
            canOverwrite,
            overwrite,
            copied: 0,
            attempts: 0,
            verified: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }
        if (waiting)
            job.error = null
        jobs.set(job.id, job)
        notify(job)
        save()
        if (!waiting)
            kick()
        return undefined
    }

    function asVfsUri(uri) {
        if (!uri)
            return '/'
        return uri.startsWith('/') ? uri : '/' + uri
    }

    function parentUri(uri) {
        if (typeof uri !== 'string')
            return '/'
        const value = pathDecode(uri)
        const index = value.lastIndexOf('/')
        return index <= 0 ? '/' : value.slice(0, index + 1)
    }

    function csrfSafe(ctx) {
        if (ctx.get('x-hfs-anti-csrf'))
            return true
        return /^(curl|wget|python|go-|java|axios|postman|httpie|insomnia|bruno)/i.test(ctx.get('user-agent') || '')
    }

    async function nativeCopy(uris, to, ctx) {
        if (typeof nativeCopyFiles !== 'function')
            return { errors: uris.map(() => 500) }
        return nativeCopyFiles({ uri_from: uris, uri_to: to }, ctx)
    }

    // Shared by the HTTP move_files/copy_files interception and Clipboard-Sync's
    // customApi calls. Returns null when the whole request should stay native.
    async function smartTransfer(op, uriFrom, uriTo, ctx) {
        if (!api.getConfig('enabled'))
            return
        if (!Array.isArray(uriFrom) || typeof uriTo !== 'string')
            return
        const username = api.getCurrentUsername(ctx)
        if (!username)
            return
        const params = { uri_from: uriFrom, uri_to: uriTo }
        let plan
        try {
            plan = await classify(params, ctx)
        }
        catch (e) {
            return
        }
        if (!plan?.fast.length)
            return

        try { ctx.logExtra?.(null, { target: uriFrom.map(x => typeof x === 'string' ? pathDecode(x) : x), destination: pathDecode(uriTo) }) } catch {}

        const fast = plan.fast
        const native = uriFrom.filter((_uri, i) => !plan.fastFlags[i])
        let nativeErrors = []
        if (native.length) {
            try {
                const result = op === 'copy'
                    ? await nativeCopy(native, uriTo, ctx)
                    : await moveFiles(native, uriTo, ctx)
                nativeErrors = Array.isArray(result?.errors)
                    ? result.errors
                    : native.map(() => result?.code || result?.status || 500)
            }
            catch (e) {
                nativeErrors = native.map(() => e?.code || e?.status || 500)
            }
        }

        const fastErrors = []
        for (const uri of fast)
            fastErrors.push(await enqueueFast(uri, ctx, plan.destNode, plan.destDev, op).catch(e => {
                return 500
            }))

        let fi = 0
        let ni = 0
        const errors = uriFrom.map((_uri, i) => plan.fastFlags[i] ? fastErrors[fi++] : nativeErrors[ni++])
        const queuedIds = [...jobs.values()].filter(j => j.user === username && ACTIVE.has(j.status)).map(j => j.id)
        return { errors, safemove: { queued: queuedIds } }
    }
    smartTransferImpl = smartTransfer

    async function middleware(ctx) {
        // Never let another account subscribe to this account's progress channel.
        if (typeof ctx.path === 'string' && ctx.path.endsWith('/get_notifications')
            && typeof ctx.query?.channel === 'string' && ctx.query.channel.startsWith(CHANNEL_PREFIX)) {
            const username = api.getCurrentUsername(ctx)
            if (!username || ctx.query.channel !== channelFor(username)) {
                ctx.status = 403
                ctx.type = 'text/plain; charset=utf-8'
                ctx.body = 'forbidden'
                return ctx.stop()
            }
        }

        if (ctx.method !== 'POST' || typeof ctx.path !== 'string')
            return
        const isMove = ctx.path.endsWith(API_URI + 'move_files')
        const isCopy = !isMove && ctx.path.endsWith(API_URI + 'copy_files')
        if (!isMove && !isCopy)
            return
        const params = ctx.state?.params
        if (!params || !Array.isArray(params.uri_from) || typeof params.uri_to !== 'string')
            return
        if (!csrfSafe(ctx))
            return // let the native API produce its usual CSRF error

        const body = await smartTransfer(isCopy ? 'copy' : 'move', params.uri_from, params.uri_to, ctx)
        if (!body)
            return
        ctx.status = 200
        ctx.body = body
        return ctx.stop()
    }

    async function classify(params, ctx) {
        const destNode = await urlToNode(params.uri_to, ctx)
        if (!destNode?.source || !nodeIsFolder(destNode))
            return
        if (statusCodeForMissingPerm(destNode, 'can_upload', ctx))
            return
        const destStat = await fsp.stat(destNode.source).catch(() => null)
        if (!destStat?.isDirectory())
            return
        const threshold = thresholdBytes()
        const fastFlags = []
        const fast = []
        for (const uri of params.uri_from) {
            let isFast = false
            if (typeof uri === 'string') {
                try {
                    const node = await urlToNode(uri, ctx)
                    if (node?.source && !nodeIsFolder(node) && hasPermission(node, 'can_read', ctx)) {
                        const link = await fsp.lstat(node.source)
                        if (!link.isSymbolicLink()) {
                            const stat = await fsp.stat(node.source)
                            const networkEdge = isUnc(node.source) !== isUnc(destNode.source)
                            isFast = stat.isFile() && stat.size >= threshold
                                && (forceCross() || networkEdge || stat.dev !== destStat.dev)
                        }
                    }
                }
                catch { /* native will report it */ }
            }
            fastFlags.push(isFast)
            if (isFast)
                fast.push(uri)
        }
        return { destNode, destDev: destStat.dev, fastFlags, fast }
    }

    // ------------------------------------------------------------- REST API

    async function safemove_state(_params, ctx) {
        const username = api.getCurrentUsername(ctx)
        if (!username)
            return { ok: false, reason: 'auth' }
        const mine = [...jobs.values()].filter(j => j.user === username)
        const queued = mine.filter(j => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)
        const positions = new Map(queued.map((j, i) => [j.id, i + 1]))
        mine.sort((a, b) => {
            const rank = j => j.status === 'waiting' ? 0 : j.status === 'failed' ? 1 : 2
            return rank(a) - rank(b) || a.createdAt - b.createdAt
        })
        return {
            ok: true,
            channel: channelFor(username),
            serverNow: Date.now(),
            cfg: {
                thresholdMb: num('thresholdMb', 50),
                speedMb: num('speedMb', 0),
                parallelJobs: num('parallelJobs', 1),
                keepDoneSec: Math.round(keepDoneMs() / 1000),
            },
            jobs: mine.slice(0, 100).map(j => publicJob(j, positions.get(j.id))),
        }
    }

    async function safemove_action(params, ctx) {
        const username = api.getCurrentUsername(ctx)
        if (!username)
            return { ok: false, reason: 'auth' }
        const id = typeof params?.id === 'string' ? params.id : ''
        const action = typeof params?.action === 'string' ? params.action : ''
        const job = jobs.get(id)
        if (!job)
            return { ok: false, reason: 'gone' }
        if (job.user !== username && !isAdmin(ctx))
            return { ok: false, reason: 'denied' }

        switch (action) {
            case 'overwrite':
                if (!job.canOverwrite)
                    return { ok: false, reason: 'denied' }
                job.overwrite = true
                delete job.conflict
                delete job.reason
                job.status = 'queued'
                job.phase = 'queued'
                delete job.retryAt
                job.error = null
                kick()
                break
            case 'rename':
                applyRename(job)
                job.status = 'queued'
                job.phase = 'queued'
                delete job.retryAt
                job.error = null
                kick()
                break
            case 'retry': {
                const finalizing = job.phase === 'finalize' && fs.existsSync(job.destPath)
                job.attempts = 0
                delete job.retryAt
                job.error = null
                job.abort = false
                job.status = 'queued'
                job.phase = finalizing ? 'finalize' : 'queued'
                if (!finalizing && job.verified === false) {
                    // A corrupted partial copy must not be resumed.
                    job.tempPath = null
                    job.copied = 0
                    job.verified = null
                    job.verifyBytes = 0
                    await removeTemp(job)
                }
                kick()
                break
            }
            case 'resume': {
                if (job.status !== 'paused' && job.status !== 'interrupted')
                    return { ok: false, reason: 'not-paused' }
                const finalizing = job.phase === 'finalize' && fs.existsSync(job.destPath)
                job.abort = false
                delete job.pauseRequested
                delete job.retryAt
                job.error = null
                job.status = 'queued'
                job.phase = finalizing ? 'finalize' : 'queued'
                kick()
                break
            }
            case 'pause':
                if (job.status === 'queued') {
                    pauseJob(job)
                    break
                }
                if (job.status === 'running' || job.status === 'verifying') {
                    job.pauseRequested = true
                    notify(job)
                    break
                }
                return { ok: false, reason: 'not-active' }
            case 'abort':
            case 'terminate':
            case 'skip':
                job.canceledByUser = true
                await dropJob(job)
                break
            default:
                return { ok: false, reason: 'bad-action' }
        }
        save()
        notify(job)
        return { ok: true, job: jobs.has(job.id) ? publicJob(job) : null }
    }

    // --------------------------------------------------------------- lifecycle

    tickTimer = setInterval(() => {
        if (stopping)
            return
        for (const job of jobs.values())
            if (job.status === 'done' && Date.now() - (job.doneAt || 0) > Math.max(300_000, keepDoneMs() + 60_000))
                jobs.delete(job.id)
        void pump()
    }, 1000)
    tickTimer.unref?.()

    setTimeout(() => { if (!stopping) void pump() }, 2500).unref?.()

    async function unload() {
        stopping = true
        clearInterval(tickTimer)
        clearTimeout(saveTimer)
        for (const job of active.values()) {
            job.abort = true
            if (job.status === 'running' || job.status === 'verifying') {
                job.status = 'interrupted'
                job.phase = 'interrupted'
                job.speed = 0
            }
        }
        // Let the copy loops release their file handles before a hot-restarted instance opens them.
        const deadline = Date.now() + 5000
        while (active.size && Date.now() < deadline)
            await engine.sleep(50)
        await saveNow()
    }

    return {
        middleware,
        customRest: {
            safemove_state,
            safemove_action,
            // Legacy names for a page that was loaded before the rename.
            fastmove_state: safemove_state,
            fastmove_action: safemove_action,
        },
        unload,
    }
}

function withCode(error, code) {
    error.code = code
    return error
}

function sameMtime(a, b) {
    return Math.trunc(Number(a) / 1000) === Math.trunc(Number(b) / 1000)
}

function isUnc(path) {
    return typeof path === 'string' && /^\\\\/.test(path)
}

const ERROR_TEXT = {
    ENOSPC: 'Not enough disk space',
    EACCES: 'Permission denied',
    EPERM: 'Permission denied',
    EROFS: 'Destination is read-only',
    ENOENT: 'File is missing',
    EBUSY: 'File is busy (antivirus or another program)',
    EISDIR: 'Destination is a folder',
    SAFEMOVE_SOURCE_CHANGED: 'Source changed during transfer',
    SAFEMOVE_INTEGRITY: 'Integrity check failed',
}

function friendlyError(code) {
    return ERROR_TEXT[code] || 'Transfer failed'
}
