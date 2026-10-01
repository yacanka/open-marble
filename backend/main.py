"""
MarbleOS Backend — FastAPI proxy to the SHARP Gradio app running on port 7860.

Run with:
    uvicorn main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from contextlib import suppress
import shutil
import traceback
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from gradio_client import Client, handle_file
from starlette.concurrency import run_in_threadpool

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("marbleos")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
GRADIO_URL = "http://localhost:7860"

UPLOADS_DIR = Path(__file__).resolve().parent / "uploads"
OUTPUTS_DIR = Path(__file__).resolve().parent / "outputs"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"]
ALLOWED_TRAJECTORIES = {"swipe", "shake", "rotate", "rotate_forward"}
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 25 * 1024 * 1024

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="MarbleOS API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3080",
        "http://localhost:3090",
        "http://127.0.0.1:3080",
        "http://127.0.0.1:3090",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve generated .ply / .mp4 files
app.mount("/files", StaticFiles(directory=str(OUTPUTS_DIR)), name="files")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _extract_file_path(value: Any) -> str | None:
    """Extract a local output path from Gradio's possible file payload shapes."""
    if isinstance(value, Path):
        return str(value)

    if isinstance(value, str):
        return value

    if isinstance(value, dict):
        # Component updates wrap FileData as {"value": {"path": "..."}}.
        for key in ("path", "value", "video"):
            if key not in value:
                continue
            path = _extract_file_path(value[key])
            if path:
                return path

    if isinstance(value, (list, tuple)):
        for item in value:
            path = _extract_file_path(item)
            if path:
                return path

    return None


def _copy_output(source_value: Any, destination: Path, expected_suffix: str) -> bool:
    source_path = _extract_file_path(source_value)
    if not source_path:
        return False

    source = Path(source_path)
    if source.suffix.lower() != expected_suffix or not source.is_file():
        logger.warning(
            "Invalid %s output path from Gradio: %s", expected_suffix, source
        )
        return False

    shutil.copy2(source, destination)
    return True


def _validate_generation_options(
    trajectory_type: str,
    num_frames: int,
    fps: int,
    output_resolution: int,
) -> None:
    if trajectory_type not in ALLOWED_TRAJECTORIES:
        raise HTTPException(status_code=400, detail="Unsupported camera trajectory")
    if not 24 <= num_frames <= 120:
        raise HTTPException(status_code=400, detail="num_frames must be between 24 and 120")
    if not 8 <= fps <= 60:
        raise HTTPException(status_code=400, detail="fps must be between 8 and 60")
    if output_resolution not in {0, 512, 1024}:
        raise HTTPException(
            status_code=400,
            detail="output_resolution must be 0, 512, or 1024",
        )


async def _save_upload(image: UploadFile, upload_path: Path) -> str:
    ext = Path(image.filename or "upload.png").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {ext or 'unknown'}. Allowed: {allowed}",
        )

    content = await image.read(MAX_IMAGE_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded image is empty")
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Each image must be smaller than {MAX_IMAGE_BYTES // (1024 * 1024)} MB",
        )

    upload_path.with_suffix(ext).write_bytes(content)
    return ext


def _report_status(status: Any, report: Callable[..., None]) -> None:
    log = getattr(status, "log", None)
    if log and log[0].startswith("OpenMarble progress: "):
        report("model", log[0].removeprefix("OpenMarble progress: "),
               step_progress=None, step_index=None, step_total=None, unit="steps")
    if status.rank is not None and status.code.value == "IN_QUEUE":
        report("queued", "Waiting for the SHARP worker", queue_position=status.rank + 1,
               eta_seconds=status.eta)
    for unit in status.progress_data or []:
        fraction = unit.progress
        if fraction is None and unit.length and unit.index is not None:
            fraction = unit.index / unit.length
        report("model", unit.desc or "Processing image", step_progress=fraction,
               step_index=unit.index, step_total=unit.length, unit=unit.unit)


async def _await_generation(job: Any, report: Callable[..., None]) -> Any:
    try:
        async for update in job:
            if update.type == "status":
                _report_status(update, report)
        return await run_in_threadpool(job.result)
    except asyncio.CancelledError:
        await run_in_threadpool(job.cancel)
        raise


async def _run_generation(
    client: Client,
    upload_path: Path,
    scene_id: str,
    source_filename: str,
    render_video: bool,
    trajectory_type: str,
    num_frames: int,
    fps: int,
    output_resolution: int,
    report: Callable[..., None] = lambda *_args, **_kwargs: None,
) -> dict[str, Any]:
    logger.info(
        "Calling /run_sharp for %s — trajectory=%s, resolution=%s, "
        "frames=%s, fps=%s, render_video=%s",
        source_filename,
        trajectory_type,
        output_resolution,
        num_frames,
        fps,
        render_video,
    )

    report("submitting", "Sending image to SHARP")
    job = await run_in_threadpool(
        lambda: client.submit(
            image_path=handle_file(str(upload_path)),
            trajectory_type=trajectory_type,
            output_long_side=output_resolution,
            num_frames=num_frames,
            fps=fps,
            render_video=render_video,
            api_name="/run_sharp",
        )
    )
    result = await _await_generation(job, report)
    report("saving", "Saving the 3D scene and preview files")

    if not isinstance(result, (list, tuple)) or len(result) < 3:
        raise RuntimeError("SHARP returned an unexpected response")

    video_result, ply_result, status_msg = result[:3]
    if "error" in str(status_msg).lower():
        raise RuntimeError(f"SHARP could not process {source_filename}: {status_msg}")

    ply_filename = f"{scene_id}.ply"
    ply_destination = OUTPUTS_DIR / ply_filename
    if not _copy_output(ply_result, ply_destination, ".ply"):
        raise RuntimeError(f"SHARP did not produce a usable 3D scene for {source_filename}")

    thumbnail_filename = f"{scene_id}{upload_path.suffix.lower()}"
    thumbnail_destination = OUTPUTS_DIR / thumbnail_filename
    shutil.copy2(upload_path, thumbnail_destination)

    video_filename = f"{scene_id}.mp4"
    video_destination = OUTPUTS_DIR / video_filename
    has_video = _copy_output(video_result, video_destination, ".mp4")

    if render_video and not has_video:
        report("warning", "3D scene ready; video preview was not produced (rendering requires CUDA)")

    return {
        "id": scene_id,
        "ply_url": f"http://localhost:8000/files/{ply_filename}",
        "ply_filename": ply_filename,
        "video_url": (
            f"http://localhost:8000/files/{video_filename}" if has_video else None
        ),
        "thumbnail_url": f"http://localhost:8000/files/{thumbnail_filename}",
        "source_filename": source_filename,
    }


@app.get("/api/health")
async def health():
    try:
        client = Client(GRADIO_URL)
        _ = client.view_api(print_info=False)
        return {"status": "ok", "gradio_connected": True}
    except Exception:
        return {"status": "degraded", "gradio_connected": False}


async def _generate_batch(
    images: list[UploadFile] | None = File(default=None),
    image: UploadFile | None = File(default=None),
    render_video: bool = True,
    trajectory_type: str = "rotate_forward",
    num_frames: int = 60,
    fps: int = 30,
    output_resolution: int = 0,
    report: Callable[..., None] = lambda *_args, **_kwargs: None,
):
    uploads = list(images or [])
    if image is not None:
        uploads.append(image)
    if not uploads:
        raise HTTPException(status_code=400, detail="Upload at least one image")
    if len(uploads) > MAX_IMAGES:
        raise HTTPException(
            status_code=400,
            detail=f"You can upload up to {MAX_IMAGES} images at once",
        )

    _validate_generation_options(
        trajectory_type, num_frames, fps, output_resolution
    )

    report("received", f"Received {len(uploads)} image(s)", image_count=len(uploads))
    batch_id = uuid.uuid4().hex[:12]
    try:
        report("connecting", "Connecting to the SHARP service")
        logger.info("Connecting to Gradio at %s", GRADIO_URL)
        client = await run_in_threadpool(Client, GRADIO_URL)
    except Exception:
        logger.error("Could not connect to SHARP:\n%s", traceback.format_exc())
        raise HTTPException(
            status_code=503,
            detail="The 3D generation service is unavailable. Start the SHARP service and try again.",
        )

    scenes: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    error_status_codes: list[int] = []

    for index, upload in enumerate(uploads):
        scene_id = batch_id if len(uploads) == 1 else f"{batch_id}-{index + 1}"
        source_filename = Path(
            upload.filename or f"image-{index + 1}.png"
        ).name.replace("\n", " ")[:255]
        upload_path_without_suffix = UPLOADS_DIR / scene_id
        upload_path: Path | None = None

        def report_image(stage: str, message: str, **details: Any) -> None:
            report(stage, message, image_index=index + 1, filename=source_filename,
                   image_count=len(uploads), **details)

        try:
            report_image("validating", "Validating and preparing image")
            ext = await _save_upload(upload, upload_path_without_suffix)
            upload_path = upload_path_without_suffix.with_suffix(ext)
            logger.info(
                "Saved upload %d/%d: %s", index + 1, len(uploads), upload_path
            )
            scene = await _run_generation(
                client=client,
                upload_path=upload_path,
                scene_id=scene_id,
                source_filename=source_filename,
                render_video=render_video,
                trajectory_type=trajectory_type,
                num_frames=num_frames,
                fps=fps,
                output_resolution=output_resolution,
                report=report_image,
            )
            scenes.append(scene)
            report_image("image_completed", "3D scene saved", completed_count=len(scenes))
        except HTTPException as error:
            errors.append({"filename": source_filename, "message": str(error.detail)})
            error_status_codes.append(error.status_code)
            report_image("image_error", str(error.detail))
        except Exception:
            logger.error(
                "Generation failed for %s:\n%s", source_filename, traceback.format_exc()
            )
            message = "SHARP could not process this image. Check the service logs and try again."
            errors.append({"filename": source_filename, "message": message})
            report_image("image_error", message)
            error_status_codes.append(500)
        finally:
            if upload_path is not None:
                upload_path.unlink(missing_ok=True)

    if not scenes:
        detail = errors[0]["message"] if errors else "Generation failed"
        status_code = (
            error_status_codes[0]
            if error_status_codes and len(set(error_status_codes)) == 1
            else 500
        )
        raise HTTPException(status_code=status_code, detail=detail)

    first_scene = scenes[0]
    logger.info(
        "Generated %d/%d scene layers for batch %s",
        len(scenes),
        len(uploads),
        batch_id,
    )
    return JSONResponse(
        {
            "id": batch_id,
            "scenes": scenes,
            "errors": errors,
            # Preserve the original single-image response contract.
            "ply_url": first_scene["ply_url"],
            "ply_filename": first_scene["ply_filename"],
            "video_url": first_scene["video_url"],
            "thumbnail_url": first_scene["thumbnail_url"],
        }
    )


@app.post("/api/generate")
async def generate(
    images: list[UploadFile] | None = File(default=None),
    image: UploadFile | None = File(default=None),
    render_video: bool = True,
    trajectory_type: str = "rotate_forward",
    num_frames: int = 60,
    fps: int = 30,
    output_resolution: int = 0,
    stream: bool = False,
):
    """Generate scenes; opt into newline-delimited JSON progress with stream=true.

    Streams end with exactly one result or error event. Heartbeats keep long
    inference steps observable without inventing percentage or time estimates.
    """
    options = dict(images=images, image=image, render_video=render_video,
                   trajectory_type=trajectory_type, num_frames=num_frames,
                   fps=fps, output_resolution=output_resolution)
    if not stream:
        return await _generate_batch(**options)

    async def events():
        queue: asyncio.Queue = asyncio.Queue()
        started = time.monotonic()
        previous = None

        def report(stage: str, message: str, **details: Any) -> None:
            nonlocal previous
            event = dict(type="progress", stage=stage, message=message, **details)
            if event == previous:
                return
            previous = event
            queue.put_nowait({**event, "elapsed_seconds": time.monotonic() - started})

        async def produce():
            try:
                response = await _generate_batch(**options, report=report)
                queue.put_nowait(dict(type="result", result=json.loads(response.body)))
            except HTTPException as error:
                queue.put_nowait(dict(type="error", message=str(error.detail)))
            except Exception:
                logger.exception("Generation stream failed")
                queue.put_nowait(dict(type="error", message="Generation failed. Please try again."))

        task = asyncio.create_task(produce())
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=10)
                except asyncio.TimeoutError:
                    event = dict(type="heartbeat", elapsed_seconds=time.monotonic() - started)
                yield json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n"
                if event["type"] in {"result", "error"}:
                    break
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/gallery")
async def gallery():
    items = []
    for ply in sorted(
        OUTPUTS_DIR.glob("*.ply"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    ):
        # Resolve thumbnail by finding a same-stem image file in outputs/.
        # e.g. abc123.ply → abc123.jpg (or .png, .webp, .jpeg)
        thumbnail_url = None
        for img_ext in IMAGE_EXTENSIONS:
            candidate = OUTPUTS_DIR / f"{ply.stem}{img_ext}"
            if candidate.exists():
                thumbnail_url = f"http://localhost:8000/files/{candidate.name}"
                break

        video_url = None
        video_candidate = OUTPUTS_DIR / f"{ply.stem}.mp4"
        if video_candidate.exists():
            video_url = f"http://localhost:8000/files/{video_candidate.name}"

        items.append(
            {
                "id": ply.stem,
                "ply_url": f"http://localhost:8000/files/{ply.name}",
                "ply_filename": ply.name,
                "created_at": ply.stat().st_mtime,
                "thumbnail_url": thumbnail_url,
                "video_url": video_url,
            }
        )
    return {"items": items}


@app.get("/api/worlds")
async def worlds():
    """Return all generated worlds that have both a .mp4 preview and a .ply file."""
    items = []
    for mp4 in sorted(
        OUTPUTS_DIR.glob("*.mp4"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    ):
        ply = OUTPUTS_DIR / f"{mp4.stem}.ply"
        if not ply.exists():
            continue

        thumbnail_url = None
        for img_ext in IMAGE_EXTENSIONS:
            candidate = OUTPUTS_DIR / f"{mp4.stem}{img_ext}"
            if candidate.exists():
                thumbnail_url = f"http://localhost:8000/files/{candidate.name}"
                break

        items.append(
            {
                "id": mp4.stem,
                "ply_url": f"http://localhost:8000/files/{ply.name}",
                "video_url": f"http://localhost:8000/files/{mp4.name}",
                "thumbnail_url": thumbnail_url,
                "created_at": mp4.stat().st_mtime,
            }
        )
    return {"items": items}
