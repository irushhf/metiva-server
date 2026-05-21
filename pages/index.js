export async function getServerSideProps() {
  const { execSync } = require('child_process');
  const ip = execSync('hostname -I').toString().trim().split(/\s+/)[0];
  const hostname = execSync('hostname').toString().trim();
  const hostnamaae = execSync(`hostname -I | awk '{print $1}'`).toString().trim();
  return { props: { ip, hostname, hostnamaae} };
}

export default function Home({ ip, hostname, hostnamaae }) {
  return (
    <>
      <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: monospace; background: #0a0a0a; color: #e0e0e0; }
        .bar {
          padding: 12px 20px;
          background: #111;
          border-bottom: 1px solid #222;
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
          align-items: center;
        }
        .badge {
          background: #1a1a1a;
          border: 1px solid #333;
          padding: 6px 14px;
          border-radius: 6px;
          font-size: 13px;
        }
        .badge span { color: #888; margin-right: 6px; }
        .badge strong { color: #4ade80; }
        iframe {
          width: 100%;
          height: calc(100vh - 56px);
          border: none;
          display: block;
        }
      `}</style>

      <div className="bar">
        <div className="badge"><span>HOSTNAME</span><strong>{hostname}</strong></div>
        <div className="badge"><span>hostnamaae</span><strong>{hostnamaae}</strong></div>
        <div className="badge"><span>LOCAL IP</span><strong>{ip}</strong></div>
        <div className="badge"><span>SSH</span><strong>ssh user@{ip}</strong></div>
        <div className="badge"><span>NETDATA</span><strong>http://{ip}:19999</strong></div>
      </div>

      <iframe src={`http://${ip}:19999`} />
    </>
  );
}