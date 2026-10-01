"""SHARP inference + optional CUDA video rendering utilities.

Design goals:
- Reuse SHARP's own predict/render pipeline (no subprocess calls).
- Be robust on Hugging Face Spaces + ZeroGPU.
- Cache model weights and predictor construction across requests.

Public API (used by the Gradio app):
- TrajectoryType
- predict_and_maybe_render_gpu(...)
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Final, Literal

import gradio as gr
import torch

try:
    import spaces
except Exception:  # pragma: no cover
    spaces = None  # type: ignore[assignment]

try:
    # Prefer HF cache / Hub downloads (works with Spaces `preload_from_hub`).
    from huggingface_hub import hf_hub_download, try_to_load_from_cache
except Exception:  # pragma: no cover
    hf_hub_download = None  # type: ignore[assignment]
    try_to_load_from_cache = None  # type: ignore[assignment]

from sharp.cli.predict import DEFAULT_MODEL_URL, predict_image
from sharp.cli.render import render_gaussians as sharp_render_gaussians
from sharp.models import PredictorParams, create_predictor
from sharp.utils import camera, io
from sharp.utils.gaussians import Gaussians3D, SceneMetaData, save_ply
from sharp.utils.gsplat import GSplatRenderer

TrajectoryType = Literal["swipe", "shake", "rotate", "rotate_forward"]

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------


def _report(message: str, progress: float | tuple[int, int] | None = None) -> None:
    """Report real milestones in the current Gradio request, including GPU workers."""
    gr.Progress()(progress, desc=message, unit="frames" if isinstance(progress, tuple) else "steps")
    if progress is None:
        # Progress counters are coalesced by Gradio; log events retain short phases.
        gr.Info(f"OpenMarble progress: {message}", visible=False)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _make_even(x: int) -> int:
    return x if x % 2 == 0 else x + 1


def _select_device(preference: str = "auto") -> torch.device:
    """Select the best available device for inference (CPU/CUDA/MPS)."""
    if preference not in {"auto", "cpu", "cuda", "mps"}:
        raise ValueError("device preference must be one of: auto|cpu|cuda|mps")

    if preference == "cpu":
        return torch.device("cpu")
    if preference == "cuda":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if preference == "mps":
        return torch.device("mps" if torch.backends.mps.is_available() else "cpu")

    # auto
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


# -----------------------------------------------------------------------------
# Prediction outputs
# -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PredictionOutputs:
    """Outputs of SHARP inference (plus derived metadata for rendering)."""

    ply_path: Path
    gaussians: Gaussians3D
    metadata_for_render: SceneMetaData
    input_resolution_hw: tuple[int, int]
    focal_length_px: float


# -----------------------------------------------------------------------------
# Patch SHARP VideoWriter to properly close the optional depth writer
# -----------------------------------------------------------------------------


class _PatchedVideoWriter(io.VideoWriter):
    """Ensure depth writer is closed so files can be safely cleaned up."""

    def __init__(
        self, output_path: Path, fps: float = 30.0, render_depth: bool = True,
        *, total_frames: int | None = None
    ) -> None:
        super().__init__(output_path, fps=fps, render_depth=render_depth)
        self._total_frames = total_frames
        self._completed_frames = 0
        # Ensure attribute exists for downstream code paths.
        if not hasattr(self, "depth_writer"):
            self.depth_writer = None  # type: ignore[attribute-defined-outside-init]

    def add_frame(self, *args, **kwargs):
        super().add_frame(*args, **kwargs)
        self._completed_frames += 1
        if self._total_frames:
            _report("Rendering video frames", (self._completed_frames, self._total_frames))

    def close(self):
        _report("Encoding and saving video preview")
        super().close()
        depth_writer = getattr(self, "depth_writer", None)
        try:
            if depth_writer is not None:
                depth_writer.close()
        except Exception:
            pass


@contextmanager
def _patched_sharp_videowriter(num_frames: int):
    """Temporarily patch `sharp.utils.io.VideoWriter` used by `sharp.cli.render`."""
    original = io.VideoWriter
    io.VideoWriter = partial(_PatchedVideoWriter, total_frames=num_frames)  # type: ignore[assignment]
    try:
        yield
    finally:
        io.VideoWriter = original  # type: ignore[assignment]


# -----------------------------------------------------------------------------
# Model wrapper
# -----------------------------------------------------------------------------


class ModelWrapper:
    """Cached SHARP model wrapper for Gradio/Spaces."""

    def __init__(
        self,
        *,
        outputs_dir: str | Path = "outputs",
        checkpoint_url: str = DEFAULT_MODEL_URL,
        checkpoint_path: str | Path | None = None,
        device_preference: str = "auto",
        keep_model_on_device: bool | None = None,
        hf_repo_id: str | None = None,
        hf_filename: str | None = None,
        hf_revision: str | None = None,
    ) -> None:
        self.outputs_dir = _ensure_dir(Path(outputs_dir))
        self.checkpoint_url = checkpoint_url

        env_ckpt = os.getenv("SHARP_CHECKPOINT_PATH") or os.getenv("SHARP_CHECKPOINT")
        if checkpoint_path:
            self.checkpoint_path = Path(checkpoint_path)
        elif env_ckpt:
            self.checkpoint_path = Path(env_ckpt)
        else:
            self.checkpoint_path = None

        # Optional Hugging Face Hub fallback (useful when direct CDN download fails).
        self.hf_repo_id = hf_repo_id or os.getenv("SHARP_HF_REPO_ID", "apple/Sharp")
        self.hf_filename = hf_filename or os.getenv(
            "SHARP_HF_FILENAME", "sharp_2572gikvuh.pt"
        )
        self.hf_revision = hf_revision or os.getenv("SHARP_HF_REVISION") or None

        self.device_preference = device_preference

        # For ZeroGPU, it's safer to not keep large tensors on CUDA across calls.
        if keep_model_on_device is None:
            keep_env = (
                os.getenv("SHARP_KEEP_MODEL_ON_DEVICE")
            )
            self.keep_model_on_device = keep_env == "1"
        else:
            self.keep_model_on_device = keep_model_on_device

        self._lock = threading.RLock()
        self._predictor: torch.nn.Module | None = None
        self._predictor_device: torch.device | None = None
        self._state_dict: dict | None = None

    def has_cuda(self) -> bool:
        return torch.cuda.is_available()

    def _load_state_dict(self) -> dict:
        with self._lock:
            if self._state_dict is not None:
                _report("Using cached SHARP model weights")
                return self._state_dict

            # 1) Explicit local checkpoint path
            if self.checkpoint_path is not None:
                try:
                    _report("Loading SHARP model weights from local checkpoint")
                    self._state_dict = torch.load(
                        self.checkpoint_path,
                        weights_only=True,
                        map_location="cpu",
                    )
                    return self._state_dict
                except Exception as e:
                    raise RuntimeError(
                        "Failed to load SHARP checkpoint from local path.\n\n"
                        f"Path:\n  {self.checkpoint_path}\n\n"
                        f"Original error:\n  {type(e).__name__}: {e}"
                    ) from e

            _report("Checking the SHARP model cache")
            # 2) HF cache (no-network): best match for Spaces `preload_from_hub`.
            hf_cache_error: Exception | None = None
            if try_to_load_from_cache is not None:
                try:
                    cached = try_to_load_from_cache(
                        repo_id=self.hf_repo_id,
                        filename=self.hf_filename,
                        revision=self.hf_revision,
                        repo_type="model",
                    )
                except TypeError:
                    cached = try_to_load_from_cache(self.hf_repo_id, self.hf_filename)  # type: ignore[misc]

                try:
                    if isinstance(cached, str) and Path(cached).exists():
                        _report("Loading cached SHARP model weights into memory")
                        self._state_dict = torch.load(
                            cached, weights_only=True, map_location="cpu"
                        )
                        return self._state_dict
                except Exception as e:
                    hf_cache_error = e

            # 3) HF Hub download (reuse cache when available; may download otherwise).
            hf_error: Exception | None = None
            if hf_hub_download is not None:
                # Attempt "local only" mode if supported (avoids network).
                try:
                    import inspect

                    if "local_files_only" in inspect.signature(hf_hub_download).parameters:
                        ckpt_path = hf_hub_download(
                            repo_id=self.hf_repo_id,
                            filename=self.hf_filename,
                            revision=self.hf_revision,
                            local_files_only=True,
                        )
                        if Path(ckpt_path).exists():
                            _report("Loading cached SHARP model weights into memory")
                            self._state_dict = torch.load(
                                ckpt_path, weights_only=True, map_location="cpu"
                            )
                            return self._state_dict
                except Exception:
                    pass

                try:
                    _report("Downloading SHARP model weights if missing; first use may take several minutes")
                    ckpt_path = hf_hub_download(
                        repo_id=self.hf_repo_id,
                        filename=self.hf_filename,
                        revision=self.hf_revision,
                    )
                    _report("Loading downloaded SHARP model weights into memory")
                    self._state_dict = torch.load(
                        ckpt_path,
                        weights_only=True,
                        map_location="cpu",
                    )
                    return self._state_dict
                except Exception as e:
                    hf_error = e

            # 4) Default upstream CDN (torch hub cache). Last resort.
            url_error: Exception | None = None
            try:
                _report("Loading SHARP weights from the fallback model source")
                self._state_dict = torch.hub.load_state_dict_from_url(
                    self.checkpoint_url,
                    progress=True,
                    map_location="cpu",
                )
                return self._state_dict
            except Exception as e:
                url_error = e

            # If we got here: all options failed.
            hint_lines = [
                "Failed to load SHARP checkpoint.",
                "",
                "Tried (in order):",
                f"  1) HF cache (preload_from_hub): repo_id={self.hf_repo_id}, filename={self.hf_filename}, revision={self.hf_revision or 'None'}",
                f"  2) HF Hub download: repo_id={self.hf_repo_id}, filename={self.hf_filename}, revision={self.hf_revision or 'None'}",
                f"  3) URL (torch hub): {self.checkpoint_url}",
                "",
                "If network access is restricted, set a local checkpoint path:",
                "  - SHARP_CHECKPOINT_PATH=/path/to/sharp_2572gikvuh.pt",
                "",
                "Original errors:",
            ]
            if try_to_load_from_cache is None:
                hint_lines.append("  HF cache: huggingface_hub not installed")
            elif hf_cache_error is not None:
                hint_lines.append(
                    f"  HF cache: {type(hf_cache_error).__name__}: {hf_cache_error}"
                )
            else:
                hint_lines.append("  HF cache: (not found in cache)")

            if hf_hub_download is None:
                hint_lines.append("  HF download: huggingface_hub not installed")
            else:
                hint_lines.append(f"  HF download: {type(hf_error).__name__}: {hf_error}")

            hint_lines.append(f"  URL: {type(url_error).__name__}: {url_error}")

            raise RuntimeError("\n".join(hint_lines))

    def _get_predictor(self, device: torch.device) -> torch.nn.Module:
        with self._lock:
            if self._predictor is None:
                state_dict = self._load_state_dict()
                _report("Building SHARP model and applying weights")
                predictor = create_predictor(PredictorParams())
                predictor.load_state_dict(state_dict)
                predictor.eval()
                self._predictor = predictor
                self._predictor_device = torch.device("cpu")

            assert self._predictor is not None
            assert self._predictor_device is not None

            if self._predictor_device != device:
                _report(f"Moving SHARP model to {device.type.upper()}")
                self._predictor.to(device)
                self._predictor_device = device

            _report(f"SHARP model ready on {device.type.upper()}")
            return self._predictor

    def _maybe_move_model_back_to_cpu(self) -> None:
        if self.keep_model_on_device:
            return
        with self._lock:
            if self._predictor is not None and self._predictor_device is not None:
                if self._predictor_device.type != "cpu":
                    self._predictor.to("cpu")
                    self._predictor_device = torch.device("cpu")
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def _make_output_stem(self, input_path: Path) -> str:
        return f"{input_path.stem}-{_now_ms()}-{uuid.uuid4().hex[:8]}"

    def predict_to_ply(self, image_path: str | Path) -> PredictionOutputs:
        """Run SHARP inference and export a .ply file."""
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"Image does not exist: {image_path}")

        device = _select_device(self.device_preference)
        _report(f"Preparing SHARP model on {device.type.upper()}")
        predictor = self._get_predictor(device)

        _report("Reading image and camera parameters")
        image_np, _, f_px = io.load_rgb(image_path)
        height, width = image_np.shape[:2]

        _report(f"Reconstructing 3D geometry from {width} × {height} image on {device.type.upper()}")
        with torch.no_grad():
            gaussians = predict_image(predictor, image_np, f_px, device)

        stem = self._make_output_stem(image_path)
        ply_path = self.outputs_dir / f"{stem}.ply"

        _report("Exporting Gaussian splats to a PLY scene")
        # save_ply expects (height, width).
        save_ply(gaussians, f_px, (height, width), ply_path)

        # SceneMetaData expects (width, height) for resolution.
        metadata_for_render = SceneMetaData(
            focal_length_px=float(f_px),
            resolution_px=(int(width), int(height)),
            color_space="linearRGB",
        )

        _report("Releasing inference resources")
        self._maybe_move_model_back_to_cpu()

        return PredictionOutputs(
            ply_path=ply_path,
            gaussians=gaussians,
            metadata_for_render=metadata_for_render,
            input_resolution_hw=(int(height), int(width)),
            focal_length_px=float(f_px),
        )

    def _render_video_impl(
        self,
        *,
        gaussians: Gaussians3D,
        metadata: SceneMetaData,
        output_path: Path,
        trajectory_type: TrajectoryType,
        num_frames: int,
        fps: int,
        output_long_side: int | None,
    ) -> Path:
        if not torch.cuda.is_available():
            raise RuntimeError("Rendering requires CUDA (gsplat).")

        if num_frames < 2:
            raise ValueError("num_frames must be >= 2")
        if fps < 1:
            raise ValueError("fps must be >= 1")

        # Keep aligned with upstream CLI pipeline where possible.
        if output_long_side is None and int(fps) == 30:
            params = camera.TrajectoryParams(
                type=trajectory_type,
                num_steps=int(num_frames),
                num_repeats=1,
            )
            with _patched_sharp_videowriter(num_frames):
                sharp_render_gaussians(
                    gaussians=gaussians,
                    metadata=metadata,
                    params=params,
                    output_path=output_path,
                )
            depth_path = output_path.with_suffix(".depth.mp4")
            try:
                if depth_path.exists():
                    depth_path.unlink()
            except Exception:
                pass
            return output_path

        # Adapted pipeline for custom output resolution / FPS.
        src_w, src_h = metadata.resolution_px
        src_f = float(metadata.focal_length_px)

        if output_long_side is None:
            out_w, out_h, out_f = src_w, src_h, src_f
        else:
            long_side = max(src_w, src_h)
            scale = float(output_long_side) / float(long_side)
            out_w = _make_even(max(2, int(round(src_w * scale))))
            out_h = _make_even(max(2, int(round(src_h * scale))))
            out_f = src_f * scale

        traj_params = camera.TrajectoryParams(
            type=trajectory_type,
            num_steps=int(num_frames),
            num_repeats=1,
        )

        device = torch.device("cuda")
        gaussians_cuda = gaussians.to(device)

        intrinsics = torch.tensor(
            [
                [out_f, 0.0, (out_w - 1) / 2.0, 0.0],
                [0.0, out_f, (out_h - 1) / 2.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
            device=device,
            dtype=torch.float32,
        )

        cam_model = camera.create_camera_model(
            gaussians_cuda,
            intrinsics,
            resolution_px=(out_w, out_h),
            lookat_mode=traj_params.lookat_mode,
        )

        trajectory = camera.create_eye_trajectory(
            gaussians_cuda,
            traj_params,
            resolution_px=(out_w, out_h),
            f_px=out_f,
        )

        renderer = GSplatRenderer(color_space=metadata.color_space)

        # IMPORTANT: Keep render_depth=True (avoids upstream AttributeError).
        video_writer = _PatchedVideoWriter(output_path, fps=float(fps), render_depth=True, total_frames=len(trajectory))

        for eye_position in trajectory:
            cam_info = cam_model.compute(eye_position)
            rendering = renderer(
                gaussians_cuda,
                extrinsics=cam_info.extrinsics[None].to(device),
                intrinsics=cam_info.intrinsics[None].to(device),
                image_width=cam_info.width,
                image_height=cam_info.height,
            )
            color = (rendering.color[0].permute(1, 2, 0) * 255.0).to(dtype=torch.uint8)
            depth = rendering.depth[0]
            video_writer.add_frame(color, depth)

        video_writer.close()

        depth_path = output_path.with_suffix(".depth.mp4")
        try:
            if depth_path.exists():
                depth_path.unlink()
        except Exception:
            pass

        return output_path

    def render_video(
        self,
        *,
        gaussians: Gaussians3D,
        metadata: SceneMetaData,
        output_stem: str,
        trajectory_type: TrajectoryType = "rotate_forward",
        num_frames: int = 60,
        fps: int = 30,
        output_long_side: int | None = None,
    ) -> Path:
        """Render a camera trajectory as an MP4 (CUDA-only)."""
        output_path = self.outputs_dir / f"{output_stem}.mp4"
        return self._render_video_impl(
            gaussians=gaussians,
            metadata=metadata,
            output_path=output_path,
            trajectory_type=trajectory_type,
            num_frames=num_frames,
            fps=fps,
            output_long_side=output_long_side,
        )

    def predict_and_maybe_render(
        self,
        image_path: str | Path,
        *,
        trajectory_type: TrajectoryType,
        num_frames: int,
        fps: int,
        output_long_side: int | None,
        render_video: bool = True,
    ) -> tuple[Path | None, Path]:
        """One-shot helper for the UI: returns (video_path, ply_path)."""
        pred = self.predict_to_ply(image_path)

        if not render_video:
            _report("Video preview disabled; 3D scene is ready")
            return None, pred.ply_path

        if not torch.cuda.is_available():
            _report("Video preview skipped: CUDA is unavailable; 3D scene is ready")
            return None, pred.ply_path

        _report(f"Rendering video preview: {num_frames} frames at {fps} FPS, {trajectory_type} camera")
        output_stem = pred.ply_path.with_suffix("").name
        video_path = self.render_video(
            gaussians=pred.gaussians,
            metadata=pred.metadata_for_render,
            output_stem=output_stem,
            trajectory_type=trajectory_type,
            num_frames=num_frames,
            fps=fps,
            output_long_side=output_long_side,
        )
        _report("3D scene and video preview are ready", 1.0)
        return video_path, pred.ply_path


# -----------------------------------------------------------------------------
# ZeroGPU entrypoints
# -----------------------------------------------------------------------------
#
# IMPORTANT: Do NOT decorate bound instance methods with `@spaces.GPU` on ZeroGPU.
# The wrapper uses multiprocessing queues and pickles args/kwargs. If `self` is
# included, Python will try to pickle the whole instance. ModelWrapper contains
# a threading.RLock (not pickleable) and the model itself should not be pickled.
#
# Expose module-level functions that accept only pickleable arguments and
# create/cache the ModelWrapper inside the GPU worker process.

DEFAULT_OUTPUTS_DIR: Final[Path] = _ensure_dir(Path(__file__).resolve().parent / "outputs")

_GLOBAL_MODEL: ModelWrapper | None = None
_GLOBAL_MODEL_INIT_LOCK: Final[threading.Lock] = threading.Lock()


def get_global_model(*, outputs_dir: str | Path = DEFAULT_OUTPUTS_DIR) -> ModelWrapper:
    global _GLOBAL_MODEL
    with _GLOBAL_MODEL_INIT_LOCK:
        if _GLOBAL_MODEL is None:
            _GLOBAL_MODEL = ModelWrapper(outputs_dir=outputs_dir)
    return _GLOBAL_MODEL


def predict_and_maybe_render(
    image_path: str | Path,
    *,
    trajectory_type: TrajectoryType,
    num_frames: int,
    fps: int,
    output_long_side: int | None,
    render_video: bool = True,
) -> tuple[Path | None, Path]:
    model = get_global_model()
    return model.predict_and_maybe_render(
        image_path,
        trajectory_type=trajectory_type,
        num_frames=num_frames,
        fps=fps,
        output_long_side=output_long_side,
        render_video=render_video,
    )


# Export the GPU-wrapped callable (or a no-op wrapper locally).
if spaces is not None:
    predict_and_maybe_render_gpu = spaces.GPU(duration=180)(predict_and_maybe_render)
else:  # pragma: no cover
    predict_and_maybe_render_gpu = predict_and_maybe_render
