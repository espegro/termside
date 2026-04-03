# termside

`termside` is a self-contained Go app for sharing a local `tmux` view on your LAN.

It starts a small web server on a high local port, prints a QR code in the terminal, and exposes a read-only browser view of a selected `tmux` target. The browser UI is designed for tablets and phones, follows the actual `tmux` pane layout, and updates live over SSE.

## What it does

- Starts a local web server on an automatically selected high port
- Detects a usable LAN IP automatically
- Generates a random secret and includes it in the share URL
- Prints the share URL as an ASCII QR code in the terminal
- Lets iPads, phones, and laptops open the tmux view in a browser
- Shows the real pane layout from the selected `tmux` window
- Supports multiple simultaneous viewers, each with their own selected target
- Can run over plain HTTP or HTTPS with a self-signed certificate

## Current model

- Read-only browser access
- One selected `tmux` target per web client
- If the selected target is a `tmux` window, all panes in that window are mirrored together
- If the selected target is a single pane, only that pane is shown

## Requirements

- Linux
- Go 1.22+
- `tmux` installed and running

## Build

```bash
go build ./cmd/termside
```

## Run

Basic usage:

```bash
./termside
```

With HTTPS and a self-signed certificate:

```bash
./termside --https
```

Target a specific tmux server name:

```bash
./termside --tmux-name dev
```

Target a specific tmux socket:

```bash
./termside --tmux-socket /tmp/tmux-build.sock
```

Use a specific bind IP or port:

```bash
./termside --bind-ip 192.168.1.114 --port 8088
```

## Flags

- `--bind-ip`: IP address to bind to. If omitted, termside picks a private LAN IPv4 address automatically.
- `--port`: Port to bind to. `0` means auto-select.
- `--refresh`: Base refresh cadence used by the SSE loop.
- `--https`: Serve over HTTPS with an in-memory self-signed certificate.
- `--tmux-name`: Use `tmux -L <name>`.
- `--tmux-socket`: Use `tmux -S <path>`.

## HTTPS notes

When `--https` is enabled, termside generates a temporary self-signed certificate at startup. This protects traffic on the LAN, but the browser will warn about the certificate until it is manually trusted.

This certificate is not written to disk and is regenerated on every launch.

## Browser behavior

- The browser connects with Server-Sent Events for live updates
- Pane layout follows `tmux` geometry
- ANSI colors are preserved
- Cursor position is mirrored for the active pane
- The left sidebar can be resized or collapsed
- Zoom and fullscreen controls are available in the UI

## Shutdown

When the host process is interrupted, connected clients receive a shutdown message before the server exits.

## Development

Run tests:

```bash
go test ./...
```

## Security

The share URL contains a random secret. Anyone with that URL can view the exposed `tmux` target while the process is running.

For trusted home/LAN use, plain HTTP may be acceptable. For less trusted networks, prefer `--https`.
