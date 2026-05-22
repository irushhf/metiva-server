import { useState, useEffect } from 'react';

export async function getServerSideProps() {
    const { execSync } = require('child_process');

    const run = (cmd, fallback = 'N/A') => {
        try { return execSync(cmd, { timeout: 4000, shell: '/bin/bash' }).toString().trim(); }
        catch { return fallback; }
    };

    // ── Network ──────────────────────────────────────────────
    const ip       = run(`hostname -I | awk '{print $1}'`);
    const hostname = run('hostname');

    // ── CPU Model & Cores ────────────────────────────────────
    const cpuModel = run(`cat /proc/cpuinfo | grep 'model name' | head -1 | cut -d: -f2`).replace(/\s+/g, ' ').trim();
    const cpuCores = run('nproc');
    const cpuThreads = run("grep -c processor /proc/cpuinfo");

    // ── CPU Temperature ───────────────────────────────────────
    let cpuTemp = 'N/A';
    // Try sensors first
    const sensorsRaw = run('sensors 2>/dev/null');
    if (sensorsRaw !== 'N/A') {
        const m = sensorsRaw.match(/(?:Core 0|Package id 0|Tdie|CPU).*?([+-]?\d+\.?\d*)\s*°C/i);
        if (m) cpuTemp = parseFloat(m[1]).toFixed(1) + '°C';
    }
    // Fallback to thermal_zone
    if (cpuTemp === 'N/A') {
        const tz = run('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null');
        if (tz !== 'N/A' && !isNaN(tz)) cpuTemp = (parseInt(tz) / 1000).toFixed(1) + '°C';
    }

    // ── CPU Usage (two /proc/stat reads 500ms apart) ──────────
    let cpuPct = 0;
    try {
        const stat1 = run("head -1 /proc/stat").split(/\s+/).slice(1).map(Number);
        execSync('sleep 0.5', { shell: '/bin/bash' });
        const stat2 = run("head -1 /proc/stat").split(/\s+/).slice(1).map(Number);
        const idle1 = stat1[3], idle2 = stat2[3];
        const total1 = stat1.reduce((a, b) => a + b, 0);
        const total2 = stat2.reduce((a, b) => a + b, 0);
        const totalDiff = total2 - total1;
        const idleDiff  = idle2  - idle1;
        cpuPct = Math.round(((totalDiff - idleDiff) / totalDiff) * 100);
    } catch {}

    // ── Load Average ──────────────────────────────────────────
    const loadRaw = run('cat /proc/loadavg').split(' ');
    const load = { m1: loadRaw[0] || '0', m5: loadRaw[1] || '0', m15: loadRaw[2] || '0' };

    // ── RAM ───────────────────────────────────────────────────
    const memRaw   = run('cat /proc/meminfo');
    const memTotal = parseInt(memRaw.match(/MemTotal:\s+(\d+)/)?.[1] || 0);
    const memAvail = parseInt(memRaw.match(/MemAvailable:\s+(\d+)/)?.[1] || 0);
    const memUsed  = memTotal - memAvail;
    const memPct   = Math.round((memUsed / memTotal) * 100);
    const mem = {
        total: (memTotal / 1024 / 1024).toFixed(1),
        used:  (memUsed  / 1024 / 1024).toFixed(1),
        free:  (memAvail / 1024 / 1024).toFixed(1),
        pct:   memPct,
    };

    // ── Disk ──────────────────────────────────────────────────
    const diskRaw = run("df -h / | tail -1").split(/\s+/);
    const disk = {
        total: diskRaw[1] || 'N/A',
        used:  diskRaw[2] || 'N/A',
        free:  diskRaw[3] || 'N/A',
        pct:   diskRaw[4] || 'N/A',
    };

    // ── Uptime ────────────────────────────────────────────────
    const uptimeSec = parseFloat(run('cat /proc/uptime').split(' ')[0] || 0);
    const days  = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins  = Math.floor((uptimeSec % 3600) / 60);
    const uptime = `${days}d ${hours}h ${mins}m`;

    // ── Network interfaces ────────────────────────────────────
    const allIPs = run("hostname -I").split(/\s+/).filter(Boolean);

    // ── Top processes ─────────────────────────────────────────
    const topProcs = run("ps aux --sort=-%cpu | awk 'NR>1{printf \"%s|%s|%s\\n\",$11,$3,$4}' | head -6");

    // ── OS Info ──────────────────────────────────────────────
    const osName   = run("lsb_release -d 2>/dev/null | cut -d: -f2").trim() || run("cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'");
    const kernel   = run("uname -r");

    // ── Timestamp ─────────────────────────────────────────────
    const timestamp = new Date().toISOString();

    return {
        props: {
            ip, hostname, allIPs,
            cpuModel, cpuCores, cpuThreads, cpuPct, cpuTemp,
            load, mem, disk, uptime, topProcs,
            osName, kernel, timestamp,
        }
    };
}

// ── Gauge component ───────────────────────────────────────────────────────────
function Gauge({ value, label, color = '#4ade80' }) {
    const r = 36, cx = 44, cy = 44;
    const circ = 2 * Math.PI * r;
    const offset = circ - (Math.min(value, 100) / 100) * circ;
    const hue = value < 60 ? 142 : value < 80 ? 38 : 0;
    const col = `hsl(${hue}, 90%, 55%)`;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <svg width="88" height="88" viewBox="0 0 88 88">
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e1e1e" strokeWidth="8" />
                <circle cx={cx} cy={cy} r={r} fill="none" stroke={col} strokeWidth="8"
                        strokeDasharray={circ} strokeDashoffset={offset}
                        strokeLinecap="round"
                        transform={`rotate(-90 ${cx} ${cy})`}
                        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                />
                <text x={cx} y={cy + 5} textAnchor="middle" fill="#e0e0e0"
                      style={{ fontSize: 14, fontFamily: 'monospace', fontWeight: 700 }}>
                    {value}%
                </text>
            </svg>
            <span style={{ fontSize: 11, color: '#666', letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
        </div>
    );
}

// ── Bar component ─────────────────────────────────────────────────────────────
function Bar({ pct, label, left, right }) {
    const hue = pct < 60 ? 142 : pct < 80 ? 38 : 0;
    return (
        <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 12 }}>
                <span style={{ color: '#888' }}>{label}</span>
                <span style={{ color: '#e0e0e0' }}>{left} <span style={{ color: '#555' }}>/ {right}</span></span>
            </div>
            <div style={{ height: 6, background: '#1e1e1e', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                    height: '100%', width: `${pct}%`,
                    background: `hsl(${hue}, 90%, 55%)`,
                    borderRadius: 3,
                    transition: 'width 0.6s ease',
                }} />
            </div>
        </div>
    );
}

// ── Stat badge ────────────────────────────────────────────────────────────────
function Stat({ label, value, accent = false }) {
    return (
        <div style={{
            background: '#111', border: '1px solid #222', borderRadius: 8,
            padding: '12px 16px', minWidth: 120,
        }}>
            <div style={{ fontSize: 10, color: '#555', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: accent ? '#4ade80' : '#e0e0e0', fontFamily: 'monospace' }}>{value}</div>
        </div>
    );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Home(props) {
    const {
        ip, hostname, allIPs,
        cpuModel, cpuCores, cpuThreads, cpuPct, cpuTemp,
        load, mem, disk, uptime, topProcs,
        osName, kernel, timestamp,
    } = props;

    const [countdown, setCountdown] = useState(30);
    const [lastUpdate, setLastUpdate] = useState('');

    useEffect(() => {
        const t = new Date(timestamp);
        setLastUpdate(t.toLocaleTimeString());
    }, [timestamp]);

    useEffect(() => {
        let c = 30;
        const interval = setInterval(() => {
            c -= 1;
            setCountdown(c);
            if (c <= 0) {
                window.location.reload();
            }
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    // Parse top processes
    const procs = topProcs !== 'N/A'
        ? topProcs.split('\n').map(l => {
            const parts = l.split('|');
            return { name: (parts[0] || '').split('/').pop().slice(0, 24), cpu: parts[1] || '0', mem: parts[2] || '0' };
        }).filter(p => p.name)
        : [];

    const diskPct = parseInt(disk.pct) || 0;

    return (
        <>
            <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { height: 100%; }
        body {
          font-family: 'Courier New', monospace;
          background: #0a0a0a;
          color: #e0e0e0;
          overflow: hidden;
        }
        .panel {
          background: #0f0f0f;
          border: 1px solid #1e1e1e;
          border-radius: 10px;
          padding: 18px;
        }
        .panel-title {
          font-size: 10px;
          color: #444;
          letter-spacing: 2px;
          text-transform: uppercase;
          margin-bottom: 16px;
          padding-bottom: 10px;
          border-bottom: 1px solid #1a1a1a;
        }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80;
               display: inline-block; margin-right: 8px; animation: pulse 2s infinite; }
        @keyframes pulse {
          0%, 100% { opacity: 1; } 50% { opacity: 0.3; }
        }
        .proc-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 5px 0; border-bottom: 1px solid #161616; font-size: 12px;
        }
        .proc-row:last-child { border-bottom: none; }
        .tag {
          background: #1a1a1a; border: 1px solid #2a2a2a;
          border-radius: 4px; padding: 2px 8px; font-size: 11px; color: #666;
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
        .refresh-ring {
          width: 28px; height: 28px; border-radius: 50%;
          border: 2px solid #1e1e1e;
          border-top-color: #4ade80;
          display: flex; align-items: center; justify-content: center;
          font-size: 10px; color: #4ade80; font-weight: 700;
          animation: spin ${30}s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

            {/* ── TOP BAR ─────────────────────────────────────────── */}
            <div style={{
                height: 52, background: '#080808', borderBottom: '1px solid #1a1a1a',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0 20px', flexShrink: 0,
            }}>
                {/* Left: identity */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <span style={{ fontSize: 11, color: '#333' }}>◈</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#e0e0e0', letterSpacing: 1 }}>{hostname}</span>
                    <span style={{ fontSize: 11, color: '#4ade80' }}>{ip}</span>
                    <span className="tag">{osName !== 'N/A' ? osName : kernel}</span>
                    <span className="tag">↑ {uptime}</span>
                </div>
                {/* Right: refresh */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 11, color: '#444' }}>Updated {lastUpdate}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11, color: '#555' }}>Refresh in</span>
                        <div style={{
                            width: 32, height: 32, borderRadius: '50%',
                            border: '2px solid #1e1e1e',
                            borderTop: '2px solid #4ade80',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 11, color: '#4ade80', fontWeight: 700,
                        }}>{countdown}</div>
                    </div>
                    <button onClick={() => window.location.reload()} style={{
                        background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#888',
                        borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12,
                    }}>↺ Now</button>
                </div>
            </div>

            {/* ── BODY ─────────────────────────────────────────────── */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: '320px 1fr',
                gridTemplateRows: 'calc(100vh - 52px)',
                overflow: 'hidden',
            }}>

                {/* ── LEFT SIDEBAR ─────────────────────────────────── */}
                <div style={{
                    overflowY: 'auto', padding: 16,
                    borderRight: '1px solid #141414',
                    display: 'flex', flexDirection: 'column', gap: 12,
                }}>

                    {/* CPU */}
                    <div className="panel">
                        <div className="panel-title"><span className="dot" />CPU</div>
                        <div style={{ fontSize: 11, color: '#555', marginBottom: 14, lineHeight: 1.6 }}>
                            {cpuModel || 'Unknown CPU'}<br />
                            <span style={{ color: '#333' }}>{cpuCores} cores · {cpuThreads} threads</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 14 }}>
                            <Gauge value={cpuPct} label="Usage" />
                            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
                                <Stat label="Temp" value={cpuTemp} accent={cpuTemp !== 'N/A'} />
                                <Stat label="Cores" value={`${cpuCores}c / ${cpuThreads}t`} />
                            </div>
                        </div>
                        <div style={{ fontSize: 11, color: '#444', marginBottom: 6 }}>Load Average</div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            {[['1m', load.m1], ['5m', load.m5], ['15m', load.m15]].map(([k, v]) => (
                                <div key={k} style={{
                                    flex: 1, background: '#141414', border: '1px solid #1e1e1e',
                                    borderRadius: 6, padding: '8px 0', textAlign: 'center',
                                }}>
                                    <div style={{ fontSize: 14, fontWeight: 700, color: '#e0e0e0' }}>{v}</div>
                                    <div style={{ fontSize: 10, color: '#444', marginTop: 2 }}>{k}</div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* RAM */}
                    <div className="panel">
                        <div className="panel-title"><span className="dot" style={{ background: '#60a5fa' }} />Memory</div>
                        <Gauge value={mem.pct} label="RAM Used" />
                        <div style={{ marginTop: 14 }}>
                            <Bar pct={mem.pct} label="RAM" left={`${mem.used} GB`} right={`${mem.total} GB`} />
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                            <Stat label="Used" value={`${mem.used} GB`} />
                            <Stat label="Free" value={`${mem.free} GB`} />
                        </div>
                    </div>

                    {/* Disk */}
                    <div className="panel">
                        <div className="panel-title"><span className="dot" style={{ background: '#f59e0b' }} />Disk /</div>
                        <Bar pct={diskPct} label="Storage" left={disk.used} right={disk.total} />
                        <div style={{ display: 'flex', gap: 8 }}>
                            <Stat label="Used" value={disk.used} />
                            <Stat label="Free" value={disk.free} />
                            <Stat label="Total" value={disk.total} />
                        </div>
                    </div>

                    {/* Network */}
                    <div className="panel">
                        <div className="panel-title"><span className="dot" style={{ background: '#a78bfa' }} />Network</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {allIPs.map((addr, i) => (
                                <div key={i} style={{
                                    display: 'flex', justifyContent: 'space-between',
                                    background: '#141414', borderRadius: 6, padding: '8px 12px',
                                }}>
                                    <span style={{ fontSize: 11, color: '#555' }}>eth{i}</span>
                                    <span style={{ fontSize: 13, color: '#4ade80', fontWeight: 700 }}>{addr}</span>
                                </div>
                            ))}
                            <div style={{
                                background: '#141414', borderRadius: 6, padding: '8px 12px',
                                display: 'flex', justifyContent: 'space-between',
                            }}>
                                <span style={{ fontSize: 11, color: '#555' }}>SSH</span>
                                <span style={{ fontSize: 12, color: '#888' }}>ssh vinch@{ip}</span>
                            </div>
                        </div>
                    </div>

                    {/* Top Processes */}
                    <div className="panel">
                        <div className="panel-title"><span className="dot" style={{ background: '#f87171' }} />Top Processes</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0 12px',
                            fontSize: 10, color: '#444', marginBottom: 8, padding: '0 2px' }}>
                            <span>Process</span><span>CPU%</span><span>MEM%</span>
                        </div>
                        {procs.map((p, i) => (
                            <div key={i} className="proc-row">
                                <span style={{ fontSize: 12, color: '#888', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                                <span style={{ fontSize: 12, color: parseFloat(p.cpu) > 10 ? '#f87171' : '#e0e0e0', width: 42, textAlign: 'right' }}>{p.cpu}%</span>
                                <span style={{ fontSize: 12, color: '#666', width: 42, textAlign: 'right' }}>{p.mem}%</span>
                            </div>
                        ))}
                    </div>

                    {/* System */}
                    <div className="panel">
                        <div className="panel-title">System</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <Stat label="OS" value={osName !== 'N/A' ? osName.slice(0, 26) : 'Linux'} />
                            <Stat label="Kernel" value={kernel} />
                            <Stat label="Uptime" value={uptime} accent />
                        </div>
                    </div>

                </div>

                {/* ── RIGHT: NETDATA IFRAME ─────────────────────────── */}
                <div style={{ position: 'relative', overflow: 'hidden' }}>
                    <div style={{
                        position: 'absolute', top: 0, left: 0, right: 0,
                        padding: '8px 16px', background: '#080808',
                        borderBottom: '1px solid #141414', zIndex: 10,
                        display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                        <span className="dot" />
                        <span style={{ fontSize: 11, color: '#555', letterSpacing: 1 }}>NETDATA LIVE — {hostname} · {ip}:19999</span>
                    </div>
                    <iframe
                        src={`http://${ip}:19999`}
                        style={{ width: '100%', height: '100%', border: 'none', paddingTop: 36 }}
                    />
                </div>
            </div>
        </>
    );
}