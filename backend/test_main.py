import asyncio
import json
import tempfile
from types import SimpleNamespace
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main


class FakeGradioClient:
    ply_path: Path
    video_path: Path

    def __init__(self, _url: str):
        pass

    def submit(self, **_kwargs):
        client = self

        class Job:
            async def __aiter__(self):
                for message in ("Loading SHARP model", "Reconstructing 3D geometry"):
                    yield SimpleNamespace(
                        type="status", rank=None, code=SimpleNamespace(value="PROGRESS"),
                        progress_data=[SimpleNamespace(desc=message, progress=None,
                            index=None, length=None, unit="steps")],
                    )

            def result(self):
                return client.predict()

        return Job()

    def predict(self, **_kwargs):
        return (
            {"video": {"path": str(self.video_path)}},
            {
                "value": {"path": str(self.ply_path)},
                "visible": True,
                "__type__": "update",
            },
            "### Success",
        )


class GenerateEndpointTests(unittest.TestCase):
    def test_extracts_nested_gradio_file_path(self):
        payload = {
            "value": {
                "path": "/tmp/generated.ply",
                "orig_name": "generated.ply",
            },
            "__type__": "update",
        }

        self.assertEqual(main._extract_file_path(payload), "/tmp/generated.ply")

    def test_generates_multiple_scene_layers(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            uploads_directory = root / "uploads"
            outputs_directory = root / "outputs"
            uploads_directory.mkdir()
            outputs_directory.mkdir()

            FakeGradioClient.ply_path = root / "sharp-output.ply"
            FakeGradioClient.video_path = root / "sharp-output.mp4"
            FakeGradioClient.ply_path.write_bytes(b"ply")
            FakeGradioClient.video_path.write_bytes(b"video")

            with (
                patch.object(main, "UPLOADS_DIR", uploads_directory),
                patch.object(main, "OUTPUTS_DIR", outputs_directory),
                patch.object(main, "Client", FakeGradioClient),
            ):
                response = TestClient(main.app).post(
                    "/api/generate",
                    files=[
                        ("images", ("left.jpg", b"left", "image/jpeg")),
                        ("images", ("right.webp", b"right", "image/webp")),
                    ],
                )

            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(len(body["scenes"]), 2)
            self.assertEqual(body["errors"], [])
            self.assertTrue(body["scenes"][0]["ply_filename"].endswith("-1.ply"))
            self.assertTrue(body["scenes"][1]["ply_filename"].endswith("-2.ply"))
            self.assertEqual(list(uploads_directory.iterdir()), [])
            self.assertEqual(len(list(outputs_directory.glob("*.ply"))), 2)
            self.assertEqual(len(list(outputs_directory.glob("*.mp4"))), 2)

    def test_preserves_legacy_single_image_field(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            uploads_directory = root / "uploads"
            outputs_directory = root / "outputs"
            uploads_directory.mkdir()
            outputs_directory.mkdir()

            FakeGradioClient.ply_path = root / "sharp-output.ply"
            FakeGradioClient.video_path = root / "sharp-output.mp4"
            FakeGradioClient.ply_path.write_bytes(b"ply")
            FakeGradioClient.video_path.write_bytes(b"video")

            with (
                patch.object(main, "UPLOADS_DIR", uploads_directory),
                patch.object(main, "OUTPUTS_DIR", outputs_directory),
                patch.object(main, "Client", FakeGradioClient),
            ):
                response = TestClient(main.app).post(
                    "/api/generate",
                    files={"image": ("legacy.jpg", b"legacy", "image/jpeg")},
                )

            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(len(body["scenes"]), 1)
            self.assertEqual(body["ply_url"], body["scenes"][0]["ply_url"])


class StreamingGenerationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.uploads = root / "uploads"
        self.outputs = root / "outputs"
        self.uploads.mkdir()
        self.outputs.mkdir()
        FakeGradioClient.ply_path = root / "source.ply"
        FakeGradioClient.video_path = root / "source.mp4"
        FakeGradioClient.ply_path.write_bytes(b"ply")
        FakeGradioClient.video_path.write_bytes(b"video")
        for name, value in (("UPLOADS_DIR", self.uploads), ("OUTPUTS_DIR", self.outputs),
                            ("Client", FakeGradioClient)):
            patcher = patch.object(main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def request_events(self, files, query=""):
        response = TestClient(main.app).post("/api/generate?stream=true" + query, files=files)
        self.assertEqual(response.status_code, 200)
        self.assertIn("application/x-ndjson", response.headers["content-type"])
        return [json.loads(line) for line in response.text.splitlines()]

    def test_reports_each_image_and_model_steps_before_result(self):
        events = self.request_events([
            ("images", ("first.jpg", b"first", "image/jpeg")),
            ("images", ("second.jpg", b"second", "image/jpeg")),
        ])
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(len(events[-1]["result"]["scenes"]), 2)
        for index in (1, 2):
            image_events = [event for event in events if event.get("image_index") == index]
            self.assertEqual([event["stage"] for event in image_events],
                             ["validating", "submitting", "model", "model", "saving", "image_completed"])
            self.assertTrue(all(event["image_count"] == 2 for event in image_events))
        self.assertEqual(list(self.uploads.iterdir()), [])

    def test_partial_failure_preserves_successful_scene_and_error_report(self):
        events = self.request_events([
            ("images", ("bad.gif", b"bad", "image/gif")),
            ("images", ("good.jpg", b"good", "image/jpeg")),
        ])
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(len(events[-1]["result"]["scenes"]), 1)
        self.assertEqual(events[-1]["result"]["errors"][0]["filename"], "bad.gif")
        self.assertTrue(any(event.get("stage") == "image_error" for event in events))

    def test_all_images_invalid_emits_terminal_error(self):
        events = self.request_events({"images": ("bad.gif", b"bad", "image/gif")})
        self.assertEqual(events[-1]["type"], "error")
        self.assertFalse(any(event["type"] == "result" for event in events))

    def test_unavailable_service_emits_terminal_error(self):
        with patch.object(main, "Client", side_effect=RuntimeError("private service details")):
            events = self.request_events({"images": ("image.jpg", b"image", "image/jpeg")})
        self.assertEqual(events[-1]["type"], "error")
        self.assertNotIn("private service details", events[-1]["message"])

    def test_invalid_options_and_image_count_are_reported(self):
        files = {"images": ("image.jpg", b"image", "image/jpeg")}
        self.assertEqual(self.request_events(files, "&fps=0")[-1]["type"], "error")
        too_many = [("images", (f"{i}.jpg", b"image", "image/jpeg")) for i in range(5)]
        self.assertEqual(self.request_events(too_many)[-1]["type"], "error")

    def test_missing_video_is_a_warning_and_scene_still_succeeds(self):
        with patch.object(FakeGradioClient, "video_path", self.outputs / "missing.mp4"):
            events = self.request_events({"images": ("image.jpg", b"image", "image/jpeg")})
        self.assertTrue(any(event.get("stage") == "warning" for event in events))
        self.assertIsNone(events[-1]["result"]["video_url"])

    def test_progress_counts_and_queue_estimate(self):
        reports = []
        def report(stage, message, **details):
            reports.append(dict(stage=stage, **details))
        main._report_status(SimpleNamespace(
            rank=1, eta=12, code=SimpleNamespace(value="IN_QUEUE"), progress_data=None,
        ), report)
        main._report_status(SimpleNamespace(
            rank=0, code=SimpleNamespace(value="PROGRESS"), progress_data=[
                SimpleNamespace(progress=None, index=3, length=10, desc="Rendering", unit="frames")
            ],
        ), report)
        self.assertEqual(len(reports), 2)
        self.assertEqual(reports[0]["queue_position"], 2)
        self.assertEqual(reports[1]["step_progress"], 0.3)

    def test_reports_tagged_milestones_but_does_not_expose_service_logs(self):
        reports = []
        for message in ("OpenMarble progress: Model ready", "Internal service details"):
            main._report_status(SimpleNamespace(log=(message, "info"), rank=None,
                progress_data=None), lambda stage, text, **details: reports.append(text))
        self.assertEqual(reports, ["Model ready"])

    def test_cancelling_stream_cancels_upstream_job(self):
        class PendingJob:
            cancelled = False

            async def __aiter__(self):
                await asyncio.sleep(60)
                yield None

            def cancel(self):
                self.cancelled = True

        async def run():
            job = PendingJob()
            task = asyncio.create_task(main._await_generation(job, lambda *_a, **_kw: None))
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(job.cancelled)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
