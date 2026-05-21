export default async function handler(req, res) {
    const base = 'http://localhost:19999/api/v1';

    async function fetch_chart(chart) {
        try {
            const r = await fetch(`${base}/data?chart=${chart}&points=1&after=-1&format=json`);
            const d = await r.json();
            return d?.data?.[0] ?? null;
        } catch { return null; }
    }

    async function fetch_info() {
        try {
            const r = await fetch(`${base}/info`);
            return await r.json();
        } catch { return null; }
    }

    const [cpu, ram, net, disk, info] = await Promise.all([
        fetch_chart('system.cpu'),
        fetch_chart('system.ram'),
        fetch_chart('system.net'),
        fetch_chart('system.disk_ops'),
        fetch_info(),
    ]);

    // temps — find all sensor charts
    let temps = [];
    try {
        const r = await fetch(`${base}/charts`);
        const charts = await r.json();
        const tempCharts = Object.keys(charts.charts).filter(k =>
            k.startsWith('sensors.') || k.startsWith('nv_temp') || k.includes('temp')
        );
        temps = await Promise.all(
            tempCharts.slice(0, 6).map(async (chart) => {
                const d = await fetch_chart(chart);
                return { chart, value: d?.[1] ?? null };
            })
        );
    } catch {}

    res.status(200).json({ cpu, ram, net, disk, temps, info });
}