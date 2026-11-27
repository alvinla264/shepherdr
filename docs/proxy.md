# Behind nginx and Authelia

Shepherdr serves on this machine's loopback and knows nothing about a domain until you tell it. This page is the shape
where a browser reaches it through WireGuard to a VPS, nginx terminating TLS for a domain, and Authelia in front;
it is supported on purpose, not by luck.

```text
phone ──WireGuard──► VPS ──nginx (TLS, Authelia)──► 127.0.0.1:7787 ──► herdr and the agents
```

The app sits on the VPS (or on a machine reached from it), and nginx is its only public way in. WireGuard protects the
hop from the phone to the VPS; it does not protect what the VPS itself sees (see [Security](#security)).

## What the app expects of the proxy

- **The connection comes from the proxy's own address.** In Settings → Web, `web.proxy` names it (`127.0.0.1` when
  nginx is on the same machine, else the WireGuard address it reaches the app from). Forwarded headers count only from
  that address. A client that can reach the port directly cannot make `X-Forwarded-Host` mean anything, whatever it
  sends.
- **The proxy overwrites the forwarded headers, never appends.** `X-Forwarded-Host`, `X-Forwarded-For` and
  `X-Forwarded-Proto` are set from nginx's own values, so a client-supplied header never reaches the app. The app reads
  the first value of each.
- **The WebSocket locations are behind the same gate as everything else.** An `/api/ws` that upgrades without
  `auth_request` is an authentication bypass, and it looks like it works.
- **Long waits are not cut.** The live link, `shepherdr checks` (it waits on GitHub), voice calls and the Browser
  panel stay open longer than nginx's default 60 seconds.
- **Uploads fit.** Files and pictures in a chat go through `client_max_body_size`.
- **The app's path is passed through as it is.** A subpath works: the page addresses everything relatively
  (`api/action`, `api/ws`) and the server strips whatever comes before `/api/`. nginx must not rewrite the prefix away.

## nginx

One server block for the domain. The `map` goes in nginx's `http` block.

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  http2 on;
  server_name shep.example.com;

  ssl_certificate     /etc/letsencrypt/live/shep.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/shep.example.com/privkey.pem;

  # Shepherdr's own host, and the host the browser asked for. Overwrite, never append: a client-supplied
  # X-Forwarded-Host poisons the same-origin check and every link Shepherdr writes.
  proxy_set_header Host              $host;
  proxy_set_header X-Forwarded-Host  $host;
  proxy_set_header X-Forwarded-For   $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;

  # WebSockets (the live link, voice, the Browser panel) and the long waits behind them
  proxy_http_version 1.1;
  proxy_set_header Upgrade    $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  proxy_buffering off;

  # files and pictures in a chat, and an artifact's page
  client_max_body_size 64m;

  location / {
    auth_request /authelia/api/verify;
    auth_request_set $user $upstream_http_remote_user;
    proxy_pass http://127.0.0.1:7787;
  }

  # the login gate itself, reachable without a session
  location /authelia/ {
    proxy_pass http://127.0.0.1:9091/;
  }

  # an installed app fetches these itself, with no page behind them: the manifest (with the page's cookie,
  # crossorigin="use-credentials") and the service worker (same-origin, with the cookie) must reach the app, not a
  # sign-in page, or the home-screen install fails and alerts cannot subscribe. They carry no data of yours.
  location = /manifest.webmanifest { auth_request off; proxy_pass http://127.0.0.1:7787; }
  location = /sw.js                { auth_request off; proxy_pass http://127.0.0.1:7787; }
  location ^~ /icon-               { auth_request off; proxy_pass http://127.0.0.1:7787; }
  location ^~ /splash/             { auth_request off; proxy_pass http://127.0.0.1:7787; }
  location ^~ /assets/             { auth_request off; proxy_pass http://127.0.0.1:7787; }
}
```

The `location /` above already carries `auth_request` and the upgrade headers for `/api/ws`, `/api/voice` and
`/api/browser`. If you split those into their own `location` blocks, give each one **both**: an upgrade block without
`auth_request` is an open door, and an `auth_request` without upgrade headers leaves the live link frozen.

### Authelia

Authelia v4 verifies with a forwarded-auth request. Add the verify endpoint to the same server block (or a `server`
shared by all your apps):

```nginx
location = /authelia/api/verify {
  internal;
  proxy_pass http://127.0.0.1:9091/api/verify?rd=https://auth.example.com/;
  proxy_set_header X-Original-URL      $scheme://$http_host$request_uri;
  proxy_set_header X-Original-Method   $request_method;
  proxy_set_header X-Forwarded-Proto   $scheme;
  proxy_set_header X-Forwarded-Host    $http_host;
  proxy_set_header X-Forwarded-For     $remote_addr;
  proxy_set_header Content-Length      "";
  proxy_pass_request_body off;
}
```

In Authelia's `configuration.yml`, list the domain and the policy you want — this gate is your only login, so make it
multi-factor:

```yaml
access_control:
  default_policy: deny
  rules:
    - domain: shep.example.com
      policy: two_factor
```

No session is `401`. Safari and Chrome will follow a `302` to the login page for a page load, but not for the
WebSocket handshake or an XHR, so sign in in that browser before opening the app: the cookie then rides along on the
page, its API calls, the WebSocket and the service worker.

## Caddy

For comparison, the same shape. Caddy upgrades WebSockets by itself and sets the forwarded headers from the real
connection, so there is less to get wrong:

```caddyfile
shep.example.com {
  encode zstd gzip

  # the login gate's own endpoints
  handle /authelia/* {
    reverse_proxy 127.0.0.1:9091
  }

  # install and alerts: no page behind them
  @install path /manifest.webmanifest /sw.js /icon-* /splash/* /assets/*
  handle @install {
    reverse_proxy 127.0.0.1:7787
  }

  handle {
    forward_auth 127.0.0.1:9091 {
      uri /api/verify?rd=https://auth.example.com/
      copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
    }
    reverse_proxy 127.0.0.1:7787 {
      # overwrite, never append
      header_up X-Forwarded-Host  {host}
      header_up X-Forwarded-For   {remote_host}
      header_up X-Forwarded-Proto {scheme}
      transport http {
        read_timeout 1h
        write_timeout 1h
      }
    }
  }
}
```

## Settings

Two keys, each machine's own (Settings → Web, or `shepherdr set`):

- `web.proxy` — the proxy's address (`off` by default). `127.0.0.1`, or a WireGuard address, or a network:
  `10.8.0.0/24`. Forwarded headers from that address are believed; from anywhere else they are ignored.
- `web.publicUrl` — the address links use, `https://shep.example.com`. Empty by default: the trusted proxy's
  `X-Forwarded-Host` is used instead. Set it when the proxy's host and the address you open are not the same (a port
  forward, a second name).

```sh
shepherdr set web.proxy 127.0.0.1 --machine
shepherdr set web.publicUrl https://shep.example.com --machine
```

`web.proxy` is what makes [the same-origin check](../server/app.ts) and `local:`-style decisions agree with the browser.
Secret access does not change: `shepherdr secret run` still needs the session's own credential, and no forwarded header
grants it.

### Under a subpath

A subpath (`https://example.com/shepherdr/`) works: the app addresses its API and WebSocket relatively and the server
strips the prefix before `/api/`. nginx only has to pass the path through as it is:

```nginx
location /shepherdr/ {
  auth_request /authelia/api/verify;
  proxy_pass http://127.0.0.1:7787;   # no trailing slash on either side: the prefix stays
}
```

Set `web.publicUrl` to the whole address including the path (`https://example.com/shepherdr`) so links and alerts land
there.

## When it doesn't work, check this

Run `shepherdr doctor` on the main machine first. Its `Web:` line says whether the app is reached through the proxy,
the host it was asked for, whether the live link has been upgrading, and whether the proxy's address and headers agree.

| What you see | What to check |
| --- | --- |
| `Web: the proxy … is configured, but the last request came from … directly` | nginx connects from another address (the WireGuard one) — put that in `web.proxy`. |
| `Web: through the proxy …, but it sends no X-Forwarded-Host` | the `proxy_set_header X-Forwarded-Host $host;` line is missing, or a client header was appended. |
| The screen says *Live updates aren't getting through* | `proxy_set_header Upgrade`/`Connection`, and `auth_request` on `/api/ws` answering `401`, not redirecting. |
| Actions answer 403 | `X-Forwarded-Host` does not match the address in the address bar, or `web.proxy` is not set. |
| Links open `127.0.0.1` | `X-Forwarded-Host` is missing or `web.publicUrl` is empty. |
| `shepherdr checks` or a voice call cuts off | `proxy_read_timeout`/`proxy_send_timeout` are still 60s. |
| A big file in a chat fails | `client_max_body_size`. |
| The app cannot be added to the home screen, or alerts cannot subscribe | the manifest or `sw.js` is answered by the sign-in page. |

Browser DevTools → Network says it clearest: `/api/ws` is `101 Switching Protocols` when the live link is right, and
anything else (a `200` sign-in page, a `302`, a `400`) means the proxy is not upgrading it.

## Security

- **TLS ends at the proxy, so the proxy sees everything in clear.** Passwords, agent output, file uploads and secrets
  used by agents all pass through the VPS; WireGuard protects the phone-to-VPS hop, not the VPS itself. If that matters,
  keep nginx and Authelia at home and reach them over WireGuard, and use the VPS only as a relay.
- **Anyone through the gate has full control of the app.** It starts agents, runs commands in your spaces and merges
  pull requests. The gate is not a password on a read-only page: use Authelia's MFA (`two_factor`, or `webauthn`),
  a separate user for this app, and its own session timeout.
- **Finished apps check the WebSocket as well.** A location that upgrades `/api/ws` without the gate is an
  unauthenticated live feed of your agents' work, and a client that upgrades but skips the gate looks like it works.
- **The forwarded headers are not authority.** `web.proxy` makes them *believable*, and `local:` follows; it never makes
  a caller authenticated for secrets. `shepherdr secret run` needs the session's own credential, from any address.
