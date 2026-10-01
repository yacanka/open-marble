"""Progress regression checks without checkpoint downloads or GPU execution."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
import torch

import model_utils


class ModelProgressTests(unittest.TestCase):
    def test_prediction_reports_milestones_and_cached_model(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / 'image.jpg'
            image_path.write_bytes(b'image')
            model = model_utils.ModelWrapper(outputs_dir=directory)
            model._predictor = Mock()
            model._predictor_device = torch.device('cpu')
            messages = []
            with (
                patch.object(model_utils, '_report', side_effect=lambda message, *args: messages.append(message)),
                patch.object(model_utils, '_select_device', return_value=torch.device('cpu')),
                patch.object(model_utils.io, 'load_rgb', return_value=(np.zeros((20, 30, 3)), None, 10)),
                patch.object(model_utils, 'predict_image', return_value=Mock()),
                patch.object(model_utils, 'save_ply'),
                patch.object(model, '_maybe_move_model_back_to_cpu'),
                patch.object(model, '_load_state_dict') as load_weights,
            ):
                model.predict_to_ply(image_path)
            load_weights.assert_not_called()
            self.assertEqual(messages, [
                'Preparing SHARP model on CPU', 'SHARP model ready on CPU',
                'Reading image and camera parameters',
                'Reconstructing 3D geometry from 30 × 20 image on CPU',
                'Exporting Gaussian splats to a PLY scene', 'Releasing inference resources',
            ])

    def test_milestones_are_logged_but_frame_counters_are_not(self):
        with patch.object(model_utils.gr, 'Progress'), patch.object(model_utils.gr, 'Info') as info:
            model_utils._report('Model ready')
            model_utils._report('Rendering video frames', (1, 60))
        info.assert_called_once_with('OpenMarble progress: Model ready', visible=False)

    def test_video_reports_only_written_frames(self):
        with (
            patch.object(model_utils.io.VideoWriter, '__init__', return_value=None),
            patch.object(model_utils.io.VideoWriter, 'add_frame') as add_frame,
            patch.object(model_utils, '_report') as report,
        ):
            writer = model_utils._PatchedVideoWriter(Path('unused.mp4'), total_frames=2)
            writer.add_frame('color', 'depth')
            report.assert_called_once_with('Rendering video frames', (1, 2))
            add_frame.side_effect = RuntimeError('write failed')
            with self.assertRaises(RuntimeError):
                writer.add_frame('color', 'depth')
            self.assertEqual(report.call_count, 1)

    def test_writer_patch_is_restored_after_failure(self):
        original = model_utils.io.VideoWriter
        with self.assertRaises(RuntimeError):
            with model_utils._patched_sharp_videowriter(60):
                self.assertIsNot(model_utils.io.VideoWriter, original)
                raise RuntimeError('render failed')
        self.assertIs(model_utils.io.VideoWriter, original)

    def test_video_skip_is_reported_without_cuda(self):
        with tempfile.TemporaryDirectory() as directory:
            model = model_utils.ModelWrapper(outputs_dir=directory)
            prediction = Mock(ply_path=Path(directory) / 'scene.ply')
            with (
                patch.object(model, 'predict_to_ply', return_value=prediction),
                patch.object(model_utils.torch.cuda, 'is_available', return_value=False),
                patch.object(model_utils, '_report') as report,
            ):
                video, ply = model.predict_and_maybe_render('image.jpg', trajectory_type='swipe',
                    num_frames=60, fps=30, output_long_side=None)
            self.assertIsNone(video)
            self.assertEqual(ply, prediction.ply_path)
            report.assert_called_with('Video preview skipped: CUDA is unavailable; 3D scene is ready')


if __name__ == '__main__':
    unittest.main()
