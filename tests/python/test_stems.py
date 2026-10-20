"""Separator plumbing, with a stand-in model rather than a checkpoint."""
import os
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from support import needs_audio
from analysis import models, stems


class FakeSeparator:
    """Writes one stem wherever `output_dir` points by the time it finishes,
    the way audio-separator does, and returns its bare file name."""

    def __init__(self):
        self.output_dir = None
        self.model_instance = types.SimpleNamespace(output_dir=None)

    def separate(self, source):
        import numpy as np
        import soundfile as sf
        time.sleep(0.2)
        name = f'input_(vocals)_{threading.get_ident()}.wav'
        folder = self.model_instance.output_dir or '.'
        sf.write(os.path.join(folder, name), np.full(22050, 0.5, dtype=np.float32), 22050)
        return [name]


@needs_audio
class BsRoformer(unittest.TestCase):
    def test_overlapping_calls_each_get_their_own_stems(self):
        # A failed analysis leaves its separation thread running into the next
        # track. Both calls share one cached separator and swap its output
        # directory; interleaved, one call's stems went to the working
        # directory and it came back with nothing.
        import numpy as np
        fake = FakeSeparator()
        mono = np.zeros(22050, dtype=np.float32)
        results, errors = [], []
        start = threading.Barrier(2)

        def run():
            start.wait()
            try:
                results.append(stems.separate_bs_roformer(mono, 22050))
            except Exception as exc:  # pragma: no cover - the failure being guarded
                errors.append(exc)

        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(models, 'bs_roformer_separator', return_value=fake), \
             patch.object(models, 'on_gpu', return_value=False):
            os.chdir(directory)
            try:
                threads = [threading.Thread(target=run) for _ in range(2)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
                stray = [f for f in os.listdir(directory) if f.endswith('.wav')]
            finally:
                os.chdir(cwd)

        self.assertEqual(errors, [])
        self.assertEqual(stray, [], 'stems written to the working directory')
        self.assertEqual(len(results), 2)
        for result in results:
            self.assertGreater(float(np.abs(result.vocals).max()), 0.4)


class SixStems(FakeSeparator):
    LEVELS = {'drums': 0.1, 'bass': 0.2, 'vocals': 0.3, 'other': 0.05, 'guitar': 0.15, 'piano': 0.25}

    def separate(self, source):
        import numpy as np
        import soundfile as sf
        names = []
        for stem, level in self.LEVELS.items():
            name = f'input_({stem})_BS-Roformer-SW.wav'
            sf.write(os.path.join(self.model_instance.output_dir, name),
                     np.full(22050, level, dtype=np.float32), 22050)
            names.append(name)
        return names


@needs_audio
class SixStemCheckpoint(unittest.TestCase):
    def test_guitar_and_piano_count_as_other(self):
        # The default checkpoint splits guitar and piano out of "other".
        # Dropping them left "other" holding only the remainder.
        import numpy as np
        with patch.object(models, 'bs_roformer_separator', return_value=SixStems()), \
             patch.object(models, 'on_gpu', return_value=False):
            result = stems.separate_bs_roformer(np.zeros(22050, dtype=np.float32), 22050)
        middle = slice(5000, 15000)
        self.assertAlmostEqual(float(np.median(result.other[middle])), 0.45, places=2)
        for stem in ('drums', 'bass', 'vocals'):
            self.assertAlmostEqual(float(np.median(result.named(stem)[middle])),
                                   SixStems.LEVELS[stem], places=2, msg=stem)


@needs_audio
class StereoInput(unittest.TestCase):
    # The separators are stereo-trained; they were handed the mono analysis
    # signal copied into two identical channels.
    def write(self, directory, channels):
        import numpy as np
        import soundfile as sf
        t = np.arange(44100 * 3) / 44100
        tones = [0.3 * np.sin(2 * np.pi * f * t) for f in (440, 660)][:channels]
        path = os.path.join(directory, f'{channels}ch.wav')
        sf.write(path, np.stack(tones, axis=1), 44100)
        return path

    def test_the_real_channels_come_back_at_the_asked_rate(self):
        import numpy as np
        from analysis import preprocess
        with tempfile.TemporaryDirectory() as directory:
            audio = preprocess.prepare(self.write(directory, 2))
            pair = preprocess.load_for_separation(audio, 44100)
            mono = preprocess.prepare(self.write(directory, 1))
            self.assertIsNone(preprocess.load_for_separation(mono, 44100))
        self.assertEqual(pair.shape[0], 2)
        self.assertAlmostEqual(pair.shape[1] / 44100, audio.duration, delta=0.01)
        self.assertLess(abs(np.corrcoef(pair[0], pair[1])[0, 1]), 0.1, 'the channels differ')

    def test_demucs_is_given_the_pair(self):
        import numpy as np
        import torch
        seen = {}

        def apply_model(model, tensor, device=None, **kwargs):
            seen['tensor'] = tensor
            return torch.zeros(1, 4, 2, tensor.shape[-1])

        left, right = np.ones(44100, dtype=np.float32), -np.ones(44100, dtype=np.float32)
        model = types.SimpleNamespace(samplerate=44100, sources=['drums', 'bass', 'other', 'vocals'])
        with patch.object(models, 'bs_roformer_enabled', return_value=False), \
             patch.object(models, 'separator', return_value=model), \
             patch.object(models, 'device', return_value='cpu'), \
             patch.object(models, 'on_gpu', return_value=False), \
             patch('demucs.apply.apply_model', side_effect=apply_model):
            stems.separate(np.zeros(22050, dtype=np.float32), 22050,
                           stereo_loader=lambda rate: np.stack([left, right]))
        self.assertEqual(float(seen['tensor'][0, 0, 0]), 1.0)
        self.assertEqual(float(seen['tensor'][0, 1, 0]), -1.0)



@needs_audio
class StreamedDemucs(unittest.TestCase):
    # apply_model on a whole track held it as four stereo stems at 44.1 kHz,
    # twice: 4 MB a second, more than tychome had for a long track. The
    # segments are now run one at a time; for the same random shift the stems
    # must be the ones apply_model gives, bit for bit.
    def test_the_stems_are_apply_models(self):
        import random
        import numpy as np
        import torch
        import librosa
        from demucs.apply import BagOfModels, apply_model
        from demucs.htdemucs import HTDemucs
        torch.manual_seed(0)
        net = HTDemucs(sources=['drums', 'bass', 'other', 'vocals'], channels=4, depth=2,
                       t_layers=1, t_heads=2, dconv_comp=2, segment=1, samplerate=44100).eval()
        pair = (0.1 * np.random.default_rng(3).standard_normal((2, 44100 * 3 + 777))).astype(np.float32)
        size = (pair.shape[1] + 1) // 2
        for model in (net, BagOfModels([net])):
            random.seed(11)
            with torch.no_grad():
                whole = apply_model(model, torch.tensor(pair)[None], split=True, overlap=0.10)[0]
            random.seed(11)
            with torch.no_grad():
                streamed = stems._demucs(model, pair, 'cpu', 0.10, None, 22050, size)
            for name, source in zip(model.sources, whole):
                want = librosa.resample(source.mean(dim=0).numpy(), orig_sr=44100, target_sr=22050)
                want = np.pad(want, (0, max(0, size - want.size)))[:size]
                np.testing.assert_array_equal(streamed[name], want, err_msg=f'{type(model).__name__} {name}')

    def test_a_span_reads_what_load_for_separation_returns(self):
        import numpy as np
        from analysis import preprocess
        source = np.random.default_rng(5).standard_normal((2, 50000)).astype(np.float32)
        audio = preprocess.PreparedAudio(
            mono=np.zeros(1), levelled=np.zeros(1), harmonic=np.zeros(1), percussive=np.zeros(1),
            sample_rate=22050, duration=1.0, trim_offset=0.25, applied_gain_db=-3.5,
            source=source, source_rate=44100, source_channels=2)
        whole = preprocess.load_for_separation(audio, 44100)
        span = preprocess.separation_span(audio, 44100)
        self.assertEqual(span.shape, whole.shape)
        np.testing.assert_array_equal(np.concatenate([span.read(a, a + 777) for a in range(0, span.shape[1], 777)],
                                                     axis=1), whole)


if __name__ == '__main__':
    unittest.main()
