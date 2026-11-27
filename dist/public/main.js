'use strict';
{
    const { h, React, t, state, customRestCall, getNotifications, reloadList, toast } = HFS
    const { useState, useEffect } = React

    const POLL_ACTIVE = 1500
    const POLL_IDLE = 8000
    const POLL_ERROR = 5000

    const store = {
        jobs: [],
        cfg: null,
        channel: null,
        subscribed: false,
        timer: null,
        loading: false,
        loaded: false,
        prev: new Map(),
        listeners: new Set(),
        clockOffset: 0,
    }

    function emit() {
        for (const fn of store.listeners)
            fn()
    }

    function T(key, vars, fallback) {
        try { return t(key, vars, fallback) }
        catch { return fallback || key }
    }

    function schedule(delay) {
        clearTimeout(store.timer)
        store.timer = null
        if (!store.listeners.size)
            return
        store.timer = setTimeout(refresh, Math.max(40, delay))
    }

    async function refresh() {
        store.timer = null
        if (store.loading || !store.listeners.size)
            return
        store.loading = true
        let delay = POLL_IDLE
        try {
            const res = await customRestCall('safemove_state')
            if (res && res.ok) {
                if (res.channel && res.channel !== store.channel)
                    subscribe(res.channel)
                if (res.cfg)
                    store.cfg = res.cfg
                if (Number.isFinite(res.serverNow))
                    store.clockOffset = res.serverNow - Date.now()
                const jobs = Array.isArray(res.jobs) ? res.jobs : []
                detectCompletions(jobs)
                store.jobs = jobs
                store.loaded = true
                emit()
                if (jobs.some(isActive))
                    delay = POLL_ACTIVE
            }
            else if (res && res.reason === 'auth') {
                store.jobs = []
                store.prev.clear()
                emit()
                delay = POLL_IDLE
            }
        }
        catch {
            delay = POLL_ERROR
        }
        finally {
            store.loading = false
            schedule(delay)
        }
    }

    function subscribe(channel) {
        store.channel = channel
        if (store.subscribed)
            return
        store.subscribed = true
        try {
            getNotifications(channel, () => schedule(120))
        }
        catch {
            store.subscribed = false
        }
    }

    function isActive(job) {
        return job.status === 'queued' || job.status === 'running'
            || job.status === 'verifying' || job.status === 'waiting'
            || job.status === 'paused' || job.status === 'interrupted'
    }

    function isUnfinished(job) {
        return job.status === 'paused' || job.status === 'interrupted'
    }

    function safeDecode(value) {
        try { return decodeURI(value || '/') }
        catch { return value || '/' }
    }

    function sameDir(a, b) {
        if (!a || !b)
            return false
        const clean = value => safeDecode(value).replace(/\/+$/, '')
        return clean(a) === clean(b)
    }

    function detectCompletions(jobs) {
        const seen = new Set()
        for (const job of jobs) {
            seen.add(job.id)
            const previous = store.prev.get(job.id)
            store.prev.set(job.id, job.status)
            if (job.status === 'done' && previous && previous !== 'done') {
                const current = state.uri
                if (sameDir(current, job.srcDir) || sameDir(current, job.destDir)) {
                    try { reloadList() } catch {}
                }
            }
        }
        for (const id of [...store.prev.keys()])
            if (!seen.has(id))
                store.prev.delete(id)
    }

    function action(job, act) {
        customRestCall('safemove_action', { id: job.id, action: act })
            .then(res => {
                if (!res || !res.ok) {
                    if (res && res.reason === 'gone')
                        store.jobs = store.jobs.filter(x => x.id !== job.id)
                    else
                        toast(T('safemove_action_failed', null, 'Action failed'), 'warning')
                    emit()
                }
                schedule(120)
            })
            .catch(() => toast(T('safemove_action_failed', null, 'Action failed'), 'warning'))
    }

    function formatSpeed(bytesPerSecond) {
        const value = Number(bytesPerSecond) || 0
        if (value <= 0)
            return ''
        const mb = value / (1024 * 1024)
        if (mb >= 100)
            return Math.round(mb) + ' MB/s'
        if (mb >= 10)
            return mb.toFixed(1) + ' MB/s'
        return mb.toFixed(2) + ' MB/s'
    }

    function statusText(job, now) {
        switch (job.status) {
            case 'queued':
                if (job.retryAt && job.retryAt > now)
                    return T('safemove_retrying', { n: Math.max(1, Math.ceil((job.retryAt - now) / 1000)) }, 'Retry in {n}s')
                return job.queuePos
                    ? T('safemove_queued_n', { n: job.queuePos }, 'Queued #{n}')
                    : T('safemove_queued', null, 'Queued')
            case 'running':
                return T('safemove_copying', null, 'Copying')
            case 'verifying':
                return T('safemove_verifying', null, 'Verifying')
            case 'paused':
                return T('safemove_paused', null, 'Paused')
            case 'interrupted':
                return T('safemove_interrupted', null, 'Interrupted')
            case 'waiting':
                return job.reason === 'conflict'
                    ? T('safemove_conflict', null, 'File exists')
                    : T('safemove_action_needed', null, 'Needs action')
            case 'failed':
                return T('safemove_failed', null, 'Failed')
            case 'done':
                if (job.verified === false)
                    return T('safemove_mismatch', null, 'Hash mismatch')
                if (job.verified === true)
                    return T('safemove_verified', null, 'Integrity OK')
                return T('safemove_size_ok', null, 'Size OK')
            default:
                return job.status || ''
        }
    }

    function percent(job) {
        const size = Number(job.size) || 0
        if (!size)
            return 0
        if (job.status === 'verifying')
            return Math.max(0, Math.min(100, (Number(job.verifyBytes) || 0) / (size * 2) * 100))
        return Math.max(0, Math.min(100, (Number(job.copied) || 0) / size * 100))
    }

    function doneRemaining(job, now) {
        if (job.status !== 'done' || !job.hideAt)
            return null
        return Math.max(0, Math.ceil((job.hideAt - now) / 1000))
    }

    function btn(job, act, label, extraClass) {
        return h('button', {
            key: act,
            type: 'button',
            'data-action': act,
            className: 'sm-btn ' + (extraClass || ''),
            title: label,
            onClick: event => {
                event.preventDefault()
                event.stopPropagation()
                action(job, act)
            },
        }, label)
    }

    function buttons(job) {
        const acts = Array.isArray(job.actions) ? job.actions : []
        if (!acts.length)
            return null
        const labels = {
            overwrite: T('safemove_overwrite', null, 'Overwrite'),
            rename: T('safemove_rename', null, 'Rename'),
            skip: T('safemove_skip', null, 'Skip'),
            retry: T('safemove_retry', null, 'Retry'),
            pause: T('safemove_pause', null, 'Pause'),
            resume: T('safemove_resume', null, 'Resume'),
            abort: T('safemove_abort', null, 'Abort'),
            terminate: T('safemove_abort', null, 'Abort'),
        }
        return h('span', { className: 'sm-actions' },
            acts.map(act => btn(job, act, labels[act] || act, act === 'abort' || act === 'terminate' ? 'sm-stop' : '')))
    }

    function Prompt({ job }) {
        const name = job.partial || job.name
        return h('div', { className: 'sm-prompt sm-prompt-' + job.status, 'data-job': job.id },
            h('span', { className: 'sm-prompt-icon' }, '⚠'),
            h('span', { className: 'sm-prompt-text' },
                T('safemove_unfinished', { file: name }, 'Unfinished transfer detected: {file}'),
                ' ',
                T('safemove_unfinished_hint', null, 'Resume or delete the incomplete file?')),
            h('span', { className: 'sm-actions' },
                btn(job, 'resume', T('safemove_resume', null, 'Resume')),
                btn(job, 'abort', T('safemove_delete_partial', null, 'Delete partial'), 'sm-stop')))
    }

    function Row({ job, now }) {
        const pct = percent(job)
        const speed = (job.status === 'running' || job.status === 'verifying')
            ? formatSpeed(job.speed)
            : ''
        const remaining = doneRemaining(job, now)
        const title = [
            job.name,
            job.status,
            job.error,
            job.srcHash ? 'src ' + job.srcHash : '',
            job.destHash ? 'dst ' + job.destHash : '',
        ].filter(Boolean).join(' | ')

        return h('div', { className: 'sm-row sm-' + job.status, 'data-job': job.id, 'data-status': job.status, title },
            h('span', { className: 'sm-name' }, job.name),
            h('span', { className: 'sm-label' },
                statusText(job, now),
                remaining != null ? ' ' + remaining + 's' : '',
                job.status === 'failed' && job.error ? h('span', { className: 'sm-error' }, ' - ' + job.error) : null),
            h('span', { className: 'sm-bar' },
                h('span', { className: 'sm-fill', style: { width: Math.round(pct) + '%' } })),
            h('span', { className: 'sm-pct' }, Math.round(pct) + '%'),
            h('span', { className: 'sm-speed' }, speed),
            buttons(job),
        )
    }

    function Panel() {
        const [, setVersion] = useState(0)
        const [now, setNow] = useState(Date.now())

        useEffect(() => {
            const listener = () => setVersion(value => value + 1)
            store.listeners.add(listener)
            let unwatch = null
            try { unwatch = HFS.watchState?.('uri', listener) } catch {}
            if (!store.timer)
                refresh()
            const clock = setInterval(() => setNow(Date.now()), 1000)
            return () => {
                store.listeners.delete(listener)
                if (typeof unwatch === 'function')
                    unwatch()
                clearInterval(clock)
                if (!store.listeners.size) {
                    clearTimeout(store.timer)
                    store.timer = null
                }
            }
        }, [])

        const visible = store.jobs.filter(job =>
            !(job.status === 'done' && job.hideAt && now + store.clockOffset >= job.hideAt))
        const current = HFS.state.uri
        const prompted = visible.filter(job => isUnfinished(job)
            && (sameDir(current, job.srcDir) || sameDir(current, job.destDir)))
        const rest = visible.filter(job => !prompted.includes(job))

        if (!visible.length)
            return null

        return h('div', { className: 'sm-panel', id: 'safemove-panel' },
            prompted.map(job => h(Prompt, { key: 'prompt-' + job.id, job })),
            rest.map(job => h(Row, { key: job.id, job, now: now + store.clockOffset })))
    }

    HFS.onEvent('afterFolderStats', () => h(Panel))
}
