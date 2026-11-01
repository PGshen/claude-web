# 登录（2026-11-01，用户要求）

把服务放到云主机上，在家和公司都能用；只有一个账号，防的是地址泄露。**登录后的人几乎等于拿到这台机器的 shell**，密码就是整台机器的钥匙。

## 部署

服务仍只监听 `127.0.0.1`，HTTPS 和对外由同一台机器上的 Nginx 负责。

```
npm run account            # 设置账号 / 改密码（密码至少 12 位）
npm run account -- status  # 看有没有账号
npm run account -- remove  # 关掉登录
make restart               # 账号只在启动时读，改完要重启
```

```nginx
server {
  listen 80;
  server_name app.example.com;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl;
  server_name app.example.com;
  ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;
  client_max_body_size 200m;                     # 附件上限

  location / {
    proxy_pass http://127.0.0.1:3090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # /ws
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;                 # 必须：WS 的 Origin 和登录的来源检查都比对 Host
    proxy_set_header X-Real-IP $remote_addr;     # 必须：失败次数按它算；不传就所有人算同一个地址
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;  # 必须：没有它会被当成明文 HTTP，拒绝登录
    proxy_read_timeout 1d;                       # 对话可以很久没有消息
    proxy_send_timeout 1d;
    proxy_buffering off;
  }
}
# 放在 http {} 里
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

没有 HTTPS 时，SSH 隧道到 `127.0.0.1:3090` 也能登录（本机请求不算明文风险）。

## 设计决定

- **没有账号文件 = 没有登录**，本机和桌面版和以前一样。文件坏了（`LoginService.load` 抛错）**服务拒绝启动**，绝不退回不用登录。
- **不做「第一次打开时设置密码」**：放到公网后谁先打开谁就是主人，所以只能在服务器上用命令设。
- `<data>/login.json`：用户名、scrypt 哈希、盐、`generation`；`<data>/login-sessions.json`：会话的 sha256 + 到期时间。都是 600，不进 meta.json（meta 会同步、会上 wire）。
- 改密码换 `generation`，下次启动时旧 generation 的会话全部丢弃。所以「账号文件只被 CLI 写、会话文件只被服务写」，运行中的服务写会话不会盖掉新密码。
- cookie `cw_session`：`HttpOnly; SameSite=Lax`，HTTPS 时 `Secure`，30 天不滑动。用 Lax 不用 Strict：从别处点链接打开时 Strict 不带 cookie，会多跳一次登录页；跨站写操作靠上传口和登录 / 退出的 `sameOriginRequest`、WS 的 `wsOriginOk` 挡。
- 防猜密码（`LoginService.attempt`）：同一地址错 5 次锁 15 分钟；所有地址一小时错 50 次，暂停全部登录 15 分钟；同时最多 4 个 scrypt，多的回 429，防止把 CPU 占满。已登录的浏览器不受影响，所以被人恶意锁住也只是暂时登不了新浏览器。用户名错也要算一遍 scrypt，不泄露是哪个错了。

## 开了登录后关掉的门（`server/src/index.ts`）

- `authOk` 只认登录 cookie：`?token=`、`CLAUDE_WEB_TOKEN`、设备令牌、「Host 是 localhost 就放行」全部无效。**后一条是关键**：Nginx 如果写了 `Host localhost`，老逻辑会直接放行公网请求。
- 同机代理的请求 socket 也是 loopback，所以 `isLoopbackAddr` 不够。内部接口（隐私中转、`web` / `computer` MCP 回调）额外要 `internalRequest`：Host 是本机，且没有任何转发头。
- 配对：`RemoteService` 的 `closed`，不起监听、不出码、不认旧设备令牌（`meta.json` 里的 `remote.enabled` 不管）；`/pair`、`/api/pair` 一律 404；设置页整段换成「退出登录」，右栏的「手机远程」开关隐藏。IM 的 `/pair` 是另一套，不动。
- 别的电脑也不能再用配对码 / 令牌连进来（联邦的入站）；这台机器主动连别的机器不受影响。
- `/api/health` 只回 `{ok:true}`，不带版本和联邦信息。
- **还开着**：`/p/` 已发布的快照，本来就是公开的。

## 前端

- 登录页由服务端直接输出（`auth/http.ts`），不走 `web/`：未登录的人拿不到前端代码。语言：`ui.language`，没选就跟浏览器的 `Accept-Language`，因为云主机自己的系统语言说明不了什么。
- `WsClient.onDown`：socket 断了问 `/api/auth/status`，确实没登录就 `location.replace('/login')`，否则继续重连。
- 退出后服务端切断这个浏览器的 socket（`dropEndedSessions`），每分钟也扫一次到期的。
- 「退出登录」在设置 → 手机与其它电脑。

## 测试

- `server/src/auth/login.test.ts`：账号文件、会话、锁定、代理请求的判断。
- `server/ws-login.mjs`：真起服务（临时 HOME），按 Nginx 转发的样子发请求，走完整个流程。先清环境变量（见 CLAUDE.md）。

## 没做

多用户、两步验证、注册、网页改密码、内置 HTTPS。要防得更严，在云主机防火墙上限制来源 IP，不用改代码。
