import { spawn } from 'node:child_process';
import { createGameServer } from '../server.mjs';

// Run this on the player's computer to open its own default browser.
const configured = Number(process.env.PORT);
const firstPort = Number.isInteger(configured) && configured > 0 && configured <= 65535 ? configured : 3001;
let game;
let address;
for (let offset = 0; offset < 20 && firstPort + offset <= 65535; offset++) {
  const candidate = createGameServer({ port: firstPort + offset });
  try {
    address = await candidate.listen();
    game = candidate;
    break;
  } catch (error) {
    await candidate.close();
    if (error.code !== 'EADDRINUSE') throw error;
    console.log(`端口 ${firstPort + offset} 已被使用，尝试下一个端口…`);
  }
}
if (!game) throw new Error('没有找到可用端口，请设置 PORT 后重试。');
const url = `http://localhost:${address.port}`;
console.log(`\n星球大爆炸已启动：${url}\n关闭这个窗口或按 Ctrl+C 可结束游戏服务。\n`);

if (!process.argv.includes('--no-open')) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const browser = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  browser.once('error', () => console.log(`无法自动打开浏览器，请手动访问 ${url}`));
  browser.once('exit', code => {
    if (code !== 0 && code !== null) console.log(`浏览器未能自动打开，请手动访问 ${url}`);
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await game.close();
  process.exit(0);
});
