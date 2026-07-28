# Sharing your local instance with a public link

Quick way to let someone outside your network try the app running on your
machine, using [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/tunnel-guide/local/quick-tunnels/)
— no account, no signup, no ngrok authtoken required.

> These are anonymous, ephemeral tunnels: no uptime guarantee, and the URL
> changes every time you start a new tunnel. Fine for demos; not for
> production.

## Why two tunnels

The frontend's `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` are baked into the
browser bundle at **build time** and resolved in the *visitor's* browser — not
on your machine. So exposing only the frontend leaves remote visitors' API
and WebSocket calls pointed at their own `localhost:8080`, which fails. You
need a public URL for the backend too, and the frontend must be rebuilt to
point at it.

## One-time setup

Install `cloudflared` locally (no `sudo` needed):

```bash
mkdir -p ~/.local/bin
curl -sL -o ~/.local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/.local/bin/cloudflared
```

## Every time you want to share a link

1. **Bring up the stack** (if it isn't already running):
   ```bash
   docker compose up -d
   ```

2. **Start the backend tunnel** and note its URL:
   ```bash
   cloudflared tunnel --url http://localhost:8080
   ```
   Look for a line like:
   ```
   https://<random-words>.trycloudflare.com
   ```

3. **Rebuild the frontend pointing at that backend URL**, and allow it in
   backend CORS. Don't edit `docker-compose.yml` — use an override file kept
   outside the repo:

   ```yaml
   # /tmp/tunnel.yml
   services:
     frontend:
       environment:
         - NEXT_PUBLIC_API_URL=https://<backend-tunnel-url>
         - NEXT_PUBLIC_WS_URL=wss://<backend-tunnel-url>
     backend:
       environment:
         - ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,https://<frontend-tunnel-url>
   ```

   You won't know the frontend tunnel URL until step 4, so start the backend
   tunnel first (step 2), start the frontend tunnel (step 4) to get its URL,
   *then* fill in both URLs above and run:

   ```bash
   docker compose -f docker-compose.yml -f /tmp/tunnel.yml up -d --build frontend backend
   ```

4. **Start the frontend tunnel**:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   The printed `https://<random-words>.trycloudflare.com` URL is what you
   share with others.

5. **Verify** both tunnels actually forward traffic before sharing:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://<backend-tunnel-url>/
   curl -s -o /dev/null -w "%{http_code}\n" https://<frontend-tunnel-url>/
   ```
   Both should print `200`.

## Keeping it running

- Both `cloudflared` processes must keep running (e.g. `nohup ... &`, or a
  separate terminal/tmux pane) for as long as you want the link to work.
- Your machine must stay powered on and connected.
- If a tunnel process dies, restarting it gives you a **new** URL — repeat
  from step 2 (backend) and re-rebuild the frontend with the new URL.

## Tearing down

```bash
pkill cloudflared        # stop both tunnels
docker compose down      # optional: stop the app stack too
```
