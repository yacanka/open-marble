# MarbleOS

> *Imagining a World* — a spatial computing interface for turning images into explorable 3D worlds.


## Vision

MarbleOS is an experiment in what a personal spatial OS might look like if it were built around generative 3D. Upload a photo, and MarbleOS reconstructs it as a navigable Gaussian Splat — viewable, shareable, and editable right in the browser. The interface takes its aesthetic cues from visionOS: glassmorphism, depth, spring animations, and a window-based app model.

The goal is to make 3D scene generation feel as natural as taking a photo. You
can provide up to four images; OpenMarble reconstructs each image and arranges
the resulting layers from left to right as a wider scene.

![How To Frame It for Maximum Impact](frontend/public/chatgpt-moment.png)

## Architecture

The project is organized into three layers:

```
frontend/       Next.js 16 — VisionOS-style shell + MarbleOS app
backend/        FastAPI — wraps Apple SHARP for inference
supersplat/     Gaussian Splat editor (embedded via iframe)
```

**Frontend** (`localhost:3080`) — a Next.js app built on the `vision-ui` template. The home grid launches individual apps; MarbleOS lives at `/openmarble` with Create and Gallery tabs. State is managed with Jotai atoms (`lib/marble-atoms.ts`). UI components follow the VisionOS design system: `Material`, `Ornament`, `Stack`, spring-based motion.

**Backend** (`localhost:8000`) — a FastAPI server (`backend/main.py`) that accepts an image, runs it through Apple's SHARP model, and returns a `.ply` Gaussian Splat file and a preview `.mp4`. The SHARP model lives in `Apple-Sharp-Image-to-3D-View-Synthesis/` and is imported via `sys.path` without code duplication.

**SuperSplat** (`localhost:3090`) — an open-source Gaussian Splat editor embedded as an iframe. Receives the generated `.ply` via a `?load=<url>` query parameter for in-browser 3D inspection.

### Data flow

```
User uploads image
  → POST /api/generate (FastAPI)
  → Apple SHARP model → .ply + .mp4
  → SuperSplat iframe loads .ply via URL
  → Gallery tab stores and lists past generations
```

### Live generation report

The Create screen streams actual SHARP progress: upload confirmation, queue
position and queue estimate when available, checkpoint cache/download/loading,
compute device, image dimensions and reconstruction, PLY export, and optional
video rendering. It lists each image, elapsed time, remaining image count, and
a timestamped activity log. Percentages and step estimates appear only when the
worker provides measurable progress; unknown durations stay explicitly unknown.
Partial failures remain on screen so successful scenes can still be opened.

`POST /api/generate?stream=true` returns newline-delimited JSON: `progress`,
`heartbeat` (every ten seconds while idle), and one terminal `result` or `error`.
Without `stream=true`, the existing JSON response contract is unchanged. Restart
both SHARP and the backend after updating their progress instrumentation.
The backend requires FastAPI 0.118+ to keep request resources alive during
streaming ([lifecycle details](https://fastapi.tiangolo.com/advanced/advanced-dependencies/#dependencies-with-yield-and-streamingresponse-technical-details))
and gradio_client 2.7+ for retained asynchronous status and milestone events.

## Running locally

### One-click startup (macOS)

Double-click `start.command` in Finder. The script installs missing project
dependencies, starts SHARP, the backend, SuperSplat, and the frontend, waits for
their health checks, then opens `http://localhost:3080/openmarble`.

Node.js 22+, `npm`, `uv`, and `curl` must be available on the machine. Keep the
opened Terminal window running. Press `Control+C` in that window to stop every
service started by the script.

The same script can be run from a terminal:

```bash
./start.command
```

Set `OPEN_BROWSER=0` to start without opening a browser:

```bash
OPEN_BROWSER=0 ./start.command
```

### Manual startup

```bash
# SHARP inference service (first run downloads the ~2.8 GB model checkpoint)
cd Apple-Sharp-Image-to-3D-View-Synthesis
uv sync --locked
MPLCONFIGDIR=/tmp/openmarble-matplotlib-cache .venv/bin/python app.py  # :7860

# Backend
cd ../backend
uv venv .venv --python 3.13
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000

# SuperSplat
cd ../supersplat
npm install
npm run build
./node_modules/.bin/serve dist -l 3090 -C

# Frontend
cd ../frontend
npm install
NEXT_PUBLIC_URL=http://localhost:3080 \
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000 \
NEXT_PUBLIC_SUPERSPLAT_URL=http://localhost:3090 \
npm run dev
```

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See [`frontend/LICENSE.md`](frontend/LICENSE.md) for the full text.

In short: you are free to use, modify, and distribute this software, but any modified version deployed over a network must also make its source code available under the same license.

## Acknowledgements

- **[vision-ui](https://github.com/ibelick/vision-ui)** — the visionOS-inspired React component system and app shell that forms the frontend foundation.
- **[Apple SHARP](https://github.com/apple/ml-vision-view-synthesis)** — *Spatial High-fidelity Adaptive Rendering Pipeline*, Apple's model for single-image 3D Gaussian Splat reconstruction.
- **[SuperSplat](https://github.com/playcanvas/supersplat)** — the open-source Gaussian Splat editor by PlayCanvas, embedded for in-browser 3D viewing and editing.
