/**
 * SERVER MONITOR — pages/index.js
 * Drop this into your Next.js pages/ directory.
 * Reads all metrics directly from /proc (no agent needed).
 * Auto-refreshes every 5s via router.replace (no full reload flash).
 *
 * Tabs: Overview · CPU · Memory · Disk · Network · Processes · Docker
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SERVER-SIDE DATA COLLECTION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function getServerSideProps() {
    const fs = require('fs');
    const { execSync } = require('child_process');

    const readFile = (path) => {
        try { return fs.readFileSync(path, 'utf8').trim(); }
        catch { return ''; }
    };

    const run = (cmd, fallback = '') => {
        try { return execSync(cmd, { timeout: 4000, shell: '/bin/bash' }).toString().trim(); }
        catch { return fallback; }
    };

    // ── Identity ────────────────────────────────────────────────────────────
    const hostname  = readFile('/proc/sys/kernel/hostname') || run('hostname');
    const allIPs    = run('hostname -I').split(/\s+/).filter(Boolean);
    const ip        = allIPs[0] || 'N/A';
    const arch      = run('uname -m');
    const kernelVer = run('uname -r');
    const osName    = run("lsb_release -d 2>/dev/null | cut -d: -f2").trim() ||
        run("grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '\"'");

    // ── Uptime ──────────────────────────────────────────────────────────────
    const uptimeParts = readFile('/proc/uptime').split(' ');
    const uptimeSec   = parseFloat(uptimeParts[0] || 0);
    const uptime = {
        sec: Math.floor(uptimeSec % 60),
        min: Math.floor((uptimeSec % 3600) / 60),
        hr:  Math.floor((uptimeSec % 86400) / 3600),
        day: Math.floor(uptimeSec / 86400),
        str: (() => {
            const d = Math.floor(uptimeSec / 86400);
            const h = Math.floor((uptimeSec % 86400) / 3600);
            const m = Math.floor((uptimeSec % 3600) / 60);
            return `${d}d ${h}h ${m}m`;
        })(),
    };

    // ── Load Average ────────────────────────────────────────────────────────
    const laParts = readFile('/proc/loadavg').split(' ');
    const load = {
        m1: laParts[0] || '0.00',
        m5: laParts[1] || '0.00',
        m15: laParts[2] || '0.00',
        runnable: (laParts[3] || '0/0').split('/')[0],
        total: (laParts[3] || '0/0').split('/')[1],
        lastPid: laParts[4] || '0',
    };

    // ── CPU Info ────────────────────────────────────────────────────────────
    const cpuInfoRaw  = readFile('/proc/cpuinfo');
    const cpuModel    = (cpuInfoRaw.match(/model name\s*:\s*(.+)/)?.[1] || 'Unknown').trim().replace(/\s+/g,' ');
    const cpuCores    = (cpuInfoRaw.match(/^processor\s*:/gm) || []).length;
    const cpuMHz      = parseFloat(cpuInfoRaw.match(/cpu MHz\s*:\s*([\d.]+)/)?.[1] || 0).toFixed(0);
    const cpuCache    = cpuInfoRaw.match(/cache size\s*:\s*(.+)/)?.[1]?.trim() || 'N/A';
    const cpuVendor   = cpuInfoRaw.match(/vendor_id\s*:\s*(.+)/)?.[1]?.trim() || '';
    const cpuSockets  = new Set(cpuInfoRaw.match(/physical id\s*:\s*(\d+)/g) || ['0']).size;
    const cpuFlags    = cpuInfoRaw.match(/flags\s*:\s*(.+)/)?.[1]?.split(' ').slice(0, 8).join(' ') || '';
    const cpuBogoMIPS = cpuInfoRaw.match(/bogomips\s*:\s*([\d.]+)/)?.[1] || 'N/A';

    // ── CPU Usage — two /proc/stat reads 400ms apart ────────────────────────
    const parseStat = (raw) => {
        const lines = raw.split('\n');
        const cpus = {};
        for (const line of lines) {
            const m = line.match(/^(cpu\d*)\s+([\d\s]+)/);
            if (!m) continue;
            const [user, nice, system, idle, iowait, irq, softirq, steal] =
                m[2].trim().split(/\s+/).map(Number);
            const total = user + nice + system + idle + (iowait||0) + (irq||0) + (softirq||0) + (steal||0);
            cpus[m[1]] = { user, nice, system, idle, iowait: iowait||0, irq: irq||0,
                softirq: softirq||0, steal: steal||0, total };
        }
        return cpus;
    };

    const raw1 = readFile('/proc/stat');
    execSync('sleep 0.4', { shell: '/bin/bash' });
    const raw2 = readFile('/proc/stat');
    const stat1 = parseStat(raw1);
    const stat2 = parseStat(raw2);

    const cpuUsage = {};
    for (const key of Object.keys(stat1)) {
        const a = stat1[key], b = stat2[key];
        if (!b) continue;
        const td = b.total - a.total || 1;
        cpuUsage[key] = {
            pct:    Math.min(100, Math.round(((td - (b.idle - a.idle) - (b.iowait - a.iowait)) / td) * 100)),
            user:   Math.min(100, Math.round(((b.user - a.user) / td) * 100)),
            sys:    Math.min(100, Math.round(((b.system - a.system) / td) * 100)),
            io:     Math.min(100, Math.round(((b.iowait - a.iowait) / td) * 100)),
            steal:  Math.min(100, Math.round(((b.steal - a.steal) / td) * 100)),
            nice:   Math.min(100, Math.round(((b.nice - a.nice) / td) * 100)),
        };
    }

    // ── Context switches & interrupts (from /proc/stat) ─────────────────────
    const ctxSwitches = parseInt(raw2.match(/^ctxt\s+(\d+)/m)?.[1] || 0);
    const interrupts  = parseInt(raw2.match(/^intr\s+(\d+)/m)?.[1] || 0);
    const processes   = parseInt(raw2.match(/^processes\s+(\d+)/m)?.[1] || 0);
    const procsRunning = parseInt(raw2.match(/^procs_running\s+(\d+)/m)?.[1] || 0);
    const procsBlocked = parseInt(raw2.match(/^procs_blocked\s+(\d+)/m)?.[1] || 0);

    // ── Temperature ─────────────────────────────────────────────────────────
    const temps = {};
    // Try sensors -j
    try {
        const sj = run('sensors -j 2>/dev/null');
        if (sj) {
            const parsed = JSON.parse(sj);
            for (const [chip, sensors] of Object.entries(parsed)) {
                for (const [sensor, values] of Object.entries(sensors)) {
                    if (typeof values !== 'object') continue;
                    for (const [k, v] of Object.entries(values)) {
                        if (k.includes('_input') && typeof v === 'number' && v > 0 && v < 200) {
                            const label = `${chip}:${sensor}`.replace(/\s+/g, '_');
                            temps[label] = parseFloat(v.toFixed(1));
                        }
                    }
                }
            }
        }
    } catch {}
    // Fallback: /sys/class/thermal
    if (!Object.keys(temps).length) {
        try {
            const zones = fs.readdirSync('/sys/class/thermal').filter(d => d.startsWith('thermal_zone'));
            for (const z of zones) {
                const t = readFile(`/sys/class/thermal/${z}/temp`);
                const type = readFile(`/sys/class/thermal/${z}/type`) || z;
                if (t && !isNaN(t)) temps[type] = parseFloat((parseInt(t) / 1000).toFixed(1));
            }
        } catch {}
    }

    const cpuTemp = Object.entries(temps).find(([k]) =>
            /core\s*0|package|cpu|tdie|tccd|tctl/i.test(k))?.[1] ||
        Object.values(temps)[0] || null;

    // ── Memory ──────────────────────────────────────────────────────────────
    const memRaw  = readFile('/proc/meminfo');
    const memGet  = (k) => parseInt(memRaw.match(new RegExp(k + ':\\s+(\\d+)'))?.[1] || 0) * 1024;
    const memTotal   = memGet('MemTotal');
    const memFree    = memGet('MemFree');
    const memAvail   = memGet('MemAvailable');
    const memBuffers = memGet('Buffers');
    const memCached  = memGet('Cached') - memGet('Shmem');
    const memShmem   = memGet('Shmem');
    const memUsed    = memTotal - memAvail;
    const memActUsed = memTotal - memFree - memBuffers - memCached - memShmem;
    const swapTotal  = memGet('SwapTotal');
    const swapFree   = memGet('SwapFree');
    const swapUsed   = swapTotal - swapFree;
    const memDirty   = memGet('Dirty');
    const memMapped  = memGet('Mapped');
    const memSlab    = memGet('Slab');
    const hugePgSz   = memGet('Hugepagesize');
    const hugePgFree = parseInt(memRaw.match(/HugePages_Free:\s+(\d+)/)?.[1] || 0);
    const hugePgTotal= parseInt(memRaw.match(/HugePages_Total:\s+(\d+)/)?.[1] || 0);

    const mem = {
        total: memTotal, free: memFree, avail: memAvail,
        buffers: memBuffers, cached: memCached, shmem: memShmem,
        used: memUsed, actUsed: memActUsed,
        dirty: memDirty, mapped: memMapped, slab: memSlab,
        usedPct: Math.round((memUsed / memTotal) * 100),
        actUsedPct: Math.round((memActUsed / memTotal) * 100),
        buffersPct: Math.round((memBuffers / memTotal) * 100),
        cachedPct: Math.round((memCached / memTotal) * 100),
        swap: {
            total: swapTotal, free: swapFree, used: swapUsed,
            pct: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0,
        },
        huge: { pageSize: hugePgSz, free: hugePgFree, total: hugePgTotal },
    };

    // ── Disk Usage ──────────────────────────────────────────────────────────
    const dfRaw = run("df -k --output=target,size,used,avail,pcent,fstype 2>/dev/null | tail -n +2");
    const disks = dfRaw.split('\n').map(line => {
        const p = line.trim().split(/\s+/);
        if (p.length < 6) return null;
        const [mount, size, used, avail, pct, fstype] = p;
        if (['tmpfs','devtmpfs','udev','squashfs','efivarfs','bpf','cgroup2','tracefs','debugfs','securityfs','fusectl','hugetlbfs','mqueue','pstore'].includes(fstype)) return null;
        if (mount.startsWith('/snap/')) return null;
        return {
            mount, fstype,
            size:  parseInt(size) * 1024,
            used:  parseInt(used) * 1024,
            avail: parseInt(avail) * 1024,
            pct:   parseInt(pct) || 0,
        };
    }).filter(Boolean);

    // ── Disk I/O — two /proc/diskstats reads ───────────────────────────────
    const parseDiskStats = (raw) => {
        const devs = {};
        for (const line of raw.split('\n')) {
            const p = line.trim().split(/\s+/);
            if (p.length < 14) continue;
            const dev = p[2];
            if (/^(loop|ram|dm-|sr)/.test(dev)) continue;
            devs[dev] = {
                readsCompleted:  +p[3],  readsMerged:   +p[4],
                sectorsRead:     +p[5],  msReading:     +p[6],
                writesCompleted: +p[7],  writesMerged:  +p[8],
                sectorsWritten:  +p[9],  msWriting:     +p[10],
                ioInProgress:    +p[11], msDoingIO:     +p[12],
            };
        }
        return devs;
    };

    const ds1Raw = readFile('/proc/diskstats');
    execSync('sleep 0.2', { shell: '/bin/bash' });
    const ds2Raw = readFile('/proc/diskstats');
    const ds1 = parseDiskStats(ds1Raw);
    const ds2 = parseDiskStats(ds2Raw);

    const diskIO = {};
    for (const dev of Object.keys(ds2)) {
        if (!ds1[dev]) continue;
        const d1 = ds1[dev], d2 = ds2[dev];
        diskIO[dev] = {
            readRate:  Math.max(0, (d2.sectorsRead    - d1.sectorsRead)    * 512 * 5),
            writeRate: Math.max(0, (d2.sectorsWritten - d1.sectorsWritten) * 512 * 5),
            readOps:   Math.max(0, d2.readsCompleted  - d1.readsCompleted) * 5,
            writeOps:  Math.max(0, d2.writesCompleted - d1.writesCompleted) * 5,
            busy:      Math.min(100, Math.round(((d2.msDoingIO - d1.msDoingIO) / 200) * 100)),
            ioInProgress: d2.ioInProgress,
        };
    }

    // ── Network — two /proc/net/dev reads ──────────────────────────────────
    const parseNetDev = (raw) => {
        const ifaces = {};
        for (const line of raw.split('\n').slice(2)) {
            const m = line.trim().match(/^(\S+):\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)\s+(\d+)/);
            if (!m) continue;
            const [, iface, rxB, rxP, txB, txP] = m;
            if (iface === 'lo') continue;
            ifaces[iface] = { rxBytes: +rxB, rxPkts: +rxP, txBytes: +txB, txPkts: +txP };
        }
        return ifaces;
    };

    const net1Raw = readFile('/proc/net/dev');
    execSync('sleep 0.2', { shell: '/bin/bash' });
    const net2Raw = readFile('/proc/net/dev');
    const net1 = parseNetDev(net1Raw);
    const net2 = parseNetDev(net2Raw);

    // Get IPs per interface
    const ifaceIPs = {};
    try {
        const ipOut = run("ip -o addr show 2>/dev/null | awk '{print $2, $4}'");
        for (const line of ipOut.split('\n')) {
            const [iface, cidr] = line.trim().split(' ');
            if (!iface || !cidr) continue;
            if (!ifaceIPs[iface]) ifaceIPs[iface] = [];
            ifaceIPs[iface].push(cidr.split('/')[0]);
        }
    } catch {}

    const network = {};
    for (const iface of Object.keys(net2)) {
        const n1 = net1[iface] || { rxBytes: 0, txBytes: 0, rxPkts: 0, txPkts: 0 };
        network[iface] = {
            rxTotal: net2[iface].rxBytes,  txTotal: net2[iface].txBytes,
            rxPkts:  net2[iface].rxPkts,   txPkts:  net2[iface].txPkts,
            rxRate:  Math.max(0, net2[iface].rxBytes - n1.rxBytes) * 5,
            txRate:  Math.max(0, net2[iface].txBytes - n1.txBytes) * 5,
            rxPktRate: Math.max(0, net2[iface].rxPkts - n1.rxPkts) * 5,
            txPktRate: Math.max(0, net2[iface].txPkts - n1.txPkts) * 5,
            ips: ifaceIPs[iface] || [],
        };
    }

    // Socket stats
    const sockRaw = readFile('/proc/net/sockstat');
    const sockets = {
        tcpInUse:  parseInt(sockRaw.match(/TCP:\s+inuse\s+(\d+)/)?.[1]  || 0),
        udpInUse:  parseInt(sockRaw.match(/UDP:\s+inuse\s+(\d+)/)?.[1]  || 0),
        tcpOrphan: parseInt(sockRaw.match(/TCP:.*orphan\s+(\d+)/)?.[1]  || 0),
        tcpTw:     parseInt(sockRaw.match(/TCP:.*tw\s+(\d+)/)?.[1]      || 0),
        sockInUse: parseInt(sockRaw.match(/sockets:\s+used\s+(\d+)/)?.[1]|| 0),
    };

    // ── Top Processes ───────────────────────────────────────────────────────
    const psRaw = run("ps aux --sort=-%cpu | awk 'NR>1{printf \"%s|%s|%s|%s|%s|%s\\n\",$1,$2,$3,$4,$6,$11}' | head -25");
    const procs = psRaw.split('\n').filter(Boolean).map(line => {
        const [user, pid, cpu, mem, vsz, cmd] = line.split('|');
        return {
            user: user?.slice(0, 10),
            pid,
            cpu: parseFloat(cpu || 0),
            mem: parseFloat(mem || 0),
            vsz: parseInt(vsz || 0) * 1024,
            cmd: (cmd || '').split('/').pop()?.slice(0, 35),
        };
    });

    // ── Docker Containers ───────────────────────────────────────────────────
    const dockerRaw = run("docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.RunningFor}}|{{.Ports}}' 2>/dev/null");
    const dockerAll = run("docker ps -a --format '{{.Names}}|{{.Status}}' 2>/dev/null");
    const containers = dockerRaw
        ? dockerRaw.split('\n').filter(Boolean).map(l => {
            const [name, image, status, runningFor, ports] = l.split('|');
            return { name, image: image?.slice(0, 40), status, runningFor, ports: ports?.slice(0, 50) || '' };
        })
        : [];
    const stoppedContainers = dockerAll
        ? dockerAll.split('\n').filter(l => l.includes('Exited') || l.includes('exited')).length
        : 0;

    // ── VM Stats ────────────────────────────────────────────────────────────
    const vmRaw = readFile('/proc/vmstat');
    const vmGet = (k) => parseInt(vmRaw.match(new RegExp('^' + k + '\\s+(\\d+)', 'm'))?.[1] || 0);
    const vmstat = {
        pgFaults:   vmGet('pgfault'),
        pgMajFault: vmGet('pgmajfault'),
        pgSwapIn:   vmGet('pswpin'),
        pgSwapOut:  vmGet('pswpout'),
        pgAllocated:vmGet('pgalloc_normal'),
        oomKills:   vmGet('oom_kill'),
    };

    return {
        props: {
            hostname, ip, allIPs, arch, kernelVer, osName,
            uptime, load,
            cpu: {
                model: cpuModel, cores: cpuCores, mhz: cpuMHz, cache: cpuCache,
                vendor: cpuVendor, sockets: cpuSockets, flags: cpuFlags,
                bogoMIPS: cpuBogoMIPS, usage: cpuUsage,
            },
            cpuTemp: cpuTemp ? parseFloat(cpuTemp) : null,
            temps,
            mem, disks, diskIO, network, sockets,
            procs, containers, stoppedContainers,
            vmstat,
            kernel: { ctxSwitches, interrupts, processes, procsRunning, procsBlocked },
            timestamp: new Date().toISOString(),
        }
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UTILITIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const fmt = {
    bytes(b, decimals = 1) {
        if (b === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(b) / Math.log(k));
        return parseFloat((b / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[Math.min(i, 4)];
    },
    rate(b) { return fmt.bytes(b) + '/s'; },
    pct(n)  { return Math.round(n) + '%'; },
    num(n)  { return n.toLocaleString(); },
    mhz(n)  { return n >= 1000 ? (n / 1000).toFixed(2) + ' GHz' : n + ' MHz'; },
};

const severity = (pct) => {
    if (pct >= 90) return '#ef4444';
    if (pct >= 70) return '#f59e0b';
    return '#22c55e';
};

const sevBg = (pct) => {
    if (pct >= 90) return 'rgba(239,68,68,0.08)';
    if (pct >= 70) return 'rgba(245,158,11,0.08)';
    return 'rgba(34,197,94,0.06)';
};

const tempColor = (t) => {
    if (!t) return '#888';
    if (t >= 85) return '#ef4444';
    if (t >= 70) return '#f59e0b';
    return '#22c55e';
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UI PRIMITIVES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const S = {
    card: {
        background: '#0f0f0f', border: '1px solid #1c1c1c',
        borderRadius: 8, padding: '16px 18px',
    },
    label: { fontSize: 10, color: '#4a4a4a', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4 },
    val:   { fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', fontFamily: 'monospace' },
    sub:   { fontSize: 11, color: '#555', marginTop: 2 },
    sectionTitle: {
        fontSize: 10, color: '#3a3a3a', letterSpacing: '0.16em',
        textTransform: 'uppercase', marginBottom: 14, paddingBottom: 8,
        borderBottom: '1px solid #161616', display: 'flex', alignItems: 'center', gap: 8,
    },
    grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
    grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 },
    grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 },
};

function Dot({ color = '#22c55e', pulse = false }) {
    return (
        <span style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: color, flexShrink: 0,
            animation: pulse ? 'pulse 2s infinite' : 'none',
        }} />
    );
}

function Bar({ pct, color, height = 5, showSegments }) {
    const col = color || severity(pct);
    return (
        <div style={{ height, background: '#141414', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
            <div style={{
                height: '100%', width: `${Math.min(pct, 100)}%`,
                background: col, borderRadius: 3,
                transition: 'width 0.4s ease',
            }} />
        </div>
    );
}

function SegBar({ segments }) {
    // segments: [{pct, color, label}]
    const total = segments.reduce((s, x) => s + x.pct, 0);
    return (
        <div style={{ height: 16, background: '#141414', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
            {segments.map((seg, i) => (
                <div key={i} title={`${seg.label}: ${fmt.pct(seg.pct)}`}
                     style={{ width: `${Math.min(seg.pct, 100)}%`, background: seg.color, flexShrink: 0 }} />
            ))}
        </div>
    );
}

function MetricCard({ label, value, sub, color, pct }) {
    return (
        <div style={{ ...S.card, background: pct != null ? sevBg(pct) : '#0f0f0f', position: 'relative' }}>
            <div style={S.label}>{label}</div>
            <div style={{ ...S.val, color: color || (pct != null ? severity(pct) : '#e0e0e0') }}>{value}</div>
            {sub && <div style={S.sub}>{sub}</div>}
            {pct != null && <Bar pct={pct} height={3} style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }} />}
        </div>
    );
}

function KV({ k, v, accent }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            padding: '5px 0', borderBottom: '1px solid #111' }}>
            <span style={{ fontSize: 11, color: '#4a4a4a' }}>{k}</span>
            <span style={{ fontSize: 12, color: accent || '#c0c0c0', fontFamily: 'monospace', textAlign: 'right', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
        </div>
    );
}

function Section({ title, children, dot = '#22c55e' }) {
    return (
        <div style={S.card}>
            <div style={S.sectionTitle}><Dot color={dot} pulse />{title}</div>
            {children}
        </div>
    );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TABS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function TabOverview({ data }) {
    const { cpu, mem, disks, cpuTemp, load, uptime, hostname, ip, osName, kernelVer, arch,
        network, procs, containers, stoppedContainers, sockets, kernel } = data;
    const totalCPU = cpu.usage['cpu']?.pct ?? 0;
    const rootDisk = disks.find(d => d.mount === '/') || disks[0];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Big 4 KPIs */}
            <div style={S.grid4}>
                <MetricCard label="CPU Usage" value={fmt.pct(totalCPU)} pct={totalCPU}
                            sub={`${cpu.cores} cores · load ${load.m1}`} />
                <MetricCard label="Memory" value={fmt.pct(mem.usedPct)} pct={mem.usedPct}
                            sub={`${fmt.bytes(mem.used)} / ${fmt.bytes(mem.total)}`} />
                <MetricCard label="Disk /" value={fmt.pct(rootDisk?.pct ?? 0)} pct={rootDisk?.pct ?? 0}
                            sub={rootDisk ? `${fmt.bytes(rootDisk.used)} / ${fmt.bytes(rootDisk.size)}` : 'N/A'} />
                <MetricCard label="CPU Temp"
                            value={cpuTemp != null ? `${cpuTemp}°C` : 'N/A'}
                            color={cpuTemp != null ? tempColor(cpuTemp) : '#555'}
                            sub={cpuTemp != null ? (cpuTemp >= 85 ? '⚠ HIGH' : cpuTemp >= 70 ? 'WARM' : 'NORMAL') : 'sensors not found'} />
            </div>

            {/* Load + uptime row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <Section title="Load Average" dot="#60a5fa">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                        {[['1 min', load.m1], ['5 min', load.m5], ['15 min', load.m15]].map(([t, v]) => (
                            <div key={t} style={{ textAlign: 'center', background: '#141414', borderRadius: 6, padding: '10px 0' }}>
                                <div style={{ fontSize: 18, fontWeight: 700, color: parseFloat(v) > cpu.cores ? '#ef4444' : '#e0e0e0', fontFamily: 'monospace' }}>{v}</div>
                                <div style={{ fontSize: 10, color: '#444', marginTop: 2 }}>{t}</div>
                            </div>
                        ))}
                    </div>
                    <KV k="Runnable procs" v={kernel.procsRunning} />
                    <KV k="Blocked procs"  v={kernel.procsBlocked} accent={kernel.procsBlocked > 0 ? '#f59e0b' : null} />
                    <KV k="Total procs"    v={kernel.processes} />
                </Section>

                <Section title="System Info" dot="#a78bfa">
                    <KV k="Hostname"  v={hostname} />
                    <KV k="IP"        v={ip} accent="#22c55e" />
                    <KV k="OS"        v={osName || 'Linux'} />
                    <KV k="Kernel"    v={kernelVer} />
                    <KV k="Arch"      v={arch} />
                    <KV k="Uptime"    v={uptime.str} accent="#60a5fa" />
                </Section>

                <Section title="Connections" dot="#f59e0b">
                    <KV k="TCP in-use"  v={sockets.tcpInUse}  accent="#60a5fa" />
                    <KV k="UDP in-use"  v={sockets.udpInUse} />
                    <KV k="TCP orphan"  v={sockets.tcpOrphan} accent={sockets.tcpOrphan > 0 ? '#f59e0b' : null} />
                    <KV k="TCP time-wait" v={sockets.tcpTw} />
                    <KV k="Sockets used"  v={sockets.sockInUse} />
                    <KV k="OOM kills"   v={data.vmstat.oomKills} accent={data.vmstat.oomKills > 0 ? '#ef4444' : null} />
                </Section>
            </div>

            {/* CPU per-core quick view */}
            <Section title="CPU Cores" dot="#22c55e">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: 8 }}>
                    {Object.entries(cpu.usage)
                        .filter(([k]) => k !== 'cpu')
                        .sort(([a],[b]) => parseInt(a.replace('cpu','')) - parseInt(b.replace('cpu','')))
                        .map(([core, u]) => (
                            <div key={core} style={{ background: '#141414', borderRadius: 6, padding: '8px 10px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                                    <span style={{ fontSize: 10, color: '#444' }}>{core.replace('cpu','C')}</span>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: severity(u.pct), fontFamily: 'monospace' }}>{u.pct}%</span>
                                </div>
                                <div style={{ height: 4, background: '#1e1e1e', borderRadius: 2, overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${u.user}%`, background: '#22c55e', display: 'inline-block' }} />
                                    <div style={{ height: '100%', width: `${u.sys}%`, background: '#3b82f6', display: 'inline-block' }} />
                                    <div style={{ height: '100%', width: `${u.io}%`, background: '#f59e0b', display: 'inline-block' }} />
                                </div>
                            </div>
                        ))}
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 10, color: '#444' }}>
                    {[['■ User','#22c55e'],['■ Sys','#3b82f6'],['■ IO Wait','#f59e0b']].map(([l, c]) => (
                        <span key={l}><span style={{ color: c }}>{l.split(' ')[0]}</span> {l.split(' ')[1]}</span>
                    ))}
                </div>
            </Section>

            {/* Network quick */}
            <Section title="Network Interfaces" dot="#a78bfa">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: 10 }}>
                    {Object.entries(network).map(([iface, n]) => (
                        <div key={iface} style={{ background: '#141414', borderRadius: 6, padding: '10px 12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                <span style={{ fontSize: 12, fontWeight: 700, color: '#e0e0e0' }}>{iface}</span>
                                <Dot color="#22c55e" pulse />
                            </div>
                            {n.ips.slice(0, 2).map((addr, i) => (
                                <div key={i} style={{ fontSize: 11, color: '#22c55e', marginBottom: 2 }}>{addr}</div>
                            ))}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 6 }}>
                                <div><div style={{ fontSize: 9, color: '#444' }}>↓ RX</div><div style={{ fontSize: 11, color: '#60a5fa', fontFamily: 'monospace' }}>{fmt.rate(n.rxRate)}</div></div>
                                <div><div style={{ fontSize: 9, color: '#444' }}>↑ TX</div><div style={{ fontSize: 11, color: '#a78bfa', fontFamily: 'monospace' }}>{fmt.rate(n.txRate)}</div></div>
                            </div>
                        </div>
                    ))}
                </div>
            </Section>

            {/* Top procs + Docker */}
            <div style={S.grid2}>
                <Section title="Top Processes by CPU" dot="#f87171">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0 12px',
                        fontSize: 10, color: '#333', marginBottom: 6, padding: '0 2px' }}>
                        <span>Command</span><span>CPU%</span><span>MEM%</span>
                    </div>
                    {procs.slice(0, 8).map((p, i) => (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0 12px',
                            padding: '4px 2px', borderBottom: '1px solid #111', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#444', marginRight: 6, fontSize: 10 }}>{p.pid}</span>{p.cmd}
              </span>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: p.cpu > 10 ? '#ef4444' : p.cpu > 5 ? '#f59e0b' : '#c0c0c0', textAlign: 'right', width: 38 }}>{p.cpu.toFixed(1)}</span>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#666', textAlign: 'right', width: 38 }}>{p.mem.toFixed(1)}</span>
                        </div>
                    ))}
                </Section>

                <Section title={`Docker Containers (${containers.length} running · ${stoppedContainers} stopped)`} dot="#38bdf8">
                    {containers.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#333', textAlign: 'center', padding: 20 }}>No running containers</div>
                    ) : containers.map((c, i) => (
                        <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #111' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                <span style={{ fontSize: 12, color: '#e0e0e0', fontWeight: 600 }}>{c.name}</span>
                                <span style={{ fontSize: 10, color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '1px 6px', borderRadius: 3 }}>UP</span>
                            </div>
                            <div style={{ fontSize: 11, color: '#555' }}>{c.image}</div>
                            {c.ports && <div style={{ fontSize: 10, color: '#38bdf8', marginTop: 2 }}>{c.ports}</div>}
                        </div>
                    ))}
                </Section>
            </div>
        </div>
    );
}

function TabCPU({ data }) {
    const { cpu, cpuTemp, temps, load, kernel } = data;
    const overall = cpu.usage['cpu'] || {};
    const cores = Object.entries(cpu.usage).filter(([k]) => k !== 'cpu')
        .sort(([a], [b]) => parseInt(a.replace('cpu','')) - parseInt(b.replace('cpu','')));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Overall + info */}
            <div style={S.grid2}>
                <Section title="Overall CPU" dot="#22c55e">
                    <div style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ fontSize: 32, fontWeight: 800, fontFamily: 'monospace', color: severity(overall.pct ?? 0) }}>{overall.pct ?? 0}%</span>
                            {cpuTemp != null && (
                                <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontSize: 24, fontWeight: 700, color: tempColor(cpuTemp), fontFamily: 'monospace' }}>{cpuTemp}°C</div>
                                    <div style={{ fontSize: 10, color: '#444' }}>Package Temp</div>
                                </div>
                            )}
                        </div>
                        <SegBar segments={[
                            { pct: overall.user  || 0, color: '#22c55e', label: 'User' },
                            { pct: overall.nice  || 0, color: '#86efac', label: 'Nice' },
                            { pct: overall.sys   || 0, color: '#3b82f6', label: 'System' },
                            { pct: overall.io    || 0, color: '#f59e0b', label: 'IO Wait' },
                            { pct: overall.steal || 0, color: '#ef4444', label: 'Steal' },
                        ]} />
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 6, marginTop: 10 }}>
                            {[
                                ['User', overall.user, '#22c55e'],
                                ['System', overall.sys, '#3b82f6'],
                                ['IO Wait', overall.io, '#f59e0b'],
                                ['Nice', overall.nice, '#86efac'],
                                ['Steal', overall.steal, '#ef4444'],
                            ].map(([label, val, color]) => (
                                <div key={label} style={{ textAlign: 'center', background: '#141414', borderRadius: 5, padding: '6px 0' }}>
                                    <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: 'monospace' }}>{val ?? 0}%</div>
                                    <div style={{ fontSize: 9, color: '#444', marginTop: 1 }}>{label}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <KV k="Load 1m / 5m / 15m" v={`${load.m1} / ${load.m5} / ${load.m15}`} />
                    <KV k="Processes running"  v={kernel.procsRunning} />
                    <KV k="Processes blocked"  v={kernel.procsBlocked} accent={kernel.procsBlocked > 0 ? '#f59e0b' : null} />
                    <KV k="Context switches"   v={fmt.num(kernel.ctxSwitches)} />
                </Section>

                <Section title="CPU Specification" dot="#60a5fa">
                    <KV k="Model"       v={cpu.model} />
                    <KV k="Vendor"      v={cpu.vendor || 'Unknown'} />
                    <KV k="Sockets"     v={cpu.sockets} />
                    <KV k="Total Cores" v={cpu.cores} accent="#22c55e" />
                    <KV k="Speed"       v={fmt.mhz(cpu.mhz)} />
                    <KV k="Cache"       v={cpu.cache} />
                    <KV k="BogoMIPS"    v={cpu.bogoMIPS} />
                    <KV k="Flags"       v={cpu.flags} />
                    {Object.entries(temps).slice(0, 4).map(([k, v]) => (
                        <KV key={k} k={k.split(':')[1] || k} v={`${v}°C`} accent={tempColor(v)} />
                    ))}
                </Section>
            </div>

            {/* Per-core grid */}
            <Section title="Per-Core Breakdown" dot="#22c55e">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
                    {cores.map(([core, u]) => (
                        <div key={core} style={{ background: '#141414', borderRadius: 6, padding: '10px 12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                <span style={{ fontSize: 11, color: '#555', textTransform: 'uppercase', letterSpacing: 1 }}>{core.replace('cpu', 'Core ')}</span>
                                <span style={{ fontSize: 14, fontWeight: 800, color: severity(u.pct), fontFamily: 'monospace' }}>{u.pct}%</span>
                            </div>
                            <SegBar segments={[
                                { pct: u.user,  color: '#22c55e', label: 'User' },
                                { pct: u.sys,   color: '#3b82f6', label: 'Sys' },
                                { pct: u.io,    color: '#f59e0b', label: 'IO' },
                                { pct: u.steal, color: '#ef4444', label: 'Steal' },
                            ]} />
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 2, marginTop: 5 }}>
                                {[['usr', u.user,'#22c55e'],['sys', u.sys,'#3b82f6'],['io', u.io,'#f59e0b'],['stl', u.steal,'#ef4444']].map(([l, v, c]) => (
                                    <div key={l} style={{ textAlign: 'center' }}>
                                        <div style={{ fontSize: 11, color: v > 0 ? c : '#2a2a2a', fontFamily: 'monospace' }}>{v}%</div>
                                        <div style={{ fontSize: 9, color: '#333' }}>{l}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </Section>
        </div>
    );
}

function TabMemory({ data }) {
    const { mem, vmstat } = data;
    const { swap } = mem;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={S.grid2}>
                <Section title="RAM Overview" dot="#60a5fa">
                    <div style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <div>
                                <div style={{ fontSize: 30, fontWeight: 800, fontFamily: 'monospace', color: severity(mem.usedPct) }}>{mem.usedPct}%</div>
                                <div style={{ fontSize: 11, color: '#555' }}>{fmt.bytes(mem.used)} used of {fmt.bytes(mem.total)}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                <div style={{ fontSize: 14, color: '#e0e0e0', fontFamily: 'monospace' }}>{fmt.bytes(mem.avail)}</div>
                                <div style={{ fontSize: 10, color: '#444' }}>Available</div>
                            </div>
                        </div>
                        <SegBar segments={[
                            { pct: mem.actUsedPct,  color: '#3b82f6', label: 'Used (actual)' },
                            { pct: mem.buffersPct,  color: '#a78bfa', label: 'Buffers' },
                            { pct: mem.cachedPct,   color: '#22c55e', label: 'Cached' },
                        ]} />
                        <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: '#444' }}>
                            {[['Used','#3b82f6'],['Buffers','#a78bfa'],['Cached','#22c55e'],['Free','#1e1e1e']].map(([l,c]) => (
                                <span key={l}><span style={{ color: c }}>■</span> {l}</span>
                            ))}
                        </div>
                    </div>
                    <KV k="Total"       v={fmt.bytes(mem.total)} accent="#e0e0e0" />
                    <KV k="Used"        v={fmt.bytes(mem.used)}  accent={severity(mem.usedPct)} />
                    <KV k="Free"        v={fmt.bytes(mem.free)} />
                    <KV k="Available"   v={fmt.bytes(mem.avail)} accent="#22c55e" />
                    <KV k="Buffers"     v={fmt.bytes(mem.buffers)} />
                    <KV k="Cached"      v={fmt.bytes(mem.cached)} />
                    <KV k="Shared"      v={fmt.bytes(mem.shmem)} />
                </Section>

                <Section title="Swap & Virtual Memory" dot="#a78bfa">
                    <div style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <div>
                                <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'monospace', color: severity(swap.pct) }}>
                                    {swap.total > 0 ? `${swap.pct}%` : 'No Swap'}
                                </div>
                                {swap.total > 0 && <div style={{ fontSize: 11, color: '#555' }}>{fmt.bytes(swap.used)} / {fmt.bytes(swap.total)}</div>}
                            </div>
                        </div>
                        {swap.total > 0 && <Bar pct={swap.pct} height={8} />}
                    </div>
                    <KV k="Swap Total"  v={swap.total > 0 ? fmt.bytes(swap.total) : 'N/A'} />
                    <KV k="Swap Used"   v={swap.total > 0 ? fmt.bytes(swap.used) : 'N/A'} accent={swap.pct > 50 ? '#f59e0b' : null} />
                    <KV k="Swap Free"   v={swap.total > 0 ? fmt.bytes(swap.free) : 'N/A'} />
                    <div style={{ marginTop: 14, ...S.sectionTitle }}>Virtual Memory Stats</div>
                    <KV k="Page Faults"     v={fmt.num(vmstat.pgFaults)} />
                    <KV k="Major Faults"    v={fmt.num(vmstat.pgMajFault)} accent={vmstat.pgMajFault > 1000 ? '#f59e0b' : null} />
                    <KV k="Swap In"         v={fmt.num(vmstat.pgSwapIn)} />
                    <KV k="Swap Out"        v={fmt.num(vmstat.pgSwapOut)} accent={vmstat.pgSwapOut > 0 ? '#f59e0b' : null} />
                    <KV k="OOM Kills"       v={vmstat.oomKills} accent={vmstat.oomKills > 0 ? '#ef4444' : null} />
                </Section>
            </div>

            <Section title="Detailed Memory Breakdown" dot="#60a5fa">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                    {[
                        ['Active Used', mem.actUsed,  '#3b82f6'],
                        ['Buffers',     mem.buffers,  '#a78bfa'],
                        ['Page Cache',  mem.cached,   '#22c55e'],
                        ['Shared',      mem.shmem,    '#f59e0b'],
                        ['Dirty',       mem.dirty,    '#ef4444'],
                        ['Mapped',      mem.mapped,   '#38bdf8'],
                        ['Slab',        mem.slab,     '#f472b6'],
                    ].map(([label, val, color]) => (
                        <div key={label} style={{ background: '#141414', borderRadius: 6, padding: '12px 14px' }}>
                            <div style={{ fontSize: 10, color: '#444', marginBottom: 4 }}>{label}</div>
                            <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: 'monospace' }}>{fmt.bytes(val)}</div>
                            <div style={{ marginTop: 6 }}>
                                <Bar pct={(val / mem.total) * 100} color={color} height={3} />
                            </div>
                            <div style={{ fontSize: 10, color: '#333', marginTop: 3 }}>{fmt.pct((val / mem.total) * 100)}</div>
                        </div>
                    ))}
                </div>
            </Section>
        </div>
    );
}

function TabDisk({ data }) {
    const { disks, diskIO } = data;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Section title="Mount Points" dot="#f59e0b">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {disks.map((d, i) => (
                        <div key={i} style={{ background: '#141414', borderRadius: 7, padding: '12px 16px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                                <div>
                                    <span style={{ fontSize: 14, fontWeight: 700, color: '#e0e0e0' }}>{d.mount}</span>
                                    <span style={{ fontSize: 11, color: '#444', marginLeft: 10 }}>{d.fstype}</span>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <span style={{ fontSize: 20, fontWeight: 800, fontFamily: 'monospace', color: severity(d.pct) }}>{d.pct}%</span>
                                    <span style={{ fontSize: 11, color: '#555', marginLeft: 8 }}>{fmt.bytes(d.used)} / {fmt.bytes(d.size)}</span>
                                </div>
                            </div>
                            <Bar pct={d.pct} height={8} />
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginTop: 8 }}>
                                {[['Used', fmt.bytes(d.used), severity(d.pct)], ['Free', fmt.bytes(d.avail), '#22c55e'], ['Total', fmt.bytes(d.size), '#888']].map(([l, v, c]) => (
                                    <div key={l} style={{ textAlign: 'center' }}>
                                        <div style={{ fontSize: 13, fontWeight: 600, color: c, fontFamily: 'monospace' }}>{v}</div>
                                        <div style={{ fontSize: 10, color: '#444' }}>{l}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </Section>

            {Object.keys(diskIO).length > 0 && (
                <Section title="Disk I/O" dot="#f59e0b">
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px,1fr))', gap: 10 }}>
                        {Object.entries(diskIO).map(([dev, io]) => (
                            <div key={dev} style={{ background: '#141414', borderRadius: 6, padding: '12px 14px' }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: '#e0e0e0', marginBottom: 10 }}>/dev/{dev}</div>
                                <div style={S.grid2}>
                                    <div><div style={{ fontSize: 10, color: '#444' }}>Read</div><div style={{ fontSize: 14, color: '#22c55e', fontFamily: 'monospace' }}>{fmt.rate(io.readRate)}</div></div>
                                    <div><div style={{ fontSize: 10, color: '#444' }}>Write</div><div style={{ fontSize: 14, color: '#f59e0b', fontFamily: 'monospace' }}>{fmt.rate(io.writeRate)}</div></div>
                                    <div><div style={{ fontSize: 10, color: '#444' }}>Read IOPS</div><div style={{ fontSize: 13, color: '#888', fontFamily: 'monospace' }}>{io.readOps}</div></div>
                                    <div><div style={{ fontSize: 10, color: '#444' }}>Write IOPS</div><div style={{ fontSize: 13, color: '#888', fontFamily: 'monospace' }}>{io.writeOps}</div></div>
                                </div>
                                <div style={{ marginTop: 10 }}>
                                    <div style={{ fontSize: 10, color: '#444', marginBottom: 4 }}>Busy {io.busy}%</div>
                                    <Bar pct={io.busy} height={5} />
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>
            )}
        </div>
    );
}

function TabNetwork({ data }) {
    const { network, sockets } = data;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Object.entries(network).map(([iface, n]) => (
                <Section key={iface} title={iface} dot="#a78bfa">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                        <div>
                            <div style={{ fontSize: 10, color: '#444', marginBottom: 8 }}>IP ADDRESSES</div>
                            {n.ips.length ? n.ips.map((addr, i) => (
                                <div key={i} style={{ fontSize: 14, color: '#22c55e', fontFamily: 'monospace', marginBottom: 2 }}>{addr}</div>
                            )) : <div style={{ fontSize: 12, color: '#333' }}>No IP</div>}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                            <MetricCard label="↓ RX Rate" value={fmt.rate(n.rxRate)} color="#60a5fa" />
                            <MetricCard label="↑ TX Rate" value={fmt.rate(n.txRate)} color="#a78bfa" />
                        </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginTop: 12 }}>
                        {[
                            ['Total RX', fmt.bytes(n.rxTotal), '#60a5fa'],
                            ['Total TX', fmt.bytes(n.txTotal), '#a78bfa'],
                            ['RX Pkts/s', n.rxPktRate.toFixed(0), '#86efac'],
                            ['TX Pkts/s', n.txPktRate.toFixed(0), '#c4b5fd'],
                        ].map(([label, val, color]) => (
                            <div key={label} style={{ background: '#141414', borderRadius: 6, padding: '10px 12px', textAlign: 'center' }}>
                                <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: 'monospace' }}>{val}</div>
                                <div style={{ fontSize: 10, color: '#444', marginTop: 2 }}>{label}</div>
                            </div>
                        ))}
                    </div>
                </Section>
            ))}

            <Section title="Socket Statistics" dot="#38bdf8">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10 }}>
                    {[
                        ['TCP In Use',   sockets.tcpInUse,  '#60a5fa'],
                        ['UDP In Use',   sockets.udpInUse,  '#a78bfa'],
                        ['TCP Orphan',   sockets.tcpOrphan, sockets.tcpOrphan > 0 ? '#f59e0b' : '#555'],
                        ['TCP Time-Wait',sockets.tcpTw,     '#555'],
                        ['Total Sockets',sockets.sockInUse, '#38bdf8'],
                    ].map(([label, val, color]) => (
                        <div key={label} style={{ background: '#141414', borderRadius: 6, padding: '12px', textAlign: 'center' }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: 'monospace' }}>{val}</div>
                            <div style={{ fontSize: 10, color: '#444', marginTop: 3 }}>{label}</div>
                        </div>
                    ))}
                </div>
            </Section>
        </div>
    );
}

function TabProcesses({ data }) {
    const { procs } = data;
    const [sort, setSort] = useState('cpu');
    const sorted = [...procs].sort((a, b) => sort === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Section title="Process List" dot="#f87171">
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    {[['cpu', 'Sort by CPU'], ['mem', 'Sort by MEM']].map(([k, label]) => (
                        <button key={k} onClick={() => setSort(k)} style={{
                            background: sort === k ? '#1e1e1e' : 'transparent',
                            border: `1px solid ${sort === k ? '#333' : '#1a1a1a'}`,
                            color: sort === k ? '#e0e0e0' : '#555', borderRadius: 5,
                            padding: '4px 12px', cursor: 'pointer', fontSize: 11,
                        }}>{label}</button>
                    ))}
                </div>

                {/* Header */}
                <div style={{ display: 'grid', gridTemplateColumns: '60px 80px 1fr 70px 70px 90px',
                    gap: '0 12px', fontSize: 10, color: '#3a3a3a', marginBottom: 6,
                    padding: '0 6px', letterSpacing: '0.1em' }}>
                    <span>PID</span><span>USER</span><span>COMMAND</span>
                    <span style={{ textAlign: 'right' }}>CPU%</span>
                    <span style={{ textAlign: 'right' }}>MEM%</span>
                    <span style={{ textAlign: 'right' }}>VSZ</span>
                </div>

                {sorted.map((p, i) => (
                    <div key={i} style={{
                        display: 'grid', gridTemplateColumns: '60px 80px 1fr 70px 70px 90px',
                        gap: '0 12px', padding: '6px 6px', borderBottom: '1px solid #0f0f0f',
                        alignItems: 'center',
                        background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                    }}>
                        <span style={{ fontSize: 11, color: '#444', fontFamily: 'monospace' }}>{p.pid}</span>
                        <span style={{ fontSize: 11, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.user}</span>
                        <span style={{ fontSize: 12, color: '#a0a0a0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.cmd}</span>
                        <span style={{ fontSize: 12, fontFamily: 'monospace', color: p.cpu > 20 ? '#ef4444' : p.cpu > 5 ? '#f59e0b' : '#888', textAlign: 'right' }}>{p.cpu.toFixed(1)}</span>
                        <span style={{ fontSize: 12, fontFamily: 'monospace', color: p.mem > 10 ? '#60a5fa' : '#666', textAlign: 'right' }}>{p.mem.toFixed(1)}</span>
                        <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#444', textAlign: 'right' }}>{fmt.bytes(p.vsz)}</span>
                    </div>
                ))}
            </Section>
        </div>
    );
}

function TabDocker({ data }) {
    const { containers, stoppedContainers } = data;
    if (containers.length === 0) return (
        <Section title="Docker" dot="#38bdf8">
            <div style={{ textAlign: 'center', padding: 40, color: '#333', fontSize: 13 }}>
                No running containers · {stoppedContainers} stopped
            </div>
        </Section>
    );
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {containers.map((c, i) => (
                <div key={i} style={{ ...S.card }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <Dot color="#22c55e" pulse />
                            <span style={{ fontSize: 15, fontWeight: 700, color: '#e0e0e0' }}>{c.name}</span>
                        </div>
                        <span style={{ fontSize: 11, color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '2px 10px', borderRadius: 4 }}>RUNNING</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                        <div><div style={{ fontSize: 10, color: '#444' }}>IMAGE</div><div style={{ fontSize: 12, color: '#888' }}>{c.image}</div></div>
                        <div><div style={{ fontSize: 10, color: '#444' }}>STATUS</div><div style={{ fontSize: 12, color: '#888' }}>{c.status}</div></div>
                        <div><div style={{ fontSize: 10, color: '#444' }}>PORTS</div><div style={{ fontSize: 11, color: '#38bdf8', fontFamily: 'monospace' }}>{c.ports || '—'}</div></div>
                    </div>
                </div>
            ))}
        </div>
    );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN PAGE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TABS = [
    { id: 'overview',   label: 'Overview' },
    { id: 'cpu',        label: 'CPU' },
    { id: 'memory',     label: 'Memory' },
    { id: 'disk',       label: 'Disk' },
    { id: 'network',    label: 'Network' },
    { id: 'processes',  label: 'Processes' },
    { id: 'docker',     label: 'Docker' },
];

export default function ServerMonitor(props) {
    const router = useRouter();
    const [tab, setTab] = useState('overview');
    const [countdown, setCountdown] = useState(5);
    const [refreshing, setRefreshing] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [lastUpdate, setLastUpdate] = useState('');

    useEffect(() => {
        setMounted(true);
        setLastUpdate(new Date(props.timestamp).toLocaleTimeString());
    }, [props.timestamp]);

    // Soft refresh — re-runs getServerSideProps without full reload
    useEffect(() => {
        let c = 5;
        const tick = setInterval(() => {
            c -= 1;
            setCountdown(c);
            if (c <= 0) {
                setRefreshing(true);
                router.replace(router.asPath, undefined, { scroll: false })
                    .finally(() => { setRefreshing(false); setCountdown(5); });
                c = 5;
            }
        }, 1000);
        return () => clearInterval(tick);
    }, []);

    if (!mounted) return null;

    const { hostname, ip, cpu, mem, cpuTemp, load } = props;
    const totalCPU = cpu.usage['cpu']?.pct ?? 0;

    return (
        <>
            <style>{`
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { height: 100%; overflow: hidden; }
        body { font-family: 'Courier New', 'Consolas', monospace; background: #080808; color: #e0e0e0; }
        button { font-family: inherit; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
        .tab-content { animation: fadeIn 0.2s ease; }
      `}</style>

            {/* ── TOP STATUS BAR ──────────────────────────────────────── */}
            <div style={{
                height: 48, background: '#060606', borderBottom: '1px solid #141414',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0 20px', flexShrink: 0, position: 'sticky', top: 0, zIndex: 100,
            }}>
                {/* Left */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Dot color="#22c55e" pulse />
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#e0e0e0', letterSpacing: '0.04em' }}>{hostname}</span>
                        <span style={{ fontSize: 12, color: '#22c55e', fontFamily: 'monospace' }}>{ip}</span>
                    </div>
                    <div style={{ width: 1, height: 20, background: '#1a1a1a' }} />
                    {[
                        [`CPU ${totalCPU}%`, severity(totalCPU)],
                        [`MEM ${mem.usedPct}%`, severity(mem.usedPct)],
                        [cpuTemp != null ? `${cpuTemp}°C` : null, cpuTemp != null ? tempColor(cpuTemp) : null],
                        [`↑${load.m1}`, parseFloat(load.m1) > cpu.cores ? '#ef4444' : '#888'],
                    ].filter(([v]) => v != null).map(([val, color], i) => (
                        <span key={i} style={{ fontSize: 12, color, fontFamily: 'monospace' }}>{val}</span>
                    ))}
                </div>

                {/* Right */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {refreshing && <span style={{ fontSize: 11, color: '#444' }}>Refreshing...</span>}
                    <span style={{ fontSize: 11, color: '#333' }}>{lastUpdate}</span>
                    <div style={{
                        width: 28, height: 28, borderRadius: '50%',
                        border: `2px solid ${countdown <= 1 ? '#22c55e' : '#1e1e1e'}`,
                        borderTop: `2px solid #22c55e`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, color: '#22c55e', fontWeight: 700,
                        animation: 'spin 5s linear infinite',
                    }}>{countdown}</div>
                    <button onClick={() => { setRefreshing(true); router.replace(router.asPath, undefined, { scroll: false }).finally(() => setRefreshing(false)); }}
                            style={{ background: '#141414', border: '1px solid #1e1e1e', color: '#666',
                                borderRadius: 5, padding: '4px 10px', cursor: 'pointer', fontSize: 11 }}>↺</button>
                </div>
            </div>

            {/* ── TAB BAR ────────────────────────────────────────────── */}
            <div style={{
                height: 38, background: '#060606', borderBottom: '1px solid #141414',
                display: 'flex', alignItems: 'flex-end', padding: '0 20px', gap: 0, flexShrink: 0,
            }}>
                {TABS.map(t => (
                    <button key={t.id} onClick={() => setTab(t.id)} style={{
                        background: tab === t.id ? '#0f0f0f' : 'transparent',
                        border: 'none',
                        borderTop: tab === t.id ? '1px solid #22c55e' : '1px solid transparent',
                        borderLeft: '1px solid transparent', borderRight: '1px solid transparent',
                        borderBottom: tab === t.id ? '1px solid #0f0f0f' : '1px solid transparent',
                        color: tab === t.id ? '#e0e0e0' : '#3a3a3a',
                        padding: '6px 16px', cursor: 'pointer', fontSize: 11,
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                        marginBottom: tab === t.id ? '-1px' : 0,
                        transition: 'color 0.15s',
                    }}>{t.label}</button>
                ))}
            </div>

            {/* ── CONTENT ────────────────────────────────────────────── */}
            <div style={{
                height: 'calc(100vh - 86px)', overflowY: 'auto',
                padding: 16, background: '#080808',
            }}>
                <div className="tab-content" key={tab}>
                    {tab === 'overview'   && <TabOverview   data={props} />}
                    {tab === 'cpu'        && <TabCPU        data={props} />}
                    {tab === 'memory'     && <TabMemory     data={props} />}
                    {tab === 'disk'       && <TabDisk       data={props} />}
                    {tab === 'network'    && <TabNetwork    data={props} />}
                    {tab === 'processes'  && <TabProcesses  data={props} />}
                    {tab === 'docker'     && <TabDocker     data={props} />}
                </div>
            </div>
        </>
    );
}