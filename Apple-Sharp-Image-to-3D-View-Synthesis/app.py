"""
SHARP Gradio Demo
- Standard Native Layout
- Fixed: Added @spaces.GPU for ZeroGPU compatibility (Fixes 'dummy' output)
- Fixed: Download Button visibility logic
"""

from __future__ import annotations

import warnings
import json
from pathlib import Path
from typing import Final
import gradio as gr

# --- 1. Import Spaces for ZeroGPU Support ---
try:
    import spaces
except ImportError:
    # Fallback for local testing if spaces is not installed
    class spaces:
        @staticmethod
        def GPU(func):
            return func

# Suppress internal warnings
warnings.filterwarnings("ignore", category=FutureWarning, module="torch.distributed")

# Ensure model_utils is present in your directory
from model_utils import TrajectoryType, predict_and_maybe_render_gpu

# -----------------------------------------------------------------------------
# Paths & Config
# -----------------------------------------------------------------------------

APP_DIR: Final[Path] = Path(__file__).resolve().parent
OUTPUTS_DIR: Final[Path] = APP_DIR / "outputs"
ASSETS_DIR: Final[Path] = APP_DIR / "assets"
EXAMPLES_DIR: Final[Path] = ASSETS_DIR / "examples"

IMAGE_EXTS: Final[tuple[str, ...]] = (".png", ".jpg", ".jpeg", ".webp")

# -----------------------------------------------------------------------------
# SEO
# -----------------------------------------------------------------------------

SEO_HEAD = """
<meta name="description" content="Turn 2D images into 3D Gaussian Splats instantly. SHARP (Apple) AI Demo.">
<meta name="viewport" content="width=device-width, initial-scale=1">
"""

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path

def get_example_files() -> list[list[str]]:
    """Discover images in assets/examples for the UI."""
    _ensure_dir(EXAMPLES_DIR)
    
    # Check manifest.json first
    manifest_path = EXAMPLES_DIR / "manifest.json"
    if manifest_path.exists():
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            examples = []
            for entry in data:
                if "image" in entry:
                    img_path = EXAMPLES_DIR / entry["image"]
                    if img_path.exists():
                        examples.append([str(img_path)])
            if examples:
                return examples
        except Exception as e:
            print(f"Manifest error: {e}")

    # Fallback: simple file scan
    examples = []
    for ext in IMAGE_EXTS:
        for img in sorted(EXAMPLES_DIR.glob(f"*{ext}")):
            examples.append([str(img)])
    return examples

# --- 2. Apply @spaces.GPU Decorator ---
@spaces.GPU(duration=120) 
def run_sharp(
    image_path: str | None,
    trajectory_type: str,
    output_long_side: int,
    num_frames: int,
    fps: int,
    render_video: bool,
    progress=gr.Progress(track_tqdm=True)
) -> tuple[str | None, dict, str]:
    """
    Main Inference Function
    Decorated with @spaces.GPU to ensure it runs on the GPU node.
    """
    if not image_path:
        raise gr.Error("Please upload an image first.")

    # Validate inputs
    out_long_side_val = None if int(output_long_side) <= 0 else int(output_long_side)
    
    # Convert trajectory string to Enum safely
    traj_key = trajectory_type.upper()
    if hasattr(TrajectoryType, traj_key):
        traj_enum = TrajectoryType[traj_key]
    else:
        traj_enum = trajectory_type

    try:
        progress(None, desc="Preparing the SHARP inference worker")
        
        # Call the backend model
        video_path, ply_path = predict_and_maybe_render_gpu(
            image_path,
            trajectory_type=traj_enum,
            num_frames=int(num_frames),
            fps=int(fps),
            output_long_side=out_long_side_val,
            render_video=bool(render_video),
        )

        progress(None, desc="Preparing generated files for transfer")

        # Prepare outputs
        status_msg = f"### ✅ Success\nGenerated: `{ply_path.name}`"
        
        video_result = str(video_path) if video_path else None
        if video_path:
            status_msg += f"\nVideo: `{video_path.name}`"

        # Explicitly update the Download Button
        download_btn_update = gr.DownloadButton(
            value=str(ply_path), 
            visible=True,
            label=f"Download {ply_path.name}"
        )
        
        return (
            video_result,
            download_btn_update,
            status_msg
        )

    except Exception as e:
        # If it fails, we return None for video, hide button, and show error
        return (
            None, 
            gr.DownloadButton(visible=False), 
            f"### ❌ Error\n{str(e)}"
        )

# -----------------------------------------------------------------------------
# UI Construction
# -----------------------------------------------------------------------------

def build_demo() -> gr.Blocks:
    theme = gr.themes.Default()

    with gr.Blocks(theme=theme, head=SEO_HEAD, title="SHARP 3D Generator") as demo:
        
        with gr.Row():
            with gr.Column(scale=1):
                gr.Markdown("# SHARP: Single-Image 3D Generator from Apple\nConvert any static image into a 3D Gaussian Splat scene instantly.")

        # --- Main Layout (Strict Two Columns) ---
        with gr.Row(equal_height=False):
            
            # --- LEFT COLUMN: Input & Controls ---
            with gr.Column(scale=1):
                image_in = gr.Image(
                    label="Input Image",
                    type="filepath",
                    sources=["upload", "clipboard"],
                    interactive=True
                )

                # Configs
                with gr.Group():
                    with gr.Row():
                        trajectory = gr.Dropdown(
                            label="Camera Movement",
                            choices=["swipe", "shake", "rotate", "rotate_forward"],
                            value="rotate_forward",
                            scale=2
                        )
                        output_res = gr.Dropdown(
                            label="Output Resolution",
                            choices=[("Original", 0), ("512px", 512), ("1024px", 1024)],
                            value=0,
                            scale=1
                        )
                    with gr.Row():
                        frames = gr.Slider(label="Frames", minimum=24, maximum=120, step=1, value=60)
                        fps_in = gr.Slider(label="FPS", minimum=8, maximum=60, step=1, value=30)
                    
                    render_toggle = gr.Checkbox(label="Render Video Preview", value=True)

                run_btn = gr.Button("🚀 Generate 3D Scene", variant="primary", size="lg")

                # Examples
                example_files = get_example_files()
                if example_files:
                    gr.Examples(
                        examples=example_files,
                        inputs=[image_in],
                        label="Examples",
                        run_on_click=False,
                        cache_examples=False
                    )

            # --- RIGHT COLUMN: Output ---
            with gr.Column(scale=1):
                video_out = gr.Video(
                    label="3D Preview", 
                    autoplay=True,
                    elem_id="output-video",
                    interactive=False
                )
                
                with gr.Group():
                    status_md = gr.Markdown("Ready to generate.")
                    # Button starts hidden
                    ply_download = gr.DownloadButton(
                        label="Download .PLY File",
                        variant="secondary",
                        visible=False
                    )

        # --- Logic Binding ---
        run_btn.click(
            fn=run_sharp,
            inputs=[image_in, trajectory, output_res, frames, fps_in, render_toggle],
            outputs=[video_out, ply_download, status_md],
            concurrency_limit=1
        )
        
    return demo

# -----------------------------------------------------------------------------
# Entry Point
# -----------------------------------------------------------------------------

_ensure_dir(OUTPUTS_DIR)

if __name__ == "__main__":
    demo = build_demo()
    demo.queue().launch(
        allowed_paths=[str(ASSETS_DIR)],
        ssr_mode=False
    )