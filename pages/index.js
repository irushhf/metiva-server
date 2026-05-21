import { useEffect, useState } from 'react';
import { execSync } from 'child_process';

export async function getServerSideProps() {
    const ip = execSync('hostname -I').toString().trim().split(/\s+/)[0];
    const hostname = execSync('hostname').toString().trim();
    const ips = execSync("hostname -I | awk '{print $1}'")
    return { props: { ip, hostname,ips } };
}


function Badge({ label, value, unit = '', color = '#4ade80' }) {
    return (
        <div style={{
            background: '#1a1a1a', border: '1px solid #333',
            padding: '8px 14px', borderRadius: '8px', minWidth: '120px'
        }}>
            <div style={{ color: '#666', fontSize: '10px', marginBottom: '4px', textTransform: 'uppercase' }}>{label}</div>
            <div style={{ color, fontSize: '15px', fontWeight: 'bold' }}>
                {value ?? '—'}{value != null ? unit : ''}
            </div>
        </div>
    );
}

export default function Home({ ip, hostname, ips }) {
    const [stats, setStats] = useState(null);

    const fetchStats = async () => {
        try {
            const r = await fetch('/api/stats');
            setStats(await r.json());
        } catch {}
    };

    useEffect(() => {
        fetchStats();
        const t = setInterval(fetchStats, 3000);
        return () => clearInterval(t);
    }, []);

    const cpu = stats?.cpu ? (100 - (stats.cpu[1] ?? 0)).toFixed(1) : null;
    const ramUsed = stats?.ram ? (stats.ram[1] / 1024).toFixed(1) : null;
    const ramFree = stats?.ram ? (stats.ram[2] / 1024).toFixed(1) : null;
    const temps = stats?.temps ?? [];

    const cpuColor = cpu > 80 ? '#f87171' : cpu > 50 ? '#fbbf24' : '#4ade80';
    const ramColor = ramUsed > 12 ? '#f87171' : ramUsed > 8 ? '#fbbf24' : '#4ade80';

    return (
        <>
            <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: monospace; background: #0a0a0a; color: #e0e0e0; }
        .topbar {
          padding: 10px 16px;
          background: #111;
          border-bottom: 1px solid #1f1f1f;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
        }
        iframe { width: 100%; height: calc(100vh - 80px); border: none; display: block; }
        .dot { width: 8px; height: 8px; background: #4ade80;
               border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse {
          0%, 100% { opacity: 1; } 50% { opacity: 0.3; }
        }
      `}</style>

            <div className="topbar">
                <div className="dot" />
                <Badge label="Hostname" value={hostname} />
                <Badge label="Local IP" value={ip} />
                <Badge label="Local IP ips" value={ips} />
                <Badge label="SSH" value={`user@${ip}`} color="#60a5fa" />
                {cpu != null && <Badge label="CPU Usage" value={cpu} unit="%" color={cpuColor} />}
                {ramUsed != null && <Badge label="RAM Used" value={ramUsed} unit=" GB" color={ramColor} />}
                {ramFree != null && <Badge label="RAM Free" value={ramFree} unit=" GB" />}
                {temps.map((t, i) => t.value != null && (
                    <Badge
                        key={i}
                        label={t.chart.replace('sensors.', '').replace(/_/g, ' ')}
                        value={t.value.toFixed(1)}
                        unit="°C"
                        color={t.value > 80 ? '#f87171' : t.value > 60 ? '#fbbf24' : '#4ade80'}
                    />
                ))}
            </div>

            <iframe src={`http://${ip}:19999`} />
        </>
    );
}