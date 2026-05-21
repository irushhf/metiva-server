import { execSync } from 'child_process';

export default function handler(req, res) {
  const ip = execSync('hostname -I').toString().trim().split(/\s+/)[0];
  const hostname = execSync('hostname').toString().trim();
  res.status(200).json({ ip, hostname });
}