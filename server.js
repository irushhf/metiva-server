const http = require('http');
const { execSync } = require('child_process');

function getIP() {
    try {
        return execSync('hostname -I').toString().trim().split(/\s+/)[0];
    } catch { return 'unavailable'; }
}

function getHostname() {
    try {
        return execSync('hostname').toString().trim();
    } catch { return 'unavailable'; }
}

function getHTML(ip, hostname) {
    return `<!DOCTYPE html>
<html>
<head>
  <title>Server Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: monospace; background:#0a0a0a; color:#e0e0e0; }
    .bar { padding:12px 20px; background:#111; border-bottom:1px solid #222;
           display:flex; gap:16px; flex-wrap:wrap; align-items:center; }
    .badge { background:#1a1a1a; border:1px solid #333; padding:6px 14px;
             border-radius:6px; font-size:13px; }
    .badge span { color:#888; margin-right:6px; }
    .badge strong { color:#4ade80; }
    iframe { width:100%; height:calc(100vh - 56px); border:none; }
  </style>
</head>
<body>
  <div class="bar">
    <div class="badge"><span>HOSTNAME</span><strong>${hostname}</strong></div>
    <div class="badge"><span>LOCAL IP</span><strong>${ip}</strong></div>
    <div class="badge"><span>SSH</span><strong>ssh user@${ip}</strong></div>
    <div class="badge"><span>NETDATA</span><strong>http://${ip}:19999</strong></div>
  </div>
  <iframe src="http://${ip}:19999"></iframe>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
    const ip = getIP();
    const hostname = getHostname();
    if (req.url === '/api/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ip, hostname }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getHTML(ip, hostname));
    }
});

server.listen(8181, '0.0.0.0', () => {
    console.log('Dashboard running on port 8181');
});