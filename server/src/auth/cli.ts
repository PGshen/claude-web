// npm run account            set the login account, or change its password
// npm run account -- remove  turn login off again
// npm run account -- status  is there an account?
// The server reads the account when it starts, so a change takes effect with the next restart.
import '../i18n/init.js';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { tr } from '../i18n/index.js';
import { MIN_PASSWORD_LENGTH, readAccount, removeAccount, writeAccount } from './login.js';

async function setAccount() {
  let muted = false;
  const tty = !!process.stdin.isTTY;
  const output = new Writable({ write(chunk, _enc, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: tty });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string, hidden = false) => {
    process.stdout.write(prompt);
    muted = hidden;
    const { value, done } = await lines.next();
    muted = false;
    if (hidden || !tty) process.stdout.write('\n');
    if (done) throw new Error(tr('输入没有写完'));
    return String(value);
  };
  try {
    const current = readAccount();
    const username = (await ask(current ? tr('用户名（回车保留 {name}）：', { name: current.username }) : tr('用户名：'))).trim() || current?.username || '';
    if (!username) throw new Error(tr('用户名不能为空'));
    const password = await ask(tr('密码（至少 {n} 位）：', { n: MIN_PASSWORD_LENGTH }), true);
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(tr('密码至少要 {n} 位', { n: MIN_PASSWORD_LENGTH }));
    if ((await ask(tr('再输一次密码：'), true)) !== password) throw new Error(tr('两次输入的密码不一样'));
    await writeAccount(username, password);
    console.log(tr('账号已保存。重启服务后生效，所有已登录的浏览器都要重新登录。'));
  } finally {
    rl.close();
  }
}

async function main() {
  const command = process.argv[2] ?? 'set';
  if (command === 'set') return setAccount();
  if (command === 'remove') {
    console.log(removeAccount() ? tr('账号已删除。重启服务后不再需要登录，只有本机地址能打开。') : tr('还没有设置账号。'));
    return;
  }
  if (command === 'status') {
    const account = readAccount();
    console.log(account ? tr('登录已开启，用户名：{name}', { name: account.username }) : tr('还没有设置账号。'));
    return;
  }
  throw new Error('usage: npm run account [-- set | remove | status]');
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
